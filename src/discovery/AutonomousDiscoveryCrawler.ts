import { BlacklistManager } from '../core/BlacklistManager.ts';
import { PreferenceEngine } from '../core/PreferenceEngine.ts';
import { TrackMetadata } from '../types/index.ts';

export interface DiscoveryCandidate {
  track: TrackMetadata;
  popularity: number | null; // Spotify's 0-100, when the source provides it
}
export const DiscoveryCandidate = {};

export interface DiscoveryBridge {
  fetchArtistAlbums(artistUri: string): Promise<string[]>;
  fetchAlbumTracks(albumUri: string): Promise<DiscoveryCandidate[]>;
  /** Replaces the album walk where album listings are unavailable. */
  fetchArtistTracks?(artistUri: string, excluded: ReadonlySet<string>): Promise<DiscoveryCandidate[]>;
  /** Tracks of an album the user already rated well, which is what makes a true deep cut. */
  fetchAlbumDeepCuts?(albumUri: string, excluded: ReadonlySet<string>): Promise<DiscoveryCandidate[]>;
}
export const DiscoveryBridge = {};

export interface DiscoveryResult {
  track: TrackMetadata;
  gain: number;
  score: number;
  popularity: number | null;
  sourceArtist: string;
}
export const DiscoveryResult = {};

const BETA_POPULARITY = 0.8;
const UNKNOWN_POPULARITY = 0.5;
const EXPLORATION_WEIGHT = 0.15;
const MAX_ARTISTS = 8;
const MAX_ALBUMS = 10;
const MAX_ALBUMS_PER_ARTIST = 4;
const CRAWL_BUDGET_MS = 8_000;
const FAVORITE_SEEDS = 3;

/**
 * DiscoveryGain(x) = Score(x) · (1 - β Pop(x)²) · I(x ∉ History), with Pop in [0, 1] and β < 1 so the
 * factor stays positive. Unknown popularity takes the middle: treating it as 0 would favor exactly the
 * tracks about which nothing is known.
 */
export function discoveryGain(score: number, popularity: number | null, inHistory: boolean, beta: number = BETA_POPULARITY): number {
  if (inHistory) return 0;
  const pop = popularity === null ? UNKNOWN_POPULARITY : Math.max(0, Math.min(1, popularity / 100));
  return Math.max(0, score) * (1 - beta * pop * pop);
}

/**
 * Most seeds go to artists the user has never rated: filled with favorites first, the walk spends its
 * whole budget on what the user already knows and reaches no one new. Known related artists and further
 * favorites only fill the slots left over.
 */
export function chooseDiscoverySeeds(
  favorites: readonly string[],
  related: readonly string[],
  isKnown: (artistUri: string) => boolean
): string[] {
  const unknown = related.filter((artist) => !isKnown(artist));
  const known = related.filter(isKnown);
  const ordered = [...favorites.slice(0, FAVORITE_SEEDS), ...unknown, ...known, ...favorites.slice(FAVORITE_SEEDS)];
  return Array.from(new Set(ordered)).slice(0, MAX_ARTISTS);
}

/** Round-robin by artist, so a prolific favorite cannot fill the whole result. */
function diversify(results: DiscoveryResult[], limit: number): DiscoveryResult[] {
  const buckets = new Map<string, DiscoveryResult[]>();
  for (const result of results) {
    const list = buckets.get(result.sourceArtist);
    if (list) list.push(result);
    else buckets.set(result.sourceArtist, [result]);
  }

  const queues = Array.from(buckets.values());
  const output: DiscoveryResult[] = [];
  while (output.length < limit && queues.some((queue) => queue.length > 0)) {
    for (const queue of queues) {
      const next = queue.shift();
      if (next && output.length < limit) output.push(next);
    }
  }
  return output;
}

/**
 * Deep cuts from artists already liked. Related-artist endpoints are not used: Spotify withdrew them
 * from the Web API, and this only walks what the bridge can actually reach. Every candidate goes through
 * BlacklistManager and PreferenceEngine.
 */
export class AutonomousDiscoveryCrawler {
  private bridge: DiscoveryBridge;
  private blacklist: BlacklistManager;
  private preference: PreferenceEngine;

  constructor(bridge: DiscoveryBridge, blacklist: BlacklistManager, preference: PreferenceEngine) {
    this.bridge = bridge;
    this.blacklist = blacklist;
    this.preference = preference;
  }

  /**
   * Same gain over tracks already at hand, for when the client's artist operations are not loaded:
   * saved tracks never rated or played. It is a smaller promise than discovery outside the library.
   */
  rankLocal(tracks: readonly TrackMetadata[], history: ReadonlySet<string>, limit: number = 30): DiscoveryResult[] {
    const results: DiscoveryResult[] = [];

    for (const track of tracks) {
      if (history.has(track.uri) || this.blacklist.isBlockedFast(track.uri, track.artists.map((a) => a.uri))) continue;

      const evaluation = this.preference.evaluateCandidate(track);
      if (!evaluation.eligible) continue;

      const score = evaluation.score / 100 + EXPLORATION_WEIGHT * evaluation.noveltyScore;
      results.push({
        track,
        gain: discoveryGain(score, null, false),
        score: evaluation.score,
        popularity: null,
        sourceArtist: track.artists[0]?.uri ?? ''
      });
    }

    results.sort((a, b) => b.gain - a.gain);
    return diversify(results, limit);
  }

  async crawl(
    seedArtists: readonly string[],
    history: ReadonlySet<string>,
    limit: number = 30,
    seedAlbums: readonly string[] = [],
    { budgetMs = CRAWL_BUDGET_MS }: { budgetMs?: number } = {}
  ): Promise<DiscoveryResult[]> {
    const results: DiscoveryResult[] = [];
    const seen = new Set<string>();

    // Whatever was found before the budget ends is a valid answer: a stalled seed must not cost the rest
    let outOfTime = false;
    let budget: ReturnType<typeof setTimeout>;
    const deadline = new Promise<null>((resolve) => {
      budget = setTimeout(() => {
        outOfTime = true;
        resolve(null);
      }, budgetMs);
    });
    const bounded = <T>(work: Promise<T>): Promise<T | null> => Promise.race([work, deadline]);

    const consider = ({ track, popularity }: DiscoveryCandidate, artist: string): void => {
      if (seen.has(track.uri)) return;
      seen.add(track.uri);

      if (this.blacklist.isBlockedFast(track.uri, track.artists.map((a) => a.uri))) return;

      const evaluation = this.preference.evaluateCandidate(track);
      if (!evaluation.eligible) return;

      const score = evaluation.score / 100 + EXPLORATION_WEIGHT * evaluation.noveltyScore;
      const gain = discoveryGain(score, popularity, history.has(track.uri));
      if (gain > 0) results.push({ track, gain, score: evaluation.score, popularity, sourceArtist: artist });
    };

    if (this.bridge.fetchAlbumDeepCuts) {
      for (const album of seedAlbums.slice(0, MAX_ALBUMS)) {
        if (outOfTime) break;
        try {
          for (const candidate of await bounded(this.bridge.fetchAlbumDeepCuts(album, history)) ?? []) consider(candidate, album);
        } catch (err) {
          console.warn('[NeuralTune] Descoberta: álbum indisponível', err);
        }
      }
    }

    for (const artist of seedArtists.slice(0, MAX_ARTISTS)) {
      if (outOfTime) break;
      try {
        if (this.bridge.fetchArtistTracks) {
          for (const candidate of await bounded(this.bridge.fetchArtistTracks(artist, history)) ?? []) consider(candidate, artist);
          continue;
        }

        const albums = await bounded(this.bridge.fetchArtistAlbums(artist)) ?? [];
        for (const album of albums.slice(0, MAX_ALBUMS_PER_ARTIST)) {
          if (outOfTime) break;
          const candidates = await bounded(this.bridge.fetchAlbumTracks(album).catch(() => [] as DiscoveryCandidate[])) ?? [];
          for (const candidate of candidates) consider(candidate, artist);
        }
      } catch (err) {
        console.warn('[NeuralTune] Descoberta: artista indisponível', err);
      }
    }

    clearTimeout(budget!);
    results.sort((a, b) => b.gain - a.gain);
    return diversify(results, limit);
  }
}
