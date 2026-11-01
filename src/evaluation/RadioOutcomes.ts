import { ipsWeight } from '../core/CalibratedRanker.ts';
import { WeeklyReport, buildWeeklyReport } from './WeeklyReport.ts';
import { PlayEvent, RadioArm, RadioExposure, TrackMetadata, TrackRatingRecord } from '../types/index.ts';

// What actually reaches the player: the first track plus the 15 sent to the queue
export const EXPOSED_TRACKS = 16;

const ATTRIBUTION_WINDOW_MS = 7 * 24 * 3_600_000;
const COMPLETE_RATIO = 0.85;
const POSITIVE_RATING = 4;
const NEGATIVE_RATING = 2;
const MIN_HEARD = 20;
const Z_95 = 1.96;
const MIN_RUN_TRACKS = 3;
const MIN_ARM_RUNS = 10;
const MIN_RANKED_EACH = 10;

/** Temperature of the exploratory arm relative to the standard one. */
export const EXPLORATORY_TEMPERATURE_FACTOR = 2;

export interface ExposureInput {
  runId: string;
  radio: string;
  at: number;
  tracks: readonly TrackMetadata[];
  /** Chance of the draw that picked this track, when the ranker drew it. */
  propensityOf?: (uri: string) => number | null;
  sourceOf: (uri: string) => RadioExposure['source'];
  isNewArtist: (track: TrackMetadata) => boolean;
  arm?: RadioArm;
  carry?: boolean;
  scoreOf?: (uri: string) => number | undefined;
  /** Where this batch starts inside the run, for tracks added after the radio began. */
  positionOffset?: number;
  limit?: number;
}
export const ExposureInput = {};

export function buildExposures({ runId, radio, at, tracks, propensityOf, sourceOf, isNewArtist, arm, carry, scoreOf, positionOffset = 0, limit = EXPOSED_TRACKS }: ExposureInput): RadioExposure[] {
  return tracks.slice(0, limit).map((track, index) => ({
    id: `${runId}:${index + positionOffset}`,
    runId,
    radio,
    uri: track.uri,
    position: index + positionOffset,
    at,
    propensity: propensityOf?.(track.uri) ?? null,
    source: sourceOf(track.uri),
    newArtist: isNewArtist(track),
    ...(arm ? { arm } : {}),
    ...(carry === undefined ? {} : { carry }),
    ...(typeof scoreOf?.(track.uri) === 'number' ? { score: scoreOf(track.uri) } : {})
  }));
}

export interface OutcomeSummary {
  group: string;
  exposed: number;
  heard: number;
  completed: number;
  skipped: number;
  rated: number;
  liked: number;
  disliked: number;
  moreLike: number;
  lessLike: number;
  completionRate: number | null;
  /** Wilson 95%, null with nothing heard. */
  completionInterval: [number, number] | null;
  /** Completion reweighted by 1/π̂, so tracks the draw favored do not dominate. */
  weightedCompletion: number | null;
  likeRate: number | null;
  enoughData: boolean;
}
export const OutcomeSummary = {};

export interface ArmComparison {
  runs: Record<RadioArm, number>;
  completion: Record<RadioArm, number | null>;
  /** Exploratory minus standard, with a 95% interval, over per-run rates. */
  difference: number | null;
  interval: [number, number] | null;
  verdict: string;
  runsMissing: number;
}
export const ArmComparison = {};

export interface ScoreRanking {
  completed: number;
  abandoned: number;
  /** Chance that a track heard to the end had a higher score than one abandoned. 0.5 is no skill. */
  auc: number | null;
}
export const ScoreRanking = {};

export interface RadioOutcomesReport {
  exposures: number;
  byRadio: OutcomeSummary[];
  bySource: OutcomeSummary[];
  byArtistNovelty: OutcomeSummary[];
  experiment: ArmComparison;
  carryExperiment: ArmComparison;
  ranking: ScoreRanking;
  weekly: WeeklyReport;
}
export const RadioOutcomesReport = {};

export function wilsonInterval(successes: number, total: number): [number, number] | null {
  if (total === 0) return null;

  const p = successes / total;
  const z2 = Z_95 * Z_95;
  const denominator = 1 + z2 / total;
  const center = (p + z2 / (2 * total)) / denominator;
  const margin = (Z_95 * Math.sqrt((p * (1 - p)) / total + z2 / (4 * total * total))) / denominator;
  return [Math.max(0, center - margin), Math.min(1, center + margin)];
}

function isComplete(play: PlayEvent): boolean {
  return play.durationMs ? play.playedMs / play.durationMs >= COMPLETE_RATIO : !play.skipped;
}

export interface Attributed {
  exposure: RadioExposure;
  play: PlayEvent | null;
  rating: TrackRatingRecord | null;
}

/** A track shown by two radios belongs to the later one from that moment on: it was the one playing it. */
export function attribute(exposures: readonly RadioExposure[], plays: readonly PlayEvent[], ratings: readonly TrackRatingRecord[]): Attributed[] {
  const byUri = new Map<string, RadioExposure[]>();
  for (const exposure of exposures) {
    const list = byUri.get(exposure.uri);
    if (list) list.push(exposure);
    else byUri.set(exposure.uri, [exposure]);
  }

  const playsByUri = new Map<string, PlayEvent[]>();
  for (const play of plays) {
    if (!byUri.has(play.uri)) continue;
    const list = playsByUri.get(play.uri);
    if (list) list.push(play);
    else playsByUri.set(play.uri, [play]);
  }
  const ratingOf = new Map(ratings.map((r) => [r.uri, r]));

  const attributed: Attributed[] = [];
  for (const [uri, shown] of byUri) {
    shown.sort((a, b) => a.at - b.at);
    const trackPlays = (playsByUri.get(uri) ?? []).sort((a, b) => a.startedAt - b.startedAt);

    shown.forEach((exposure, i) => {
      const end = Math.min(exposure.at + ATTRIBUTION_WINDOW_MS, shown[i + 1]?.at ?? Number.POSITIVE_INFINITY);
      const inWindow = (time: number) => time >= exposure.at && time < end;
      const rating = ratingOf.get(uri);
      attributed.push({
        exposure,
        play: trackPlays.find((p) => inWindow(p.startedAt)) ?? null,
        rating: rating && inWindow(rating.timestamp) ? rating : null
      });
    });
  }
  return attributed;
}

function summarize(group: string, items: readonly Attributed[]): OutcomeSummary {
  const heard = items.filter((item) => item.play !== null);
  const completed = heard.filter((item) => isComplete(item.play!)).length;
  const rated = items.filter((item) => item.rating !== null);
  const liked = rated.filter((item) => item.rating!.rating >= POSITIVE_RATING).length;

  let weightTotal = 0;
  let weightCompleted = 0;
  for (const { exposure, play } of heard) {
    const weight = ipsWeight({ propensity: exposure.propensity, reason: 'sorteio do ranker' });
    weightTotal += weight;
    if (isComplete(play!)) weightCompleted += weight;
  }

  return {
    group,
    exposed: items.length,
    heard: heard.length,
    completed,
    skipped: heard.filter((item) => item.play!.skipped).length,
    rated: rated.length,
    liked,
    disliked: rated.filter((item) => item.rating!.rating <= NEGATIVE_RATING).length,
    moreLike: heard.filter((item) => item.play!.feedback === 'mais').length,
    lessLike: heard.filter((item) => item.play!.feedback === 'menos').length,
    completionRate: heard.length > 0 ? completed / heard.length : null,
    completionInterval: wilsonInterval(completed, heard.length),
    weightedCompletion: weightTotal > 0 ? weightCompleted / weightTotal : null,
    likeRate: rated.length > 0 ? liked / rated.length : null,
    enoughData: heard.length >= MIN_HEARD
  };
}

function groupBy(items: readonly Attributed[], keyOf: (exposure: RadioExposure) => string): OutcomeSummary[] {
  const groups = new Map<string, Attributed[]>();
  for (const item of items) {
    const key = keyOf(item.exposure);
    const list = groups.get(key);
    if (list) list.push(item);
    else groups.set(key, [item]);
  }
  return Array.from(groups, ([group, members]) => summarize(group, members)).sort((a, b) => b.heard - a.heard);
}

function meanAndVariance(values: readonly number[]): { mean: number; variance: number } {
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / Math.max(1, values.length - 1);
  return { mean, variance };
}

/**
 * Tracks of one run share a mood and a session, so treating them as independent would overstate the
 * evidence. The unit here is the run, which is also what the coin flip assigned.
 */
export function compareArms(
  items: readonly Attributed[],
  armOf: (exposure: RadioExposure) => RadioArm | undefined = (exposure) => exposure.arm,
  labels: { control: string; treatment: string } = { control: 'padrão', treatment: 'exploratório' }
): ArmComparison {
  const runs = new Map<string, { arm: RadioArm; heard: number; completed: number }>();
  for (const { exposure, play } of items) {
    const arm = armOf(exposure);
    if (!arm || !play) continue;
    const run = runs.get(exposure.runId) ?? { arm, heard: 0, completed: 0 };
    run.heard++;
    if (isComplete(play)) run.completed++;
    runs.set(exposure.runId, run);
  }

  const ratesOf = (arm: RadioArm) => Array.from(runs.values())
    .filter((run) => run.arm === arm && run.heard >= MIN_RUN_TRACKS)
    .map((run) => run.completed / run.heard);

  const standard = ratesOf('padrao');
  const exploratory = ratesOf('exploratorio');
  const counts = { padrao: standard.length, exploratorio: exploratory.length };
  const runsMissing = Math.max(0, MIN_ARM_RUNS - standard.length) + Math.max(0, MIN_ARM_RUNS - exploratory.length);
  const completion = {
    padrao: standard.length > 0 ? meanAndVariance(standard).mean : null,
    exploratorio: exploratory.length > 0 ? meanAndVariance(exploratory).mean : null
  };

  if (runsMissing > 0) {
    return { runs: counts, completion, difference: null, interval: null, verdict: 'coletando', runsMissing };
  }

  const a = meanAndVariance(standard);
  const b = meanAndVariance(exploratory);
  const difference = b.mean - a.mean;
  const margin = Z_95 * Math.sqrt(a.variance / standard.length + b.variance / exploratory.length);
  const interval: [number, number] = [difference - margin, difference + margin];
  const verdict = interval[0] > 0 ? `${labels.treatment} melhor` : interval[1] < 0 ? `${labels.control} melhor` : 'sem diferença detectável';
  return { runs: counts, completion, difference, interval, verdict, runsMissing: 0 };
}

/** AUC over unrated tracks: unlike NDCG on ratings, this judges the model on what it actually recommends. */
export function rankingQuality(items: readonly Attributed[]): ScoreRanking {
  const completed: number[] = [];
  const abandoned: number[] = [];
  for (const { exposure, play } of items) {
    if (!play || typeof exposure.score !== 'number') continue;
    (isComplete(play) ? completed : abandoned).push(exposure.score);
  }

  if (completed.length < MIN_RANKED_EACH || abandoned.length < MIN_RANKED_EACH) {
    return { completed: completed.length, abandoned: abandoned.length, auc: null };
  }

  let wins = 0;
  for (const good of completed) {
    for (const bad of abandoned) wins += good > bad ? 1 : good === bad ? 0.5 : 0;
  }
  return { completed: completed.length, abandoned: abandoned.length, auc: wins / (completed.length * abandoned.length) };
}

/** Order inside a run no longer follows the score, so position cannot explain a gap between groups of tracks. */
export function shufflePositions<T>(items: readonly T[], random: () => number): T[] {
  const shuffled = [...items];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

/**
 * Tracks that were queued and never reached count as exposed, not as rejected: nothing is known about
 * them. Rates are over tracks actually heard. Since the user chooses which radio to start, a difference
 * between radios is an association. The experiment is what supports a cause: its arm comes from a coin.
 */
export function summarizeOutcomes(
  exposures: readonly RadioExposure[],
  plays: readonly PlayEvent[],
  ratings: readonly TrackRatingRecord[],
  now: number = Date.now()
): RadioOutcomesReport {
  const attributed = attribute(exposures, plays, ratings);
  return {
    exposures: exposures.length,
    byRadio: groupBy(attributed, (exposure) => exposure.radio),
    bySource: groupBy(attributed, (exposure) => exposure.source),
    byArtistNovelty: groupBy(attributed, (exposure) => (exposure.newArtist ? 'artista novo' : 'artista conhecido')),
    experiment: compareArms(attributed),
    carryExperiment: compareArms(
      attributed,
      (exposure) => (exposure.carry === undefined ? undefined : exposure.carry ? 'exploratorio' : 'padrao'),
      { control: 'sem memória', treatment: 'com memória' }
    ),
    weekly: buildWeeklyReport(attributed, now),
    ranking: rankingQuality(attributed)
  };
}
