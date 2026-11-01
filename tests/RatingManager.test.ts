import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStorage } from '../src/storage/MemoryStorage.ts';
import { RatingManager } from '../src/core/RatingManager.ts';
import { TrackMetadata } from '../src/types/index.ts';

test('RatingManager: should rate a track 0-5 stars and persist it', async () => {
  const storage = new MemoryStorage();
  const manager = new RatingManager(storage);

  const track: TrackMetadata = {
    uri: 'spotify:track:test1',
    name: 'Song One',
    artists: [{ name: 'Artist A', uri: 'spotify:artist:a' }],
    album: { name: 'Album A', uri: 'spotify:album:a' }
  };

  const record = await manager.rateTrack(track, 5);
  assert.equal(record.rating, 5);
  assert.equal(record.uri, 'spotify:track:test1');

  const retrieved = await manager.getRating('spotify:track:test1');
  assert.ok(retrieved);
  assert.equal(retrieved.rating, 5);
});

test('RatingManager: rating 0 should mark track as blocked', async () => {
  const storage = new MemoryStorage();
  const manager = new RatingManager(storage);

  const track: TrackMetadata = {
    uri: 'spotify:track:bad1',
    name: 'Bad Song',
    artists: [{ name: 'Artist B', uri: 'spotify:artist:b' }],
    album: { name: 'Album B', uri: 'spotify:album:b' }
  };

  await manager.rateTrack(track, 0);
  assert.equal(storage.isTrackBlocked('spotify:track:bad1'), true);

  // Changing rating to 4 unblocks it
  await manager.rateTrack(track, 4);
  assert.equal(storage.isTrackBlocked('spotify:track:bad1'), false);
});

test('RatingManager: undo and redo should restore previous ratings correctly', async () => {
  const storage = new MemoryStorage();
  const manager = new RatingManager(storage);

  const track: TrackMetadata = {
    uri: 'spotify:track:undo_test',
    name: 'Undo Song',
    artists: [],
    album: { name: '', uri: '' }
  };

  await manager.rateTrack(track, 2);
  let cur = await manager.getRating(track.uri);
  assert.equal(cur?.rating, 2);

  await manager.rateTrack(track, 5);
  cur = await manager.getRating(track.uri);
  assert.equal(cur?.rating, 5);

  // Undo should revert to rating 2
  const undone = await manager.undo();
  assert.equal(undone, true);
  cur = await manager.getRating(track.uri);
  assert.equal(cur?.rating, 2);

  // Redo should restore rating 5
  const redone = await manager.redo();
  assert.equal(redone, true);
  cur = await manager.getRating(track.uri);
  assert.equal(cur?.rating, 5);
});

test('RatingManager: distribution calculation', async () => {
  const storage = new MemoryStorage();
  const manager = new RatingManager(storage);

  const makeTrack = (uri: string) => ({ uri, name: uri, artists: [], album: { name: '', uri: '' } });

  await manager.rateTrack(makeTrack('t1'), 5);
  await manager.rateTrack(makeTrack('t2'), 5);
  await manager.rateTrack(makeTrack('t3'), 4);
  await manager.rateTrack(makeTrack('t4'), 0);

  const dist = await manager.getRatingsDistribution();
  assert.equal(dist[5], 2);
  assert.equal(dist[4], 1);
  assert.equal(dist[0], 1);
  assert.equal(dist[1], 0);
});
