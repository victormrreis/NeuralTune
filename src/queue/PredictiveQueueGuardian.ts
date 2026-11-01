import { BlacklistManager } from '../core/BlacklistManager.ts';
import {
  TrackMetadata,
  QueueStateSummary,
  LoopProtectionConfig
} from '../types/index.ts';

export interface QueuePlatformBridge {
  getQueueState(): QueueStateSummary | null;
  removeFromQueue(items: Array<{ uri: string; uid?: string }>): Promise<void>;
  skipNext(): void;
  pause(): void;
  notify(message: string, isError?: boolean): void;
  getCurrentUri?(): string | null;
  getVolume?(): number;
  setVolume?(level: number): void;
  /** Keeps the level a muted skip must restore across a crash. Null clears it. */
  persistMutedVolume?(level: number | null): void;
}

export const QueuePlatformBridge = {};

export interface GuardianConfig extends LoopProtectionConfig {
  maxConsecutiveBlocked: number;
  skipSettleMs: number;
  duplicateSkipMs: number;
  restoreDelayMs: number;
  restoreTimeoutMs: number;
  evictionTtlMs: number;
}

export const GuardianConfig = {};

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class PredictiveQueueGuardian {
  private blacklist: BlacklistManager;
  private bridge: QueuePlatformBridge;
  private config: GuardianConfig;

  // Circuit breaker state
  private skipTimestamps: number[] = [];
  private consecutiveRemovals = 0;
  private consecutiveBlocked = 0;
  private lastBlocked: { uri: string; at: number } | null = null;
  private recentEvictedUris: Map<string, number> = new Map();
  private isProcessing = false;
  private rerunPending = false;
  private circuitTripped = false;

  // Muted skip state: survives a chain of blocked tracks, so the chain restores the original level
  private lastSkip: { uri: string; at: number } | null = null;
  private savedVolume: number | null = null;
  private restoreTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    blacklist: BlacklistManager,
    bridge: QueuePlatformBridge,
    config: Partial<GuardianConfig> = {}
  ) {
    this.blacklist = blacklist;
    this.bridge = bridge;
    this.config = {
      maxSkipsInWindow: config.maxSkipsInWindow ?? 10,
      windowMs: config.windowMs ?? 5000,
      maxConsecutiveRemovals: config.maxConsecutiveRemovals ?? 500,
      maxConsecutiveBlocked: config.maxConsecutiveBlocked ?? 10,
      skipSettleMs: config.skipSettleMs ?? 120,
      duplicateSkipMs: config.duplicateSkipMs ?? 400,
      restoreDelayMs: config.restoreDelayMs ?? 150,
      restoreTimeoutMs: config.restoreTimeoutMs ?? 2500,
      evictionTtlMs: config.evictionTtlMs ?? 30_000
    };
  }

  isCircuitTripped(): boolean {
    return this.circuitTripped;
  }

  resetCircuit(): void {
    this.circuitTripped = false;
    this.skipTimestamps = [];
    this.consecutiveRemovals = 0;
    this.consecutiveBlocked = 0;
    this.lastBlocked = null;
    this.recentEvictedUris.clear();
  }

  /**
   * Skips a track the user has just blocked. Rating 0 also triggers an inspection that may have
   * started this same skip, and a second Player.next() would throw away the following good track.
   */
  async skipBlockedCurrent(uri: string): Promise<void> {
    if (this.isDuplicateSkip(uri)) return;
    await this.muteAndSkip(uri);
  }

  /**
   * Proactively scans upcoming tracks in queue and removes blocked tracks BEFORE they play.
   */
  async inspectAndCleanQueue(preserveManualQueued: boolean = true): Promise<{
    removedCount: number;
    removedTracks: TrackMetadata[];
    circuitBreakerTripped: boolean;
  }> {
    if (this.isProcessing) {
      // The songchange of our own skip lands here. Dropping it would leave the player muted until the
      // safety timer, and the good track would never reset the counters.
      this.rerunPending = true;
      return { removedCount: 0, removedTracks: [], circuitBreakerTripped: this.circuitTripped };
    }
    if (this.circuitTripped) {
      return { removedCount: 0, removedTracks: [], circuitBreakerTripped: true };
    }

    this.isProcessing = true;
    const removedTracks: TrackMetadata[] = [];

    try {
      const state = this.bridge.getQueueState();
      if (!state) {
        return { removedCount: 0, removedTracks: [], circuitBreakerTripped: false };
      }

      // Check current track if already active (safety fallback)
      if (state.current) {
        const isCurrentBlocked = this.blacklist.isRejected(state.current);

        if (isCurrentBlocked) {
          this.countBlockedArrival(state.current.uri);
          const looping = this.recordSkipAttempt();

          if (this.consecutiveBlocked >= this.config.maxConsecutiveBlocked) {
            this.handleCircuitBreak(
              `${this.consecutiveBlocked} faixas bloqueadas seguidas. Reprodução pausada, escolha outra música.`
            );
            return { removedCount: 0, removedTracks: [], circuitBreakerTripped: true };
          }
          if (looping) {
            this.handleCircuitBreak('Loop detectado na faixa atual. Reprodução pausada.');
            return { removedCount: 0, removedTracks: [], circuitBreakerTripped: true };
          }

          // Reactive skip ONLY as last resort if track slipped through
          if (!this.isDuplicateSkip(state.current.uri)) {
            await this.muteAndSkip(state.current.uri);
          }
        } else {
          this.consecutiveBlocked = 0;
          this.lastBlocked = null;
          this.skipTimestamps = [];
          this.scheduleVolumeRestore(this.config.restoreDelayMs);
        }
      }

      // Proactive Lookahead: check nextUp and optionally queued
      const candidatesToInspect: TrackMetadata[] = [];

      // Check nextUp (context generated tracks, autoplay, radios)
      for (const track of state.nextUp) {
        candidatesToInspect.push(track);
      }

      // Check queued (manual user queue) only if preserveManualQueued is false
      if (!preserveManualQueued) {
        for (const track of state.queued) {
          candidatesToInspect.push(track);
        }
      }

      const itemsToRemove: Array<{ uri: string; uid?: string }> = [];
      const now = Date.now();

      for (const [uri, evictedAt] of this.recentEvictedUris) {
        if (now - evictedAt >= this.config.evictionTtlMs) this.recentEvictedUris.delete(uri);
      }

      for (const track of candidatesToInspect) {
        const blocked = this.blacklist.isRejected(track);

        if (blocked) {
          // Prevent cycle of repeatedly trying to remove the exact same track
          if (this.recentEvictedUris.has(track.uri)) {
            continue;
          }

          itemsToRemove.push({ uri: track.uri, uid: track.uid });
          removedTracks.push(track);
          this.recentEvictedUris.set(track.uri, now);
          this.consecutiveRemovals++;

          if (this.consecutiveRemovals >= this.config.maxConsecutiveRemovals) {
            this.handleCircuitBreak(
              `Limite de segurança atingido (${this.config.maxConsecutiveRemovals} faixas removidas). Fila pode estar vazia ou esgotada.`
            );
            break;
          }
        } else {
          // Reset consecutive removals counter once an eligible track is found
          this.consecutiveRemovals = 0;
        }
      }

      if (itemsToRemove.length > 0) {
        await this.bridge.removeFromQueue(itemsToRemove);
      }
    } finally {
      this.isProcessing = false;
      if (this.rerunPending) {
        this.rerunPending = false;
        this.inspectAndCleanQueue(preserveManualQueued).catch((err) => {
          console.warn('[NeuralTune] Reinspeção da fila falhou', err);
        });
      }
    }

    return {
      removedCount: removedTracks.length,
      removedTracks,
      circuitBreakerTripped: this.circuitTripped
    };
  }

  private recordSkipAttempt(): boolean {
    const now = Date.now();
    this.skipTimestamps.push(now);

    // Filter out timestamps outside window
    this.skipTimestamps = this.skipTimestamps.filter(
      (ts) => now - ts < this.config.windowMs
    );

    return this.skipTimestamps.length >= this.config.maxSkipsInWindow;
  }

  private isDuplicateSkip(uri: string): boolean {
    return this.lastSkip?.uri === uri && Date.now() - this.lastSkip.at < this.config.duplicateSkipMs;
  }

  /** Several triggers can report one arrival: songchange, queue_update and a rating. */
  private countBlockedArrival(uri: string): void {
    const now = Date.now();
    const repeated = this.lastBlocked?.uri === uri && now - this.lastBlocked.at < this.config.duplicateSkipMs;
    if (!repeated) this.consecutiveBlocked++;
    this.lastBlocked = { uri, at: now };
  }

  /**
   * Silences the track right away, then lets Trash Bin act first: it also calls Player.next() from its
   * own songchange handler, and skipping on top of it would throw away the next good track.
   */
  private async muteAndSkip(uri: string): Promise<void> {
    this.lastSkip = { uri, at: Date.now() };
    this.mute();

    await delay(this.config.skipSettleMs);

    const current = this.bridge.getCurrentUri?.() ?? uri;
    if (current === uri) {
      this.bridge.skipNext();
    }
  }

  private mute(): void {
    const { getVolume, setVolume } = this.bridge;
    if (!getVolume || !setVolume) return;

    // Inside a chain the live level is already 0: reading it again would lose the original
    if (this.savedVolume === null) {
      const level = getVolume.call(this.bridge);
      if (level <= 0) return;
      this.savedVolume = level;
      this.bridge.persistMutedVolume?.(level);
      setVolume.call(this.bridge, 0);
    }

    this.scheduleVolumeRestore(this.config.restoreTimeoutMs);
  }

  /** Always armed while muted, so no path can leave the player silent. */
  private scheduleVolumeRestore(delayMs: number): void {
    if (this.savedVolume === null) return;

    if (this.restoreTimer) clearTimeout(this.restoreTimer);
    this.restoreTimer = setTimeout(() => this.restoreVolume(), delayMs);
  }

  private restoreVolume(): void {
    if (this.restoreTimer) {
      clearTimeout(this.restoreTimer);
      this.restoreTimer = null;
    }
    if (this.savedVolume === null) return;

    this.bridge.setVolume?.(this.savedVolume);
    this.bridge.persistMutedVolume?.(null);
    this.savedVolume = null;
  }

  private handleCircuitBreak(reason: string): void {
    this.circuitTripped = true;
    this.bridge.pause();
    this.restoreVolume();
    this.bridge.notify(`[NeuralTune] Proteção contra Loops: ${reason}`, true);
  }
}
