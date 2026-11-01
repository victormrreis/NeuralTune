const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

export const SATIATION_LIMIT_MS = 48 * HOUR_MS;
export const REACTIVATION_START_MS = 72 * HOUR_MS;

const SATIATION_HORIZONS = [
  { tauMs: 30 * MINUTE_MS, weight: 0.55 },
  { tauMs: 2 * HOUR_MS, weight: 0.3 },
  { tauMs: 24 * HOUR_MS, weight: 0.15 }
];

const BASE_DECAY = 0.5;
const AFFINITY_DECAY_SLOWDOWN = 0.5;
const MIN_AFFINITY = 0.5;
const MIN_AGE_DAYS = 0.01;

const ZONE_YOUNGEST_DAYS = 7;
const ZONE_OLDEST_DAYS = 30;

// Raw B_i grows with every listen, so a favorite heard across months would stay above the zone forever.
// Discounting most of ln m keeps repetition delaying the return without ever cancelling it.
const FREQUENCY_DISCOUNT = 0.7;

export const NOSTALGIA_MIN_POINTS = 8;
export const NOSTALGIA_MAX_POINTS = 12;

/** Inhibition from recent exposures. Each listen fades over the 30 min, 2 h and 24 h horizons. */
export function satiationExposure(timestamps: readonly number[] | undefined, now: number): number {
  if (!timestamps) return 0;

  let exposure = 0;
  for (const timestamp of timestamps) {
    const age = Math.max(0, now - timestamp);
    if (age >= SATIATION_LIMIT_MS) continue;
    for (const { tauMs, weight } of SATIATION_HORIZONS) {
      exposure += weight * Math.exp(-age / tauMs);
    }
  }
  return exposure;
}

/** d_i = d₀ e^(-β·affinity): the more a track is liked, the slower it leaves memory. */
export function decayRate(affinity: number): number {
  return BASE_DECAY * Math.exp(-AFFINITY_DECAY_SLOWDOWN * affinity);
}

/** B_i(t) = ln Σ_k Δt_k^(-d_i), the ACT-R base-level activation, with Δt in days. */
export function baseLevelActivation(timestamps: readonly number[], now: number, affinity: number): number {
  const decay = decayRate(affinity);
  let sum = 0;
  for (const timestamp of timestamps) {
    const days = Math.max(MIN_AGE_DAYS, (now - timestamp) / DAY_MS);
    sum += days ** -decay;
  }
  return sum > 0 ? Math.log(sum) : Number.NEGATIVE_INFINITY;
}

/**
 * Half-life implied by the decay: the days until a single exposure's strength halves against day one.
 * Exposed for the diagnostics; it is what grows with the rating.
 */
export function halfLifeDays(affinity: number): number {
  return 2 ** (1 / decayRate(affinity));
}

/**
 * Peaks in the middle of the zone. The zone is the activation of one exposure aged 7 to 30 days, so
 * a track heard many times stays active for longer and returns later, as the ACT-R curve predicts.
 * Too-recent tracks earn nothing: this regime starts where satiation has already ended.
 */
export function nostalgiaBonus(timestamps: readonly number[], now: number, affinity: number): number {
  if (affinity < MIN_AFFINITY || timestamps.length === 0) return 0;

  const latest = timestamps.reduce((max, value) => Math.max(max, value), 0);
  if (now - latest < REACTIVATION_START_MS) return 0;

  const decay = decayRate(affinity);
  const upper = -decay * Math.log(ZONE_YOUNGEST_DAYS);
  const lower = -decay * Math.log(ZONE_OLDEST_DAYS);
  const activation = baseLevelActivation(timestamps, now, affinity) - FREQUENCY_DISCOUNT * Math.log(timestamps.length);

  if (activation > upper || activation < lower) return 0;

  const position = (activation - lower) / (upper - lower);
  const peak = 1 - Math.abs(2 * position - 1);
  return NOSTALGIA_MIN_POINTS + (NOSTALGIA_MAX_POINTS - NOSTALGIA_MIN_POINTS) * peak;
}
