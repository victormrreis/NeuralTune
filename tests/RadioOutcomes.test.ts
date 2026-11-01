import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStorage } from '../src/storage/MemoryStorage.ts';
import { BlacklistManager } from '../src/core/BlacklistManager.ts';
import { DataPortabilityManager } from '../src/storage/DataPortabilityManager.ts';
import { PlaybackHistoryTracker } from '../src/core/PlaybackHistoryTracker.ts';
import { PreferenceEngine } from '../src/core/PreferenceEngine.ts';
import { NeuralContextModel } from '../src/core/NeuralContextModel.ts';
import { DEFAULT_FLAGS } from '../src/core/FeatureFlags.ts';
import { EXPOSED_TRACKS, buildExposures, shufflePositions, summarizeOutcomes, wilsonInterval } from '../src/evaluation/RadioOutcomes.ts';
import { diagnoseEvaluation, baselineArtistMean, randomRanker } from '../src/evaluation/RecommenderEvaluation.ts';
import { chooseDiscoverySeeds } from '../src/discovery/AutonomousDiscoveryCrawler.ts';
import { seededRandom } from '../src/core/ThompsonBanditOptimizer.ts';
import { PlayEvent, Rating, RadioExposure, TrackMetadata, TrackRatingRecord } from '../src/types/index.ts';

const NOW = 1_700_000_000_000;
const DAY = 24 * 3_600_000;

function track(id: string, artist = `a-${id}`): TrackMetadata {
  return { uri: `spotify:track:${id}`, name: id, artists: [{ name: artist, uri: `spotify:artist:${artist}` }], album: { name: '', uri: '' }, duration_ms: 200_000 };
}

function exposure(id: string, radio: string, at = NOW, overrides: Partial<RadioExposure> = {}): RadioExposure {
  return { id: `${radio}:${id}:${at}`, runId: `${radio}-${at}`, radio, uri: `spotify:track:${id}`, position: 0, at, propensity: null, source: 'playlist', newArtist: false, ...overrides };
}

function play(id: string, startedAt: number, playedMs: number, skipped = false): PlayEvent {
  return { id: `${id}@${startedAt}`, uri: `spotify:track:${id}`, name: id, artistUris: [], startedAt, endedAt: startedAt + playedMs, playedMs, durationMs: 200_000, skipped };
}

function rated(id: string, rating: Rating, timestamp: number): TrackRatingRecord {
  return { uri: `spotify:track:${id}`, rating, timestamp, metadata: track(id) };
}

test('buildExposures: só registra o que chegou ao player, com posição, origem e propensão', () => {
  const tracks = Array.from({ length: 30 }, (_, i) => track(`t${i}`));
  const records = buildExposures({
    runId: 'r1', radio: 'gym', at: NOW, tracks,
    propensityOf: (uri) => (uri.endsWith('t0') ? 0.5 : null),
    sourceOf: (uri) => (uri.endsWith('t1') ? 'descoberta' : 'playlist'),
    isNewArtist: (t) => t.uri.endsWith('t2')
  });

  assert.equal(records.length, EXPOSED_TRACKS);
  assert.equal(new Set(records.map((r) => r.id)).size, EXPOSED_TRACKS);
  assert.deepEqual(records.map((r) => r.position).slice(0, 3), [0, 1, 2]);
  assert.equal(records[0].propensity, 0.5);
  assert.equal(records[1].propensity, null);
  assert.equal(records[1].source, 'descoberta');
  assert.equal(records[2].newArtist, true);
});

test('wilsonInterval: contém a proporção, fica em [0, 1] e estreita com a amostra', () => {
  assert.equal(wilsonInterval(0, 0), null);
  for (const [s, n] of [[0, 5], [5, 5], [3, 10], [1, 1000]]) {
    const [low, high] = wilsonInterval(s, n)!;
    assert.ok(low >= 0 && high <= 1 && low <= s / n && s / n <= high);
  }
  const small = wilsonInterval(5, 10)!;
  const large = wilsonInterval(500, 1000)!;
  assert.ok(large[1] - large[0] < small[1] - small[0]);
  assert.ok(Math.abs(wilsonInterval(50, 100)![0] - 0.4038) < 0.001);
});

test('summarizeOutcomes: faixa não alcançada conta como exposta, nunca como rejeitada', () => {
  const report = summarizeOutcomes(
    [exposure('a', 'gym'), exposure('b', 'gym'), exposure('c', 'gym')],
    [play('a', NOW + 1000, 190_000), play('b', NOW + 2000, 8_000, true)],
    []
  );

  const [gym] = report.byRadio;
  assert.equal(gym.exposed, 3);
  assert.equal(gym.heard, 2);
  assert.equal(gym.completed, 1);
  assert.equal(gym.skipped, 1);
  assert.equal(gym.completionRate, 0.5);
  assert.equal(gym.enoughData, false);
});

test('summarizeOutcomes: reprodução e nota anteriores à exposição não contam', () => {
  const report = summarizeOutcomes([exposure('a', 'gym')], [play('a', NOW - 1000, 190_000)], [rated('a', 5, NOW - 1000)]);
  assert.equal(report.byRadio[0].heard, 0);
  assert.equal(report.byRadio[0].rated, 0);
});

test('summarizeOutcomes: fora da janela de 7 dias a reprodução não é atribuída à rádio', () => {
  const report = summarizeOutcomes([exposure('a', 'gym')], [play('a', NOW + 8 * DAY, 190_000)], []);
  assert.equal(report.byRadio[0].heard, 0);
});

test('summarizeOutcomes: faixa em duas rádios pertence à mais recente a partir dela', () => {
  const report = summarizeOutcomes(
    [exposure('a', 'gym', NOW), exposure('a', 'relax', NOW + DAY)],
    [play('a', NOW + DAY + 5, 190_000)],
    [rated('a', 5, NOW + DAY + 10)]
  );

  const by = Object.fromEntries(report.byRadio.map((r) => [r.group, r]));
  assert.equal(by.relax.heard, 1);
  assert.equal(by.relax.liked, 1);
  assert.equal(by.gym.heard, 0);
  assert.equal(by.gym.rated, 0);
});

test('summarizeOutcomes: notas viram gosto e desgosto, e 3★ não conta para nenhum lado', () => {
  const report = summarizeOutcomes(
    [exposure('a', 'gym'), exposure('b', 'gym'), exposure('c', 'gym'), exposure('d', 'gym')],
    [],
    [rated('a', 5, NOW + 1), rated('b', 0, NOW + 1), rated('c', 3, NOW + 1)]
  );
  const [gym] = report.byRadio;
  assert.equal(gym.rated, 3);
  assert.equal(gym.liked, 1);
  assert.equal(gym.disliked, 1);
  assert.ok(Math.abs(gym.likeRate! - 1 / 3) < 1e-12);
});

test('summarizeOutcomes: IPS dá mais peso à faixa pouco provável e ignora propensão desconhecida', () => {
  const report = summarizeOutcomes(
    [exposure('rare', 'gym', NOW, { propensity: 0.1 }), exposure('fav', 'gym', NOW, { propensity: 1 })],
    [play('rare', NOW + 1, 190_000), play('fav', NOW + 1, 5_000, true)],
    []
  );
  assert.equal(report.byRadio[0].completionRate, 0.5);
  assert.ok(Math.abs(report.byRadio[0].weightedCompletion! - 10 / 11) < 1e-12);

  const unknown = summarizeOutcomes([exposure('a', 'gym')], [play('a', NOW + 1, 190_000)], []);
  assert.equal(unknown.byRadio[0].weightedCompletion, 1);
});

test('summarizeOutcomes: agrupa por rádio, origem e artista novo, e sinaliza amostra suficiente', () => {
  const exposures = Array.from({ length: 25 }, (_, i) => exposure(`t${i}`, 'gym', NOW, { source: i < 5 ? 'descoberta' : 'playlist', newArtist: i < 2 }));
  const plays = exposures.map((e, i) => play(`t${i}`, e.at + 1, 190_000));
  const report = summarizeOutcomes(exposures, plays, []);

  assert.equal(report.byRadio[0].enoughData, true);
  assert.deepEqual(report.bySource.map((s) => [s.group, s.heard]), [['playlist', 20], ['descoberta', 5]]);
  assert.deepEqual(report.byArtistNovelty.map((s) => [s.group, s.heard]), [['artista conhecido', 23], ['artista novo', 2]]);
});

test('summarizeOutcomes: sem nada exposto devolve relatório vazio', () => {
  const empty = summarizeOutcomes([], [], []);
  assert.equal(empty.exposures, 0);
  assert.deepEqual(empty.byRadio, []);
  assert.equal(empty.experiment.verdict, 'coletando');
  assert.equal(empty.experiment.runsMissing, 20);
  assert.equal(empty.ranking.auc, null);
});

test('armazenamento: exposição grava, é idempotente por id e aparece na exportação', async () => {
  const storage = new MemoryStorage();
  await storage.saveExposures([exposure('a', 'gym')]);
  await storage.saveExposures([exposure('a', 'gym'), exposure('b', 'gym')]);
  assert.equal((await storage.getAllExposures()).length, 2);

  const manager = new DataPortabilityManager({ storage, blacklist: new BlacklistManager(storage) });
  const snapshot = await manager.buildSnapshot();
  assert.equal(snapshot.counts.radioExposures, 2);
  assert.equal(snapshot.radioExposures.length, 2);
});

test('importação: exposição volta sem duplicar, e registro inválido é recusado', async () => {
  const storage = new MemoryStorage();
  await storage.saveExposures([exposure('a', 'gym')]);
  const manager = new DataPortabilityManager({ storage, blacklist: new BlacklistManager(storage) });

  const report = await manager.importJson(JSON.stringify({
    schemaVersion: 2,
    ratings: [],
    radioExposures: [exposure('a', 'gym'), exposure('b', 'gym'), { id: 'x' }, null]
  }));

  assert.equal(report.addedExposures, 1);
  assert.equal(report.invalidRecords, 2);
  assert.equal((await storage.getAllExposures()).length, 2);
});

test('importação: origem da reprodução sobrevive, e valor desconhecido é descartado', async () => {
  const storage = new MemoryStorage();
  const manager = new DataPortabilityManager({ storage, blacklist: new BlacklistManager(storage) });
  await manager.importJson(JSON.stringify({
    schemaVersion: 2, ratings: [],
    playEvents: [{ ...play('a', NOW, 1000), origin: 'radio' }, { ...play('b', NOW, 1000), origin: 'hackeado' }]
  }));

  const stored = Object.fromEntries((await storage.getAllPlayEvents()).map((p) => [p.name, p.origin]));
  assert.equal(stored.a, 'radio');
  assert.equal(stored.b, undefined);
});

test('PlaybackHistoryTracker: grava a origem no início da reprodução, não no fim', async () => {
  const storage = new MemoryStorage();
  let active = new Set(['spotify:track:a']);
  const tracker = new PlaybackHistoryTracker(storage, undefined, () => NOW, (t) => (active.has(t.uri) ? 'radio' : 'organic'));

  await tracker.onTrackChange(track('a'));
  tracker.updateProgress(100_000);
  active = new Set();
  await tracker.onTrackChange(track('b'));
  tracker.updateProgress(100_000);
  await tracker.flush();

  const origin = Object.fromEntries((await storage.getAllPlayEvents()).map((p) => [p.name, p.origin]));
  assert.deepEqual(origin, { a: 'radio', b: 'organic' });
});

test('plasticidade: escuta completa de rádio pesa menos que a escolhida por você', async () => {
  const affinityAfter = async (origin: PlayEvent['origin']) => {
    const storage = new MemoryStorage();
    const preference = new PreferenceEngine(storage, () => NOW);
    await preference.init();
    const context = new NeuralContextModel(preference, { ...DEFAULT_FLAGS, plasticity: true });
    const event = { ...play('a', NOW - 1000, 190_000), artistUris: ['spotify:artist:x'], origin };
    context.fit([], [event]);
    return context.adjustment(track('z', 'x'), new Date(NOW));
  };

  const chosen = await affinityAfter('organic');
  const legacy = await affinityAfter(undefined);
  const radio = await affinityAfter('radio');
  assert.ok(chosen > radio, `${chosen} <= ${radio}`);
  assert.equal(chosen, legacy, 'histórico antigo, sem origem, continua contando como voluntário');
});

function history(size: number, startAt: number, seed: number, known: boolean): TrackRatingRecord[] {
  const random = seededRandom(seed);
  return Array.from({ length: size }, (_, i) => {
    const artist = known ? `band${i % 6}` : `one-off-${seed}-${i}`;
    const good = known ? i % 6 < 2 : random() < 0.4;
    const t = track(`s${seed}-${i}`, artist);
    return { uri: t.uri, rating: (good ? 5 : 2) as Rating, timestamp: startAt + i * 1_800_000, metadata: t };
  });
}

test('diagnóstico: separa as janelas e explica a queda por artistas nunca vistos', async () => {
  const old = history(120, NOW, 1, true);
  const recent = history(120, NOW + 200 * 1_800_000, 2, false);
  const all = [...old, ...recent];

  const report = await diagnoseEvaluation({ ratings: all, plays: [] }, { 'Nota por artista': baselineArtistMean }, [
    { label: 'antigas', ratings: old },
    { label: 'recentes', ratings: recent }
  ]);

  const [early, late] = report.windows;
  assert.equal(early.label, 'antigas');
  assert.equal(early.ratings, 120);
  assert.ok(Math.abs(early.knownArtistShare - 0.95) < 1e-12, 'só a primeira faixa de cada um dos 6 artistas é inédita');
  assert.equal(late.knownArtistShare, 0);
  assert.ok(early.ndcg['Nota por artista'] > late.ndcg['Nota por artista'], JSON.stringify(report.windows));
  assert.ok(Math.abs(early.positiveShare - 1 / 3) < 0.05);
  assert.ok(late.ndcg['Aleatório'] >= 0 && late.ndcg['Aleatório'] <= 1);
});

test('diagnóstico: janela sem amostra suficiente é marcada, não inventa número', async () => {
  const few = history(6, NOW, 3, true);
  const report = await diagnoseEvaluation({ ratings: few, plays: [] }, { 'Nota por artista': baselineArtistMean }, [{ label: 'pouco', ratings: few }]);
  assert.equal(report.windows[0].usableCuts, 0);
  assert.deepEqual(report.windows[0].ndcg, {});
});

test('randomRanker: determinístico por semente e diferente entre sementes', () => {
  const candidates = Array.from({ length: 30 }, (_, i) => track(`r${i}`));
  const order = (seed: number) => randomRanker(seed)(candidates, null as never, null as never).map((c) => c.track.uri);
  assert.deepEqual(order(1), order(1));
  assert.notDeepEqual(order(1), order(2));
  assert.equal(new Set(order(1)).size, 30);
});

test('chooseDiscoverySeeds: relacionados desconhecidos ganham as vagas depois de 3 favoritos', () => {
  const favorites = ['f1', 'f2', 'f3', 'f4', 'f5', 'f6'];
  const related = ['f2', 'k1', 'n1', 'k2', 'n2', 'n3', 'n4', 'n5', 'n6', 'n7'];
  const known = new Set([...favorites, 'k1', 'k2']);

  const seeds = chooseDiscoverySeeds(favorites, related, (artist) => known.has(artist));

  assert.deepEqual(seeds, ['f1', 'f2', 'f3', 'n1', 'n2', 'n3', 'n4', 'n5']);
});

test('chooseDiscoverySeeds: sem relacionados cai nos favoritos, sem repetir nem exceder 8', () => {
  const favorites = Array.from({ length: 12 }, (_, i) => `f${i}`);
  assert.deepEqual(chooseDiscoverySeeds(favorites, [], () => true), favorites.slice(0, 8));
  assert.deepEqual(chooseDiscoverySeeds([], ['a', 'a', 'b'], () => false), ['a', 'b']);
  assert.deepEqual(chooseDiscoverySeeds([], [], () => false), []);
});

/** A listener with known behavior, to check that the analysis finds what was put there and nothing else. */
function simulate(seed: number, runs: number, completion: { padrao: number; exploratorio: number }, runEffect = 0.1) {
  const random = seededRandom(seed);
  const exposures: RadioExposure[] = [];
  const plays: PlayEvent[] = [];

  for (let r = 0; r < runs; r++) {
    const arm = random() < 0.5 ? 'padrao' as const : 'exploratorio' as const;
    const at = NOW + r * DAY;
    const mood = (random() - 0.5) * 2 * runEffect;
    for (let p = 0; p < 12; p++) {
      const id = `r${r}p${p}`;
      exposures.push(exposure(id, 'gym', at, { runId: `run${r}`, arm }));
      plays.push(random() < completion[arm] + mood ? play(id, at + p + 1, 190_000) : play(id, at + p + 1, 10_000, true));
    }
  }
  return summarizeOutcomes(exposures, plays, []);
}

test('experimento: com menos de 10 rádios por variante não dá veredito', () => {
  const { experiment } = simulate(1, 12, { padrao: 0.3, exploratorio: 0.9 });
  assert.equal(experiment.verdict, 'coletando');
  assert.equal(experiment.difference, null);
  assert.ok(experiment.runsMissing > 0);
});

test('experimento: recupera um efeito real plantado na simulação, em 20 sementes', () => {
  let found = 0;
  for (let seed = 1; seed <= 20; seed++) {
    const { experiment } = simulate(seed, 60, { padrao: 0.5, exploratorio: 0.7 });
    assert.ok(Math.abs(experiment.difference! - 0.2) < 0.1, `semente ${seed}: ${experiment.difference}`);
    if (experiment.verdict === 'exploratório melhor') found++;
  }
  assert.ok(found >= 18, `detectou em ${found} de 20`);
});

test('experimento: sem efeito, quase nunca inventa diferença', () => {
  let falseAlarms = 0;
  for (let seed = 1; seed <= 200; seed++) {
    if (simulate(seed, 40, { padrao: 0.5, exploratorio: 0.5 }).experiment.verdict !== 'sem diferença detectável') falseAlarms++;
  }
  assert.ok(falseAlarms <= 22, `${falseAlarms} falsos alarmes em 200`);
});

test('experimento: a unidade é a rádio, não a faixa: humor da sessão não vira evidência falsa', () => {
  let falseAlarms = 0;
  for (let seed = 1; seed <= 200; seed++) {
    if (simulate(seed, 40, { padrao: 0.5, exploratorio: 0.5 }, 0.35).experiment.verdict !== 'sem diferença detectável') falseAlarms++;
  }
  assert.ok(falseAlarms <= 22, `${falseAlarms} falsos alarmes em 200`);
});

test('experimento: rádio com menos de 3 faixas ouvidas e rádio sem variante ficam de fora', () => {
  const exposures = [
    exposure('a', 'gym', NOW, { runId: 'x', arm: 'padrao' }),
    exposure('b', 'gym', NOW, { runId: 'x', arm: 'padrao' }),
    exposure('c', 'Deep Cuts', NOW, { runId: 'y' })
  ];
  const report = summarizeOutcomes(exposures, exposures.map((e, i) => play(e.uri.split(':')[2], NOW + i + 1, 190_000)), []);
  assert.deepEqual(report.experiment.runs, { padrao: 0, exploratorio: 0 });
});

function rankingWorld(seed: number, informative: boolean) {
  const random = seededRandom(seed);
  const exposures: RadioExposure[] = [];
  const plays: PlayEvent[] = [];
  for (let i = 0; i < 200; i++) {
    const score = random() * 100;
    const chance = informative ? score / 100 : 0.5;
    exposures.push(exposure(`s${i}`, 'gym', NOW, { score }));
    plays.push(random() < chance ? play(`s${i}`, NOW + 1, 190_000) : play(`s${i}`, NOW + 1, 10_000, true));
  }
  return summarizeOutcomes(exposures, plays, []).ranking;
}

test('ordenação em inéditas: pontuação informativa supera o acaso e pontuação inútil fica em 50%', () => {
  const useful = rankingWorld(3, true);
  const useless = rankingWorld(3, false);
  assert.ok(useful.auc! > 0.75, `${useful.auc}`);
  assert.ok(Math.abs(useless.auc! - 0.5) < 0.1, `${useless.auc}`);
});

test('ordenação em inéditas: sem 10 de cada lado não publica número', () => {
  const few = summarizeOutcomes(
    [exposure('a', 'gym', NOW, { score: 90 }), exposure('b', 'gym', NOW, { score: 10 })],
    [play('a', NOW + 1, 190_000), play('b', NOW + 1, 1_000, true)],
    []
  );
  assert.deepEqual(few.ranking, { completed: 1, abandoned: 1, auc: null });
});

test('shufflePositions: mantém as faixas e distribui as posições de forma uniforme', () => {
  const random = seededRandom(5);
  const first = new Array(4).fill(0);
  for (let n = 0; n < 8000; n++) {
    const shuffled = shufflePositions([0, 1, 2, 3], random);
    assert.deepEqual([...shuffled].sort(), [0, 1, 2, 3]);
    first[shuffled[0]]++;
  }
  for (const count of first) assert.ok(Math.abs(count - 2000) < 150, String(first));
});

test('buildExposures: grava variante e pontuação, e a importação as preserva', async () => {
  const [record] = buildExposures({
    runId: 'r', radio: 'gym', at: NOW, tracks: [track('a')], sourceOf: () => 'playlist', isNewArtist: () => false,
    arm: 'exploratorio', scoreOf: () => 72
  });
  assert.equal(record.arm, 'exploratorio');
  assert.equal(record.score, 72);

  const storage = new MemoryStorage();
  const manager = new DataPortabilityManager({ storage, blacklist: new BlacklistManager(storage) });
  await manager.importJson(JSON.stringify({ schemaVersion: 2, ratings: [], radioExposures: [record, { ...record, id: 'r:9', arm: 'golpe', score: 'x' }] }));
  const stored = Object.fromEntries((await storage.getAllExposures()).map((e) => [e.id, e]));
  assert.equal(stored['r:0'].arm, 'exploratorio');
  assert.equal(stored['r:9'].arm, undefined);
  assert.equal(stored['r:9'].score, undefined);
});
