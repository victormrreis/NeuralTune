import { TrackMetadata } from '../types/index.ts';

export const WEEKLY_PLAYLIST = 'NeuralTune — Descobertas da Semana';
export const WEEKLY_INTERVAL_MS = 7 * 24 * 3_600_000;

const WEEKLY_SIZE = 30;
const NEW_ARTIST_SHARE = 0.4;
const MAX_PER_ARTIST = 2;

export interface WeeklySelection {
  tracks: TrackMetadata[];
  newArtists: number;
}
export const WeeklySelection = {};

/**
 * Takes candidates best first and holds part of the list for artists never rated, which pure ranking
 * would crowd out with the familiar. Fewer new artists than the share leaves the rest to the others.
 */
export function pickWeeklyDiscoveries(
  candidates: readonly TrackMetadata[],
  isNewArtist: (track: TrackMetadata) => boolean,
  size: number = WEEKLY_SIZE
): WeeklySelection {
  const perArtist = new Map<string, number>();
  const chosen: TrackMetadata[] = [];
  const taken = new Set<string>();

  const take = (track: TrackMetadata): boolean => {
    if (taken.has(track.uri) || chosen.length >= size) return false;
    const artist = track.artists[0]?.uri ?? track.uri;
    if ((perArtist.get(artist) ?? 0) >= MAX_PER_ARTIST) return false;

    perArtist.set(artist, (perArtist.get(artist) ?? 0) + 1);
    taken.add(track.uri);
    chosen.push(track);
    return true;
  };

  const newQuota = Math.ceil(size * NEW_ARTIST_SHARE);
  let newArtists = 0;
  for (const track of candidates) {
    if (newArtists >= newQuota) break;
    if (isNewArtist(track) && take(track)) newArtists++;
  }

  for (const track of candidates) {
    if (take(track) && isNewArtist(track)) newArtists++;
  }

  return { tracks: chosen, newArtists };
}
