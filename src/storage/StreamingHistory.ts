import { normalizeSongKey } from '../core/SongIdentity.ts';
import { ListeningHistoryEntry } from '../types/index.ts';
import { StorageAdapter } from './StorageAdapter.ts';

const IMPORTED_UNTIL_KEY = 'neuraltune:history-imported-until';
const EARLY_SKIP_MIN_MS = 5_000;
const EARLY_SKIP_MAX_MS = 25_000;

export interface HistoryRow {
  at: number;
  uri?: string;
  name: string;
  artist: string;
  ms: number;
  completed: boolean;
  skipped: boolean;
}
export const HistoryRow = {};

export interface HistoryImportReport {
  tracks: number;
  plays: number;
  alreadyImported: number;
  podcasts: number;
  incognito: number;
  invalid: number;
}
export const HistoryImportReport = {};

/** Only what is listed here is read: the export also carries IP address, country and platform. */
interface RawStream {
  ts?: unknown;
  ms_played?: unknown;
  master_metadata_track_name?: unknown;
  master_metadata_album_artist_name?: unknown;
  spotify_track_uri?: unknown;
  episode_name?: unknown;
  reason_end?: unknown;
  skipped?: unknown;
  incognito_mode?: unknown;
  endTime?: unknown;
  artistName?: unknown;
  trackName?: unknown;
  msPlayed?: unknown;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** Accepts the extended history and the shorter one from the regular account data download. */
export function parseStreamingHistory(content: string): { rows: HistoryRow[]; podcasts: number; incognito: number; invalid: number } {
  let data: unknown;
  try {
    data = JSON.parse(content.replace(/^﻿/, ''));
  } catch {
    throw new Error('O arquivo não é um JSON válido. Extraia o ZIP do Spotify e escolha os arquivos .json de dentro dele.');
  }
  if (!Array.isArray(data)) throw new Error('O arquivo não parece ser um histórico de streaming do Spotify.');

  const rows: HistoryRow[] = [];
  let podcasts = 0;
  let incognito = 0;
  let invalid = 0;

  for (const raw of data as RawStream[]) {
    if (typeof raw !== 'object' || raw === null) {
      invalid++;
      continue;
    }
    if (raw.incognito_mode === true) {
      incognito++;
      continue;
    }

    const name = text(raw.master_metadata_track_name) || text(raw.trackName);
    const artist = text(raw.master_metadata_album_artist_name) || text(raw.artistName);
    if (!name && text(raw.episode_name)) {
      podcasts++;
      continue;
    }

    const ms = typeof raw.ms_played === 'number' ? raw.ms_played : raw.msPlayed;
    const at = Date.parse(text(raw.ts) || `${text(raw.endTime).replace(' ', 'T')}Z`);
    if (!name || !artist || typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0 || !Number.isFinite(at)) {
      invalid++;
      continue;
    }

    const uri = text(raw.spotify_track_uri);
    rows.push({
      at,
      uri: uri.startsWith('spotify:track:') ? uri : undefined,
      name,
      artist,
      ms,
      completed: raw.reason_end === 'trackdone',
      skipped: raw.skipped === true
    });
  }

  return { rows, podcasts, incognito, invalid };
}

/**
 * One record per track instead of one per play: years of history can reach hundreds of thousands of
 * plays, and everything here must load at startup. Plays up to the last import are dropped, so the
 * same file, or a newer export overlapping an older one, never counts twice. All files of one export
 * must therefore come in the same import.
 */
export async function importStreamingHistory(
  contents: readonly string[],
  storage: StorageAdapter,
  store: { get(key: string): string | null; set(key: string, value: string): void }
): Promise<{ report: HistoryImportReport; entries: ListeningHistoryEntry[] }> {
  const importedUntil = Number(store.get(IMPORTED_UNTIL_KEY) ?? 0) || 0;
  const report: HistoryImportReport = { tracks: 0, plays: 0, alreadyImported: 0, podcasts: 0, incognito: 0, invalid: 0 };

  const touched = new Map<string, ListeningHistoryEntry>();
  const stored = new Map((await storage.getAllHistory()).map((entry) => [entry.id, entry]));
  let newest = importedUntil;

  for (const content of contents) {
    const { rows, podcasts, incognito, invalid } = parseStreamingHistory(content);
    report.podcasts += podcasts;
    report.incognito += incognito;
    report.invalid += invalid;

    for (const row of rows) {
      if (row.at <= importedUntil) {
        report.alreadyImported++;
        continue;
      }

      const id = row.uri ?? normalizeSongKey({ name: row.name, artists: [{ name: row.artist }] });
      if (!id) {
        report.invalid++;
        continue;
      }

      const entry = touched.get(id) ?? stored.get(id) ?? {
        id, uri: row.uri, name: row.name, artist: row.artist, plays: 0, completions: 0, earlySkips: 0, msPlayed: 0, firstAt: row.at, lastAt: row.at
      };

      entry.plays++;
      entry.msPlayed += row.ms;
      if (row.completed) entry.completions++;
      if (row.skipped || (row.ms >= EARLY_SKIP_MIN_MS && row.ms < EARLY_SKIP_MAX_MS)) entry.earlySkips++;
      entry.firstAt = Math.min(entry.firstAt, row.at);
      entry.lastAt = Math.max(entry.lastAt, row.at);

      touched.set(id, entry);
      report.plays++;
      newest = Math.max(newest, row.at);
    }
  }

  const entries = Array.from(touched.values());
  await storage.saveHistory(entries);
  store.set(IMPORTED_UNTIL_KEY, String(newest));
  report.tracks = entries.length;
  return { report, entries };
}
