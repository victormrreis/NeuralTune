import { standardize, toAcousticPoint, cosineSimilarity } from '../core/AcousticVector.ts';
import { PreferenceEngine } from '../core/PreferenceEngine.ts';
import { DEFAULT_ARTIST_WEIGHT, NeuralContextModel } from '../core/NeuralContextModel.ts';
import { ALL_MODULES_OFF, ModuleFlags } from '../core/FeatureFlags.ts';
import { calibrationDivergence, rerankCalibrated, normalizeDistribution } from '../core/CalibratedRanker.ts';
import { MemoryStorage } from '../storage/MemoryStorage.ts';
import { TrackMetadata, TrackRatingRecord, PlayEvent } from '../types/index.ts';

export interface Dataset {
  ratings: TrackRatingRecord[];
  plays: PlayEvent[];
}
export const Dataset = {};

export type RankerName = string;

export interface Metrics {
  precision: number;
  recall: number;
  ndcg: number;
  map: number;
  diversity: number;
  novelty: number;
  calibrationKL: number;
  coverage: number;
  latencyMs: number;
}
export const Metrics = {};

export interface ScoredCandidate {
  track: TrackMetadata;
  score: number;
}
export const ScoredCandidate = {};

const K = 10;
const POSITIVE_RATING = 4;

/** Oldest ratings train and newest test, so nothing from the future reaches the model. */
export function temporalSplit(data: Dataset, trainShare: number = 0.8): { train: Dataset; test: TrackRatingRecord[] } {
  const ordered = [...data.ratings].sort((a, b) => a.timestamp - b.timestamp);
  const cut = Math.floor(ordered.length * trainShare);
  const boundary = ordered[cut]?.timestamp ?? Number.POSITIVE_INFINITY;

  return {
    train: { ratings: ordered.slice(0, cut), plays: data.plays.filter((p) => p.endedAt < boundary) },
    test: ordered.slice(cut)
  };
}

export function ndcgAtK(relevance: readonly number[], totalRelevant: number, k: number = K): number {
  let dcg = 0;
  relevance.slice(0, k).forEach((rel, i) => { dcg += rel / Math.log2(i + 2); });

  let ideal = 0;
  for (let i = 0; i < Math.min(k, totalRelevant); i++) ideal += 1 / Math.log2(i + 2);
  return ideal > 0 ? dcg / ideal : 0;
}

export function averagePrecisionAtK(relevance: readonly number[], totalRelevant: number, k: number = K): number {
  let hits = 0;
  let sum = 0;
  relevance.slice(0, k).forEach((rel, i) => {
    if (rel > 0) {
      hits++;
      sum += hits / (i + 1);
    }
  });
  return totalRelevant > 0 ? sum / Math.min(k, totalRelevant) : 0;
}

/** Mean pairwise (1 - similarity) of the list, with unknown audio counted as neutral. */
export function intraListDiversity(tracks: readonly TrackMetadata[]): number {
  const vectors = tracks.map((t) => {
    const point = toAcousticPoint(t.acousticFeatures);
    return point ? standardize(point.values) : null;
  });

  let sum = 0;
  let pairs = 0;
  for (let i = 0; i < vectors.length; i++) {
    for (let j = i + 1; j < vectors.length; j++) {
      pairs++;
      const [a, b] = [vectors[i], vectors[j]];
      sum += a && b ? (1 - cosineSimilarity(a, b)) / 2 : 0.5;
    }
  }
  return pairs > 0 ? sum / pairs : 0;
}

function clusterShares(engine: PreferenceEngine): Map<number, number> {
  const { clusters } = engine.getModelSnapshot();
  return normalizeDistribution(new Map(clusters.map((cluster, i) => [i, cluster.share])));
}

function evaluateList(
  ranked: readonly ScoredCandidate[],
  test: readonly TrackRatingRecord[],
  engine: PreferenceEngine,
  artistPopularity: ReadonlyMap<string, number>,
  latencyMs: number,
  catalogSize: number
): Metrics {
  const positive = new Set(test.filter((r) => r.rating >= POSITIVE_RATING).map((r) => r.uri));
  const top = ranked.slice(0, K);
  const relevance = top.map(({ track }) => (positive.has(track.uri) ? 1 : 0));
  const hits = relevance.reduce<number>((sum, value) => sum + value, 0);

  const counts = new Map<number, number>();
  for (const { track } of top) {
    const point = toAcousticPoint(track.acousticFeatures);
    const cluster = point ? engine.clusterOf(point) : null;
    if (cluster !== null) counts.set(cluster, (counts.get(cluster) ?? 0) + 1);
  }
  const assigned = Array.from(counts.values()).reduce((sum, value) => sum + value, 0);

  const novelty = top.length > 0
    ? top.reduce((sum, { track }) => sum + 1 / (1 + (artistPopularity.get(track.artists[0]?.uri ?? '') ?? 0)), 0) / top.length
    : 0;

  return {
    precision: top.length > 0 ? hits / top.length : 0,
    recall: positive.size > 0 ? hits / positive.size : 0,
    ndcg: ndcgAtK(relevance, positive.size),
    map: averagePrecisionAtK(relevance, positive.size),
    diversity: intraListDiversity(top.map((c) => c.track)),
    novelty,
    calibrationKL: calibrationDivergence(clusterShares(engine), counts, assigned),
    coverage: catalogSize > 0 ? new Set(top.map((c) => c.track.artists[0]?.uri)).size / Math.min(K, catalogSize) : 0,
    latencyMs
  };
}

interface Trained {
  storage: MemoryStorage;
  engine: PreferenceEngine;
  now: number;
}

const SESSION_MS = 4 * 3_600_000;
const MIN_SESSION_ITEMS = 5;

async function train(data: Dataset, now: number): Promise<Trained> {
  const storage = new MemoryStorage();
  for (const rating of data.ratings) await storage.saveRating(rating);
  for (const play of data.plays) await storage.savePlayEvent(play);

  const model: Trained = { storage, engine: null as unknown as PreferenceEngine, now };
  model.engine = new PreferenceEngine(storage, () => model.now);
  await model.engine.init();
  return model;
}

function byScore(items: ScoredCandidate[]): ScoredCandidate[] {
  return items.sort((a, b) => b.score - a.score || a.track.uri.localeCompare(b.track.uri));
}

type Ranker = (candidates: readonly TrackMetadata[], model: Trained, data: Dataset) => ScoredCandidate[];

export const baselineArtistMean: Ranker = (candidates, _model, data) => {
  const sums = new Map<string, { total: number; n: number }>();
  for (const { metadata, rating } of data.ratings) {
    for (const artist of metadata.artists) {
      const entry = sums.get(artist.uri) ?? { total: 0, n: 0 };
      entry.total += rating;
      entry.n++;
      sums.set(artist.uri, entry);
    }
  }
  return byScore(candidates.map((track) => {
    const stats = track.artists.map((a) => sums.get(a.uri)).find(Boolean);
    return { track, score: stats ? (stats.total + 3 * 2) / (stats.n + 2) : 3 };
  }));
};

export const baselineAcoustic: Ranker = (candidates, _model, data) => {
  const liked = data.ratings.flatMap((r) => {
    const point = r.rating >= POSITIVE_RATING ? toAcousticPoint(r.metadata.acousticFeatures) : null;
    return point ? [standardize(point.values)] : [];
  });
  const size = liked[0]?.length ?? 8;
  const centroid = new Array<number>(size).fill(0);
  for (const vector of liked) vector.forEach((value, i) => { centroid[i] += value / liked.length; });

  return byScore(candidates.map((track) => {
    const point = toAcousticPoint(track.acousticFeatures);
    return { track, score: point ? cosineSimilarity(standardize(point.values), centroid) : 0 };
  }));
};

export const baselineV3: Ranker = (candidates, { engine }) => {
  return byScore(candidates.map((track) => ({ track, score: engine.evaluateCandidate(track).score / 100 })));
};

/** Maximal marginal relevance over the v3 score: the plain diversity baseline. */
export const baselineDiverse: Ranker = (candidates, model, data) => {
  const scored = baselineV3(candidates, model, data);
  const chosen: ScoredCandidate[] = [];
  const pool = [...scored];

  while (pool.length > 0) {
    let best = 0;
    let bestValue = Number.NEGATIVE_INFINITY;
    pool.forEach((item, index) => {
      const penalty = chosen.reduce((max, other) => Math.max(max, 1 - intraListDiversity([item.track, other.track])), 0);
      const value = 0.7 * item.score - 0.3 * penalty;
      if (value > bestValue) {
        bestValue = value;
        best = index;
      }
    });
    chosen.push(pool.splice(best, 1)[0]);
  }
  return chosen;
};

/** The full pipeline with chosen modules: v3 score, context terms, then calibration. */
export function moduleRanker(flags: ModuleFlags, artistWeight: number = DEFAULT_ARTIST_WEIGHT): Ranker {
  return (candidates, { engine, now }, data) => {
    const context = new NeuralContextModel(engine, flags, artistWeight);
    context.fit(data.ratings, data.plays);
    const date = new Date(now);

    const scored = byScore(candidates.map((track) => ({
      track,
      score: engine.evaluateCandidate(track).score / 100 + context.adjustment(track, date)
    })));

    if (!flags.calibrated) return scored;

    const items = scored.map((item, i) => {
      const point = toAcousticPoint(item.track.acousticFeatures);
      return { id: `${i}`, score: item.score, cluster: (point ? engine.clusterOf(point) : null) ?? -1, payload: item };
    });
    return rerankCalibrated(items, clusterShares(engine), scored.length, 0.3).map((item) => item.payload);
  };
}

/** Order decided by a hash of the URI: what chance alone scores on the same test set. */
export function randomRanker(seed: number): Ranker {
  const hash = (text: string) => {
    let state = seed >>> 0;
    for (let i = 0; i < text.length; i++) state = Math.imul(state ^ text.charCodeAt(i), 0x5bd1e995) >>> 0;
    return (state ^ (state >>> 13)) >>> 0;
  };
  return (candidates) => candidates.map((track) => ({ track, score: hash(track.uri) })).sort((a, b) => b.score - a.score);
}

export const BASELINES: Record<RankerName, Ranker> = {
  'Nota por artista': baselineArtistMean,
  'Similaridade acústica': baselineAcoustic,
  'NeuralTune 3.0': baselineV3,
  'Com diversidade (MMR)': baselineDiverse
};

export interface EvaluationReport {
  sessions: number;
  ratings: number;
  testPositives: number;
  candidates: number;
  results: Record<RankerName, Metrics>;
  usable: boolean;
  reason?: string;
}
export const EvaluationReport = {};

/**
 * One temporal split, all rankers on identical data. Candidates are the test tracks with their true
 * ratings hidden: this asks which rated tracks each ranker would have put first, so it measures
 * ordering among tracks the user actually rated, a biased sample, and says nothing about unrated ones.
 */
export async function evaluate(data: Dataset, rankers: Record<RankerName, Ranker>, trainShare: number = 0.8): Promise<EvaluationReport> {
  const { train: training, test } = temporalSplit(data, trainShare);
  const positives = test.filter((r) => r.rating >= POSITIVE_RATING).length;
  const report: EvaluationReport = {
    sessions: 0, ratings: data.ratings.length, testPositives: positives, candidates: test.length, results: {}, usable: true
  };

  if (positives < 5 || positives === test.length) {
    report.usable = false;
    report.reason = `Amostra insuficiente: ${positives} positivas em ${test.length} faixas de teste.`;
    return report;
  }

  const now = test[0].timestamp;
  const model = await train(training, now);

  const artistPopularity = new Map<string, number>();
  for (const { metadata } of training.ratings) {
    const artist = metadata.artists[0]?.uri;
    if (artist) artistPopularity.set(artist, (artistPopularity.get(artist) ?? 0) + 1);
  }

  // Ranked by session, each at its own time of day; a thin history is ranked once as a whole
  const buckets = new Map<number, TrackRatingRecord[]>();
  for (const record of test) {
    const key = Math.floor(record.timestamp / SESSION_MS);
    const list = buckets.get(key);
    if (list) list.push(record);
    else buckets.set(key, [record]);
  }

  const sessions = Array.from(buckets.values()).filter((session) => {
    return session.length >= MIN_SESSION_ITEMS && session.some((r) => r.rating >= POSITIVE_RATING);
  });
  const groups = sessions.length >= 3 ? sessions : [test];
  report.sessions = groups.length;

  for (const [name, ranker] of Object.entries(rankers)) {
    const totals: Metrics = { precision: 0, recall: 0, ndcg: 0, map: 0, diversity: 0, novelty: 0, calibrationKL: 0, coverage: 0, latencyMs: 0 };

    for (const group of groups) {
      model.now = group[0].timestamp;
      const started = performance.now();
      const ranked = ranker(group.map((r) => r.metadata), model, training);
      const metrics = evaluateList(ranked, group, model.engine, artistPopularity, performance.now() - started, group.length);
      for (const key of Object.keys(totals) as Array<keyof Metrics>) totals[key] += metrics[key] / groups.length;
    }

    report.results[name] = totals;
  }

  return report;
}

export interface RollingReport {
  cuts: number[];
  usableCuts: number;
  ndcg: Record<RankerName, { mean: number; sd: number; perCut: number[] }>;
  precision: Record<RankerName, number>;
  ratings: number;
}
export const RollingReport = {};

/**
 * Rolling-origin evaluation: the model is rebuilt at each cut and tested on the ratings right after it.
 * One split can be luck, and a single number is no basis to compare models. The cuts overlap in training
 * data, so the spread understates uncertainty: it is a stability check, not a confidence interval.
 */
export async function evaluateRolling(data: Dataset, rankers: Record<RankerName, Ranker>, cuts: readonly number[] = [0.5, 0.6, 0.7, 0.8]): Promise<RollingReport> {
  const scores: Record<RankerName, number[]> = {};
  const precisions: Record<RankerName, number[]> = {};
  let usableCuts = 0;

  for (const cut of cuts) {
    const ordered = [...data.ratings].sort((a, b) => a.timestamp - b.timestamp);
    const window = ordered.slice(0, Math.floor(ordered.length * (cut + 0.2)));
    const report = await evaluate({ ratings: window, plays: data.plays }, rankers, cut / (cut + 0.2));
    if (!report.usable) continue;

    usableCuts++;
    for (const [name, metrics] of Object.entries(report.results)) {
      (scores[name] ??= []).push(metrics.ndcg);
      (precisions[name] ??= []).push(metrics.precision);
    }
  }

  const ndcg: RollingReport['ndcg'] = {};
  const precision: RollingReport['precision'] = {};
  for (const [name, values] of Object.entries(scores)) {
    const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
    const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / Math.max(1, values.length - 1);
    ndcg[name] = { mean, sd: Math.sqrt(variance), perCut: values.map((v) => Math.round(v * 1000) / 1000) };
    precision[name] = precisions[name].reduce((sum, v) => sum + v, 0) / values.length;
  }

  return { cuts: [...cuts], usableCuts, ndcg, precision, ratings: data.ratings.length };
}

export interface EvaluationWindow {
  label: string;
  ratings: TrackRatingRecord[];
}
export const EvaluationWindow = {};

export interface WindowDiagnosis {
  label: string;
  ratings: number;
  days: number;
  positiveShare: number;
  /** Share rated after another track by the same artist: what an artist signal can use at all. */
  knownArtistShare: number;
  featureShare: number;
  usableCuts: number;
  ndcg: Record<RankerName, number>;
}
export const WindowDiagnosis = {};

const RANDOM_SEEDS = [1, 2, 3, 4, 5];
const RANDOM_LABEL = 'Aleatório';

/**
 * NDCG depends on the test set as much as on the model, so two numbers from different periods cannot be
 * compared directly. This scores the same rankers per period next to chance, with what changed in the
 * data: share of positives, of artists seen before, of tracks with audio data.
 */
export async function diagnoseEvaluation(
  data: Dataset,
  rankers: Record<RankerName, Ranker>,
  windows: readonly EvaluationWindow[]
): Promise<{ windows: WindowDiagnosis[] }> {
  const results: WindowDiagnosis[] = [];

  for (const { label, ratings } of windows) {
    const ordered = [...ratings].sort((a, b) => a.timestamp - b.timestamp);
    const seen = new Set<string>();
    let knownArtists = 0;
    for (const { metadata } of ordered) {
      const uris = metadata.artists.map((a) => a.uri);
      if (uris.some((uri) => seen.has(uri))) knownArtists++;
      for (const uri of uris) seen.add(uri);
    }

    const randoms = Object.fromEntries(RANDOM_SEEDS.map((seed) => [`${RANDOM_LABEL} ${seed}`, randomRanker(seed)]));
    const rolling = await evaluateRolling({ ratings: ordered, plays: data.plays }, { ...rankers, ...randoms });

    const ndcg: Record<RankerName, number> = {};
    const chance: number[] = [];
    for (const [name, { mean }] of Object.entries(rolling.ndcg)) {
      if (name.startsWith(RANDOM_LABEL)) chance.push(mean);
      else ndcg[name] = mean;
    }
    if (chance.length > 0) ndcg[RANDOM_LABEL] = chance.reduce((sum, value) => sum + value, 0) / chance.length;

    const total = Math.max(1, ordered.length);
    results.push({
      label,
      ratings: ordered.length,
      days: ordered.length > 1 ? (ordered[ordered.length - 1].timestamp - ordered[0].timestamp) / 86_400_000 : 0,
      positiveShare: ordered.filter((r) => r.rating >= POSITIVE_RATING).length / total,
      knownArtistShare: knownArtists / total,
      featureShare: ordered.filter((r) => toAcousticPoint(r.metadata.acousticFeatures) !== null).length / total,
      usableCuts: rolling.usableCuts,
      ndcg
    });
  }

  return { windows: results };
}

export function defaultRankers(flags: ModuleFlags): Record<RankerName, Ranker> {
  return { ...BASELINES, 'NeuralTune 4.0': moduleRanker(flags), '4.0 sem módulos': moduleRanker(ALL_MODULES_OFF) };
}
