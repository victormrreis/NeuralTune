const TAU = 2 * Math.PI;
const MAX_KAPPA = 20;

export function hourAngle(date: Date): number {
  return (TAU * (date.getHours() + date.getMinutes() / 60)) / 24;
}

export function dayAngle(date: Date): number {
  return (TAU * date.getDay()) / 7;
}

/** Modified Bessel function I₀, by its power series. */
export function besselI0(x: number): number {
  let term = 1;
  let sum = 1;
  for (let k = 1; k < 200; k++) {
    term *= (x / (2 * k)) ** 2;
    sum += term;
    if (term < 1e-15 * sum) break;
  }
  return sum;
}

export function vonMisesDensity(theta: number, mu: number, kappa: number): number {
  return Math.exp(kappa * Math.cos(theta - mu)) / (TAU * besselI0(kappa));
}

export interface VonMises {
  mu: number;
  kappa: number;
  n: number;
}
export const VonMises = {};

/** Maximum likelihood, with Banerjee's κ approximation shrunk towards uniform for small samples. */
export function fitVonMises(angles: readonly number[], priorStrength: number = 5): VonMises {
  const n = angles.length;
  if (n === 0) return { mu: 0, kappa: 0, n: 0 };

  let x = 0;
  let y = 0;
  for (const angle of angles) {
    x += Math.cos(angle);
    y += Math.sin(angle);
  }

  const resultant = Math.hypot(x, y) / (n + priorStrength);
  const kappa = Math.min(MAX_KAPPA, (resultant * (2 - resultant * resultant)) / Math.max(1e-9, 1 - resultant * resultant));
  return { mu: Math.atan2(y, x), kappa, n };
}

/** P(k | hour, day) ∝ π_k p(θ_h | k) p(θ_d | k), with hour and day taken as independent. */
export class CircadianClusterPrior {
  private clusters = new Map<number, { hour: VonMises; day: VonMises; n: number }>();
  private total = 0;

  fit(observations: ReadonlyArray<{ cluster: number; timestamp: number }>): void {
    const grouped = new Map<number, Date[]>();
    for (const { cluster, timestamp } of observations) {
      const list = grouped.get(cluster);
      if (list) list.push(new Date(timestamp));
      else grouped.set(cluster, [new Date(timestamp)]);
    }

    this.clusters.clear();
    this.total = observations.length;
    for (const [cluster, dates] of grouped) {
      this.clusters.set(cluster, {
        hour: fitVonMises(dates.map(hourAngle)),
        day: fitVonMises(dates.map(dayAngle)),
        n: dates.length
      });
    }
  }

  /** With few data κ tends to 0 and this returns the plain cluster shares: the fallback is built in. */
  posterior(date: Date): Map<number, number> {
    const [theta, delta] = [hourAngle(date), dayAngle(date)];
    const weights = new Map<number, number>();
    let sum = 0;

    for (const [cluster, { hour, day, n }] of this.clusters) {
      const weight = ((n + 1) / (this.total + this.clusters.size))
        * vonMisesDensity(theta, hour.mu, hour.kappa)
        * vonMisesDensity(delta, day.mu, day.kappa);
      weights.set(cluster, weight);
      sum += weight;
    }

    for (const [cluster, weight] of weights) weights.set(cluster, sum > 0 ? weight / sum : 0);
    return weights;
  }
}

export interface CusumConfig {
  drift: number;
  threshold: number;
  minEvents: number;
  cooldownEvents: number;
}
export const CusumConfig = {};

const DEFAULT_CUSUM: CusumConfig = { drift: 0.15, threshold: 2.5, minEvents: 4, cooldownEvents: 6 };

/**
 * One-sided CUSUM: S_t = max(0, S_{t-1} + r̂_t - r_t - δ). It fires when outcomes stay below what the
 * model expected. A pivot means the recent pattern of interaction changed; it is no statement about how
 * the person feels. Two skips alone cannot reach the threshold with these defaults.
 */
export class SessionChangeDetector {
  private config: CusumConfig;
  private sum = 0;
  private events = 0;
  private cooldown = 0;

  constructor(config: Partial<CusumConfig> = {}) {
    this.config = { ...DEFAULT_CUSUM, ...config };
  }

  getStatistic(): number {
    return this.sum;
  }

  reset(): void {
    this.sum = 0;
    this.events = 0;
    this.cooldown = 0;
  }

  /** Returns true when a Context Pivot should happen. */
  update(expected: number, observed: number): boolean {
    this.events++;
    this.sum = Math.max(0, this.sum + expected - observed - this.config.drift);

    if (this.cooldown > 0) {
      this.cooldown--;
      return false;
    }
    if (this.events < this.config.minEvents || this.sum < this.config.threshold) return false;

    this.sum = 0;
    this.cooldown = this.config.cooldownEvents;
    return true;
  }
}

/** Mixes down the previous cluster gradually, which is what keeps a pivot from being a flip. */
export class SessionState {
  private weights = new Map<number, number>();
  private decay: number;

  constructor(decay: number = 0.5) {
    this.decay = decay;
  }

  reinforce(cluster: number, amount: number = 1): void {
    this.weights.set(cluster, (this.weights.get(cluster) ?? 0) + amount);
  }

  pivot(away: number): void {
    const current = this.weights.get(away);
    if (current !== undefined) this.weights.set(away, current * this.decay);
  }

  distribution(): Map<number, number> {
    const total = Array.from(this.weights.values()).reduce((sum, w) => sum + w, 0);
    return new Map(Array.from(this.weights, ([cluster, weight]) => [cluster, total > 0 ? weight / total : 0]));
  }

  active(): number | null {
    let best: number | null = null;
    let weight = 0;
    for (const [cluster, value] of this.weights) {
      if (value > weight) {
        weight = value;
        best = cluster;
      }
    }
    return best;
  }
}
