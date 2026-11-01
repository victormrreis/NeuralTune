import { BlacklistManager } from '../core/BlacklistManager.ts';
import { TimeoutError, withTimeout } from '../core/AsyncGuards.ts';
import { songKeys } from '../core/SongIdentity.ts';
import { TrackMetadata, TrackRatingRecord } from '../types/index.ts';

export interface ShieldInput {
  ratings: readonly TrackRatingRecord[];
  blockedArtistCount: number;
  harvest: { tracks: readonly TrackMetadata[]; libraryUris?: ReadonlySet<string> };
  blacklist: BlacklistManager;
  /** The track in playback when the player reports it as liked. */
  liked?: { uri: string; track: TrackMetadata | null } | null;
  /** Flags per URI, for liked tracks past the part of the library the harvest reads. */
  libraryContains?: (uris: string[]) => Promise<unknown>;
  containsTimeoutMs?: number;
  /** Shared between shields: one stall stops the next ones from each waiting out the same timeout. */
  containsBreaker?: { retryAt: number };
  /** What was already played: without it, a track heard yesterday and never rated counts as new. */
  heard?: { isHeard(track: TrackMetadata): boolean; size: number };
}
export const ShieldInput = {};

const CONTAINS_BATCH = 100;
const CONTAINS_TIMEOUT_MS = 3_000;
const CONTAINS_RETRY_MS = 60_000;
const MIN_CONFIRMED_TRACKS = 5;

export interface UnheardShield {
  ratedUris: Set<string>;
  likedUris: Set<string>;
  excludedKeys: Set<string>;
  counts: { rated: number; liked: number; blocked: number; heard: number };
  isExcluded(track: TrackMetadata): boolean;
  filterUnheard(tracks: TrackMetadata[]): Promise<TrackMetadata[]>;
}
export const UnheardShield = {};

/**
 * Builds a strict exclusion shield covering 100% of:
 * - Tracks rated with ANY stars (0★ to 5★) in NeuralTune (`storage.getAllRatings()`)
 * - Tracks liked/hearted (♥) in Spotify's Library (`LibraryAPI.getTracks` + `LibraryAPI.contains`)
 * - Blocked tracks and blocked artists (`BlacklistManager`)
 * - Duplicate versions/remasters of rated or liked tracks via `normalizeSongKey`
 */
export function buildUnheardShield({
  ratings, blockedArtistCount, harvest, blacklist, liked, libraryContains, containsTimeoutMs = CONTAINS_TIMEOUT_MS, containsBreaker, heard
}: ShieldInput): UnheardShield {
  const ratedUris = new Set<string>();
  const likedUris = new Set<string>(harvest.libraryUris ?? []);
  const excludedKeys = new Set<string>();
  const excludeSong = (track: TrackMetadata | null | undefined) => {
    for (const key of songKeys(track)) excludedKeys.add(key);
  };

  for (const r of ratings) {
    ratedUris.add(r.uri);
    excludeSong(r.metadata);
  }

  for (const t of harvest.tracks) {
    if (likedUris.has(t.uri) || (t as unknown as { is_liked?: boolean }).is_liked) {
      likedUris.add(t.uri);
      excludeSong(t);
    }
  }

  if (liked) {
    likedUris.add(liked.uri);
    excludeSong(liked.track);
  }

  const isExcluded = (track: TrackMetadata): boolean => {
    if (!track?.uri || !track.uri.startsWith('spotify:track:')) return true;
    if (ratedUris.has(track.uri) || likedUris.has(track.uri)) return true;
    if (blacklist.isRejected(track)) return true;
    if (heard?.isHeard(track)) return true;
    return songKeys(track).some((key) => excludedKeys.has(key));
  };

  const filterUnheard = async (tracks: TrackMetadata[]): Promise<TrackMetadata[]> => {
    const seenUris = new Set<string>();
    const seenKeys = new Set<string>();
    const prelim: TrackMetadata[] = [];
    for (const t of tracks) {
      if (isExcluded(t) || seenUris.has(t.uri)) continue;
      const keys = songKeys(t);
      if (keys.some((key) => seenKeys.has(key))) continue;
      seenUris.add(t.uri);
      for (const key of keys) seenKeys.add(key);
      prelim.push(t);
    }
    if (prelim.length === 0) return [];

    if (!libraryContains) return prelim;

    // An unconfirmed track could be a like past what the harvest reads. It is dropped while confirmed ones
    // can carry the radio, and allowed only when the alternative is no radio at all
    const newlyLiked = new Set<string>();
    const confirmed = new Set<string>();
    const batches: TrackMetadata[][] = [];
    for (let i = 0; i < prelim.length; i += CONTAINS_BATCH) batches.push(prelim.slice(i, i + CONTAINS_BATCH));

    if (!containsBreaker || Date.now() >= containsBreaker.retryAt) {
      await Promise.all(batches.map(async (batch) => {
        try {
          const flags = await withTimeout(libraryContains(batch.map((t) => t.uri)), containsTimeoutMs, 'LibraryAPI.contains');
          if (!Array.isArray(flags) || flags.length !== batch.length) return;
          batch.forEach((t, i) => {
            confirmed.add(t.uri);
            if (flags[i]) newlyLiked.add(t.uri);
          });
        } catch (err) {
          if (err instanceof TimeoutError && containsBreaker) containsBreaker.retryAt = Date.now() + CONTAINS_RETRY_MS;
        }
      }));
    }

    const unliked = prelim.filter((t) => {
      if (!newlyLiked.has(t.uri)) return true;
      likedUris.add(t.uri);
      excludeSong(t);
      return false;
    });
    const verified = unliked.filter((t) => confirmed.has(t.uri));
    return verified.length >= MIN_CONFIRMED_TRACKS ? verified : unliked;
  };

  const blockedTracksCount = ratings.filter((r) => r.rating === 0).length;
  return {
    ratedUris,
    likedUris,
    excludedKeys,
    counts: {
      rated: ratedUris.size,
      liked: likedUris.size,
      blocked: blockedTracksCount + blockedArtistCount,
      heard: heard?.size ?? 0
    },
    isExcluded,
    filterUnheard
  };
}
