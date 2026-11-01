import { AudioAnalysisPayload } from './AudioAnalysisSynthesizer.ts';
import { estimateKey } from '../dsp/LocalAudioDSPEngine.ts';
import { CamelotKey, toCamelot } from '../math/Camelot.ts';

const INTRO_SECONDS = 15;
const CORE_SECONDS = 30;
const OUTRO_SECONDS = 15;
const FADE_FLOOR_DB = -30;
const TIMELINE_BIN_S = 5;
const MAX_TRACK_SECONDS = 86_400;

export interface SectionVector {
  loudness: number;      // Mean of loudness_max, in dB: a level, not power or intensity of feeling
  brightness: number;    // Echo Nest timbre coefficient 1
  density: number;       // Segments per second
  camelot?: CamelotKey;
}
export const SectionVector = {};

export interface TrackMorphology {
  intro: SectionVector;
  core: SectionVector;
  outro: SectionVector;
  bpm?: number;
  timeline: number[];    // Mean level per 5 s bin
}
export const TrackMorphology = {};

export interface SeamWeights {
  loudness: number;
  brightness: number;
  density: number;
  key: number;
  tempo: number;
}
export const SeamWeights = {};

/** Scales chosen so one typical unit of each term is comparable. They are not fitted to perception. */
export const DEFAULT_SEAM_WEIGHTS: SeamWeights = { loudness: 1 / 36, brightness: 1 / 900, density: 1 / 4, key: 0.5, tempo: 4 };

type Segment = NonNullable<AudioAnalysisPayload['segments']>[number];

function summarize(segments: readonly Segment[], seconds: number): SectionVector {
  const usable = segments.filter((s) => s.pitches?.length === 12);
  if (usable.length === 0) return { loudness: FADE_FLOOR_DB, brightness: 0, density: 0 };

  const chroma = new Array<number>(12).fill(0);
  let loudness = 0;
  let brightness = 0;
  let duration = 0;

  for (const segment of usable) {
    const weight = segment.duration ?? 0;
    duration += weight;
    loudness += weight * (segment.loudness_max ?? FADE_FLOOR_DB);
    brightness += weight * (segment.timbre?.[1] ?? 0);
    segment.pitches!.forEach((value, i) => { chroma[i] += weight * value; });
  }

  const key = estimateKey(chroma);
  return {
    loudness: duration > 0 ? loudness / duration : FADE_FLOOR_DB,
    brightness: duration > 0 ? brightness / duration : 0,
    density: seconds > 0 ? usable.length / seconds : 0,
    camelot: key ? toCamelot(key.pitchClass, key.mode) : undefined
  };
}

/**
 * Splits a track around its audible region. "Core" is the 30 s window of highest activity, defined as
 * mean level plus onset density. Null without segments: this cannot be derived from summary features.
 */
export function extractMorphology(payload: AudioAnalysisPayload): TrackMorphology | null {
  const segments = (payload.segments ?? []).filter((s) => Number.isFinite(s.start));
  if (segments.length < 20) return null;

  // The timeline is allocated from this value, so a corrupt last segment cannot be allowed to size it
  const lastDuration = segments[segments.length - 1].duration ?? 0;
  const end = Math.min(MAX_TRACK_SECONDS, segments[segments.length - 1].start! + (Number.isFinite(lastDuration) ? lastDuration : 0));
  const audible = segments.filter((s) => (s.loudness_max ?? FADE_FLOOR_DB) > FADE_FLOOR_DB);
  const first = audible[0]?.start ?? 0;
  const last = audible.length > 0 ? audible[audible.length - 1].start! : end;

  const within = (from: number, to: number) => segments.filter((s) => s.start! >= from && s.start! < to);

  let coreStart = first;
  let bestActivity = Number.NEGATIVE_INFINITY;
  for (let start = first; start + CORE_SECONDS <= last; start += 5) {
    const window = within(start, start + CORE_SECONDS);
    if (window.length === 0) continue;
    const level = window.reduce((sum, s) => sum + (s.loudness_max ?? FADE_FLOOR_DB), 0) / window.length;
    const activity = level + window.length / CORE_SECONDS;
    if (activity > bestActivity) {
      bestActivity = activity;
      coreStart = start;
    }
  }

  const bins = Math.max(1, Math.ceil(end / TIMELINE_BIN_S));
  const sums = new Array<number>(bins).fill(0);
  const counts = new Array<number>(bins).fill(0);
  for (const segment of segments) {
    const bin = Math.min(bins - 1, Math.floor(segment.start! / TIMELINE_BIN_S));
    sums[bin] += segment.loudness_max ?? FADE_FLOOR_DB;
    counts[bin]++;
  }

  return {
    intro: summarize(within(first, first + INTRO_SECONDS), INTRO_SECONDS),
    core: summarize(within(coreStart, coreStart + CORE_SECONDS), CORE_SECONDS),
    outro: summarize(within(last - OUTRO_SECONDS, last + 1), OUTRO_SECONDS),
    bpm: payload.track?.tempo,
    timeline: sums.map((sum, i) => (counts[i] > 0 ? Math.round((sum / counts[i]) * 10) / 10 : FADE_FLOOR_DB))
  };
}

/** Steps around the wheel, plus 1 for changing ring: 0 is the same key, 7 the opposite. */
export function camelotDistance(a: CamelotKey, b: CamelotKey): number {
  const delta = Math.abs(a.number - b.number);
  return Math.min(delta, 12 - delta) + (a.letter === b.letter ? 0 : 1);
}

/**
 * SeamCost(i, j) = ‖v_outro(i) - v_intro(j)‖²_W + γ CamelotDist(i, j), plus a tempo term. A low value
 * means the measured features are close at the seam. It does not mean the transition sounds seamless:
 * Spotify's crossfade is outside this extension's control.
 */
export function seamCost(from: TrackMorphology, to: TrackMorphology, weights: SeamWeights = DEFAULT_SEAM_WEIGHTS): number {
  const [a, b] = [from.outro, to.intro];

  let cost = weights.loudness * (a.loudness - b.loudness) ** 2
    + weights.brightness * (a.brightness - b.brightness) ** 2
    + weights.density * (a.density - b.density) ** 2;

  if (a.camelot && b.camelot) cost += weights.key * camelotDistance(a.camelot, b.camelot);
  if (from.bpm && to.bpm) {
    const ratio = Math.abs(Math.log2(from.bpm / to.bpm));
    cost += weights.tempo * Math.abs(ratio - Math.round(ratio));
  }
  return cost;
}

export interface SkipAssociation {
  n: number;
  meanDifference: number;
  low: number;
  high: number;
  supported: boolean;
}
export const SkipAssociation = {};

const MIN_SKIPS = 12;

/**
 * Compares the level of [t_s - 10, t_s] with the rest of the same track, across skips, with a 95%
 * interval on the mean paired difference. It reports an association over many events and never a cause
 * for one: a person skips for reasons no audio feature sees, such as a phone call.
 */
export function skipLevelAssociation(
  skips: ReadonlyArray<{ timeline: readonly number[]; skippedAtMs: number }>
): SkipAssociation {
  const differences: number[] = [];

  for (const { timeline, skippedAtMs } of skips) {
    const bin = Math.floor(skippedAtMs / 1000 / TIMELINE_BIN_S);
    if (bin < 2 || bin >= timeline.length) continue;

    const local = (timeline[bin] + timeline[bin - 1]) / 2;
    const rest = timeline.filter((_, i) => i !== bin && i !== bin - 1);
    differences.push(local - rest.reduce((sum, value) => sum + value, 0) / rest.length);
  }

  const n = differences.length;
  if (n < MIN_SKIPS) return { n, meanDifference: 0, low: 0, high: 0, supported: false };

  const mean = differences.reduce((sum, d) => sum + d, 0) / n;
  const variance = differences.reduce((sum, d) => sum + (d - mean) ** 2, 0) / (n - 1);
  const margin = 1.96 * Math.sqrt(variance / n);

  return { n, meanDifference: mean, low: mean - margin, high: mean + margin, supported: true };
}
