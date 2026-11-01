import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStorage } from '../src/storage/MemoryStorage.ts';
import { BlacklistManager } from '../src/core/BlacklistManager.ts';
import { GuardianConfig, PredictiveQueueGuardian, QueuePlatformBridge } from '../src/queue/PredictiveQueueGuardian.ts';
import { QueueStateSummary, TrackMetadata } from '../src/types/index.ts';

const FAST: Partial<GuardianConfig> = { skipSettleMs: 1, restoreDelayMs: 1, restoreTimeoutMs: 40, duplicateSkipMs: 0 };

function track(id: string): TrackMetadata {
  return { uri: `spotify:track:${id}`, name: id, artists: [], album: { name: '', uri: '' } };
}

class Player implements QueuePlatformBridge {
  queue: QueueStateSummary = { queued: [], nextUp: [] };
  volume = 0.7;
  volumeLog: number[] = [];
  skips = 0;
  pauses = 0;
  notifications: string[] = [];
  persisted: Array<number | null> = [];
  removable = true;

  getQueueState() {
    return this.queue;
  }
  async removeFromQueue(items: Array<{ uri: string }>) {
    if (!this.removable) return;
    const uris = new Set(items.map((i) => i.uri));
    this.queue.nextUp = this.queue.nextUp.filter((t) => !uris.has(t.uri));
  }
  skipNext() {
    this.skips++;
    this.queue.current = this.queue.nextUp.shift();
  }
  pause() {
    this.pauses++;
  }
  notify(message: string) {
    this.notifications.push(message);
  }
  getCurrentUri() {
    return this.queue.current?.uri ?? null;
  }
  getVolume() {
    return this.volume;
  }
  setVolume(level: number) {
    this.volume = level;
    this.volumeLog.push(level);
  }
  persistMutedVolume(level: number | null) {
    this.persisted.push(level);
  }
}

async function setup(blocked: string[], config: Partial<GuardianConfig> = FAST) {
  const storage = new MemoryStorage();
  for (const id of blocked) {
    await storage.saveRating({ uri: `spotify:track:${id}`, rating: 0, timestamp: 1, metadata: track(id) });
  }
  const player = new Player();
  const guardian = new PredictiveQueueGuardian(new BlacklistManager(storage), player, config);
  return { storage, player, guardian };
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test('Guardian 2.0: a blocked artist in the queue is evicted before it plays', async () => {
  const storage = new MemoryStorage();
  await storage.blockArtist({ artistUri: 'spotify:artist:bad', artistName: 'Bad', timestamp: 1 });
  const player = new Player();
  const guardian = new PredictiveQueueGuardian(new BlacklistManager(storage), player, FAST);

  player.queue = {
    current: track('ok'),
    queued: [],
    nextUp: [{ ...track('x'), artists: [{ name: 'Bad', uri: 'spotify:artist:bad' }] }, track('good')]
  };

  const result = await guardian.inspectAndCleanQueue();

  assert.equal(result.removedCount, 1);
  assert.equal(player.skips, 0);
  assert.deepEqual(player.volumeLog, []);
});

test('Guardian 2.0: a blocked track that became current is muted, skipped and the volume restored', async () => {
  const { player, guardian } = await setup(['bad']);
  player.queue = { current: track('bad'), queued: [], nextUp: [track('good')] };

  await guardian.inspectAndCleanQueue();
  assert.equal(player.volume, 0);
  assert.equal(player.skips, 1);

  await guardian.inspectAndCleanQueue();
  await wait(10);

  assert.equal(player.volume, 0.7);
  assert.deepEqual(player.volumeLog, [0, 0.7]);
  assert.deepEqual(player.persisted, [0.7, null]);
});

test('Guardian 2.0: a chain of blocked tracks restores the original level, not the muted 0', async () => {
  const { player, guardian } = await setup(['b1', 'b2', 'b3', 'b4']);
  player.removable = false;
  player.queue = {
    current: track('b1'),
    queued: [],
    nextUp: [track('b2'), track('b3'), track('b4'), track('good')]
  };

  for (let i = 0; i < 5; i++) {
    await guardian.inspectAndCleanQueue();
  }
  await wait(10);

  assert.equal(player.queue.current?.uri, 'spotify:track:good');
  assert.equal(player.skips, 4);
  assert.equal(player.volume, 0.7);
  assert.deepEqual(player.volumeLog, [0, 0.7]);
});

test('Guardian 2.0: volume returns on its own even if no new track ever arrives', async () => {
  const { player, guardian } = await setup(['bad']);
  player.queue = { current: track('bad'), queued: [], nextUp: [] };

  await guardian.inspectAndCleanQueue();
  assert.equal(player.volume, 0);

  await wait(70);
  assert.equal(player.volume, 0.7);
});

test('Guardian 2.0: the songchange of our own skip restores the volume, not the safety timer', async () => {
  const { player, guardian } = await setup(['bad'], { ...FAST, restoreTimeoutMs: 5000 });
  player.queue = { current: track('bad'), queued: [], nextUp: [track('good')] };

  // Spotify can report the new track while the skip is still being processed
  const skip = player.skipNext.bind(player);
  player.skipNext = () => {
    skip();
    void guardian.inspectAndCleanQueue();
  };

  await guardian.inspectAndCleanQueue();
  await wait(20);

  assert.equal(player.volume, 0.7);
  assert.deepEqual(player.volumeLog, [0, 0.7]);
});

test('Guardian 2.0: a good track between blocked runs resets both breaker counters', async () => {
  const ids = Array.from({ length: 6 }, (_, i) => `b${i}`);
  const { player, guardian } = await setup(ids, { ...FAST, maxConsecutiveBlocked: 5, maxSkipsInWindow: 5, windowMs: 60_000 });
  player.removable = false;

  const runOf = async (slice: string[]) => {
    player.queue = { current: track(slice[0]), queued: [], nextUp: [...slice.slice(1).map(track), track('good')] };
    for (let i = 0; i <= slice.length; i++) await guardian.inspectAndCleanQueue();
  };

  await runOf(ids.slice(0, 3));
  await runOf(ids.slice(3, 6));

  assert.equal(guardian.isCircuitTripped(), false);
  assert.equal(player.pauses, 0);
});

test('Guardian 2.0: a user-muted player stays muted', async () => {
  const { player, guardian } = await setup(['bad']);
  player.volume = 0;
  player.queue = { current: track('bad'), queued: [], nextUp: [track('good')] };

  await guardian.inspectAndCleanQueue();
  await guardian.inspectAndCleanQueue();
  await wait(10);

  assert.deepEqual(player.volumeLog, []);
  assert.equal(player.skips, 1);
});

test('Guardian 2.0: does not skip on top of Trash Bin, which already moved on', async () => {
  const { player, guardian } = await setup(['bad'], { ...FAST, skipSettleMs: 15 });
  player.queue = { current: track('bad'), queued: [], nextUp: [track('good'), track('next')] };

  const inspection = guardian.inspectAndCleanQueue();
  player.skipNext(); // Trash Bin reacting to the same songchange
  await inspection;

  assert.equal(player.skips, 1);
  assert.equal(player.queue.current?.uri, 'spotify:track:good');
});

test('Guardian 2.0: breaker pauses at exactly 10 consecutive blocked tracks, with the volume back', async () => {
  const ids = Array.from({ length: 15 }, (_, i) => `b${i}`);
  const { player, guardian } = await setup(ids);
  player.removable = false;
  player.queue = { current: track(ids[0]), queued: [], nextUp: ids.slice(1).map(track) };

  let inspections = 0;
  while (!guardian.isCircuitTripped() && inspections < 20) {
    await guardian.inspectAndCleanQueue();
    inspections++;
  }

  assert.equal(inspections, 10);
  assert.equal(player.skips, 9);
  assert.equal(player.pauses, 1);
  assert.equal(player.volume, 0.7);
  assert.ok(player.notifications.some((n) => n.includes('10 faixas bloqueadas seguidas')));

  await guardian.inspectAndCleanQueue();
  assert.equal(player.skips, 9);
});

test('Guardian 2.0: nine blocked tracks then a good one do not trip, and the count restarts', async () => {
  const ids = Array.from({ length: 9 }, (_, i) => `b${i}`);
  const { player, guardian } = await setup(ids);
  player.removable = false;
  player.queue = { current: track(ids[0]), queued: [], nextUp: [...ids.slice(1).map(track), track('good')] };

  for (let i = 0; i < 10; i++) {
    await guardian.inspectAndCleanQueue();
  }

  assert.equal(guardian.isCircuitTripped(), false);
  assert.equal(player.queue.current?.uri, 'spotify:track:good');
  assert.equal(player.pauses, 0);
});

test('Guardian 2.0: duplicate triggers of one arrival count once and skip once', async () => {
  const { player, guardian } = await setup(['bad'], { ...FAST, duplicateSkipMs: 500, maxConsecutiveBlocked: 2 });
  player.queue = { current: track('bad'), queued: [], nextUp: [] };

  await guardian.inspectAndCleanQueue();
  await guardian.inspectAndCleanQueue();

  assert.equal(player.skips, 1);
  assert.equal(guardian.isCircuitTripped(), false);
});

test('Guardian 2.0: blocking the current track skips exactly once across rating and shortcut', async () => {
  const { player, guardian } = await setup(['bad'], { ...FAST, duplicateSkipMs: 500 });
  player.queue = { current: track('bad'), queued: [], nextUp: [track('good'), track('next')] };

  await Promise.all([
    guardian.inspectAndCleanQueue(false),
    guardian.skipBlockedCurrent('spotify:track:bad')
  ]);
  await guardian.skipBlockedCurrent('spotify:track:bad');

  assert.equal(player.skips, 1);
  assert.equal(player.queue.current?.uri, 'spotify:track:good');
});

test('Guardian 2.0: an evicted track that returns later is evicted again', async () => {
  const { player, guardian } = await setup(['bad'], { ...FAST, evictionTtlMs: 5 });
  player.queue = { current: track('ok'), queued: [], nextUp: [track('bad')] };

  await guardian.inspectAndCleanQueue();
  player.queue.nextUp = [track('bad')];
  await wait(10);
  const second = await guardian.inspectAndCleanQueue();

  assert.equal(second.removedCount, 1);
});

test('Guardian 2.0: a resumed player gets a fresh breaker', async () => {
  const ids = Array.from({ length: 3 }, (_, i) => `b${i}`);
  const { player, guardian } = await setup(ids, { ...FAST, maxConsecutiveBlocked: 2 });
  player.removable = false;
  player.queue = { current: track(ids[0]), queued: [], nextUp: ids.slice(1).map(track) };

  await guardian.inspectAndCleanQueue();
  await guardian.inspectAndCleanQueue();
  assert.equal(guardian.isCircuitTripped(), true);

  guardian.resetCircuit();
  assert.equal(guardian.isCircuitTripped(), false);
  await guardian.inspectAndCleanQueue();
  assert.equal(player.skips, 2);
});
