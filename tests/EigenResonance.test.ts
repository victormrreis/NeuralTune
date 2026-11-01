import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TEMPERATURE_DEFAULT,
  TEMPERATURE_DISCOVERY,
  TEMPERATURE_FOCUS,
  ThompsonBanditOptimizer,
  boltzmannDistribution,
  freeEnergyOf,
  posteriorFrom,
  resolveTemperature,
  sampleGamma,
  sampleStandardNormal,
  sampleWithoutReplacement,
  seededRandom,
  shannonEntropyBits
} from '../src/core/ThompsonBanditOptimizer.ts';
import { EigenResonanceRanker, camelotOf } from '../src/core/EigenResonanceRanker.ts';
import { PreferenceEngine } from '../src/core/PreferenceEngine.ts';
import { BlacklistManager } from '../src/core/BlacklistManager.ts';
import { MemoryStorage } from '../src/storage/MemoryStorage.ts';
import {
  COVARIANCE_EXPORT_FILENAME,
  DataPortabilityManager,
  GRAPH_EXPORT_FILENAME
} from '../src/storage/DataPortabilityManager.ts';
import { symmetricEigen, weightedCovariance } from '../src/math/LinearAlgebra.ts';
import { isCamelotCompatible } from '../src/math/Camelot.ts';
import { AcousticFeatures, PlayEvent, Rating, TrackMetadata } from '../src/types/index.ts';

function mean(values: number[]): number {
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function variance(values: number[]): number {
  const m = mean(values);
  return values.reduce((sum, v) => sum + (v - m) ** 2, 0) / values.length;
}

test('Sampling: seeded generator repeats, standard normal has mean 0 and variance 1', () => {
  assert.equal(seededRandom(5)(), seededRandom(5)());

  const random = seededRandom(1);
  const values = Array.from({ length: 200_000 }, () => sampleStandardNormal(random));
  assert.ok(Math.abs(mean(values)) < 0.01);
  assert.ok(Math.abs(variance(values) - 1) < 0.02);
});

test('Sampling: Gamma(k, θ) matches mean k/θ and variance k/θ², including k < 1', () => {
  const random = seededRandom(2);
  for (const [shape, rate] of [[0.5, 1], [2, 3], [9, 0.5]]) {
    const values = Array.from({ length: 200_000 }, () => sampleGamma(shape, rate, random));
    assert.ok(Math.abs(mean(values) - shape / rate) / (shape / rate) < 0.02, `mean ${shape},${rate}`);
    assert.ok(Math.abs(variance(values) - shape / rate ** 2) / (shape / rate ** 2) < 0.05, `var ${shape},${rate}`);
  }
});

test('Normal-Gamma: closed-form update on a worked example', () => {
  const posterior = posteriorFrom([1, 2, 3], { mu: 0, lambda: 1, alpha: 2, beta: 1 });

  assert.equal(posterior.lambda, 4);
  assert.ok(Math.abs(posterior.mu - 1.5) < 1e-12);
  assert.equal(posterior.alpha, 3.5);
  assert.ok(Math.abs(posterior.beta - (1 + 1 + 1.5)) < 1e-12);
});

test('Normal-Gamma: updating in two batches equals one batch', () => {
  const data = [0.3, -0.2, 0.9, 0.5, 0.1];
  const whole = posteriorFrom(data);
  const staged = posteriorFrom(data.slice(2), posteriorFrom(data.slice(0, 2)));

  for (const field of ['mu', 'lambda', 'alpha', 'beta'] as const) {
    assert.ok(Math.abs(whole[field] - staged[field]) < 1e-10, field);
  }
});

test('Thompson: posterior concentrates on the taste as evidence grows', () => {
  const optimizer = new ThompsonBanditOptimizer(2, seededRandom(3));
  const known = [true, true];
  const spread = () => variance(Array.from({ length: 4000 }, () => optimizer.sampleTheta()[0]));

  const before = spread();
  optimizer.fit(Array.from({ length: 400 }, () => ({ context: [1, -1], known, reward: 1 })));
  const after = spread();

  assert.ok(after < before / 20);

  const draws = Array.from({ length: 4000 }, () => optimizer.sampleTheta());
  assert.ok(mean(draws.map((d) => d[0])) > 0.9);
  assert.ok(mean(draws.map((d) => d[1])) < -0.9);
});

test('Thompson: an unknown dimension stays at the prior', () => {
  const optimizer = new ThompsonBanditOptimizer(2, seededRandom(4));
  optimizer.fit([{ context: [1, 5], known: [true, false], reward: 1 }]);

  const [first, second] = optimizer.getPosteriors();
  assert.equal(first.lambda, 2);
  assert.deepEqual(second, { mu: 0, lambda: 1, alpha: 2, beta: 1 });
});

test('Entropy: reference values in bits', () => {
  assert.equal(shannonEntropyBits([0.5, 0.5]), 1);
  assert.equal(shannonEntropyBits([0.25, 0.25, 0.25, 0.25]), 2);
  assert.equal(shannonEntropyBits([1, 0, 0]), 0);
});

test('Boltzmann: probabilities normalize, and order follows utility', () => {
  const { probabilities } = boltzmannDistribution([0.9, 0.5, 0.1], 0.3);
  assert.ok(Math.abs(probabilities.reduce((a, b) => a + b, 0) - 1) < 1e-12);
  assert.ok(probabilities[0] > probabilities[1] && probabilities[1] > probabilities[2]);
});

test('Boltzmann: the temperature spends entropy as specified', () => {
  const utilities = Array.from({ length: 50 }, (_, i) => i / 50);

  const focus = boltzmannDistribution(utilities, TEMPERATURE_FOCUS);
  const discovery = boltzmannDistribution(utilities, TEMPERATURE_DISCOVERY);

  assert.ok(discovery.entropyBits > focus.entropyBits);
  assert.ok(boltzmannDistribution(utilities, 1e-9).entropyBits < 0.1);
  assert.ok(Math.abs(boltzmannDistribution(utilities, 1e6).entropyBits - Math.log2(50)) < 1e-6);
});

test('Boltzmann: it is the actual minimizer of F = Ū - T·H in bits', () => {
  const random = seededRandom(9);
  const utilities = Array.from({ length: 12 }, () => random());

  for (const temperature of [0.1, 0.3, 0.8]) {
    const { probabilities, freeEnergy } = boltzmannDistribution(utilities, temperature);
    assert.ok(Math.abs(freeEnergy - freeEnergyOf(probabilities, utilities, temperature)) < 1e-12);

    for (let trial = 0; trial < 500; trial++) {
      const noisy = probabilities.map((p) => Math.max(1e-12, p * (1 + (random() - 0.5) * 0.4)));
      const total = noisy.reduce((a, b) => a + b, 0);
      const other = noisy.map((p) => p / total);
      assert.ok(freeEnergyOf(other, utilities, temperature) >= freeEnergy - 1e-10);
    }
  }
});

test('Boltzmann: huge gaps do not underflow, an empty list is harmless', () => {
  const { probabilities } = boltzmannDistribution([1000, 0], 0.1);
  assert.ok(Number.isFinite(probabilities[0]));
  assert.equal(probabilities[0], 1);
  assert.deepEqual(boltzmannDistribution([], 0.5).probabilities, []);
});

test('Temperature: focus radios ≈ 0.1, discovery and weekends ≈ 0.8', () => {
  const saturday = new Date(2026, 9, 31);
  const tuesday = new Date(2026, 9, 27);

  assert.equal(resolveTemperature({ radio: 'work', date: saturday }), TEMPERATURE_FOCUS);
  assert.equal(resolveTemperature({ radio: 'study', date: tuesday }), 0.1);
  assert.equal(resolveTemperature({ radio: 'discovery', date: tuesday }), 0.8);
  assert.equal(resolveTemperature({ radio: 'preference', date: saturday }), TEMPERATURE_DISCOVERY);
  assert.equal(resolveTemperature({ radio: 'gym', date: tuesday }), TEMPERATURE_DEFAULT);
});

test('Gumbel-top-k: draws distinct items with the right marginals', () => {
  const random = seededRandom(6);
  const counts = [0, 0, 0];

  for (let i = 0; i < 60_000; i++) counts[sampleWithoutReplacement([0.7, 0.2, 0.1], 1, random)[0]]++;

  assert.ok(Math.abs(counts[0] / 60_000 - 0.7) < 0.01);
  assert.ok(Math.abs(counts[2] / 60_000 - 0.1) < 0.01);

  const drawn = sampleWithoutReplacement([0.1, 0.2, 0.3, 0.4], 4, random);
  assert.deepEqual([...drawn].sort(), [0, 1, 2, 3]);
  assert.ok(!sampleWithoutReplacement([0.5, 0, 0.5], 2, random).includes(1));
});

function track(id: string, features: AcousticFeatures | undefined, artist: string = id): TrackMetadata {
  return {
    uri: `spotify:track:${id}`,
    name: id,
    artists: [{ name: artist, uri: `spotify:artist:${artist}` }],
    album: { name: `Album ${id}`, uri: '' },
    acousticFeatures: features
  };
}

const LOUD: AcousticFeatures = { bpm: 128, energy: 0.8, valence: 0.3, key: 9, mode: 0 };
const QUIET: AcousticFeatures = { bpm: 70, energy: 0.2, valence: 0.7, key: 2, mode: 1 };

async function trained(random = seededRandom(10)) {
  const storage = new MemoryStorage();
  const engine = new PreferenceEngine(storage);
  await engine.init();

  let timestamp = 1;
  const rate = async (t: TrackMetadata, rating: Rating) => {
    const record = { uri: t.uri, rating, timestamp: timestamp++, metadata: t };
    await storage.saveRating(record);
    await engine.updateWithRating(record, null);
  };

  for (let i = 0; i < 12; i++) await rate(track(`l${i}`, LOUD), 5);
  for (let i = 0; i < 6; i++) await rate(track(`q${i}`, QUIET), 1);

  return { storage, engine, ranker: new EigenResonanceRanker(engine, random) };
}

test('camelotOf: reads stored, derived and absent keys', () => {
  assert.deepEqual(camelotOf({ camelot: '8A' }), { number: 8, letter: 'A' });
  assert.deepEqual(camelotOf({ key: 0, mode: 1 }), { number: 8, letter: 'B' });
  assert.equal(camelotOf({ key: 0 }), undefined);
  assert.equal(camelotOf({ key: -1, mode: 1 }), undefined);
  assert.equal(camelotOf(undefined), undefined);
});

test('Ranker: refit moves the hyperbolic profile, and is reproducible', async () => {
  const { ranker, engine } = await trained();
  ranker.refit();
  const position = ranker.getUserPosition();

  assert.ok(position.some((x) => x !== 0));
  assert.ok(Math.hypot(...position) < 1);

  const again = new EigenResonanceRanker(engine, seededRandom(1));
  again.refit();
  assert.deepEqual(again.getUserPosition(), position);
});

test('Ranker: at low temperature a radio favors what the profile likes', async () => {
  const { ranker, engine } = await trained();

  const pool = [
    ...Array.from({ length: 20 }, (_, i) => track(`loud${i}`, { ...LOUD, bpm: 126 + i / 5 })),
    ...Array.from({ length: 20 }, (_, i) => track(`quiet${i}`, { ...QUIET, bpm: 69 + i / 5 }))
  ];

  const predictions = pool.map((t) => engine.evaluateCandidate(t));
  const queue = ranker.compose(predictions, { radio: 'work', length: 10 });

  assert.equal(queue.temperature, 0.1);
  assert.equal(queue.tracks.length, 10);
  assert.ok(queue.tracks.every((t) => t.uri.includes('loud')));
});

test('Ranker: higher temperature means more entropy and more variety between runs', async () => {
  const { engine } = await trained();
  const pool = Array.from({ length: 40 }, (_, i) => track(`t${i}`, { ...LOUD, energy: 0.5 + i / 100, bpm: 120 + i / 10 }));
  const predictions = pool.map((t) => engine.evaluateCandidate(t));

  const draw = (radio: string, seed: number) =>
    new EigenResonanceRanker(engine, seededRandom(seed)).compose(predictions, { radio, length: 8 });

  assert.ok(draw('discovery', 1).thermodynamics.entropyBits >= draw('work', 1).thermodynamics.entropyBits);

  const distinct = (radio: string) => new Set(
    Array.from({ length: 12 }, (_, seed) => draw(radio, seed).tracks.map((t) => t.uri)).flat()
  ).size;
  assert.ok(distinct('discovery') >= distinct('work'));
});

test('Ranker: the composed queue honors harmonic and artist rules', async () => {
  const { engine, ranker } = await trained();

  const keys = [[9, 0], [0, 1], [4, 0], [7, 1], [2, 0], [5, 1]];
  const pool = Array.from({ length: 60 }, (_, i) => {
    const [key, mode] = keys[i % keys.length];
    return track(`t${i}`, { bpm: 124 + (i % 5), energy: 0.7 + (i % 3) / 20, valence: 0.4, key, mode }, `artist${i % 15}`);
  });

  const queue = ranker.compose(pool.map((t) => engine.evaluateCandidate(t)), { radio: 'preference', length: 12 });

  queue.solver.tracks.forEach((current, i) => {
    const next = queue.solver.tracks[i + 1];
    if (next) assert.ok(isCamelotCompatible(current.camelot!, next.camelot!));
    for (let j = 1; j <= 3; j++) {
      const other = queue.solver.tracks[i + j];
      if (other) assert.notDeepEqual(current.artistIds, other.artistIds);
    }
  });
  assert.equal(queue.solver.relaxedTransitions, 0);
  assert.equal(queue.tracks.length, 12);
});

test('Ranker: a library without acoustic data still yields a queue', async () => {
  const storage = new MemoryStorage();
  const engine = new PreferenceEngine(storage);
  await engine.init();

  const pool = Array.from({ length: 12 }, (_, i) => track(`t${i}`, undefined));
  const queue = new EigenResonanceRanker(engine, seededRandom(1)).compose(pool.map((t) => engine.evaluateCandidate(t)), { length: 10 });

  assert.equal(queue.tracks.length, 10);
  assert.equal(queue.solver.unknownTransitions, 9);
});

test('Ranker: an artist known only through rated tracks ranks an unanalyzed new track', async () => {
  const { ranker, engine } = await trained();

  const predictions = [
    track('fav', undefined, 'l0'),
    track('stranger', undefined, 'nobody')
  ].map((t) => engine.evaluateCandidate(t));

  const queue = ranker.compose(predictions, { radio: 'work', length: 2 });
  assert.equal(queue.tracks.length, 2);
  assert.ok(queue.thermodynamics.probabilities[0] > queue.thermodynamics.probabilities[1]);
});

test('Covariance: reference value by hand, with weights', () => {
  const known = [true, true];
  const { mean: m, covariance } = weightedCovariance([
    { values: [0, 0], known, weight: 1 },
    { values: [2, 4], known, weight: 1 }
  ], 2);

  assert.deepEqual(m, [1, 2]);
  assert.deepEqual(covariance, [[1, 2], [2, 4]]);

  const weighted = weightedCovariance([
    { values: [0], known: [true], weight: 3 },
    { values: [4], known: [true], weight: 1 }
  ], 1);
  assert.equal(weighted.mean[0], 1);
  assert.equal(weighted.covariance[0][0], (3 * 1 + 1 * 9) / 4);
});

test('Covariance: unknown values keep Σ positive semidefinite and are counted', () => {
  const { covariance, observationsPerDimension } = weightedCovariance([
    { values: [0, 0], known: [true, false], weight: 1 },
    { values: [1, 1], known: [true, true], weight: 1 },
    { values: [0.5, 0], known: [false, true], weight: 1 }
  ], 2);

  assert.deepEqual(observationsPerDimension, [2, 2]);
  assert.ok(symmetricEigen(covariance).every((pair) => pair.value >= -1e-12));
});

test('Eigen: A v = λ v, orthonormal axes, trace preserved, descending order', () => {
  const random = seededRandom(8);
  const raw = Array.from({ length: 8 }, () => Array.from({ length: 8 }, () => random() - 0.5));
  const a = raw.map((row) => raw.map((other) => row.reduce((sum, v, k) => sum + v * other[k], 0)));

  const pairs = symmetricEigen(a);

  pairs.forEach(({ value, vector }, i) => {
    a.forEach((row, r) => {
      const product = row.reduce((sum, v, c) => sum + v * vector[c], 0);
      assert.ok(Math.abs(product - value * vector[r]) < 1e-9);
    });
    pairs.forEach((other, j) => {
      const inner = vector.reduce((sum, v, k) => sum + v * other.vector[k], 0);
      assert.ok(Math.abs(inner - (i === j ? 1 : 0)) < 1e-9);
    });
    if (i > 0) assert.ok(value <= pairs[i - 1].value);
  });

  const trace = a.reduce((sum, row, i) => sum + row[i], 0);
  assert.ok(Math.abs(pairs.reduce((sum, p) => sum + p.value, 0) - trace) < 1e-9);
});

test('Eigen: closed form for [[2,1],[1,2]]', () => {
  const [first, second] = symmetricEigen([[2, 1], [1, 2]]);
  assert.ok(Math.abs(first.value - 3) < 1e-10);
  assert.ok(Math.abs(second.value - 1) < 1e-10);
  assert.ok(Math.abs(Math.abs(first.vector[0]) - Math.SQRT1_2) < 1e-10);
});

function portability() {
  const storage = new MemoryStorage();
  const manager = new DataPortabilityManager({ storage, blacklist: new BlacklistManager(storage) });
  return { storage, manager };
}

test('Covariance export: liked tracks only, with PCA, ready for numpy', async () => {
  const { storage, manager } = portability();
  await storage.saveRating({ uri: 'spotify:track:a', rating: 5, timestamp: 1, metadata: track('a', { energy: 0.9, bpm: 120 }) });
  await storage.saveRating({ uri: 'spotify:track:b', rating: 5, timestamp: 2, metadata: track('b', { energy: 0.5, bpm: 140 }) });
  await storage.saveRating({ uri: 'spotify:track:c', rating: 1, timestamp: 3, metadata: track('c', { energy: 0.1, bpm: 60 }) });
  await storage.saveRating({ uri: 'spotify:track:d', rating: 5, timestamp: 4, metadata: track('d', undefined) });

  const file = await manager.exportCovariance();
  const data = JSON.parse(file.content);

  assert.equal(file.filename, COVARIANCE_EXPORT_FILENAME);
  assert.equal(data.samples, 2);
  assert.equal(data.dimensions.length, 8);
  assert.equal(data.covariance.length, 8);
  assert.equal(data.covariance[0].length, 8);
  assert.equal(data.eigenvectors.length, 8);
  assert.deepEqual(data.observationsPerDimension.slice(0, 3), [2, 2, 0]);
  assert.ok(Math.abs(data.mean[1] - 0.7) < 1e-12);
  assert.ok(Math.abs(data.covariance[1][1] - 0.04) < 1e-12);
  assert.ok(Math.abs(data.explainedVarianceRatio.reduce((a: number, b: number) => a + b, 0) - 1) < 1e-9);
});

test('Covariance export: no liked tracks is a valid empty result', async () => {
  const data = JSON.parse((await portability().manager.exportCovariance()).content);
  assert.equal(data.samples, 0);
  assert.ok(data.eigenvalues.every((v: number) => v === 0));
});

function play(id: string, startedAt: number, playedMs: number, skipped: boolean, name: string = id): PlayEvent {
  return {
    id: `${id}@${startedAt}`, uri: `spotify:track:${id}`, name, artistUris: [],
    startedAt, endedAt: startedAt + playedMs, playedMs, skipped
  };
}

function attr(block: string, key: string): string | undefined {
  return new RegExp(`<data key="${key}">([^<]*)</data>`).exec(block)?.[1];
}

test('GraphML: edges follow plays, weighted by listening without skips', async () => {
  const { storage, manager } = portability();
  await storage.savePlayEvent(play('a', 0, 100_000, false));
  await storage.savePlayEvent(play('b', 110_000, 180_000, false));
  await storage.savePlayEvent(play('a', 300_000, 90_000, false));
  await storage.savePlayEvent(play('b', 400_000, 120_000, false));
  await storage.savePlayEvent(play('c', 530_000, 4_000, true));

  const file = await manager.exportTransitionGraph();
  const xml = file.content;

  assert.equal(file.filename, GRAPH_EXPORT_FILENAME);
  assert.match(xml, /^<\?xml version="1.0" encoding="UTF-8"\?>/);
  assert.match(xml, /edgedefault="directed"/);
  assert.equal((xml.match(/<node /g) ?? []).length, 3);
  assert.equal((xml.match(/<edge /g) ?? []).length, 3);

  const edges = xml.split('<edge ').slice(1);
  const ab = edges.find((e) => e.startsWith('id="e0"'))!;
  assert.match(ab, /source="n0" target="n1"/);
  assert.equal(attr(ab, 'weight'), '300000');
  assert.equal(attr(ab, 'transitions'), '2');

  const bc = edges.find((e) => /target="n2"/.test(e))!;
  assert.equal(attr(bc, 'weight'), '0');
  assert.equal(attr(bc, 'skips'), '1');
});

test('GraphML: a long pause separates sessions', async () => {
  const { storage, manager } = portability();
  await storage.savePlayEvent(play('a', 0, 60_000, false));
  await storage.savePlayEvent(play('b', 60_000 + 31 * 60_000, 60_000, false));

  const { content } = await manager.exportTransitionGraph();
  assert.equal((content.match(/<edge /g) ?? []).length, 0);
});

test('GraphML: names are escaped, control characters removed, emoji kept', async () => {
  const { storage, manager } = portability();
  await storage.savePlayEvent(play('a', 0, 60_000, false, 'Rock & <Roll> "Live" \u0007 🎸'));

  const { content } = await manager.exportTransitionGraph();

  assert.ok(content.includes('Rock &amp; &lt;Roll&gt; &quot;Live&quot;  🎸'));
  assert.ok(!content.includes('\u0007'));
});

test('GraphML: carries rating and artists of rated tracks, and an empty history is valid', async () => {
  const { storage, manager } = portability();
  assert.match((await manager.exportTransitionGraph()).content, /<\/graphml>/);

  await storage.saveRating({ uri: 'spotify:track:a', rating: 5, timestamp: 1, metadata: track('a', undefined, 'Banda') });
  await storage.savePlayEvent(play('a', 0, 60_000, false));

  const { content } = await manager.exportTransitionGraph();
  assert.equal(attr(content, 'rating'), '5');
  assert.equal(attr(content, 'artists'), 'Banda');
});

test('Import: 3.0 harmonic features survive a JSON round trip', async () => {
  const source = portability();
  await source.storage.saveRating({
    uri: 'spotify:track:a', rating: 5, timestamp: 1,
    metadata: track('a', { bpm: 120, key: 9, mode: 0, camelot: '8A', keyConfidence: 0.8, chroma: [1, 0.5], timbre: [40] })
  });

  const target = portability();
  await target.manager.importJson((await source.manager.exportJson()).content);

  const features = (await target.storage.getRating('spotify:track:a'))?.metadata.acousticFeatures;
  assert.equal(features?.mode, 0);
  assert.equal(features?.camelot, '8A');
  assert.deepEqual(features?.chroma, [1, 0.5]);
});
