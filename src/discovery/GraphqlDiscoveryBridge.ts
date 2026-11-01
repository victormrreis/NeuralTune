import { DiscoveryBridge, DiscoveryCandidate } from './AutonomousDiscoveryCrawler.ts';
import { TrackMetadata } from '../types/index.ts';
import { withTimeout } from '../core/AsyncGuards.ts';

export type GraphqlRequest = (operation: string, variables: Record<string, unknown>) => Promise<unknown>;
export const GraphqlRequest = {};

/** A persisted query can stay pending forever: past the limit it fails like any other request. */
export function timedRequest(request: GraphqlRequest, ms: number): GraphqlRequest {
  return (operation, variables) => withTimeout(request(operation, variables), ms, operation);
}

const MAX_WALK_DEPTH = 14;
const PAGE_SIZE = 50;
const TOP_TRACKS_LIMIT = 200;
const DEEP_TRACKS_PER_ARTIST = 6;
const DEEP_TRACKS_PER_ALBUM = 4;
const RESOLVE_CONCURRENCY = 5;

function walk(value: unknown, visit: (node: Record<string, unknown>) => void, depth: number = 0): void {
  if (depth > MAX_WALK_DEPTH || typeof value !== 'object' || value === null) return;

  if (Array.isArray(value)) {
    for (const item of value) walk(item, visit, depth + 1);
    return;
  }

  const node = value as Record<string, unknown>;
  visit(node);
  for (const child of Object.values(node)) walk(child, visit, depth + 1);
}

/** Response layouts are undocumented and change, so URIs are found by shape instead of by path. */
export function collectUris(value: unknown, prefix: string): string[] {
  const found = new Set<string>();
  walk(value, (node) => {
    if (typeof node.uri === 'string' && node.uri.startsWith(prefix)) found.add(node.uri);
  });
  return Array.from(found);
}

/** Spotify's play count, on a log scale reaching 100 at a billion plays. Null when absent. */
export function popularityFromPlaycount(playcount: unknown): number | null {
  const plays = typeof playcount === 'string' ? Number(playcount) : playcount;
  if (typeof plays !== 'number' || !Number.isFinite(plays) || plays < 0) return null;
  return Math.min(100, (Math.log10(1 + plays) / 9) * 100);
}

export function collectTracks(value: unknown, albumUri: string): DiscoveryCandidate[] {
  const tracks = new Map<string, DiscoveryCandidate>();

  walk(value, (node) => {
    const { uri, name } = node;
    if (typeof uri !== 'string' || !uri.startsWith('spotify:track:') || typeof name !== 'string') return;

    const artists: TrackMetadata['artists'] = [];
    walk(node.artists, (artist) => {
      if (typeof artist.uri === 'string' && artist.uri.startsWith('spotify:artist:')) {
        const profile = artist.profile as { name?: unknown } | undefined;
        const label = typeof artist.name === 'string' ? artist.name : typeof profile?.name === 'string' ? profile.name : '';
        artists.push({ name: label, uri: artist.uri });
      }
    });

    tracks.set(uri, {
      track: { uri, name, artists, album: { name: '', uri: albumUri } },
      popularity: popularityFromPlaycount(node.playcount)
    });
  });

  return Array.from(tracks.values());
}

/** Without play counts, the position in the artist's own ranking stands in: first is 100, last near 0. */
export function popularityFromRank(position: number, total: number): number {
  return total > 0 ? 100 * (1 - position / total) : 50;
}

async function resolveTrack(request: GraphqlRequest, uri: string, popularity: number | null): Promise<DiscoveryCandidate | null> {
  try {
    const [nameResponse, artistsResponse] = await Promise.all([
      request('getTrackName', { uri }) as Promise<{ data?: { trackUnion?: { name?: unknown } } }>,
      request('queryTrackArtists', { trackUri: uri })
    ]);

    const name = nameResponse?.data?.trackUnion?.name;
    const artists: TrackMetadata['artists'] = [];
    walk(artistsResponse, (node) => {
      if (typeof node.uri === 'string' && node.uri.startsWith('spotify:artist:')) {
        const profile = node.profile as { name?: unknown } | undefined;
        artists.push({ name: typeof profile?.name === 'string' ? profile.name : '', uri: node.uri });
      }
    });

    // Without the artists a block could not be honored, so the track is dropped rather than guessed
    if (typeof name !== 'string' || artists.length === 0) return null;
    return { track: { uri, name, artists, album: { name: '', uri: '' } }, popularity };
  } catch {
    return null;
  }
}

/**
 * Uses only operations the client loads at startup. They list an artist's most played tracks, not
 * albums, so "deep" here means the far end of that ranking outside the user's history: a substitute for
 * walking the discography, which needs operations that only load with an artist page.
 */
export function createTopTracksDiscoveryBridge(request: GraphqlRequest): DiscoveryBridge {
  return {
    fetchArtistAlbums: async () => [],
    fetchAlbumTracks: async () => [],
    async fetchArtistTracks(artistUri: string, excluded: ReadonlySet<string>) {
      const response = await request('getArtistNameAndTracks', { uri: artistUri, offset: 0, limit: TOP_TRACKS_LIMIT });
      const uris = collectUris(response, 'spotify:track:');

      const deepest = uris
        .map((uri, position) => ({ uri, popularity: popularityFromRank(position, uris.length) }))
        .filter(({ uri }) => !excluded.has(uri))
        .slice(-DEEP_TRACKS_PER_ARTIST);

      const resolved = await Promise.all(deepest.map(({ uri, popularity }) => resolveTrack(request, uri, popularity)));
      return resolved.filter((candidate): candidate is DiscoveryCandidate => candidate !== null);
    },
    async fetchAlbumDeepCuts(albumUri: string, excluded: ReadonlySet<string>) {
      const response = await request('getAlbumNameAndTracks', { uri: albumUri, offset: 0, limit: TOP_TRACKS_LIMIT });
      const unheard = collectUris(response, 'spotify:track:').filter((uri) => !excluded.has(uri));

      // Album order puts singles first more often than not, so the later tracks are tried first
      const chosen = unheard.slice(-DEEP_TRACKS_PER_ALBUM);
      const resolved = await Promise.all(chosen.map((uri) => resolveTrack(request, uri, null)));
      return resolved
        .filter((candidate): candidate is DiscoveryCandidate => candidate !== null)
        .map((candidate) => ({ ...candidate, track: { ...candidate.track, album: { name: '', uri: albumUri } } }));
    }
  };
}

export function createGraphqlDiscoveryBridge(
  request: GraphqlRequest,
  locale: string = '',
  definitions?: Record<string, unknown>
): DiscoveryBridge {
  const topTracksBridge = createTopTracksDiscoveryBridge(request);
  const hasAlbumTracksOp = !definitions || Boolean(definitions.queryAlbumTracks);

  return {
    async fetchArtistAlbums(artistUri: string) {
      if (!hasAlbumTracksOp) return [];
      const response = await request('queryArtistDiscographyAlbums', { uri: artistUri, offset: 0, limit: PAGE_SIZE });
      return collectUris(response, 'spotify:album:');
    },
    async fetchAlbumTracks(albumUri: string) {
      if (!hasAlbumTracksOp) return [];
      const response = await request('queryAlbumTracks', { uri: albumUri, locale, offset: 0, limit: PAGE_SIZE });
      const tracks = collectTracks(response, albumUri);
      const withArtists = tracks.filter((c) => c.track.artists.length > 0);
      if (withArtists.length > 0) return withArtists;
      if (topTracksBridge.fetchAlbumDeepCuts) {
        return topTracksBridge.fetchAlbumDeepCuts(albumUri, new Set());
      }
      return [];
    },
    fetchArtistTracks: !hasAlbumTracksOp ? topTracksBridge.fetchArtistTracks : undefined,
    fetchAlbumDeepCuts: topTracksBridge.fetchAlbumDeepCuts
  };
}

/** Names and artists through the client's own operations, for when the Web API answers 429. */
export async function resolveTrackMetadata(request: GraphqlRequest, uris: readonly string[]): Promise<Map<string, TrackMetadata>> {
  const resolved = new Map<string, TrackMetadata>();

  for (let i = 0; i < uris.length; i += RESOLVE_CONCURRENCY) {
    const batch = await Promise.all(uris.slice(i, i + RESOLVE_CONCURRENCY).map((uri) => resolveTrack(request, uri, null)));
    for (const candidate of batch) {
      if (candidate) resolved.set(candidate.track.uri, candidate.track);
    }
  }

  return resolved;
}

/** Other artists the client relates to this one, for seeds beyond what the user already rated. */
export async function fetchRelatedArtists(request: GraphqlRequest, artistUri: string): Promise<string[]> {
  const response = await request('queryArtistRelated', { uri: artistUri, locale: '' });
  return collectUris(response, 'spotify:artist:').filter((uri) => uri !== artistUri);
}
