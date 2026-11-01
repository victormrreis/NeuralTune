import { BlacklistManager } from '../core/BlacklistManager.ts';
import { QueueStateSummary, TrackMetadata } from '../types/index.ts';

export interface AutopilotBridge {
  getQueueState(): QueueStateSummary | null;
  addToQueue(tracks: Array<{ uri: string }>): Promise<void>;
  notify(message: string, isError?: boolean): void;
}
export const AutopilotBridge = {};

export interface ChoiceTerms {
  preference: number;
  discovery: number;
  continuity: number;
  calibration: number;
  satisfaction: number; // Share of past listens of similar tracks finished: never time on platform
  risk: number;
}
export const ChoiceTerms = {};

/** Preference leads; risk equals discovery, so an uncertain pick must earn its place. Set by hand. */
export const DEFAULT_CHOICE_WEIGHTS: ChoiceTerms = {
  preference: 0.4, discovery: 0.1, continuity: 0.2, calibration: 0.15, satisfaction: 0.15, risk: 0.1
};

/** J(x) = w₁ Pref + w₂ Disc + w₃ Cont + w₄ Calib + w₅ Satisf - w₆ Risk, with every term in [0, 1]. */
export function choiceObjective(terms: ChoiceTerms, weights: ChoiceTerms = DEFAULT_CHOICE_WEIGHTS): number {
  return weights.preference * terms.preference
    + weights.discovery * terms.discovery
    + weights.continuity * terms.continuity
    + weights.calibration * terms.calibration
    + weights.satisfaction * terms.satisfaction
    - weights.risk * terms.risk;
}

const LOW_WATER_MARK = 3;
const BATCH_SIZE = 5;

export type CandidateSource = (current: TrackMetadata | null, excluded: ReadonlySet<string>, count: number) => Promise<TrackMetadata[]>;

/**
 * Tops up the user queue while enabled. It only adds: it cannot govern Spotify's Autoplay, and what
 * sits in `nextUp` is the context's own. If the client rearranges the queue, the next tick recounts from
 * the real state instead of a stored plan, which is the whole reconciliation.
 */
export class AutopilotDaemon {
  private bridge: AutopilotBridge;
  private blacklist: BlacklistManager;
  private source: CandidateSource;
  private enabled = false;
  private ticking = false;
  private generation = 0;
  private added = new Set<string>();

  constructor(bridge: AutopilotBridge, blacklist: BlacklistManager, source: CandidateSource) {
    this.bridge = bridge;
    this.blacklist = blacklist;
    this.source = source;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  toggle(): boolean {
    this.enabled = !this.enabled;
    this.generation++;
    if (this.enabled) this.added.clear();
    this.bridge.notify(`[NeuralTune] Autopilot ${this.enabled ? 'ligado' : 'desligado'}.`);
    if (this.enabled) void this.tick();
    return this.enabled;
  }

  /** Runs on song and queue changes. Reentrant calls are dropped: the running tick sees the same state. */
  async tick(): Promise<number> {
    if (!this.enabled || this.ticking) return 0;

    const state = this.bridge.getQueueState();
    if (!state) return 0;

    const eligible = state.queued.filter((t) => !this.blacklist.isBlockedFast(t.uri, t.artists.map((a) => a.uri)));
    if (eligible.length >= LOW_WATER_MARK) return 0;

    this.ticking = true;
    const generation = this.generation;

    try {
      const excluded = new Set([
        ...state.queued.map((t) => t.uri),
        ...state.nextUp.map((t) => t.uri),
        ...this.added,
        ...(state.current ? [state.current.uri] : [])
      ]);

      const proposals = await this.source(state.current ?? null, excluded, BATCH_SIZE);

      // Switching off during the await must stop here, before touching the queue
      if (!this.enabled || generation !== this.generation) return 0;

      const accepted = proposals.filter((t) => {
        return !excluded.has(t.uri) && !this.blacklist.isBlockedFast(t.uri, t.artists.map((a) => a.uri));
      });
      const unique = Array.from(new Map(accepted.map((t) => [t.uri, t])).values());
      if (unique.length === 0) return 0;

      await this.bridge.addToQueue(unique.map((t) => ({ uri: t.uri })));
      for (const track of unique) this.added.add(track.uri);
      return unique.length;
    } catch (err) {
      console.warn('[NeuralTune] Autopilot: não foi possível completar a fila', err);
      return 0;
    } finally {
      this.ticking = false;
    }
  }
}
