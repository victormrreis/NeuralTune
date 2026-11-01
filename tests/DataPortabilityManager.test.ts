import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStorage } from '../src/storage/MemoryStorage.ts';
import { BlacklistManager } from '../src/core/BlacklistManager.ts';
import {
  CSV_COLUMNS,
  CSV_EXPORT_FILENAME,
  DataPortabilityManager,
  JSON_EXPORT_FILENAME,
  KeyValueStore,
  PlaylistBridge,
  SYNC_PLAYLISTS,
  escapeCsvCell,
  starsOf
} from '../src/storage/DataPortabilityManager.ts';
import { PlayEvent, Rating, TrackMetadata, TrackRatingRecord } from '../src/types/index.ts';

function meta(id: string, name: string = id): TrackMetadata {
  return {
    uri: `spotify:track:${id}`,
    name,
    artists: [{ name: `Artist ${id}`, uri: `spotify:artist:${id}` }],
    album: { name: `Album ${id}`, uri: `spotify:album:${id}` }
  };
}

function rating(id: string, value: Rating, timestamp: number = 1000, metadata: TrackMetadata = meta(id)): TrackRatingRecord {
  return { uri: `spotify:track:${id}`, rating: value, timestamp, metadata };
}

function setup(extra: { playlists?: PlaylistBridge; keyValue?: KeyValueStore; resolveTracks?: (u: string[]) => Promise<Map<string, TrackMetadata>> } = {}) {
  const storage = new MemoryStorage();
  const blacklist = new BlacklistManager(storage);
  const manager = new DataPortabilityManager({ storage, blacklist, now: () => Date.UTC(2026, 9, 31), ...extra });
  return { storage, blacklist, manager };
}

function playEvent(id: string, playedMs: number, skipped: boolean, startedAt: number): PlayEvent {
  return {
    id: `${id}@${startedAt}`, uri: `spotify:track:${id}`, name: id, artistUris: [],
    startedAt, endedAt: startedAt, playedMs, skipped
  };
}

/** Parses this exporter's dialect: ';' separated, '"' quoted, CRLF rows, leading BOM. */
function parseCsv(content: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;

  for (let i = 0; i < content.length; i++) {
    const char = content[i];
    if (quoted) {
      if (char === '"' && content[i + 1] === '"') { cell += '"'; i++; }
      else if (char === '"') quoted = false;
      else cell += char;
    } else if (char === '"') quoted = true;
    else if (char === ';') { row.push(cell); cell = ''; }
    else if (char === '\r' && content[i + 1] === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; i++; }
    else cell += char;
  }
  return rows;
}

class FakePlaylists implements PlaylistBridge {
  playlists = new Map<string, { uri: string; items: Array<{ uri: string; uid: string }> }>();
  created: string[] = [];
  addCalls: number[] = [];
  failOn: string | null = null;
  private uid = 0;

  async findPlaylistByName(name: string) {
    if (name === this.failOn) throw new Error('rootlist offline');
    return this.playlists.get(name)?.uri ?? null;
  }
  async createPlaylist(name: string) {
    const uri = `spotify:playlist:${this.playlists.size}`;
    this.playlists.set(name, { uri, items: [] });
    this.created.push(name);
    return uri;
  }
  private byUri(uri: string) {
    return Array.from(this.playlists.values()).find((p) => p.uri === uri)!;
  }
  async getPlaylistItems(uri: string) {
    return [...this.byUri(uri).items];
  }
  async addTracks(uri: string, uris: string[]) {
    this.addCalls.push(uris.length);
    this.byUri(uri).items.push(...uris.map((u) => ({ uri: u, uid: `uid${this.uid++}` })));
  }
  async removeTracks(uri: string, items: Array<{ uri: string; uid: string }>) {
    const playlist = this.byUri(uri);
    const uids = new Set(items.map((i) => i.uid));
    playlist.items = playlist.items.filter((i) => !uids.has(i.uid));
  }
  urisOf(name: string) {
    return this.playlists.get(name)?.items.map((i) => i.uri) ?? [];
  }
}

function memoryKeyValue(initial: Record<string, string> = {}): KeyValueStore & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial));
  return { data, get: (k) => data.get(k) ?? null, set: (k, v) => void data.set(k, v) };
}

test('JSON export: full versioned snapshot with ratings, history, skips and blacklist', async () => {
  const { storage, manager } = setup();
  for (let value = 0; value <= 5; value++) {
    await storage.saveRating(rating(`t${value}`, value as Rating, 1000 + value));
  }
  await storage.blockArtist({ artistUri: 'spotify:artist:bad', artistName: 'Bad', timestamp: 5 });
  await storage.saveVersionRule({ trackName: 'X', artistName: 'Y', blockAllVersions: true, blockLiveVersionsOnly: false, blockRemixesOnly: false, timestamp: 1 });
  await storage.savePlayEvent(playEvent('t5', 180_000, false, 2000));
  await storage.savePlayEvent(playEvent('t5', 3_000, true, 3000));

  const file = await manager.exportJson();
  const data = JSON.parse(file.content);

  assert.equal(file.filename, JSON_EXPORT_FILENAME);
  assert.equal(file.filename, 'neuraltune_v2_export.json');
  assert.equal(data.schema, 'neuraltune.export');
  assert.equal(data.schemaVersion, 2);
  assert.equal(data.exportedAt, '2026-10-31T00:00:00.000Z');
  assert.equal(data.ratings.length, 6);
  assert.deepEqual(data.ratings.map((r: TrackRatingRecord) => r.rating).sort(), [0, 1, 2, 3, 4, 5]);
  assert.deepEqual(data.blockedTrackUris, ['spotify:track:t0']);
  assert.equal(data.blockedArtists[0].artistUri, 'spotify:artist:bad');
  assert.equal(data.versionRules.length, 1);
  assert.equal(data.playEvents.length, 2);
  assert.deepEqual(data.counts, { ratings: 6, blockedTracks: 1, blockedArtists: 1, playEvents: 2, radioExposures: 0 });
  assert.deepEqual(
    data.trackStats.find((s: { uri: string }) => s.uri === 'spotify:track:t5'),
    { uri: 'spotify:track:t5', plays: 1, skips: 1, lastPlayedAt: 3000 }
  );
});

test('CSV export: exact columns, one row per rating, newest first', async () => {
  const { storage, blacklist, manager } = setup();
  await storage.saveRating(rating('old', 4, Date.UTC(2026, 0, 2, 12)));
  await storage.saveRating(rating('new', 0, Date.UTC(2026, 5, 2, 12)));
  await storage.savePlayEvent(playEvent('old', 60_000, false, 10));
  await storage.savePlayEvent(playEvent('old', 60_000, false, 20));
  await storage.savePlayEvent(playEvent('old', 1_000, true, 30));
  assert.equal(blacklist.isBlockedFast('spotify:track:new', []), true);

  const file = await manager.exportCsv();
  assert.equal(file.filename, CSV_EXPORT_FILENAME);
  assert.ok(file.content.startsWith('﻿'));

  const [header, first, second] = parseCsv(file.content.slice(1));
  assert.deepEqual(header, [...CSV_COLUMNS]);
  assert.deepEqual(header, [
    'URI do Spotify', 'Nome da Música', 'Artistas', 'Álbum', 'Nota (0 a 5)',
    'Estrelas', 'Data de Avaliação', 'Total de Reproduções', 'Bloqueada (Sim/Não)'
  ]);

  assert.equal(first[0], 'spotify:track:new');
  assert.equal(first[4], '0');
  assert.equal(first[5], '☆☆☆☆☆');
  assert.equal(first[8], 'Sim');

  assert.equal(second[1], 'old');
  assert.equal(second[2], 'Artist old');
  assert.equal(second[3], 'Album old');
  assert.equal(second[5], '★★★★☆');
  assert.match(second[6], /^2026-01-02 \d{2}:00:00$/);
  assert.equal(second[7], '2');
  assert.equal(second[8], 'Não');
});

test('CSV export: a track of a blocked artist reads as blocked even with a good rating', async () => {
  const { storage, manager } = setup();
  await storage.saveRating(rating('a', 5));
  await storage.blockArtist({ artistUri: 'spotify:artist:a', artistName: 'A', timestamp: 1 });

  const [, row] = parseCsv((await manager.exportCsv()).content.slice(1));
  assert.equal(row[8], 'Sim');
});

test('CSV export: delimiters, quotes, line breaks and accents round-trip', async () => {
  const { storage, manager } = setup();
  const tricky = 'Coração; "Vivo"\nparte 2';
  await storage.saveRating(rating('a', 3, 1000, meta('a', tricky)));

  const [, row] = parseCsv((await manager.exportCsv()).content.slice(1));
  assert.equal(row.length, CSV_COLUMNS.length);
  assert.equal(row[1], tricky);
});

test('CSV export: cells cannot run as spreadsheet formulas', () => {
  assert.equal(escapeCsvCell('=HYPERLINK("http://x")'), `"'=HYPERLINK(""http://x"")"`);
  assert.equal(escapeCsvCell('+44'), "'+44");
  assert.equal(escapeCsvCell('-1'), "'-1");
  assert.equal(escapeCsvCell('@user'), "'@user");
  assert.equal(escapeCsvCell('Normal'), 'Normal');
  assert.equal(escapeCsvCell(5), '5');
});

test('CSV export: empty database still produces a valid header', async () => {
  const { manager } = setup();
  const rows = parseCsv((await manager.exportCsv()).content.slice(1));
  assert.equal(rows.length, 1);
});

test('starsOf: covers the whole scale', () => {
  assert.equal(starsOf(0), '☆☆☆☆☆');
  assert.equal(starsOf(3), '★★★☆☆');
  assert.equal(starsOf(5), '★★★★★');
});

test('Export: placeholder metadata is resolved and persisted before writing', async () => {
  const resolved = meta('ghost', 'Resolved Name');
  const { storage, manager } = setup({ resolveTracks: async () => new Map([[resolved.uri, resolved]]) });
  await storage.saveRating(rating('ghost', 0, 1000, {
    uri: 'spotify:track:ghost', name: 'Imported from TrashBin', artists: [], album: { name: '', uri: '' }
  }));

  const [, row] = parseCsv((await manager.exportCsv()).content.slice(1));
  assert.equal(row[1], 'Resolved Name');
  assert.equal((await storage.getRating('spotify:track:ghost'))?.metadata.name, 'Resolved Name');
  assert.equal((await storage.getRating('spotify:track:ghost'))?.rating, 0);
});

test('Export: a failing metadata lookup does not fail the export', async () => {
  const { storage, manager } = setup({ resolveTracks: async () => { throw new Error('429'); } });
  await storage.saveRating(rating('ghost', 0, 1000, {
    uri: 'spotify:track:ghost', name: 'Faixa', artists: [], album: { name: '', uri: '' }
  }));

  assert.equal(parseCsv((await manager.exportCsv()).content.slice(1)).length, 2);
});

test('Round trip: importing an export into an empty database reproduces it', async () => {
  const source = setup();
  await source.storage.saveRating(rating('a', 5, 111));
  await source.storage.saveRating(rating('b', 0, 222));
  await source.storage.blockArtist({ artistUri: 'spotify:artist:bad', artistName: 'Bad', timestamp: 5 });
  await source.storage.saveVersionRule({ trackName: 'X', artistName: 'Y', blockAllVersions: true, blockLiveVersionsOnly: false, blockRemixesOnly: false, timestamp: 1 });
  await source.storage.saveComparativeFeedback({ id: 'f1', winnerUri: 'w', loserUri: 'l', timestamp: 3 });
  await source.storage.savePlayEvent(playEvent('a', 60_000, false, 10));

  const target = setup();
  const report = await target.manager.importJson((await source.manager.exportJson()).content);

  assert.equal(report.addedRatings, 2);
  assert.equal(report.addedArtists, 1);
  assert.equal(report.addedVersionRules, 1);
  assert.equal(report.addedFeedback, 1);
  assert.equal(report.addedPlayEvents, 1);
  assert.equal(report.invalidRecords, 0);

  assert.equal((await target.storage.getRating('spotify:track:a'))?.timestamp, 111);
  assert.equal(target.storage.isTrackBlocked('spotify:track:b'), true);
  assert.equal(target.storage.isArtistUriBlocked('spotify:artist:bad'), true);

  const again = await target.manager.importJson((await source.manager.exportJson()).content);
  assert.equal(again.addedRatings + again.addedArtists + again.addedVersionRules + again.addedFeedback + again.addedPlayEvents, 0);
  assert.equal(again.conflicts, 0);
  assert.equal((await target.storage.getAllPlayEvents()).length, 1);
});

test('Import merge: "highest" keeps the larger rating whichever side has it', async () => {
  const { storage, manager } = setup();
  await storage.saveRating(rating('localHigher', 5, 100));
  await storage.saveRating(rating('fileHigher', 2, 100));

  const report = await manager.importJson(JSON.stringify({
    schemaVersion: 2,
    ratings: [rating('localHigher', 1, 999), rating('fileHigher', 4, 50)]
  }));

  assert.equal((await storage.getRating('spotify:track:localHigher'))?.rating, 5);
  assert.equal((await storage.getRating('spotify:track:fileHigher'))?.rating, 4);
  assert.equal(report.conflicts, 2);
  assert.equal(report.keptLocal, 1);
  assert.equal(report.replacedRatings, 1);
});

test('Import merge: "highest" keeps a local block and reports it', async () => {
  const { storage, manager } = setup();
  await storage.saveRating(rating('a', 0, 100));

  const report = await manager.importJson(JSON.stringify({ schemaVersion: 2, ratings: [rating('a', 3, 50)] }));

  assert.equal(report.unblockedByMerge, 0);
  assert.equal(report.keptBlocks, 1);
  assert.equal(storage.isTrackBlocked('spotify:track:a'), true);
});

test('Import merge: "replace" lifts a local block and reports it', async () => {
  const { storage, manager } = setup();
  await storage.saveRating(rating('a', 0, 100));

  const report = await manager.importJson(JSON.stringify({ schemaVersion: 2, ratings: [rating('a', 3, 50)] }), { strategy: 'replace' });

  assert.equal(report.unblockedByMerge, 1);
  assert.equal(storage.isTrackBlocked('spotify:track:a'), false);
});

test('Import merge: "newest" follows the timestamps', async () => {
  const { storage, manager } = setup();
  await storage.saveRating(rating('old', 5, 100));
  await storage.saveRating(rating('recent', 2, 900));

  await manager.importJson(
    JSON.stringify({ schemaVersion: 2, ratings: [rating('old', 1, 500), rating('recent', 5, 500)] }),
    { strategy: 'newest' }
  );

  assert.equal((await storage.getRating('spotify:track:old'))?.rating, 1);
  assert.equal((await storage.getRating('spotify:track:recent'))?.rating, 2);
});

test('Import merge: "ask" delegates each conflict and honors the answer', async () => {
  const { storage, manager } = setup();
  await storage.saveRating(rating('a', 5, 100));
  await storage.saveRating(rating('b', 5, 100));
  const asked: string[] = [];

  await manager.importJson(
    JSON.stringify({ schemaVersion: 2, ratings: [rating('a', 1, 500), rating('b', 1, 500)] }),
    {
      strategy: 'ask',
      resolveConflict: async (conflict) => {
        asked.push(conflict.uri);
        return conflict.uri.endsWith(':a') ? 'imported' : 'local';
      }
    }
  );

  assert.equal(asked.length, 2);
  assert.equal((await storage.getRating('spotify:track:a'))?.rating, 1);
  assert.equal((await storage.getRating('spotify:track:b'))?.rating, 5);
});

test('Import merge: the surviving rating inherits metadata only the other side had', async () => {
  const { storage, manager } = setup();
  await storage.saveRating(rating('a', 5, 100, {
    uri: 'spotify:track:a', name: 'Faixa', artists: [], album: { name: '', uri: '' }
  }));
  const withFeatures = { ...meta('a', 'Real Name'), acousticFeatures: { energy: 0.5 } };

  await manager.importJson(JSON.stringify({ schemaVersion: 2, ratings: [rating('a', 2, 500, withFeatures)] }));

  const merged = await storage.getRating('spotify:track:a');
  assert.equal(merged?.rating, 5);
  assert.equal(merged?.metadata.name, 'Real Name');
  assert.equal(merged?.metadata.acousticFeatures?.energy, 0.5);
});

test('Import: reads backups written by v1', async () => {
  const { storage, manager } = setup();
  const report = await manager.importJson(JSON.stringify({
    version: 1,
    exportedAt: 123,
    ratings: [rating('a', 4)],
    blockedArtists: [],
    versionRules: [],
    comparativeFeedbacks: [],
    profiles: []
  }));

  assert.equal(report.addedRatings, 1);
  assert.equal((await storage.getRating('spotify:track:a'))?.rating, 4);
});

test('Import: rejects files that are not exports, and future schema versions', async () => {
  const { manager } = setup();
  await assert.rejects(manager.importJson('{not json'), /JSON válido/);
  await assert.rejects(manager.importJson('[]'), /exportação do NeuralTune/);
  await assert.rejects(manager.importJson('{"ratings": []}'), /não suportada/);
  await assert.rejects(manager.importJson('{"schemaVersion": 3, "ratings": []}'), /não suportada/);
});

test('Import: malformed records are counted and skipped, unknown fields are dropped', async () => {
  const { storage, manager } = setup();
  const report = await manager.importJson(JSON.stringify({
    schemaVersion: 2,
    ratings: [
      { ...rating('good', 4), injected: true, metadata: { ...meta('good'), evil: '<script>' } },
      { uri: 'spotify:track:range', rating: 9, timestamp: 1 },
      { uri: 'spotify:track:fraction', rating: 2.5, timestamp: 1 },
      { uri: 'javascript:alert(1)', rating: 3, timestamp: 1 },
      { rating: 3, timestamp: 1 },
      null,
      'garbage'
    ]
  }));

  assert.equal(report.addedRatings, 1);
  assert.equal(report.invalidRecords, 6);

  const stored = await storage.getRating('spotify:track:good') as unknown as Record<string, unknown>;
  assert.equal('injected' in stored, false);
  assert.equal('evil' in (stored.metadata as object), false);
});

test('Import: a file with a BOM is accepted', async () => {
  const { manager } = setup();
  const report = await manager.importJson(`﻿${JSON.stringify({ schemaVersion: 2, ratings: [] })}`);
  assert.equal(report.addedRatings, 0);
});

test('Playlists: creates the three dedicated playlists with the right tracks', async () => {
  const playlists = new FakePlaylists();
  const { storage, manager } = setup({ playlists });
  await storage.saveRating(rating('gold', 5));
  await storage.saveRating(rating('fav', 4));
  await storage.saveRating(rating('trash', 0));
  await storage.saveRating(rating('meh', 3));

  const results = await manager.syncPlaylists();

  assert.deepEqual(SYNC_PLAYLISTS.map((p) => p.name), [
    'NeuralTune — Ouro Puro (★★★★★)',
    'NeuralTune — Favoritas (★★★★☆)',
    'NeuralTune — Blacklist & Lixeira (0★)'
  ]);
  assert.equal(results.length, 3);
  assert.ok(results.every((r) => r.created && !r.error));
  assert.deepEqual(playlists.urisOf(SYNC_PLAYLISTS[0].name), ['spotify:track:gold']);
  assert.deepEqual(playlists.urisOf(SYNC_PLAYLISTS[1].name), ['spotify:track:fav']);
  assert.deepEqual(playlists.urisOf(SYNC_PLAYLISTS[2].name), ['spotify:track:trash']);
});

test('Playlists: a second sync reuses playlists and only applies the difference', async () => {
  const playlists = new FakePlaylists();
  const { storage, manager } = setup({ playlists });
  await storage.saveRating(rating('a', 5));
  await storage.saveRating(rating('b', 5));
  await manager.syncPlaylists();

  await storage.saveRating(rating('b', 4));
  await storage.saveRating(rating('c', 5));
  const created = playlists.created.length;
  const [gold, favorites] = await manager.syncPlaylists();

  assert.equal(gold.created, false);
  assert.equal(gold.added, 1);
  assert.equal(gold.removed, 1);
  assert.deepEqual(playlists.urisOf(SYNC_PLAYLISTS[0].name).sort(), ['spotify:track:a', 'spotify:track:c']);
  assert.equal(favorites.created, true);
  assert.equal(playlists.created.length, created + 1);

  const [unchanged] = await manager.syncPlaylists();
  assert.equal(unchanged.added + unchanged.removed, 0);
});

test('Playlists: removes duplicates, skips empty playlists, ignores non-track URIs', async () => {
  const playlists = new FakePlaylists();
  const { storage, manager } = setup({ playlists });
  await storage.saveRating(rating('a', 5));
  await storage.saveRating({ ...rating('x', 5), uri: 'spotify:local:x' });
  await playlists.createPlaylist(SYNC_PLAYLISTS[0].name);
  await playlists.addTracks('spotify:playlist:0', ['spotify:track:a', 'spotify:track:a']);
  playlists.created = [];

  await manager.syncPlaylists();

  assert.deepEqual(playlists.urisOf(SYNC_PLAYLISTS[0].name), ['spotify:track:a']);
  assert.deepEqual(playlists.created, []);
});

test('Playlists: batches large additions at 100', async () => {
  const playlists = new FakePlaylists();
  const { storage, manager } = setup({ playlists });
  for (let i = 0; i < 250; i++) await storage.saveRating(rating(`t${i}`, 5));

  await manager.syncPlaylists();

  assert.deepEqual(playlists.addCalls, [100, 100, 50]);
});

test('Playlists: one failure is reported and does not stop the others', async () => {
  const playlists = new FakePlaylists();
  playlists.failOn = SYNC_PLAYLISTS[0].name;
  const { storage, manager } = setup({ playlists });
  await storage.saveRating(rating('a', 5));
  await storage.saveRating(rating('b', 4));

  const results = await manager.syncPlaylists();

  assert.match(results[0].error ?? '', /rootlist offline/);
  assert.deepEqual(playlists.urisOf(SYNC_PLAYLISTS[1].name), ['spotify:track:b']);
});

test('Playlists: refuses to run without a bridge', async () => {
  const { manager } = setup();
  await assert.rejects(manager.syncPlaylists(), /indisponível/);
});

test('Trash Bin: migrates songs and artists, keeping metadata of tracks already rated', async () => {
  const keyValue = memoryKeyValue({
    TrashSongList: JSON.stringify({ 'spotify:track:rated': true, 'spotify:track:new': true }),
    TrashArtistList: JSON.stringify({ 'spotify:artist:bad': true })
  });
  const { storage, manager } = setup({ keyValue });
  await storage.saveRating(rating('rated', 4, 100, meta('rated', 'Known Name')));

  const result = await manager.syncTrashBin();

  assert.deepEqual(result, { importedSongs: 2, importedArtists: 1 });
  const rated = await storage.getRating('spotify:track:rated');
  assert.equal(rated?.rating, 0);
  assert.equal(rated?.metadata.name, 'Known Name');
  assert.equal(storage.isArtistUriBlocked('spotify:artist:bad'), true);
});

test('Trash Bin: continuous sync imports only what is new', async () => {
  const keyValue = memoryKeyValue({ TrashSongList: JSON.stringify({ 'spotify:track:a': true }) });
  const { storage, manager } = setup({ keyValue });

  await manager.syncTrashBin();
  assert.deepEqual(await manager.syncTrashBin(), { importedSongs: 0, importedArtists: 0 });

  keyValue.data.set('TrashSongList', JSON.stringify({ 'spotify:track:a': true, 'spotify:track:b': true }));
  assert.equal((await manager.syncTrashBin()).importedSongs, 1);
  assert.equal(storage.isTrackBlocked('spotify:track:b'), true);
});

test('Trash Bin: a track unblocked here is not re-blocked by the next sync', async () => {
  const keyValue = memoryKeyValue({ TrashSongList: JSON.stringify({ 'spotify:track:a': true }) });
  const { storage, manager } = setup({ keyValue });

  await manager.syncTrashBin();
  await storage.deleteRating('spotify:track:a');

  keyValue.data.set('TrashSongList', JSON.stringify({ 'spotify:track:a': true, 'spotify:track:b': true }));
  await manager.syncTrashBin();

  assert.equal(storage.isTrackBlocked('spotify:track:a'), false);
  assert.equal(storage.isTrackBlocked('spotify:track:b'), true);
});

test('Trash Bin: sync survives a new manager instance, and force re-imports everything', async () => {
  const keyValue = memoryKeyValue({ TrashSongList: JSON.stringify({ 'spotify:track:a': true }) });
  const first = setup({ keyValue });
  await first.manager.syncTrashBin();

  const storage = first.storage;
  await storage.deleteRating('spotify:track:a');

  const restarted = new DataPortabilityManager({ storage, blacklist: first.blacklist, keyValue });
  assert.equal((await restarted.syncTrashBin()).importedSongs, 0);
  assert.equal((await restarted.syncTrashBin(true)).importedSongs, 1);
});

test('Trash Bin: corrupt or absent lists are harmless, and entries set to false are ignored', async () => {
  const keyValue = memoryKeyValue({
    TrashSongList: '{broken',
    TrashArtistList: JSON.stringify({ 'spotify:artist:ok': false })
  });
  const { storage, manager } = setup({ keyValue });

  assert.deepEqual(await manager.syncTrashBin(), { importedSongs: 0, importedArtists: 0 });
  assert.equal(storage.isArtistUriBlocked('spotify:artist:ok'), false);
  assert.deepEqual(await setup().manager.syncTrashBin(), { importedSongs: 0, importedArtists: 0 });
});
