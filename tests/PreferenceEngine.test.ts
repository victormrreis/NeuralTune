import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStorage } from '../src/storage/MemoryStorage.ts';
import { PreferenceEngine } from '../src/core/PreferenceEngine.ts';
import { TrackMetadata, TrackRatingRecord } from '../src/types/index.ts';

test('PreferenceEngine: Bayesian learning boosts positive attributes', async () => {
  const storage = new MemoryStorage();
  const engine = new PreferenceEngine(storage);
  await engine.init();

  const track5Stars: TrackMetadata = {
    uri: 'spotify:track:rock1',
    name: 'Great Rock Song',
    artists: [{ name: 'Rock Band', uri: 'spotify:artist:rock_band' }],
    album: { name: 'Album', uri: '' },
    genres: ['alternative rock'],
    releaseYear: 2004,
    acousticFeatures: { bpm: 120, energy: 0.8 }
  };

  const record: TrackRatingRecord = {
    uri: track5Stars.uri,
    rating: 5,
    timestamp: Date.now(),
    metadata: track5Stars
  };

  await engine.updateWithRating(record, null);

  const profile = engine.getProfile();
  const genreWeight = profile.attributeWeights['genre:alternative rock'];
  assert.ok(genreWeight);
  assert.ok(genreWeight.weight > 0);
  assert.equal(genreWeight.count, 1);
  assert.ok(genreWeight.confidence > 0);

  // Candidate with same genre should receive a score higher than 50
  const candidate: TrackMetadata = {
    uri: 'spotify:track:rock2',
    name: 'Another Rock Song',
    artists: [{ name: 'Other Band', uri: 'spotify:artist:other' }],
    album: { name: 'Album', uri: '' },
    genres: ['alternative rock']
  };

  const evalResult = engine.evaluateCandidate(candidate);
  assert.ok(evalResult.score > 50);
  assert.equal(evalResult.eligible, true);
  assert.ok(evalResult.reasons.length > 0);
});

test('PreferenceEngine: Rating 0 penalizes attributes proportionally without eliminating the whole genre', async () => {
  const storage = new MemoryStorage();
  const engine = new PreferenceEngine(storage);
  await engine.init();

  // 1. Positive rating on genre "indie rock"
  const goodTrack: TrackMetadata = {
    uri: 'spotify:track:good_indie',
    name: 'Good Indie',
    artists: [{ name: 'Band A', uri: 'spotify:artist:a' }],
    album: { name: '', uri: '' },
    genres: ['indie rock']
  };
  await engine.updateWithRating({
    uri: goodTrack.uri,
    rating: 5,
    timestamp: Date.now(),
    metadata: goodTrack
  }, null);

  // 2. Reject one specific song of the same genre with 0 stars
  const badTrack: TrackMetadata = {
    uri: 'spotify:track:bad_indie',
    name: 'Bad Indie Track',
    artists: [{ name: 'Band B', uri: 'spotify:artist:b' }],
    album: { name: '', uri: '' },
    genres: ['indie rock']
  };
  // Mark badTrack as blocked in storage (deterministic block)
  await storage.saveRating({
    uri: badTrack.uri,
    rating: 0,
    timestamp: Date.now(),
    metadata: badTrack
  });
  await engine.updateWithRating({
    uri: badTrack.uri,
    rating: 0,
    timestamp: Date.now(),
    metadata: badTrack
  }, null);

  // The rejected track itself is deterministically INELIGIBLE
  const badEval = engine.evaluateCandidate(badTrack);
  assert.equal(badEval.eligible, false);
  assert.equal(badEval.score, 0);

  // A NEW third track in the same genre should NOT be eliminated!
  const thirdTrack: TrackMetadata = {
    uri: 'spotify:track:third_indie',
    name: 'Third Indie Track',
    artists: [{ name: 'Band C', uri: 'spotify:artist:c' }],
    album: { name: '', uri: '' },
    genres: ['indie rock']
  };
  const thirdEval = engine.evaluateCandidate(thirdTrack);
  assert.equal(thirdEval.eligible, true);
  // Its score remains around neutral (neither locked out nor exaggerated)
  assert.ok(thirdEval.score >= 35 && thirdEval.score <= 65);
});

test('PreferenceEngine: Anti-fatigue penalty on recently played artist', async () => {
  const storage = new MemoryStorage();
  const engine = new PreferenceEngine(storage);
  await engine.init();

  const track: TrackMetadata = {
    uri: 'spotify:track:t1',
    name: 'Song',
    artists: [{ name: 'Band X', uri: 'spotify:artist:x' }],
    album: { name: '', uri: '' }
  };

  // Score without recent history
  const normalEval = engine.evaluateCandidate(track, []);

  // Score when artist was played right before
  const fatigueEval = engine.evaluateCandidate(track, ['spotify:artist:x']);
  assert.ok(fatigueEval.score < normalEval.score);
  assert.ok(fatigueEval.reasons.some((r) => r.attribute === 'anti-fatigue'));
});
