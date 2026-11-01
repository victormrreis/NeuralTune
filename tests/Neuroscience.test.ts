import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DecayedPpm,
  NO_DECAY,
  analyzeSequence,
  entropyBits,
  fitTasteForInformation,
  harmonicEvents,
  kernelWeight,
  predictiveProfile,
  predictFromInformation,
  rhythmicEvents
} from '../src/neuroscience/AuditoryPredictiveCodingEngine.ts';
import {
  kuramotoSynchrony,
  orderParameter,
  patternSimilarity,
  rhythmProfile,
  rhythmicCompatibility,
  tempoSimilarity
} from '../src/neuroscience/RhythmDynamicsEngine.ts';
import { AdaptivePreferencePlasticity, evidenceOf } from '../src/neuroscience/AdaptivePreferencePlasticity.ts';
import { SCIENTIFIC_EVIDENCE, evidenceFor } from '../src/neuroscience/ScientificEvidenceRegistry.ts';
import { NeuralContextModel } from '../src/core/NeuralContextModel.ts';
import { PreferenceEngine } from '../src/core/PreferenceEngine.ts';
import { MemoryStorage } from '../src/storage/MemoryStorage.ts';
import { ALL_MODULES_OFF, ALL_MODULES_ON } from '../src/core/FeatureFlags.ts';
import { baselineV3, evaluate, evaluateRolling, moduleRanker, ndcgAtK, averagePrecisionAtK, temporalSplit, intraListDiversity } from '../src/evaluation/RecommenderEvaluation.ts';
import { TrackMetadata, TrackRatingRecord, Rating } from '../src/types/index.ts';

const DAY = 86_400_000;

function mulberry(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), seed | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('PPM: every predictive distribution sums to 1 and has no zero', () => {
  const model = new DecayedPpm(5);
  const random = mulberry(1);

  for (let t = 0; t < 300; t++) {
    const distribution = model.predict(t);
    assert.ok(Math.abs(distribution.reduce((sum, p) => sum + p, 0) - 1) < 1e-9);
    assert.ok(distribution.every((p) => p > 0));
    model.observe(Math.floor(random() * 5), t);
  }
});

test('PPM: starts uniform, with entropy log₂ of the alphabet', () => {
  const distribution = new DecayedPpm(8).predict(0);
  assert.ok(Math.abs(entropyBits(distribution) - 3) < 1e-12);
});

test('PPM: a deterministic sequence becomes predictable, random noise does not', () => {
  const periodic = Array.from({ length: 400 }, (_, i) => i % 4);
  const random = mulberry(2);
  const noise = Array.from({ length: 400 }, () => Math.floor(random() * 4));

  const ordered = analyzeSequence(periodic, 4, undefined, NO_DECAY);
  const chaotic = analyzeSequence(noise, 4, undefined, NO_DECAY);

  assert.ok(ordered.surprise < 0.3, `${ordered.surprise}`);
  assert.ok(chaotic.surprise > 1.8, `${chaotic.surprise}`);
  assert.ok(chaotic.uncertainty > ordered.uncertainty);
});

test('PPM: an event is scored before being learned, so a first event carries full surprise', () => {
  const { surprise } = analyzeSequence([3], 8, undefined, NO_DECAY);
  assert.ok(Math.abs(surprise - 3) < 1e-9);
});

test('Decay kernel: starts at w₀, halves its excess at t½, and tends to w∞', () => {
  const kernel = { initialWeight: 1, asymptote: 0.2, halfLife: 10 };

  assert.equal(kernelWeight(kernel, 0), 1);
  assert.ok(Math.abs(kernelWeight(kernel, 10) - 0.6) < 1e-12);
  assert.ok(Math.abs(kernelWeight(kernel, 1e6) - 0.2) < 1e-9);
  assert.equal(kernelWeight(NO_DECAY, 1e9), 1);
});

test('PPM-Decay: adapts faster than perfect memory when the statistics change', () => {
  const before = new Array<number>(300).fill(0);
  const after = new Array<number>(60).fill(1);
  const sequence = [...before, ...after];

  const surpriseAfterChange = (kernel: Parameters<typeof analyzeSequence>[3]) => {
    const whole = analyzeSequence(sequence, 3, undefined, kernel);
    const first = analyzeSequence(before, 3, undefined, kernel);
    return (whole.surprise * sequence.length - first.surprise * before.length) / after.length;
  };

  assert.ok(surpriseAfterChange({ initialWeight: 1, asymptote: 0, halfLife: 10 }) < surpriseAfterChange(NO_DECAY));
});

function segments(count: number, pattern: (i: number) => { pitch: number; duration: number; brightness?: number }) {
  let start = 0;
  return Array.from({ length: count }, (_, i) => {
    const { pitch, duration, brightness = 0 } = pattern(i);
    const pitches = new Array<number>(12).fill(0.1);
    pitches[pitch] = 1;
    const segment = { start, duration, confidence: 1, loudness_max: -10, pitches, timbre: [40, brightness, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] };
    start += duration;
    return segment;
  });
}

test('Predictive profile: a looping chord cycle is less surprising than a random one', () => {
  const random = mulberry(3);
  const loop = predictiveProfile({ segments: segments(200, (i) => ({ pitch: [0, 7, 9, 5][i % 4], duration: 0.5 })) });
  const scattered = predictiveProfile({ segments: segments(200, () => ({ pitch: Math.floor(random() * 12), duration: 0.5 })) });

  assert.ok(loop.harmonic!.normalizedSurprise < scattered.harmonic!.normalizedSurprise);
  assert.ok(loop.harmonic!.normalizedUncertainty < scattered.harmonic!.normalizedUncertainty);
});

test('Predictive profile: rhythmic events ignore absolute tempo', () => {
  const at = (scale: number) => rhythmicEvents({ segments: segments(50, (i) => ({ pitch: 0, duration: [0.25, 0.5][i % 2] * scale })) }).symbols;
  assert.deepEqual(at(1), at(0.5));
});

test('Predictive profile: melodic surprise is never fabricated, and short input yields nothing', () => {
  const profile = predictiveProfile({ segments: segments(200, (i) => ({ pitch: i % 12, duration: 0.3 })) });
  assert.equal(profile.melodic, null);

  const empty = predictiveProfile({ segments: segments(3, () => ({ pitch: 0, duration: 1 })) });
  assert.equal(empty.harmonic, null);
  assert.equal(empty.rhythmic, null);
  assert.equal(predictiveProfile({}).timbral, null);
});

test('Harmonic events: repeated centers merge into one event', () => {
  const { symbols } = harmonicEvents({ segments: segments(6, (i) => ({ pitch: i < 3 ? 2 : 7, duration: 1 })) });
  assert.deepEqual(symbols, [2, 7]);
});

test('Information taste: refuses to speak under 30 tracks', () => {
  const taste = fitTasteForInformation(Array.from({ length: 29 }, () => ({ surprise: 0.5, uncertainty: 0.5, reward: 1 })));
  assert.equal(taste.supported, false);
  assert.equal(predictFromInformation(taste, 0.3, 0.3), 0);
});

test('Information taste: recovers an inverted U, the shape of Gold et al., when the data has it', () => {
  const random = mulberry(4);
  const samples = Array.from({ length: 300 }, () => {
    const surprise = random();
    const uncertainty = random();
    return { surprise, uncertainty, reward: 1 - 8 * (surprise - 0.5) ** 2 };
  });

  const taste = fitTasteForInformation(samples);
  assert.equal(taste.supported, true);
  assert.ok(taste.coefficients[3] < -6, `${taste.coefficients[3]}`);

  const mean = 0.5;
  assert.ok(predictFromInformation(taste, 0.5 - mean, 0) > predictFromInformation(taste, 0.95 - mean, 0));
});

test('Information taste: learns the opposite sign when this user has it, nothing is assumed', () => {
  const random = mulberry(5);
  const samples = Array.from({ length: 300 }, () => {
    const surprise = random();
    return { surprise, uncertainty: random(), reward: 8 * (surprise - 0.5) ** 2 - 1 };
  });

  assert.ok(fitTasteForInformation(samples).coefficients[3] > 6);
});

function beats(bpm: number, count: number, jitter: number = 0) {
  const duration = 60 / bpm;
  return Array.from({ length: count }, (_, i) => ({ start: i * duration, duration: duration * (1 + (i % 2 ? jitter : -jitter)), confidence: 1 }));
}

function onBeatSegments(bpm: number, count: number, offset: number = 0) {
  const duration = 60 / bpm;
  return Array.from({ length: count }, (_, i) => ({ start: i * duration + offset * duration, duration: duration / 2, loudness_max: -10 }));
}

test('Rhythm: recovers tempo and regularity from beats', () => {
  const steady = rhythmProfile({ beats: beats(120, 64), segments: onBeatSegments(120, 64) })!;
  const shaky = rhythmProfile({ beats: beats(120, 64, 0.2), segments: onBeatSegments(120, 64) })!;

  assert.ok(Math.abs(steady.bpm - 120) < 1e-6);
  assert.ok(steady.regularity > shaky.regularity + 0.1);
  assert.ok(Math.abs(steady.pattern.reduce((a, b) => a + b, 0) - 1) < 1e-9);
});

test('Rhythm: off-beat onsets raise syncopation', () => {
  const straight = rhythmProfile({ beats: beats(120, 64), segments: onBeatSegments(120, 64) })!;
  const offbeat = rhythmProfile({ beats: beats(120, 64), segments: onBeatSegments(120, 64, 0.5) })!;

  assert.ok(straight.syncopation < 0.05);
  assert.ok(offbeat.syncopation > 0.9);
});

test('Rhythm: without beats there is no profile, not an invented one', () => {
  assert.equal(rhythmProfile({ track: { tempo: 120 } }), null);
});

test('Tempo similarity: identity, symmetry and double time', () => {
  assert.equal(tempoSimilarity(120, 120), 1);
  assert.ok(Math.abs(tempoSimilarity(100, 130) - tempoSimilarity(130, 100)) < 1e-12);
  assert.ok(Math.abs(tempoSimilarity(80, 160) - 1) < 1e-12);
  assert.ok(tempoSimilarity(100, 141) < 0.3);
});

test('Pattern similarity: a shift by whole beats is the same groove, a different one is not', () => {
  const pattern = new Array<number>(16).fill(0);
  pattern[0] = 0.5;
  pattern[6] = 0.5;
  const shifted = pattern.map((_, i) => pattern[(i + 4) % 16]);
  const other = new Array<number>(16).fill(0);
  other[1] = 0.5;
  other[3] = 0.5;

  assert.ok(Math.abs(patternSimilarity(pattern, shifted) - 1) < 1e-9);
  assert.ok(patternSimilarity(pattern, other) < 0.1);
});

test('Rhythmic compatibility stays in [0, 1] and is highest for identical profiles', () => {
  const a = rhythmProfile({ beats: beats(120, 64), segments: onBeatSegments(120, 64) })!;
  const b = rhythmProfile({ beats: beats(95, 64), segments: onBeatSegments(95, 64, 0.5) })!;

  assert.ok(rhythmicCompatibility(a, a) > rhythmicCompatibility(a, b));
  assert.ok(rhythmicCompatibility(a, b) >= 0 && rhythmicCompatibility(a, a) <= 1 + 1e-9);
});

test('Kuramoto: order parameter reference values', () => {
  assert.ok(Math.abs(orderParameter([1, 1, 1]) - 1) < 1e-12);
  assert.ok(orderParameter([0, Math.PI]) < 1e-12);
});

test('Kuramoto: locks under the critical coupling difference, and drifts above it', () => {
  // For two oscillators φ′ = Δω - K sin φ, so a locked state exists only when |Δω| ≤ K
  const locked = kuramotoSynchrony([1, 1.5], { coupling: 1, duration: 60 });
  const drifting = kuramotoSynchrony([1, 4], { coupling: 1, duration: 60 });

  assert.ok(locked > 0.9, `${locked}`);
  assert.ok(drifting < 0.75, `${drifting}`);
});

test('Kuramoto: for two tracks it adds nothing beyond their tempo difference', () => {
  const synchrony = (a: number, b: number) => kuramotoSynchrony([(2 * Math.PI * a) / 60, (2 * Math.PI * b) / 60], { coupling: 1, duration: 40 });

  assert.ok(Math.abs(synchrony(100, 110) - synchrony(130, 140)) < 0.02);
});

test('Plasticity: a lone skip is not rejection, repeated skips are weak evidence', () => {
  const event = { kind: 'early-skip' as const, key: 'a', timestamp: 0 };
  assert.equal(evidenceOf(event, 1, 2), 0);
  assert.ok(evidenceOf(event, 2, 2) < 0);
  assert.ok(evidenceOf(event, 2, 2) > evidenceOf({ kind: 'rating', key: 'a', timestamp: 0, rating: 1 }, 0, 2));

  const model = new AdaptivePreferencePlasticity();
  model.observe(event);
  assert.equal(model.affinity('a', 0), 0);
});

test('Plasticity: involuntary exposure teaches nothing', () => {
  const model = new AdaptivePreferencePlasticity();
  for (let i = 0; i < 50; i++) model.observe({ kind: 'involuntary-exposure', key: 'a', timestamp: i });
  assert.equal(model.affinity('a', 50), 0);
});

test('Plasticity: exposure between skips does not reset the streak, a real listen does', () => {
  const model = new AdaptivePreferencePlasticity();
  model.observe({ kind: 'early-skip', key: 'a', timestamp: 0 });
  model.observe({ kind: 'involuntary-exposure', key: 'a', timestamp: 1 });
  model.observe({ kind: 'early-skip', key: 'a', timestamp: 2 });
  assert.ok(model.read('a', 2).durable < 0);

  const other = new AdaptivePreferencePlasticity();
  other.observe({ kind: 'early-skip', key: 'b', timestamp: 0 });
  other.observe({ kind: 'partial-listen', key: 'b', timestamp: 1 });
  other.observe({ kind: 'early-skip', key: 'b', timestamp: 2 });
  assert.ok(other.read('b', 2).durable >= 0);
});

test('Plasticity: weights stay bounded in [-1, 1] under any feedback', () => {
  const model = new AdaptivePreferencePlasticity();
  for (let i = 0; i < 2000; i++) model.observe({ kind: 'rating', key: 'up', timestamp: i, rating: 5 });
  for (let i = 0; i < 2000; i++) model.observe({ kind: 'rating', key: 'down', timestamp: i, rating: 0 });

  const up = model.read('up', 2000);
  const down = model.read('down', 2000);
  assert.ok(up.durable <= 1 && up.momentary <= 1 && up.durable > 0.9);
  assert.ok(down.durable >= -1 && down.momentary >= -1 && down.durable < -0.9);
});

test('Plasticity: mood fades in hours, lasting taste in months, and an old taste can return', () => {
  const model = new AdaptivePreferencePlasticity();
  for (let i = 0; i < 5; i++) model.observe({ kind: 'rating', key: 'a', timestamp: i, rating: 5 });

  const start = model.read('a', 5);
  const nextDay = model.read('a', DAY);
  assert.ok(nextDay.momentary < start.momentary / 100);
  assert.ok(nextDay.durable > start.durable * 0.95);

  const aYearLater = model.read('a', 365 * DAY);
  assert.ok(aYearLater.durable > 0 && aYearLater.durable < start.durable / 3);

  model.observe({ kind: 'rating', key: 'a', timestamp: 365 * DAY, rating: 5 });
  assert.ok(model.read('a', 365 * DAY).durable > aYearLater.durable);
});

test('Plasticity: an explicit rating outweighs any single listen', () => {
  const rated = new AdaptivePreferencePlasticity();
  rated.observe({ kind: 'rating', key: 'a', timestamp: 0, rating: 4 });
  const heard = new AdaptivePreferencePlasticity();
  heard.observe({ kind: 'complete-listen', key: 'a', timestamp: 0, voluntary: true });

  assert.ok(rated.read('a', 0).durable > heard.read('a', 0).durable);
});

function rated(id: string, artist: string, rating: number, timestamp: number): TrackRatingRecord {
  const metadata: TrackMetadata = { uri: `spotify:track:${id}`, name: id, artists: [{ name: artist, uri: `spotify:artist:${artist}` }], album: { name: '', uri: '' } };
  return { uri: metadata.uri, rating: rating as Rating, timestamp, metadata };
}

function history(size: number): TrackRatingRecord[] {
  return Array.from({ length: size }, (_, i) => {
    const artist = i % 2 === 0 ? 'loved' : 'disliked';
    return rated(`t${i}`, artist, artist === 'loved' ? 5 : 1, 1000 + i);
  });
}

test('Context: the artist term follows the rated mean, shrunk towards neutral', async () => {
  const storage = new MemoryStorage();
  const engine = new PreferenceEngine(storage);
  await engine.init();

  const context = new NeuralContextModel(engine, ALL_MODULES_OFF, 0.5);
  context.fit([rated('a', 'band', 5, 1), rated('b', 'band', 5, 2), rated('c', 'other', 1, 3)]);

  const value = (artist: string) => context.terms(rated('x', artist, 3, 0).metadata, new Date(0)).find((t) => t.key === 'artist')?.value ?? 0;

  assert.ok(Math.abs(value('band') - 0.5 * ((((10 + 6) / 4) - 3) / 2)) < 1e-12);
  assert.ok(value('other') < 0);
  assert.equal(value('stranger'), 0);
});

test('Evaluation: reference values for NDCG and MAP', () => {
  assert.equal(ndcgAtK([1, 1, 0], 2), 1);
  assert.ok(Math.abs(ndcgAtK([0, 1], 1) - 1 / Math.log2(3)) < 1e-12);
  assert.equal(averagePrecisionAtK([1, 0, 1], 2), (1 + 2 / 3) / 2);
  assert.equal(ndcgAtK([0, 0], 0), 0);
});

test('Evaluation: the temporal split leaks nothing from the future', () => {
  const data = { ratings: history(100), plays: [] };
  const { train, test } = temporalSplit(data);

  assert.equal(train.ratings.length, 80);
  assert.ok(Math.max(...train.ratings.map((r) => r.timestamp)) < Math.min(...test.map((r) => r.timestamp)));
});

test('Evaluation: plays after the cut are hidden from training', () => {
  const play = (at: number) => ({ id: String(at), uri: 'u', name: 'n', artistUris: [], startedAt: at, endedAt: at, playedMs: 1, skipped: false });
  const { train } = temporalSplit({ ratings: history(100), plays: [play(1010), play(1099)] });
  assert.equal(train.plays.length, 1);
});

test('Evaluation: too little data is reported, never scored', async () => {
  const report = await evaluate({ ratings: history(6), plays: [] }, { v3: baselineV3 });
  assert.equal(report.usable, false);
  assert.ok(report.reason);
  assert.deepEqual(report.results, {});
});

test('Evaluation: a seeded run is deterministic, and a perfect signal scores high', async () => {
  const data = { ratings: history(120), plays: [] };
  const first = await evaluate(data, { full: moduleRanker(ALL_MODULES_ON) });
  const second = await evaluate(data, { full: moduleRanker(ALL_MODULES_ON) });

  assert.equal(first.results.full.ndcg, second.results.full.ndcg);
  assert.ok(first.results.full.ndcg > 0.95);
});

test('Evaluation: rolling origin reports every usable cut', async () => {
  const report = await evaluateRolling({ ratings: history(200), plays: [] }, { full: moduleRanker(ALL_MODULES_OFF) });

  assert.equal(report.usableCuts, 4);
  assert.equal(report.ndcg.full.perCut.length, 4);
  assert.ok(report.ndcg.full.sd >= 0);
});

test('Evaluation: diversity is 0 for identical tracks, and unknown audio counts as neutral', () => {
  const song = { ...rated('a', 'x', 3, 0).metadata, acousticFeatures: { energy: 0.9, bpm: 150, valence: 0.2 } };
  assert.ok(intraListDiversity([song, song]) < 1e-9);
  assert.equal(intraListDiversity([rated('a', 'x', 3, 0).metadata, rated('b', 'y', 3, 0).metadata]), 0.5);
});

test('Evidence registry: every entry is traceable and complete', () => {
  assert.ok(SCIENTIFIC_EVIDENCE.length >= 6);

  for (const entry of SCIENTIFIC_EVIDENCE) {
    assert.ok(entry.references.length > 0, entry.id);
    assert.ok(entry.equations.length > 0, entry.id);
    for (const field of [entry.hypothesis, entry.limitations, entry.validation, entry.adaptations, entry.evidenceType]) {
      assert.ok(field.length > 10, entry.id);
    }
    for (const reference of entry.references) assert.match(reference.link, /^https:\/\/doi\.org\/10\./);
  }

  assert.equal(evidenceFor('calibration')?.references[0].citation.includes('Steck'), true);
  assert.equal(evidenceFor('inexistente'), undefined);
});

test('Evidence registry: never claims to measure a brain', () => {
  const text = JSON.stringify(SCIENTIFIC_EVIDENCE).toLowerCase();
  for (const claim of ['mede a dopamina', 'seu cérebro', 'mede sua emoção', 'estado emocional']) {
    assert.equal(text.includes(claim), false, claim);
  }
});
