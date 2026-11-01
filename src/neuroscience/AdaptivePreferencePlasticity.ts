export type InteractionKind =
  | 'rating'
  | 'complete-listen'
  | 'partial-listen'
  | 'early-skip'
  | 'involuntary-exposure'
  | 'steer-more'
  | 'steer-less';
export const InteractionKind = {};

export interface InteractionEvent {
  kind: InteractionKind;
  key: string;           // Cluster or artist the evidence is about
  timestamp: number;
  rating?: number;
  voluntary?: boolean;
}
export const InteractionEvent = {};

interface Trace {
  durable: number;
  momentary: number;
  skipStreak: number;
  updatedAt: number;
}

export interface PlasticityConfig {
  durableHalfLifeMs: number;
  momentaryHalfLifeMs: number;
  durableRate: number;
  momentaryRate: number;
  skipsForEvidence: number;
}
export const PlasticityConfig = {};

const DAY_MS = 86_400_000;

const DEFAULT_CONFIG: PlasticityConfig = {
  durableHalfLifeMs: 180 * DAY_MS,
  momentaryHalfLifeMs: 45 * 60_000,
  durableRate: 0.2,
  momentaryRate: 0.5,
  skipsForEvidence: 2
};

const RATING_SIGNAL: Record<number, number> = { 0: -1, 1: -0.6, 2: -0.3, 3: 0, 4: 0.5, 5: 1 };

/**
 * Evidence Δ_t of one event. The mapping is a modeling decision, not a biological fact. Exposure is
 * always 0: hearing something the player chose says nothing by itself. A skip is 0 until repeated, and
 * every implicit signal is weaker than any non-neutral rating.
 */
export function evidenceOf(event: InteractionEvent, skipStreak: number, skipsForEvidence: number): number {
  switch (event.kind) {
    case 'rating': return RATING_SIGNAL[event.rating ?? 3] ?? 0;
    case 'complete-listen': return event.voluntary ? 0.25 : 0.1;
    case 'partial-listen': return 0.03;
    case 'early-skip': return skipStreak >= skipsForEvidence ? -0.2 : 0;
    case 'involuntary-exposure': return 0;
    case 'steer-more': return RATING_SIGNAL[4];
    case 'steer-less': return RATING_SIGNAL[2];
  }
}

/**
 * w_{t+1} = w_t + η_t Δ_t with soft bounds at ±1: η shrinks as w nears the bound it is moving towards.
 * Rubin et al. (2001) show the equilibrium of Hebbian-style rules depends on how bounds are imposed,
 * and Zenke, Gerstner & Ganguli (2017) that Hebbian growth needs a stabilizer: bounded, decaying weights are
 * what is taken from them. There is no spike-timing analogue here, since no digital event has one.
 *
 * Two traces separate lasting taste from the mood of a session; both decay exponentially between
 * events, so an old taste fades without being erased and returns as soon as evidence does.
 */
export class AdaptivePreferencePlasticity {
  private config: PlasticityConfig;
  private traces = new Map<string, Trace>();

  constructor(config: Partial<PlasticityConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  private decayed(trace: Trace, now: number): void {
    const age = Math.max(0, now - trace.updatedAt);
    trace.durable *= 2 ** (-age / this.config.durableHalfLifeMs);
    trace.momentary *= 2 ** (-age / this.config.momentaryHalfLifeMs);
    trace.updatedAt = now;
  }

  observe(event: InteractionEvent): void {
    let trace = this.traces.get(event.key);
    if (!trace) {
      trace = { durable: 0, momentary: 0, skipStreak: 0, updatedAt: event.timestamp };
      this.traces.set(event.key, trace);
    }
    this.decayed(trace, event.timestamp);

    if (event.kind === 'early-skip') trace.skipStreak++;
    else if (event.kind !== 'involuntary-exposure') trace.skipStreak = 0;

    const delta = evidenceOf(event, trace.skipStreak, this.config.skipsForEvidence);
    if (delta === 0) return;

    const bound = delta > 0 ? 1 : -1;
    trace.durable += this.config.durableRate * Math.abs(delta) * (bound - trace.durable);
    trace.momentary += this.config.momentaryRate * Math.abs(delta) * (bound - trace.momentary);
  }

  /** Durable taste, then what the current session adds to it. */
  read(key: string, now: number): { durable: number; momentary: number } {
    const trace = this.traces.get(key);
    if (!trace) return { durable: 0, momentary: 0 };

    const age = Math.max(0, now - trace.updatedAt);
    return {
      durable: trace.durable * 2 ** (-age / this.config.durableHalfLifeMs),
      momentary: trace.momentary * 2 ** (-age / this.config.momentaryHalfLifeMs)
    };
  }

  affinity(key: string, now: number): number {
    const { durable, momentary } = this.read(key, now);
    return Math.max(-1, Math.min(1, 0.7 * durable + 0.3 * momentary));
  }
}
