import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStorage } from '../src/storage/MemoryStorage.ts';
import { AudioFeatureBridge, AudioFeatureProvider, RawAudioFeatures } from '../src/core/AudioFeatureProvider.ts';
import { SYNTHESIS_VERSION } from '../src/core/AudioAnalysisSynthesizer.ts';
import { PlaybackHistoryTracker, isSkip } from '../src/core/PlaybackHistoryTracker.ts';
import { PlayEvent, TrackMetadata } from '../src/types/index.ts';

function track(id: string, duration_ms?: number): TrackMetadata {
  return {
    uri: `spotify:track:${id}`,
    name: id,
    artists: [{ name: 'A', uri: 'spotify:artist:a' }],
    album: { name: '', uri: '' },
    duration_ms
  };
}

test('isSkip: under 30 s or half of a short track', () => {
  assert.equal(isSkip(10_000, 200_000), true);
  assert.equal(isSkip(31_000, 200_000), false);
  assert.equal(isSkip(25_000, 40_000), false);
  assert.equal(isSkip(15_000, 40_000), true);
  assert.equal(isSkip(29_000), true);
});

test('Tracker: closes one event per track change, using player progress', async () => {
  const clock = { now: 1000 };
  const storage = new MemoryStorage();
  const seen: PlayEvent[] = [];
  const tracker = new PlaybackHistoryTracker(storage, (e) => seen.push(e), () => clock.now);

  await tracker.onTrackChange(track('a', 200_000));
  clock.now += 500_000; // Paused for most of this time: progress is what counts
  tracker.updateProgress(120_000);
  await tracker.onTrackChange(track('b', 200_000));

  const events = await storage.getAllPlayEvents();
  assert.equal(events.length, 1);
  assert.equal(events[0].uri, 'spotify:track:a');
  assert.equal(events[0].playedMs, 120_000);
  assert.equal(events[0].skipped, false);
  assert.deepEqual(events[0].artistUris, ['spotify:artist:a']);
  assert.equal(seen.length, 1);
});

test('Tracker: an early change is a skip, and a repeated notification is ignored', async () => {
  const clock = { now: 1000 };
  const storage = new MemoryStorage();
  const tracker = new PlaybackHistoryTracker(storage, undefined, () => clock.now);

  await tracker.onTrackChange(track('a', 200_000));
  clock.now += 3000;
  tracker.updateProgress(3000);
  await tracker.onTrackChange(track('a', 200_000));
  assert.equal((await storage.getAllPlayEvents()).length, 0);

  await tracker.onTrackChange(track('b'));
  const [event] = await storage.getAllPlayEvents();
  assert.equal(event.skipped, true);
  assert.equal(event.playedMs, 3000);
});

test('Tracker: ads and podcasts are not listening history, flush closes the session', async () => {
  const clock = { now: 1000 };
  const storage = new MemoryStorage();
  const tracker = new PlaybackHistoryTracker(storage, undefined, () => clock.now);

  await tracker.onTrackChange({ ...track('x'), uri: 'spotify:ad:x' });
  clock.now += 10_000;
  tracker.updateProgress(10_000);
  await tracker.onTrackChange(track('a'));
  clock.now += 40_000;
  tracker.updateProgress(40_000);
  await tracker.flush();

  const events = await storage.getAllPlayEvents();
  assert.deepEqual(events.map((e) => e.uri), ['spotify:track:a']);
});

test('Tracker: a storage failure never reaches the player', async () => {
  const storage = new MemoryStorage();
  storage.savePlayEvent = async () => { throw new Error('quota'); };
  const originalWarn = console.warn;
  console.warn = () => undefined;

  const tracker = new PlaybackHistoryTracker(storage);
  await tracker.onTrackChange(track('a'));
  tracker.updateProgress(60_000);
  await assert.doesNotReject(tracker.onTrackChange(track('b')));

  console.warn = originalWarn;
});

class FakeAudio implements AudioFeatureBridge {
  batches: string[][] = [];
  analysisCalls = 0;
  failure: unknown = null;
  analysisFailure: unknown = null;

  async fetchBatch(ids: string[]): Promise<Array<RawAudioFeatures | null>> {
    this.batches.push(ids);
    if (this.failure) throw this.failure;
    return ids.map((id) => (id === 'missing' ? null : { tempo: 120, energy: 0.5, liveness: 0.1 }));
  }
  async fetchAnalysis() {
    this.analysisCalls++;
    if (this.analysisFailure) throw this.analysisFailure;
    return { bpm: 128, key: 0, mode: 1, camelot: '8B', energy: 0.7, source: 'Spotify Audio Analysis (Synthesized)', synthesisVersion: SYNTHESIS_VERSION };
  }
}

test('AudioFeatures: caches, persists and never asks twice for a track', async () => {
  const storage = new MemoryStorage();
  const audio = new FakeAudio();
  const provider = new AudioFeatureProvider(storage, audio);

  assert.equal(await provider.ensure(['spotify:track:a', 'spotify:track:b']), 2);
  assert.equal(await provider.ensure(['spotify:track:a', 'spotify:track:b']), 0);
  assert.equal(audio.batches.length, 1);

  assert.equal(provider.get('spotify:track:a')?.energy, 0.5);
  assert.equal(provider.get('spotify:track:a')?.bpm, 120);
  assert.equal(provider.get('spotify:track:a')?.liveness, 0.1);
  assert.equal(provider.attach(track('a')).acousticFeatures?.bpm, 120);

  const reopened = new AudioFeatureProvider(storage, audio);
  await reopened.init();
  assert.equal(reopened.get('spotify:track:b')?.energy, 0.5);
});

test('AudioFeatures: batches at 100, ignores non-tracks, remembers tracks without data', async () => {
  const audio = new FakeAudio();
  const provider = new AudioFeatureProvider(new MemoryStorage(), audio);
  const uris = Array.from({ length: 230 }, (_, i) => `spotify:track:t${i}`);

  await provider.ensure([...uris, 'spotify:episode:e', 'spotify:track:missing']);
  assert.deepEqual(audio.batches.map((b) => b.length), [100, 100, 31]);

  await provider.ensure(['spotify:track:missing']);
  assert.equal(audio.batches.length, 3);
});

test('AudioFeatures: a 403 disables the batch endpoint for the session, without retry storms', async () => {
  const audio = new FakeAudio();
  audio.failure = { status: 403 };
  const provider = new AudioFeatureProvider(new MemoryStorage(), audio);

  await provider.ensure(Array.from({ length: 300 }, (_, i) => `spotify:track:t${i}`));
  await provider.ensure(['spotify:track:other']);

  assert.equal(audio.batches.length, 1);
  assert.equal(provider.getDiagnostics().status, 'unavailable');
  assert.equal(provider.getDiagnostics().lastError, 'HTTP 403');
});

test('AudioFeatures: with the batch refused, the current track still gets key data from analysis', async () => {
  const audio = new FakeAudio();
  audio.failure = { code: 403 };
  const provider = new AudioFeatureProvider(new MemoryStorage(), audio);

  await provider.ensureCurrent('spotify:track:now');

  assert.equal(provider.get('spotify:track:now')?.bpm, 128);
  assert.equal(provider.get('spotify:track:now')?.camelot, '8B');
  assert.equal(provider.hasHarmonicData('spotify:track:now'), true);
});

test('AudioFeatures: a tempo-only record from v2 is upgraded by analysis, once', async () => {
  const storage = new MemoryStorage();
  await storage.saveAudioFeatures([{ uri: 'spotify:track:old', features: { bpm: 90, source: 'Spotify Audio Analysis' }, fetchedAt: 1 }]);
  const audio = new FakeAudio();
  const provider = new AudioFeatureProvider(storage, audio);
  await provider.init();

  assert.equal(await provider.ensureAnalyzed(['spotify:track:old']), 1);
  assert.equal(await provider.ensureAnalyzed(['spotify:track:old']), 0);

  assert.equal(audio.analysisCalls, 1);
  assert.equal(provider.get('spotify:track:old')?.mode, 1);
});

test('AudioFeatures: a record from an older synthesis is computed again, real data never is', async () => {
  const storage = new MemoryStorage();
  await storage.saveAudioFeatures([
    { uri: 'spotify:track:stale', features: { bpm: 90, mode: 1, source: 'Spotify Audio Analysis (Synthesized)', synthesisVersion: 1 }, fetchedAt: 1 },
    { uri: 'spotify:track:real', features: { bpm: 90, mode: 1, source: 'Spotify Audio Features' }, fetchedAt: 1 }
  ]);
  const audio = new FakeAudio();
  const provider = new AudioFeatureProvider(storage, audio);
  await provider.init();

  assert.equal(provider.hasHarmonicData('spotify:track:stale'), false);
  assert.equal(provider.hasHarmonicData('spotify:track:real'), true);

  await provider.ensureAnalyzed(['spotify:track:stale', 'spotify:track:real']);
  assert.equal(audio.analysisCalls, 1);
});

test('AudioFeatures: real audio-features are not overwritten by estimates', async () => {
  const audio = new FakeAudio();
  const provider = new AudioFeatureProvider(new MemoryStorage(), audio);

  await provider.ensure(['spotify:track:a']);
  await provider.ensureAnalyzed(['spotify:track:a']);

  const merged = provider.get('spotify:track:a');
  assert.equal(merged?.energy, 0.5);
  assert.equal(merged?.bpm, 120);
  assert.equal(merged?.mode, 1);
  assert.equal(merged?.source, 'Spotify Audio Features');
});

test('AudioFeatures: analysis refused stops at once; a rate limit pauses it, then recovers', async () => {
  const clock = { now: 1000 };
  const audio = new FakeAudio();
  audio.analysisFailure = { status: 429 };
  const provider = new AudioFeatureProvider(new MemoryStorage(), audio, () => clock.now);

  await provider.ensureAnalyzed(['spotify:track:a', 'spotify:track:b', 'spotify:track:c']);
  assert.equal(audio.analysisCalls, 1);
  assert.equal(provider.canAnalyze(), false);

  audio.analysisFailure = null;
  clock.now += 61_000;
  assert.equal(await provider.ensureAnalyzed(['spotify:track:a']), 1);

  audio.analysisFailure = { status: 403 };
  await provider.ensureAnalyzed(['spotify:track:b']);
  clock.now += 10_000_000;
  assert.equal(provider.canAnalyze(), false);
});

test('AudioFeatures: a rate limit backs off, then recovers', async () => {
  const clock = { now: 1000 };
  const audio = new FakeAudio();
  audio.failure = { status: 429 };
  const provider = new AudioFeatureProvider(new MemoryStorage(), audio, () => clock.now);

  await provider.ensure(['spotify:track:a']);
  assert.equal(provider.getDiagnostics().status, 'backing-off');

  await provider.ensure(['spotify:track:a']);
  assert.equal(audio.batches.length, 1);

  audio.failure = null;
  clock.now += 61_000;
  assert.equal(await provider.ensure(['spotify:track:a']), 1);
  assert.equal(provider.getDiagnostics().status, 'available');
});