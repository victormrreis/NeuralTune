import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStorage } from '../src/storage/MemoryStorage.ts';
import { BlacklistManager } from '../src/core/BlacklistManager.ts';
import { PreferenceEngine } from '../src/core/PreferenceEngine.ts';
import { NeuralContextModel } from '../src/core/NeuralContextModel.ts';
import { DEFAULT_FLAGS } from '../src/core/FeatureFlags.ts';
import { HeardLedger } from '../src/radios/HeardLedger.ts';
import { buildUnheardShield } from '../src/radios/UnheardShield.ts';
import { importStreamingHistory, parseStreamingHistory } from '../src/storage/StreamingHistory.ts';
import { attribute, buildExposures, compareArms, summarizeOutcomes } from '../src/evaluation/RadioOutcomes.ts';
import { buildWeeklyReport } from '../src/evaluation/WeeklyReport.ts';
import { evidenceOf } from '../src/neuroscience/AdaptivePreferencePlasticity.ts';
import { seededRandom } from '../src/core/ThompsonBanditOptimizer.ts';
import { ListeningHistoryEntry, PlayEvent, RadioExposure, TrackMetadata } from '../src/types/index.ts';

const NOW = Date.parse('2026-11-01T12:00:00Z');
const DAY = 24 * 3_600_000;

function track(id: string, name = id, artist = `Art ${id}`): TrackMetadata {
  return { uri: `spotify:track:${id}`, name, artists: [{ name: artist, uri: `spotify:artist:${artist.replace(/\s/g, '')}` }], album: { name: '', uri: '' }, duration_ms: 200_000 };
}

function play(id: string, overrides: Partial<PlayEvent> = {}): PlayEvent {
  return { id: `${id}@${NOW}`, uri: `spotify:track:${id}`, name: id, artistUris: [], startedAt: NOW - 1000, endedAt: NOW, playedMs: 190_000, durationMs: 200_000, skipped: false, ...overrides };
}

function memoryStore() {
  const values = new Map<string, string>();
  return { get: (k: string) => values.get(k) ?? null, set: (k: string, v: string) => { values.set(k, v); } };
}

function stream(overrides: Record<string, unknown> = {}) {
  return {
    ts: '2024-03-10T20:15:00Z', platform: 'windows', ms_played: 210_000, conn_country: 'BR', ip_addr: '203.0.113.7',
    master_metadata_track_name: 'Canção', master_metadata_album_artist_name: 'Banda', master_metadata_album_album_name: 'Disco',
    spotify_track_uri: 'spotify:track:abc', episode_name: null, episode_show_name: null, spotify_episode_uri: null,
    reason_start: 'trackdone', reason_end: 'trackdone', shuffle: false, skipped: false, offline: false, offline_timestamp: null, incognito_mode: false,
    ...overrides
  };
}

test('parseStreamingHistory: lê o formato estendido e não guarda IP, país nem plataforma', () => {
  const { rows } = parseStreamingHistory(JSON.stringify([stream()]));
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], { at: Date.parse('2024-03-10T20:15:00Z'), uri: 'spotify:track:abc', name: 'Canção', artist: 'Banda', ms: 210_000, completed: true, skipped: false });
  assert.doesNotMatch(JSON.stringify(rows), /203\.0\.113|BR|windows/);
});

test('parseStreamingHistory: lê o formato curto, sem URI', () => {
  const { rows } = parseStreamingHistory(JSON.stringify([{ endTime: '2024-03-10 20:15', artistName: 'Banda', trackName: 'Canção', msPlayed: 1000 }]));
  assert.equal(rows[0].uri, undefined);
  assert.equal(rows[0].at, Date.parse('2024-03-10T20:15:00Z'));
});

test('parseStreamingHistory: ignora podcast, sessão privada e linha quebrada, e conta cada um', () => {
  const result = parseStreamingHistory(JSON.stringify([
    stream(),
    stream({ master_metadata_track_name: null, master_metadata_album_artist_name: null, spotify_track_uri: null, episode_name: 'Podcast' }),
    stream({ incognito_mode: true }),
    stream({ ms_played: 'x' }),
    stream({ ts: 'ontem' }),
    null, 7
  ]));
  assert.equal(result.rows.length, 1);
  assert.equal(result.podcasts, 1);
  assert.equal(result.incognito, 1);
  assert.equal(result.invalid, 4);
});

test('parseStreamingHistory: ZIP ou JSON que não é histórico vira mensagem útil', () => {
  assert.throws(() => parseStreamingHistory('PK\u0003\u0004 binário'), /Extraia o ZIP/);
  assert.throws(() => parseStreamingHistory('{"ratings":[]}'), /não parece ser um histórico/);
});

test('importStreamingHistory: agrega por faixa e separa conclusão de pulo', async () => {
  const storage = new MemoryStorage();
  const { report } = await importStreamingHistory([JSON.stringify([
    stream({ ts: '2024-01-01T00:00:00Z' }),
    stream({ ts: '2024-02-01T00:00:00Z' }),
    stream({ ts: '2024-03-01T00:00:00Z', ms_played: 9_000, reason_end: 'fwdbtn', skipped: true })
  ])], storage, memoryStore());

  const [entry] = await storage.getAllHistory();
  assert.equal(report.tracks, 1);
  assert.equal(report.plays, 3);
  assert.equal(entry.plays, 3);
  assert.equal(entry.completions, 2);
  assert.equal(entry.earlySkips, 1);
  assert.equal(entry.msPlayed, 429_000);
  assert.equal(entry.firstAt, Date.parse('2024-01-01T00:00:00Z'));
  assert.equal(entry.lastAt, Date.parse('2024-03-01T00:00:00Z'));
});

test('importStreamingHistory: importar de novo não conta duas vezes, e o período novo entra', async () => {
  const storage = new MemoryStorage();
  const store = memoryStore();
  const file = JSON.stringify([stream({ ts: '2024-01-01T00:00:00Z' })]);

  await importStreamingHistory([file], storage, store);
  const again = await importStreamingHistory([file], storage, store);
  assert.equal(again.report.plays, 0);
  assert.equal(again.report.alreadyImported, 1);

  await importStreamingHistory([JSON.stringify([stream({ ts: '2024-01-01T00:00:00Z' }), stream({ ts: '2025-01-01T00:00:00Z' })])], storage, store);
  assert.equal((await storage.getAllHistory())[0].plays, 2);
});

test('importStreamingHistory: vários arquivos do mesmo pedido entram juntos, em qualquer ordem', async () => {
  const storage = new MemoryStorage();
  await importStreamingHistory([
    JSON.stringify([stream({ ts: '2025-01-01T00:00:00Z' })]),
    JSON.stringify([stream({ ts: '2020-01-01T00:00:00Z' })])
  ], storage, memoryStore());
  assert.equal((await storage.getAllHistory())[0].plays, 2);
});

test('importStreamingHistory: arquivo ruim no lote não grava pela metade', async () => {
  const storage = new MemoryStorage();
  const store = memoryStore();
  await assert.rejects(importStreamingHistory([JSON.stringify([stream()]), 'lixo'], storage, store));
  assert.equal((await storage.getAllHistory()).length, 0);
  assert.equal(store.get('neuraltune:history-imported-until'), null);
});

test('importStreamingHistory: 200 mil reproduções terminam rápido', async () => {
  const random = seededRandom(9);
  const rows = Array.from({ length: 200_000 }, (_, i) => stream({
    ts: new Date(NOW - i * 60_000).toISOString(),
    spotify_track_uri: `spotify:track:t${Math.floor(random() * 30_000)}`
  }));
  const started = performance.now();
  const { report } = await importStreamingHistory([JSON.stringify(rows)], new MemoryStorage(), memoryStore());
  assert.equal(report.plays, 200_000);
  assert.ok(performance.now() - started < 3000, `${Math.round(performance.now() - started)} ms`);
});

function entry(overrides: Partial<ListeningHistoryEntry>): ListeningHistoryEntry {
  return { id: 'x', name: 'Song', artist: 'Band', plays: 3, completions: 2, earlySkips: 0, msPlayed: 500_000, firstAt: NOW, lastAt: NOW, ...overrides };
}

test('HeardLedger: reconhece por URI e por outra versão da mesma música', () => {
  const ledger = new HeardLedger();
  ledger.addPlay(play('a', { name: 'Hino', artistNames: ['Nina'] }));
  ledger.addHistory(entry({ id: 'k', name: 'Antiga', artist: 'Velho' }));

  assert.equal(ledger.isHeard(track('a')), true);
  assert.equal(ledger.isHeard(track('b', 'Hino - Remastered', 'Nina')), true);
  assert.equal(ledger.isHeard(track('c', 'Antiga (Ao Vivo)', 'Velho')), true);
  assert.equal(ledger.isHeard(track('d', 'Outra', 'Nina')), false);
});

test('HeardLedger: esbarrão de menos de 5 s não conta como ouvida', () => {
  const ledger = new HeardLedger();
  ledger.addPlay(play('a', { playedMs: 3000, artistNames: ['Nina'] }));
  ledger.addHistory(entry({ uri: 'spotify:track:b', msPlayed: 1000 }));
  assert.equal(ledger.isHeard(track('a')), false);
  assert.equal(ledger.isHeard(track('b')), false);
  assert.equal(ledger.size, 0);
});

test('HeardLedger: conhece o artista pelo nome, que é tudo o que o histórico traz', () => {
  const ledger = new HeardLedger();
  ledger.addHistory(entry({ artist: 'The Beatles' }));
  assert.equal(ledger.knowsArtist(track('a', 'x', 'Beatles')), true);
  assert.equal(ledger.knowsArtist(track('b', 'x', 'Outro')), false);
});

test('Escudo: faixa já ouvida sem nota e sem curtida não entra, e a contagem aparece', async () => {
  const storage = new MemoryStorage();
  const ledger = new HeardLedger();
  ledger.addPlay(play('heard', { artistNames: ['Art heard'] }));

  const shield = buildUnheardShield({ ratings: [], blockedArtistCount: 0, harvest: { tracks: [] }, blacklist: new BlacklistManager(storage), heard: ledger });

  assert.equal(shield.isExcluded(track('heard')), true);
  assert.equal(shield.isExcluded(track('alt', 'heard - Live', 'Art heard')), true);
  assert.equal(shield.isExcluded(track('nova')), false);
  assert.equal(shield.counts.heard, 1);
});

test('ingestHistory: histórico alimenta o modelo sem criar nota, e nota explícita continua soberana', async () => {
  const storage = new MemoryStorage();
  const features = { energy: 0.8, bpm: 120 };
  const engine = new PreferenceEngine(storage, () => NOW);
  await engine.init();
  engine.setFeatureLookup((uri) => (uri === 'spotify:track:loved' ? features : undefined));

  const before = engine.evaluateCandidate(track('probe')).score;
  engine.ingestHistory([entry({ uri: 'spotify:track:loved', plays: 30, completions: 28 })]);

  assert.equal(engine.getModelSnapshot().implicitSignals, 1);
  assert.equal((await storage.getAllRatings()).length, 0);
  assert.ok(Number.isFinite(engine.evaluateCandidate(track('probe')).score));
  assert.ok(Number.isFinite(before));
});

test('Mais/menos assim: pesa como 4★ e 2★, abaixo de uma nota 5★ ou 0★', () => {
  const more = evidenceOf({ kind: 'steer-more', key: 'a', timestamp: 0 }, 0, 2);
  const less = evidenceOf({ kind: 'steer-less', key: 'a', timestamp: 0 }, 0, 2);
  assert.equal(more, 0.5);
  assert.equal(less, -0.3);
});

test('Memória de sinais: só muda a pontuação com a variante ligada', async () => {
  const storage = new MemoryStorage();
  const engine = new PreferenceEngine(storage, () => NOW);
  await engine.init();
  const context = new NeuralContextModel(engine, { ...DEFAULT_FLAGS, plasticity: true });
  const event = play('a', { artistUris: ['spotify:artist:x'], feedback: 'mais', playedMs: 8_000, skipped: true });
  context.fit([], [event]);

  const t = track('z', 'z', 'x');
  const off = context.adjustment(t, new Date(NOW), false);
  const on = context.adjustment(t, new Date(NOW), true);
  assert.ok(on > off, `${on} <= ${off}`);
  assert.equal(context.adjustment(t, new Date(NOW)), off, 'sem pedir, fica como antes');
});

test('Sinal "menos assim" empurra o artista para baixo com a variante ligada', async () => {
  const storage = new MemoryStorage();
  const engine = new PreferenceEngine(storage, () => NOW);
  await engine.init();
  const context = new NeuralContextModel(engine, { ...DEFAULT_FLAGS, plasticity: true });
  context.fit([], [play('a', { artistUris: ['spotify:artist:x'], feedback: 'menos' })]);
  const t = track('z', 'z', 'x');
  assert.ok(context.adjustment(t, new Date(NOW), true) < context.adjustment(t, new Date(NOW), false));
});

function exposure(id: string, overrides: Partial<RadioExposure> = {}): RadioExposure {
  return { id, runId: 'r', radio: 'gym', uri: `spotify:track:${id}`, position: 0, at: NOW - DAY, propensity: null, source: 'playlist', newArtist: false, ...overrides };
}

test('buildExposures: grava a variante de memória', () => {
  const [record] = buildExposures({ runId: 'r', radio: 'gym', at: NOW, tracks: [track('a')], sourceOf: () => 'playlist', isNewArtist: () => false, carry: true });
  assert.equal(record.carry, true);
});

test('Experimento de memória: analisado à parte, com rótulos próprios', () => {
  const random = seededRandom(4);
  const exposures: RadioExposure[] = [];
  const plays: PlayEvent[] = [];
  for (let r = 0; r < 60; r++) {
    const carry = r % 2 === 0;
    for (let p = 0; p < 10; p++) {
      const id = `r${r}p${p}`;
      exposures.push(exposure(id, { runId: `run${r}`, carry, at: NOW - 60 * DAY + r * DAY }));
      const good = random() < (carry ? 0.75 : 0.45);
      plays.push(play(id, { startedAt: NOW - 60 * DAY + r * DAY + 1, playedMs: good ? 190_000 : 9_000, skipped: !good }));
    }
  }

  const report = summarizeOutcomes(exposures, plays, [], NOW);
  assert.equal(report.carryExperiment.verdict, 'com memória melhor');
  assert.equal(report.experiment.verdict, 'coletando');
  assert.deepEqual(compareArms(attribute(exposures, plays, []), (e) => (e.carry === undefined ? undefined : e.carry ? 'exploratorio' : 'padrao'), { control: 'A', treatment: 'B' }).verdict, 'B melhor');
});

test('Relatório semanal: resume a semana, aprova artistas novos e aponta o que foi pulado', () => {
  const exposures = [
    exposure('a', { newArtist: true }), exposure('b', { newArtist: true }), exposure('c'), exposure('d'),
    exposure('e', { radio: 'relax' }), exposure('f', { radio: 'relax' }), exposure('g', { radio: 'relax' }), exposure('h', { radio: 'relax' }), exposure('i', { radio: 'relax' })
  ];
  const plays = [
    play('a', { name: 'Nova', artistNames: ['Estreante'], feedback: 'mais' }),
    play('b', { name: 'Ruim', artistNames: ['Outro'], playedMs: 8_000, skipped: true }),
    play('c', { name: 'P1', artistNames: ['Chato'], playedMs: 8_000, skipped: true }),
    play('d', { name: 'P2', artistNames: ['Chato'], playedMs: 8_000, skipped: true }),
    ...['e', 'f', 'g', 'h', 'i'].map((id) => play(id, { artistNames: ['Bom'] }))
  ];

  const report = buildWeeklyReport(attribute(exposures, plays, []), NOW);

  assert.equal(report.heard, 9);
  assert.equal(report.completed, 6);
  assert.equal(report.newArtistTracks, 2);
  assert.deepEqual(report.approvedNewArtists, ['Estreante — Nova']);
  assert.deepEqual(report.mostSkippedArtists[0], { artist: 'Chato', skips: 2 });
  assert.equal(report.bestRadio?.radio, 'relax');
  assert.equal(report.bestRadio?.completionRate, 1);
});

test('Relatório semanal: fora dos 7 dias não entra, e sem escuta não inventa nada', () => {
  const old = buildWeeklyReport(attribute([exposure('a', { at: NOW - 9 * DAY })], [play('a', { startedAt: NOW - 8 * DAY })], []), NOW);
  assert.equal(old.heard, 0);
  assert.equal(old.completionRate, null);
  assert.equal(old.bestRadio, null);
  assert.deepEqual(old.approvedNewArtists, []);
});

test('Relatório semanal: faixa aprovada por nota também conta, e rádio com pouca escuta não vence', () => {
  const t = track('a', 'Boa', 'Novo');
  const report = buildWeeklyReport(attribute(
    [exposure('a', { newArtist: true })],
    [play('a', { name: 'Boa' })],
    [{ uri: t.uri, rating: 5, timestamp: NOW - 500, metadata: t }]
  ), NOW);
  assert.deepEqual(report.approvedNewArtists, ['Novo — Boa']);
  assert.equal(report.bestRadio, null);
});
