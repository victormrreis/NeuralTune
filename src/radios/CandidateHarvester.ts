import { StorageAdapter } from '../storage/StorageAdapter.ts';
import { TimeoutError, withTimeout } from '../core/AsyncGuards.ts';
import { TrackMetadata } from '../types/index.ts';

export interface HarvestBridge {
  fetchLibraryPage(offset: number, limit: number): Promise<TrackMetadata[]>;
  listPlaylists(): Promise<string[]>;
  fetchPlaylistTracks(playlistUri: string): Promise<TrackMetadata[]>;
}
export const HarvestBridge = {};

export interface HarvestResult {
  tracks: TrackMetadata[];
  contexts: Map<string, string[]>;
  sources: { rated: number; library: number; playlists: number };
  ratedUris: Set<string>;
  libraryUris: Set<string>;
}
export const HarvestResult = {};

const LIBRARY_LIMIT = 5000;
const LIBRARY_PAGE = 100;
const MAX_PLAYLISTS = 40;
const MAX_TRACKS_PER_PLAYLIST = 500;
const CACHE_MS = 10 * 60_000;
const RETRY_MS = 3_000;
const CALL_TIMEOUT_MS = 8_000;
const BUDGET_MS = 20_000;

export interface HarvestConfig {
  timeoutMs?: number;
  budgetMs?: number;
}
export const HarvestConfig = {};

interface RemoteTracks {
  at: number;
  library: TrackMetadata[];
  contexts: Map<string, string[]>;
  listed: TrackMetadata[];
  partial: boolean;
}

/** Multi-source candidate pool. Any source may fail: a radio must still start from what remains. */
export class CandidateHarvester {
  private storage: StorageAdapter;
  private bridge: HarvestBridge;
  private now: () => number;
  private timeoutMs: number;
  private budgetMs: number;
  private cached: RemoteTracks | null = null;
  private inFlight: Promise<RemoteTracks> | null = null;

  constructor(storage: StorageAdapter, bridge: HarvestBridge, now: () => number = Date.now, config: HarvestConfig = {}) {
    this.storage = storage;
    this.bridge = bridge;
    this.now = now;
    this.timeoutMs = config.timeoutMs ?? CALL_TIMEOUT_MS;
    this.budgetMs = config.budgetMs ?? BUDGET_MS;
  }

  invalidate(): void {
    this.cached = null;
  }

  async harvest(): Promise<HarvestResult> {
    const ratings = await this.storage.getAllRatings();
    const rated = ratings
      .filter((r) => r.rating >= 3 && r.uri.startsWith('spotify:track:') && r.metadata.artists.length > 0)
      .map((r) => r.metadata);

    const remote = await this.fetchRemote();

    const unique = new Map<string, TrackMetadata>();
    for (const track of [...rated, ...remote.library, ...remote.listed]) {
      if (track.uri.startsWith('spotify:track:') && !unique.has(track.uri)) unique.set(track.uri, track);
    }

    return {
      tracks: Array.from(unique.values()),
      contexts: remote.contexts,
      sources: { rated: rated.length, library: remote.library.length, playlists: remote.listed.length },
      ratedUris: new Set(ratings.map((r) => r.uri)),
      libraryUris: new Set(remote.library.map((t) => t.uri))
    };
  }

  private fetchRemote(): Promise<RemoteTracks> {
    if (this.cached) {
      const complete = !this.cached.partial && this.cached.library.length > 0 && this.cached.listed.length > 0;
      if (this.now() - this.cached.at < (complete ? CACHE_MS : RETRY_MS)) return Promise.resolve(this.cached);
    }

    // Radios launched together share one sweep of the library
    this.inFlight ??= this.collectRemote().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async collectRemote(): Promise<RemoteTracks> {
    let outOfTime = false;
    let partial = false;
    const budget = setTimeout(() => { outOfTime = true; }, this.budgetMs);
    const noteStall = (err: unknown) => {
      if (err instanceof TimeoutError) partial = true;
    };

    const library: TrackMetadata[] = [];
    try {
      for (let offset = 0; offset < LIBRARY_LIMIT && !outOfTime; offset += LIBRARY_PAGE) {
        const page = await withTimeout(this.bridge.fetchLibraryPage(offset, LIBRARY_PAGE), this.timeoutMs, 'LibraryAPI.getTracks');
        library.push(...page);
        if (page.length < LIBRARY_PAGE) break;
      }
    } catch (err) {
      noteStall(err);
      console.warn('[NeuralTune] Coleta da biblioteca interrompida', err);
    }

    const contexts = new Map<string, string[]>();
    const listed: TrackMetadata[] = [];
    try {
      const playlists = (await withTimeout(this.bridge.listPlaylists(), this.timeoutMs, 'RootlistAPI.getContents')).slice(0, MAX_PLAYLISTS);
      const BATCH_CONCURRENCY = 5;
      for (let i = 0; i < playlists.length; i += BATCH_CONCURRENCY) {
        if (outOfTime) {
          partial = true;
          break;
        }

        const batch = playlists.slice(i, i + BATCH_CONCURRENCY);
        const batchResults = await Promise.all(
          batch.map(async (playlist) => {
            try {
              const tracks = (await withTimeout(this.bridge.fetchPlaylistTracks(playlist), this.timeoutMs, 'PlaylistAPI.getContents')).slice(0, MAX_TRACKS_PER_PLAYLIST);
              return { playlist, tracks };
            } catch (err) {
              noteStall(err);
              console.warn('[NeuralTune] Playlist ignorada na coleta', playlist, err);
              return null;
            }
          })
        );
        for (const item of batchResults) {
          if (!item) continue;
          contexts.set(item.playlist, item.tracks.map((t) => t.uri));
          listed.push(...item.tracks);
        }
      }
    } catch (err) {
      noteStall(err);
      console.warn('[NeuralTune] Lista de playlists indisponível', err);
    }
    clearTimeout(budget);

    const result = { at: this.now(), library, contexts, listed, partial };
    if (library.length > 0 || listed.length > 0) {
      this.cached = result;
    }
    return result;
  }
}
