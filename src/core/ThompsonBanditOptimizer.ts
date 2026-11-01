export type RandomSource = () => number;
export const RandomSource = {};

export interface ThompsonSample {
  context: readonly number[];
  known: readonly boolean[];
  reward: number;
}
export const ThompsonSample = {};

export interface NormalGammaPosterior {
  mu: number;
  lambda: number;
  alpha: number;
  beta: number;
}
export const NormalGammaPosterior = {};

export interface BoltzmannResult {
  probabilities: number[];
  entropyBits: number;
  meanEnergy: number;
  freeEnergy: number;
}
export const BoltzmannResult = {};

export interface TemperatureContext {
  radio?: string;
  date?: Date;
}
export const TemperatureContext = {};

export const TEMPERATURE_FOCUS = 0.1;
export const TEMPERATURE_DEFAULT = 0.3;
export const TEMPERATURE_DISCOVERY = 0.8;

const FOCUS_RADIOS = new Set(['work', 'study']);

const PRIOR: NormalGammaPosterior = { mu: 0, lambda: 1, alpha: 2, beta: 1 };

/** A single seeded generator, so a test can pin every stochastic decision. */
export function seededRandom(seed: number): RandomSource {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function sampleStandardNormal(random: RandomSource): number {
  const u = 1 - random();
  const v = random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** Marsaglia & Tsang (2000). Gamma(shape, rate). */
export function sampleGamma(shape: number, rate: number, random: RandomSource): number {
  if (shape < 1) {
    return sampleGamma(shape + 1, rate, random) * Math.pow(1 - random(), 1 / shape);
  }

  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);

  for (;;) {
    const x = sampleStandardNormal(random);
    const v = (1 + c * x) ** 3;
    if (v <= 0) continue;

    const u = 1 - random();
    if (Math.log(u) < 0.5 * x * x + d - d * v + d * Math.log(v)) return (d * v) / rate;
  }
}

/** Conjugate update of N(μ | μ₀, (λτ)⁻¹) Gamma(τ | α, β) with n observations. */
export function posteriorFrom(values: readonly number[], prior: NormalGammaPosterior = PRIOR): NormalGammaPosterior {
  const n = values.length;
  if (n === 0) return { ...prior };

  const mean = values.reduce((sum, value) => sum + value, 0) / n;
  const scatter = values.reduce((sum, value) => sum + (value - mean) ** 2, 0);
  const lambda = prior.lambda + n;

  return {
    mu: (prior.lambda * prior.mu + n * mean) / lambda,
    lambda,
    alpha: prior.alpha + n / 2,
    beta: prior.beta + 0.5 * scatter + (prior.lambda * n * (mean - prior.mu) ** 2) / (2 * lambda)
  };
}

export function shannonEntropyBits(probabilities: readonly number[]): number {
  let entropy = 0;
  for (const p of probabilities) {
    if (p > 0) entropy -= p * Math.log2(p);
  }
  return entropy;
}

/**
 * The distribution minimizing F = Ū - T·H(p), with U_i = -utility_i. Since H is in bits, stationarity
 * gives p_i ∝ exp(-U_i · ln 2 / T): the ln 2 converts the temperature from bits to nats.
 */
export function boltzmannDistribution(utilities: readonly number[], temperature: number): BoltzmannResult {
  if (utilities.length === 0) {
    return { probabilities: [], entropyBits: 0, meanEnergy: 0, freeEnergy: 0 };
  }

  const beta = Math.LN2 / Math.max(temperature, 1e-6);
  const usable = utilities.filter(Number.isFinite);
  if (usable.length === 0) {
    return { probabilities: utilities.map(() => 1 / utilities.length), entropyBits: Math.log2(utilities.length), meanEnergy: 0, freeEnergy: 0 };
  }

  // One corrupt utility has zero mass instead of turning the whole distribution into NaN
  const peak = Math.max(...usable);
  const weights = utilities.map((utility) => (Number.isFinite(utility) ? Math.exp(beta * (utility - peak)) : 0)); // Avoids underflow
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  const probabilities = weights.map((weight) => weight / total);

  const meanEnergy = probabilities.reduce((sum, p, i) => (p > 0 ? sum - p * utilities[i] : sum), 0);
  const entropyBits = shannonEntropyBits(probabilities);

  return { probabilities, entropyBits, meanEnergy, freeEnergy: meanEnergy - temperature * entropyBits };
}

export function freeEnergyOf(probabilities: readonly number[], utilities: readonly number[], temperature: number): number {
  const meanEnergy = probabilities.reduce((sum, p, i) => sum - p * utilities[i], 0);
  return meanEnergy - temperature * shannonEntropyBits(probabilities);
}

/** Explicit context wins; otherwise the weekend relaxes the exploration budget. */
export function resolveTemperature({ radio, date = new Date() }: TemperatureContext): number {
  if (radio && FOCUS_RADIOS.has(radio)) return TEMPERATURE_FOCUS;
  if (radio === 'discovery') return TEMPERATURE_DISCOVERY;

  const day = date.getDay();
  return day === 0 || day === 6 ? TEMPERATURE_DISCOVERY : TEMPERATURE_DEFAULT;
}

/** Gumbel-top-k: k draws without replacement from p, in O(n log n). */
export function sampleWithoutReplacement(
  probabilities: readonly number[],
  count: number,
  random: RandomSource
): number[] {
  return probabilities
    .map((p, index) => ({ index, key: p > 0 ? Math.log(p) - Math.log(-Math.log(1 - random())) : -Infinity }))
    .sort((a, b) => b.key - a.key)
    .slice(0, count)
    .map((entry) => entry.index);
}

export class ThompsonBanditOptimizer {
  private random: RandomSource;
  private posteriors: NormalGammaPosterior[];
  private dimension: number;

  constructor(dimension: number = 8, random: RandomSource = Math.random) {
    this.dimension = dimension;
    this.random = random;
    this.posteriors = Array.from({ length: dimension }, () => ({ ...PRIOR }));
  }

  /**
   * One Normal-Gamma per dimension over x_k = r · z_k: positive when listening rewards that side of
   * dimension k. Dimensions are treated as independent, so correlated tastes are not captured here.
   */
  fit(samples: readonly ThompsonSample[]): void {
    this.posteriors = Array.from({ length: this.dimension }, (_, k) => {
      const observations = samples.filter((s) => s.known[k]).map((s) => s.reward * s.context[k]);
      return posteriorFrom(observations);
    });
  }

  getPosteriors(): NormalGammaPosterior[] {
    return this.posteriors.map((p) => ({ ...p }));
  }

  /** θ* ~ P(θ | D): τ_k ~ Gamma(α, β), then μ_k ~ N(μ, (λτ_k)⁻¹). */
  sampleTheta(): number[] {
    return this.posteriors.map(({ mu, lambda, alpha, beta }) => {
      const precision = sampleGamma(alpha, beta, this.random);
      return mu + sampleStandardNormal(this.random) / Math.sqrt(lambda * precision);
    });
  }
}
