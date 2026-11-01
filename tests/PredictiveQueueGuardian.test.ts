import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStorage } from '../src/storage/MemoryStorage.ts';
import { BlacklistManager } from '../src/core/BlacklistManager.ts';
import { PredictiveQueueGuardian, QueuePlatformBridge } from '../src/queue/PredictiveQueueGuardian.ts';
import { TrackMetadata, QueueStateSummary } from '../src/types/index.ts';

class MockQueueBridge implements QueuePlatformBridge {
  public queueState: QueueStateSummary = { queued: [], nextUp: [] };
  public removedUris: string[] = [];
  public skipCount = 0;
  public pauseCount = 0;
  public notifications: string[] = [];

  getQueueState(): QueueStateSummary | null {
    return this.queueState;
  }

  async removeFromQueue(items: Array<{ uri: string; uid?: string }>): Promise<void> {
    for (const item of items) {
      this.removedUris.push(item.uri);
      this.queueState.nextUp = this.queueState.nextUp.filter((t) => t.uri !== item.uri);
      this.queueState.queued = this.queueState.queued.filter((t) => t.uri !== item.uri);
    }
  }

  skipNext(): void {
    this.skipCount++;
    if (this.queueState.nextUp.length > 0) {
      this.queueState.current = this.queueState.nextUp.shift();
    }
  }

  pause(): void {
    this.pauseCount++;
  }

  notify(message: string): void {
    this.notifications.push(message);
  }
}

test('PredictiveQueueGuardian: proactively evicts blocked tracks before playback', async () => {
  const storage = new MemoryStorage();
  const blacklist = new BlacklistManager(storage);
  const bridge = new MockQueueBridge();
  const guardian = new PredictiveQueueGuardian(blacklist, bridge);

  // Block track2 and track4
  await storage.saveRating({
    uri: 'spotify:track:blocked2',
    rating: 0,
    timestamp: Date.now(),
    metadata: { uri: 'spotify:track:blocked2', name: 'Blocked 2', artists: [], album: { name: '', uri: '' } }
  });
  await storage.saveRating({
    uri: 'spotify:track:blocked4',
    rating: 0,
    timestamp: Date.now(),
    metadata: { uri: 'spotify:track:blocked4', name: 'Blocked 4', artists: [], album: { name: '', uri: '' } }
  });

  bridge.queueState = {
    current: { uri: 'spotify:track:current', name: 'Current', artists: [], album: { name: '', uri: '' } },
    queued: [],
    nextUp: [
      { uri: 'spotify:track:good1', name: 'Good 1', artists: [], album: { name: '', uri: '' } },
      { uri: 'spotify:track:blocked2', name: 'Blocked 2', artists: [], album: { name: '', uri: '' } },
      { uri: 'spotify:track:good3', name: 'Good 3', artists: [], album: { name: '', uri: '' } },
      { uri: 'spotify:track:blocked4', name: 'Blocked 4', artists: [], album: { name: '', uri: '' } }
    ]
  };

  const res = await guardian.inspectAndCleanQueue();
  assert.equal(res.removedCount, 2);
  assert.equal(bridge.removedUris.length, 2);
  assert.deepEqual(bridge.removedUris, ['spotify:track:blocked2', 'spotify:track:blocked4']);

  // Queue now only contains good1 and good3
  assert.equal(bridge.queueState.nextUp.length, 2);
  assert.equal(bridge.queueState.nextUp[0].uri, 'spotify:track:good1');
  assert.equal(bridge.queueState.nextUp[1].uri, 'spotify:track:good3');
});

test('PredictiveQueueGuardian: handles 100 consecutive blocked tracks without infinite loop', async () => {
  const storage = new MemoryStorage();
  const blacklist = new BlacklistManager(storage);
  const bridge = new MockQueueBridge();
  // Configured with high consecutive removal limit for testing batch eviction
  const guardian = new PredictiveQueueGuardian(blacklist, bridge, { maxConsecutiveRemovals: 150 });

  const nextUp: TrackMetadata[] = [];
  for (let i = 1; i <= 100; i++) {
    const uri = `spotify:track:blocked_${i}`;
    await storage.saveRating({
      uri,
      rating: 0,
      timestamp: Date.now(),
      metadata: { uri, name: `Blocked ${i}`, artists: [], album: { name: '', uri: '' } }
    });
    nextUp.push({ uri, name: `Blocked ${i}`, artists: [], album: { name: '', uri: '' } });
  }

  // Add 1 good track at the end
  nextUp.push({ uri: 'spotify:track:final_good', name: 'Final Good', artists: [], album: { name: '', uri: '' } });

  bridge.queueState = {
    current: { uri: 'spotify:track:cur', name: 'Current', artists: [], album: { name: '', uri: '' } },
    queued: [],
    nextUp
  };

  const res = await guardian.inspectAndCleanQueue();
  assert.equal(res.removedCount, 100);
  assert.equal(bridge.removedUris.length, 100);
  assert.equal(bridge.queueState.nextUp.length, 1);
  assert.equal(bridge.queueState.nextUp[0].uri, 'spotify:track:final_good');
  assert.equal(res.circuitBreakerTripped, false);
});

test('PredictiveQueueGuardian: Preserves manually added user queue tracks by default', async () => {
  const storage = new MemoryStorage();
  const blacklist = new BlacklistManager(storage);
  const bridge = new MockQueueBridge();
  const guardian = new PredictiveQueueGuardian(blacklist, bridge);

  // Both tracks are blocked in ratings
  await storage.saveRating({
    uri: 'spotify:track:user_added_blocked',
    rating: 0,
    timestamp: Date.now(),
    metadata: { uri: 'spotify:track:user_added_blocked', name: 'User Added', artists: [], album: { name: '', uri: '' } }
  });
  await storage.saveRating({
    uri: 'spotify:track:context_blocked',
    rating: 0,
    timestamp: Date.now(),
    metadata: { uri: 'spotify:track:context_blocked', name: 'Context Track', artists: [], album: { name: '', uri: '' } }
  });

  bridge.queueState = {
    queued: [{ uri: 'spotify:track:user_added_blocked', uid: 'uid1', name: 'User Added', artists: [], album: { name: '', uri: '' }, is_queued: true }],
    nextUp: [{ uri: 'spotify:track:context_blocked', uid: 'uid2', name: 'Context Track', artists: [], album: { name: '', uri: '' } }]
  };

  // When preserveManualQueued is true, it only removes from nextUp, not queued
  await guardian.inspectAndCleanQueue(true);
  assert.equal(bridge.queueState.queued.length, 1);
  assert.equal(bridge.queueState.queued[0].uri, 'spotify:track:user_added_blocked');
  assert.equal(bridge.queueState.nextUp.length, 0);
});

test('PredictiveQueueGuardian: Circuit breaker trips and pauses when loop threshold is hit', async () => {
  const storage = new MemoryStorage();
  const blacklist = new BlacklistManager(storage);
  const bridge = new MockQueueBridge();
  // Allow max 3 skips in 2000ms
  const guardian = new PredictiveQueueGuardian(blacklist, bridge, {
    maxSkipsInWindow: 3,
    windowMs: 2000
  });

  // Current track is blocked
  await storage.saveRating({
    uri: 'spotify:track:bad_cur',
    rating: 0,
    timestamp: Date.now(),
    metadata: { uri: 'spotify:track:bad_cur', name: 'Bad Cur', artists: [], album: { name: '', uri: '' } }
  });

  bridge.queueState = {
    current: { uri: 'spotify:track:bad_cur', name: 'Bad Cur', artists: [], album: { name: '', uri: '' } },
    queued: [],
    nextUp: []
  };

  // 1st skip
  await guardian.inspectAndCleanQueue();
  // 2nd skip
  await guardian.inspectAndCleanQueue();
  // 3rd skip triggers circuit breaker
  const res = await guardian.inspectAndCleanQueue();

  assert.equal(res.circuitBreakerTripped, true);
  assert.equal(guardian.isCircuitTripped(), true);
  assert.ok(bridge.pauseCount >= 1);
  assert.ok(bridge.notifications.some((n) => n.includes('Proteção contra Loops')));
});

test('PredictiveQueueGuardian: handles 1000 consecutive blocked tracks safely', async () => {
  const storage = new MemoryStorage();
  const blacklist = new BlacklistManager(storage);
  const bridge = new MockQueueBridge();
  const guardian = new PredictiveQueueGuardian(blacklist, bridge, { maxConsecutiveRemovals: 1500 });

  const nextUp: TrackMetadata[] = [];
  for (let i = 1; i <= 1000; i++) {
    const uri = `spotify:track:blocked_large_${i}`;
    await storage.saveRating({
      uri,
      rating: 0,
      timestamp: Date.now(),
      metadata: { uri, name: `Blocked ${i}`, artists: [], album: { name: '', uri: '' } }
    });
    nextUp.push({ uri, name: `Blocked ${i}`, artists: [], album: { name: '', uri: '' } });
  }

  // 1 valid candidate at the end
  nextUp.push({ uri: 'spotify:track:survivor', name: 'Survivor', artists: [], album: { name: '', uri: '' } });

  bridge.queueState = {
    current: { uri: 'spotify:track:cur', name: 'Current', artists: [], album: { name: '', uri: '' } },
    queued: [],
    nextUp
  };

  const res = await guardian.inspectAndCleanQueue();
  assert.equal(res.removedCount, 1000);
  assert.equal(bridge.removedUris.length, 1000);
  assert.equal(bridge.queueState.nextUp.length, 1);
  assert.equal(bridge.queueState.nextUp[0].uri, 'spotify:track:survivor');
  assert.equal(res.circuitBreakerTripped, false);
});

test('PredictiveQueueGuardian: Preserves manually added user queue tracks by default', async () => {
  const storage = new MemoryStorage();
  const blacklist = new BlacklistManager(storage);
  const bridge = new MockQueueBridge();
  const guardian = new PredictiveQueueGuardian(blacklist, bridge);

  // Both tracks are blocked in ratings
  await storage.saveRating({
    uri: 'spotify:track:user_added_blocked',
    rating: 0,
    timestamp: Date.now(),
    metadata: { uri: 'spotify:track:user_added_blocked', name: 'User Added', artists: [], album: { name: '', uri: '' } }
  });
  await storage.saveRating({
    uri: 'spotify:track:context_blocked',
    rating: 0,
    timestamp: Date.now(),
    metadata: { uri: 'spotify:track:context_blocked', name: 'Context Track', artists: [], album: { name: '', uri: '' } }
  });

  bridge.queueState = {
    queued: [{ uri: 'spotify:track:user_added_blocked', uid: 'uid1', name: 'User Added', artists: [], album: { name: '', uri: '' }, is_queued: true }],
    nextUp: [{ uri: 'spotify:track:context_blocked', uid: 'uid2', name: 'Context Track', artists: [], album: { name: '', uri: '' } }]
  };

  // When preserveManualQueued is true, it only removes from nextUp, not queued
  await guardian.inspectAndCleanQueue(true);
  assert.equal(bridge.queueState.queued.length, 1);
  assert.equal(bridge.queueState.queued[0].uri, 'spotify:track:user_added_blocked');
  assert.equal(bridge.queueState.nextUp.length, 0);
});
