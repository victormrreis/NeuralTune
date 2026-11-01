import { CHROMA_SIZE, estimateKey } from '../dsp/LocalAudioDSPEngine.ts';
import { formatCamelot, toCamelot } from '../math/Camelot.ts';
import { AcousticFeatures } from '../types/index.ts';

export const SYNTHESIZED_SOURCE = 'Spotify Audio Analysis (Synthesized)';

// Raises when a coefficient changes, so records from an older synthesis are computed again
export const SYNTHESIS_VERSION = 3;

const TIMBRE_SIZE = 12;
const SUSTAINED_SEGMENT_S = 0.25;
const SYLLABLE_SEGMENT_S = 0.15;
const IBI_REGULARITY_GAMMA = 8;
const MIN_BEATS = 8;

// Far above any real analysis value, whose largest are timbre coefficients in the hundreds
const MAX_PLAUSIBLE = 1e4;

export interface AnalysisQuantum {
  start?: number;
  duration?: number;
  confidence?: number;
}
export const AnalysisQuantum = {};

export interface AnalysisSegment extends AnalysisQuantum {
  loudness_start?: number;
  loudness_max?: number;
  pitches?: number[];
  timbre?: number[];
}
export const AnalysisSegment = {};

export interface AudioAnalysisPayload {
  track?: {
    duration?: number;
    tempo?: number;
    tempo_confidence?: number;
    key?: number;
    key_confidence?: number;
    mode?: number;
    loudness?: number;
    time_signature?: number;
  };
  beats?: AnalysisQuantum[];
  tatums?: AnalysisQuantum[];
  segments?: AnalysisSegment[];
}
export const AudioAnalysisPayload = {};

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

function round3(x: number): number {
  return Math.round(x * 1000) / 1000;
}

function isPlausible(value: unknown): value is number {
  return typeof value === 'number' && Math.abs(value) <= MAX_PLAUSIBLE;
}

function meanConfidence(items: readonly AnalysisQuantum[]): number {
  if (items.length === 0) return 0;
  let sum = 0;
  for (const item of items) sum += isPlausible(item.confidence) ? clamp01(item.confidence) : 0;
  return sum / items.length;
}

/** Coefficient of variation of the inter-beat intervals, with the median beat length as tempo. */
function beatStatistics(beats: readonly AnalysisQuantum[]): { cv: number; bpm: number } | null {
  const intervals: number[] = [];
  for (const beat of beats) {
    if (isPlausible(beat.duration) && beat.duration > 0) intervals.push(beat.duration);
  }
  if (intervals.length < MIN_BEATS) return null;

  const mean = intervals.reduce((sum, value) => sum + value, 0) / intervals.length;
  const variance = intervals.reduce((sum, value) => sum + (value - mean) ** 2, 0) / intervals.length;
  const sorted = [...intervals].sort((a, b) => a - b);

  return { cv: Math.sqrt(variance) / mean, bpm: 60 / sorted[sorted.length >> 1] };
}

/** Share of chroma energy on the tonic triad: 1 for a pure triad, about 0.25 for flat noise. */
function triadConsonance(chroma: readonly number[], key: number, mode: number): number {
  const third = mode === 1 ? 4 : 3;
  const total = chroma.reduce((sum, value) => sum + value, 0);
  if (total === 0) return 0;
  return (chroma[key] + chroma[(key + third) % 12] + chroma[(key + 7) % 12]) / total;
}

/**
 * Deterministic reconstruction of the 8 audio-features from an Echo Nest analysis tree. Each dimension
 * is a hand-set heuristic on physically related quantities: the coefficients were not fitted against
 * Spotify's values, since no labeled pair is available here. They order tracks plausibly, but they are
 * not the numbers the audio-features endpoint would return.
 *
 * O(segments + beats): one pass, no allocation per segment.
 */
export function synthesizeFeatures(payload: AudioAnalysisPayload): AcousticFeatures | null {
  const track = payload.track ?? {};
  const beats = payload.beats ?? [];
  const tatums = payload.tatums ?? [];
  const segments = payload.segments ?? [];

  const chroma = new Array<number>(CHROMA_SIZE).fill(0);
  const timbreMean = new Array<number>(TIMBRE_SIZE).fill(0);
  const timbreSquare = new Array<number>(TIMBRE_SIZE).fill(0);

  let duration = 0;
  let onsets = 0;
  let maxAttack = Number.NEGATIVE_INFINITY;
  let sustainedWeight = 0;
  const sustainedSum = [0, 0, 0];
  const sustainedSquare = [0, 0, 0];
  let syllabic = 0;
  let pitchPeakSum = 0;
  let tailSum = 0;
  let tailCount = 0;

  for (const segment of segments) {
    const weight = segment.duration ?? 0;
    const { pitches } = segment;
    if (!isPlausible(weight) || weight <= 0 || !pitches || pitches.length !== CHROMA_SIZE || !pitches.every(isPlausible)) continue;

    const timbre = segment.timbre?.every(isPlausible) ? segment.timbre : undefined;

    duration += weight;
    onsets++;

    let pitchPeak = 0;
    for (let i = 0; i < CHROMA_SIZE; i++) {
      chroma[i] += weight * pitches[i];
      if (pitches[i] > pitchPeak) pitchPeak = pitches[i];
    }
    pitchPeakSum += pitchPeak;

    if (weight < SYLLABLE_SEGMENT_S) syllabic++;

    if (timbre) {
      for (let i = 0; i < TIMBRE_SIZE && i < timbre.length; i++) {
        timbreMean[i] += weight * timbre[i];
        timbreSquare[i] += weight * timbre[i] * timbre[i];
      }
      if (timbre[3] > maxAttack) maxAttack = timbre[3];

      if (weight >= SUSTAINED_SEGMENT_S) {
        sustainedWeight += weight;
        [timbre[1], timbre[2], timbre[4]].forEach((value, i) => {
          sustainedSum[i] += weight * value;
          sustainedSquare[i] += weight * value * value;
        });
      }
    }

    const { loudness_start: start, loudness_max: peak } = segment;
    if (isPlausible(start) && isPlausible(peak) && peak < -20) {
      tailSum += peak - start;
      tailCount++;
    }
  }

  const hasSegments = duration > 0;
  const tempo = isPlausible(track.tempo) && track.tempo > 0 ? track.tempo : undefined;
  if (!hasSegments && !tempo) return null;

  const stats = beatStatistics(beats);
  const beatConfidence = meanConfidence(beats);
  const pulseConfidence = tatums.length > 0 ? 0.7 * beatConfidence + 0.3 * meanConfidence(tatums) : beatConfidence;

  let bpm = tempo;
  if (stats && bpm) {
    const trust = isPlausible(track.tempo_confidence) ? clamp01(track.tempo_confidence) : 0.5;
    bpm = trust * bpm + (1 - trust) * stats.bpm;
  }

  const features: AcousticFeatures = {
    bpm: bpm ? round3(bpm) : undefined,
    source: SYNTHESIZED_SOURCE,
    synthesisVersion: SYNTHESIS_VERSION
  };

  const key = declaredOrEstimatedKey(track, hasSegments ? chroma : null);
  if (key) {
    features.key = key.pitchClass;
    features.mode = key.mode;
    features.keyConfidence = round3(key.confidence);
    features.camelot = formatCamelot(toCamelot(key.pitchClass, key.mode));
  }

  const loudness = isPlausible(track.loudness) ? track.loudness : undefined;
  if (!hasSegments) {
    if (loudness !== undefined) features.energy = round3(clamp01((loudness + 35) / 35));
    return features;
  }

  for (let i = 0; i < TIMBRE_SIZE; i++) {
    timbreMean[i] /= duration;
    timbreSquare[i] = Math.max(0, timbreSquare[i] / duration - timbreMean[i] ** 2);
  }

  const onsetRate = onsets / duration;
  const [t0Std, t1, t2] = [Math.sqrt(timbreSquare[0]), timbreMean[1], timbreMean[2]];

  const level = ((loudness ?? -14) + 35) / 35;
  const energy = sigmoid(3 * level + 0.15 * onsetRate + 0.03 * t0Std - 2.2);

  const danceability = stats
    ? clamp01(pulseConfidence * Math.exp(-IBI_REGULARITY_GAMMA * stats.cv))
    : clamp01(pulseConfidence);

  const attack = Number.isFinite(maxAttack) ? maxAttack : 0;
  const acousticness = sigmoid(-t1 / 50 - t2 / 60 - attack / 150 + 0.4);

  let vocalVariance = 0;
  if (sustainedWeight > 0) {
    for (let i = 0; i < 3; i++) {
      const mean = sustainedSum[i] / sustainedWeight;
      vocalVariance += Math.max(0, sustainedSquare[i] / sustainedWeight - mean * mean);
    }
    vocalVariance /= 3;
  }
  const instrumentalness = sigmoid(2.2 - vocalVariance / 700);

  const sustain = pitchPeakSum / onsets;
  const speechiness = clamp01((syllabic / onsets) * 0.8 * (1.2 - sustain) + timbreSquare[5] / 20_000);

  const brightness = clamp01(0.5 + t1 / 300);
  const tempoLift = bpm ? clamp01((bpm - 60) / 120) : 0.5;
  const consonance = key ? clamp01((triadConsonance(chroma, key.pitchClass, key.mode) - 0.25) / 0.45) : 0.5;
  const modeSignal = key ? key.mode : 0.5;
  const valence = clamp01(0.35 * modeSignal + 0.25 * consonance + 0.25 * brightness + 0.15 * tempoLift);

  const tail = tailCount > 0 ? tailSum / tailCount : 12;
  // The bias was set from real tracks: 1.2 gave a median of 0.61, against 0.2 for catalog music
  const liveness = sigmoid(-0.65 - tail / 6);

  const peak = Math.max(...chroma);

  return {
    ...features,
    energy: round3(energy),
    danceability: round3(danceability),
    acousticness: round3(acousticness),
    instrumentalness: round3(instrumentalness),
    speechiness: round3(speechiness),
    valence: round3(valence),
    liveness: round3(liveness),
    chroma: chroma.map((value) => round3(peak > 0 ? value / peak : 0)),
    timbre: timbreMean.map((value) => Math.round(value * 100) / 100),
    timbreVariance: timbreSquare.map((value) => Math.round(value * 10) / 10)
  };
}

function declaredOrEstimatedKey(
  track: NonNullable<AudioAnalysisPayload['track']>,
  chroma: readonly number[] | null
): { pitchClass: number; mode: number; confidence: number } | null {
  const { key, mode, key_confidence: confidence } = track;
  if (typeof key === 'number' && key >= 0 && key < 12 && (mode === 0 || mode === 1)) {
    return { pitchClass: key, mode, confidence: confidence ?? 0 };
  }

  const estimate = chroma ? estimateKey(chroma) : null;
  return estimate && { pitchClass: estimate.pitchClass, mode: estimate.mode, confidence: estimate.correlation };
}
