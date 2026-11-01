import { StorageAdapter } from '../storage/StorageAdapter.ts';
import { PlayEvent, PlayFeedback, PlayOrigin, TrackMetadata } from '../types/index.ts';

/** Shorter than this, a playback is an auto-skip or a mis-click and does not count as a listen. */
export const COUNTED_PLAY_MS = 5_000;

const SKIP_THRESHOLD_MS = 30_000;
const SKIP_THRESHOLD_RATIO = 0.5;
const NOISE_FLOOR_MS = 250;

interface ActivePlayback {
  track: TrackMetadata;
  startedAt: number;
  progressMs: number;
  origin?: PlayOrigin;
  feedback?: PlayFeedback;
}

export function isSkip(playedMs: number, durationMs?: number): boolean {
  const threshold = durationMs ? Math.min(SKIP_THRESHOLD_MS, durationMs * SKIP_THRESHOLD_RATIO) : SKIP_THRESHOLD_MS;
  return playedMs < threshold;
}

/** Closes one PlayEvent per track change. Progress comes from the player, so pauses do not inflate it. */
export class PlaybackHistoryTracker {
  private storage: StorageAdapter;
  private onRecorded?: (event: PlayEvent) => void;
  private now: () => number;
  private originOf?: (track: TrackMetadata) => PlayOrigin;
  private active: ActivePlayback | null = null;

  constructor(
    storage: StorageAdapter,
    onRecorded?: (event: PlayEvent) => void,
    now: () => number = Date.now,
    originOf?: (track: TrackMetadata) => PlayOrigin
  ) {
    this.storage = storage;
    this.onRecorded = onRecorded;
    this.now = now;
    this.originOf = originOf;
  }

  updateProgress(progressMs: number): void {
    if (this.active && Number.isFinite(progressMs)) {
      this.active.progressMs = progressMs;
    }
  }

  /** The event only closes when the track ends, so the signal waits on the playback in progress. */
  markFeedback(feedback: PlayFeedback): void {
    if (this.active) this.active.feedback = feedback;
  }

  async onTrackChange(track: TrackMetadata | null): Promise<void> {
    if (track && this.active?.track.uri === track.uri) return;

    const previous = this.active;
    this.active = track?.uri.startsWith('spotify:track:')
      ? { track, startedAt: this.now(), progressMs: 0, origin: this.originOf?.(track) }
      : null;

    if (previous) await this.close(previous);
  }

  async flush(): Promise<void> {
    const previous = this.active;
    this.active = null;
    if (previous) await this.close(previous);
  }

  private async close(playback: ActivePlayback): Promise<void> {
    const { track, startedAt, progressMs, origin, feedback } = playback;
    if (progressMs < NOISE_FLOOR_MS && this.now() - startedAt < NOISE_FLOOR_MS) return;

    const event: PlayEvent = {
      id: `${track.uri}@${startedAt}`,
      uri: track.uri,
      name: track.name,
      artistUris: track.artists.map((a) => a.uri).filter(Boolean),
      startedAt,
      endedAt: this.now(),
      playedMs: Math.round(progressMs),
      durationMs: track.duration_ms,
      skipped: isSkip(progressMs, track.duration_ms),
      artistNames: track.artists.map((a) => a.name).filter(Boolean),
      ...(origin ? { origin } : {}),
      ...(feedback ? { feedback } : {})
    };

    this.onRecorded?.(event);
    try {
      await this.storage.savePlayEvent(event);
    } catch (err) {
      console.warn('[NeuralTune] Falha ao gravar evento de reprodução', err);
    }
  }
}
