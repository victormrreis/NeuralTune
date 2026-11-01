import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStorage } from '../src/storage/MemoryStorage.ts';
import { RatingManager } from '../src/core/RatingManager.ts';
import { BlacklistManager } from '../src/core/BlacklistManager.ts';
import { PreferenceEngine } from '../src/core/PreferenceEngine.ts';
import { EigenResonanceRanker } from '../src/core/EigenResonanceRanker.ts';
import { RadioEngine } from '../src/radios/RadioEngine.ts';
import {
  BANDIT_CONTEXT_SIZE,
  banditContext,
  cosineSimilarity,
  dot,
  identityMatrix,
  invertMatrix,
  matrixVector,
  standardize,
  toAcousticPoint
} from '../src/core/AcousticVector.ts';
import { boltzmannDistribution, sampleGamma, seededRandom, ThompsonBanditOptimizer } from '../src/core/ThompsonBanditOptimizer.ts';
import { synthesizeFeatures } from '../src/core/AudioAnalysisSynthesizer.ts';
import { predictiveProfile } from '../src/neuroscience/AuditoryPredictiveCodingEngine.ts';
import { rhythmProfile } from '../src/neuroscience/RhythmDynamicsEngine.ts';
import { extractMorphology } from '../src/core/SegmentMorphologyEngine.ts';
import { powerIterationPca, weightedCovariance } from '../src/math/LinearAlgebra.ts';
import { PoincareEmbeddingSpace, embedFromOrigin } from '../src/math/PoincareEmbeddingSpace.ts';
import { normalizeSongKey } from '../src/core/SongIdentity.ts';
import { buildUnheardShield } from '../src/radios/UnheardShield.ts';
import { PredictiveQueueGuardian } from '../src/queue/PredictiveQueueGuardian.ts';
import { SmartPlaybackEngine } from '../src/queue/SmartPlaybackEngine.ts';
import { DataPortabilityManager } from '../src/storage/DataPortabilityManager.ts';
import { CandidateHarvester } from '../src/radios/CandidateHarvester.ts';
import { AutonomousDiscoveryCrawler } from '../src/discovery/AutonomousDiscoveryCrawler.ts';
import { createTopTracksDiscoveryBridge, resolveTrackMetadata, timedRequest } from '../src/discovery/GraphqlDiscoveryBridge.ts';
import { fetchNativeRecommendations } from '../src/discovery/NativeRecommendations.ts';
import { AudioFeatureProvider } from '../src/core/AudioFeatureProvider.ts';
import { LatestRunGate, withTimeout } from '../src/core/AsyncGuards.ts';
import { patchRatingMetadata } from '../src/storage/RatingPatch.ts';
import { AcousticFeatures, Rating, TrackMetadata, TrackRatingRecord } from '../src/types/index.ts';

const NOW = 1_700_000_000_000;
const MINUTE = 60_000;

function track(id: string, name = `Song ${id}`, artist = `Artist ${id}`, features?: AcousticFeatures): TrackMetadata {
  return {
    uri: `spotify:track:${id}`,
    name,
    artists: [{ name: artist, uri: `spotify:artist:${artist.replace(/\s+/g, '_')}` }],
    album: { name: 'Album', uri: `spotify:album:${id}` },
    acousticFeatures: features
  };
}

function randomFeatures(random: () => number): AcousticFeatures {
  return {
    bpm: 50 + random() * 150,
    energy: random(),
    valence: random(),
    danceability: random(),
    acousticness: random(),
    instrumentalness: random(),
    speechiness: random(),
    liveness: random(),
    source: 'Spotify Audio Features'
  };
}

const HOSTILE_NUMBERS = [0, 1, -5, 7, 1e308, -1e308, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 5e-324];

function hostileFeatures(random: () => number): AcousticFeatures {
  const pick = () => HOSTILE_NUMBERS[Math.floor(random() * HOSTILE_NUMBERS.length)];
  return {
    bpm: pick(), energy: pick(), valence: pick(), danceability: pick(),
    acousticness: pick(), instrumentalness: pick(), speechiness: pick(), liveness: pick()
  };
}

async function engineWith(ratings: TrackRatingRecord[] = [], now: () => number = () => NOW) {
  const storage = new MemoryStorage();
  await storage.init();
  for (const record of ratings) await storage.saveRating(record);
  const engine = new PreferenceEngine(storage, now);
  await engine.init();
  return { storage, engine };
}

/** Everything the ratings teach, rebuilt from the stored records alone. */
async function replayOf(storage: MemoryStorage) {
  const { engine } = await engineWith(await storage.getAllRatings());
  await engine.reloadFromStorage();
  return engine;
}

function rated(t: TrackMetadata, rating: Rating, timestamp = NOW): TrackRatingRecord {
  return { uri: t.uri, rating, timestamp, metadata: t };
}

/** Rejects when `work` outlives the deadline, so a hang fails the test instead of the whole run. */
function within<T>(ms: number, work: Promise<T>): Promise<T> {
  return withTimeout(work, ms, 'Teste');
}

const forever = <T>() => new Promise<T>(() => undefined);
const later = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function weightsOf(engine: PreferenceEngine) {
  const profile = engine.getProfile();
  const clean = (entries: Record<string, { count: number }>) => Object.fromEntries(
    Object.entries(entries).filter(([, entry]) => entry.count > 0)
  );
  return { attributes: clean(profile.attributeWeights), artists: clean(profile.artistAffinities) };
}

function assertWeightsMatch(actual: PreferenceEngine, expected: PreferenceEngine, label: string) {
  const a = weightsOf(actual);
  const b = weightsOf(expected);
  assert.deepEqual(Object.keys(a.attributes).sort(), Object.keys(b.attributes).sort(), `${label}: atributos`);
  assert.deepEqual(Object.keys(a.artists).sort(), Object.keys(b.artists).sort(), `${label}: artistas`);
  for (const [key, entry] of Object.entries(a.attributes) as Array<[string, { weight: number; count: number }]>) {
    const other = b.attributes[key] as unknown as { weight: number; count: number };
    assert.equal(entry.count, other.count, `${label}: contagem de ${key}`);
    assert.ok(Math.abs(entry.weight - other.weight) < 1e-9, `${label}: peso de ${key}: ${entry.weight} vs ${other.weight}`);
  }
  for (const [key, entry] of Object.entries(a.artists) as Array<[string, { score: number; count: number }]>) {
    const other = b.artists[key] as unknown as { score: number; count: number };
    assert.equal(entry.count, other.count, `${label}: contagem de ${key}`);
    assert.ok(Math.abs(entry.score - other.score) < 1e-9, `${label}: afinidade de ${key}: ${entry.score} vs ${other.score}`);
  }
}

// ---------------------------------------------------------------------------------------------
// A. Matemática
// ---------------------------------------------------------------------------------------------

test('A1 invertMatrix: SPD com condição até 1e10 devolve A·A⁻¹ ≈ I, em 20 sementes', () => {
  for (let seed = 1; seed <= 20; seed++) {
    const random = seededRandom(seed);
    const size = BANDIT_CONTEXT_SIZE;
    const basis = Array.from({ length: 6 }, () => Array.from({ length: size }, () => random() - 0.5));
    const scale = 10 ** (seed % 11);
    const matrix = identityMatrix(size, 1);
    for (const v of basis) {
      for (let i = 0; i < size; i++) {
        for (let j = 0; j < size; j++) matrix[i][j] += scale * v[i] * v[j];
      }
    }

    const inverse = invertMatrix(matrix);
    for (let i = 0; i < size; i++) {
      const row = matrixVector(inverse, matrix.map((r) => r[i]));
      for (let j = 0; j < size; j++) {
        assert.ok(Math.abs(row[j] - (i === j ? 1 : 0)) < 1e-4, `semente ${seed}, célula ${i},${j}: ${row[j]}`);
      }
    }
  }
});

test('A1 invertMatrix: matriz singular e quase singular recusam em vez de devolver lixo', () => {
  assert.throws(() => invertMatrix([[1, 1], [1, 1]]), /Singular/);
  assert.throws(() => invertMatrix([[1, 1], [1, 1 + 1e-14]]), /Singular/);
  assert.throws(() => invertMatrix([[0, 0], [0, 0]]), /Singular/);
});

test('A1 LinUCB: 3000 notas na mesma faixa não degeneram a inversa e a incerteza fica real', async () => {
  const features = randomFeatures(seededRandom(9));
  const ratings = Array.from({ length: 3000 }, (_, i) => rated(track(`dup${i}`, `T${i}`, 'Same', features), 5, NOW + i));
  const { engine } = await engineWith(ratings);

  const result = engine.evaluateCandidate(track('probe', 'Probe', 'Other', features));
  assert.ok(Number.isFinite(result.score));
  assert.ok(result.noveltyScore >= 0 && result.noveltyScore <= 1, `incerteza ${result.noveltyScore}`);
  assert.ok(result.noveltyScore < 0.05, 'muita evidência no mesmo ponto precisa reduzir a incerteza');
});

test('A1 LinUCB: colunas colineares e faixas constantes não dão NaN nem incerteza negativa', async () => {
  const random = seededRandom(3);
  const ratings = Array.from({ length: 800 }, (_, i) => {
    const level = random();
    return rated(track(`col${i}`, `T${i}`, 'Col', {
      bpm: 50 + 150 * level, energy: level, valence: level, danceability: level,
      acousticness: level, instrumentalness: level, speechiness: level, liveness: level
    }), (i % 6) as Rating, NOW + i);
  });
  const { engine } = await engineWith(ratings);

  for (let i = 0; i < 200; i++) {
    const result = engine.evaluateCandidate(track(`c${i}`, `C${i}`, 'Z', randomFeatures(random)));
    assert.ok(Number.isFinite(result.score) && Number.isFinite(result.noveltyScore));
    assert.ok(result.noveltyScore >= 0);
  }
});

test('A1 forma quadrática φᵀA⁻¹φ: nunca negativa além do erro de arredondamento em 2000 contextos', () => {
  const random = seededRandom(41);
  const size = BANDIT_CONTEXT_SIZE;
  const matrix = identityMatrix(size, 1);
  for (let n = 0; n < 2000; n++) {
    const phi = banditContext(Array.from({ length: 8 }, () => random()));
    for (let i = 0; i < size; i++) {
      for (let j = 0; j < size; j++) matrix[i][j] += phi[i] * phi[j];
    }
  }
  const inverse = invertMatrix(matrix);

  for (let n = 0; n < 2000; n++) {
    const phi = banditContext(Array.from({ length: 8 }, () => random()));
    assert.ok(Math.abs(Math.sqrt(dot(phi, phi)) - 1) < 1e-12);
    const quadratic = dot(phi, matrixVector(inverse, phi));
    assert.ok(quadratic > -1e-12 && quadratic <= 1 + 1e-9, `forma quadrática ${quadratic}`);
  }
});

test('A1 mais evidência no mesmo contexto nunca aumenta a incerteza', async () => {
  const features = randomFeatures(seededRandom(77));
  let previous = Number.POSITIVE_INFINITY;
  for (const size of [0, 1, 5, 25, 125]) {
    const ratings = Array.from({ length: size }, (_, i) => rated(track(`m${i}`, `T${i}`, 'M', features), 4, NOW + i));
    const { engine } = await engineWith(ratings);
    const { noveltyScore } = engine.evaluateCandidate(track('probe', 'Probe', 'Q', features));
    assert.ok(noveltyScore <= previous + 1e-12, `n=${size}: ${noveltyScore} > ${previous}`);
    previous = noveltyScore;
  }
});

test('A1 fuzz: vetores hostis nunca produzem pontuação fora de [0, 100] em 15 sementes', async () => {
  for (let seed = 1; seed <= 15; seed++) {
    const random = seededRandom(seed);
    const ratings = Array.from({ length: 120 }, (_, i) => rated(track(`h${i}`, `T${i}`, `A${i % 7}`, hostileFeatures(random)), (i % 6) as Rating, NOW + i));
    const { engine } = await engineWith(ratings);

    for (let i = 0; i < 80; i++) {
      const result = engine.evaluateCandidate(track(`q${i}`, `Q${i}`, `A${i % 7}`, hostileFeatures(random)));
      if (!result.eligible) continue;
      assert.ok(Number.isFinite(result.score) && result.score >= 0 && result.score <= 100, `semente ${seed}: ${result.score}`);
      assert.ok(Number.isFinite(result.confidence) && result.confidence >= 0.1 && result.confidence <= 1);
      assert.ok(Number.isFinite(result.noveltyScore));
    }
  }
});

test('A2 5★ → 1★ → remover volta ao estado neutro, sem deriva em peso, contagem ou vetor', async () => {
  const { storage, engine } = await engineWith();
  const manager = new RatingManager(storage);
  manager.onRatingChange((record, previous) => { void engine.updateWithRating(record, previous); });
  const t = track('p1', 'Paradox', 'Ana', randomFeatures(seededRandom(5)));

  await manager.rateTrack(t, 5);
  await manager.rateTrack(t, 1);
  await manager.deleteRating(t.uri);
  await later(0);

  for (const entry of Object.values(engine.getProfile().attributeWeights)) {
    assert.equal(entry.count, 0);
    assert.equal(entry.weight, 0, 'sem nenhuma nota, o peso precisa ser exatamente zero');
  }
  for (const entry of Object.values(engine.getProfile().artistAffinities)) {
    assert.equal(entry.count, 0);
    assert.equal(entry.score, 0);
  }
  const snapshot = engine.getModelSnapshot();
  assert.equal(snapshot.samples, 0);
  assert.equal(snapshot.clusters.length, 0);
  assert.deepEqual(snapshot.vector, (await engineWith()).engine.getModelSnapshot().vector);
});

test('A2 desfazer uma remoção devolve a contribuição da nota', async () => {
  const { storage, engine } = await engineWith();
  const manager = new RatingManager(storage);
  manager.onRatingChange((record, previous) => { void engine.updateWithRating(record, previous); });
  const t = track('u1', 'Undo', 'Bia', randomFeatures(seededRandom(6)));

  await manager.rateTrack(t, 5);
  const before = JSON.stringify(weightsOf(engine));
  await manager.deleteRating(t.uri);
  await manager.undo();
  await later(0);

  assert.equal(JSON.stringify(weightsOf(engine)), before);
});

test('A2 reavaliar depois que a faixa ganhou dados acústicos não corrompe os atributos', async () => {
  const { storage, engine } = await engineWith();
  const manager = new RatingManager(storage);
  manager.onRatingChange((record, previous) => { void engine.updateWithRating(record, previous); });
  const bare = track('b1', 'Bare', 'Caio');

  await manager.rateTrack(bare, 5);
  await manager.rateTrack({ ...bare, acousticFeatures: { energy: 0.9, bpm: 150 } }, 1);
  await later(0);

  const replay = await replayOf(storage);
  assertWeightsMatch(engine, replay, 'metadados que mudaram');
});

test('A2 propriedade: qualquer sequência de notar, remover, desfazer e refazer equivale a reprocessar o banco', async () => {
  for (let seed = 1; seed <= 12; seed++) {
    const random = seededRandom(seed * 31);
    const { storage, engine } = await engineWith();
    const manager = new RatingManager(storage);
    manager.onRatingChange((record, previous) => { void engine.updateWithRating(record, previous); });
    const pool = Array.from({ length: 12 }, (_, i) => track(`s${i}`, `T${i}`, `A${i % 3}`, randomFeatures(random)));

    for (let step = 0; step < 250; step++) {
      const t = pool[Math.floor(random() * pool.length)];
      const roll = random();
      if (roll < 0.55) await manager.rateTrack(t, Math.floor(random() * 6) as Rating);
      else if (roll < 0.7) await manager.deleteRating(t.uri);
      else if (roll < 0.85) await manager.undo();
      else await manager.redo();
    }
    await later(0);

    const replay = await replayOf(storage);
    assertWeightsMatch(engine, replay, `semente ${seed}`);
  }
});

test('A3 fadiga máxima em toda a piscina não zera a elegibilidade nem esvazia a rádio', async () => {
  const random = seededRandom(14);
  const pool = Array.from({ length: 60 }, (_, i) => track(`f${i}`, `T${i}`, 'Mono Artist', randomFeatures(random)));
  const { storage, engine } = await engineWith();
  for (const t of pool) {
    for (let k = 0; k < 40; k++) {
      engine.recordPlay({
        id: `${t.uri}:${k}`, uri: t.uri, artistUris: t.artists.map((a) => a.uri),
        startedAt: NOW - k * 1000, endedAt: NOW - k * 500, playedMs: 200_000, durationMs: 200_000, skipped: false
      });
    }
  }

  const radio = new RadioEngine(engine, new BlacklistManager(storage));
  const { predictions } = radio.generateRadio(pool, 'preference');
  assert.equal(predictions.length, pool.length, 'fadiga penaliza, nunca exclui');
  assert.ok(predictions.some((p) => p.breakdown?.some((c) => c.key === 'fatigue')));

  const queue = new EigenResonanceRanker(engine, seededRandom(1)).compose(predictions, { length: 30 });
  assert.ok(queue.tracks.length >= 5, `fila com ${queue.tracks.length} faixas`);
});

test('A3 piscina inteira com pontuação zero ainda compõe uma fila', async () => {
  const random = seededRandom(15);
  const block = Array.from({ length: 30 }, (_, i) => rated(track(`z${i}`, `Z${i}`, 'Hated', randomFeatures(random)), 1, NOW + i));
  const { engine } = await engineWith(block);
  const pool = Array.from({ length: 40 }, (_, i) => track(`y${i}`, `Y${i}`, 'Hated', randomFeatures(random)));
  const predictions = pool.map((t) => ({ ...engine.evaluateCandidate(t), score: 0 }));

  const queue = new EigenResonanceRanker(engine, seededRandom(2)).compose(predictions, { length: 20 });
  assert.ok(queue.tracks.length > 0);
});

test('A3 temperaturas extremas e utilidades distantes mantêm a distribuição válida', () => {
  for (const temperature of [0, 1e-12, 1e-6, 0.1, 1, 1e6, 1e12]) {
    const { probabilities, entropyBits } = boltzmannDistribution([1e6, -1e6, 0, 0.5, 0.500001], temperature);
    const total = probabilities.reduce((sum, p) => sum + p, 0);
    assert.ok(Math.abs(total - 1) < 1e-9, `T=${temperature}: soma ${total}`);
    assert.ok(probabilities.every((p) => p >= 0 && Number.isFinite(p)));
    assert.ok(entropyBits >= 0 && entropyBits <= Math.log2(5) + 1e-9);
  }
});

test('A3 Boltzmann ignora utilidade não finita em vez de contaminar a distribuição inteira', () => {
  const { probabilities } = boltzmannDistribution([0.5, Number.NaN, 0.7, Number.POSITIVE_INFINITY], 0.3);
  assert.ok(probabilities.every((p) => Number.isFinite(p) && p >= 0), String(probabilities));
  assert.ok(Math.abs(probabilities.reduce((sum, p) => sum + p, 0) - 1) < 1e-9);
  assert.equal(probabilities[1], 0);
  assert.equal(probabilities[3], 0);
});

test('A3 perfil salvo por versão antiga, sem exploração nem antifadiga, não quebra a avaliação', async () => {
  const storage = new MemoryStorage();
  await storage.init();
  await storage.saveProfile({ id: 'default', name: 'Antigo', attributeWeights: {}, artistAffinities: {} } as never);
  const engine = new PreferenceEngine(storage, () => NOW);
  await engine.init();

  const result = engine.evaluateCandidate(track('old', 'Old', 'Era', randomFeatures(seededRandom(1))));
  assert.ok(Number.isFinite(result.score), `pontuação ${result.score}`);
});

test('A4 fuzz da análise: payloads degenerados ficam na escala e não derrubam nenhum módulo', () => {
  const degenerate: unknown[] = [
    {}, { track: {} }, { track: { tempo: 0, duration: 0 } }, { segments: [] }, { beats: [], segments: [] },
    { track: { tempo: 120, key: -1, mode: -1 }, beats: [{ start: 0 }], segments: [{}] },
    { track: { tempo: Number.NaN, loudness: Number.NaN }, beats: Array.from({ length: 20 }, () => ({ start: 0, duration: 0 })), segments: Array.from({ length: 20 }, () => ({ start: 0, duration: 0 })) }
  ];

  for (let seed = 1; seed <= 300; seed++) {
    const random = seededRandom(seed);
    const pick = () => (random() < 0.3 ? HOSTILE_NUMBERS[Math.floor(random() * HOSTILE_NUMBERS.length)] : random() * 3);
    const vector = (n: number) => (random() < 0.15 ? undefined : Array.from({ length: n }, pick));
    degenerate.push({
      track: { tempo: pick() * 60, duration: pick() * 60, loudness: -pick() * 10, key: Math.floor(random() * 14) - 1, mode: Math.floor(random() * 3) - 1, time_signature: 4 },
      beats: Array.from({ length: Math.floor(random() * 40) }, (_, i) => ({ start: i * 0.5 + pick() * 0.01, duration: pick(), confidence: random() })),
      tatums: Array.from({ length: Math.floor(random() * 20) }, (_, i) => ({ start: i * 0.25, duration: 0.25, confidence: random() })),
      segments: Array.from({ length: Math.floor(random() * 60) }, (_, i) => ({
        start: i * 0.3, duration: pick(), confidence: random(), loudness_start: -pick() * 20, loudness_max: -pick() * 10,
        pitches: vector(12), timbre: vector(12)
      }))
    });
  }

  for (const payload of degenerate) {
    const label = JSON.stringify(payload).slice(0, 120);
    const synthesized = synthesizeFeatures(payload as never);
    if (synthesized) {
      for (const key of ['energy', 'valence', 'danceability', 'acousticness', 'instrumentalness', 'speechiness', 'liveness'] as const) {
        const value = synthesized[key];
        if (value === undefined) continue;
        assert.ok(Number.isFinite(value) && value >= 0 && value <= 1, `${key}=${value} em ${label}`);
      }
      const point = toAcousticPoint(synthesized);
      if (point) assert.ok(point.values.every(Number.isFinite));
    }
    assert.doesNotThrow(() => predictiveProfile(payload as never), label);
    assert.doesNotThrow(() => rhythmProfile(payload as never), label);
    assert.doesNotThrow(() => extractMorphology(payload as never), label);
  }
});

test('A4 valores fora de escala são contidos antes do cosseno, com similaridade sempre em [-1, 1]', () => {
  const random = seededRandom(22);
  for (let n = 0; n < 3000; n++) {
    const a = toAcousticPoint(hostileFeatures(random));
    const b = toAcousticPoint(hostileFeatures(random));
    if (!a || !b) continue;
    const similarity = cosineSimilarity(standardize(a.values), standardize(b.values));
    assert.ok(Number.isFinite(similarity) && similarity >= -1 && similarity <= 1, String(similarity));
    assert.ok(banditContext(a.values).every(Number.isFinite));
  }
});

test('A4 energia NaN ou infinita não vira atributo "energia alta"', async () => {
  const { engine } = await engineWith();
  const attributes = engine.extractAttributes(track('n', 'N', 'N', {
    energy: Number.NaN, instrumentalness: Number.NaN, valence: Number.POSITIVE_INFINITY, acousticness: Number.NaN
  }));
  assert.deepEqual(attributes, []);
});

test('A4 PCA: covariância nula, posto 1 e dimensões desconhecidas ficam finitas e ortogonais', () => {
  const zero = weightedCovariance([], 8).covariance;
  const zeroAxes = powerIterationPca(zero);
  assert.ok(zeroAxes.axes.flat().every(Number.isFinite));
  assert.deepEqual(zeroAxes.explained, [0, 0]);

  const known = new Array(8).fill(true);
  const rankOne = weightedCovariance(Array.from({ length: 50 }, (_, i) => ({ values: new Array(8).fill(i / 50), known, weight: 1 })), 8).covariance;
  const axes = powerIterationPca(rankOne);
  assert.ok(axes.axes.flat().every(Number.isFinite));
  assert.ok(axes.explained[0] > 0.999);
  assert.ok(axes.orthogonality < 1e-6);

  const noneKnown = weightedCovariance([{ values: new Array(8).fill(0.5), known: new Array(8).fill(false), weight: 1 }], 8);
  assert.ok(noneKnown.covariance.flat().every(Number.isFinite));
});

test('A4 Poincaré: 20000 atualizações extremas não saem da bola nem geram NaN', () => {
  const random = seededRandom(8);
  const space = new PoincareEmbeddingSpace();
  for (let n = 0; n < 20_000; n++) {
    const point = embedFromOrigin(Array.from({ length: 8 }, () => (random() < 0.5 ? -3 : 3) * 0.25));
    space.update(point, (n % 6) as Rating);
    const user = space.getUser();
    assert.ok(user.every(Number.isFinite));
    assert.ok(Math.sqrt(dot(user, user)) < 1);
    assert.ok(Number.isFinite(space.affinity(point)));
  }
});

test('A4 Thompson: posterior concentrado e formas pequenas seguem finitos', () => {
  const random = seededRandom(19);
  const optimizer = new ThompsonBanditOptimizer(8, random);
  optimizer.fit(Array.from({ length: 5000 }, () => ({
    context: new Array(8).fill(3), known: new Array(8).fill(true), reward: 1
  })));
  for (let n = 0; n < 2000; n++) assert.ok(optimizer.sampleTheta().every(Number.isFinite));
  for (const shape of [1e-3, 0.5, 1, 2500]) {
    const value = sampleGamma(shape, 1, random);
    assert.ok(Number.isFinite(value) && value >= 0, `forma ${shape}: ${value}`);
  }
});

// ---------------------------------------------------------------------------------------------
// B. Estado, precedência e Modo 100% Inéditas
// ---------------------------------------------------------------------------------------------

async function shieldWorld() {
  const storage = new MemoryStorage();
  await storage.init();
  const blacklist = new BlacklistManager(storage);
  return { storage, blacklist };
}

function shieldOf(
  storage: MemoryStorage,
  blacklist: BlacklistManager,
  library: TrackMetadata[] = [],
  ratings: TrackRatingRecord[] = []
) {
  return buildUnheardShield({
    ratings,
    blockedArtistCount: 0,
    harvest: { tracks: library, libraryUris: new Set(library.map((t) => t.uri)) },
    blacklist
  });
}

function queueBridge(state: { current?: TrackMetadata; queued: TrackMetadata[]; nextUp: TrackMetadata[] }) {
  const log = { skips: 0, removed: [] as string[], paused: 0, notes: [] as string[], volume: 0.7 };
  return {
    log,
    bridge: {
      getQueueState: () => ({ current: state.current, queued: state.queued, nextUp: state.nextUp }),
      async removeFromQueue(items: Array<{ uri: string }>) {
        log.removed.push(...items.map((i) => i.uri));
        const gone = new Set(items.map((i) => i.uri));
        state.queued = state.queued.filter((t) => !gone.has(t.uri));
        state.nextUp = state.nextUp.filter((t) => !gone.has(t.uri));
      },
      skipNext() { log.skips++; },
      pause() { log.paused++; },
      notify(message: string) { log.notes.push(message); },
      getCurrentUri: () => state.current?.uri ?? null,
      getVolume: () => log.volume,
      setVolume(level: number) { log.volume = level; }
    }
  };
}

test('B1 0★ com ♥ na biblioteca: o bloqueio vence no escore, no escudo e no guardião', async () => {
  const { storage, blacklist } = await shieldWorld();
  const engine = new PreferenceEngine(storage, () => NOW);
  await engine.init();
  const t = track('both', 'Both', 'Duda', randomFeatures(seededRandom(2)));
  const record = rated(t, 0);
  await storage.saveRating(record);

  assert.equal(engine.evaluateCandidate(t).eligible, false);
  assert.equal(shieldOf(storage, blacklist, [t], [record]).isExcluded(t), true);

  const state = { current: t, queued: [], nextUp: [t] };
  const { bridge, log } = queueBridge(state);
  const guardian = new PredictiveQueueGuardian(blacklist, bridge, { skipSettleMs: 0, restoreDelayMs: 0 });
  await guardian.inspectAndCleanQueue(true);
  assert.equal(log.skips, 1);
  assert.deepEqual(log.removed, [t.uri]);
});

test('B1 desbloquear remove a nota 0★: nada sobra para o escudo, e o Trash Bin não rebloqueia', async () => {
  const { storage, blacklist } = await shieldWorld();
  const manager = new RatingManager(storage);
  const t = track('free', 'Free', 'Eva');
  const values = new Map<string, string>([['TrashSongList', JSON.stringify({ [t.uri]: true })], ['TrashArtistList', '{}']]);
  const keyValue = { get: (k: string) => values.get(k) ?? null, set: (k: string, v: string) => { values.set(k, v); } };
  const portability = new DataPortabilityManager({ storage, blacklist, keyValue });

  await portability.syncTrashBin();
  assert.equal(storage.isTrackBlocked(t.uri), true);

  assert.equal(await manager.deleteRating(t.uri), true);
  assert.equal(storage.isTrackBlocked(t.uri), false);
  assert.equal(await storage.getRating(t.uri), null);
  assert.equal(shieldOf(storage, blacklist, [], await storage.getAllRatings()).isExcluded(t), false);

  values.set('TrashSongList', JSON.stringify({ [t.uri]: true, 'spotify:track:other': true }));
  await portability.syncTrashBin();
  assert.equal(storage.isTrackBlocked(t.uri), false, 'sincronização automática respeita o desbloqueio');
  assert.equal(storage.isTrackBlocked('spotify:track:other'), true);
});

test('B1 faixa bloqueada na fila manual sobrevive à limpeza e é pulada uma vez ao chegar', async () => {
  const { storage, blacklist } = await shieldWorld();
  const t = track('manual', 'Manual', 'Fabi');
  await storage.saveRating(rated(t, 0));
  const state: { current?: TrackMetadata; queued: TrackMetadata[]; nextUp: TrackMetadata[] } = { current: track('ok'), queued: [t], nextUp: [] };
  const { bridge, log } = queueBridge(state);
  const guardian = new PredictiveQueueGuardian(blacklist, bridge, { skipSettleMs: 0, restoreDelayMs: 0 });

  await guardian.inspectAndCleanQueue(true);
  assert.deepEqual(log.removed, [], 'a fila manual é ação voluntária e fica');

  state.queued = [];
  state.current = t;
  await guardian.inspectAndCleanQueue(true);
  assert.equal(log.skips, 1);
  assert.equal(guardian.isCircuitTripped(), false);
});

test('B1 faixa bloqueada em repetição infinita aciona o disjuntor em vez de pular para sempre', async () => {
  const { storage, blacklist } = await shieldWorld();
  const t = track('loop', 'Loop', 'Gui');
  await storage.saveRating(rated(t, 0));
  const state = { current: t, queued: [], nextUp: [] };
  const { bridge, log } = queueBridge(state);
  const guardian = new PredictiveQueueGuardian(blacklist, bridge, { skipSettleMs: 0, duplicateSkipMs: 0, restoreDelayMs: 0, restoreTimeoutMs: 5 });

  for (let n = 0; n < 200 && !guardian.isCircuitTripped(); n++) await guardian.inspectAndCleanQueue(true);

  assert.equal(guardian.isCircuitTripped(), true);
  assert.ok(log.skips < 11, `${log.skips} pulos antes do disjuntor`);
  assert.equal(log.paused, 1);
  assert.equal(log.volume, 0.7, 'o disjuntor devolve o volume');
});

test('B1 regra "todas as versões" importada vale nas rádios', async () => {
  const { storage, blacklist } = await shieldWorld();
  await blacklist.addVersionRule({
    trackName: 'Hino', artistName: 'Hugo', blockAllVersions: true, blockLiveVersionsOnly: false, blockRemixesOnly: false, timestamp: NOW
  } as never);
  const shield = shieldOf(storage, blacklist);

  assert.equal(shield.isExcluded(track('v1', 'Hino', 'Hugo')), true);
  assert.equal(shield.isExcluded(track('v2', 'Hino - Ao Vivo', 'Hugo')), true);
  assert.equal(shield.isExcluded(track('v3', 'Outra', 'Hugo')), false);
});

test('B1 artista bloqueado em posição secundária e nota sem metadados também barram', async () => {
  const { storage, blacklist } = await shieldWorld();
  await blacklist.blockArtist('spotify:artist:guest', 'Guest');
  const placeholder: TrackMetadata = { uri: 'spotify:track:ph', name: 'Faixa', artists: [], album: { name: '', uri: '' } };
  const record = rated(placeholder, 0);
  await storage.saveRating(record);
  const shield = shieldOf(storage, blacklist, [], [record]);

  assert.equal(shield.isExcluded({ ...track('c1'), artists: [{ name: 'Host', uri: 'spotify:artist:host' }, { name: 'Guest', uri: 'spotify:artist:guest' }] }), true);
  assert.equal(shield.isExcluded(placeholder), true);
  assert.equal(shield.isExcluded(track('c2')), false);
});

const SAME_SONG: Array<[string, string]> = [
  ['Song', 'Song - 2011 Remaster'],
  ['Song', 'Song - Remastered 2009'],
  ['Song', 'Song - 2015 Remastered Version'],
  ['Song', 'Song (2011 Remaster)'],
  ['Song', 'Song (Remastered 2015)'],
  ['Song', 'Song [Remastered]'],
  ['Song', 'Song (feat. Xis)'],
  ['Song', 'Song (ft. Xis)'],
  ['Song', 'Song (featuring Xis)'],
  ['Song', 'Song [feat. Xis]'],
  ['Song', 'Song feat. Xis'],
  ['Song', 'Song (with Xis)'],
  ['Song', 'Song (Live at Wembley)'],
  ['Song', 'Song - Live at Wembley'],
  ['Song', 'Song [Live]'],
  ['Song', 'Song - Ao Vivo'],
  ['Song', 'Song (Ao Vivo)'],
  ['Song', 'Song - En Vivo'],
  ['Song', 'Song - Radio Edit'],
  ['Song', 'Song - Single Version'],
  ['Song', 'Song - Mono'],
  ['Song', 'Song (Stereo Version)'],
  ['Song', 'Song - Deluxe Edition'],
  ['Song', 'SONG'],
  ['Song', 'Song - Lively Remix'],
  ['Song', 'Song (Club Mix)'],
  ['Song', 'Song - Acoustic'],
  ['Song', 'Song (Versão Acústica)'],
  ['Song', "Song (Taylor's Version)"],
  ['Song', 'Song [Instrumental]'],
  ['Song', 'Song - Re-Recorded'],
  ['Song', '  song  '],
  ['Song - 2011 Remaster', 'Song - 2009 Remaster'],
  ['Song (Live at Wembley)', 'Song - Ao Vivo'],
  ['Song - 2011 Remaster - Live', 'Song'],
  ['Canção', 'Cancao'],
  ['The Scientist', 'Scientist'],
  ['Песня (feat. Иван)', 'Песня'],
  ['夜に駆ける - Live', '夜に駆ける']
];

for (const [a, b] of SAME_SONG) {
  test(`B2 mesma música: "${a}" ≡ "${b}"`, () => {
    const left = normalizeSongKey({ name: a, artists: [{ name: 'Yuri' }] });
    assert.notEqual(left, null);
    assert.equal(left, normalizeSongKey({ name: b, artists: [{ name: 'Yuri' }] }));
  });
}

const DIFFERENT_SONG: Array<[string, string]> = [
  ['Песня', 'Танец'],
  ['Песня 2', 'Танец 2'],
  ['夜に駆ける', '群青'],
  ['봄날', '다이너마이트'],
  ['أغنية', 'رقصة'],
  ['Τραγούδι', 'Χορός'],
  ['💔', '🔥'],
  ['Live Forever', 'Forever'],
  ['Song - Monologue', 'Song'],
  ['Song - Livewire', 'Song'],
  ['Love', 'Love Me'],
  ['Song Remix', 'Song'],
  ['1999', '2000']
];

for (const [a, b] of DIFFERENT_SONG) {
  test(`B2 músicas diferentes: "${a}" ≠ "${b}"`, () => {
    const left = normalizeSongKey({ name: a, artists: [{ name: 'Yuri' }] });
    assert.notEqual(left, null, `"${a}" perdeu a identidade`);
    assert.notEqual(left, normalizeSongKey({ name: b, artists: [{ name: 'Yuri' }] }));
  });
}

test('B2 variações de artista: artigo, acento, largura e alfabetos', () => {
  const key = (name: string, artist: string) => normalizeSongKey({ name, artists: [{ name: artist }] });
  assert.equal(key('Help', 'The Beatles'), key('Help', 'Beatles'));
  assert.equal(key('Halo', 'Beyoncé'), key('Halo', 'Beyonce'));
  assert.equal(key('Halo', 'ＢＥＹＯＮＣＥ'), key('Halo', 'beyonce'));
  assert.notEqual(key('Песня', 'Кино'), null);
  assert.notEqual(key('Песня', 'Кино'), key('Песня', 'Сплин'));
  assert.notEqual(key('歌', '米津玄師'), key('歌', 'ヨルシカ'));
  assert.notEqual(key('The', 'The The'), null);
});

test('B2 sem identidade confiável devolve null, nunca uma chave que junte faixas distintas', () => {
  assert.equal(normalizeSongKey(null), null);
  assert.equal(normalizeSongKey({ name: 'Faixa', artists: [{ name: 'X' }] }), null);
  assert.equal(normalizeSongKey({ name: 'Sem título', artists: [{ name: 'X' }] }), null);
  assert.equal(normalizeSongKey({ name: 'Real', artists: [] }), null);
  assert.equal(normalizeSongKey({ name: 'Real', artists: [{ name: 'Desconhecido' }] }), null);
});

test('B2 parceria com ordem de artistas invertida também é a mesma música', async () => {
  const { storage, blacklist } = await shieldWorld();
  const original: TrackMetadata = { ...track('duo1', 'Duet'), artists: [{ name: 'Ana', uri: 'spotify:artist:a' }, { name: 'Bruno', uri: 'spotify:artist:b' }] };
  const swapped: TrackMetadata = { ...track('duo2', 'Duet'), artists: [{ name: 'Bruno', uri: 'spotify:artist:b' }, { name: 'Ana', uri: 'spotify:artist:a' }] };

  assert.equal(shieldOf(storage, blacklist, [], [rated(original, 5)]).isExcluded(swapped), true);
  assert.equal(shieldOf(storage, blacklist, [original]).isExcluded(swapped), true);
  assert.equal(shieldOf(storage, blacklist, [], [rated(original, 5)]).isExcluded(track('solo', 'Duet', 'Carla')), false);
});

const ALPHABETS = [
  'abcdefghijklmnopqrstuvwxyz', 'áàâãéêíóôõúçñü', 'абвгдежзиклмнопрстуфхцчшщыэюя', 'あいうえおかきくけこさしすせそたちつてと',
  '夜空海山川風雪花月星光影音楽歌', 'ㄱ가나다라마바사아자차카타파하', 'αβγδεζηθικλμνξοπρστυφχψω', 'ابتثجحخدذرزسشصضطظعغفق', 'אבגדהוזחטיכלמנסעפצקרשת'
];
const DECORATIONS: Array<(title: string, n: number) => string> = [
  (t) => t,
  (t) => t.toUpperCase(),
  (t) => `  ${t}  `,
  (t) => `The ${t}`,
  (t, n) => `${t} - ${1960 + n % 60} Remaster`,
  (t, n) => `${t} - Remastered ${1960 + n % 60}`,
  (t, n) => `${t} (${1960 + n % 60} Remaster)`,
  (t) => `${t} (feat. Zé & Jú)`,
  (t) => `${t} [ft. Ж]`,
  (t) => `${t} (Live at Budokan)`,
  (t) => `${t} - Ao Vivo`,
  (t) => `${t} - Radio Edit`,
  (t) => `${t} - Deluxe Edition`
];

test('B2 fuzz: 6000 títulos em 9 alfabetos, avaliados sob outro URI, nunca vazam para a rádio', async () => {
  const random = seededRandom(2026);
  const { storage, blacklist } = await shieldWorld();
  const ratings: TrackRatingRecord[] = [];
  const decorated: TrackMetadata[] = [];

  for (let n = 0; n < 6000; n++) {
    const alphabet = ALPHABETS[n % ALPHABETS.length];
    const word = (size: number) => Array.from({ length: size }, () => alphabet[Math.floor(random() * alphabet.length)]).join('');
    const title = `${word(5)} ${word(6)}`;
    const artist = `${word(4)} ${word(4)}`;
    const original = track(`orig${n}`, title, artist);
    ratings.push(rated(original, (n % 6) as Rating));
    const decorate = DECORATIONS[Math.floor(random() * DECORATIONS.length)];
    decorated.push(track(`alt${n}`, decorate(title, n), artist));
  }

  const shield = shieldOf(storage, blacklist, [], ratings);
  const leaked = (await shield.filterUnheard(decorated)).map((t) => t.name);
  assert.deepEqual(leaked.slice(0, 10), [], `${leaked.length} vazamentos`);
});

test('B2 fuzz: 2000 pares sem relação não colidem, mesmo só com caracteres não latinos', async () => {
  const random = seededRandom(7);
  const keys = new Set<string>();
  for (let n = 0; n < 2000; n++) {
    const alphabet = ALPHABETS[n % ALPHABETS.length];
    const title = Array.from({ length: 10 }, () => alphabet[Math.floor(random() * alphabet.length)]).join('');
    const key = normalizeSongKey({ name: title, artists: [{ name: 'Mesmo Artista' }] });
    assert.notEqual(key, null, title);
    keys.add(key as string);
  }
  assert.ok(keys.size >= 1990, `${2000 - keys.size} colisões`);
});

test('B2 entradas patológicas não travam: 200 mil caracteres, controle e surrogates soltos', () => {
  const started = performance.now();
  for (const name of ['a'.repeat(200_000), ' - '.repeat(50_000), `(${'('.repeat(50_000)}`, '𐀀\ud800', '\u0000\u0007‮', '-', '()', '[ ]']) {
    assert.doesNotThrow(() => normalizeSongKey({ name, artists: [{ name }] }));
  }
  assert.ok(performance.now() - started < 1500, 'sem retrocesso catastrófico na expressão regular');
});

function importPayload(ratings: unknown[], extra: Record<string, unknown> = {}) {
  return JSON.stringify({ schemaVersion: 2, ratings, ...extra });
}

async function portabilityWorld(resolveTracks?: (uris: string[]) => Promise<Map<string, TrackMetadata>>) {
  const { storage, blacklist } = await shieldWorld();
  return { storage, blacklist, portability: new DataPortabilityManager({ storage, blacklist, resolveTracks }) };
}

test('B3 "newest": o resultado independe da ordem das linhas e de timestamps invertidos', async () => {
  const t = track('imp');
  const lines = [rated(t, 1, NOW + 5), rated(t, 5, NOW + 9), rated(t, 3, NOW - 100)];
  const winners = new Set<number | undefined>();

  for (const order of [[0, 1, 2], [2, 1, 0], [1, 0, 2], [1, 2, 0], [2, 0, 1], [0, 2, 1]]) {
    const { storage, portability } = await portabilityWorld();
    await storage.saveRating(rated(t, 2, NOW));
    await portability.importJson(importPayload(order.map((i) => lines[i])), { strategy: 'newest' });
    winners.add((await storage.getRating(t.uri))?.rating);
  }
  assert.deepEqual([...winners], [5]);
});

test('B3 "newest": empate de timestamp mantém o local, e o relatório fecha a conta', async () => {
  const t = track('tie');
  const { storage, portability } = await portabilityWorld();
  await storage.saveRating(rated(t, 2, NOW));
  const report = await portability.importJson(importPayload([rated(t, 5, NOW)]), { strategy: 'newest' });

  assert.equal((await storage.getRating(t.uri))?.rating, 2);
  assert.equal(report.conflicts, 1);
  assert.equal(report.keptLocal, 1);
  assert.equal(report.replacedRatings, 0);
});

test('B3 "replace": bloqueio local substituído atualiza o cache e é relatado', async () => {
  const t = track('unb');
  const { storage, blacklist, portability } = await portabilityWorld();
  await storage.saveRating(rated(t, 0, NOW));
  const report = await portability.importJson(importPayload([rated(t, 4, NOW - 1)]), { strategy: 'replace' });

  assert.equal(report.unblockedByMerge, 1);
  assert.equal(storage.isTrackBlocked(t.uri), false);
  assert.equal(blacklist.isBlockedFast(t.uri, []), false);
});

test('B3 "newest": 0★ importado sobre 5★ bloqueia de imediato, sem esperar reinício', async () => {
  const t = track('blk');
  const { storage, portability } = await portabilityWorld();
  await storage.saveRating(rated(t, 5, NOW));
  await portability.importJson(importPayload([rated(t, 0, NOW + 1)]), { strategy: 'newest' });
  assert.equal(storage.isTrackBlocked(t.uri), true);
});

test('B3 "ask": resolvedor que falha no meio não corrompe nem apaga o que já existe', async () => {
  const a = track('aa');
  const b = track('bb');
  const { storage, portability } = await portabilityWorld();
  await storage.saveRating(rated(a, 2, NOW));
  await storage.saveRating(rated(b, 2, NOW));
  let calls = 0;

  await assert.rejects(portability.importJson(importPayload([rated(a, 5), rated(b, 5)]), {
    strategy: 'ask',
    resolveConflict: async () => {
      if (++calls === 2) throw new Error('modal fechado');
      return 'imported';
    }
  }));

  assert.equal((await storage.getRating(a.uri))?.rating, 5);
  assert.equal((await storage.getRating(b.uri))?.rating, 2);
});

test('B3 payload hostil é recusado linha a linha, sem perder as válidas', async () => {
  const good = track('good');
  const { storage, portability } = await portabilityWorld();
  const report = await portability.importJson(importPayload([
    rated(good, 4),
    { uri: 'spotify:track:x', rating: 7, timestamp: NOW },
    { uri: 'spotify:track:y', rating: 2.5, timestamp: NOW },
    { uri: 'spotify:track:z', rating: 3, timestamp: 'ontem' },
    { uri: 'javascript:alert(1)', rating: 3, timestamp: NOW },
    { uri: 'spotify:track:w', rating: -1, timestamp: NOW },
    null, 42, 'lixo'
  ]));

  assert.equal(report.addedRatings, 1);
  assert.equal(report.invalidRecords, 8);
  assert.equal((await storage.getAllRatings()).length, 1);
});

test('B3 importação e Trash Bin simultâneos terminam num estado único e consistente', async () => {
  for (let seed = 1; seed <= 10; seed++) {
    const random = seededRandom(seed);
    const uris = Array.from({ length: 30 }, (_, i) => `spotify:track:mix${i}`);
    const values = new Map<string, string>([
      ['TrashSongList', JSON.stringify(Object.fromEntries(uris.filter(() => random() < 0.5).map((uri) => [uri, true])))],
      ['TrashArtistList', '{}']
    ]);
    const { storage, blacklist } = await shieldWorld();
    const keyValue = { get: (k: string) => values.get(k) ?? null, set: (k: string, v: string) => { values.set(k, v); } };
    const portability = new DataPortabilityManager({ storage, blacklist, keyValue });

    await Promise.all([
      portability.importJson(importPayload(uris.map((uri) => rated(track(uri.split(':')[2]), 4, NOW))), { strategy: 'highest' }),
      portability.syncTrashBin(true),
      portability.syncTrashBin(true)
    ]);

    const stored = await storage.getAllRatings();
    assert.equal(stored.length, uris.length);
    for (const record of stored) {
      assert.equal(storage.isTrackBlocked(record.uri), record.rating === 0, `semente ${seed}: cache divergente em ${record.uri}`);
    }
  }
});

test('B3 preencher metadados em segundo plano nunca sobrescreve uma nota dada durante a consulta', async () => {
  const t: TrackMetadata = { uri: 'spotify:track:ph1', name: 'Faixa', artists: [], album: { name: '', uri: '' } };
  let release: (value: Map<string, TrackMetadata>) => void = () => undefined;
  const { storage, portability } = await portabilityWorld(() => new Promise((resolve) => { release = resolve; }));
  await storage.saveRating(rated(t, 3));

  const exporting = portability.exportJson();
  await later(1);
  await storage.saveRating(rated(t, 0, NOW + 1));
  release(new Map([[t.uri, track('ph1', 'Nome Real', 'Artista Real')]]));
  await exporting;

  const after = await storage.getRating(t.uri);
  assert.equal(after?.rating, 0, 'a nota nova precisa sobreviver');
  assert.equal(after?.metadata.name, 'Nome Real');
});

test('B3 preencher metadados não ressuscita uma nota removida durante a consulta', async () => {
  const t: TrackMetadata = { uri: 'spotify:track:ph2', name: 'Faixa', artists: [], album: { name: '', uri: '' } };
  let release: (value: Map<string, TrackMetadata>) => void = () => undefined;
  const { storage, portability } = await portabilityWorld(() => new Promise((resolve) => { release = resolve; }));
  await storage.saveRating(rated(t, 0));

  const exporting = portability.exportJson();
  await later(1);
  await storage.deleteRating(t.uri);
  release(new Map([[t.uri, track('ph2', 'Nome Real', 'Artista Real')]]));
  await exporting;

  assert.equal(await storage.getRating(t.uri), null);
  assert.equal(storage.isTrackBlocked(t.uri), false);
});

test('B3 patchRatingMetadata lê a nota viva, para o backfill acústico não reverter uma nota nova', async () => {
  const { storage } = await shieldWorld();
  const t = track('live');
  await storage.saveRating(rated(t, 5));
  await storage.saveRating(rated(t, 0, NOW + 1));

  assert.equal(await patchRatingMetadata(storage, t.uri, (metadata) => ({ ...metadata, acousticFeatures: { energy: 0.5 } })), true);
  const after = await storage.getRating(t.uri);
  assert.equal(after?.rating, 0);
  assert.equal(after?.metadata.acousticFeatures?.energy, 0.5);

  await storage.deleteRating(t.uri);
  assert.equal(await patchRatingMetadata(storage, t.uri, (metadata) => metadata), false);
  assert.equal(await storage.getRating(t.uri), null);
});

// ---------------------------------------------------------------------------------------------
// C. Concorrência e runtime
// ---------------------------------------------------------------------------------------------

test('C1 notas concorrentes na mesma faixa: cada uma enxerga a anterior e a contagem não duplica', async () => {
  const { storage, engine } = await engineWith();
  const manager = new RatingManager(storage);
  manager.onRatingChange((record, previous) => { void engine.updateWithRating(record, previous); });
  const t = track('race', 'Race', 'Iris', { energy: 0.9, bpm: 150 });

  await Promise.all([manager.rateTrack(t, 5), manager.rateTrack(t, 4), manager.rateTrack(t, 1), manager.rateTrack(t, 2), manager.rateTrack(t, 0)]);
  await later(0);

  assert.equal((await storage.getRating(t.uri))?.rating, 0);
  const replay = await replayOf(storage);
  assertWeightsMatch(engine, replay, 'mesma faixa');
});

test('C1 5 faixas avaliadas em menos de 500 ms deixam modelo e banco coerentes', async () => {
  const random = seededRandom(64);
  const { storage, engine } = await engineWith();
  const manager = new RatingManager(storage);
  manager.onRatingChange((record, previous) => { void engine.updateWithRating(record, previous); });
  const tracks = Array.from({ length: 5 }, (_, i) => track(`fast${i}`, `F${i}`, 'Same', randomFeatures(random)));

  const started = performance.now();
  await Promise.all(tracks.map((t, i) => manager.rateTrack(t, ([0, 4, 5, 4, 0] as Rating[])[i])));
  await later(0);
  assert.ok(performance.now() - started < 500);

  const replay = await replayOf(storage);
  assertWeightsMatch(engine, replay, 'faixas diferentes');
  assert.equal(storage.isTrackBlocked(tracks[0].uri), true);
  assert.equal(storage.isTrackBlocked(tracks[1].uri), false);
});

test('C1 notar e remover ao mesmo tempo terminam serializados', async () => {
  const { storage, engine } = await engineWith();
  const manager = new RatingManager(storage);
  manager.onRatingChange((record, previous) => { void engine.updateWithRating(record, previous); });
  const t = track('mix', 'Mix', 'Jo', { energy: 0.2 });
  await manager.rateTrack(t, 3);

  await Promise.all([manager.deleteRating(t.uri), manager.rateTrack(t, 5), manager.deleteRating(t.uri), manager.rateTrack(t, 1)]);
  await later(0);

  const replay = await replayOf(storage);
  assertWeightsMatch(engine, replay, 'notar e remover');
});

test('C1 uma nota que falha ao salvar não trava as próximas da mesma faixa', async () => {
  const { storage } = await engineWith();
  const manager = new RatingManager(storage);
  const t = track('fail');
  const save = storage.saveRating.bind(storage);
  let failures = 1;
  storage.saveRating = async (record: TrackRatingRecord) => {
    if (failures-- > 0) throw new Error('disco cheio');
    return save(record);
  };

  await assert.rejects(manager.rateTrack(t, 5));
  await within(200, manager.rateTrack(t, 4));
  assert.equal((await storage.getRating(t.uri))?.rating, 4);
});

test('C1 LatestRunGate: só a última rodada segue válida', () => {
  const gate = new LatestRunGate();
  const first = gate.begin();
  assert.equal(gate.isCurrent(first), true);
  const second = gate.begin();
  assert.equal(gate.isCurrent(first), false);
  assert.equal(gate.isCurrent(second), true);
});

/** Player with latency that interleaves, like the real one: every call yields before applying. */
function slowPlayer(latencyMs = 2) {
  const player = { current: '', queue: [] as string[], plays: [] as string[], notes: [] as string[] };
  return {
    player,
    bridge: {
      async playTrack(uri: string) {
        await later(latencyMs);
        player.current = uri;
        player.plays.push(uri);
      },
      async addToQueue(tracks: Array<{ uri: string }>) {
        await later(latencyMs);
        player.queue.push(...tracks.map((t) => t.uri));
      },
      async setQueue(tracks: Array<{ uri: string }>) {
        await later(latencyMs);
        player.queue = [];
        await later(latencyMs);
        player.queue.push(...tracks.map((t) => t.uri));
      },
      notify(message: string) { player.notes.push(message); }
    }
  };
}

async function playback(bridge: ReturnType<typeof slowPlayer>['bridge'], config?: { timeoutMs?: number }) {
  const { storage, engine } = await engineWith();
  return new SmartPlaybackEngine(new BlacklistManager(storage), engine, bridge, config);
}

test('C2 cliques seguidos em Nova Seleção: a fila final é só da última rádio, sem misturar', async () => {
  for (let burst = 2; burst <= 6; burst++) {
    const { player, bridge } = slowPlayer();
    const engine = await playback(bridge);
    const radios = Array.from({ length: burst }, (_, r) => Array.from({ length: 12 }, (_, i) => track(`r${r}t${i}`)));

    await Promise.all(radios.map((radio) => engine.startPlayback(radio)));

    const last = radios[burst - 1];
    assert.equal(player.current, last[0].uri, `rajada de ${burst}`);
    assert.deepEqual(player.queue, last.slice(1, 12).map((t) => t.uri), `rajada de ${burst}: fila misturada`);
  }
});

test('C2 rodada superada devolve false e não sobrescreve o estado da nova', async () => {
  const { bridge } = slowPlayer();
  const engine = await playback(bridge);
  const a = [track('a0'), track('a1')];
  const b = [track('b0'), track('b1')];

  const [first, second] = await Promise.all([engine.startPlayback(a), engine.startPlayback(b)]);
  assert.equal(first, false);
  assert.equal(second, true);
  assert.deepEqual(engine.getBuffer().map((t) => t.uri), ['spotify:track:b1']);
});

test('C2 a primeira faixa nunca aparece duplicada na fila', async () => {
  const { player, bridge } = slowPlayer();
  const engine = await playback(bridge);
  const radio = Array.from({ length: 20 }, (_, i) => track(`d${i}`));
  await engine.startPlayback(radio);

  assert.equal(new Set(player.queue).size, player.queue.length);
  assert.equal(player.queue.includes(radio[0].uri), false);
  assert.equal(player.queue.length, 15);
});

test('C2 falha ao montar a fila com a faixa já tocando não vira "erro ao carregar candidatos"', async () => {
  const { player, bridge } = slowPlayer();
  bridge.setQueue = async () => { throw new Error('Spotify mudando de faixa'); };
  const engine = await playback(bridge);

  assert.equal(await engine.startPlayback([track('q0'), track('q1')]), true);
  assert.equal(player.current, 'spotify:track:q0');
  assert.ok(player.notes.some((note) => /fila/i.test(note)), player.notes.join('|'));
});

test('C2 falha de setQueue tenta addToQueue antes de desistir', async () => {
  const { player, bridge } = slowPlayer();
  bridge.setQueue = async () => { throw new Error('clearQueue indisponível'); };
  const engine = await playback(bridge);

  await engine.startPlayback([track('w0'), track('w1'), track('w2')]);
  assert.deepEqual(player.queue, ['spotify:track:w1', 'spotify:track:w2']);
});

test('C2 player que nunca responde rejeita dentro do prazo e libera a rádio seguinte', async () => {
  const { player, bridge } = slowPlayer();
  const original = bridge.playTrack;
  let stall = true;
  bridge.playTrack = (uri: string) => {
    if (stall) {
      stall = false;
      return forever<void>();
    }
    return original(uri);
  };
  const engine = await playback(bridge, { timeoutMs: 20 });

  await assert.rejects(within(500, engine.startPlayback([track('h0')])), /^Error: Player: sem resposta|Player: sem resposta/);
  assert.equal(await within(500, engine.startPlayback([track('h1')])), true);
  assert.equal(player.current, 'spotify:track:h1');
});

function harvestBridge(overrides: Partial<ConstructorParameters<typeof CandidateHarvester>[1]> = {}) {
  return {
    fetchLibraryPage: async (offset: number) => (offset === 0 ? [track('lib1'), track('lib2')] : []),
    listPlaylists: async () => ['spotify:playlist:p1', 'spotify:playlist:p2'],
    fetchPlaylistTracks: async (uri: string) => [track(`in_${uri.split(':')[2]}`)],
    ...overrides
  };
}

test('C3 biblioteca travada: a coleta segue com as playlists dentro do orçamento', async () => {
  const storage = new MemoryStorage();
  const harvester = new CandidateHarvester(storage, harvestBridge({ fetchLibraryPage: () => forever() }), Date.now, { timeoutMs: 15, budgetMs: 100 });
  const result = await within(500, harvester.harvest());
  assert.deepEqual(result.tracks.map((t) => t.uri).sort(), ['spotify:track:in_p1', 'spotify:track:in_p2']);
});

test('C3 lista de playlists travada: a coleta segue com a biblioteca', async () => {
  const storage = new MemoryStorage();
  const harvester = new CandidateHarvester(storage, harvestBridge({ listPlaylists: () => forever() }), Date.now, { timeoutMs: 15, budgetMs: 100 });
  assert.equal((await within(500, harvester.harvest())).tracks.length, 2);
});

test('C3 parte das playlists travada ou com erro: as demais entram e o orçamento é respeitado', async () => {
  const storage = new MemoryStorage();
  const uris = Array.from({ length: 40 }, (_, i) => `spotify:playlist:x${i}`);
  const harvester = new CandidateHarvester(storage, harvestBridge({
    listPlaylists: async () => uris,
    fetchPlaylistTracks: async (uri: string) => {
      const n = Number(uri.split('x')[1]);
      if (n % 3 === 0) return forever();
      if (n % 3 === 1) throw new Error('403');
      return [track(`pl${n}`)];
    }
  }), Date.now, { timeoutMs: 15, budgetMs: 60 });

  const started = performance.now();
  const result = await within(1000, harvester.harvest());
  assert.ok(performance.now() - started < 300, 'o orçamento limita a soma dos lotes');
  assert.ok(result.sources.playlists > 0);
});

test('C3 coleta parcial não fica em cache por 10 minutos', async () => {
  const storage = new MemoryStorage();
  let stalled = true;
  const bridge = harvestBridge({
    fetchPlaylistTracks: async (uri: string) => {
      if (stalled && uri.endsWith('p2')) return forever();
      return [track(`in_${uri.split(':')[2]}`)];
    }
  });
  let clock = NOW;
  const harvester = new CandidateHarvester(storage, bridge, () => clock, { timeoutMs: 15, budgetMs: 100 });

  assert.equal((await within(500, harvester.harvest())).tracks.length, 3);
  stalled = false;
  clock += 5_000;
  assert.equal((await within(500, harvester.harvest())).tracks.length, 4);
});

test('C3 tudo fora do ar: a coleta termina vazia, sem exceção', async () => {
  const storage = new MemoryStorage();
  const harvester = new CandidateHarvester(storage, harvestBridge({
    fetchLibraryPage: async () => { throw new Error('offline'); },
    listPlaylists: async () => { throw new Error('offline'); }
  }));
  assert.deepEqual((await within(200, harvester.harvest())).tracks, []);
});

test('C3 getRecommendedTracks: travada, com erro, lixo e correta juntas devolvem só a correta', async () => {
  const calls = new Map<string, () => Promise<unknown>>([
    ['spotify:playlist:slow', () => forever()],
    ['spotify:playlist:boom', async () => { throw new Error('500'); }],
    ['spotify:playlist:junk', async () => ({ error: 'não é lista' })],
    ['spotify:playlist:good', async () => [
      { uri: 'spotify:track:rec1', name: 'Rec', artists: [{ name: 'A', uri: 'spotify:artist:a' }], bpm: 128, trackKey: '8A' },
      { uri: 'spotify:track:bad', name: 'Rated', artists: [{ name: 'B', uri: 'spotify:artist:b' }] },
      null,
      {}
    ]]
  ]);
  const ingested: string[] = [];

  const tracks = await within(500, fetchNativeRecommendations({
    recommend: (uri) => calls.get(uri)!(),
    playlistUris: Array.from(calls.keys()),
    rotation: 0,
    parseTrack: (raw) => {
      const item = raw as { uri?: string; name?: string; artists?: TrackMetadata['artists'] } | null;
      return item?.uri ? { uri: item.uri, name: item.name ?? '', artists: item.artists ?? [], album: { name: '', uri: '' } } : null;
    },
    isExcluded: (t) => t.uri === 'spotify:track:bad',
    onDecorated: (uri) => { ingested.push(uri); },
    timeoutMs: 20
  }));

  assert.deepEqual(tracks.map((t) => t.uri), ['spotify:track:rec1']);
  assert.deepEqual(ingested, ['spotify:track:rec1']);
});

test('C3 GraphQL lento: timedRequest rejeita no prazo e a ponte devolve o que resolveu', async () => {
  const slow = timedRequest(() => forever(), 15);
  await assert.rejects(within(300, slow('getTrackName', {})), /getTrackName: sem resposta/);

  const bridge = createTopTracksDiscoveryBridge(timedRequest(async (operation, variables) => {
    if (operation === 'getAlbumNameAndTracks') return { items: [{ uri: 'spotify:track:ok' }, { uri: 'spotify:track:stall' }] };
    if (variables.uri === 'spotify:track:stall' || variables.trackUri === 'spotify:track:stall') return forever();
    if (operation === 'getTrackName') return { data: { trackUnion: { name: 'Ok' } } };
    return { artists: [{ uri: 'spotify:artist:a', profile: { name: 'A' } }] };
  }, 15));

  const found = await within(300, bridge.fetchAlbumDeepCuts!('spotify:album:x', new Set()));
  assert.deepEqual(found.map((c) => c.track.uri), ['spotify:track:ok']);
});

test('C3 crawler com todas as chamadas travadas respeita o orçamento e devolve o parcial', async () => {
  const { storage, engine } = await engineWith();
  const blacklist = new BlacklistManager(storage);
  let served = 0;
  const crawler = new AutonomousDiscoveryCrawler({
    fetchArtistAlbums: async () => [],
    fetchAlbumTracks: async () => [],
    async fetchAlbumDeepCuts() {
      if (served++ === 0) return [{ track: track('deep1'), popularity: 10 }];
      return forever();
    },
    fetchArtistTracks: () => forever()
  }, blacklist, engine);

  const albums = Array.from({ length: 10 }, (_, i) => `spotify:album:a${i}`);
  const artists = Array.from({ length: 8 }, (_, i) => `spotify:artist:b${i}`);
  const started = performance.now();
  const found = await within(1000, crawler.crawl(artists, new Set(), 30, albums, { budgetMs: 60 }));

  assert.ok(performance.now() - started < 300);
  assert.deepEqual(found.map((r) => r.track.uri), ['spotify:track:deep1']);
});

test('C3 análise que trava entra em espera e não segura a rádio', async () => {
  const storage = new MemoryStorage();
  let clock = NOW;
  const features = new AudioFeatureProvider(storage, {
    fetchBatch: async () => [],
    fetchAnalysis: () => forever()
  }, () => clock, { timeoutMs: 15 });

  await within(300, features.ensureAnalyzed(['spotify:track:a', 'spotify:track:b', 'spotify:track:c']));
  assert.equal(features.canAnalyze(), false, 'depois da primeira espera as outras não tentam');
  assert.match(features.getDiagnostics().lastError ?? '', /sem resposta/);
  clock += 61_000;
  assert.equal(features.canAnalyze(), true);
});

test('C3 audio-features travado não segura a rádio', async () => {
  const storage = new MemoryStorage();
  const features = new AudioFeatureProvider(storage, { fetchBatch: () => forever() }, () => NOW, { timeoutMs: 15 });
  await within(300, features.ensure(['spotify:track:a']));
  assert.equal(features.getDiagnostics().status, 'backing-off');
});

test('C3 HTTP 429 em audio-features recua sem desligar, e a análise segue preenchendo', async () => {
  const storage = new MemoryStorage();
  let clock = NOW;
  let batches = 0;
  const features = new AudioFeatureProvider(storage, {
    fetchBatch: async () => {
      batches++;
      throw { status: 429 };
    },
    fetchAnalysis: async () => ({ energy: 0.5, mode: 1, key: 3, source: 'Local' })
  }, () => clock);

  await features.ensure(['spotify:track:a']);
  await features.ensure(['spotify:track:a']);
  assert.equal(batches, 1, 'dentro da espera não insiste');
  assert.equal(features.getDiagnostics().status, 'backing-off');
  assert.equal(await features.ensureAnalyzed(['spotify:track:a']), 1);

  clock += 61_000;
  await features.ensure(['spotify:track:b']);
  assert.equal(batches, 2);
});

test('C3 LibraryAPI.contains travada falha aberta no prazo e não trava a rádio', async () => {
  const { storage, blacklist } = await shieldWorld();
  const shield = buildUnheardShield({
    ratings: [], blockedArtistCount: 0, harvest: { tracks: [] }, blacklist,
    libraryContains: () => forever(), containsTimeoutMs: 15
  });
  void storage;
  const kept = await within(300, shield.filterUnheard([track('a'), track('b')]));
  assert.equal(kept.length, 2);
});

test('C3 contains em lotes: 1000 faixas sem estourar argumentos, curtidas filtradas em qualquer lote', async () => {
  const { blacklist } = await shieldWorld();
  const liked = new Set(['spotify:track:n7', 'spotify:track:n512', 'spotify:track:n999']);
  const sizes: number[] = [];
  const shield = buildUnheardShield({
    ratings: [], blockedArtistCount: 0, harvest: { tracks: [] }, blacklist,
    libraryContains: async (uris) => {
      sizes.push(uris.length);
      if (uris.length > 100) throw new Error('muitos argumentos');
      return uris.map((uri) => liked.has(uri));
    }
  });

  const kept = await within(1000, shield.filterUnheard(Array.from({ length: 1000 }, (_, i) => track(`n${i}`))));
  assert.equal(kept.length, 997);
  assert.ok(Math.max(...sizes) <= 100);
});

test('C3 um lote de contains que falha não libera curtidas dos outros lotes', async () => {
  const { blacklist } = await shieldWorld();
  const shield = buildUnheardShield({
    ratings: [], blockedArtistCount: 0, harvest: { tracks: [] }, blacklist,
    libraryContains: async (uris) => {
      if (uris.includes('spotify:track:n0')) throw new Error('falhou');
      return uris.map((uri) => uri === 'spotify:track:n150');
    }
  });

  const kept = await shield.filterUnheard(Array.from({ length: 200 }, (_, i) => track(`n${i}`)));
  assert.equal(kept.some((t) => t.uri === 'spotify:track:n150'), false);
  assert.equal(kept.length, 99, 'com 99 confirmadas, as 100 sem confirmação ficam de fora');
  assert.equal(kept.some((t) => t.uri === 'spotify:track:n0'), false);
});

test('C3 falha na reinspeção do guardião não vira rejeição sem tratamento', async () => {
  const { storage, blacklist } = await shieldWorld();
  const t = track('rr');
  await storage.saveRating(rated(t, 0));
  const state = { current: t, queued: [], nextUp: [] };
  const { bridge } = queueBridge(state);
  const guardian = new PredictiveQueueGuardian(blacklist, bridge, { skipSettleMs: 5 });
  const original = bridge.getQueueState;
  let calls = 0;
  bridge.getQueueState = () => {
    if (++calls > 1) throw new Error('fila indisponível');
    return original();
  };

  const rejections: unknown[] = [];
  const listener = (reason: unknown) => rejections.push(reason);
  process.on('unhandledRejection', listener);
  await Promise.all([guardian.inspectAndCleanQueue(true), guardian.inspectAndCleanQueue(true)]);
  await later(20);
  process.off('unhandledRejection', listener);

  assert.deepEqual(rejections, []);
});

test('A3 poucos artistas: a fila cresce relaxando o espaçamento só quando nenhum outro artista cabe', async () => {
  const random = seededRandom(33);
  const { engine } = await engineWith();
  const pool = Array.from({ length: 60 }, (_, i) => track(`few${i}`, `T${i}`, `Duo ${i % 2}`, randomFeatures(random)));
  const predictions = pool.map((t) => engine.evaluateCandidate(t));

  const { tracks } = new EigenResonanceRanker(engine, seededRandom(4)).compose(predictions, { length: 30 });
  assert.equal(tracks.length, 30);
  for (let i = 1; i < tracks.length; i++) {
    assert.notEqual(tracks[i].artists[0].uri, tracks[i - 1].artists[0].uri, 'com dois artistas ainda dá para alternar');
  }
});

test('A3 artistas suficientes: o espaçamento de 4 posições continua rígido', async () => {
  const random = seededRandom(34);
  const { engine } = await engineWith();
  const pool = Array.from({ length: 80 }, (_, i) => track(`many${i}`, `T${i}`, `Band ${i % 8}`, randomFeatures(random)));
  const predictions = pool.map((t) => engine.evaluateCandidate(t));

  const { tracks } = new EigenResonanceRanker(engine, seededRandom(5)).compose(predictions, { length: 30 });
  assert.equal(tracks.length, 30);
  for (let i = 0; i < tracks.length; i++) {
    const nearby = tracks.slice(Math.max(0, i - 3), i).map((t) => t.artists[0].uri);
    assert.equal(nearby.includes(tracks[i].artists[0].uri), false, `posição ${i}`);
  }
});

test('A2 artistas sem URI não dividem a mesma afinidade', async () => {
  const anonymous = (id: string): TrackMetadata => ({ ...track(id), artists: [{ name: 'Desconhecido', uri: '' }] });
  const { storage, engine } = await engineWith();
  await engine.updateWithRating(rated(anonymous('dis1'), 0), null);
  await storage.saveRating(rated(anonymous('dis1'), 0));

  assert.equal(engine.getProfile().artistAffinities[''], undefined);
  const reasons = engine.evaluateCandidate(anonymous('other')).breakdown ?? [];
  assert.equal(reasons.some((c) => c.key === 'artist'), false);
});

test('A4 fuzz da análise: ritmo e morfologia só devolvem números finitos', () => {
  for (let seed = 1; seed <= 200; seed++) {
    const random = seededRandom(seed * 13);
    const pick = () => (random() < 0.25 ? HOSTILE_NUMBERS[Math.floor(random() * HOSTILE_NUMBERS.length)] : random() * 2);
    const payload = {
      track: { tempo: 120, duration: 200 },
      beats: Array.from({ length: 40 }, (_, i) => ({ start: i * 0.5, duration: pick(), confidence: 0.5 })),
      segments: Array.from({ length: 40 }, (_, i) => ({ start: i * 0.5, duration: pick(), loudness_max: -pick() * 20, pitches: new Array(12).fill(0.5), timbre: new Array(12).fill(1) }))
    };

    const rhythm = rhythmProfile(payload);
    if (rhythm) {
      assert.ok([rhythm.bpm, rhythm.regularity, rhythm.syncopation, rhythm.tempoStability, ...rhythm.pattern].every(Number.isFinite), `semente ${seed}`);
    }
    const morphology = extractMorphology(payload);
    if (morphology) assert.ok(morphology.timeline.length <= 17_281, `semente ${seed}`);
  }
});

test('B2 título que é só etiqueta ou símbolo mantém identidade própria', () => {
  const key = (name: string) => normalizeSongKey({ name, artists: [{ name: 'Yuri' }] });
  assert.notEqual(key('(Live)'), null);
  assert.notEqual(key('Live'), null);
  assert.notEqual(key('...'), null);
  assert.notEqual(key('...'), key('!!!'));
});

test('B1 regra de versão sem nome de faixa não bloqueia o catálogo inteiro do artista', async () => {
  const { storage, blacklist } = await shieldWorld();
  await blacklist.addVersionRule({
    trackName: '', artistName: 'Hugo', blockAllVersions: true, blockLiveVersionsOnly: false, blockRemixesOnly: false, timestamp: NOW
  } as never);
  assert.equal(shieldOf(storage, blacklist).isExcluded(track('v9', 'Qualquer', 'Hugo')), false);
});

test('P1 contains fora do ar sem alternativa: sem faixa confirmada, a rádio ainda sai', async () => {
  const { blacklist } = await shieldWorld();
  const shield = buildUnheardShield({
    ratings: [], blockedArtistCount: 0, harvest: { tracks: [] }, blacklist,
    libraryContains: async () => { throw new Error('offline'); }
  });
  assert.equal((await shield.filterUnheard(Array.from({ length: 8 }, (_, i) => track(`z${i}`)))).length, 8);
});

test('P1 um travamento de contains desarma o disjuntor e o próximo escudo não espera de novo', async () => {
  const { blacklist } = await shieldWorld();
  const breaker = { retryAt: 0 };
  let calls = 0;
  const build = () => buildUnheardShield({
    ratings: [], blockedArtistCount: 0, harvest: { tracks: [] }, blacklist, containsBreaker: breaker, containsTimeoutMs: 15,
    libraryContains: () => { calls++; return forever(); }
  });

  await within(300, build().filterUnheard([track('a')]));
  await within(300, build().filterUnheard([track('b')]));
  assert.equal(calls, 1, 'o segundo escudo nem chama contains, então não espera');
});

test('P2 estratégia desconhecida é recusada antes de gravar qualquer nota', async () => {
  const t = track('st');
  const { storage, portability } = await portabilityWorld();
  await assert.rejects(portability.importJson(importPayload([rated(t, 4)]), { strategy: 'sobrescrever' as never }), /desconhecida/);
  assert.equal(await storage.getRating(t.uri), null);
});

test('P2 replace, keepLocal e merge têm o efeito do nome', async () => {
  const t = track('st2');
  for (const [strategy, expected] of [['replace', 1], ['keepLocal', 3], ['merge', 3]] as const) {
    const { storage, portability } = await portabilityWorld();
    await storage.saveRating(rated(t, 3, NOW));
    await portability.importJson(importPayload([rated(t, 1, NOW + 1)]), { strategy });
    assert.equal((await storage.getRating(t.uri))?.rating, expected, strategy);
  }
});

test('P2 limpar o histórico impede desfazer por cima de uma importação', async () => {
  const { storage } = await shieldWorld();
  const manager = new RatingManager(storage);
  const t = track('undoimp');
  await manager.rateTrack(t, 2);
  await storage.saveRating(rated(t, 5, NOW));
  manager.clearHistory();
  assert.equal(await manager.undo(), false);
  assert.equal((await storage.getRating(t.uri))?.rating, 5);
});

test('P3 guardião aplica regra de versão na fila automática e na faixa atual', async () => {
  const { blacklist } = await shieldWorld();
  await blacklist.addVersionRule({ trackName: 'Hino', artistName: 'Hugo', blockAllVersions: true, blockLiveVersionsOnly: false, blockRemixesOnly: false, timestamp: NOW } as never);
  const rule = track('rv1', 'Hino - Ao Vivo', 'Hugo');
  const { bridge, log } = queueBridge({ current: track('ok'), queued: [], nextUp: [rule] });
  await new PredictiveQueueGuardian(blacklist, bridge, { skipSettleMs: 0 }).inspectAndCleanQueue(true);
  assert.deepEqual(log.removed, [rule.uri]);

  const current = queueBridge({ current: rule, queued: [], nextUp: [] });
  await new PredictiveQueueGuardian(blacklist, current.bridge, { skipSettleMs: 0, restoreDelayMs: 0 }).inspectAndCleanQueue(true);
  assert.equal(current.log.skips, 1);
});

test('P4 pesos salvos na escala antiga são reconstruídos uma vez ao iniciar', async () => {
  const storage = new MemoryStorage();
  await storage.init();
  const t = track('old1', 'Old', 'Lia', { energy: 0.9 });
  await storage.saveRating(rated(t, 1));
  await storage.saveProfile({
    id: 'default', name: 'Padrão', explorationFactor: 0.2, antiFatigue: { minArtistDistance: 3, recentPenaltyWindow: 5 },
    attributeWeights: { 'energy:high': { weight: -0.7 / 5, count: 1, confidence: 0.3, variance: 1 } },
    artistAffinities: {}
  } as never);

  const engine = new PreferenceEngine(storage, () => NOW);
  await engine.init();

  assert.ok(Math.abs(engine.getProfile().attributeWeights['energy:high'].weight + 0.6 / 5) < 1e-12);
  assert.equal((await storage.getProfile('default'))?.signalScale, 2);
});

test('P4 sinal da nota igual em pesos e modelo: 1★ remove exatamente o que somou', async () => {
  const { storage, engine } = await engineWith();
  const manager = new RatingManager(storage);
  manager.onRatingChange((record, previous) => { void engine.updateWithRating(record, previous); });
  const t = track('sig', 'Sig', 'Mel', { energy: 0.9 });
  await manager.rateTrack(t, 1);
  await later(0);
  assert.ok(Math.abs(engine.getProfile().attributeWeights['energy:high'].weight + 0.6 / 5) < 1e-12);
});

test('P5 prepareSequence com fadiga total ainda devolve as faixas elegíveis', async () => {
  const { storage, engine } = await engineWith();
  const { bridge } = slowPlayer(0);
  const playbackEngine = new SmartPlaybackEngine(new BlacklistManager(storage), engine, bridge);
  const pool = [track('w1', 'W1', 'Wes'), track('w2', 'W2', 'Wes2')];
  const { eligibleTracks } = playbackEngine.prepareSequence(pool, 101);
  assert.equal(eligibleTracks.length, 2);
});

test('P6 nota sem metadados ganha nome e artistas sem perder nota nem dados acústicos', async () => {
  const features = { energy: 0.4 };
  const t: TrackMetadata = { uri: 'spotify:track:ph3', name: 'Faixa', artists: [], album: { name: '', uri: '' }, acousticFeatures: features };
  const { storage, blacklist, portability } = await portabilityWorld(async () => new Map([[t.uri, track('ph3', 'Hino - Remastered', 'Nina')]]));
  await storage.saveRating(rated(t, 0));

  assert.equal(await portability.enrichPlaceholders(), 1);

  const after = await storage.getRating(t.uri);
  assert.equal(after?.rating, 0);
  assert.equal(after?.metadata.acousticFeatures?.energy, 0.4);
  assert.equal(shieldOf(storage, blacklist, [], await storage.getAllRatings()).isExcluded(track('other', 'Hino', 'Nina')), true);
});

test('P6 resolveTrackMetadata usa GraphQL e ignora o que não resolve', async () => {
  const found = await resolveTrackMetadata(async (operation, variables) => {
    if (variables.uri === 'spotify:track:bad' || variables.trackUri === 'spotify:track:bad') throw new Error('404');
    if (operation === 'getTrackName') return { data: { trackUnion: { name: 'Real' } } };
    return { artists: [{ uri: 'spotify:artist:r', profile: { name: 'R' } }] };
  }, ['spotify:track:ok', 'spotify:track:bad']);
  assert.deepEqual(Array.from(found.keys()), ['spotify:track:ok']);
  assert.equal(found.get('spotify:track:ok')?.artists[0].name, 'R');
});
