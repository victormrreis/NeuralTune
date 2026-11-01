import { StorageAdapter } from './StorageAdapter.ts';
import { patchRatingMetadata } from './RatingPatch.ts';
import { BlacklistManager } from '../core/BlacklistManager.ts';
import { ACOUSTIC_DIMENSIONS, ACOUSTIC_DIMENSION_COUNT, standardize, toAcousticPoint } from '../core/AcousticVector.ts';
import { COUNTED_PLAY_MS } from '../core/PlaybackHistoryTracker.ts';
import { WeightedObservation, powerIterationPca, symmetricEigen, weightedCovariance } from '../math/LinearAlgebra.ts';
import { SCIENTIFIC_EVIDENCE } from '../neuroscience/ScientificEvidenceRegistry.ts';
import { barChartSvg, constellationSvg, escapeMarkup, radarSvg } from '../ui/TasteVisualizer.ts';
import {
  AcousticFeatures,
  ArtistBlockRecord,
  ComparativeFeedback,
  PlayEvent,
  PreferenceProfile,
  Rating,
  TrackMetadata,
  TrackRatingRecord,
  VersionBlockRule
} from '../types/index.ts';

export const EXPORT_SCHEMA = 'neuraltune.export';
export const EXPORT_SCHEMA_VERSION = 2;
export const JSON_EXPORT_FILENAME = 'neuraltune_v2_export.json';
export const CSV_EXPORT_FILENAME = 'neuraltune_avaliacoes.csv';
export const COVARIANCE_EXPORT_FILENAME = 'neuraltune_taste_covariance.json';
export const GRAPH_EXPORT_FILENAME = 'neuraltune_transitions.graphml';
export const JSPF_EXPORT_FILENAME = 'neuraltune_avaliacoes.jspf';
export const DOSSIER_EXPORT_FILENAME = 'neuraltune-dossier.html';
export const RADIO_JSPF_EXPORT_FILENAME = 'neuraltune_radio.jspf';

const JSPF_EXTENSION = 'https://github.com/neuraltune/jspf#track';

const LIKED_WEIGHT: Record<number, number> = { 4: 0.5, 5: 1 };
const SESSION_GAP_MS = 30 * 60_000;

export const CSV_COLUMNS = [
  'URI do Spotify',
  'Nome da Música',
  'Artistas',
  'Álbum',
  'Nota (0 a 5)',
  'Estrelas',
  'Data de Avaliação',
  'Total de Reproduções',
  'Bloqueada (Sim/Não)'
] as const;

// Excel on a pt-BR system splits columns on ';' and renders a comma-separated file as a single column.
// The BOM is what makes it read the accents as UTF-8.
const CSV_DELIMITER = ';';
const CSV_BOM = '﻿';
const CSV_EOL = '\r\n';

export const SYNC_PLAYLISTS: ReadonlyArray<{ name: string; rating: Rating }> = [
  { name: 'NeuralTune — Ouro Puro (★★★★★)', rating: 5 },
  { name: 'NeuralTune — Favoritas (★★★★☆)', rating: 4 },
  { name: 'NeuralTune — Blacklist & Lixeira (0★)', rating: 0 }
];

const PLAYLIST_CHUNK_SIZE = 100;
const TRASH_SEEN_KEY = 'neuraltune:trash-seen';

export interface ExportFile {
  filename: string;
  mimeType: string;
  content: string;
}
export const ExportFile = {};

export interface TrackStats {
  uri: string;
  plays: number;
  skips: number;
  lastPlayedAt: number | null;
}
export const TrackStats = {};

export interface ExportSnapshot {
  schema: typeof EXPORT_SCHEMA;
  schemaVersion: typeof EXPORT_SCHEMA_VERSION;
  exportedAt: string;
  counts: { ratings: number; blockedTracks: number; blockedArtists: number; playEvents: number; radioExposures: number };
  ratings: TrackRatingRecord[];
  blockedTrackUris: string[];
  blockedArtists: ArtistBlockRecord[];
  versionRules: VersionBlockRule[];
  comparativeFeedbacks: ComparativeFeedback[];
  profiles: PreferenceProfile[];
  playEvents: PlayEvent[];
  radioExposures: RadioExposure[];
  trackStats: TrackStats[];
  featureSources: Record<string, number>;
  model?: unknown;
}
export const ExportSnapshot = {};

export type MergeStrategy = 'highest' | 'merge' | 'newest' | 'ask' | 'replace' | 'keepLocal';
export const MergeStrategy = {};

const MERGE_STRATEGIES: readonly string[] = ['highest', 'merge', 'newest', 'ask', 'replace', 'keepLocal'];

export interface RatingConflict {
  uri: string;
  name: string;
  local: TrackRatingRecord;
  imported: TrackRatingRecord;
}
export const RatingConflict = {};

export interface ImportOptions {
  strategy?: MergeStrategy;
  resolveConflict?: (conflict: RatingConflict) => Promise<'local' | 'imported'>;
}
export const ImportOptions = {};

export interface ImportReport {
  addedRatings: number;
  replacedRatings: number;
  conflicts: number;
  keptLocal: number;
  unblockedByMerge: number;
  keptBlocks: number;
  invalidRecords: number;
  addedArtists: number;
  addedVersionRules: number;
  addedFeedback: number;
  addedPlayEvents: number;
  addedExposures: number;
}
export const ImportReport = {};

export interface PlaylistBridge {
  findPlaylistByName(name: string): Promise<string | null>;
  createPlaylist(name: string): Promise<string | null>;
  getPlaylistItems(playlistUri: string): Promise<Array<{ uri: string; uid: string }>>;
  addTracks(playlistUri: string, uris: string[]): Promise<void>;
  removeTracks(playlistUri: string, items: Array<{ uri: string; uid: string }>): Promise<void>;
}
export const PlaylistBridge = {};

export interface PlaylistSyncResult {
  name: string;
  uri: string | null;
  created: boolean;
  added: number;
  removed: number;
  total: number;
  error?: string;
}
export const PlaylistSyncResult = {};

export interface KeyValueStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
}
export const KeyValueStore = {};

export type TrackResolver = (uris: string[]) => Promise<Map<string, TrackMetadata>>;

export interface DataPortabilityDependencies {
  storage: StorageAdapter;
  blacklist: BlacklistManager;
  playlists?: PlaylistBridge;
  keyValue?: KeyValueStore;
  resolveTracks?: TrackResolver;
  getModelDiagnostics?: () => unknown;
  now?: () => number;
}
export const DataPortabilityDependencies = {};

export function starsOf(rating: number): string {
  return '★'.repeat(rating) + '☆'.repeat(5 - rating);
}

/** RFC 4180 quoting, plus neutralizing cells a spreadsheet would run as a formula. */
export function escapeCsvCell(value: string | number): string {
  if (typeof value === 'number') return String(value);
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  const needsQuoting = safe.includes(CSV_DELIMITER) || /["\r\n]/.test(safe);
  return needsQuoting ? `"${safe.replace(/"/g, '""')}"` : safe;
}

function formatLocalDate(timestamp: number): string {
  const date = new Date(timestamp);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function isPlaceholder(metadata: TrackMetadata): boolean {
  return metadata.artists.length === 0;
}

function chunks<T>(items: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    result.push(items.slice(i, i + size));
  }
  return result;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function sanitizeFeatures(value: unknown): AcousticFeatures | undefined {
  if (typeof value !== 'object' || value === null) return undefined;

  const source = value as Record<string, unknown>;
  const features: AcousticFeatures = {};
  const numericKeys = [
    'bpm', 'key', 'energy', 'danceability', 'acousticness',
    'instrumentalness', 'valence', 'speechiness', 'liveness', 'mode', 'keyConfidence', 'synthesisVersion'
  ] as const;

  for (const key of numericKeys) {
    const candidate = source[key];
    if (typeof candidate === 'number' && Number.isFinite(candidate)) features[key] = candidate;
  }
  for (const key of ['chroma', 'timbre', 'timbreVariance'] as const) {
    const candidate = source[key];
    if (Array.isArray(candidate) && candidate.every((v) => typeof v === 'number' && Number.isFinite(v))) {
      features[key] = candidate as number[];
    }
  }
  if (typeof source.camelot === 'string') features.camelot = source.camelot;
  for (const key of ['predictive', 'rhythm', 'morphology'] as const) {
    const nested = plainData(source[key]);
    if (nested) (features as Record<string, unknown>)[key] = nested;
  }
  if (typeof source.source === 'string') features.source = source.source;

  return Object.keys(features).length > 0 ? features : undefined;
}

/** Deep copy of numbers, strings and containers only: nothing executable or unexpected survives. */
function plainData(value: unknown, depth: number = 0): unknown {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string') return value;
  if (depth > 4 || typeof value !== 'object' || value === null) return undefined;
  if (Array.isArray(value)) return value.map((item) => plainData(item, depth + 1)).filter((item) => item !== undefined);

  const copy: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    const clean = plainData(item, depth + 1);
    if (clean !== undefined) copy[key] = clean;
  }
  return copy;
}

function sanitizeMetadata(uri: string, value: unknown): TrackMetadata {
  const source = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>;
  const album = (typeof source.album === 'object' && source.album !== null ? source.album : {}) as Record<string, unknown>;
  const artists = Array.isArray(source.artists) ? source.artists : [];

  const metadata: TrackMetadata = {
    uri,
    name: asString(source.name),
    artists: artists
      .filter((a): a is Record<string, unknown> => typeof a === 'object' && a !== null)
      .map((a) => ({ name: asString(a.name), uri: asString(a.uri) })),
    album: { name: asString(album.name), uri: asString(album.uri) }
  };

  const features = sanitizeFeatures(source.acousticFeatures);
  if (features) metadata.acousticFeatures = features;
  if (typeof source.duration_ms === 'number') metadata.duration_ms = source.duration_ms;
  if (typeof source.releaseYear === 'number') metadata.releaseYear = source.releaseYear;
  if (Array.isArray(source.genres)) {
    metadata.genres = source.genres.filter((g): g is string => typeof g === 'string');
  }

  return metadata;
}

function escapeXml(value: string): string {
  return value
    .replace(/[^\t\n\r\u{20}-\u{D7FF}\u{E000}-\u{FFFD}\u{10000}-\u{10FFFF}]/gu, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Imported files are untrusted: only known fields of well-formed records reach storage. */
function sanitizeRating(value: unknown): TrackRatingRecord | null {
  if (typeof value !== 'object' || value === null) return null;

  const { uri, rating, timestamp, metadata, manualOverride } = value as Record<string, unknown>;
  if (typeof uri !== 'string' || !/^spotify:(track|local|episode):\S+$/.test(uri)) return null;
  if (typeof rating !== 'number' || !Number.isInteger(rating) || rating < 0 || rating > 5) return null;
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) return null;

  return {
    uri,
    rating: rating as Rating,
    timestamp,
    metadata: sanitizeMetadata(uri, metadata),
    manualOverride: manualOverride === true
  };
}

function sanitizeArtist(value: unknown): ArtistBlockRecord | null {
  if (typeof value !== 'object' || value === null) return null;

  const { artistUri, artistName, timestamp, reason } = value as Record<string, unknown>;
  if (typeof artistUri !== 'string' || !artistUri.startsWith('spotify:artist:')) return null;

  return {
    artistUri,
    artistName: asString(artistName),
    timestamp: typeof timestamp === 'number' ? timestamp : 0,
    reason: typeof reason === 'string' ? reason : undefined
  };
}

function sanitizeVersionRule(value: unknown): VersionBlockRule | null {
  if (typeof value !== 'object' || value === null) return null;

  const rule = value as Record<string, unknown>;
  if (typeof rule.trackName !== 'string' || typeof rule.artistName !== 'string') return null;

  return {
    trackName: rule.trackName,
    artistName: rule.artistName,
    compositionId: typeof rule.compositionId === 'string' ? rule.compositionId : undefined,
    blockAllVersions: rule.blockAllVersions === true,
    blockLiveVersionsOnly: rule.blockLiveVersionsOnly === true,
    blockRemixesOnly: rule.blockRemixesOnly === true,
    timestamp: typeof rule.timestamp === 'number' ? rule.timestamp : 0
  };
}

function sanitizeFeedback(value: unknown): ComparativeFeedback | null {
  if (typeof value !== 'object' || value === null) return null;

  const { id, winnerUri, loserUri, timestamp, context } = value as Record<string, unknown>;
  if (typeof id !== 'string' || typeof winnerUri !== 'string' || typeof loserUri !== 'string') return null;

  return {
    id,
    winnerUri,
    loserUri,
    timestamp: typeof timestamp === 'number' ? timestamp : 0,
    context: typeof context === 'string' ? context : undefined
  };
}

function sanitizePlayEvent(value: unknown): PlayEvent | null {
  if (typeof value !== 'object' || value === null) return null;

  const event = value as Record<string, unknown>;
  if (typeof event.id !== 'string' || typeof event.uri !== 'string') return null;
  if (typeof event.startedAt !== 'number' || typeof event.playedMs !== 'number') return null;

  return {
    id: event.id,
    uri: event.uri,
    name: asString(event.name),
    artistUris: Array.isArray(event.artistUris) ? event.artistUris.filter((a): a is string => typeof a === 'string') : [],
    startedAt: event.startedAt,
    endedAt: typeof event.endedAt === 'number' ? event.endedAt : event.startedAt,
    playedMs: event.playedMs,
    durationMs: typeof event.durationMs === 'number' ? event.durationMs : undefined,
    skipped: event.skipped === true,
    ...(event.origin === 'radio' || event.origin === 'autoplay' || event.origin === 'organic' ? { origin: event.origin } : {}),
    ...(event.feedback === 'mais' || event.feedback === 'menos' ? { feedback: event.feedback } : {}),
    ...(Array.isArray(event.artistNames) ? { artistNames: event.artistNames.filter((a): a is string => typeof a === 'string') } : {})
  };
}

function sanitizeExposure(value: unknown): RadioExposure | null {
  if (typeof value !== 'object' || value === null) return null;

  const e = value as Record<string, unknown>;
  if (typeof e.id !== 'string' || typeof e.runId !== 'string' || typeof e.radio !== 'string' || typeof e.uri !== 'string') return null;
  if (typeof e.at !== 'number' || typeof e.position !== 'number') return null;

  return {
    id: e.id,
    runId: e.runId,
    radio: e.radio,
    uri: e.uri,
    position: e.position,
    at: e.at,
    propensity: typeof e.propensity === 'number' ? e.propensity : null,
    source: e.source === 'descoberta' ? 'descoberta' : 'playlist',
    newArtist: e.newArtist === true,
    ...(e.arm === 'padrao' || e.arm === 'exploratorio' ? { arm: e.arm } : {}),
    ...(typeof e.carry === 'boolean' ? { carry: e.carry } : {}),
    ...(typeof e.score === 'number' && Number.isFinite(e.score) ? { score: e.score } : {})
  };
}

function listOf<T>(value: unknown, sanitize: (item: unknown) => T | null): { items: T[]; invalid: number } {
  if (!Array.isArray(value)) return { items: [], invalid: 0 };

  const items: T[] = [];
  let invalid = 0;
  for (const raw of value) {
    const item = sanitize(raw);
    if (item) items.push(item);
    else invalid++;
  }
  return { items, invalid };
}

export class DataPortabilityManager {
  private storage: StorageAdapter;
  private blacklist: BlacklistManager;
  private playlists?: PlaylistBridge;
  private keyValue?: KeyValueStore;
  private resolveTracks?: TrackResolver;
  private getModelDiagnostics?: () => unknown;
  private now: () => number;
  private lastTrashSnapshot: string | null = null;

  constructor(deps: DataPortabilityDependencies) {
    this.storage = deps.storage;
    this.blacklist = deps.blacklist;
    this.playlists = deps.playlists;
    this.keyValue = deps.keyValue;
    this.resolveTracks = deps.resolveTracks;
    this.getModelDiagnostics = deps.getModelDiagnostics;
    this.now = deps.now ?? Date.now;
  }

  async buildSnapshot(): Promise<ExportSnapshot> {
    await this.enrichPlaceholders();

    const [ratings, blockedArtists, versionRules, comparativeFeedbacks, profiles, playEvents, radioExposures] = await Promise.all([
      this.storage.getAllRatings(),
      this.storage.getAllBlockedArtists(),
      this.storage.getAllVersionRules(),
      this.storage.getAllComparativeFeedbacks(),
      this.storage.getAllProfiles(),
      this.storage.getAllPlayEvents(),
      this.storage.getAllExposures()
    ]);

    const blockedTrackUris = ratings.filter((r) => r.rating === 0).map((r) => r.uri);

    return {
      schema: EXPORT_SCHEMA,
      schemaVersion: EXPORT_SCHEMA_VERSION,
      exportedAt: new Date(this.now()).toISOString(),
      counts: {
        ratings: ratings.length,
        blockedTracks: blockedTrackUris.length,
        blockedArtists: blockedArtists.length,
        playEvents: playEvents.length,
        radioExposures: radioExposures.length
      },
      ratings,
      blockedTrackUris,
      blockedArtists,
      versionRules,
      comparativeFeedbacks,
      profiles,
      playEvents,
      radioExposures,
      trackStats: Array.from(this.computeTrackStats(playEvents).values()),
      featureSources: this.countFeatureSources(ratings),
      model: this.getModelDiagnostics?.()
    };
  }

  async exportJson(): Promise<ExportFile> {
    return {
      filename: JSON_EXPORT_FILENAME,
      mimeType: 'application/json',
      content: JSON.stringify(await this.buildSnapshot(), null, 2)
    };
  }

  async exportCsv(): Promise<ExportFile> {
    await this.enrichPlaceholders();

    const [ratings, playEvents] = await Promise.all([
      this.storage.getAllRatings(),
      this.storage.getAllPlayEvents()
    ]);
    const stats = this.computeTrackStats(playEvents);

    const rows = [...ratings]
      .sort((a, b) => b.timestamp - a.timestamp)
      .map((record) => {
        const blocked = this.blacklist.isBlockedFast(record.uri, record.metadata.artists.map((a) => a.uri));
        return [
          record.uri,
          record.metadata.name,
          record.metadata.artists.map((a) => a.name).join(', '),
          record.metadata.album.name,
          record.rating,
          starsOf(record.rating),
          formatLocalDate(record.timestamp),
          stats.get(record.uri)?.plays ?? 0,
          blocked ? 'Sim' : 'Não'
        ].map(escapeCsvCell).join(CSV_DELIMITER);
      });

    return {
      filename: CSV_EXPORT_FILENAME,
      mimeType: 'text/csv;charset=utf-8',
      content: CSV_BOM + [CSV_COLUMNS.join(CSV_DELIMITER), ...rows].join(CSV_EOL) + CSV_EOL
    };
  }

  /**
   * JSPF, the JSON form of XSPF that ListenBrainz reads. Every rating goes out, rating and block
   * included, in a track extension. ListenBrainz matches tracks by MusicBrainz ID, which is not known
   * here: Spotify links identify a track but may not resolve there without a lookup on their side.
   */
  async exportJspf(): Promise<ExportFile> {
    await this.enrichPlaceholders();

    const ratings = (await this.storage.getAllRatings()).sort((a, b) => b.rating - a.rating || b.timestamp - a.timestamp);
    const tracks = ratings.map((record) => this.toJspfTrack(record.metadata, {
      uri: record.uri,
      rating: record.rating,
      ratedAt: new Date(record.timestamp).toISOString(),
      blocked: this.blacklist.isBlockedFast(record.uri, record.metadata.artists.map((a) => a.uri))
    }));

    return this.jspfFile(JSPF_EXPORT_FILENAME, 'NeuralTune — Avaliações', tracks);
  }

  /**
   * Self-contained HTML, no network and no script from outside. It carries ratings, acoustic statistics
   * and aggregates. Play events are reduced to counts and no session or account field is read at all.
   */
  async exportDossier(evaluation: unknown = null): Promise<ExportFile> {
    const [ratings, plays] = await Promise.all([this.storage.getAllRatings(), this.storage.getAllPlayEvents()]);
    const stats = this.computeTrackStats(plays);
    const dated = [...ratings].sort((a, b) => b.timestamp - a.timestamp);

    const tableRows = dated.map((record) => {
      const features = record.metadata.acousticFeatures;
      return [
        record.metadata.name, record.metadata.artists.map((a) => a.name).join(', '), record.rating,
        new Date(record.timestamp).toISOString().slice(0, 10), stats.get(record.uri)?.plays ?? 0,
        features?.camelot ?? '', features?.bpm ? Math.round(features.bpm) : ''
      ];
    });

    const liked = ratings.flatMap((r) => {
      const weight = LIKED_WEIGHT[r.rating];
      const point = weight ? toAcousticPoint(r.metadata.acousticFeatures) : null;
      return point ? [{ values: point.values, known: point.known, weight }] : [];
    });

    const { mean, covariance } = weightedCovariance(liked, ACOUSTIC_DIMENSION_COUNT);
    const pca = powerIterationPca(covariance);
    const correlationCells = covariance.map((row, i) => row.map((value, j) => {
      const scale = Math.sqrt(covariance[i][i] * covariance[j][j]);
      return scale > 0 ? value / scale : 0;
    }));

    const distribution = [5, 4, 3, 2, 1, 0].map((value) => ({ label: `${value}★`, value: ratings.filter((r) => r.rating === value).length }));
    const hours = Array.from({ length: 24 }, (_, hour) => ({ label: `${hour}h`, value: 0 }));
    for (const play of plays) hours[new Date(play.startedAt).getHours()].value++;

    const skips = plays.filter((p) => p.skipped).length;
    const artists = new Set(ratings.flatMap((r) => r.metadata.artists.map((a) => a.uri)));

    const map = constellationSvg(ratings.flatMap((record) => {
      const point = toAcousticPoint(record.metadata.acousticFeatures);
      return point ? [{ coordinates: standardize(point.values), label: record.metadata.name, rating: record.rating, kind: 'track' as const }] : [];
    }), pca);

    const references = SCIENTIFIC_EVIDENCE.flatMap((entry) => entry.references.map((reference) => {
      return `<li>${escapeMarkup(reference.citation)} <a href="${escapeMarkup(reference.link)}">${escapeMarkup(reference.link)}</a> (${reference.access}; ${escapeMarkup(entry.status)})</li>`;
    })).join('');

    const correlation = `<table class="m"><tr><th></th>${ACOUSTIC_DIMENSIONS.map((d) => `<th>${d.slice(0, 5)}</th>`).join('')}</tr>${correlationCells.map((row, i) => {
      return `<tr><th>${ACOUSTIC_DIMENSIONS[i]}</th>${row.map((value) => `<td style="background:rgba(29,185,84,${Math.abs(value).toFixed(2)})">${value.toFixed(2)}</td>`).join('')}</tr>`;
    }).join('')}</table>`;

    const payload = JSON.stringify(tableRows).replace(/</g, '\\u003c');

    const content = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Dossiê NeuralTune</title>
<style>:root{color-scheme:light dark}body{font:15px/1.5 system-ui,sans-serif;max-width:920px;margin:0 auto;padding:16px;background:Canvas;color:CanvasText}section{margin:28px 0}table{border-collapse:collapse;width:100%;font-size:13px}th,td{padding:4px 6px;border-bottom:1px solid rgba(128,128,128,.3);text-align:left}.m td{text-align:center;font-size:11px}input{width:100%;padding:8px;font:inherit;box-sizing:border-box}.scroll{overflow:auto;max-height:420px}</style></head><body>
<h1>Dossiê NeuralTune</h1><p>Gerado em ${new Date(this.now()).toISOString().slice(0, 10)} · ${ratings.length} avaliações · ${artists.size} artistas · ${plays.length} reproduções registradas.</p>
<section><h2>Distribuição das notas</h2>${barChartSvg(distribution)}</section>
<section><h2>Radar acústico das faixas favoritas</h2>${liked.length > 0 ? radarSvg([{ label: 'Média das 4★ e 5★', values: mean, color: '#1db954' }]) : '<p>Sem faixas favoritas com dados acústicos.</p>'}</section>
<section><h2>PCA do gosto</h2>${map}</section>
<section><h2>Matriz de correlação acústica</h2><div class="scroll">${correlation}</div></section>
<section><h2>Distribuição temporal de reproduções</h2>${barChartSvg(hours, '#509bf5')}</section>
<section><h2>Skips</h2><p>${skips} de ${plays.length} reproduções registradas foram interrompidas cedo${plays.length > 0 ? ` (${Math.round((skips / plays.length) * 100)}%)` : ''}. Um skip não indica por si só rejeição da música.</p></section>
<section><h2>Qualidade das recomendações</h2><pre style="white-space:pre-wrap;font-size:12px">${escapeMarkup(evaluation ? JSON.stringify(evaluation, null, 1) : 'Sem avaliação disponível.')}</pre></section>
<section><h2>Avaliações</h2><input id="q" type="search" placeholder="Filtrar por música ou artista" aria-label="Filtrar avaliações"><div class="scroll"><table><thead><tr><th>Música</th><th>Artistas</th><th>Nota</th><th>Data</th><th>Reproduções</th><th>Camelot</th><th>BPM</th></tr></thead><tbody id="t"></tbody></table></div></section>
<section><h2>Referências usadas no motor</h2><ul>${references}</ul></section>
<section><h2>Limitações e disponibilidade dos dados</h2><ul><li>Os atributos acústicos são estimativas a partir da análise do Spotify, com pesos não calibrados contra valores reais.</li><li>Nada aqui mede atividade cerebral, emoção ou fisiologia: tudo vem de notas, reproduções e áudio analisado.</li><li>O histórico de reproduções começa na versão 2.0.</li><li>O mapa PCA é uma aproximação em 2 dimensões de um espaço de 8.</li></ul></section>
<script>var d=${payload};var b=document.getElementById('t');function r(q){b.textContent='';d.filter(function(x){return !q||(x[0]+' '+x[1]).toLowerCase().indexOf(q)>=0}).slice(0,500).forEach(function(x){var t=document.createElement('tr');x.forEach(function(v){var c=document.createElement('td');c.textContent=v;t.appendChild(c)});b.appendChild(t)})}r('');document.getElementById('q').addEventListener('input',function(e){r(e.target.value.toLowerCase())});</script></body></html>`;

    return { filename: DOSSIER_EXPORT_FILENAME, mimeType: 'text/html', content };
  }

  async exportRadioJspf(title: string, radio: readonly TrackMetadata[]): Promise<ExportFile> {
    return this.jspfFile(RADIO_JSPF_EXPORT_FILENAME, title, radio.map((track) => this.toJspfTrack(track, { uri: track.uri })));
  }

  /**
   * Σ of the liked tracks (5★ weighs 1, 4★ weighs 0.5) with its principal axes, in the [0, 1] space.
   * A dimension with no known values has zero variance, which says nothing about taste: check
   * `observationsPerDimension` before reading the ellipse.
   */
  async exportCovariance(): Promise<ExportFile> {
    const ratings = await this.storage.getAllRatings();
    const observations: WeightedObservation[] = [];

    for (const record of ratings) {
      const weight = LIKED_WEIGHT[record.rating];
      const point = weight ? toAcousticPoint(record.metadata.acousticFeatures) : null;
      if (point) observations.push({ values: point.values, known: point.known, weight });
    }

    const { mean, covariance, observationsPerDimension } = weightedCovariance(observations, ACOUSTIC_DIMENSION_COUNT);
    const eigen = symmetricEigen(covariance);
    const totalVariance = eigen.reduce((sum, pair) => sum + Math.max(0, pair.value), 0);

    return {
      filename: COVARIANCE_EXPORT_FILENAME,
      mimeType: 'application/json',
      content: JSON.stringify({
        schema: 'neuraltune.taste-covariance',
        schemaVersion: 1,
        exportedAt: new Date(this.now()).toISOString(),
        dimensions: ACOUSTIC_DIMENSIONS,
        samples: observations.length,
        observationsPerDimension,
        mean,
        covariance,
        eigenvalues: eigen.map((pair) => pair.value),
        eigenvectors: eigen.map((pair) => pair.vector),
        explainedVarianceRatio: eigen.map((pair) => (totalVariance > 0 ? Math.max(0, pair.value) / totalVariance : 0))
      }, null, 2)
    };
  }

  /**
   * Directed graph of consecutive plays inside one session. An edge's weight is the time listened to
   * its target without skipping, so a transition that was always skipped stays visible at weight 0.
   */
  async exportTransitionGraph(): Promise<ExportFile> {
    const [events, ratings] = await Promise.all([this.storage.getAllPlayEvents(), this.storage.getAllRatings()]);
    const ordered = [...events].sort((a, b) => a.startedAt - b.startedAt);
    const ratingByUri = new Map(ratings.map((r) => [r.uri, r]));

    const nodes = new Map<string, { id: string; name: string; plays: number; listenedMs: number }>();
    const edges = new Map<string, { source: string; target: string; weight: number; transitions: number; skips: number }>();

    ordered.forEach((event, index) => {
      let node = nodes.get(event.uri);
      if (!node) {
        node = { id: `n${nodes.size}`, name: event.name, plays: 0, listenedMs: 0 };
        nodes.set(event.uri, node);
      }
      node.plays++;
      if (!event.skipped) node.listenedMs += event.playedMs;

      const previous = ordered[index - 1];
      if (!previous || event.startedAt - previous.endedAt > SESSION_GAP_MS) return;

      const key = `${previous.uri}\n${event.uri}`;
      const edge = edges.get(key) ?? { source: previous.uri, target: event.uri, weight: 0, transitions: 0, skips: 0 };
      edge.transitions++;
      if (event.skipped) edge.skips++;
      else edge.weight += event.playedMs;
      edges.set(key, edge);
    });

    const nodeXml = Array.from(nodes, ([uri, node]) => {
      const record = ratingByUri.get(uri);
      const artists = record?.metadata.artists.map((a) => a.name).join(', ') ?? '';
      return [
        `    <node id="${node.id}">`,
        `      <data key="uri">${escapeXml(uri)}</data>`,
        `      <data key="label">${escapeXml(node.name)}</data>`,
        `      <data key="artists">${escapeXml(artists)}</data>`,
        `      <data key="plays">${node.plays}</data>`,
        `      <data key="listened_ms">${node.listenedMs}</data>`,
        record ? `      <data key="rating">${record.rating}</data>` : '',
        '    </node>'
      ].filter(Boolean).join('\n');
    });

    const edgeXml = Array.from(edges.values(), (edge, index) => [
      `    <edge id="e${index}" source="${nodes.get(edge.source)!.id}" target="${nodes.get(edge.target)!.id}">`,
      `      <data key="weight">${edge.weight}</data>`,
      `      <data key="transitions">${edge.transitions}</data>`,
      `      <data key="skips">${edge.skips}</data>`,
      '    </edge>'
    ].join('\n'));

    const content = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<graphml xmlns="http://graphml.graphdrawing.org/xmlns" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://graphml.graphdrawing.org/xmlns http://graphml.graphdrawing.org/xmlns/1.0/graphml.xsd">',
      '  <key id="uri" for="node" attr.name="uri" attr.type="string"/>',
      '  <key id="label" for="node" attr.name="label" attr.type="string"/>',
      '  <key id="artists" for="node" attr.name="artists" attr.type="string"/>',
      '  <key id="plays" for="node" attr.name="plays" attr.type="int"/>',
      '  <key id="listened_ms" for="node" attr.name="listened_ms" attr.type="double"/>',
      '  <key id="rating" for="node" attr.name="rating" attr.type="int"/>',
      '  <key id="weight" for="edge" attr.name="weight" attr.type="double"/>',
      '  <key id="transitions" for="edge" attr.name="transitions" attr.type="int"/>',
      '  <key id="skips" for="edge" attr.name="skips" attr.type="int"/>',
      '  <graph id="neuraltune" edgedefault="directed">',
      ...nodeXml,
      ...edgeXml,
      '  </graph>',
      '</graphml>',
      ''
    ].join('\n');

    return { filename: GRAPH_EXPORT_FILENAME, mimeType: 'application/xml', content };
  }

  /**
   * Accepts this schema and the v1 backups written by the previous release. Local data is never
   * deleted: the import can add records, or replace a rating according to the strategy.
   */
  async importJson(text: string, options: ImportOptions = {}): Promise<ImportReport> {
    const strategy = options.strategy ?? 'highest';
    if (!MERGE_STRATEGIES.includes(strategy)) throw new Error(`Estratégia de importação desconhecida: ${String(strategy)}.`);

    const data = this.parseImport(text);

    const ratings = listOf(data.ratings, sanitizeRating);
    const artists = listOf(data.blockedArtists, sanitizeArtist);
    const rules = listOf(data.versionRules, sanitizeVersionRule);
    const feedback = listOf(data.comparativeFeedbacks, sanitizeFeedback);
    const plays = listOf(data.playEvents, sanitizePlayEvent);
    const exposures = listOf(data.radioExposures, sanitizeExposure);

    const report: ImportReport = {
      addedRatings: 0,
      replacedRatings: 0,
      conflicts: 0,
      keptLocal: 0,
      unblockedByMerge: 0,
      keptBlocks: 0,
      invalidRecords: ratings.invalid + artists.invalid + rules.invalid + feedback.invalid + plays.invalid + exposures.invalid,
      addedArtists: 0,
      addedVersionRules: 0,
      addedFeedback: 0,
      addedPlayEvents: 0,
      addedExposures: 0
    };

    for (const imported of ratings.items) {
      await this.mergeRating(imported, strategy, options, report);
    }

    for (const artist of artists.items) {
      if (!this.storage.isArtistUriBlocked(artist.artistUri)) {
        await this.storage.blockArtist(artist);
        report.addedArtists++;
      }
    }

    const existingRules = await this.storage.getAllVersionRules();
    const ruleKey = (rule: VersionBlockRule) => `${rule.artistName.toLowerCase()}:::${rule.trackName.toLowerCase()}`;
    const knownRules = new Set(existingRules.map(ruleKey));
    for (const rule of rules.items) {
      if (!knownRules.has(ruleKey(rule))) {
        await this.blacklist.addVersionRule(rule);
        knownRules.add(ruleKey(rule));
        report.addedVersionRules++;
      }
    }

    const knownFeedback = new Set((await this.storage.getAllComparativeFeedbacks()).map((f) => f.id));
    for (const item of feedback.items) {
      if (!knownFeedback.has(item.id)) {
        await this.storage.saveComparativeFeedback(item);
        report.addedFeedback++;
      }
    }

    const knownPlays = new Set((await this.storage.getAllPlayEvents()).map((e) => e.id));
    for (const event of plays.items) {
      if (!knownPlays.has(event.id)) {
        await this.storage.savePlayEvent(event);
        report.addedPlayEvents++;
      }
    }

    const knownExposures = new Set((await this.storage.getAllExposures()).map((e) => e.id));
    const newExposures = exposures.items.filter((e) => !knownExposures.has(e.id));
    if (newExposures.length > 0) await this.storage.saveExposures(newExposures);
    report.addedExposures = newExposures.length;

    return report;
  }

  /**
   * Mirrors the ratings into the dedicated playlists: tracks that left a rating leave its playlist.
   * New playlists stay off the public profile, since one of them lists what the user dislikes.
   */
  async syncPlaylists(): Promise<PlaylistSyncResult[]> {
    const bridge = this.playlists;
    if (!bridge) throw new Error('Integração com playlists indisponível');

    const ratings = await this.storage.getAllRatings();
    const results: PlaylistSyncResult[] = [];

    for (const { name, rating } of SYNC_PLAYLISTS) {
      const desired = new Set(
        ratings.filter((r) => r.rating === rating && r.uri.startsWith('spotify:track:')).map((r) => r.uri)
      );
      results.push(await this.syncOnePlaylist(bridge, name, desired));
    }

    return results;
  }

  /** Makes a playlist hold exactly these tracks, creating it private when missing. */
  async replacePlaylist(name: string, uris: readonly string[]): Promise<PlaylistSyncResult> {
    const bridge = this.playlists;
    if (!bridge) throw new Error('Integração com playlists indisponível');
    return this.syncOnePlaylist(bridge, name, new Set(uris));
  }

  /**
   * Imports what appeared in the Trash Bin since the last call. A URI is only imported the first time
   * it is seen, otherwise unblocking a track here would be undone by the Trash Bin on the next run.
   * Writing back is deliberately absent: Trash Bin rewrites its lists from memory, so anything stored
   * from outside is lost on its next change.
   */
  async syncTrashBin(force: boolean = false): Promise<{ importedSongs: number; importedArtists: number }> {
    const store = this.keyValue;
    if (!store) return { importedSongs: 0, importedArtists: 0 };

    const rawSongs = store.get('TrashSongList') ?? '{}';
    const rawArtists = store.get('TrashArtistList') ?? '{}';
    const snapshot = `${rawSongs}\n${rawArtists}`;
    if (!force && snapshot === this.lastTrashSnapshot) {
      return { importedSongs: 0, importedArtists: 0 };
    }
    this.lastTrashSnapshot = snapshot;

    const songs = this.parseFlags(rawSongs);
    const artists = this.parseFlags(rawArtists);
    const seen = force ? new Set<string>() : new Set(this.parseSeen(store.get(TRASH_SEEN_KEY)));

    const pick = (flags: Record<string, boolean>) => Object.fromEntries(
      Object.entries(flags).filter(([uri, banned]) => banned && !seen.has(uri))
    );

    const result = await this.blacklist.importFromTrashBin(pick(songs), pick(artists));

    const known = new Set([...this.parseSeen(store.get(TRASH_SEEN_KEY)), ...Object.keys(songs), ...Object.keys(artists)]);
    store.set(TRASH_SEEN_KEY, JSON.stringify(Array.from(known)));

    return result;
  }

  private toJspfTrack(metadata: TrackMetadata, extension: Record<string, unknown>): Record<string, unknown> {
    const id = metadata.uri.split(':')[2];
    return {
      title: metadata.name,
      creator: metadata.artists.map((a) => a.name).join(', '),
      album: metadata.album.name,
      duration: metadata.duration_ms,
      identifier: metadata.uri.startsWith('spotify:track:') ? [`https://open.spotify.com/track/${id}`] : [],
      extension: { [JSPF_EXTENSION]: extension }
    };
  }

  private jspfFile(filename: string, title: string, track: Array<Record<string, unknown>>): ExportFile {
    return {
      filename,
      mimeType: 'application/json',
      content: JSON.stringify({
        playlist: {
          title,
          creator: 'NeuralTune',
          date: new Date(this.now()).toISOString(),
          track
        }
      }, null, 2)
    };
  }

  private countFeatureSources(ratings: TrackRatingRecord[]): Record<string, number> {
    const sources: Record<string, number> = {};
    for (const { metadata } of ratings) {
      const source = metadata.acousticFeatures?.source ?? 'Sem dados acústicos';
      sources[source] = (sources[source] ?? 0) + 1;
    }
    return sources;
  }

  private computeTrackStats(events: PlayEvent[]): Map<string, TrackStats> {
    const stats = new Map<string, TrackStats>();

    for (const event of events) {
      const entry = stats.get(event.uri) ?? { uri: event.uri, plays: 0, skips: 0, lastPlayedAt: null };
      if (event.playedMs >= COUNTED_PLAY_MS) entry.plays++;
      if (event.skipped) entry.skips++;
      entry.lastPlayedAt = Math.max(entry.lastPlayedAt ?? 0, event.startedAt);
      stats.set(event.uri, entry);
    }

    return stats;
  }

  /** Ratings made from a context menu or migrated from Trash Bin carry no names. Best effort. */
  async enrichPlaceholders(): Promise<number> {
    if (!this.resolveTracks) return 0;

    const ratings = await this.storage.getAllRatings();
    const placeholders = ratings.filter((r) => isPlaceholder(r.metadata) && r.uri.startsWith('spotify:track:'));
    if (placeholders.length === 0) return 0;

    let resolved: Map<string, TrackMetadata>;
    try {
      resolved = await this.resolveTracks(placeholders.map((r) => r.uri));
    } catch (err) {
      console.warn('[NeuralTune] Metadados indisponíveis para a exportação', err);
      return 0;
    }

    let enriched = 0;
    for (const record of placeholders) {
      const metadata = resolved.get(record.uri);
      if (!metadata) continue;
      const patched = await patchRatingMetadata(this.storage, record.uri, (known) => ({
        ...metadata,
        acousticFeatures: metadata.acousticFeatures ?? known.acousticFeatures
      }));
      if (patched) enriched++;
    }
    return enriched;
  }

  private parseImport(text: string): Record<string, unknown> {
    let data: unknown;
    try {
      data = JSON.parse(text.replace(/^﻿/, ''));
    } catch {
      throw new Error('O arquivo não é um JSON válido.');
    }

    if (typeof data !== 'object' || data === null || !Array.isArray((data as Record<string, unknown>).ratings)) {
      throw new Error('O arquivo não parece ser uma exportação do NeuralTune.');
    }

    const version = (data as Record<string, unknown>).schemaVersion ?? (data as Record<string, unknown>).version;
    if (typeof version !== 'number' || version > EXPORT_SCHEMA_VERSION) {
      throw new Error(`Versão de exportação não suportada: ${String(version)}.`);
    }

    return data as Record<string, unknown>;
  }

  private async mergeRating(
    imported: TrackRatingRecord,
    strategy: MergeStrategy,
    options: ImportOptions,
    report: ImportReport
  ): Promise<void> {
    const local = await this.storage.getRating(imported.uri);

    if (!local) {
      await this.storage.saveRating(imported);
      report.addedRatings++;
      return;
    }

    if (local.rating === imported.rating) {
      const metadata = this.mergeMetadata(local.metadata, imported.metadata);
      if (metadata !== local.metadata) await this.storage.saveRating({ ...local, metadata });
      return;
    }

    report.conflicts++;
    const winner = await this.pickWinner(local, imported, strategy, options);

    if (winner === 'local') {
      report.keptLocal++;
      if (local.rating === 0) report.keptBlocks++;
      const metadata = this.mergeMetadata(local.metadata, imported.metadata);
      if (metadata !== local.metadata) await this.storage.saveRating({ ...local, metadata });
      return;
    }

    if (local.rating === 0) report.unblockedByMerge++;
    await this.storage.saveRating({
      ...imported,
      metadata: this.mergeMetadata(imported.metadata, local.metadata)
    });
    report.replacedRatings++;
  }

  private async pickWinner(
    local: TrackRatingRecord,
    imported: TrackRatingRecord,
    strategy: MergeStrategy,
    options: ImportOptions
  ): Promise<'local' | 'imported'> {
    if (strategy === 'replace') return 'imported';
    if (strategy === 'keepLocal') return 'local';
    if (strategy === 'ask' && options.resolveConflict) {
      const name = local.metadata.name || imported.metadata.name || local.uri;
      return options.resolveConflict({ uri: local.uri, name, local, imported });
    }
    if (strategy === 'newest') {
      return imported.timestamp > local.timestamp ? 'imported' : 'local';
    }
    // 0★ is a block, not a low score: a higher number in a file is not the user changing their mind
    if (local.rating === 0) return 'local';
    return imported.rating > local.rating ? 'imported' : 'local';
  }

  /** Keeps `primary`, borrowing what only `secondary` knows. Returns `primary` itself if nothing changed. */
  private mergeMetadata(primary: TrackMetadata, secondary: TrackMetadata): TrackMetadata {
    const base = isPlaceholder(primary) && !isPlaceholder(secondary) ? secondary : primary;
    const features = base.acousticFeatures ?? primary.acousticFeatures ?? secondary.acousticFeatures;

    if (base === primary && features === primary.acousticFeatures) return primary;
    return { ...base, acousticFeatures: features };
  }

  private async syncOnePlaylist(
    bridge: PlaylistBridge,
    name: string,
    desired: Set<string>
  ): Promise<PlaylistSyncResult> {
    const result: PlaylistSyncResult = { name, uri: null, created: false, added: 0, removed: 0, total: desired.size };

    try {
      result.uri = await bridge.findPlaylistByName(name);

      if (!result.uri) {
        if (desired.size === 0) return result;
        result.uri = await bridge.createPlaylist(name);
        if (!result.uri) throw new Error('O Spotify não criou a playlist');
        result.created = true;
      }

      const items = result.created ? [] : await bridge.getPlaylistItems(result.uri);
      const present = new Set<string>();
      const toRemove: Array<{ uri: string; uid: string }> = [];

      for (const item of items) {
        if (desired.has(item.uri) && !present.has(item.uri)) present.add(item.uri);
        else toRemove.push(item);
      }

      for (const chunk of chunks(toRemove, PLAYLIST_CHUNK_SIZE)) {
        await bridge.removeTracks(result.uri, chunk);
        result.removed += chunk.length;
      }

      const toAdd = Array.from(desired).filter((uri) => !present.has(uri));
      for (const chunk of chunks(toAdd, PLAYLIST_CHUNK_SIZE)) {
        await bridge.addTracks(result.uri, chunk);
        result.added += chunk.length;
      }
    } catch (err) {
      result.error = err instanceof Error ? err.message : String(err);
    }

    return result;
  }

  private parseFlags(raw: string): Record<string, boolean> {
    try {
      const parsed: unknown = JSON.parse(raw);
      return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, boolean> : {};
    } catch {
      return {};
    }
  }

  private parseSeen(raw: string | null): string[] {
    try {
      const parsed: unknown = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed.filter((u): u is string => typeof u === 'string') : [];
    } catch {
      return [];
    }
  }
}
