import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStorage } from '../src/storage/MemoryStorage.ts';
import { BlacklistManager } from '../src/core/BlacklistManager.ts';
import { TrackMetadata } from '../src/types/index.ts';

test('BlacklistManager: fast check for blocked track and artist', async () => {
  const storage = new MemoryStorage();
  const blacklist = new BlacklistManager(storage);

  await storage.saveRating({
    uri: 'spotify:track:blocked1',
    rating: 0,
    timestamp: Date.now(),
    metadata: { uri: 'spotify:track:blocked1', name: 'Banned', artists: [], album: { name: '', uri: '' } }
  });

  await blacklist.blockArtist('spotify:artist:bad_artist', 'Bad Artist');

  // Direct track block
  assert.equal(blacklist.isBlockedFast('spotify:track:blocked1', []), true);
  // Allowed track
  assert.equal(blacklist.isBlockedFast('spotify:track:good1', []), false);

  // Artist block
  assert.equal(blacklist.isBlockedFast('spotify:track:any', ['spotify:artist:bad_artist']), true);
  assert.equal(blacklist.isBlockedFast('spotify:track:any', ['spotify:artist:other']), false);
});

test('BlacklistManager: version rules for live and remix songs', async () => {
  const storage = new MemoryStorage();
  const blacklist = new BlacklistManager(storage);
  await blacklist.init();

  await blacklist.addVersionRule({
    trackName: 'Creep',
    artistName: 'Radiohead',
    blockAllVersions: false,
    blockLiveVersionsOnly: true,
    blockRemixesOnly: false,
    timestamp: Date.now()
  });

  const studioTrack: TrackMetadata = {
    uri: 'spotify:track:creep_studio',
    name: 'Creep',
    artists: [{ name: 'Radiohead', uri: 'spotify:artist:radiohead' }],
    album: { name: 'Pablo Honey', uri: '' }
  };

  const liveTrack: TrackMetadata = {
    uri: 'spotify:track:creep_live',
    name: 'Creep - Live at Reading',
    artists: [{ name: 'Radiohead', uri: 'spotify:artist:radiohead' }],
    album: { name: 'Live Sessions', uri: '' }
  };

  const studioCheck = await blacklist.isTrackBlocked(studioTrack);
  assert.equal(studioCheck.blocked, false);

  const liveCheck = await blacklist.isTrackBlocked(liveTrack);
  assert.equal(liveCheck.blocked, true);
  assert.ok(liveCheck.reason?.includes('Live version'));
});

test('BlacklistManager: TrashBin import without data corruption', async () => {
  const storage = new MemoryStorage();
  const blacklist = new BlacklistManager(storage);

  const trashSongList = {
    'spotify:track:tb1': true,
    'spotify:track:tb2': true,
    'invalid_uri': true
  };

  const trashArtistList = {
    'spotify:artist:art1': true
  };

  const res = await blacklist.importFromTrashBin(trashSongList, trashArtistList);
  assert.equal(res.importedSongs, 2);
  assert.equal(res.importedArtists, 1);

  assert.equal(blacklist.isBlockedFast('spotify:track:tb1', []), true);
  assert.equal(blacklist.isBlockedFast('spotify:track:tb2', []), true);
  assert.equal(blacklist.isBlockedFast('spotify:track:tb3', []), false);
  assert.equal(blacklist.isBlockedFast('spotify:track:any', ['spotify:artist:art1']), true);
});
