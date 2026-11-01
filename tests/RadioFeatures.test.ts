import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStorage } from '../src/storage/MemoryStorage.ts';
import { BlacklistManager } from '../src/core/BlacklistManager.ts';
import { DataPortabilityManager } from '../src/storage/DataPortabilityManager.ts';
import { PlaybackHistoryTracker } from '../src/core/PlaybackHistoryTracker.ts';
import { ExplainabilityEngine } from '../src/explainability/ExplainabilityEngine.ts';
import { RadioSession, RadioSessionBridge } from '../src/radios/RadioSession.ts';
import { AutoBackup, BackupFolder } from '../src/storage/AutoBackup.ts';
import { pickWeeklyDiscoveries } from '../src/radios/WeeklyDiscoveries.ts';
import { buildExposures, summarizeOutcomes } from '../src/evaluation/RadioOutcomes.ts';
import { AcousticFeatures, PlayEvent, PredictionResult, TrackMetadata } from '../src/types/index.ts';

const NOW = 1_700_000_000_000;
const DAY = 24 * 3_600_000;
const LOUD: AcousticFeatures = { energy: 0.95, valence: 0.8, danceability: 0.9, bpm: 170 };
const QUIET: AcousticFeatures = { energy: 0.1, valence: 0.2, danceability: 0.2, bpm: 65 };

function track(id: string, artist = `a-${id}`, acousticFeatures?: AcousticFeatures): TrackMetadata {
  return { uri: `spotify:track:${id}`, name: id, artists: [{ name: artist, uri: `spotify:artist:${artist}` }], album: { name: '', uri: '' }, acousticFeatures };
}

function skip(t: TrackMetadata): PlayEvent {
  return { id: t.uri, uri: t.uri, name: t.name, artistUris: t.artists.map((a) => a.uri), startedAt: NOW, endedAt: NOW + 5000, playedMs: 5000, durationMs: 200_000, skipped: true };
}

function sessionWorld(overrides: Partial<RadioSessionBridge> = {}) {
  const log = { added: [] as string[][], set: [] as string[][], sent: [] as string[], replenished: 0 };
  const state: { current?: TrackMetadata; queued: TrackMetadata[]; nextUp: TrackMetadata[] } = { queued: [], nextUp: [] };
  const bridge: RadioSessionBridge = {
    getQueueState: () => ({ current: state.current, queued: state.queued, nextUp: state.nextUp }),
    async addToQueue(tracks) { log.added.push(tracks.map((t) => t.name)); state.queued.push(...tracks); },
    async setQueue(tracks) { log.set.push(tracks.map((t) => t.name)); state.queued = [...tracks]; },
    filterAllowed: async (tracks) => tracks,
    async replenish() { log.replenished++; return []; },
    async onSent(tracks) { log.sent.push(...tracks.map((t) => t.name)); },
    ...overrides
  };
  return { session: new RadioSession(bridge), state, log };
}

function radio(size: number) {
  return Array.from({ length: size }, (_, i) => track(`t${i}`));
}

test('RadioSession: repõe a fila com as faixas que ficaram de fora, em lotes, na ordem do ranker', async () => {
  const { session, state, log } = sessionWorld();
  const tracks = radio(30);
  session.start(tracks, 16);
  state.current = tracks[0];

  assert.equal(await session.tick(), 5);
  assert.deepEqual(log.added[0], ['t16', 't17', 't18', 't19', 't20']);
  assert.deepEqual(log.sent, log.added[0]);
});

test('RadioSession: com fila cheia não mexe em nada', async () => {
  const { session, state, log } = sessionWorld();
  const tracks = radio(30);
  session.start(tracks, 16);
  state.current = tracks[0];
  state.queued = tracks.slice(1, 5);

  assert.equal(await session.tick(), 0);
  assert.equal(log.added.length, 0);
});

test('RadioSession: acabando a seleção, pede mais da mesma rádio sem repetir', async () => {
  const fresh = [track('t2'), track('n1'), track('n2'), track('n3')];
  let excluded: ReadonlySet<string> = new Set();
  const { session, state, log } = sessionWorld({
    async replenish(seen) { excluded = seen; return fresh; }
  });
  const tracks = radio(4);
  session.start(tracks, 4);
  state.current = tracks[0];

  await session.tick();

  assert.equal(excluded.has('spotify:track:t2'), true);
  assert.deepEqual(log.added[0], ['n1', 'n2', 'n3']);
});

test('RadioSession: sem mais faixas para pedir, não insiste', async () => {
  const { session, state, log } = sessionWorld();
  const tracks = radio(2);
  session.start(tracks, 2);
  state.current = tracks[0];

  await session.tick();
  await session.tick();
  assert.equal(log.replenished, 1);
});

test('RadioSession: faixa avaliada ou curtida depois do início não entra', async () => {
  const { session, state, log } = sessionWorld({
    filterAllowed: async (tracks) => tracks.filter((t) => t.name !== 't17')
  });
  const tracks = radio(30);
  session.start(tracks, 16);
  state.current = tracks[0];

  await session.tick();
  assert.deepEqual(log.added[0], ['t16', 't18', 't19', 't20', 't21']);
});

test('RadioSession: tocar algo de fora encerra a rádio e nada mais é adicionado', async () => {
  const { session, state, log } = sessionWorld();
  const tracks = radio(30);
  session.start(tracks, 16);
  state.current = track('escolhida-por-voce');

  assert.equal(await session.tick(), 0);
  assert.equal(session.isActive(), false);
  assert.equal(log.added.length, 0);
});

test('RadioSession: tem um teto para não tocar indefinidamente sem ninguém ouvindo', async () => {
  let n = 0;
  const { session, state } = sessionWorld({
    async replenish() { return Array.from({ length: 10 }, () => track(`g${n++}`)); }
  });
  const tracks = radio(16);
  session.start(tracks, 16);
  state.current = tracks[0];

  let total = 16;
  for (let i = 0; i < 100; i++) {
    state.queued = [];
    total += await session.tick();
  }
  assert.ok(total <= 124, `${total} faixas`);
  assert.ok(total >= 120);
});

test('RadioSession: reposição em andamento não se repete nem sobrevive a uma rádio nova', async () => {
  let release: (value: TrackMetadata[]) => void = () => undefined;
  const { session, state, log } = sessionWorld({
    replenish: () => new Promise((resolve) => { release = resolve; })
  });
  const tracks = radio(2);
  session.start(tracks, 2);
  state.current = tracks[0];

  const first = session.tick();
  assert.equal(await session.tick(), 0, 'chamada reentrante é descartada');

  const other = radio(30).map((t) => track(`x${t.name}`));
  session.start(other, 16);
  release([track('velha')]);
  await first;

  assert.equal(log.added.length, 0);
});

test('Menos assim: faixas parecidas caem na fila na hora, e o artista sai da sessão', async () => {
  const { session, state, log } = sessionWorld();
  const loud = Array.from({ length: 10 }, (_, i) => track(`loud${i}`, `lb${i}`, LOUD));
  const quiet = Array.from({ length: 10 }, (_, i) => track(`quiet${i}`, `qb${i}`, QUIET));
  const tracks = loud.flatMap((t, i) => [t, quiet[i]]);
  session.start(tracks, 12);
  state.current = tracks[0];
  state.queued = tracks.slice(1, 12);

  assert.equal(await session.steer(tracks[0], -1), true);

  const next = log.set[0];
  assert.equal(next.includes('loud0'), false);
  assert.ok(next.slice(0, 5).every((name) => name.startsWith('quiet')), next.join(','));
});

test('Mais assim: faixas parecidas sobem na fila, sem remover ninguém', async () => {
  const { session, state, log } = sessionWorld();
  const loud = Array.from({ length: 6 }, (_, i) => track(`loud${i}`, `lb${i}`, LOUD));
  const quiet = Array.from({ length: 6 }, (_, i) => track(`quiet${i}`, `qb${i}`, QUIET));
  const tracks = [...quiet, ...loud];
  session.start(tracks, 12);
  state.current = loud[0];
  state.queued = tracks.filter((t) => t !== loud[0]);

  await session.steer(loud[0], 1);

  assert.equal(log.set[0].length, 11);
  assert.ok(log.set[0].slice(0, 5).every((name) => name.startsWith('loud')), log.set[0].join(','));
});

test('Mais ou menos assim preserva a fila manual, e sem rádio ativa não mexe em nada', async () => {
  const { session, state, log } = sessionWorld();
  assert.equal(await session.steer(track('z', 'z', LOUD), 1), false);

  const tracks = radio(20);
  session.start(tracks, 10);
  state.current = tracks[0];
  const manual = track('minha');
  state.queued = [manual, ...tracks.slice(1, 10)];

  await session.steer(tracks[0], 1);
  assert.equal(log.set[0][0], 'minha');
  assert.equal(new Set(log.set[0]).size, log.set[0].length);
  assert.equal(log.set[0].length, 15);
});

test('Pular duas do mesmo artista tira o artista; uma só não tira', async () => {
  const { session, state, log } = sessionWorld();
  const tracks = [track('a1', 'x'), track('a2', 'x'), track('b1', 'y'), ...radio(20), track('a3', 'x')];
  session.start(tracks, 1);
  state.current = tracks[0];

  session.observePlay(skip(tracks[0]));
  await session.tick();
  assert.ok(log.added[0].includes('a2'));

  session.observePlay(skip(tracks[1]));
  state.queued = [];
  for (let i = 0; i < 5; i++) { state.queued = []; await session.tick(); }
  assert.equal(log.added.flat().includes('a3'), false);
});

function memoryFolder(failWrite = false) {
  const files = new Map<string, string>();
  const folder: BackupFolder = {
    async write(name, content) { files.set(name, failWrite ? content.slice(0, 10) : content); },
    read: async (name) => files.get(name)!,
    list: async () => Array.from(files.keys()),
    remove: async (name) => { files.delete(name); }
  };
  return { files, folder };
}

function memoryStore() {
  const values = new Map<string, string>();
  return { get: (k: string) => values.get(k) ?? null, set: (k: string, v: string) => { values.set(k, v); } };
}

const backupOf = (ratings: number) => JSON.stringify({ ratings: Array.from({ length: ratings }, (_, i) => ({ uri: `u${i}` })) });

test('AutoBackup: grava, confere e registra o estado', async () => {
  const { files, folder } = memoryFolder();
  const backup = new AutoBackup({ folder: async () => folder, snapshot: async () => backupOf(10), store: memoryStore(), now: () => NOW });

  assert.equal(backup.isDue(), true);
  const status = await backup.run();

  assert.equal(status.error, null);
  assert.equal(status.ratings, 10);
  assert.equal(files.get(status.lastFile!), backupOf(10));
  assert.equal(backup.isDue(), false);
});

test('AutoBackup: vence depois de 7 dias', async () => {
  const { folder } = memoryFolder();
  let clock = NOW;
  const backup = new AutoBackup({ folder: async () => folder, snapshot: async () => backupOf(1), store: memoryStore(), now: () => clock });
  await backup.run();
  clock += 6 * DAY;
  assert.equal(backup.isDue(), false);
  clock += DAY;
  assert.equal(backup.isDue(), true);
});

test('AutoBackup: mantém 8 cópias e nunca toca em arquivos que não são dele', async () => {
  const { files, folder } = memoryFolder();
  files.set('minha-planilha.json', 'x');
  let clock = NOW;
  const backup = new AutoBackup({ folder: async () => folder, snapshot: async () => backupOf(5), store: memoryStore(), now: () => clock });

  for (let i = 0; i < 12; i++) {
    await backup.run();
    clock += DAY;
  }

  assert.equal(files.has('minha-planilha.json'), true);
  assert.equal(Array.from(files.keys()).filter((n) => n.startsWith('neuraltune-backup-')).length, 8);
});

test('AutoBackup: arquivo que não confere não apaga nada e vira erro', async () => {
  const { files, folder } = memoryFolder();
  let clock = NOW;
  const store = memoryStore();
  const good = new AutoBackup({ folder: async () => folder, snapshot: async () => backupOf(5), store, now: () => clock });
  for (let i = 0; i < 8; i++) { await good.run(); clock += DAY; }
  const kept = Array.from(files.keys());

  const broken = memoryFolder(true).folder;
  const bad = new AutoBackup({ folder: async () => ({ ...folder, write: broken.write, read: async () => 'corrompido' }), snapshot: async () => backupOf(5), store, now: () => clock });
  const status = await bad.run();

  assert.ok(status.error, 'precisa acusar o erro');
  for (const name of kept) assert.equal(files.has(name), true);
});

test('AutoBackup: banco esvaziado não gira os backups bons para fora', async () => {
  const { files, folder } = memoryFolder();
  let clock = NOW;
  let size = 800;
  const backup = new AutoBackup({ folder: async () => folder, snapshot: async () => backupOf(size), store: memoryStore(), now: () => clock });
  for (let i = 0; i < 8; i++) { await backup.run(); clock += DAY; }
  const kept = Array.from(files.keys());

  size = 0;
  for (let i = 0; i < 10; i++) { await backup.run(); clock += DAY; }

  for (const name of kept) assert.equal(files.has(name), true, 'nenhum backup bom pode sumir');
  assert.match(backup.getStatus().error!, /mantidos/);
});

test('AutoBackup: sem pasta ou sem permissão explica o que fazer e continua vencido', async () => {
  const backup = new AutoBackup({ folder: async () => null, snapshot: async () => backupOf(1), store: memoryStore(), now: () => NOW });
  assert.match((await backup.run()).error!, /pasta de backup/);
  assert.equal(backup.isDue(), true);
});

test('AutoBackup: restaurar um backup real devolve notas e exposição', async () => {
  const source = new MemoryStorage();
  const t = track('r1');
  await source.saveRating({ uri: t.uri, rating: 5, timestamp: NOW, metadata: t });
  await source.saveExposures(buildExposures({ runId: 'r', radio: 'gym', at: NOW, tracks: [t], sourceOf: () => 'playlist', isNewArtist: () => false }));
  const exporter = new DataPortabilityManager({ storage: source, blacklist: new BlacklistManager(source) });
  const { files, folder } = memoryFolder();
  const backup = new AutoBackup({ folder: async () => folder, snapshot: async () => (await exporter.exportJson()).content, store: memoryStore(), now: () => NOW });

  const { lastFile } = await backup.run();

  const target = new MemoryStorage();
  const importer = new DataPortabilityManager({ storage: target, blacklist: new BlacklistManager(target) });
  await importer.importJson(files.get(lastFile!)!);
  assert.equal((await target.getRating(t.uri))?.rating, 5);
  assert.equal((await target.getAllExposures()).length, 1);
});

test('Descobertas da Semana: reserva 40% para artistas novos, mesmo vindo depois no ranking', () => {
  const known = Array.from({ length: 40 }, (_, i) => track(`k${i}`, `known${i}`));
  const fresh = Array.from({ length: 20 }, (_, i) => track(`n${i}`, `new${i}`));

  const { tracks, newArtists } = pickWeeklyDiscoveries([...known, ...fresh], (t) => t.uri.includes(':n'));

  assert.equal(tracks.length, 30);
  assert.equal(newArtists, 12);
  assert.equal(new Set(tracks.map((t) => t.uri)).size, 30);
});

test('Descobertas da Semana: limita 2 por artista e completa quando faltam artistas novos', () => {
  const candidates = [...Array.from({ length: 10 }, (_, i) => track(`same${i}`, 'mesmo')), ...Array.from({ length: 40 }, (_, i) => track(`o${i}`))];
  const { tracks, newArtists } = pickWeeklyDiscoveries(candidates, () => false);
  assert.equal(tracks.length, 30);
  assert.equal(newArtists, 0);
  assert.equal(tracks.filter((t) => t.artists[0].name === 'mesmo').length, 2);
});

test('Descobertas da Semana: candidatos de menos devolvem o que houver', () => {
  assert.deepEqual(pickWeeklyDiscoveries([], () => false), { tracks: [], newArtists: 0 });
  assert.equal(pickWeeklyDiscoveries([track('a'), track('b')], () => true).tracks.length, 2);
});

test('replacePlaylist: troca o conteúdo da playlist inteiro pela nova seleção', async () => {
  const storage = new MemoryStorage();
  const items = new Map<string, Array<{ uri: string; uid: string }>>();
  const playlists = {
    findPlaylistByName: async () => (items.has('p') ? 'p' : null),
    createPlaylist: async () => { items.set('p', []); return 'p'; },
    getPlaylistItems: async () => items.get('p')!,
    addTracks: async (_: string, uris: string[]) => { items.get('p')!.push(...uris.map((uri, i) => ({ uri, uid: `u${uri}${i}` }))); },
    removeTracks: async (_: string, gone: Array<{ uri: string; uid: string }>) => { items.set('p', items.get('p')!.filter((x) => !gone.some((g) => g.uid === x.uid))); }
  };
  const manager = new DataPortabilityManager({ storage, blacklist: new BlacklistManager(storage), playlists });

  const first = await manager.replacePlaylist('Semana', ['a', 'b']);
  assert.equal(first.created, true);
  const second = await manager.replacePlaylist('Semana', ['b', 'c']);

  assert.equal(second.created, false);
  assert.deepEqual(items.get('p')!.map((x) => x.uri).sort(), ['b', 'c']);
});

const prediction = (overrides: Partial<PredictionResult>): PredictionResult => ({
  track: track('w'), score: 70, confidence: 0.5, eligible: true, reasons: [], noveltyScore: 0.2, ...overrides
});

test('Por que essa faixa: usa os motivos reais, do maior para o menor, e só os positivos', () => {
  const engine = new ExplainabilityEngine();
  const why = engine.whyRecommended(prediction({
    breakdown: [
      { key: 'artist', label: 'afinidade com o artista', points: 12, share: 0.5 },
      { key: 'acoustic', label: 'afinidade acústica (alta energia)', points: 8, share: 0.3 },
      { key: 'graph', label: 'afinidade estrutural no grafo', points: 2, share: 0.1 },
      { key: 'fatigue', label: 'penalidade por repetição recente', points: -9, share: -0.3 }
    ]
  }), false);

  assert.equal(why, 'Por quê: afinidade com o artista · afinidade acústica (alta energia)');
});

test('Por que essa faixa: artista novo vem primeiro, e sem sinal assume que é exploração', () => {
  const engine = new ExplainabilityEngine();
  assert.match(engine.whyRecommended(prediction({ breakdown: [{ key: 'bandit', label: 'previsão do modelo de notas', points: 5, share: 1 }] }), true), /^Por quê: artista novo · previsão/);
  assert.equal(engine.whyRecommended(prediction({ breakdown: [] }), false), 'Por quê: sem sinal forte, entrou para explorar');
  assert.equal(engine.whyRecommended(prediction({}), true), 'Por quê: artista novo');
});

test('Sinal Mais/Menos assim fica na reprodução e entra no resumo da rádio', async () => {
  const storage = new MemoryStorage();
  const tracker = new PlaybackHistoryTracker(storage, undefined, () => NOW, () => 'radio');
  await tracker.onTrackChange(track('a'));
  tracker.markFeedback('mais');
  tracker.updateProgress(100_000);
  await tracker.onTrackChange(track('b'));
  tracker.markFeedback('menos');
  tracker.updateProgress(100_000);
  await tracker.flush();

  const plays = await storage.getAllPlayEvents();
  const exposures = ['a', 'b'].map((id) => buildExposures({ runId: 'r', radio: 'gym', at: NOW - 1, tracks: [track(id)], sourceOf: () => 'playlist', isNewArtist: () => false })[0]);
  const [summary] = summarizeOutcomes(exposures.map((e, i) => ({ ...e, id: `e${i}` })), plays, []).byRadio;

  assert.equal(summary.moreLike, 1);
  assert.equal(summary.lessLike, 1);
});

test('importação: sinal da reprodução sobrevive, e valor desconhecido é descartado', async () => {
  const storage = new MemoryStorage();
  const manager = new DataPortabilityManager({ storage, blacklist: new BlacklistManager(storage) });
  const base = { uri: 'spotify:track:a', startedAt: NOW, playedMs: 1 };
  await manager.importJson(JSON.stringify({ schemaVersion: 2, ratings: [], playEvents: [{ ...base, id: 'a', feedback: 'mais' }, { ...base, id: 'b', feedback: 'talvez' }] }));
  const byId = Object.fromEntries((await storage.getAllPlayEvents()).map((p) => [p.id, p.feedback]));
  assert.deepEqual(byId, { a: 'mais', b: undefined });
});

test('buildExposures: reposição continua a numeração da mesma rádio sem colidir', () => {
  const base = { radio: 'gym', at: NOW, sourceOf: () => 'playlist' as const, isNewArtist: () => false, runId: 'r' };
  const first = buildExposures({ ...base, tracks: Array.from({ length: 16 }, (_, i) => track(`a${i}`)) });
  const refill = buildExposures({ ...base, tracks: [track('b')], positionOffset: 16 });
  assert.equal(refill[0].position, 16);
  assert.equal(new Set([...first, ...refill].map((e) => e.id)).size, 17);

  const weekly = buildExposures({ ...base, tracks: Array.from({ length: 30 }, (_, i) => track(`c${i}`)), limit: 30 });
  assert.equal(weekly.length, 30);
});
