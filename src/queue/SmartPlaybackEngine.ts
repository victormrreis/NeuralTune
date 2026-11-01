import { BlacklistManager } from '../core/BlacklistManager.ts';
import { LatestRunGate, withTimeout } from '../core/AsyncGuards.ts';
import { PreferenceEngine } from '../core/PreferenceEngine.ts';
import { TrackMetadata, PredictionResult } from '../types/index.ts';

export interface SmartPlaybackBridge {
  playTrack(uri: string): Promise<void>;
  addToQueue(tracks: Array<{ uri: string }>): Promise<void>;
  setQueue?(nextTracks: Array<{ uri: string }>): Promise<void>;
  notify(message: string, isError?: boolean): void;
}

export const SmartPlaybackBridge = {};

export interface SmartPlaybackConfig {
  timeoutMs?: number;
}
export const SmartPlaybackConfig = {};

const PLAYER_TIMEOUT_MS = 10_000;

export class SmartPlaybackEngine {
  private blacklist: BlacklistManager;
  private preference: PreferenceEngine;
  private bridge: SmartPlaybackBridge;

  private buffer: TrackMetadata[] = [];
  private history: string[] = []; // Recent artist URIs for anti-fatigue
  private isActive = false;
  private timeoutMs: number;
  private runs = new LatestRunGate();
  private lastStart: Promise<unknown> = Promise.resolve();

  constructor(
    blacklist: BlacklistManager,
    preference: PreferenceEngine,
    bridge: SmartPlaybackBridge,
    config: SmartPlaybackConfig = {}
  ) {
    this.blacklist = blacklist;
    this.preference = preference;
    this.bridge = bridge;
    this.timeoutMs = config.timeoutMs ?? PLAYER_TIMEOUT_MS;
  }

  isManaged(): boolean {
    return this.isActive;
  }

  getBuffer(): TrackMetadata[] {
    return [...this.buffer];
  }

  /**
   * Pre-filters and scores raw candidate tracks, discarding any rejected track.
   * Returns sorted, 100% eligible tracks ready for seamless playback.
   */
  prepareSequence(
    candidates: TrackMetadata[],
    minScoreThreshold: number = 25
  ): {
    eligibleTracks: TrackMetadata[];
    discardedCount: number;
    predictions: PredictionResult[];
  } {
    const predictions: PredictionResult[] = [];
    const belowThreshold: PredictionResult[] = [];
    let discardedCount = 0;

    for (const candidate of candidates) {
      // Fast check
      const isBlocked = this.blacklist.isBlockedFast(
        candidate.uri,
        candidate.artists.map((a) => a.uri)
      );

      if (isBlocked) {
        discardedCount++;
        continue;
      }

      // Evaluate candidate score with preference engine and history
      const evaluation = this.preference.evaluateCandidate(candidate, this.history);
      if (!evaluation.eligible) {
        discardedCount++;
        continue;
      }
      if (evaluation.score < minScoreThreshold) {
        belowThreshold.push(evaluation);
        continue;
      }

      predictions.push(evaluation);
    }

    // Fatigue can sink a whole pool under the threshold. A worn-out track beats silence
    if (predictions.length === 0) predictions.push(...belowThreshold);
    else discardedCount += belowThreshold.length;

    // Sort descending by score
    predictions.sort((a, b) => b.score - a.score);

    // Apply anti-fatigue artist spacing
    const spaced = this.applyAntiFatigueSpacing(predictions.map((p) => p.track));

    return {
      eligibleTracks: spaced,
      discardedCount,
      predictions
    };
  }

  /**
   * Starts playback of a prepared sequence without risk of skips. Starts run one at a time, since the
   * player and queue calls of two overlapping radios would interleave, and the latest request wins:
   * one overtaken while waiting resolves to false and never touches the player.
   */
  startPlayback(tracks: TrackMetadata[]): Promise<boolean> {
    if (tracks.length === 0) {
      this.bridge.notify('Nenhuma faixa elegível disponível para o Smart Playback.', true);
      return Promise.resolve(false);
    }

    const run = this.runs.begin();
    const start = this.lastStart.then(() => (this.runs.isCurrent(run) ? this.play(tracks, run) : false));
    this.lastStart = start.catch(() => undefined);
    return start;
  }

  private async play(tracks: TrackMetadata[], run: number): Promise<boolean> {
    this.isActive = true;
    this.buffer = [...tracks];

    const firstTrack = this.buffer.shift()!;
    this.recordPlayed(firstTrack);

    await withTimeout(this.bridge.playTrack(firstTrack.uri), this.timeoutMs, 'Player');
    if (!this.runs.isCurrent(run)) return false;

    // Queue upcoming buffer tracks
    if (this.buffer.length > 0) {
      await this.fillQueue(this.buffer.slice(0, 15).map((t) => ({ uri: t.uri })));
    }

    this.bridge.notify(`[Smart Playback] Iniciado com ${tracks.length} faixas pré-filtradas.`);
    return true;
  }

  /** The first track is already playing here, so a queue failure degrades the radio without failing it. */
  private async fillQueue(upcoming: Array<{ uri: string }>): Promise<void> {
    try {
      const replacing = this.bridge.setQueue?.(upcoming) ?? this.bridge.addToQueue(upcoming);
      await withTimeout(replacing, this.timeoutMs, 'Fila');
      return;
    } catch (err) {
      console.warn('[NeuralTune] Falha ao substituir a fila', err);
    }

    try {
      await withTimeout(this.bridge.addToQueue(upcoming), this.timeoutMs, 'Fila');
      this.bridge.notify('[Smart Playback] Fila anterior não pôde ser limpa: faixas adicionadas ao final dela.');
    } catch (err) {
      console.warn('[NeuralTune] Falha ao adicionar à fila', err);
      this.bridge.notify('[Smart Playback] A faixa começou, mas a fila não pôde ser montada.', true);
    }
  }

  recordPlayed(track: TrackMetadata): void {
    for (const a of track.artists) {
      this.history.unshift(a.uri);
    }
    // Keep history bounded to 30 items
    if (this.history.length > 30) {
      this.history = this.history.slice(0, 30);
    }
  }

  /**
   * Separates tracks by the same artist to avoid consecutive repetition
   */
  private applyAntiFatigueSpacing(tracks: TrackMetadata[]): TrackMetadata[] {
    if (tracks.length <= 2) return tracks;

    const result: TrackMetadata[] = [];
    const pool = [...tracks];

    while (pool.length > 0) {
      const lastArtistUris = result.length > 0 ? result[result.length - 1].artists.map((a) => a.uri) : [];

      let pickedIndex = pool.findIndex((t) => !t.artists.some((a) => lastArtistUris.includes(a.uri)));
      if (pickedIndex === -1) {
        pickedIndex = 0; // Fallback if impossible to space further
      }

      const [picked] = pool.splice(pickedIndex, 1);
      result.push(picked);
    }

    return result;
  }
}
