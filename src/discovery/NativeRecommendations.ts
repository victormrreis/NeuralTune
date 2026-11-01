import { withTimeout } from '../core/AsyncGuards.ts';
import { TrackMetadata } from '../types/index.ts';

const PLAYLISTS_PER_ROUND = 4;
const ROTATION_STEP = 3;
const RECOMMEND_TIMEOUT_MS = 6_000;

export interface NativeRecommendationRequest {
  recommend: (playlistUri: string) => Promise<unknown>;
  playlistUris: readonly string[];
  rotation: number;
  parseTrack: (raw: unknown) => TrackMetadata | null;
  isExcluded: (track: TrackMetadata) => boolean;
  /** Spotify decorates these with tempo and key, which saves a whole audio analysis. */
  onDecorated?: (uri: string, raw: { bpm: number; trackKey?: unknown }) => void;
  timeoutMs?: number;
}
export const NativeRecommendationRequest = {};

/**
 * Spotify's own recommendations for a few of the user's playlists, rotating between calls. Each playlist
 * stands alone: one that fails or stalls costs only its own tracks.
 */
export async function fetchNativeRecommendations({
  recommend, playlistUris, rotation, parseTrack, isExcluded, onDecorated, timeoutMs = RECOMMEND_TIMEOUT_MS
}: NativeRecommendationRequest): Promise<TrackMetadata[]> {
  if (playlistUris.length === 0) return [];

  const offset = (rotation * ROTATION_STEP) % playlistUris.length;
  const rotated = [...playlistUris.slice(offset), ...playlistUris.slice(0, offset)].slice(0, PLAYLISTS_PER_ROUND);

  const batches = await Promise.all(rotated.map(async (playlistUri) => {
    try {
      const items = await withTimeout(recommend(playlistUri), timeoutMs, 'PlaylistAPI.getRecommendedTracks');
      if (!Array.isArray(items)) return [];

      const tracks: TrackMetadata[] = [];
      for (const raw of items) {
        const track = parseTrack(raw);
        if (!track || isExcluded(track)) continue;
        if (typeof raw?.bpm === 'number' && raw.bpm > 0) onDecorated?.(track.uri, raw);
        tracks.push(track);
      }
      return tracks;
    } catch {
      return [];
    }
  }));

  return batches.flat();
}
