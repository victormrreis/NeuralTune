import { CamelotKey, PITCH_CLASSES, formatCamelot, toCamelot } from '../math/Camelot.ts';
import { AcousticFeatures } from '../types/index.ts';

export const FFT_SIZE = 2048;
export const MEL_FILTER_COUNT = 26;
export const MFCC_COUNT = 13;
export const CHROMA_SIZE = 12;

const CHROMA_MIN_HZ = 110;
const CHROMA_MAX_HZ = 5000;
const MIN_BPM = 60;
const MAX_BPM = 200;
const SILENCE_RMS = 1e-4;
const MIN_ANALYZED_SECONDS = 20;
const MIN_PULSE_CLARITY = 0.1;

// Krumhansl & Kessler (1982) tonal hierarchy, from the tonic upwards
export const KRUMHANSL_MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
export const KRUMHANSL_MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

export interface KeyEstimate {
  pitchClass: number;
  mode: number; // 1 = major, 0 = minor
  correlation: number;
  name: string;
  camelot: CamelotKey;
}
export const KeyEstimate = {};

export interface FrameFeatures {
  rms: number;
  centroidHz: number;
  flux: number;
  mfcc: number[];
  chroma: number[];
}
export const FrameFeatures = {};

export function hzToMel(hz: number): number {
  return 2595 * Math.log10(1 + hz / 700);
}

export function melToHz(mel: number): number {
  return 700 * (10 ** (mel / 2595) - 1);
}

/** w(n) = 0.5 (1 - cos(2πn / (N - 1))) */
export function hannWindow(size: number): Float64Array {
  const window = new Float64Array(size);
  for (let n = 0; n < size; n++) {
    window[n] = 0.5 * (1 - Math.cos((2 * Math.PI * n) / (size - 1)));
  }
  return window;
}

/** In-place iterative radix-2 Cooley-Tukey FFT. */
export function fft(real: Float64Array, imaginary: Float64Array): void {
  const size = real.length;
  if ((size & (size - 1)) !== 0) throw new Error('FFT size must be a power of two');

  for (let i = 1, j = 0; i < size; i++) {
    let bit = size >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [real[i], real[j]] = [real[j], real[i]];
      [imaginary[i], imaginary[j]] = [imaginary[j], imaginary[i]];
    }
  }

  for (let length = 2; length <= size; length <<= 1) {
    const angle = (-2 * Math.PI) / length;
    const half = length >> 1;
    for (let start = 0; start < size; start += length) {
      for (let k = 0; k < half; k++) {
        const wr = Math.cos(angle * k);
        const wi = Math.sin(angle * k);
        const a = start + k;
        const b = a + half;
        const tr = real[b] * wr - imaginary[b] * wi;
        const ti = real[b] * wi + imaginary[b] * wr;
        real[b] = real[a] - tr;
        imaginary[b] = imaginary[a] - ti;
        real[a] += tr;
        imaginary[a] += ti;
      }
    }
  }
}

/** Triangular filters with centers evenly spaced in mel, up to Nyquist. One row per filter. */
export function melFilterBank(sampleRate: number, size: number = FFT_SIZE, filters: number = MEL_FILTER_COUNT): Float64Array[] {
  const bins = size / 2 + 1;
  const maxMel = hzToMel(sampleRate / 2);
  const edges = Array.from({ length: filters + 2 }, (_, i) => melToHz((maxMel * i) / (filters + 1)));
  const hzPerBin = sampleRate / size;

  return Array.from({ length: filters }, (_, m) => {
    const [left, center, right] = [edges[m], edges[m + 1], edges[m + 2]];
    const row = new Float64Array(bins);
    for (let k = 0; k < bins; k++) {
      const hz = k * hzPerBin;
      if (hz > left && hz < center) row[k] = (hz - left) / (center - left);
      else if (hz >= center && hz < right) row[k] = (right - hz) / (right - center);
    }
    return row;
  });
}

/** c_k = Σ_{m=1..M} S_m cos(πk(m - 0.5) / M) */
export function dctII(energies: ArrayLike<number>, coefficients: number = MFCC_COUNT): number[] {
  const size = energies.length;
  return Array.from({ length: coefficients }, (_, k) => {
    let sum = 0;
    for (let m = 1; m <= size; m++) {
      sum += energies[m - 1] * Math.cos((Math.PI * k * (m - 0.5)) / size);
    }
    return sum;
  });
}

export function computeRms(samples: ArrayLike<number>): number {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / samples.length);
}

/** Pearson correlation of the chroma against all 24 rotations of the Krumhansl-Schmuckler profiles. */
export function estimateKey(chroma: readonly number[]): KeyEstimate | null {
  if (chroma.every((value) => value === chroma[0])) return null;

  let best: { pitchClass: number; mode: number; correlation: number } | null = null;

  for (let mode = 0; mode <= 1; mode++) {
    const profile = mode === 1 ? KRUMHANSL_MAJOR : KRUMHANSL_MINOR;
    for (let pitchClass = 0; pitchClass < CHROMA_SIZE; pitchClass++) {
      const rotated = chroma.map((_, i) => profile[(i - pitchClass + CHROMA_SIZE) % CHROMA_SIZE]);
      const correlation = pearson(chroma, rotated);
      if (!best || correlation > best.correlation) best = { pitchClass, mode, correlation };
    }
  }

  const { pitchClass, mode, correlation } = best!;
  return {
    pitchClass,
    mode,
    correlation,
    name: `${PITCH_CLASSES[pitchClass]} ${mode === 1 ? 'maior' : 'menor'}`,
    camelot: toCamelot(pitchClass, mode)
  };
}

function pearson(a: readonly number[], b: readonly number[]): number {
  const meanA = a.reduce((sum, value) => sum + value, 0) / a.length;
  const meanB = b.reduce((sum, value) => sum + value, 0) / b.length;
  let covariance = 0;
  let varianceA = 0;
  let varianceB = 0;

  for (let i = 0; i < a.length; i++) {
    covariance += (a[i] - meanA) * (b[i] - meanB);
    varianceA += (a[i] - meanA) ** 2;
    varianceB += (b[i] - meanB) ** 2;
  }

  const denominator = Math.sqrt(varianceA * varianceB);
  return denominator === 0 ? 0 : covariance / denominator;
}

/** R(τ) = Σ_t X(t) X(t - τ) over the rectified, mean-removed flux. Returns null without a clear pulse. */
export function estimateTempo(envelope: ArrayLike<number>, framesPerSecond: number): number | null {
  const size = envelope.length;
  if (size < framesPerSecond * 4) return null;

  let mean = 0;
  for (let i = 0; i < size; i++) mean += envelope[i];
  mean /= size;

  // Light smoothing: a beat falling between two frames must not lose to its double at a whole lag
  const x = Float64Array.from({ length: size }, (_, i) => {
    const before = envelope[Math.max(0, i - 1)];
    const after = envelope[Math.min(size - 1, i + 1)];
    return 0.25 * before + 0.5 * envelope[i] + 0.25 * after - mean;
  });

  let energy = 0;
  for (let t = 0; t < size; t++) energy += x[t] * x[t];
  if (energy === 0) return null;

  const minLag = Math.max(1, Math.floor((60 / MAX_BPM) * framesPerSecond));
  const maxLag = Math.min(size - 1, Math.ceil((60 / MIN_BPM) * framesPerSecond));
  const autocorrelation = new Float64Array(maxLag + 2);

  for (let lag = minLag - 1; lag <= maxLag + 1 && lag < size; lag++) {
    let sum = 0;
    for (let t = lag; t < size; t++) sum += x[t] * x[t - lag];
    autocorrelation[lag] = sum / (size - lag);
  }

  // A period between two frames splits its peak: comparing neighborhoods keeps it from losing to its double
  const strength = (lag: number) => autocorrelation[lag - 1] + autocorrelation[lag] + autocorrelation[lag + 1];

  let bestLag = 0;
  let bestValue = 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    const value = strength(lag);
    if (value > bestValue) {
      bestValue = value;
      bestLag = lag;
    }
  }
  if (bestLag === 0) return null;

  // A steady tone still has a highest noise peak: without a clear periodicity there is no tempo to report
  if (bestValue / 3 < MIN_PULSE_CLARITY * (energy / size)) return null;

  // Multiples of the beat period also peak: prefer the fastest one nearly as strong
  for (let divisor = 4; divisor >= 2; divisor--) {
    const fraction = Math.round(bestLag / divisor);
    if (fraction >= minLag && strength(fraction) > 0.85 * bestValue) {
      bestLag = fraction;
      bestValue = strength(fraction);
      break;
    }
  }

  // Parabolic interpolation: a whole-frame lag alone quantizes the tempo too coarsely at 120 BPM
  const [before, at, after] = [autocorrelation[bestLag - 1], autocorrelation[bestLag], autocorrelation[bestLag + 1]];
  const curvature = before - 2 * at + after;
  const offset = curvature < 0 ? (0.5 * (before - after)) / curvature : 0;
  const refinedLag = bestLag + Math.max(-1, Math.min(1, offset));
  return (60 * framesPerSecond) / refinedLag;
}

/** Spectral analysis of successive frames. Buffers are reused: this runs inside the audio callback. */
export class SpectralAnalyzer {
  readonly sampleRate: number;
  readonly size: number;

  private window: Float64Array;
  private filters: Float64Array[];
  private real: Float64Array;
  private imaginary: Float64Array;
  private previousMagnitude: Float64Array;
  private pitchClassOfBin: Int8Array;

  constructor(sampleRate: number, size: number = FFT_SIZE) {
    this.sampleRate = sampleRate;
    this.size = size;
    this.window = hannWindow(size);
    this.filters = melFilterBank(sampleRate, size);
    this.real = new Float64Array(size);
    this.imaginary = new Float64Array(size);
    this.previousMagnitude = new Float64Array(size / 2 + 1);
    this.pitchClassOfBin = this.mapBinsToPitchClasses();
  }

  private mapBinsToPitchClasses(): Int8Array {
    const bins = new Int8Array(this.size / 2 + 1).fill(-1);
    const hzPerBin = this.sampleRate / this.size;

    for (let k = 1; k < bins.length; k++) {
      const hz = k * hzPerBin;
      if (hz < CHROMA_MIN_HZ || hz > CHROMA_MAX_HZ) continue;
      const semitone = Math.round(12 * Math.log2(hz / 440)) + 9; // A4 is pitch class 9
      bins[k] = ((semitone % CHROMA_SIZE) + CHROMA_SIZE) % CHROMA_SIZE;
    }
    return bins;
  }

  analyze(frame: ArrayLike<number>): FrameFeatures {
    const { real, imaginary, window, size } = this;
    for (let n = 0; n < size; n++) {
      real[n] = frame[n] * window[n];
      imaginary[n] = 0;
    }
    fft(real, imaginary);

    const bins = size / 2 + 1;
    const hzPerBin = this.sampleRate / size;
    const chroma = new Array<number>(CHROMA_SIZE).fill(0);
    let flux = 0;
    let weightedHz = 0;
    let magnitudeSum = 0;

    const power = new Float64Array(bins);
    for (let k = 0; k < bins; k++) {
      power[k] = real[k] * real[k] + imaginary[k] * imaginary[k];
      const magnitude = Math.sqrt(power[k]);

      flux += Math.max(0, magnitude - this.previousMagnitude[k]);
      this.previousMagnitude[k] = magnitude;

      weightedHz += k * hzPerBin * magnitude;
      magnitudeSum += magnitude;

      const pitchClass = this.pitchClassOfBin[k];
      if (pitchClass >= 0) chroma[pitchClass] += power[k];
    }

    const melLog = this.filters.map((filter) => {
      let energy = 0;
      for (let k = 0; k < bins; k++) energy += filter[k] * power[k];
      return Math.log(energy + 1e-10);
    });

    return {
      rms: computeRms(frame),
      centroidHz: magnitudeSum > 0 ? weightedHz / magnitudeSum : 0,
      flux,
      mfcc: dctII(melLog),
      chroma
    };
  }
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

/** dBFS mapped so -40 dB is 0 and 0 dB is 1. */
function energyFromDecibels(decibels: number): number {
  return clamp01((decibels + 40) / 40);
}

/**
 * Brightness and mode as a valence proxy. A heuristic: neither is valence, which was learned by
 * Spotify from human annotations, so this value is not comparable to the Web API one.
 */
function estimateValence(brightness: number, key: KeyEstimate | null): number {
  const modeSignal = key ? (key.mode === 1 ? 1 : 0) : 0.5;
  return clamp01(0.5 * brightness + 0.5 * modeSignal);
}

function brightnessFromCentroid(centroidHz: number): number {
  return centroidHz > 0 ? clamp01(Math.log2(centroidHz / 500) / 3) : 0;
}

function withKey(features: AcousticFeatures, key: KeyEstimate | null, chroma: number[]): AcousticFeatures {
  if (!key) return features;
  return {
    ...features,
    key: key.pitchClass,
    mode: key.mode,
    keyConfidence: Math.round(key.correlation * 1000) / 1000,
    camelot: formatCamelot(key.camelot),
    chroma: chroma.map((value) => Math.round(value * 1000) / 1000)
  };
}

function normalizedChroma(chroma: readonly number[]): number[] {
  const peak = Math.max(...chroma);
  return peak > 0 ? chroma.map((value) => value / peak) : [...chroma];
}

/** Accumulates one track of PCM, hop N/2, and condenses it into features. */
export class TrackAudioAccumulator {
  private analyzer: SpectralAnalyzer;
  private hop: number;
  private buffer: Float64Array;
  private filled = 0;

  private frames = 0;
  private rmsSum = 0;
  private centroidSum = 0;
  private chroma = new Array<number>(CHROMA_SIZE).fill(0);
  private mfcc = new Array<number>(MFCC_COUNT).fill(0);
  private envelope: number[] = [];

  constructor(sampleRate: number, size: number = FFT_SIZE) {
    this.analyzer = new SpectralAnalyzer(sampleRate, size);
    this.hop = size / 2;
    this.buffer = new Float64Array(size);
  }

  push(samples: ArrayLike<number>): void {
    for (let i = 0; i < samples.length; i++) {
      this.buffer[this.filled++] = samples[i];
      if (this.filled === this.buffer.length) {
        this.consumeFrame();
        this.buffer.copyWithin(0, this.hop);
        this.filled -= this.hop;
      }
    }
  }

  private consumeFrame(): void {
    const frame = this.analyzer.analyze(this.buffer);
    this.envelope.push(frame.flux);

    // Silence between tracks and muted skips must not pull the averages down
    if (frame.rms < SILENCE_RMS) return;

    this.frames++;
    this.rmsSum += frame.rms;
    this.centroidSum += frame.centroidHz;
    for (let i = 0; i < CHROMA_SIZE; i++) this.chroma[i] += frame.chroma[i];
    for (let i = 0; i < MFCC_COUNT; i++) this.mfcc[i] += frame.mfcc[i];
  }

  analyzedSeconds(): number {
    return (this.frames * this.hop) / this.analyzer.sampleRate;
  }

  /** Null when too little signal arrived to say anything about the track. */
  finalize(minimumSeconds: number = MIN_ANALYZED_SECONDS): AcousticFeatures | null {
    if (this.frames === 0 || this.analyzedSeconds() < minimumSeconds) return null;

    const rms = this.rmsSum / this.frames;
    const chroma = normalizedChroma(this.chroma);
    const key = estimateKey(chroma);
    const brightness = brightnessFromCentroid(this.centroidSum / this.frames);
    const bpm = estimateTempo(this.envelope, this.analyzer.sampleRate / this.hop);

    return withKey({
      bpm: bpm ?? undefined,
      energy: energyFromDecibels(20 * Math.log10(rms)),
      valence: estimateValence(brightness, key),
      timbre: this.mfcc.map((value) => Math.round((value / this.frames) * 100) / 100),
      source: 'NeuralTune Local DSP'
    }, key, chroma);
  }
}

export interface CaptureEnvironment {
  mediaDevices: boolean;
  displayCapture: boolean;
  audioInputs: string[];
  loopbackInputs: string[];
}
export const CaptureEnvironment = {};

const LOOPBACK_DEVICE = /stereo mix|mixagem est|loopback|cable output|voicemeeter|what u hear/i;

/**
 * Live capture of what the machine is playing, the only route that uses no remote service.
 *
 * Spotify Desktop decodes and plays music in its native main process: the CEF renderers load no audio
 * library and hold no audio session, so the page has no <audio> element or Web Audio graph carrying
 * music, and tapping one captures silence. A signal only reaches this page through a capture device,
 * so this class takes a MediaStream, and it hears everything the system plays, not just Spotify.
 */
export class LocalAudioDSPEngine {
  private onFeatures: (uri: string, features: AcousticFeatures) => void;

  private context: AudioContext | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private processor: ScriptProcessorNode | null = null;
  private stream: MediaStream | null = null;
  private accumulator: TrackAudioAccumulator | null = null;
  private currentUri: string | null = null;

  constructor(onFeatures: (uri: string, features: AcousticFeatures) => void) {
    this.onFeatures = onFeatures;
  }

  isCapturing(): boolean {
    return this.stream !== null;
  }

  async probeEnvironment(): Promise<CaptureEnvironment> {
    const devices = typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined;
    const inputs = (await devices?.enumerateDevices?.().catch(() => []) ?? [])
      .filter((device) => device.kind === 'audioinput')
      .map((device) => device.label);

    return {
      mediaDevices: !!devices?.getUserMedia,
      displayCapture: !!devices?.getDisplayMedia,
      audioInputs: inputs,
      loopbackInputs: inputs.filter((label) => LOOPBACK_DEVICE.test(label))
    };
  }

  /** Must run from a user gesture. Processing that alters levels would corrupt every measurement. */
  async startFromLoopbackDevice(): Promise<void> {
    const devices = navigator.mediaDevices;
    const available = await devices.enumerateDevices();
    const loopback = available.find((d) => d.kind === 'audioinput' && LOOPBACK_DEVICE.test(d.label));

    const stream = await devices.getUserMedia({
      audio: {
        deviceId: loopback ? { exact: loopback.deviceId } : undefined,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false
      }
    });
    await this.attachStream(stream);
  }

  /** ScriptProcessor rather than AudioWorklet: a worklet module needs a URL the client's CSP may refuse. */
  async attachStream(stream: MediaStream): Promise<void> {
    this.stop();

    const context = new AudioContext();
    const source = context.createMediaStreamSource(stream);
    const processor = context.createScriptProcessor(FFT_SIZE, 1, 1);

    processor.onaudioprocess = (event) => {
      this.accumulator?.push(event.inputBuffer.getChannelData(0));
    };

    const silent = context.createGain();
    silent.gain.value = 0; // A processor only runs when connected, and loopback must not feed back
    source.connect(processor);
    processor.connect(silent);
    silent.connect(context.destination);
    await context.resume();

    this.context = context;
    this.source = source;
    this.processor = processor;
    this.stream = stream;
    this.accumulator = this.currentUri ? new TrackAudioAccumulator(context.sampleRate) : null;
  }

  /** Attributes everything since the previous call to the previous track. */
  onTrackChange(uri: string | null): void {
    this.flush();
    this.currentUri = uri;
    this.accumulator = uri && this.context ? new TrackAudioAccumulator(this.context.sampleRate) : null;
  }

  stop(): void {
    this.flush();
    this.processor?.disconnect();
    this.source?.disconnect();
    this.stream?.getTracks().forEach((track) => track.stop());
    void this.context?.close();
    this.processor = null;
    this.source = null;
    this.stream = null;
    this.context = null;
    this.accumulator = null;
  }

  private flush(): void {
    const features = this.accumulator?.finalize();
    if (features && this.currentUri) this.onFeatures(this.currentUri, features);
  }
}
