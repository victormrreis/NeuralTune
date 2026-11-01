import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AudioAnalysisPayload,
  AnalysisSegment,
  SYNTHESIZED_SOURCE,
  synthesizeFeatures
} from '../src/core/AudioAnalysisSynthesizer.ts';
import { KRUMHANSL_MAJOR, KRUMHANSL_MINOR } from '../src/dsp/LocalAudioDSPEngine.ts';
import {
  NOSTALGIA_MAX_POINTS,
  NOSTALGIA_MIN_POINTS,
  baseLevelActivation,
  decayRate,
  halfLifeDays,
  nostalgiaBonus,
  satiationExposure
} from '../src/core/CognitiveMemoryModel.ts';
import { PreferenceEngine } from '../src/core/PreferenceEngine.ts';
import { MusicGraphEngine } from '../src/core/MusicGraphEngine.ts';
import { RatingManager } from '../src/core/RatingManager.ts';
import { BlacklistManager } from '../src/core/BlacklistManager.ts';
import { MemoryStorage } from '../src/storage/MemoryStorage.ts';
import {
  CSV_COLUMNS,
  DataPortabilityManager,
  JSON_EXPORT_FILENAME,
  JSPF_EXPORT_FILENAME
} from '../src/storage/DataPortabilityManager.ts';
import { localScaling, mutualProximity, solveTrajectory, softTransitionCost, tempoDrift, TrajectoryTrack } from '../src/queue/HarmonicTrajectorySolver.ts';
import { CandidateHarvester, HarvestBridge } from '../src/radios/CandidateHarvester.ts';
import { parseRadioPrompt } from '../src/radios/NaturalLanguageRadioParser.ts';
import { RadioEngine } from '../src/radios/RadioEngine.ts';
import { isCamelotCompatible, parseCamelot } from '../src/math/Camelot.ts';
import { AcousticFeatures, PlayEvent, Rating, TrackMetadata } from '../src/types/index.ts';

const DAY = 86_400_000;

function analysisFixture(overrides: {
  bpm?: number; jitter?: number; beatConfidence?: number; loudness?: number; mode?: number; key?: number;
  brightness?: number; flatness?: number; attack?: number; timbreSpread?: number; segmentSeconds?: number;
  loudTail?: number; segments?: number;
} = {}): AudioAnalysisPayload {
  const {
    bpm = 128, jitter = 0, beatConfidence = 0.9, loudness = -6, mode = 0, key = 9,
    brightness = 40, flatness = 20, attack = 40, timbreSpread = 30, segmentSeconds = 0.25,
    loudTail = 20, segments: count = 800
  } = overrides;

  const profile = mode === 1 ? KRUMHANSL_MAJOR : KRUMHANSL_MINOR;
  const pitches = profile.map((_, i) => profile[(i - key + 12) % 12] / 6.4);
  const beat = 60 / bpm;

  const segments: AnalysisSegment[] = Array.from({ length: count }, (_, i) => {
    const wobble = Math.sin(i * 1.7);
    return {
      start: i * segmentSeconds,
      duration: segmentSeconds,
      confidence: 0.7,
      loudness_start: -25,
      loudness_max: i % 10 === 0 ? -25 + loudTail / 10 : -8,
      pitches,
      timbre: [
        45 + wobble * 6, brightness + wobble * timbreSpread, flatness + wobble * timbreSpread, attack,
        wobble * timbreSpread, wobble * 10, 0, 0, 0, 0, 0, 0
      ]
    };
  });

  return {
    track: {
      duration: count * segmentSeconds, tempo: bpm, tempo_confidence: 0.8, key, key_confidence: 0.75,
      mode, loudness, time_signature: 4
    },
    beats: Array.from({ length: 200 }, (_, i) => ({
      start: i * beat,
      duration: beat * (1 + (i % 2 ? jitter : -jitter)),
      confidence: beatConfidence
    })),
    tatums: Array.from({ length: 400 }, (_, i) => ({ start: (i * beat) / 2, duration: beat / 2, confidence: beatConfidence })),
    segments
  };
}

const EIGHT: Array<keyof AcousticFeatures> = [
  'energy', 'valence', 'danceability', 'acousticness', 'instrumentalness', 'speechiness', 'liveness'
];

test('Synthesizer: an analysis tree rebuilds all 8 dimensions in [0, 1], plus key and mode', () => {
  const features = synthesizeFeatures(analysisFixture())!;

  assert.ok(Math.abs(features.bpm! - 128) < 0.5);
  for (const dimension of EIGHT) {
    const value = features[dimension] as number;
    assert.ok(typeof value === 'number' && value >= 0 && value <= 1, `${dimension}: ${value}`);
  }
  assert.equal(features.key, 9);
  assert.equal(features.mode, 0);
  assert.equal(features.camelot, '8A');
  assert.equal(features.keyConfidence, 0.75);
  assert.equal(features.source, 'Spotify Audio Analysis (Synthesized)');
  assert.equal(features.source, SYNTHESIZED_SOURCE);
  assert.equal(features.timbre?.length, 12);
  assert.equal(features.timbreVariance?.length, 12);
  assert.equal(features.chroma?.length, 12);
});

test('Synthesizer: each dimension moves in the direction of its physics', () => {
  const at = (o: Parameters<typeof analysisFixture>[0]) => synthesizeFeatures(analysisFixture(o))!;

  assert.ok(at({ loudness: -4 }).energy! > at({ loudness: -28 }).energy!);
  assert.ok(at({ jitter: 0 }).danceability! > at({ jitter: 0.1 }).danceability! + 0.2);
  assert.ok(at({ beatConfidence: 0.95 }).danceability! > at({ beatConfidence: 0.2 }).danceability!);
  assert.ok(at({ brightness: -60, flatness: -40, attack: -20 }).acousticness! > at({ brightness: 90, flatness: 60, attack: 100 }).acousticness! + 0.3);
  assert.ok(at({ timbreSpread: 5 }).instrumentalness! > at({ timbreSpread: 70 }).instrumentalness! + 0.3);
  assert.ok(at({ mode: 1, key: 0, brightness: 90 }).valence! > at({ mode: 0, brightness: -90 }).valence! + 0.3);
  assert.ok(at({ segmentSeconds: 0.1 }).speechiness! > at({ segmentSeconds: 0.4 }).speechiness!);
  assert.ok(at({ loudTail: 2 }).liveness! > at({ loudTail: 40 }).liveness!);
});

test('Synthesizer: falls back to the chroma when the header declares no key', () => {
  const payload = analysisFixture({ key: 2, mode: 1 });
  payload.track!.key = -1;

  const features = synthesizeFeatures(payload)!;
  assert.equal(features.key, 2);
  assert.equal(features.mode, 1);
  assert.equal(features.camelot, '10B');
});

test('Synthesizer: survives a header-only payload, and an empty one is no data', () => {
  const headerOnly = synthesizeFeatures({ track: { tempo: 90, key: 9, mode: 0, loudness: -10 } })!;
  assert.equal(headerOnly.bpm, 90);
  assert.equal(headerOnly.camelot, '8A');
  assert.equal(headerOnly.valence, undefined);

  assert.equal(synthesizeFeatures({}), null);
  assert.equal(synthesizeFeatures({ segments: [{ duration: 1 }] }), null);
});

test('Synthesizer: 800 segments in under 5 ms', () => {
  const payload = analysisFixture({ segments: 800 });
  for (let i = 0; i < 50; i++) synthesizeFeatures(payload); // Warm the JIT, as a long session would

  let elapsed = Number.POSITIVE_INFINITY;
  for (let attempt = 0; attempt < 5; attempt++) {
    const started = performance.now();
    synthesizeFeatures(payload);
    elapsed = Math.min(elapsed, performance.now() - started);
  }

  assert.ok(elapsed < 5, `${elapsed} ms`);
});

const METAL: AcousticFeatures = {
  bpm: 170, energy: 0.97, valence: 0.3, danceability: 0.4,
  acousticness: 0.02, instrumentalness: 0.2, speechiness: 0.1, liveness: 0.2
};
const AMBIENT: AcousticFeatures = {
  bpm: 66, energy: 0.08, valence: 0.3, danceability: 0.2,
  acousticness: 0.95, instrumentalness: 0.92, speechiness: 0.04, liveness: 0.1
};
const POP: AcousticFeatures = {
  bpm: 118, energy: 0.52, valence: 0.3, danceability: 0.3,
  acousticness: 0.48, instrumentalness: 0.55, speechiness: 0.07, liveness: 0.15
};

function vary(features: AcousticFeatures, i: number): AcousticFeatures {
  return { ...features, energy: features.energy! - (i % 5) / 100, acousticness: features.acousticness! + (i % 4) / 100 };
}

function track(id: string, features?: AcousticFeatures, artist: string = id, album?: string): TrackMetadata {
  return {
    uri: `spotify:track:${id}`,
    name: id,
    artists: [{ name: artist, uri: `spotify:artist:${artist}` }],
    album: { name: album ?? '', uri: album ? `spotify:album:${album}` : '' },
    acousticFeatures: features
  };
}

function setup(start: number = 1_700_000_000_000) {
  const clock = { now: start };
  const storage = new MemoryStorage();
  const engine = new PreferenceEngine(storage, () => clock.now);
  const rate = async (t: TrackMetadata, rating: Rating) => {
    clock.now += 1000;
    const record = { uri: t.uri, rating, timestamp: clock.now, metadata: t };
    await storage.saveRating(record);
    await engine.updateWithRating(record, null);
  };
  return { clock, storage, engine, rate };
}

test('Multimodal: 5★ on two opposite styles makes 2 clusters and scores both on top, not the middle', async () => {
  const { engine, rate } = setup();
  await engine.init();

  for (let i = 0; i < 8; i++) {
    await rate(track(`metal${i}`, vary(METAL, i)), 5);
    await rate(track(`ambient${i}`, vary(AMBIENT, i)), 5);
  }

  const { clusters } = engine.getModelSnapshot();
  assert.equal(clusters.length, 2);
  assert.ok(clusters.every((c) => c.share > 0.4));
  assert.ok(Math.abs(clusters[0].centroid[1] - clusters[1].centroid[1]) > 2);
  assert.notEqual(clusters[0].description, clusters[1].description);

  const score = (id: string, f: AcousticFeatures) =>
    engine.evaluateCandidate(track(id, f)).breakdown!.find((c) => c.key === 'acoustic')!.points;

  const metal = score('m', METAL);
  const ambient = score('a', AMBIENT);
  const middle = score('p', POP);

  assert.ok(metal > 12, `metal ${metal}`);
  assert.ok(ambient > 12, `ambient ${ambient}`);
  assert.ok(middle < Math.min(metal, ambient) - 8, `middle ${middle}`);
});

test('Multimodal: userVector stays the global mean for the existing interface', async () => {
  const { engine, rate } = setup();
  await engine.init();
  await rate(track('a', METAL), 5);
  await rate(track('b', AMBIENT), 5);

  const { vector } = engine.getModelSnapshot();
  assert.equal(vector.length, 8);
  assert.equal(engine.getProfile().userVector?.length, 8);
});

test('Multimodal: similar tracks share one cluster, and K never passes 6', async () => {
  const single = setup();
  await single.engine.init();
  for (let i = 0; i < 10; i++) await single.rate(track(`m${i}`, vary(METAL, i)), 5);
  assert.equal(single.engine.getModelSnapshot().clusters.length, 1);

  const many = setup();
  await many.engine.init();
  const styles: AcousticFeatures[] = Array.from({ length: 12 }, (_, i) => ({
    bpm: 60 + i * 12,
    energy: (i * 7 % 12) / 11,
    valence: (i * 5 % 12) / 11,
    danceability: (i * 11 % 12) / 11,
    acousticness: 1 - (i * 7 % 12) / 11,
    instrumentalness: i % 2,
    speechiness: (i % 3) / 2,
    liveness: (i % 4) / 3
  }));
  for (let i = 0; i < styles.length; i++) await many.rate(track(`s${i}`, styles[i]), 5);

  const { clusters } = many.engine.getModelSnapshot();
  assert.ok(clusters.length > 2 && clusters.length <= 6, `K=${clusters.length}`);
  assert.ok(Math.abs(clusters.reduce((sum, c) => sum + c.share, 0) - 1) < 1e-9);
});

test('Multimodal: dislikes found no cluster, and undo restores the exact mixture', async () => {
  const storage = new MemoryStorage();
  const engine = new PreferenceEngine(storage);
  const manager = new RatingManager(storage);
  await engine.init();
  manager.onRatingChange((record, previous) => { engine.updateWithRating(record, previous); });

  await manager.rateTrack(track('a', METAL), 1);
  assert.equal(engine.getModelSnapshot().clusters.length, 0);

  await manager.rateTrack(track('b', METAL), 5);
  const expected = engine.getModelSnapshot();

  await manager.rateTrack(track('c', AMBIENT), 5);
  assert.equal(engine.getModelSnapshot().clusters.length, 2);

  await manager.undo();
  assert.deepEqual(engine.getModelSnapshot(), expected);
});

function play(id: string, startedAt: number, playedMs: number, skipped: boolean = false, artist: string = id): PlayEvent {
  return {
    id: `${id}@${startedAt}`, uri: `spotify:track:${id}`, name: id, artistUris: [`spotify:artist:${artist}`],
    startedAt, endedAt: startedAt + playedMs, playedMs, durationMs: 200_000, skipped
  };
}

test('Implicit: complete listens teach the bandit, repeated early skips repel, no rating needed', async () => {
  const features = new Map<string, AcousticFeatures>([
    ['spotify:track:loved', METAL], ['spotify:track:hated', AMBIENT]
  ]);
  const { engine, clock } = setup();
  engine.setFeatureLookup((uri) => features.get(uri));
  await engine.init();

  const banditOf = (f: AcousticFeatures) =>
    engine.evaluateCandidate(track(`probe${f.bpm}`, f)).breakdown!.find((c) => c.key === 'bandit')?.points ?? 0;
  const before = { metal: banditOf(METAL), ambient: banditOf(AMBIENT) };

  for (let i = 0; i < 8; i++) {
    clock.now += 3600_000;
    engine.recordPlay(play('loved', clock.now, 195_000));
    engine.recordPlay(play('hated', clock.now + 300_000, 8_000, true));
  }

  assert.equal(engine.getModelSnapshot().implicitSignals, 2);
  assert.ok(banditOf(METAL) > before.metal);
  assert.ok(banditOf(AMBIENT) < before.ambient);
});

test('Implicit: an explicit rating is sovereign over every implicit signal', async () => {
  const features = new Map([['spotify:track:a', METAL]]);
  const { engine, clock, rate } = setup();
  engine.setFeatureLookup((uri) => features.get(uri));
  await engine.init();

  await rate(track('a', METAL), 5);
  const expected = engine.evaluateCandidate(track('probe', METAL)).breakdown!.find((c) => c.key === 'bandit')?.points ?? 0;

  for (let i = 0; i < 6; i++) {
    clock.now += 3600_000;
    engine.recordPlay(play('a', clock.now, 8_000, true));
  }

  assert.equal(engine.getModelSnapshot().implicitSignals, 0);
  const after = engine.evaluateCandidate(track('probe', METAL)).breakdown!.find((c) => c.key === 'bandit')?.points ?? 0;
  assert.ok(Math.abs(after - expected) < 1e-9);
});

test('Bandit: cross-features learn a boundary no linear model can', async () => {
  const { engine, rate } = setup();
  await engine.init();

  // An XOR in energy × acousticness: the mean of each axis says nothing
  const corners: Array<[number, number, Rating]> = [[0.95, 0.9, 5], [0.05, 0.05, 5], [0.95, 0.05, 1], [0.05, 0.9, 1]];
  let index = 0;
  for (const [energy, acousticness, rating] of corners) {
    for (let i = 0; i < 25; i++) {
      await rate(track(`x${index++}`, { energy, acousticness, bpm: 120 + i / 10 }), rating);
    }
  }

  const predicted = (energy: number, acousticness: number) =>
    engine.evaluateCandidate(track(`p${energy}${acousticness}`, { energy, acousticness, bpm: 120 }))
      .breakdown!.find((c) => c.key === 'bandit')?.points ?? 0;

  assert.ok(predicted(0.95, 0.9) > 2);
  assert.ok(predicted(0.05, 0.05) > 2);
  assert.ok(predicted(0.95, 0.05) < -2);
  assert.ok(predicted(0.05, 0.9) < -2);
});

test('Graph: a rating reaches a featured artist through the shared track', () => {
  const graph = new MusicGraphEngine();
  graph.rebuild({
    tracks: [
      { uri: 'spotify:track:feat', signal: 1, artistUris: ['spotify:artist:a', 'spotify:artist:b'] },
      { uri: 'spotify:track:x', signal: 0, artistUris: ['spotify:artist:c'] }
    ]
  });

  assert.ok(graph.affinity('spotify:track:new', ['spotify:artist:b']) > 0.1);
  assert.equal(graph.affinity('spotify:track:new', ['spotify:artist:c']), 0);
  assert.equal(graph.affinity('spotify:track:new', ['spotify:artist:nobody']), 0);
});

test('Graph: session neighbors inherit, dislikes propagate negatively', () => {
  const graph = new MusicGraphEngine();
  graph.rebuild({
    tracks: [
      { uri: 'a', signal: 1, artistUris: [] },
      { uri: 'b', signal: -1, artistUris: [] }
    ],
    transitions: [['a', 'c'], ['b', 'd']]
  });

  assert.ok(graph.affinity('c') > 0);
  assert.ok(graph.affinity('d') < 0);
});

test('Graph: the degree penalty keeps a hub from outranking a specific neighbor', () => {
  const graph = new MusicGraphEngine();
  const hubTracks = Array.from({ length: 200 }, (_, i) => ({ uri: `h${i}`, signal: 0, artistUris: ['hub'] }));
  graph.rebuild({
    tracks: [
      { uri: 'liked', signal: 1, artistUris: ['hub', 'niche'] },
      ...hubTracks
    ]
  });

  assert.ok(graph.affinity('new', ['niche']) > graph.affinity('new', ['hub']));
});

test('Graph: oversized contexts relate nothing, and an empty graph is harmless', () => {
  const graph = new MusicGraphEngine();
  const giant = Array.from({ length: 600 }, (_, i) => `t${i}`);
  graph.rebuild({
    tracks: [{ uri: 't0', signal: 1, artistUris: [] }],
    contexts: new Map([['spotify:playlist:huge', giant]])
  });
  assert.equal(graph.affinity('t1'), 0);

  graph.rebuild({ tracks: [] });
  assert.equal(graph.affinity('anything', ['a']), 0);
});

test('Graph: genres come from the artist, then from neighbors', () => {
  const graph = new MusicGraphEngine();
  graph.setArtistGenres('a', ['Rock', ' Metal ']);
  assert.deepEqual(graph.inferGenres('t', ['a']), ['rock', 'metal']);

  graph.rebuild({
    tracks: [
      { uri: 'known', signal: 1, artistUris: ['a'] },
      { uri: 'orphan', signal: 0, artistUris: ['z'] }
    ],
    transitions: [['orphan', 'known']]
  });
  assert.deepEqual(graph.inferGenres('orphan', ['z']), ['rock', 'metal']);
  assert.deepEqual(graph.inferGenres('stranger'), []);
});

test('Graph: the engine feeds it, so a new track by a loved artist gains points without any audio', async () => {
  const { engine, rate } = setup();
  await engine.init();
  for (let i = 0; i < 4; i++) await rate(track(`t${i}`, undefined, 'band', `album${i}`), 5);

  const result = engine.evaluateCandidate(track('new', undefined, 'band'));
  assert.ok(result.breakdown!.some((c) => c.key === 'graph' && c.points > 0));
});

test('Memory: closed-form ACT-R activation and the slowed decay of liked tracks', () => {
  const now = 100 * DAY;
  const expected = Math.log(10 ** -0.5 + 40 ** -0.5);

  assert.ok(Math.abs(baseLevelActivation([now - 10 * DAY, now - 40 * DAY], now, 0) - expected) < 1e-9);
  assert.ok(decayRate(1) < decayRate(0.6));
  assert.ok(halfLifeDays(1) > halfLifeDays(0.6));
  assert.equal(baseLevelActivation([], now, 1), Number.NEGATIVE_INFINITY);
});

test('Memory: satiation ends at 48 h, and the bonus is confined to its window and range', () => {
  const now = 1000 * DAY;

  assert.ok(satiationExposure([now - 3_600_000], now) > 0.3);
  assert.equal(satiationExposure([now - 49 * 3_600_000], now), 0);

  assert.equal(nostalgiaBonus([now - 2 * DAY], now, 1), 0);
  assert.equal(nostalgiaBonus([now - 5 * DAY], now, 1), 0);
  assert.equal(nostalgiaBonus([now - 45 * DAY], now, 1), 0);
  assert.equal(nostalgiaBonus([now - 14 * DAY], now, 0.3), 0);

  for (const days of [7, 10, 14, 20, 30]) {
    const bonus = nostalgiaBonus([now - days * DAY], now, 1);
    assert.ok(bonus >= NOSTALGIA_MIN_POINTS && bonus <= NOSTALGIA_MAX_POINTS, `${days}d: ${bonus}`);
  }
});

test('Memory: a much-played favorite comes back later than a once-played one', () => {
  const now = 1000 * DAY;
  const heavy = Array.from({ length: 30 }, (_, i) => now - (14 + i / 10) * DAY);

  assert.ok(nostalgiaBonus([now - 14 * DAY], now, 1) > 0);
  assert.equal(nostalgiaBonus(heavy, now, 1), 0);
});

test('Memory: a 5★ track is penalized in the first 24 h and rediscovered after 14 days', async () => {
  const { engine, clock, rate } = setup();
  await engine.init();

  const favorite = track('favorite', undefined, 'band');
  const stranger = track('stranger', undefined, 'band');
  await rate(favorite, 5);

  clock.now += 40 * DAY;
  const baseline = engine.evaluateCandidate(favorite).score;

  engine.recordPlay({ ...play('favorite', clock.now, 180_000, false, 'band') });
  const justHeard = engine.evaluateCandidate(favorite);
  assert.ok(justHeard.score < baseline);
  assert.ok(justHeard.breakdown!.some((c) => c.key === 'fatigue'));

  clock.now += 23 * 3_600_000;
  assert.ok(engine.evaluateCandidate(favorite).breakdown!.some((c) => c.key === 'fatigue'));

  clock.now += 14 * DAY;
  const rediscovered = engine.evaluateCandidate(favorite);
  const nostalgia = rediscovered.breakdown!.find((c) => c.key === 'nostalgia');

  assert.ok(nostalgia && nostalgia.points >= 8 && nostalgia.points <= 12);
  assert.ok(!rediscovered.breakdown!.some((c) => c.key === 'fatigue'));
  assert.ok(rediscovered.score > baseline);
  assert.ok(!engine.evaluateCandidate(stranger).breakdown!.some((c) => c.key === 'nostalgia'));
});

test('Memory: a rating with no play history still counts as the last exposure', async () => {
  const { engine, clock, rate } = setup();
  await engine.init();
  const favorite = track('old-rating', undefined, 'band');
  await rate(favorite, 5);

  clock.now += 14 * DAY;
  assert.ok(engine.evaluateCandidate(favorite).breakdown!.some((c) => c.key === 'nostalgia'));
});

test('Performance: retrain with 20 000 ratings, clusters and graph in under 200 ms', async () => {
  const { engine, storage, rate } = setup();
  await engine.init();

  for (let i = 0; i < 20_000; i++) {
    await storage.saveRating({
      uri: `spotify:track:bulk${i}`,
      rating: (i % 6) as Rating,
      timestamp: i,
      metadata: track(`bulk${i}`, vary(i % 2 ? METAL : AMBIENT, i), `artist${i % 500}`, `album${i % 2000}`)
    });
  }
  await engine.reloadFromStorage();
  engine.evaluateCandidate(track('warm', METAL));

  // Best of several: one run under a parallel test suite measures the scheduler, not this code
  let elapsed = Number.POSITIVE_INFINITY;
  for (let attempt = 0; attempt < 5; attempt++) {
    const started = performance.now();
    await rate(track(`last${attempt}`, METAL), 5);
    engine.evaluateCandidate(track(`probe${attempt}`, METAL));
    elapsed = Math.min(elapsed, performance.now() - started);
  }

  assert.ok(elapsed < 200, `${elapsed} ms`);
});

function solverTrack(id: string, overrides: Partial<TrajectoryTrack<null>> = {}): TrajectoryTrack<null> {
  return { id, artistIds: [`artist-${id}`], score: 0.5, payload: null, ...overrides };
}

function tempoKeyPool(size: number): Array<TrajectoryTrack<null>> {
  return Array.from({ length: size }, (_, i) => {
    const number = (i % 5) + 3;
    return solverTrack(`t${i}`, {
      score: 0.8 - (i % 7) / 100,
      artistIds: [`artist${i % 12}`],
      bpm: 90 + (i * 37) % 80,
      energy: 0.2 + ((i * 13) % 60) / 100,
      camelot: parseCamelot(`${number}${i % 2 ? 'A' : 'B'}`)!,
      vector: [Math.sin(i), Math.cos(i * 2), ((i * 13) % 60) / 30 - 1]
    });
  });
}

function jumps(tracks: Array<TrajectoryTrack<null>>) {
  let tempo = 0;
  let harmonic = 0;
  let energy = 0;

  for (let i = 1; i < tracks.length; i++) {
    const [a, b] = [tracks[i - 1], tracks[i]];
    if (tempoDrift(a.bpm!, b.bpm!) > 0.12) tempo++;
    if (!isCamelotCompatible(a.camelot!, b.camelot!)) harmonic++;
    if (Math.abs(a.energy! - b.energy!) > 0.35) energy++;
  }
  return { tempo, harmonic, energy };
}

test('Trajectory: double and half time count as the same pulse', () => {
  assert.equal(tempoDrift(80, 160), 0);
  assert.equal(tempoDrift(160, 80), 0);
  assert.ok(Math.abs(tempoDrift(100, 110) - 0.1) < 1e-12);

  const cost = (a: number, b: number) => softTransitionCost(solverTrack('a', { bpm: a }), solverTrack('b', { bpm: b }));
  assert.ok(cost(100, 200) < cost(100, 125));
});

test('Trajectory: a generated queue never repeats an artist inside the window', () => {
  const { tracks } = solveTrajectory(tempoKeyPool(120), { length: 30 });

  assert.equal(tracks.length, 30);
  tracks.forEach((track, i) => {
    for (let j = 1; j <= 3 && i + j < tracks.length; j++) {
      assert.notDeepEqual(track.artistIds, tracks[i + j].artistIds);
    }
  });
  assert.equal(new Set(tracks.map((t) => t.id)).size, 30);
});

test('Trajectory: minimizes the jumps a score-sorted list would make', () => {
  const pool = tempoKeyPool(120);
  const sorted = [...pool].sort((a, b) => b.score - a.score).slice(0, 30);

  const baseline = jumps(sorted);
  const solved = jumps(solveTrajectory(pool, { length: 30 }).tracks);

  assert.ok(solved.tempo < baseline.tempo / 2, `bpm ${solved.tempo} vs ${baseline.tempo}`);
  assert.ok(solved.harmonic < baseline.harmonic / 2, `key ${solved.harmonic} vs ${baseline.harmonic}`);
  assert.ok(solved.energy <= baseline.energy, `energy ${solved.energy} vs ${baseline.energy}`);
});

test('Trajectory: the determinant term spreads the queue across the space', () => {
  const clustered = Array.from({ length: 12 }, (_, i) => solverTrack(`same${i}`, { score: 0.9, vector: [1, 1, 1] }));
  const distinct = Array.from({ length: 6 }, (_, i) => solverTrack(`far${i}`, {
    score: 0.86,
    vector: [i * 3, -i * 2, i]
  }));

  const diverse = solveTrajectory([...clustered, ...distinct], { length: 6, lambdaDiversity: 0.5 }).tracks;
  const pure = solveTrajectory([...clustered, ...distinct], { length: 6, lambdaDiversity: 0 }).tracks;

  const farCount = (tracks: typeof diverse) => tracks.filter((t) => t.id.startsWith('far')).length;
  assert.ok(farCount(diverse) > farCount(pure));
});

test('Hubness: local scaling takes away the universal neighbor', () => {
  // Track 0 is close to everyone; the others form distinct pairs
  const size = 9;
  const raw = Array.from({ length: size }, (_, i) => Float64Array.from({ length: size }, (_, j) => {
    if (i === j) return 1;
    if (i === 0 || j === 0) return 0.7;
    return Math.floor((i - 1) / 2) === Math.floor((j - 1) / 2) ? 0.65 : 0.1;
  }));

  const nearestToHub = (matrix: readonly Float64Array[]) => matrix
    .map((row, i) => {
      if (i === 0) return 0;
      const others = Array.from(row).map((v, j) => (j === i ? -1 : v));
      return others.indexOf(Math.max(...others)) === 0 ? 1 : 0;
    })
    .reduce<number>((sum, value) => sum + value, 0);

  const scaled = localScaling(raw, 2);
  const proximity = mutualProximity(scaled);

  assert.equal(nearestToHub(raw), 8);
  assert.equal(nearestToHub(proximity), 0);

  for (const matrix of [scaled, proximity]) {
    matrix.forEach((row, i) => row.forEach((value, j) => {
      assert.ok(Math.abs(value - matrix[j][i]) < 1e-12);
      assert.ok(value >= 0 && value <= 1 + 1e-12);
    }));
  }

  // The local scaling alone narrows the margin of the hub without reversing it
  assert.ok(scaled[1][0] / scaled[1][2] < raw[1][0] / raw[1][2]);
});

test('Trajectory: empty pool, and a pool that runs out of spacing, end cleanly', () => {
  assert.equal(solveTrajectory([]).tracks.length, 0);

  const sameArtist = Array.from({ length: 5 }, (_, i) => solverTrack(`t${i}`, { artistIds: ['one'] }));
  assert.equal(solveTrajectory(sameArtist, { length: 5 }).tracks.length, 1);
});

test('Trajectory: 300 candidates and 30 tracks stay fast', () => {
  const started = performance.now();
  solveTrajectory(tempoKeyPool(300), { length: 30 });
  assert.ok(performance.now() - started < 500);
});

function bridge(library: number, playlists: Record<string, TrackMetadata[]> = {}): HarvestBridge & { pages: number } {
  const all = Array.from({ length: library }, (_, i) => track(`lib${i}`, undefined, `a${i}`));
  return {
    pages: 0,
    async fetchLibraryPage(offset, limit) {
      this.pages++;
      return all.slice(offset, offset + limit);
    },
    async listPlaylists() {
      return Object.keys(playlists);
    },
    async fetchPlaylistTracks(uri) {
      return playlists[uri];
    }
  };
}

test('Harvester: pages up to 5000 tracks and merges every source without duplicates', async () => {
  const storage = new MemoryStorage();
  await storage.saveRating({ uri: 'spotify:track:r', rating: 4, timestamp: 1, metadata: track('r') });
  await storage.saveRating({ uri: 'spotify:track:low', rating: 2, timestamp: 1, metadata: track('low') });
  await storage.saveRating({ uri: 'spotify:track:ghost', rating: 5, timestamp: 1, metadata: { uri: 'spotify:track:ghost', name: 'Faixa', artists: [], album: { name: '', uri: '' } } });

  const source = bridge(6500, { 'spotify:playlist:p': [track('r'), track('lib0'), track('only-list')] });
  const result = await new CandidateHarvester(storage, source).harvest();

  assert.equal(result.sources.library, 5000);
  assert.equal(source.pages, 50);
  const uris = result.tracks.map((t) => t.uri);
  assert.equal(new Set(uris).size, uris.length);
  assert.ok(uris.includes('spotify:track:r'));
  assert.ok(uris.includes('spotify:track:only-list'));
  assert.ok(!uris.includes('spotify:track:low'));
  assert.ok(!uris.includes('spotify:track:ghost'));
  assert.deepEqual(result.contexts.get('spotify:playlist:p')?.length, 3);
});

test('Harvester: caches, and a failing source leaves the others', async () => {
  const storage = new MemoryStorage();
  await storage.saveRating({ uri: 'spotify:track:r', rating: 5, timestamp: 1, metadata: track('r') });

  const clock = { now: 0 };
  const source = bridge(10);
  const harvester = new CandidateHarvester(storage, source, () => clock.now);

  await harvester.harvest();
  await harvester.harvest();
  assert.equal(source.pages, 1);

  clock.now += 11 * 60_000;
  await harvester.harvest();
  assert.equal(source.pages, 2);

  const originalWarn = console.warn;
  console.warn = () => undefined;
  const broken = new CandidateHarvester(storage, {
    fetchLibraryPage: async () => { throw new Error('offline'); },
    listPlaylists: async () => { throw new Error('offline'); },
    fetchPlaylistTracks: async () => []
  });
  const result = await broken.harvest();
  console.warn = originalWarn;

  assert.equal(result.tracks.length, 1);
});

test('Text2Radio: the two prompts of the specification', () => {
  const focus = parseRadioPrompt('foco noturno instrumental lento sem músicas repetidas');

  assert.equal(focus.params.instrumentalOnly, true);
  assert.equal(focus.params.maxBpm, 100);
  assert.equal(focus.avoidRepeats, true);
  assert.equal(focus.params.explorationFactor, 0.1);
  assert.ok(focus.targetVector);

  const gym = parseRadioPrompt('treino pesado anos 90/2000 com alta energia e redescobertas');

  assert.equal(gym.params.minEnergy, 0.7);
  assert.equal(gym.params.eraStart, 1990);
  assert.equal(gym.params.eraEnd, 2009);
  assert.equal(gym.nostalgiaOnly, true);
  assert.ok(gym.target.energy! > 0.7);
});

test('Text2Radio: moods, tempo and era in Portuguese, accents optional', () => {
  const sad = parseRadioPrompt('Músicas TRISTES e lentas dos anos 80');
  assert.equal(sad.params.maxValence, 0.45);
  assert.equal(sad.params.maxBpm, 100);
  assert.equal(sad.params.eraStart, 1980);
  assert.equal(sad.params.eraEnd, 1989);

  const unaccented = parseRadioPrompt('musicas acusticas calmas');
  assert.ok(unaccented.target.acousticness! > 0.7);
  assert.equal(unaccented.params.maxEnergy, 0.45);

  assert.equal(parseRadioPrompt('rock da década de 2010').params.eraStart, 2010);
  assert.equal(parseRadioPrompt('2000s hits').params.eraStart, 2000);
  assert.equal(parseRadioPrompt('anos 70').params.eraEnd, 1979);
});

test('Text2Radio: English, discovery and strict harmonic mixing', () => {
  const run = parseRadioPrompt('fast happy dance music for a party, discover new stuff');
  assert.equal(run.params.minBpm, 125);
  assert.equal(run.params.minValence, 0.5);
  assert.equal(run.params.explorationFactor, 0.8);

  assert.equal(parseRadioPrompt('set de dj com mixagem harmonica').strictHarmonic, true);
});

test('Text2Radio: negation flips nothing on, and "sem vocais" means instrumental', () => {
  const noFocus = parseRadioPrompt('sem foco, nada triste');
  assert.equal(noFocus.params.explorationFactor, undefined);
  assert.equal(noFocus.params.maxValence, undefined);

  assert.equal(parseRadioPrompt('música sem vocais').params.instrumentalOnly, true);
  assert.equal(parseRadioPrompt('musica sem vocais').params.vocalOnly, undefined);
});

test('Text2Radio: unknown words yield an empty, harmless request, with what was understood listed', () => {
  const unknown = parseRadioPrompt('xyzzy plugh');
  assert.deepEqual(unknown.params, {});
  assert.equal(unknown.targetVector, null);
  assert.deepEqual(unknown.matched, []);

  assert.ok(parseRadioPrompt('rádio calma').matched.includes('energia baixa'));
  assert.deepEqual(parseRadioPrompt('').matched, []);
});

test('Text2Radio: the filters it produces really select tracks in the radio engine', async () => {
  const storage = new MemoryStorage();
  const engine = new PreferenceEngine(storage);
  await engine.init();
  const radio = new RadioEngine(engine, new BlacklistManager(storage));

  const { params } = parseRadioPrompt('foco instrumental lento');
  const result = radio.generateRadio([
    track('quiet', { bpm: 70, instrumentalness: 0.9, energy: 0.2 }),
    track('fast', { bpm: 150, instrumentalness: 0.9, energy: 0.2 }),
    track('sung', { bpm: 70, instrumentalness: 0.1, energy: 0.2 })
  ], 'custom', params);

  assert.deepEqual(result.tracks.map((t) => t.name), ['quiet']);
});

function portability(diagnostics?: () => unknown) {
  const storage = new MemoryStorage();
  const blacklist = new BlacklistManager(storage);
  return { storage, manager: new DataPortabilityManager({ storage, blacklist, getModelDiagnostics: diagnostics }) };
}

const FULL_FEATURES: AcousticFeatures = {
  bpm: 128, key: 9, mode: 0, camelot: '8A', keyConfidence: 0.75, energy: 0.8, valence: 0.3, danceability: 0.7,
  acousticness: 0.1, instrumentalness: 0.2, speechiness: 0.05, liveness: 0.15,
  chroma: [1, 0.5], timbre: [40, 2], timbreVariance: [9, 3], source: SYNTHESIZED_SOURCE
};

async function seeded(diagnostics?: () => unknown) {
  const context = portability(diagnostics);
  for (let rating = 0; rating <= 5; rating++) {
    await context.storage.saveRating({
      uri: `spotify:track:t${rating}`,
      rating: rating as Rating,
      timestamp: 1000 + rating,
      manualOverride: rating === 3,
      metadata: { ...track(`t${rating}`, FULL_FEATURES, 'Artista; "X"', 'Álbum'), duration_ms: 200_000, genres: ['rock'], releaseYear: 1999 }
    });
  }
  return context;
}

test('Portability: JSON keeps every rating with every field', async () => {
  const { storage, manager } = await seeded();
  const file = await manager.exportJson();
  const data = JSON.parse(file.content);

  assert.equal(file.filename, JSON_EXPORT_FILENAME);
  assert.deepEqual(data.ratings, await storage.getAllRatings());
});

test('Portability: importing the JSON loses no field, the 3.0 features included', async () => {
  const source = await seeded();
  const target = portability();

  await target.manager.importJson((await source.manager.exportJson()).content);

  const original = await source.storage.getRating('spotify:track:t5');
  const restored = await target.storage.getRating('spotify:track:t5');
  assert.deepEqual(restored?.metadata.acousticFeatures, original?.metadata.acousticFeatures);
  assert.deepEqual(restored?.metadata.genres, ['rock']);
  assert.equal(restored?.metadata.releaseYear, 1999);
  assert.equal((await target.storage.getRating('spotify:track:t3'))?.manualOverride, true);
});

test('Portability: CSV has one row per rating, unchanged columns and BOM', async () => {
  const { manager } = await seeded();
  const { content } = await manager.exportCsv();
  const rows = content.slice(1).trimEnd().split('\r\n');

  assert.ok(content.startsWith('﻿'));
  assert.equal(rows[0], CSV_COLUMNS.join(';'));
  assert.equal(rows.length, 7);
});

test('Portability: JSPF carries every rating as a valid playlist', async () => {
  const { manager } = await seeded();
  const file = await manager.exportJspf();
  const { playlist } = JSON.parse(file.content);

  assert.equal(file.filename, JSPF_EXPORT_FILENAME);
  assert.equal(playlist.track.length, 6);
  assert.ok(playlist.title && playlist.creator && playlist.date);

  const [first] = playlist.track;
  assert.equal(first.title, 't5');
  assert.equal(first.creator, 'Artista; "X"');
  assert.equal(first.album, 'Álbum');
  assert.equal(first.duration, 200000);
  assert.deepEqual(first.identifier, ['https://open.spotify.com/track/t5']);

  const extension = Object.values(first.extension)[0] as { rating: number; uri: string; ratedAt: string };
  assert.equal(extension.rating, 5);
  assert.equal(extension.uri, 'spotify:track:t5');
  assert.ok(extension.ratedAt);
});

test('Portability: a generated radio exports as JSPF in its order', async () => {
  const { manager } = portability();
  const { content } = await manager.exportRadioJspf('Minha rádio', [track('b'), track('a')]);
  const { playlist } = JSON.parse(content);

  assert.equal(playlist.title, 'Minha rádio');
  assert.deepEqual(playlist.track.map((t: { title: string }) => t.title), ['b', 'a']);
});

test('Portability: JSON reports clusters and acoustic coverage by source', async () => {
  const { manager, storage } = await seeded(() => ({ clusters: [{ share: 1, description: 'Alta energia' }] }));
  await storage.saveRating({ uri: 'spotify:track:bare', rating: 3, timestamp: 1, metadata: track('bare') });

  const data = JSON.parse((await manager.exportJson()).content);

  assert.equal(data.featureSources[SYNTHESIZED_SOURCE], 6);
  assert.equal(data.featureSources['Sem dados acústicos'], 1);
  assert.equal(data.model.clusters[0].description, 'Alta energia');
});
