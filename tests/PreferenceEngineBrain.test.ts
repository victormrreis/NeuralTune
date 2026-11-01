import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStorage } from '../src/storage/MemoryStorage.ts';
import { PreferenceEngine } from '../src/core/PreferenceEngine.ts';
import { RatingManager } from '../src/core/RatingManager.ts';
import { ExplainabilityEngine } from '../src/explainability/ExplainabilityEngine.ts';
import { acousticSimilarity, toAcousticPoint } from '../src/core/AcousticVector.ts';
import { AcousticFeatures, PlayEvent, Rating, TrackMetadata } from '../src/types/index.ts';

const METAL: AcousticFeatures = {
  bpm: 165, energy: 0.95, valence: 0.25, danceability: 0.4,
  acousticness: 0.02, instrumentalness: 0.1, speechiness: 0.1, liveness: 0.2
};
const AMBIENT: AcousticFeatures = {
  bpm: 70, energy: 0.1, valence: 0.3, danceability: 0.2,
  acousticness: 0.9, instrumentalness: 0.9, speechiness: 0.04, liveness: 0.1
};

function jitter(features: AcousticFeatures, amount: number): AcousticFeatures {
  return {
    ...features,
    energy: features.energy! - amount,
    danceability: features.danceability! + amount,
    acousticness: features.acousticness! + amount
  };
}

function track(id: string, features?: AcousticFeatures, artist: string = id): TrackMetadata {
  return {
    uri: `spotify:track:${id}`,
    name: id,
    artists: [{ name: artist, uri: `spotify:artist:${artist}` }],
    album: { name: '', uri: '' },
    acousticFeatures: features
  };
}

function setup(start: number = 1_000_000_000) {
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

function distanceToUser(engine: PreferenceEngine, features: AcousticFeatures): number {
  const point = toAcousticPoint(features)!;
  const { vector } = engine.getModelSnapshot();
  return Math.sqrt(point.values.reduce((sum, value, i) => sum + (value - vector[i]) ** 2, 0));
}

function play(uri: string, artist: string, startedAt: number): PlayEvent {
  return {
    id: `${uri}@${startedAt}`, uri, name: 'x', artistUris: [artist],
    startedAt, endedAt: startedAt + 60_000, playedMs: 60_000, skipped: false
  };
}

test('Brain: 5★ attracts the user vector, and more than 4★', async () => {
  const five = setup();
  const four = setup();
  await five.engine.init();
  await four.engine.init();

  const before = distanceToUser(five.engine, METAL);
  await five.rate(track('a', METAL), 5);
  await four.rate(track('a', METAL), 4);

  const afterFive = distanceToUser(five.engine, METAL);
  const afterFour = distanceToUser(four.engine, METAL);
  assert.ok(afterFive < afterFour);
  assert.ok(afterFour < before);
});

test('Brain: 1★ repels harder than 2★, and 3★ leaves the vector alone', async () => {
  const seed = jitter(METAL, 0.02);

  const build = async (rating: Rating) => {
    const ctx = setup();
    await ctx.engine.init();
    for (let i = 0; i < 6; i++) await ctx.rate(track(`seed${i}`, seed), 5);
    const before = distanceToUser(ctx.engine, METAL);
    await ctx.rate(track('target', METAL), rating);
    return distanceToUser(ctx.engine, METAL) - before;
  };

  const one = await build(1);
  const two = await build(2);
  const three = await build(3);

  assert.ok(one > two);
  assert.ok(two > 0);
  assert.equal(three, 0);
});

test('Brain: repulsion fades with distance, so disliking a far track barely moves the profile', async () => {
  const ctx = setup();
  await ctx.engine.init();
  for (let i = 0; i < 8; i++) await ctx.rate(track(`m${i}`, METAL), 5);
  const before = ctx.engine.getModelSnapshot().vector;

  await ctx.rate(track('far', AMBIENT), 1);
  const after = ctx.engine.getModelSnapshot().vector;

  const moved = Math.sqrt(before.reduce((sum, v, i) => sum + (v - after[i]) ** 2, 0));
  assert.ok(moved < 0.005, `moved ${moved}`);
});

test('Brain: acoustic matches outrank mismatches once taste is learned', async () => {
  const ctx = setup();
  await ctx.engine.init();
  for (let i = 0; i < 10; i++) await ctx.rate(track(`m${i}`, jitter(METAL, i / 200)), 5);
  for (let i = 0; i < 5; i++) await ctx.rate(track(`am${i}`, jitter(AMBIENT, i / 200)), 2);

  const match = ctx.engine.evaluateCandidate(track('c1', METAL));
  const mismatch = ctx.engine.evaluateCandidate(track('c2', AMBIENT));

  assert.ok(match.score > 70, `match ${match.score}`);
  assert.ok(mismatch.score < match.score - 20, `mismatch ${mismatch.score}`);
});

test('Brain: 0★ penalizes its acoustic neighborhood without touching a distant region or the genre', async () => {
  const ctx = setup();
  await ctx.engine.init();

  const blocked = { ...track('blocked', METAL), genres: ['rock'] };
  await ctx.rate(blocked, 0);

  const neighbor = ctx.engine.evaluateCandidate({ ...track('n', jitter(METAL, 0.02)), genres: ['rock'] });
  const distant = ctx.engine.evaluateCandidate({ ...track('d', AMBIENT), genres: ['rock'] });

  assert.equal(neighbor.eligible, true);
  assert.ok(neighbor.breakdown?.some((c) => c.key === 'avoidance' && c.points < -15));
  assert.ok(!distant.breakdown?.some((c) => c.key === 'avoidance' && c.points < -1));
  assert.ok(ctx.engine.getProfile().attributeWeights['genre:rock'].weight > -0.3);
});

test('Brain: LinUCB explores the unknown and the bonus shrinks with evidence', async () => {
  const ctx = setup();
  await ctx.engine.init();

  const exploration = () => ctx.engine.evaluateCandidate(track('c', METAL)).breakdown
    ?.find((c) => c.key === 'exploration')?.points ?? 0;

  const initial = exploration();
  assert.ok(initial > 5);

  for (let i = 0; i < 20; i++) await ctx.rate(track(`m${i}`, METAL), 3);

  assert.ok(exploration() < initial / 2);
  assert.ok(
    ctx.engine.evaluateCandidate(track('novel', AMBIENT)).noveltyScore
      > ctx.engine.evaluateCandidate(track('known', METAL)).noveltyScore
  );
});

test('Brain: higher exploration factor promotes uncertain tracks', async () => {
  const ctx = setup();
  await ctx.engine.init();
  for (let i = 0; i < 12; i++) await ctx.rate(track(`m${i}`, METAL), 4);

  const novelty = track('novel', AMBIENT);
  const conservative = ctx.engine.evaluateCandidate(novelty).score;
  ctx.engine.getProfile().explorationFactor = 0.8;
  assert.ok(ctx.engine.evaluateCandidate(novelty).score > conservative);
});

test('Brain: fatigue decays across the 30 min, 2 h and 24 h horizons', async () => {
  const ctx = setup();
  await ctx.engine.init();

  const candidate = track('song', undefined, 'band');
  const baseline = ctx.engine.evaluateCandidate(candidate).score;

  ctx.engine.recordPlay(play(candidate.uri, 'spotify:artist:band', ctx.clock.now));
  const justPlayed = ctx.engine.evaluateCandidate(candidate).score;

  ctx.clock.now += 30 * 60_000;
  const after30Minutes = ctx.engine.evaluateCandidate(candidate).score;
  ctx.clock.now += 90 * 60_000;
  const after2Hours = ctx.engine.evaluateCandidate(candidate).score;
  ctx.clock.now += 22 * 60 * 60_000;
  const after24Hours = ctx.engine.evaluateCandidate(candidate).score;
  ctx.clock.now += 7 * 24 * 60 * 60_000;
  const afterAWeek = ctx.engine.evaluateCandidate(candidate).score;

  assert.ok(justPlayed < after30Minutes);
  assert.ok(after30Minutes < after2Hours);
  assert.ok(after2Hours < after24Hours);
  assert.ok(after24Hours < baseline);
  assert.equal(afterAWeek, baseline);
});

test('Brain: an artist tires less than the exact track, and auto-skips do not tire at all', async () => {
  const ctx = setup();
  await ctx.engine.init();

  const played = track('song', undefined, 'band');
  const sibling = track('other', undefined, 'band');
  const skipped = track('skipped', undefined, 'skippers');

  ctx.engine.recordPlay(play(played.uri, 'spotify:artist:band', ctx.clock.now));
  ctx.engine.recordPlay({ ...play(skipped.uri, 'spotify:artist:skippers', ctx.clock.now), playedMs: 400, skipped: true });

  assert.ok(ctx.engine.evaluateCandidate(played).score < ctx.engine.evaluateCandidate(sibling).score);
  assert.ok(ctx.engine.evaluateCandidate(sibling).score < 50);
  assert.equal(ctx.engine.evaluateCandidate(skipped).score, 50);
});

test('Brain: fatigue survives a reload through the stored play events', async () => {
  const ctx = setup();
  await ctx.storage.savePlayEvent(play('spotify:track:song', 'spotify:artist:band', ctx.clock.now - 60_000));
  await ctx.engine.init();

  assert.ok(ctx.engine.evaluateCandidate(track('song', undefined, 'band')).score < 50);
});

test('Brain: undo restores the exact previous model', async () => {
  const storage = new MemoryStorage();
  const engine = new PreferenceEngine(storage);
  const manager = new RatingManager(storage);
  await engine.init();
  manager.onRatingChange((record, previous) => {
    engine.updateWithRating(record, previous);
  });

  await manager.rateTrack(track('a', METAL), 5);
  await manager.rateTrack(track('b', jitter(METAL, 0.05)), 4);
  const expected = engine.getModelSnapshot();
  const candidate = track('c', AMBIENT);
  const expectedScore = engine.evaluateCandidate(candidate).score;

  await manager.rateTrack(track('z', AMBIENT), 1);
  assert.notDeepEqual(engine.getModelSnapshot().vector, expected.vector);

  await manager.undo();
  assert.deepEqual(engine.getModelSnapshot(), expected);
  assert.equal(engine.evaluateCandidate(candidate).score, expectedScore);
});

test('Brain: re-rating is equivalent to having rated that way from the start', async () => {
  const direct = setup();
  const corrected = setup();
  await direct.engine.init();
  await corrected.engine.init();

  const t = track('a', METAL);
  await direct.rate(t, 5);

  await corrected.rate(t, 1);
  const first = await corrected.storage.getRating(t.uri);
  const replacement = { uri: t.uri, rating: 5 as Rating, timestamp: corrected.clock.now, metadata: t };
  await corrected.storage.saveRating(replacement);
  await corrected.engine.updateWithRating(replacement, first);

  assert.deepEqual(corrected.engine.getModelSnapshot().vector, direct.engine.getModelSnapshot().vector);
});

test('Brain: removing a rating forgets it, including attribute sample counts', async () => {
  const storage = new MemoryStorage();
  const engine = new PreferenceEngine(storage);
  const manager = new RatingManager(storage);
  await engine.init();
  manager.onRatingChange((record, previous) => {
    engine.updateWithRating(record, previous);
  });

  await manager.rateTrack({ ...track('a', METAL), genres: ['metal'] }, 5);
  await manager.deleteRating('spotify:track:a');

  const genre = engine.getProfile().attributeWeights['genre:metal'];
  assert.equal(genre.count, 0);
  assert.ok(Math.abs(genre.weight) < 1e-12);
  assert.equal(engine.getModelSnapshot().samples, 0);
});

test('Brain: init retrains from stored ratings, and reloadFromStorage rebuilds imported data', async () => {
  const first = setup();
  await first.engine.init();
  await first.rate(track('a', METAL), 5);
  const trained = first.engine.getModelSnapshot();

  const reopened = new PreferenceEngine(first.storage);
  await reopened.init();
  assert.deepEqual(reopened.getModelSnapshot(), trained);

  await first.storage.saveRating({
    uri: 'spotify:track:imported', rating: 5, timestamp: first.clock.now + 1000,
    metadata: { ...track('imported', METAL), genres: ['metal'] }
  });
  await reopened.reloadFromStorage();

  assert.equal(reopened.getModelSnapshot().samples, 2);
  assert.ok(reopened.getProfile().attributeWeights['genre:metal'].weight > 0);
});

test('Brain: tempo-only samples learn nothing about the other dimensions', async () => {
  const ctx = setup();
  await ctx.engine.init();
  const before = ctx.engine.getModelSnapshot().vector;

  await ctx.rate(track('a', { bpm: 190 }), 5);
  const after = ctx.engine.getModelSnapshot().vector;

  assert.ok(after[0] > before[0]);
  assert.deepEqual(after.slice(1), before.slice(1));
});

test('Brain: scoring still works with no acoustic data at all', async () => {
  const ctx = setup();
  await ctx.engine.init();
  await ctx.rate(track('a', undefined, 'band'), 5);

  const sameArtist = ctx.engine.evaluateCandidate(track('b', undefined, 'band'));
  const unknown = ctx.engine.evaluateCandidate(track('c', undefined, 'other'));

  assert.ok(sameArtist.score > unknown.score);
  assert.equal(unknown.score, 50);
  assert.equal(ctx.engine.getModelSnapshot().samples, 0);
});

test('Brain: the score decomposes into shares that reconcile with it', async () => {
  const ctx = setup();
  await ctx.engine.init();
  for (let i = 0; i < 10; i++) await ctx.rate(track(`m${i}`, jitter(METAL, i / 200), 'band'), 5);

  ctx.engine.recordPlay(play('spotify:track:other', 'spotify:artist:band', ctx.clock.now - 20 * 60_000));
  const result = ctx.engine.evaluateCandidate(track('candidate', METAL, 'band'));
  const breakdown = result.breakdown!;

  const total = breakdown.reduce((sum, c) => sum + c.points, 0);
  const positiveShares = breakdown.filter((c) => c.share > 0).reduce((sum, c) => sum + c.share, 0);

  assert.ok(Math.abs(positiveShares - 1) < 1e-9);
  assert.ok(Math.abs(Math.min(100, 50 + total) - result.score) <= 1.5);
  assert.ok(breakdown.some((c) => c.key === 'fatigue' && c.share < 0));

  const acoustic = breakdown.find((c) => c.key === 'acoustic');
  assert.match(acoustic!.label, /afinidade acústica \(.*alta energia.*\)|afinidade acústica \(.*andamento rápido.*\)/);

  const line = new ExplainabilityEngine().formatBreakdown(breakdown);
  assert.match(line, /^\d+% /);
  assert.match(line, /, \+\d+% /);
  assert.match(line, /-\d+% penalidade por repetição recente/);
});

test('Brain: retraining over 20 000 ratings stays fast enough for every keypress', async () => {
  const ctx = setup();
  await ctx.engine.init();

  for (let i = 0; i < 20_000; i++) {
    await ctx.storage.saveRating({
      uri: `spotify:track:bulk${i}`,
      rating: (i % 6) as Rating,
      timestamp: i,
      metadata: track(`bulk${i}`, jitter(i % 2 ? METAL : AMBIENT, (i % 10) / 100))
    });
  }
  await ctx.engine.reloadFromStorage();

  // Best of several: one run under a parallel test suite measures the scheduler, not this code
  let elapsed = Number.POSITIVE_INFINITY;
  for (let attempt = 0; attempt < 5; attempt++) {
    const started = performance.now();
    await ctx.rate(track(`last${attempt}`, METAL), 5);
    elapsed = Math.min(elapsed, performance.now() - started);
  }

  assert.ok(elapsed < 200, `${elapsed} ms`);
});

test('Brain: reference similarity is consistent with the helper used in scoring', () => {
  const a = toAcousticPoint(METAL)!.values;
  const b = toAcousticPoint(AMBIENT)!.values;
  assert.ok(acousticSimilarity(a, a) > 0.999);
  assert.ok(acousticSimilarity(a, b) < 0);
});
