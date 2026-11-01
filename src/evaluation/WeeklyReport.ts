import type { Attributed } from './RadioOutcomes.ts';

const WINDOW_MS = 7 * 24 * 3_600_000;
const POSITIVE_RATING = 4;
const MIN_RADIO_TRACKS = 5;
const MAX_ITEMS = 5;
const COMPLETE_RATIO = 0.85;

export interface WeeklyReport {
  heard: number;
  completed: number;
  completionRate: number | null;
  newArtistTracks: number;
  /** New artists heard this week and approved with a rating or "more like this". */
  approvedNewArtists: string[];
  mostSkippedArtists: Array<{ artist: string; skips: number }>;
  bestRadio: { radio: string; completionRate: number; heard: number } | null;
}
export const WeeklyReport = {};

function finished(item: Attributed): boolean {
  const { play } = item;
  if (!play) return false;
  return play.durationMs ? play.playedMs / play.durationMs >= COMPLETE_RATIO : !play.skipped;
}

export function buildWeeklyReport(items: readonly Attributed[], now: number): WeeklyReport {
  const week = items.filter((item) => item.play && now - item.play.startedAt < WINDOW_MS && item.play.startedAt <= now);
  const completed = week.filter(finished).length;

  const approved = new Set<string>();
  const skips = new Map<string, number>();
  const radios = new Map<string, { heard: number; completed: number }>();

  for (const item of week) {
    const { exposure, play, rating } = item;
    const artists = play!.artistNames ?? rating?.metadata.artists.map((a) => a.name) ?? [];

    if (exposure.newArtist && (play!.feedback === 'mais' || (rating?.rating ?? 0) >= POSITIVE_RATING)) {
      approved.add(artists[0] ? `${artists[0]} — ${play!.name}` : play!.name);
    }
    if (play!.skipped) {
      for (const artist of artists.slice(0, 1)) skips.set(artist, (skips.get(artist) ?? 0) + 1);
    }

    const radio = radios.get(exposure.radio) ?? { heard: 0, completed: 0 };
    radio.heard++;
    if (finished(item)) radio.completed++;
    radios.set(exposure.radio, radio);
  }

  const best = Array.from(radios, ([radio, { heard, completed: done }]) => ({ radio, heard, completionRate: done / heard }))
    .filter((radio) => radio.heard >= MIN_RADIO_TRACKS)
    .sort((a, b) => b.completionRate - a.completionRate)[0];

  return {
    heard: week.length,
    completed,
    completionRate: week.length > 0 ? completed / week.length : null,
    newArtistTracks: week.filter((item) => item.exposure.newArtist).length,
    approvedNewArtists: Array.from(approved).slice(0, MAX_ITEMS),
    mostSkippedArtists: Array.from(skips, ([artist, count]) => ({ artist, skips: count }))
      .sort((a, b) => b.skips - a.skips)
      .slice(0, MAX_ITEMS),
    bestRadio: best ?? null
  };
}
