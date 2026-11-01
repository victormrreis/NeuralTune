import { AudioAnalysisPayload } from '../core/AudioAnalysisSynthesizer.ts';

/** w(t) = w∞ + (w₀ - w∞) · 2^(-t / t½), the decay kernel of PPM-Decay (Harrison et al., 2020). */
export interface DecayKernel {
  initialWeight: number;
  asymptote: number;
  halfLife: number;
}
export const DecayKernel = {};

export const NO_DECAY: DecayKernel = { initialWeight: 1, asymptote: 1, halfLife: Number.POSITIVE_INFINITY };

const DEFAULT_KERNEL: DecayKernel = { initialWeight: 1, asymptote: 0.2, halfLife: 60 };
const MAX_ORDER = 2;

export function kernelWeight(kernel: DecayKernel, age: number): number {
  if (!Number.isFinite(kernel.halfLife)) return kernel.initialWeight;
  return kernel.asymptote + (kernel.initialWeight - kernel.asymptote) * 2 ** (-Math.max(0, age) / kernel.halfLife);
}

/**
 * Variable-order Markov model with memory decay. Follows PPM method A, the escape the paper keeps: at
 * each order from the longest matching context down, P = c(s|ctx)/(n+1), and the escape 1/(n+1) passes
 * the remaining mass to the shorter context, ending on the uniform distribution. Counts are stored as
 * observation times, so the decay is exact at the cost of O(observations) per context.
 */
export class DecayedPpm {
  private alphabet: number;
  private order: number;
  private kernel: DecayKernel;
  private history: number[] = [];
  private tables: Array<Map<string, Map<number, number[]>>>;

  constructor(alphabet: number, order: number = MAX_ORDER, kernel: DecayKernel = DEFAULT_KERNEL) {
    this.alphabet = alphabet;
    this.order = order;
    this.kernel = kernel;
    this.tables = Array.from({ length: order + 1 }, () => new Map());
  }

  private contextKey(length: number): string | null {
    if (this.history.length < length) return null;
    return this.history.slice(this.history.length - length).join(',');
  }

  predict(now: number): Float64Array {
    const distribution = new Float64Array(this.alphabet);
    let escape = 1;

    for (let length = Math.min(this.order, this.history.length); length >= 0; length--) {
      const key = this.contextKey(length);
      const counts = key === null ? undefined : this.tables[length].get(key);
      if (!counts) continue;

      let total = 0;
      const weights = new Map<number, number>();
      for (const [symbol, times] of counts) {
        let weight = 0;
        for (const time of times) weight += kernelWeight(this.kernel, now - time);
        weights.set(symbol, weight);
        total += weight;
      }

      const denominator = total + 1;
      for (const [symbol, weight] of weights) distribution[symbol] += (escape * weight) / denominator;
      escape /= denominator;
    }

    for (let i = 0; i < this.alphabet; i++) distribution[i] += escape / this.alphabet;
    return distribution;
  }

  observe(symbol: number, now: number): void {
    for (let length = 0; length <= Math.min(this.order, this.history.length); length++) {
      const key = this.contextKey(length)!;
      let counts = this.tables[length].get(key);
      if (!counts) {
        counts = new Map();
        this.tables[length].set(key, counts);
      }
      const times = counts.get(symbol);
      if (times) times.push(now);
      else counts.set(symbol, [now]);
    }
    this.history.push(symbol);
    if (this.history.length > this.order) this.history.shift();
  }
}

export function entropyBits(distribution: ArrayLike<number>): number {
  let entropy = 0;
  for (let i = 0; i < distribution.length; i++) {
    const p = distribution[i];
    if (p > 0) entropy -= p * Math.log2(p);
  }
  return entropy;
}

export interface SequenceInformation {
  surprise: number;    // Mean -log₂ P(x_t | context), in bits
  uncertainty: number; // Mean H(X_t | context), in bits
  normalizedSurprise: number;
  normalizedUncertainty: number;
  events: number;
}
export const SequenceInformation = {};

/** Online: each event is scored before it is learned, so no event predicts itself. */
export function analyzeSequence(
  symbols: readonly number[],
  alphabet: number,
  times?: readonly number[],
  kernel: DecayKernel = DEFAULT_KERNEL
): SequenceInformation {
  const model = new DecayedPpm(alphabet, MAX_ORDER, kernel);
  let surprise = 0;
  let uncertainty = 0;

  for (let t = 0; t < symbols.length; t++) {
    const now = times?.[t] ?? t;
    const distribution = model.predict(now);
    surprise += -Math.log2(Math.max(distribution[symbols[t]], 1e-12));
    uncertainty += entropyBits(distribution);
    model.observe(symbols[t], now);
  }

  const events = symbols.length;
  const capacity = Math.log2(alphabet);
  const meanSurprise = events > 0 ? surprise / events : 0;
  const meanUncertainty = events > 0 ? uncertainty / events : 0;

  return {
    surprise: meanSurprise,
    uncertainty: meanUncertainty,
    normalizedSurprise: Math.min(1, meanSurprise / capacity),
    normalizedUncertainty: Math.min(1, meanUncertainty / capacity),
    events
  };
}

export interface PredictiveProfile {
  harmonic: SequenceInformation | null;
  rhythmic: SequenceInformation | null;
  timbral: SequenceInformation | null;
  /** Always null: chroma is polyphonic energy, not a note sequence, so a melody cannot be read from it. */
  melodic: null;
}
export const PredictiveProfile = {};

const IOI_BINS = 7;
const TIMBRE_BINS = 6;

/** Strongest pitch class of each segment, with repeats merged: the sequence of harmonic centers. */
export function harmonicEvents(payload: AudioAnalysisPayload): { symbols: number[]; times: number[] } {
  const symbols: number[] = [];
  const times: number[] = [];

  for (const segment of payload.segments ?? []) {
    const { pitches, start = 0 } = segment;
    if (!pitches || pitches.length !== 12) continue;

    let strongest = 0;
    for (let i = 1; i < 12; i++) if (pitches[i] > pitches[strongest]) strongest = i;

    if (symbols[symbols.length - 1] !== strongest) {
      symbols.push(strongest);
      times.push(start);
    }
  }
  return { symbols, times };
}

/** Log-ratio of consecutive inter-onset intervals: tempo-invariant, as a rhythm should be. */
export function rhythmicEvents(payload: AudioAnalysisPayload): { symbols: number[]; times: number[] } {
  const segments = (payload.segments ?? []).filter((s) => (s.duration ?? 0) > 0);
  const symbols: number[] = [];
  const times: number[] = [];

  for (let i = 1; i < segments.length; i++) {
    const ratio = Math.log2(segments[i].duration! / segments[i - 1].duration!);
    symbols.push(Math.max(0, Math.min(IOI_BINS - 1, Math.round(ratio) + (IOI_BINS >> 1))));
    times.push(segments[i].start ?? i);
  }
  return { symbols, times };
}

/** Quantized brightness, a coarse stand-in for timbral change. */
export function timbralEvents(payload: AudioAnalysisPayload): { symbols: number[]; times: number[] } {
  const values = (payload.segments ?? []).filter((s) => s.timbre && s.timbre.length > 1);
  if (values.length === 0) return { symbols: [], times: [] };

  const brightness = values.map((s) => s.timbre![1]);
  const sorted = [...brightness].sort((a, b) => a - b);
  const edges = Array.from({ length: TIMBRE_BINS - 1 }, (_, i) => sorted[Math.floor(((i + 1) * sorted.length) / TIMBRE_BINS)]);

  return {
    symbols: brightness.map((value) => {
      let bin = 0;
      while (bin < edges.length && value > edges[bin]) bin++;
      return bin;
    }),
    times: values.map((s, i) => s.start ?? i)
  };
}

const MIN_EVENTS = 16;

export function predictiveProfile(payload: AudioAnalysisPayload): PredictiveProfile {
  const run = (events: { symbols: number[]; times: number[] }, alphabet: number) => {
    return events.symbols.length >= MIN_EVENTS ? analyzeSequence(events.symbols, alphabet, events.times) : null;
  };

  return {
    harmonic: run(harmonicEvents(payload), 12),
    rhythmic: run(rhythmicEvents(payload), IOI_BINS),
    timbral: run(timbralEvents(payload), TIMBRE_BINS),
    melodic: null
  };
}

export interface TasteForInformation {
  n: number;
  coefficients: number[]; // S, H, S×H, S², H²
  featureMeans: number[];
  supported: boolean;
}
export const TasteForInformation = {};

function informationFeatures(x: number, y: number): number[] {
  return [x, y, x * y, x * x, y * y];
}

/**
 * Ridge regression of rating on S, H, their interaction and squares, all centered. Cheung et al. (2019)
 * and Gold et al. (2019) found those terms in experiments on chords and melodies; that is a population
 * result, so the sign of each coefficient is learned from this user and never assumed. With too few rated
 * tracks it reports `supported: false` and contributes nothing.
 */
export function fitTasteForInformation(samples: ReadonlyArray<{ surprise: number; uncertainty: number; reward: number }>): TasteForInformation {
  const n = samples.length;
  const size = 5;
  if (n < 30) return { n, coefficients: new Array<number>(size).fill(0), featureMeans: new Array<number>(size).fill(0), supported: false };

  const meanS = samples.reduce((sum, s) => sum + s.surprise, 0) / n;
  const meanH = samples.reduce((sum, s) => sum + s.uncertainty, 0) / n;
  const meanR = samples.reduce((sum, s) => sum + s.reward, 0) / n;

  // Squares of centered values are not centered themselves, and with no intercept that biases their slope
  const rows = samples.map((sample) => informationFeatures(sample.surprise - meanS, sample.uncertainty - meanH));
  const featureMeans = new Array<number>(size).fill(0);
  for (const row of rows) row.forEach((value, i) => { featureMeans[i] += value / n; });

  const a = Array.from({ length: size }, (_, i) => Array.from({ length: size }, (_, j) => (i === j ? 1e-2 : 0)));
  const b = new Array<number>(size).fill(0);

  for (let s = 0; s < n; s++) {
    const features = rows[s].map((value, i) => value - featureMeans[i]);
    const target = samples[s].reward - meanR;
    for (let i = 0; i < size; i++) {
      b[i] += features[i] * target;
      for (let j = 0; j < size; j++) a[i][j] += features[i] * features[j];
    }
  }

  for (let i = 0; i < size; i++) {
    for (let j = i + 1; j < size; j++) {
      const factor = a[j][i] / a[i][i];
      for (let k = i; k < size; k++) a[j][k] -= factor * a[i][k];
      b[j] -= factor * b[i];
    }
  }

  const coefficients = new Array<number>(size).fill(0);
  for (let i = size - 1; i >= 0; i--) {
    let value = b[i];
    for (let k = i + 1; k < size; k++) value -= a[i][k] * coefficients[k];
    coefficients[i] = value / a[i][i];
  }

  return { n, coefficients, featureMeans, supported: true };
}

export function predictFromInformation(taste: TasteForInformation, x: number, y: number): number {
  return informationFeatures(x, y).reduce((sum, value, i) => sum + (value - taste.featureMeans[i]) * taste.coefficients[i], 0);
}
