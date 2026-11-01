import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStorage } from '../src/storage/MemoryStorage.ts';
import { BlacklistManager } from '../src/core/BlacklistManager.ts';
import { PreferenceEngine } from '../src/core/PreferenceEngine.ts';
import { SmartPlaybackEngine, SmartPlaybackBridge } from '../src/queue/SmartPlaybackEngine.ts';
import { TrackMetadata } from '../src/types/index.ts';

class MockSmartBridge implements SmartPlaybackBridge {
  public playedUris: string[] = [];
  public queuedUris: string[] = [];
  public notifications: string[] = [];

  async playTrack(uri: string): Promise<void> {
    this.playedUris.push(uri);
  }

  async addToQueue(tracks: Array<{ uri: string }>): Promise<void> {
    for (const t of tracks) {
      this.queuedUris.push(t.uri);
    }
  }

  notify(message: string): void {
    this.notifications.push(message);
  }
}

test('SmartPlaybackEngine: prepares sequence with 0 blocked tracks and starts playback', async () => {
  const storage = new MemoryStorage();
  const blacklist = new BlacklistManager(storage);
  const preference = new PreferenceEngine(storage);
  await preference.init();
  const bridge = new MockSmartBridge();
  const engine = new SmartPlaybackEngine(blacklist, preference, bridge);

  // Block 5 tracks
  for (let i = 1; i <= 5; i++) {
    await storage.saveRating({
      uri: `spotify:track:blocked_${i}`,
      rating: 0,
      timestamp: Date.now(),
      metadata: { uri: `spotify:track:blocked_${i}`, name: `Bad ${i}`, artists: [], album: { name: '', uri: '' } }
    });
  }

  // Create pool of 10 tracks (5 blocked, 5 good)
  const pool: TrackMetadata[] = [];
  for (let i = 1; i <= 5; i++) {
    pool.push({ uri: `spotify:track:blocked_${i}`, name: `Bad ${i}`, artists: [], album: { name: '', uri: '' } });
  }
  for (let i = 1; i <= 5; i++) {
    pool.push({
      uri: `spotify:track:good_${i}`,
      name: `Good ${i}`,
      artists: [{ name: `Artist ${i}`, uri: `spotify:artist:${i}` }],
      album: { name: 'Album', uri: '' }
    });
  }

  const { eligibleTracks, discardedCount } = engine.prepareSequence(pool);

  assert.equal(discardedCount, 5);
  assert.equal(eligibleTracks.length, 5);
  // Ensure NONE of the eligible tracks is blocked
  for (const t of eligibleTracks) {
    assert.equal(t.uri.startsWith('spotify:track:good_'), true);
  }

  // Start playback
  await engine.startPlayback(eligibleTracks);
  assert.equal(bridge.playedUris.length, 1);
  assert.equal(bridge.playedUris[0], 'spotify:track:good_1');
  assert.equal(bridge.queuedUris.length, 4);
});

test('SmartPlaybackEngine: anti-fatigue separation avoids consecutive songs by same artist', () => {
  const storage = new MemoryStorage();
  const blacklist = new BlacklistManager(storage);
  const preference = new PreferenceEngine(storage);
  const bridge = new MockSmartBridge();
  const engine = new SmartPlaybackEngine(blacklist, preference, bridge);

  const pool: TrackMetadata[] = [
    { uri: 't1', name: 'Song 1', artists: [{ name: 'Artist A', uri: 'art_a' }], album: { name: '', uri: '' } },
    { uri: 't2', name: 'Song 2', artists: [{ name: 'Artist A', uri: 'art_a' }], album: { name: '', uri: '' } },
    { uri: 't3', name: 'Song 3', artists: [{ name: 'Artist B', uri: 'art_b' }], album: { name: '', uri: '' } },
    { uri: 't4', name: 'Song 4', artists: [{ name: 'Artist B', uri: 'art_b' }], album: { name: '', uri: '' } }
  ];

  const { eligibleTracks } = engine.prepareSequence(pool);
  assert.equal(eligibleTracks.length, 4);

  // Check that adjacent tracks do not share the exact same artist
  for (let i = 0; i < eligibleTracks.length - 1; i++) {
    const curArtist = eligibleTracks[i].artists[0].uri;
    const nextArtist = eligibleTracks[i + 1].artists[0].uri;
    assert.notEqual(curArtist, nextArtist);
  }
});
