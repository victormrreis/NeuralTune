import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  camelotDistance,
  extractMorphology,
  seamCost,
  skipLevelAssociation,
  TrackMorphology
} from '../src/core/SegmentMorphologyEngine.ts';
import {
  CircadianClusterPrior,
  SessionChangeDetector,
  SessionState,
  besselI0,
  dayAngle,
  fitVonMises,
  hourAngle,
  vonMisesDensity
} from '../src/core/CircadianSessionController.ts';
import { calibrationDivergence, ipsWeight, normalizeDistribution, rerankCalibrated } from '../src/core/CalibratedRanker.ts';
import { AutonomousDiscoveryCrawler, DiscoveryBridge, discoveryGain } from '../src/discovery/AutonomousDiscoveryCrawler.ts';
import { collectTracks, collectUris, createGraphqlDiscoveryBridge, createTopTracksDiscoveryBridge, fetchRelatedArtists, popularityFromPlaycount, popularityFromRank } from '../src/discovery/GraphqlDiscoveryBridge.ts';
import { AutopilotBridge, AutopilotDaemon, DEFAULT_CHOICE_WEIGHTS, choiceObjective } from '../src/queue/AutopilotDaemon.ts';
import { BlacklistManager } from '../src/core/BlacklistManager.ts';
import { PreferenceEngine } from '../src/core/PreferenceEngine.ts';
import { MemoryStorage } from '../src/storage/MemoryStorage.ts';
import { DataPortabilityManager, DOSSIER_EXPORT_FILENAME } from '../src/storage/DataPortabilityManager.ts';
import { powerIterationPca, symmetricEigen } from '../src/math/LinearAlgebra.ts';
import { constellationSvg, escapeMarkup, radarSvg, barChartSvg } from '../src/ui/TasteVisualizer.ts';
import { probeCapabilities } from '../src/core/ApiCapabilityProbe.ts';
import { DEFAULT_FLAGS, loadFlags, saveFlags } from '../src/core/FeatureFlags.ts';
import { resolveShortcut } from '../src/ui/KeyboardShortcuts.ts';
import { QueueStateSummary, Rating, TrackMetadata } from '../src/types/index.ts';

function morphologyPayload(level: (t: number) => number, seconds: number = 200) {
  return {
    track: { tempo: 120 },
    segments: Array.from({ length: seconds * 2 }, (_, i) => {
      const start = i / 2;
      const pitches = new Array<number>(12).fill(0.1);
      pitches[0] = 1;
      pitches[4] = 0.8;
      pitches[7] = 0.9;
      return { start, duration: 0.5, loudness_max: level(start), pitches, timbre: [40, level(start) + 40, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] };
    })
  };
}

const arc = (t: number) => (t < 5 ? -50 : t > 195 ? -50 : t > 90 && t < 130 ? -6 : -14);

test('Morphology: finds audible bounds past fades and the loudest window as core', () => {
  const morphology = extractMorphology(morphologyPayload(arc))!;

  assert.ok(morphology.core.loudness > morphology.intro.loudness + 3);
  assert.ok(morphology.intro.loudness > -20, 'fade-in was skipped');
  assert.ok(morphology.outro.loudness > -20, 'fade-out was skipped');
  assert.equal(morphology.timeline.length, 40);
});

test('Morphology: without temporal data there is nothing to extract', () => {
  assert.equal(extractMorphology({ track: { tempo: 120 } }), null);
});

test('Camelot distance: a metric-like count around the wheel', () => {
  const key = (number: number, letter: 'A' | 'B') => ({ number, letter });
  assert.equal(camelotDistance(key(8, 'A'), key(8, 'A')), 0);
  assert.equal(camelotDistance(key(12, 'A'), key(1, 'A')), 1);
  assert.equal(camelotDistance(key(8, 'A'), key(8, 'B')), 1);
  assert.equal(camelotDistance(key(1, 'A'), key(7, 'A')), 6);
});

function section(loudness: number, number: number = 8): TrackMorphology['intro'] {
  return { loudness, brightness: 0, density: 3, camelot: { number, letter: 'A' } };
}

function ends(outro: TrackMorphology['intro'], intro: TrackMorphology['intro'], bpm: number = 120): TrackMorphology {
  return { intro, core: intro, outro, bpm, timeline: [] };
}

test('Seam: zero for a perfect match, and it grows with each discontinuity', () => {
  const base = ends(section(-10), section(-10));

  assert.equal(seamCost(base, base), 0);
  assert.ok(seamCost(base, ends(section(-10), section(-20))) > 0);
  assert.ok(seamCost(base, ends(section(-10), section(-10, 2))) > seamCost(base, ends(section(-10), section(-10, 9))));
  assert.ok(seamCost(base, ends(section(-10), section(-10), 140)) > seamCost(base, ends(section(-10), section(-10), 121)));
  assert.equal(seamCost(base, ends(section(-10), section(-10), 60)), 0, 'half time is the same pulse');
});

test('Skip attribution: refuses to answer under 12 skips', () => {
  const few = Array.from({ length: 11 }, () => ({ timeline: [-10, -10, -10, -10, -40, -40, -10, -10], skippedAtMs: 25_000 }));
  const result = skipLevelAssociation(few);

  assert.equal(result.supported, false);
  assert.equal(result.meanDifference, 0);
});

test('Skip attribution: reports an interval that includes zero when there is no pattern', () => {
  const skips = Array.from({ length: 40 }, (_, i) => ({
    timeline: Array.from({ length: 20 }, (_, bin) => -10 + Math.sin(bin * 1.7 + i * 2.3) * 3),
    skippedAtMs: (5 + (i % 10)) * 5000
  }));

  const result = skipLevelAssociation(skips);
  assert.equal(result.supported, true);
  assert.ok(result.low < 0 && result.high > 0, `${result.low}..${result.high}`);
});

test('Skip attribution: finds a real level difference, as an association with an interval', () => {
  const skips = Array.from({ length: 30 }, (_, i) => {
    const timeline = new Array<number>(20).fill(-10 + (i % 3));
    timeline[6] = -25;
    timeline[7] = -25;
    return { timeline, skippedAtMs: 38_000 };
  });

  const result = skipLevelAssociation(skips);
  assert.ok(result.high < 0);
  assert.equal('cause' in result, false);
});

test('Von Mises: integrates to 1 and is periodic, including across midnight', () => {
  for (const kappa of [0, 0.5, 2, 10]) {
    let integral = 0;
    const steps = 20_000;
    for (let i = 0; i < steps; i++) integral += vonMisesDensity((2 * Math.PI * i) / steps, 1, kappa) * ((2 * Math.PI) / steps);
    assert.ok(Math.abs(integral - 1) < 1e-6, `κ=${kappa}`);
  }

  assert.ok(Math.abs(vonMisesDensity(0.3, 1, 3) - vonMisesDensity(0.3 + 2 * Math.PI, 1, 3)) < 1e-12);
});

test('Von Mises: 23:59 and 00:00 are neighbors, as a linear hour would not be', () => {
  const lateNight = fitVonMises([hourAngle(new Date(2026, 0, 1, 23, 30)), hourAngle(new Date(2026, 0, 2, 0, 30))]);
  assert.ok(Math.cos(lateNight.mu) > 0.99);

  const justBefore = vonMisesDensity(hourAngle(new Date(2026, 0, 1, 23, 59)), 0, 4);
  const justAfter = vonMisesDensity(hourAngle(new Date(2026, 0, 2, 0, 0)), 0, 4);
  assert.ok(Math.abs(justBefore - justAfter) < 0.01);
});

test('Bessel I₀: reference values', () => {
  assert.equal(besselI0(0), 1);
  assert.ok(Math.abs(besselI0(1) - 1.2660658777520084) < 1e-12);
  assert.ok(Math.abs(besselI0(5) - 27.239871823604442) < 1e-9);
});

test('Von Mises fit: recovers concentrated data and shrinks with few samples', () => {
  const many = Array.from({ length: 500 }, (_, i) => 2 + Math.sin(i) * 0.2);
  const fitted = fitVonMises(many);
  assert.ok(Math.abs(fitted.mu - 2) < 0.05);
  assert.ok(fitted.kappa > 10);

  assert.ok(fitVonMises([2, 2]).kappa < fitted.kappa);
  assert.equal(fitVonMises([]).kappa, 0);
});

test('Circadian prior: learns who plays when, and falls back to shares with no pattern', () => {
  const prior = new CircadianClusterPrior();
  const at = (day: number, hour: number) => new Date(2026, 0, day, hour).getTime();

  prior.fit([
    ...Array.from({ length: 40 }, (_, i) => ({ cluster: 0, timestamp: at(1 + (i % 28), 8) })),
    ...Array.from({ length: 40 }, (_, i) => ({ cluster: 1, timestamp: at(1 + (i % 28), 22) }))
  ]);

  assert.ok(prior.posterior(new Date(2026, 1, 3, 8)).get(0)! > 0.9);
  assert.ok(prior.posterior(new Date(2026, 1, 3, 22)).get(1)! > 0.9);

  const sparse = new CircadianClusterPrior();
  sparse.fit([{ cluster: 0, timestamp: at(1, 8) }, { cluster: 1, timestamp: at(2, 20) }]);
  const shares = sparse.posterior(new Date(2026, 1, 3, 8));
  assert.ok(Math.abs(shares.get(0)! - 0.5) < 0.35);
});

test('Circadian prior: dayAngle covers the week', () => {
  assert.equal(dayAngle(new Date(2026, 9, 25)), 0);
  assert.ok(Math.abs(dayAngle(new Date(2026, 9, 28)) - (2 * Math.PI * 3) / 7) < 1e-12);
});

test('CUSUM: S_t follows max(0, S + r̂ - r - δ)', () => {
  const detector = new SessionChangeDetector({ drift: 0.1, threshold: 100, minEvents: 1 });
  detector.update(0.5, 0.2);
  assert.ok(Math.abs(detector.getStatistic() - 0.2) < 1e-12);
  detector.update(0.5, 0.9);
  assert.equal(detector.getStatistic(), 0);
});

test('CUSUM: two skips are not a pivot', () => {
  const detector = new SessionChangeDetector();
  assert.equal(detector.update(0.9, 0), false);
  assert.equal(detector.update(0.9, 0), false);
});

test('CUSUM: a sustained shortfall pivots, then a cooldown prevents flapping', () => {
  const detector = new SessionChangeDetector();
  const fired: number[] = [];
  for (let i = 0; i < 30; i++) if (detector.update(0.9, 0)) fired.push(i);

  assert.ok(fired[0] >= 3 && fired[0] < 6);
  for (let i = 1; i < fired.length; i++) assert.ok(fired[i] - fired[i - 1] > 6);
});

test('CUSUM: noise around the expectation does not pivot', () => {
  const detector = new SessionChangeDetector();
  let fired = 0;
  for (let i = 0; i < 2000; i++) {
    const observed = 0.6 + Math.sin(i * 12.9898) * 0.2;
    if (detector.update(0.6, observed)) fired++;
  }
  assert.equal(fired, 0);
});

test('Session: a pivot lowers a cluster gradually without erasing it', () => {
  const session = new SessionState(0.5);
  session.reinforce(0, 6);
  session.reinforce(1, 2);
  assert.equal(session.active(), 0);

  session.pivot(0);
  assert.equal(session.distribution().get(0), 0.6);
  session.pivot(0);
  assert.equal(session.active(), 1);
  assert.ok(session.distribution().get(0)! > 0);
});

test('KL: zero at perfect calibration, positive otherwise, finite with an empty queue', () => {
  const target = new Map([[0, 0.7], [1, 0.3]]);

  assert.ok(Math.abs(calibrationDivergence(target, new Map([[0, 7], [1, 3]]), 10)) < 1e-12);
  assert.ok(calibrationDivergence(target, new Map([[0, 10]]), 10) > 0.1);
  assert.ok(Number.isFinite(calibrationDivergence(target, new Map(), 0)));
  assert.ok(Number.isFinite(calibrationDivergence(new Map([[0, 1e-12], [1, 1]]), new Map([[0, 1]]), 1, 1e-6)));
});

test('KL: distributions normalize, and an all-zero input stays harmless', () => {
  assert.deepEqual(normalizeDistribution(new Map([[0, 2], [1, 6]])), new Map([[0, 0.25], [1, 0.75]]));
  assert.deepEqual(normalizeDistribution(new Map([[0, 0]])), new Map([[0, 0]]));
});

function items(cluster: number, count: number, score: number) {
  return Array.from({ length: count }, (_, i) => ({ id: `${cluster}-${i}`, score: score - i / 1000, cluster, payload: null }));
}

test('Calibration: a dominant cluster no longer fills the list', () => {
  const pool = [...items(0, 20, 0.9), ...items(1, 20, 0.5)];
  const target = new Map([[0, 0.7], [1, 0.3]]);

  const minority = (lambda: number) => rerankCalibrated(pool, target, 10, lambda).filter((i) => i.cluster === 1).length;

  assert.equal(minority(0), 0);
  assert.equal(minority(0.99), 3);

  // The trade-off is monotonic: more λ never buys less calibration
  const curve = [0, 0.3, 0.5, 0.7, 0.8, 0.9, 0.99].map(minority);
  curve.forEach((value, i) => { if (i > 0) assert.ok(value >= curve[i - 1]); });
});

test('Calibration: λ = 0 is the score order, and it is deterministic', () => {
  const pool = [...items(0, 5, 0.9), ...items(1, 5, 0.95)];
  const first = rerankCalibrated(pool, new Map([[0, 1]]), 10, 0).map((i) => i.id);

  assert.deepEqual(first, [...pool].sort((a, b) => b.score - a.score).map((i) => i.id));
  assert.deepEqual(rerankCalibrated(pool, new Map([[0, 1]]), 10, 0).map((i) => i.id), first);
});

test('IPS: a play count is not a propensity', () => {
  assert.equal(ipsWeight({ propensity: null, reason: 'sem log de exposição' }), 1);
  assert.equal(ipsWeight({ propensity: 0.5, reason: 'sorteio próprio' }), 2);
  assert.equal(ipsWeight({ propensity: 0.001, reason: 'sorteio próprio' }), 10);
});

test('Discovery gain: the formula, always non-negative, zero for history', () => {
  assert.ok(Math.abs(discoveryGain(0.8, 50, false, 0.8) - 0.8 * (1 - 0.8 * 0.25)) < 1e-12);
  assert.equal(discoveryGain(0.8, 50, true), 0);
  assert.ok(discoveryGain(0.8, 100, false) > 0);
  assert.ok(discoveryGain(0.8, 10, false) > discoveryGain(0.8, 90, false));
  assert.equal(discoveryGain(-1, 50, false), 0);
  assert.ok(discoveryGain(0.8, 500, false) > 0, 'an out-of-range popularity is clamped');
});

function track(id: string, artist: string = id): TrackMetadata {
  return { uri: `spotify:track:${id}`, name: id, artists: [{ name: artist, uri: `spotify:artist:${artist}` }], album: { name: '', uri: '' } };
}

async function discovery(bridge: DiscoveryBridge) {
  const storage = new MemoryStorage();
  const blacklist = new BlacklistManager(storage);
  const preference = new PreferenceEngine(storage);
  await preference.init();
  return { storage, crawler: new AutonomousDiscoveryCrawler(bridge, blacklist, preference) };
}

test('Discovery: blocks, history and duplicates never pass, and one artist cannot fill the list', async () => {
  const { storage, crawler } = await discovery({
    fetchArtistAlbums: async (artist) => [`spotify:album:${artist}`],
    fetchAlbumTracks: async (album) => {
      const name = album.split(':')[2];
      return ['1', '2', '3', '4'].map((n) => ({ track: track(`${name}-${n}`, name), popularity: 20 }));
    }
  });

  await storage.saveRating({ uri: 'spotify:track:a-1', rating: 0, timestamp: 1, metadata: track('a-1', 'a') });

  const found = await crawler.crawl(['a', 'b'], new Set(['spotify:track:a-2']), 4);
  const uris = found.map((f) => f.track.uri);

  assert.ok(!uris.includes('spotify:track:a-1'));
  assert.ok(!uris.includes('spotify:track:a-2'));
  assert.equal(new Set(uris).size, uris.length);
  assert.equal(found.filter((f) => f.sourceArtist === 'a').length, 2);
});

test('Discovery fallback: ranks only saved tracks outside history, and blocks still apply', async () => {
  const { storage, crawler } = await discovery({ fetchArtistAlbums: async () => [], fetchAlbumTracks: async () => [] });
  await storage.saveRating({ uri: 'spotify:track:bad', rating: 0, timestamp: 1, metadata: track('bad') });

  const found = crawler.rankLocal([track('new'), track('heard'), track('bad')], new Set(['spotify:track:heard']));

  assert.deepEqual(found.map((f) => f.track.uri), ['spotify:track:new']);
});

test('Discovery: a refusing API yields an empty result, not an error or fake tracks', async () => {
  const warn = console.warn;
  console.warn = () => undefined;
  const { crawler } = await discovery({
    fetchArtistAlbums: async () => { throw { status: 403 }; },
    fetchAlbumTracks: async () => []
  });

  assert.deepEqual(await crawler.crawl(['a'], new Set()), []);
  console.warn = warn;
});

test('GraphQL discovery: finds URIs by shape, whatever the nesting', () => {
  const response = { data: { artistUnion: { discography: { albums: { items: [{ releases: { items: [{ uri: 'spotify:album:a' }, { uri: 'spotify:album:b' }] } }, { uri: 'spotify:album:a' }] } }, uri: 'spotify:artist:x' } } };

  assert.deepEqual(collectUris(response, 'spotify:album:'), ['spotify:album:a', 'spotify:album:b']);
  assert.deepEqual(collectUris(null, 'spotify:album:'), []);
});

test('GraphQL discovery: reads tracks, artists and play count', () => {
  const response = { data: { albumUnion: { tracksV2: { items: [{ track: {
    uri: 'spotify:track:t', name: 'Deep Cut', playcount: '123456',
    artists: { items: [{ uri: 'spotify:artist:a', profile: { name: 'Banda' } }] }
  } }] } } } };

  const [candidate] = collectTracks(response, 'spotify:album:x');
  assert.equal(candidate.track.name, 'Deep Cut');
  assert.deepEqual(candidate.track.artists, [{ name: 'Banda', uri: 'spotify:artist:a' }]);
  assert.equal(candidate.track.album.uri, 'spotify:album:x');
  assert.ok(candidate.popularity! > 50 && candidate.popularity! < 60);
});

test('GraphQL discovery: popularity is monotonic, capped, and absent stays absent', () => {
  assert.ok(popularityFromPlaycount(1000)! < popularityFromPlaycount(1e6)!);
  assert.equal(popularityFromPlaycount(1e12), 100);
  assert.equal(popularityFromPlaycount(undefined), null);
  assert.equal(popularityFromPlaycount('abc'), null);
});

test('GraphQL discovery: sends the variables the client expects, and related excludes the artist', async () => {
  const calls: Array<[string, Record<string, unknown>]> = [];
  const request = async (operation: string, variables: Record<string, unknown>) => {
    calls.push([operation, variables]);
    return { items: [{ uri: 'spotify:artist:me' }, { uri: 'spotify:artist:other' }] };
  };

  await createGraphqlDiscoveryBridge(request).fetchArtistAlbums('spotify:artist:me');
  await createGraphqlDiscoveryBridge(request).fetchAlbumTracks('spotify:album:x');

  assert.equal(calls[0][0], 'queryArtistDiscographyAlbums');
  assert.deepEqual(Object.keys(calls[1][1]).sort(), ['limit', 'locale', 'offset', 'uri']);
  assert.deepEqual(await fetchRelatedArtists(request, 'spotify:artist:me'), ['spotify:artist:other']);
});

function topTracksClient(total: number, overrides: Partial<Record<string, unknown>> = {}) {
  const calls: Array<[string, Record<string, unknown>]> = [];
  const request = async (operation: string, variables: Record<string, unknown>) => {
    calls.push([operation, variables]);
    if (operation in overrides) return overrides[operation];

    if (operation === 'getArtistNameAndTracks') {
      return { data: { artistUnion: { __typename: 'Artist', discography: { topTracks: { items: Array.from({ length: total }, (_, i) => ({ track: { uri: `spotify:track:rank${i}` } })) } } } } };
    }
    if (operation === 'getTrackName') return { data: { trackUnion: { __typename: 'Track', name: `Nome ${variables.uri}` } } };
    return { data: { trackUnion: { artists: { items: [{ uri: 'spotify:artist:main', profile: { name: 'Banda' } }] } } } };
  };
  return { calls, request };
}

test('Top tracks bridge: sends the variables the client uses, one per operation', async () => {
  const { calls, request } = topTracksClient(3);
  await createTopTracksDiscoveryBridge(request).fetchArtistTracks!('spotify:artist:a', new Set());

  assert.deepEqual(calls[0], ['getArtistNameAndTracks', { uri: 'spotify:artist:a', offset: 0, limit: 200 }]);
  assert.deepEqual(calls.find(([op]) => op === 'getTrackName')?.[1], { uri: 'spotify:track:rank0' });
  assert.deepEqual(calls.find(([op]) => op === 'queryTrackArtists')?.[1], { trackUri: 'spotify:track:rank0' });
});

test('Top tracks bridge: takes the far end of the ranking, skipping what was heard', async () => {
  const { request } = topTracksClient(100);
  const heard = new Set(['spotify:track:rank99', 'spotify:track:rank98']);

  const found = await createTopTracksDiscoveryBridge(request).fetchArtistTracks!('spotify:artist:a', heard);

  assert.deepEqual(found.map((f) => f.track.uri), [92, 93, 94, 95, 96, 97].map((n) => `spotify:track:rank${n}`));
  assert.ok(found.every((f) => f.popularity! < 10));
  assert.equal(found[0].track.artists[0].name, 'Banda');
});

test('Top tracks bridge: a track with no name or artists is dropped, never guessed', async () => {
  const noArtists = topTracksClient(3, { queryTrackArtists: { data: { trackUnion: { artists: { items: [] } } } } });
  const noName = topTracksClient(3, { getTrackName: { data: {} } });

  assert.deepEqual(await createTopTracksDiscoveryBridge(noArtists.request).fetchArtistTracks!('a', new Set()), []);
  assert.deepEqual(await createTopTracksDiscoveryBridge(noName.request).fetchArtistTracks!('a', new Set()), []);
});

test('Top tracks bridge: an artist with an empty ranking yields nothing', async () => {
  const { request } = topTracksClient(0);
  assert.deepEqual(await createTopTracksDiscoveryBridge(request).fetchArtistTracks!('a', new Set()), []);
});

function albumClient(uris: string[]) {
  const calls: Array<[string, Record<string, unknown>]> = [];
  const base = topTracksClient(0);
  const request = async (operation: string, variables: Record<string, unknown>) => {
    calls.push([operation, variables]);
    if (operation === 'getAlbumNameAndTracks') {
      return { data: { albumUnion: { __typename: 'Album', tracksV2: { items: uris.map((uri) => ({ track: { uri } })) } } } };
    }
    return base.request(operation, variables);
  };
  return { calls, request };
}

test('Album deep cuts: read the album, skip what was heard, keep the album and unknown popularity', async () => {
  const tracks = ['1', '2', '3', '4', '5', '6'].map((n) => `spotify:track:a${n}`);
  const { calls, request } = albumClient(tracks);

  const found = await createTopTracksDiscoveryBridge(request).fetchAlbumDeepCuts!('spotify:album:x', new Set(['spotify:track:a6']));

  assert.deepEqual(calls[0], ['getAlbumNameAndTracks', { uri: 'spotify:album:x', offset: 0, limit: 200 }]);
  assert.deepEqual(found.map((f) => f.track.uri), ['a2', 'a3', 'a4', 'a5'].map((n) => `spotify:track:${n}`));
  assert.ok(found.every((f) => f.popularity === null && f.track.album.uri === 'spotify:album:x'));
});

test('Album deep cuts: the crawler uses rated albums, and history still excludes tracks', async () => {
  const { request } = albumClient(['spotify:track:new', 'spotify:track:heard']);
  const storage = new MemoryStorage();
  const preference = new PreferenceEngine(storage);
  await preference.init();
  const crawler = new AutonomousDiscoveryCrawler(createTopTracksDiscoveryBridge(request), new BlacklistManager(storage), preference);

  const found = await crawler.crawl([], new Set(['spotify:track:heard']), 10, ['spotify:album:x']);

  assert.deepEqual(found.map((f) => f.track.uri), ['spotify:track:new']);
  assert.equal(found[0].sourceArtist, 'spotify:album:x');
});

test('Rank popularity: first is highest, unknown is neutral', () => {
  assert.equal(popularityFromRank(0, 10), 100);
  assert.ok(Math.abs(popularityFromRank(9, 10) - 10) < 1e-9);
  assert.equal(popularityFromRank(0, 0), 50);
});

test('Discovery: top tracks path respects blocks, including a blocked featured artist', async () => {
  const { request } = topTracksClient(4);
  const storage = new MemoryStorage();
  const preference = new PreferenceEngine(storage);
  await preference.init();
  await storage.blockArtist({ artistUri: 'spotify:artist:main', artistName: 'Banda', timestamp: 1 });

  const crawler = new AutonomousDiscoveryCrawler(createTopTracksDiscoveryBridge(request), new BlacklistManager(storage), preference);
  assert.deepEqual(await crawler.crawl(['spotify:artist:seed'], new Set()), []);
});

test('Discovery: a failing artist does not stop the others', async () => {
  const warn = console.warn;
  console.warn = () => undefined;
  const good = topTracksClient(2);
  const flaky = async (operation: string, variables: Record<string, unknown>) => {
    if (operation === 'getArtistNameAndTracks' && variables.uri === 'bad') throw new Error('offline');
    return good.request(operation, variables);
  };

  const storage = new MemoryStorage();
  const preference = new PreferenceEngine(storage);
  await preference.init();
  const crawler = new AutonomousDiscoveryCrawler(createTopTracksDiscoveryBridge(flaky), new BlacklistManager(storage), preference);

  assert.equal((await crawler.crawl(['bad', 'good'], new Set())).length, 2);
  console.warn = warn;
});

test('Choice: normalized terms stay bounded, and engagement is framed as satisfaction', () => {
  const zero = { preference: 0, discovery: 0, continuity: 0, calibration: 0, satisfaction: 0, risk: 0 };

  assert.equal(choiceObjective(zero), 0);
  assert.ok(choiceObjective({ ...zero, preference: 1 }) > choiceObjective({ ...zero, discovery: 1 }));
  assert.ok(choiceObjective({ ...zero, preference: 1, risk: 1 }) < choiceObjective({ ...zero, preference: 1 }));
  assert.equal('timeOnPlatform' in DEFAULT_CHOICE_WEIGHTS, false);
});

class FakeQueue implements AutopilotBridge {
  state: QueueStateSummary = { current: track('now'), queued: [], nextUp: [] };
  added: string[] = [];
  messages: string[] = [];
  getQueueState() { return this.state; }
  async addToQueue(tracks: Array<{ uri: string }>) {
    this.added.push(...tracks.map((t) => t.uri));
    this.state.queued.push(...tracks.map((t) => track(t.uri.split(':')[2])));
  }
  notify(message: string) { this.messages.push(message); }
}

async function autopilot(propose: (excluded: ReadonlySet<string>) => TrackMetadata[]) {
  const storage = new MemoryStorage();
  const queue = new FakeQueue();
  const daemon = new AutopilotDaemon(queue, new BlacklistManager(storage), async (_c, excluded) => propose(excluded));
  return { storage, queue, daemon };
}

test('Autopilot: does nothing until switched on', async () => {
  const { queue, daemon } = await autopilot(() => [track('x')]);
  assert.equal(await daemon.tick(), 0);
  assert.deepEqual(queue.added, []);
});

test('Autopilot: tops up under 3 tracks, and rests at or above', async () => {
  const { queue, daemon } = await autopilot(() => [track('a'), track('b')]);
  daemon.toggle();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(queue.added, ['spotify:track:a', 'spotify:track:b']);

  queue.state.queued = [track('1'), track('2'), track('3')];
  assert.equal(await daemon.tick(), 0);
});

test('Autopilot: never adds a duplicate or a blocked track', async () => {
  const { storage, queue, daemon } = await autopilot(() => [track('now'), track('dup'), track('dup'), track('bad'), track('ok')]);
  await storage.saveRating({ uri: 'spotify:track:bad', rating: 0, timestamp: 1, metadata: track('bad') });
  queue.state.nextUp = [];

  daemon.toggle();
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(queue.added, ['spotify:track:dup', 'spotify:track:ok']);
});

test('Autopilot: switching off mid-selection stops before touching the queue', async () => {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const storage = new MemoryStorage();
  const queue = new FakeQueue();
  const daemon = new AutopilotDaemon(queue, new BlacklistManager(storage), async () => {
    await gate;
    return [track('late')];
  });

  daemon.toggle();
  daemon.toggle();
  release();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(daemon.isEnabled(), false);
  assert.deepEqual(queue.added, []);
});

test('Autopilot: recovers from what the client did to the queue', async () => {
  const { queue, daemon } = await autopilot((excluded) => (excluded.has('spotify:track:a') ? [track('b')] : [track('a')]));
  daemon.toggle();
  await new Promise((resolve) => setImmediate(resolve));

  queue.state.queued = []; // Spotify dropped what was queued
  await daemon.tick();

  assert.deepEqual(queue.added, ['spotify:track:a', 'spotify:track:b']);
});

test('Autopilot: a failing source or queue API is contained', async () => {
  const warn = console.warn;
  console.warn = () => undefined;
  const { queue, daemon } = await autopilot(() => { throw new Error('offline'); });

  daemon.toggle();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(await daemon.tick(), 0);
  assert.deepEqual(queue.added, []);
  console.warn = warn;
});

test('Shortcut: Ctrl+Alt+A is the physical key, other chords keep working', () => {
  assert.deepEqual(resolveShortcut({ ctrlKey: true, altKey: true, code: 'KeyA', key: 'á' }), { type: 'autopilot' });
  assert.deepEqual(resolveShortcut({ ctrlKey: true, altKey: true, code: 'KeyE', key: '°' }), { type: 'export' });
});

function randomCovariance(seed: number): number[][] {
  let state = seed;
  const next = () => {
    state = (state * 16807) % 2147483647;
    return state / 2147483647 - 0.5;
  };
  const raw = Array.from({ length: 8 }, () => Array.from({ length: 8 }, next));
  return raw.map((a) => raw.map((b) => a.reduce((sum, v, k) => sum + v * b[k], 0)));
}

test('PCA: |v₁ᵀv₂| < 10⁻⁶, unit axes, and agreement with Jacobi', () => {
  for (const seed of [3, 17, 91, 1001]) {
    const covariance = randomCovariance(seed);
    const pca = powerIterationPca(covariance);
    const eigen = symmetricEigen(covariance);

    assert.ok(pca.orthogonality < 1e-6, `${pca.orthogonality}`);
    for (const axis of pca.axes) assert.ok(Math.abs(axis.reduce((s, v) => s + v * v, 0) - 1) < 1e-9);
    assert.ok(Math.abs(pca.eigenvalues[0] - eigen[0].value) < 1e-6);
    assert.ok(Math.abs(pca.eigenvalues[1] - eigen[1].value) < 1e-6);
  }
});

test('PCA: explained variance on a known matrix, and a degenerate input stays finite', () => {
  const diagonal = Array.from({ length: 8 }, (_, i) => Array.from({ length: 8 }, (_, j) => (i === j ? (i === 0 ? 6 : i === 1 ? 2 : 0) : 0)));
  const pca = powerIterationPca(diagonal);

  assert.ok(Math.abs(pca.explained[0] - 0.75) < 1e-9);
  assert.ok(Math.abs(pca.explained[1] - 0.25) < 1e-9);

  const zero = powerIterationPca(Array.from({ length: 8 }, () => new Array<number>(8).fill(0)));
  assert.ok(zero.eigenvalues.every(Number.isFinite));
});

test('Visualizer: radar keeps the 8 real dimension names, and markup is escaped', () => {
  const svg = radarSvg([{ label: '<script>x</script>', values: [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, null, 0.5], color: '#fff' }]);

  for (const name of ['tempo', 'energy', 'valence', 'danceability', 'acousticness', 'instrumentalness', 'speechiness', 'liveness']) {
    assert.ok(svg.includes(`>${name}<`), name);
  }
  assert.ok(!svg.includes('<script>'));
  assert.equal(escapeMarkup('"<&'), '&#34;&#60;&#38;');
});

test('Visualizer: the map states how much of the space it shows', () => {
  const covariance = randomCovariance(5);
  const svg = constellationSvg([
    { coordinates: [1, 2, 3, 4, 5, 6, 7, 8], label: 'a', rating: 5, kind: 'track' },
    { coordinates: [8, 7, 6, 5, 4, 3, 2, 1], label: '<b>', kind: 'cluster' }
  ], powerIterationPca(covariance));

  assert.match(svg, /aproximam o espaço original/);
  assert.ok(!svg.includes('<b>'));
});

test('Visualizer: bar chart prints its values', () => {
  assert.ok(barChartSvg([{ label: '5★', value: 7 }]).includes('>7<'));
});

async function dossierFixture() {
  const storage = new MemoryStorage();
  const manager = new DataPortabilityManager({ storage, blacklist: new BlacklistManager(storage) });

  for (let i = 0; i < 6; i++) {
    await storage.saveRating({
      uri: `spotify:track:t${i}`,
      rating: i as Rating,
      timestamp: 1000 + i,
      metadata: { ...track(`faixa${i}`, 'Banda'), name: i === 5 ? '</script><img src=x onerror=alert(1)>' : `Faixa ${i}`, acousticFeatures: { energy: i / 5, bpm: 100 + i, camelot: '8A' } }
    });
  }
  await storage.savePlayEvent({ id: 'p', uri: 'spotify:track:t1', name: 'x', artistUris: [], startedAt: 5, endedAt: 9, playedMs: 8000, skipped: true });

  return manager;
}

test('Dossier: self-contained, with every required section', async () => {
  const { filename, content, mimeType } = await (await dossierFixture()).exportDossier({ results: {} });

  assert.equal(filename, DOSSIER_EXPORT_FILENAME);
  assert.equal(filename, 'neuraltune-dossier.html');
  assert.equal(mimeType, 'text/html');

  for (const heading of ['Distribuição das notas', 'Radar acústico', 'PCA', 'correlação acústica', 'Distribuição temporal', 'Skips', 'Qualidade das recomendações', 'Avaliações', 'Referências usadas', 'Limitações']) {
    assert.ok(content.includes(heading), heading);
  }

  assert.ok(!/<script[^>]+src=/i.test(content), 'no external script');
  assert.ok(!/<link[^>]+href=/i.test(content), 'no external style');
});

test('Dossier: a hostile track name cannot escape the embedded data', async () => {
  const { content } = await (await dossierFixture()).exportDossier();

  assert.ok(!content.includes('</script><img'));
  assert.ok(content.includes('\\u003c/script>'));
  assert.equal((content.match(/<\/script>/g) ?? []).length, 1);
});

test('Dossier: carries no credential-shaped field', async () => {
  const { content } = await (await dossierFixture()).exportDossier();
  assert.ok(!/token|bearer|authorization|password|cookie|spotify:user/i.test(content));
});

test('Probe: records what answered and what refused, shapes only', async () => {
  const report = await probeCapabilities([
    ['ok', async () => ({ segments: 3, token: 'x' })],
    ['refused', async () => { throw { status: 403 }; }],
    ['empty', async () => null],
    ['missing', async () => false]
  ], '1.3.6', new Date(0));

  assert.deepEqual(report.results.map((r) => r.available), [true, false, false, false]);
  assert.match(report.results[1].detail, /403/);
  assert.equal(report.clientVersion, '1.3.6');
  assert.ok(!JSON.stringify(report).includes('"x"'));
});

test('Flags: defaults on cold start, persistence, and corrupt storage falls back', () => {
  const data = new Map<string, string>();
  const store = { get: (k: string) => data.get(k) ?? null, set: (k: string, v: string) => void data.set(k, v) };

  assert.deepEqual(loadFlags(store), DEFAULT_FLAGS);

  saveFlags(store, { ...DEFAULT_FLAGS, circadian: true });
  assert.equal(loadFlags(store).circadian, true);

  data.set('neuraltune:flags', '{broken');
  assert.deepEqual(loadFlags(store), DEFAULT_FLAGS);
});
