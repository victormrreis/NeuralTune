// Reproducible offline experiments. Run: node --experimental-strip-types scripts/research/run_experiments.ts
// All data here is SIMULATED, and the simulator encodes assumptions. Results say whether a module can
// recover an effect that exists, and whether it does harm when the effect does not exist. They are not
// evidence about real listeners; tests on real ratings run inside the client (EvaluationRunner).
import fs from 'node:fs';
import { evaluate, baselineV3, BASELINES, moduleRanker, Dataset, Metrics } from '../../src/evaluation/RecommenderEvaluation.ts';
import { ALL_MODULES_OFF, ModuleFlags } from '../../src/core/FeatureFlags.ts';
import { seededRandom } from '../../src/core/ThompsonBanditOptimizer.ts';
import { solveTrajectory, TrajectoryTrack } from '../../src/queue/HarmonicTrajectorySolver.ts';
import { seamCost, TrackMorphology } from '../../src/core/SegmentMorphologyEngine.ts';
import { kuramotoSynchrony, patternSimilarity, tempoSimilarity } from '../../src/neuroscience/RhythmDynamicsEngine.ts';
import { predictiveProfile } from '../../src/neuroscience/AuditoryPredictiveCodingEngine.ts';
import { synthesizeFeatures } from '../../src/core/AudioAnalysisSynthesizer.ts';
import { powerIterationPca, symmetricEigen } from '../../src/math/LinearAlgebra.ts';
import { PreferenceEngine } from '../../src/core/PreferenceEngine.ts';
import { MemoryStorage } from '../../src/storage/MemoryStorage.ts';
import { rerankCalibrated } from '../../src/core/CalibratedRanker.ts';
import { AcousticFeatures, PlayEvent, Rating, TrackMetadata, TrackRatingRecord } from '../../src/types/index.ts';

const SEEDS = 20;
const DAY = 86_400_000;
const HOUR = 3_600_000;

interface World {
  name: string;
  hourEffect: number;      // How strongly the time of day picks the taste
  informationEffect: number; // Inverted U on harmonic surprise
  artistEffect: number;
  drift: number;           // Share of taste that moves over the timeline
}

const WORLDS: World[] = [
  { name: 'nulo', hourEffect: 0, informationEffect: 0, artistEffect: 0.6, drift: 0 },
  { name: 'contexto', hourEffect: 1.5, informationEffect: 0, artistEffect: 0.6, drift: 0 },
  { name: 'informacao', hourEffect: 0, informationEffect: 1.5, artistEffect: 0.6, drift: 0 },
  { name: 'deriva', hourEffect: 0, informationEffect: 0, artistEffect: 0.6, drift: 1 }
];

function gaussian(random: () => number): number {
  return Math.sqrt(-2 * Math.log(1 - random())) * Math.cos(2 * Math.PI * random());
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function simulate(world: World, seed: number): Dataset {
  const random = seededRandom(seed * 7919 + 13);
  const CLUSTERS = 4;

  const centers = Array.from({ length: CLUSTERS }, () => Array.from({ length: 8 }, () => random()));
  const preference = Array.from({ length: CLUSTERS }, () => gaussian(random));
  const peakHours = Array.from({ length: CLUSTERS }, () => random() * 24);
  const artistBias = Array.from({ length: 60 }, () => gaussian(random));

  const catalog = Array.from({ length: 700 }, (_, i) => {
    const cluster = Math.floor(random() * CLUSTERS);
    const artist = Math.floor(random() * 60);
    const v = centers[cluster].map((c) => clamp(c + gaussian(random) * 0.08));
    const features: AcousticFeatures = {
      bpm: 50 + v[0] * 150, energy: v[1], valence: v[2], danceability: v[3], acousticness: v[4],
      instrumentalness: v[5], speechiness: v[6], liveness: v[7], key: Math.floor(random() * 12), mode: random() < 0.5 ? 1 : 0,
      predictive: { harmonicSurprise: 0.3 + random() * 0.5, harmonicUncertainty: 0.3 + random() * 0.5 }
    };
    const metadata: TrackMetadata = {
      uri: `spotify:track:s${i}`, name: `t${i}`, artists: [{ name: `a${artist}`, uri: `spotify:artist:${artist}` }],
      album: { name: '', uri: `spotify:album:${i % 150}` }, acousticFeatures: features, duration_ms: 200_000
    };
    return { metadata, cluster, artist, surprise: features.predictive!.harmonicSurprise! };
  });

  const start = Date.UTC(2026, 0, 1);
  const ratings: TrackRatingRecord[] = [];
  const plays: PlayEvent[] = [];

  for (let session = 0; session < 180; session++) {
    const hour = random() * 24;
    const base = start + session * DAY * 0.8 + hour * HOUR;
    const progress = session / 180;

    for (let i = 0; i < 8; i++) {
      const track = catalog[Math.floor(random() * catalog.length)];
      const timestamp = base + i * 240_000;

      const circular = Math.cos((2 * Math.PI * (hour - peakHours[track.cluster])) / 24);
      const taste = preference[track.cluster] * (1 - world.drift * progress) + preference[(track.cluster + 1) % CLUSTERS] * world.drift * progress;
      const information = 1 - 16 * (track.surprise - 0.55) ** 2;

      const latent = taste + world.hourEffect * circular + world.informationEffect * information
        + world.artistEffect * artistBias[track.artist] + gaussian(random) * 0.5;

      const rating = Math.max(0, Math.min(5, Math.round(3 + latent))) as Rating;
      ratings.push({ uri: track.metadata.uri, rating, timestamp, metadata: track.metadata });

      const completed = latent > 0;
      plays.push({
        id: `${track.metadata.uri}@${timestamp}`, uri: track.metadata.uri, name: track.metadata.name,
        artistUris: track.metadata.artists.map((a) => a.uri), startedAt: timestamp, endedAt: timestamp + 180_000,
        playedMs: completed ? 190_000 : 12_000, durationMs: 200_000, skipped: !completed
      });
    }
  }

  // One rating per track, the latest: the store is keyed by URI
  const latest = new Map(ratings.map((r) => [r.uri, r]));
  return { ratings: Array.from(latest.values()), plays };
}

function meanCi(values: number[]): { mean: number; ci: number } {
  const n = values.length;
  const mean = values.reduce((sum, v) => sum + v, 0) / n;
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / Math.max(1, n - 1);
  return { mean, ci: 1.96 * Math.sqrt(variance / n) };
}

const only = (flag: keyof ModuleFlags): ModuleFlags => ({ ...ALL_MODULES_OFF, [flag]: true });

const RANKERS = {
  ...BASELINES,
  'So artista': moduleRanker(ALL_MODULES_OFF),
  '+ preditivo': moduleRanker(only('predictive')),
  '+ plasticidade': moduleRanker(only('plasticity')),
  '+ circadiano': moduleRanker(only('circadian')),
  '+ calibrado': moduleRanker(only('calibrated')),
  'Todos': moduleRanker({ predictive: true, rhythm: true, plasticity: true, morphology: true, circadian: true, calibrated: true })
};

const output: Record<string, unknown> = { seeds: SEEDS, simulated: true };
const worlds: Record<string, unknown> = {};

for (const world of WORLDS) {
  const byRanker: Record<string, Array<Metrics>> = {};

  for (let seed = 1; seed <= SEEDS; seed++) {
    const report = await evaluate(simulate(world, seed), RANKERS);
    for (const [name, metrics] of Object.entries(report.results)) (byRanker[name] ??= []).push(metrics);
  }

  const table: Record<string, unknown> = {};
  for (const [name, runs] of Object.entries(byRanker)) {
    const reference = byRanker['So artista'];
    const paired = (metric: keyof Metrics) => meanCi(runs.map((run, i) => run[metric] - reference[i][metric]));
    table[name] = {
      ndcg: meanCi(runs.map((r) => r.ndcg)),
      precision: meanCi(runs.map((r) => r.precision)),
      map: meanCi(runs.map((r) => r.map)),
      diversity: meanCi(runs.map((r) => r.diversity)),
      kl: meanCi(runs.map((r) => r.calibrationKL)),
      latencyMs: meanCi(runs.map((r) => r.latencyMs)),
      deltaNdcg: paired('ndcg'),
      deltaKl: paired('calibrationKL'),
      deltaDiversity: paired('diversity')
    };
  }
  worlds[world.name] = table;

  console.log(`\n=== mundo ${world.name} (ΔNDCG pareado contra 'So artista', ${SEEDS} sementes)`);
  for (const [name, row] of Object.entries(table) as Array<[string, any]>) {
    const significant = Math.abs(row.deltaNdcg.mean) > row.deltaNdcg.ci ? '*' : ' ';
    console.log(`${name.padEnd(24)} NDCG ${row.ndcg.mean.toFixed(3)}  Δ ${row.deltaNdcg.mean >= 0 ? '+' : ''}${row.deltaNdcg.mean.toFixed(3)} ±${row.deltaNdcg.ci.toFixed(3)}${significant}  KL ${row.kl.mean.toFixed(3)}  ILD ${row.diversity.mean.toFixed(3)}`);
  }
}
output.worlds = worlds;

// --- Transitions: does the morphology change the sequence, and at what cost?
function morphologyOf(random: () => number): TrackMorphology {
  const level = -6 - random() * 16;
  const section = () => ({ loudness: level + gaussian(random) * 4, brightness: 40 + gaussian(random) * 30, density: 3 + random() * 3, camelot: { number: 1 + Math.floor(random() * 12), letter: (random() < 0.5 ? 'A' : 'B') as 'A' | 'B' } });
  return { intro: section(), core: section(), outro: section(), bpm: 90 + random() * 70, timeline: [] };
}

const seamWith: number[] = [];
const seamWithout: number[] = [];
const scoreWith: number[] = [];
const scoreWithout: number[] = [];
const latencyWith: number[] = [];

for (let seed = 1; seed <= SEEDS; seed++) {
  const random = seededRandom(seed * 104729);
  const pool: Array<TrajectoryTrack<null>> = Array.from({ length: 120 }, (_, i) => {
    const morphology = morphologyOf(random);
    return { id: `t${i}`, artistIds: [`a${i % 30}`], score: 0.4 + random() * 0.4, bpm: morphology.bpm, energy: random(), morphology, vector: [gaussian(random), gaussian(random), gaussian(random)], payload: null };
  });

  const mean = (tracks: typeof pool, pick: (t: (typeof pool)[number]) => number) => tracks.reduce((s, t) => s + pick(t), 0) / tracks.length;
  const seams = (tracks: typeof pool) => {
    let sum = 0;
    for (let i = 1; i < tracks.length; i++) sum += seamCost(tracks[i - 1].morphology!, tracks[i].morphology!);
    return sum / (tracks.length - 1);
  };

  const started = performance.now();
  const withModule = solveTrajectory(pool, { length: 30 }).tracks;
  latencyWith.push(performance.now() - started);
  const withoutModule = solveTrajectory(pool.map((t) => ({ ...t, morphology: undefined })), { length: 30 }).tracks;
  const byId = new Map(pool.map((t) => [t.id, t]));
  const restored = withoutModule.map((t) => byId.get(t.id)!);

  seamWith.push(seams(withModule));
  seamWithout.push(seams(restored));
  scoreWith.push(mean(withModule, (t) => t.score));
  scoreWithout.push(mean(restored, (t) => t.score));
}

output.morphology = {
  seamWith: meanCi(seamWith), seamWithout: meanCi(seamWithout),
  scoreWith: meanCi(scoreWith), scoreWithout: meanCi(scoreWithout),
  latencyMs: meanCi(latencyWith)
};
console.log('\n=== morfologia', JSON.stringify(output.morphology));

// --- Rhythm: can each measure tell pairs sharing a groove from pairs that do not?
function grooveAuc(measure: (a: { bpm: number; pattern: number[] }, b: { bpm: number; pattern: number[] }) => number): number {
  const random = seededRandom(424242);
  const grooves = Array.from({ length: 6 }, () => {
    const pattern = Array.from({ length: 16 }, () => random() ** 3);
    const total = pattern.reduce((a, b) => a + b, 0);
    return pattern.map((v) => v / total);
  });
  const make = (g: number) => ({ bpm: 95 + random() * 40, pattern: grooves[g].map((v) => v * (1 + gaussian(random) * 0.15)) });

  const same = Array.from({ length: 300 }, () => { const g = Math.floor(random() * 6); return measure(make(g), make(g)); });
  const other = Array.from({ length: 300 }, () => { const g = Math.floor(random() * 6); return measure(make(g), make((g + 1) % 6)); });

  let wins = 0;
  for (const a of same) for (const b of other) wins += a > b ? 1 : a === b ? 0.5 : 0;
  return wins / (same.length * other.length);
}

output.rhythm = {
  tempoOnly: grooveAuc((a, b) => tempoSimilarity(a.bpm, b.bpm)),
  pattern: grooveAuc((a, b) => patternSimilarity(a.pattern, b.pattern)),
  kuramoto: grooveAuc((a, b) => kuramotoSynchrony([(2 * Math.PI * a.bpm) / 60, (2 * Math.PI * b.bpm) / 60], { coupling: 1, duration: 8 }))
};
console.log('\n=== ritmo (AUC, 0.5 = acaso)', JSON.stringify(output.rhythm));

// --- Performance
const fixture = simulate(WORLDS[0], 1);
const bench: Record<string, unknown> = { note: 'Node 24 nesta máquina; dados simulados; sem latência de API' };

{
  const storage = new MemoryStorage();
  for (let i = 0; i < 20_000; i++) {
    const r = fixture.ratings[i % fixture.ratings.length];
    await storage.saveRating({ ...r, uri: `spotify:track:b${i}`, timestamp: i });
  }
  const engine = new PreferenceEngine(storage);
  const started = performance.now();
  await engine.init();
  bench.initWith20kRatingsMs = Math.round(performance.now() - started);

  const samples: number[] = [];
  for (let i = 0; i < 10; i++) {
    const t0 = performance.now();
    await engine.updateWithRating({ ...fixture.ratings[0], timestamp: 1e9 + i }, null);
    samples.push(performance.now() - t0);
  }
  bench.retrain20kMs = meanCi(samples);

  const candidates = fixture.ratings.slice(0, 300).map((r) => r.metadata);
  const t1 = performance.now();
  for (const candidate of candidates) engine.evaluateCandidate(candidate);
  bench.evaluate300CandidatesMs = Math.round((performance.now() - t1) * 10) / 10;
  bench.heapMB = Math.round(process.memoryUsage().heapUsed / 1e6);
}

{
  const payload = {
    track: { tempo: 120, key: 0, mode: 1, loudness: -8 },
    beats: Array.from({ length: 400 }, (_, i) => ({ start: i * 0.5, duration: 0.5, confidence: 0.8 })),
    segments: Array.from({ length: 800 }, (_, i) => ({
      start: i * 0.25, duration: 0.25, loudness_max: -10, loudness_start: -20,
      pitches: Array.from({ length: 12 }, (_, p) => ((p + i) % 7 === 0 ? 1 : 0.2)),
      timbre: Array.from({ length: 12 }, (_, t) => Math.sin(i + t) * 30)
    }))
  };
  const time = (fn: () => void) => {
    for (let i = 0; i < 30; i++) fn();
    const t0 = performance.now();
    fn();
    return Math.round((performance.now() - t0) * 100) / 100;
  };
  bench.synthesis800SegmentsMs = time(() => synthesizeFeatures(payload));
  bench.predictiveProfile800SegmentsMs = time(() => predictiveProfile(payload));
}

{
  const raw = Array.from({ length: 8 }, (_, i) => Array.from({ length: 8 }, (_, j) => Math.sin(i * 3 + j)));
  const covariance = raw.map((a) => raw.map((b) => a.reduce((s, v, k) => s + v * b[k], 0)));
  const t0 = performance.now();
  const pca = powerIterationPca(covariance);
  bench.pcaPowerIterationMs = Math.round((performance.now() - t0) * 100) / 100;
  bench.pcaOrthogonality = pca.orthogonality;
  const t1 = performance.now();
  symmetricEigen(covariance);
  bench.pcaJacobiMs = Math.round((performance.now() - t1) * 100) / 100;
}

{
  const items = Array.from({ length: 300 }, (_, i) => ({ id: `${i}`, score: Math.random(), cluster: i % 6, payload: null }));
  const target = new Map(Array.from({ length: 6 }, (_, i) => [i, 1 / 6]));
  const t0 = performance.now();
  rerankCalibrated(items, target, 30);
  bench.reclassification300ItemsMs = Math.round((performance.now() - t0) * 100) / 100;
}

output.performance = bench;
console.log('\n=== desempenho', JSON.stringify(bench));

fs.writeFileSync('docs/research/data/experiments.json', JSON.stringify(output, null, 1));
