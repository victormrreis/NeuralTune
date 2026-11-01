import { AudioAnalysisPayload } from '../core/AudioAnalysisSynthesizer.ts';

const PATTERN_BINS = 16;
const BEATS_PER_BAR = 4;
const MAX_BEAT_SECONDS = 60;
const MAX_ONSET_WEIGHT = 120;

export interface RhythmProfile {
  bpm: number;
  regularity: number;    // 1 - clamped coefficient of variation of the inter-beat intervals
  pattern: number[];     // Onset energy by position in the bar, unit sum
  syncopation: number;   // Share of onset energy away from the beat grid
  tempoStability: number;
}
export const RhythmProfile = {};

function circularDelta(a: number, b: number, period: number): number {
  const d = Math.abs(a - b) % period;
  return Math.min(d, period - d);
}

/** Null without enough beats: a rhythm pattern cannot be read from a tempo number alone. */
export function rhythmProfile(payload: AudioAnalysisPayload): RhythmProfile | null {
  const beats = (payload.beats ?? []).filter((b) => Number.isFinite(b.start) && b.duration! > 0 && b.duration! < MAX_BEAT_SECONDS);
  if (beats.length < 16) return null;

  const durations = beats.map((b) => b.duration!);
  const mean = durations.reduce((sum, d) => sum + d, 0) / durations.length;
  const variance = durations.reduce((sum, d) => sum + (d - mean) ** 2, 0) / durations.length;
  const regularity = 1 - Math.min(1, Math.sqrt(variance) / mean);

  const pattern = new Array<number>(PATTERN_BINS).fill(0);
  let offBeat = 0;
  let total = 0;
  let cursor = 0;

  for (const segment of payload.segments ?? []) {
    const start = segment.start;
    if (typeof start !== 'number') continue;

    while (cursor + 1 < beats.length && beats[cursor + 1].start! <= start) cursor++;
    const beat = beats[cursor];
    const phase = (start - beat.start!) / beat.duration!;
    if (phase < 0 || phase > 1.5) continue;

    const loudness = segment.loudness_max ?? -60;
    const weight = Number.isFinite(loudness) ? Math.min(MAX_ONSET_WEIGHT, Math.max(0, 60 + loudness)) : 0;
    const barPosition = ((cursor % BEATS_PER_BAR) + Math.min(phase, 0.999)) / BEATS_PER_BAR;
    pattern[Math.floor(barPosition * PATTERN_BINS) % PATTERN_BINS] += weight;

    total += weight;
    if (circularDelta(phase, 0, 1) > 0.125) offBeat += weight;
  }

  // First half against second half: a stable pulse keeps the same local tempo through the track
  const half = durations.length >> 1;
  const early = durations.slice(0, half).reduce((sum, d) => sum + d, 0) / half;
  const late = durations.slice(half).reduce((sum, d) => sum + d, 0) / (durations.length - half);

  return {
    bpm: 60 / mean,
    regularity,
    pattern: total > 0 ? pattern.map((value) => value / total) : pattern,
    syncopation: total > 0 ? offBeat / total : 0,
    tempoStability: 1 - Math.min(1, Math.abs(early - late) / mean)
  };
}

/** Baseline: closeness of tempo, with 2:1 counted as the same pulse. */
export function tempoSimilarity(a: number, b: number): number {
  const ratio = Math.abs(Math.log2(a / b));
  return Math.exp(-4 * Math.abs(ratio - Math.round(ratio)));
}

/** Baseline: cosine between bar-position histograms, the best of the 16 rotations. */
export function patternSimilarity(a: readonly number[], b: readonly number[]): number {
  const norm = Math.sqrt(a.reduce((s, x) => s + x * x, 0) * b.reduce((s, x) => s + x * x, 0));
  if (norm === 0) return 0;

  let best = 0;
  for (let shift = 0; shift < a.length; shift += a.length / BEATS_PER_BAR) {
    let dot = 0;
    for (let i = 0; i < a.length; i++) dot += a[i] * b[(i + shift) % b.length];
    best = Math.max(best, dot / norm);
  }
  return best;
}

export function rhythmicCompatibility(a: RhythmProfile, b: RhythmProfile): number {
  return 0.5 * tempoSimilarity(a.bpm, b.bpm) + 0.5 * patternSimilarity(a.pattern, b.pattern);
}

/** r e^{iψ} = (1/N) Σ e^{iθ_j} */
export function orderParameter(phases: readonly number[]): number {
  let x = 0;
  let y = 0;
  for (const phase of phases) {
    x += Math.cos(phase);
    y += Math.sin(phase);
  }
  return Math.hypot(x, y) / phases.length;
}

export interface KuramotoOptions {
  coupling: number;
  duration: number;
  step: number;
}
export const KuramotoOptions = {};

/**
 * dθ_i/dt = ω_i + (K/N) Σ_j sin(θ_j - θ_i), Euler integration from fixed phases. Returns the mean order
 * parameter over the second half of the run. Kept as an experiment: for two oscillators the system
 * reduces to φ' = Δω - K sin φ, so the result depends on the tempo difference alone (see the docs).
 */
export function kuramotoSynchrony(frequencies: readonly number[], options: Partial<KuramotoOptions> = {}): number {
  const { coupling = 1, duration = 30, step = 0.01 } = options;
  const size = frequencies.length;
  const phases = frequencies.map((_, i) => (2 * Math.PI * i) / size);
  const steps = Math.floor(duration / step);

  let accumulated = 0;
  let samples = 0;

  for (let t = 0; t < steps; t++) {
    const velocity = phases.map((theta, i) => {
      let sum = 0;
      for (const other of phases) sum += Math.sin(other - theta);
      return frequencies[i] + (coupling / size) * sum;
    });
    for (let i = 0; i < size; i++) phases[i] += step * velocity[i];

    if (t >= steps / 2) {
      accumulated += orderParameter(phases);
      samples++;
    }
  }
  return accumulated / samples;
}
