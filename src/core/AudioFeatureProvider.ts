import { StorageAdapter } from '../storage/StorageAdapter.ts';
import { withTimeout } from './AsyncGuards.ts';
import { SYNTHESIS_VERSION, SYNTHESIZED_SOURCE } from './AudioAnalysisSynthesizer.ts';
import { AcousticFeatures, AudioFeatureRecord, TrackMetadata } from '../types/index.ts';

const BATCH_SIZE = 100;
const RETRY_AFTER_FAILURE_MS = 60_000;
const CALL_TIMEOUT_MS = 6_000;

export const REAL_FEATURES_SOURCE = 'Spotify Audio Features';

export interface RawAudioFeatures {
  uri?: string;
  id?: string;
  tempo?: number;
  key?: number;
  energy?: number;
  danceability?: number;
  acousticness?: number;
  instrumentalness?: number;
  valence?: number;
  speechiness?: number;
  liveness?: number;
}
export const RawAudioFeatures = {};

export interface AudioFeatureBridge {
  /** Spotify's audio-features batch. Rejects with an object carrying `code` or `status` on HTTP errors. */
  fetchBatch(trackIds: string[]): Promise<Array<RawAudioFeatures | null>>;
  /** Spotify's audio-analysis, already reduced to features. Heavy and per track, but open to this client. */
  fetchAnalysis?(uri: string): Promise<AcousticFeatures | null>;
}
export const AudioFeatureBridge = {};

export type AudioFeatureStatus = 'unknown' | 'available' | 'backing-off' | 'unavailable';

export interface AudioFeatureDiagnostics {
  status: AudioFeatureStatus;
  cachedTracks: number;
  lastError: string | null;
  sources: Record<string, number>;
}
export const AudioFeatureDiagnostics = {};

function trackIdOf(uri: string): string | null {
  return uri.startsWith('spotify:track:') ? uri.slice('spotify:track:'.length) : null;
}

function toFeatures(raw: RawAudioFeatures): AcousticFeatures {
  return {
    bpm: raw.tempo,
    key: raw.key,
    energy: raw.energy,
    danceability: raw.danceability,
    acousticness: raw.acousticness,
    instrumentalness: raw.instrumentalness,
    valence: raw.valence,
    speechiness: raw.speechiness,
    liveness: raw.liveness,
    source: REAL_FEATURES_SOURCE
  };
}

/**
 * Fetches and caches acoustic vectors. Spotify closed audio-features to new Web API apps, so the
 * endpoint may refuse this client: a 403/404 disables it for the session instead of retrying on every
 * track, and audio-analysis supplies tempo, key, mode and estimates of energy and valence instead.
 * Everything downstream tolerates tracks with partial or no features.
 */
export class AudioFeatureProvider {
  private storage: StorageAdapter;
  private bridge: AudioFeatureBridge;
  private now: () => number;

  private cache = new Map<string, AcousticFeatures>();
  private missing = new Set<string>();
  private status: AudioFeatureStatus = 'unknown';
  private retryAt = 0;
  private lastError: string | null = null;
  private analysisRetryAt = 0;
  private analysisRefused = false;
  private timeoutMs: number;

  constructor(storage: StorageAdapter, bridge: AudioFeatureBridge, now: () => number = Date.now, config: { timeoutMs?: number } = {}) {
    this.storage = storage;
    this.bridge = bridge;
    this.now = now;
    this.timeoutMs = config.timeoutMs ?? CALL_TIMEOUT_MS;
  }

  async init(): Promise<void> {
    const records = await this.storage.getAllAudioFeatures();
    for (const record of records) {
      this.cache.set(record.uri, record.features);
    }
  }

  get(uri: string): AcousticFeatures | undefined {
    return this.cache.get(uri);
  }

  attach<T extends TrackMetadata>(track: T): T {
    if (track.acousticFeatures) return track;
    const features = this.cache.get(track.uri);
    return features ? { ...track, acousticFeatures: features } : track;
  }

  getDiagnostics(): AudioFeatureDiagnostics {
    const sources: Record<string, number> = {};
    for (const features of this.cache.values()) {
      const source = features.source ?? 'Desconhecida';
      sources[source] = (sources[source] ?? 0) + 1;
    }
    return { status: this.status, cachedTracks: this.cache.size, lastError: this.lastError, sources };
  }

  /** Resolves every URI it can. Returns how many gained features. */
  async ensure(uris: string[]): Promise<number> {
    const pending = uris.filter((uri) => {
      return trackIdOf(uri) !== null && !this.cache.has(uri) && !this.missing.has(uri);
    });

    let resolved = 0;
    for (let i = 0; i < pending.length && this.canFetch(); i += BATCH_SIZE) {
      resolved += await this.fetchChunk(pending.slice(i, i + BATCH_SIZE));
    }
    return resolved;
  }

  /** `ensure` for the track in playback, which also gets the full per-track analysis. */
  async ensureCurrent(uri: string): Promise<void> {
    await this.ensure([uri]);
    await this.ensureAnalyzed([uri]);
  }

  hasHarmonicData(uri: string): boolean {
    const features = this.cache.get(uri);
    if (typeof features?.mode !== 'number') return false;
    return features.source !== SYNTHESIZED_SOURCE || features.synthesisVersion === SYNTHESIS_VERSION;
  }

  canAnalyze(): boolean {
    return !!this.bridge.fetchAnalysis && !this.analysisRefused && this.now() >= this.analysisRetryAt;
  }

  /** Sequential on purpose: each call downloads a whole analysis. Returns how many gained key data. */
  async ensureAnalyzed(uris: string[], spacingMs: number = 0): Promise<number> {
    let resolved = 0;

    for (const uri of uris) {
      if (!this.canAnalyze()) break;
      if (trackIdOf(uri) === null || this.hasHarmonicData(uri)) continue;

      try {
        const features = await withTimeout(this.bridge.fetchAnalysis!(uri), this.timeoutMs, 'getAudioData');
        if (features) {
          await this.ingest(uri, features);
          if (this.hasHarmonicData(uri)) resolved++;
        }
      } catch (err) {
        this.lastError = describeError(err);
        const code = httpCodeOf(err);
        if (code === 403 || code === 404) this.analysisRefused = true;
        else this.analysisRetryAt = this.now() + RETRY_AFTER_FAILURE_MS;
      }

      if (spacingMs > 0) await new Promise((resolve) => setTimeout(resolve, spacingMs));
    }

    return resolved;
  }

  /** Real audio-features win where they exist: the estimates only fill what is missing. */
  async ingest(uri: string, features: AcousticFeatures): Promise<void> {
    const cached = this.cache.get(uri);
    const merged = cached?.source === REAL_FEATURES_SOURCE
      ? { ...features, ...cached }
      : { ...cached, ...features };

    await this.store([[uri, merged]]);
  }
  private canFetch(): boolean {
    if (this.status === 'unavailable') return false;
    return this.status !== 'backing-off' || this.now() >= this.retryAt;
  }

  private async fetchChunk(uris: string[]): Promise<number> {
    let rows: Array<RawAudioFeatures | null>;
    try {
      rows = await withTimeout(this.bridge.fetchBatch(uris.map((uri) => trackIdOf(uri)!)), this.timeoutMs, 'audio-features');
    } catch (err) {
      this.handleFailure(err);
      return 0;
    }

    this.status = 'available';
    this.lastError = null;

    const entries: Array<[string, AcousticFeatures]> = [];
    uris.forEach((uri, i) => {
      const row = rows[i];
      if (row) entries.push([uri, toFeatures(row)]);
      else this.missing.add(uri);
    });

    await this.store(entries);
    return entries.length;
  }

  private async store(entries: Array<[string, AcousticFeatures]>): Promise<void> {
    if (entries.length === 0) return;
    const fetchedAt = this.now();
    const records: AudioFeatureRecord[] = entries.map(([uri, features]) => {
      this.cache.set(uri, features);
      return { uri, features, fetchedAt };
    });
    await this.storage.saveAudioFeatures(records);
  }

  private handleFailure(err: unknown): void {
    this.lastError = describeError(err);
    const code = httpCodeOf(err);
    if (code === 403 || code === 404) {
      this.status = 'unavailable';
    } else {
      this.status = 'backing-off';
      this.retryAt = this.now() + RETRY_AFTER_FAILURE_MS;
    }
  }
}

function httpCodeOf(err: unknown): number | null {
  if (typeof err !== 'object' || err === null) return null;
  const { code, status } = err as { code?: unknown; status?: unknown };
  if (typeof code === 'number') return code;
  return typeof status === 'number' ? status : null;
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  const code = httpCodeOf(err);
  return code !== null ? `HTTP ${code}` : String(err);
}
