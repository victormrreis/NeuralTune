import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FFT_SIZE,
  KRUMHANSL_MAJOR,
  KRUMHANSL_MINOR,
  MEL_FILTER_COUNT,
  SpectralAnalyzer,
  TrackAudioAccumulator,
  computeRms,
  dctII,
  estimateKey,
  estimateTempo,
  fft,
  hannWindow,
  hzToMel,
  melFilterBank,
  melToHz
} from '../src/dsp/LocalAudioDSPEngine.ts';
import { formatCamelot } from '../src/math/Camelot.ts';

const RATE = 44100;
const TOLERANCE = 1e-5;

function tone(hz: number, seconds: number, amplitude: number = 0.5, rate: number = RATE): Float64Array {
  return Float64Array.from({ length: Math.floor(seconds * rate) }, (_, n) => amplitude * Math.sin((2 * Math.PI * hz * n) / rate));
}

function midiHz(note: number): number {
  return 440 * 2 ** ((note - 69) / 12);
}

function mix(notes: number[], seconds: number): Float64Array {
  const output = new Float64Array(Math.floor(seconds * RATE));
  for (const note of notes) {
    const signal = tone(midiHz(note), seconds, 0.3 / notes.length * 2);
    for (let i = 0; i < output.length; i++) output[i] += signal[i];
  }
  return output;
}

test('Hann: the specified formula, zero at both ends and 1 at the center', () => {
  const window = hannWindow(2049);
  assert.ok(Math.abs(window[0]) < TOLERANCE);
  assert.ok(Math.abs(window[2048]) < TOLERANCE);
  assert.ok(Math.abs(window[1024] - 1) < TOLERANCE);
  assert.ok(Math.abs(window[100] - 0.5 * (1 - Math.cos((2 * Math.PI * 100) / 2048))) < 1e-12);
});

test('FFT: agrees with a direct DFT', () => {
  const size = 64;
  const signal = Float64Array.from({ length: size }, (_, n) => Math.sin(n) + 0.3 * Math.cos(5 * n) + (n % 7) / 7);
  const real = Float64Array.from(signal);
  const imaginary = new Float64Array(size);
  fft(real, imaginary);

  for (let k = 0; k < size; k++) {
    let re = 0;
    let im = 0;
    for (let n = 0; n < size; n++) {
      re += signal[n] * Math.cos((-2 * Math.PI * k * n) / size);
      im += signal[n] * Math.sin((-2 * Math.PI * k * n) / size);
    }
    assert.ok(Math.abs(real[k] - re) < 1e-9);
    assert.ok(Math.abs(imaginary[k] - im) < 1e-9);
  }
});

test('FFT: Parseval holds, and sizes that are not powers of two are refused', () => {
  const size = FFT_SIZE;
  const signal = Float64Array.from(tone(997, size / RATE + 0.01).subarray(0, size));
  const real = Float64Array.from(signal);
  const imaginary = new Float64Array(size);
  fft(real, imaginary);

  const time = signal.reduce((sum, x) => sum + x * x, 0);
  let frequency = 0;
  for (let k = 0; k < size; k++) frequency += real[k] ** 2 + imaginary[k] ** 2;

  assert.ok(Math.abs(frequency / size - time) < 1e-6);
  assert.throws(() => fft(new Float64Array(100), new Float64Array(100)), /power of two/);
});

test('Mel: the 2595 log10 scale, invertible, 1000 Hz near 1000 mel', () => {
  assert.ok(Math.abs(hzToMel(1000) - 1000) < 1);
  assert.ok(Math.abs(hzToMel(700) - 2595 * Math.log10(2)) < TOLERANCE);
  for (const hz of [20, 440, 8000, 22050]) assert.ok(Math.abs(melToHz(hzToMel(hz)) - hz) < 1e-6);
});

test('Mel filter bank: 26 triangles, peak near 1, spacing grows with frequency', () => {
  const filters = melFilterBank(RATE);
  assert.equal(filters.length, MEL_FILTER_COUNT);
  assert.equal(filters[0].length, FFT_SIZE / 2 + 1);

  const peaks = filters.map((filter) => filter.reduce((best, value, k) => (value > filter[best] ? k : best), 0));
  for (let i = 1; i < peaks.length; i++) assert.ok(peaks[i] >= peaks[i - 1]);
  assert.ok(peaks[25] - peaks[24] > peaks[5] - peaks[4]);

  for (const filter of filters.slice(8)) assert.ok(Math.max(...filter) > 0.8);
});

test('DCT-II: the specified sum, c_0 is the total, and a constant has no other coefficient', () => {
  const energies = [1, 2, 3, 4];
  const [c0, c1] = dctII(energies, 2);

  assert.ok(Math.abs(c0 - 10) < TOLERANCE);
  const expected = energies.reduce((sum, s, i) => sum + s * Math.cos((Math.PI * (i + 0.5)) / 4), 0);
  assert.ok(Math.abs(c1 - expected) < TOLERANCE);

  const flat = dctII(new Array(26).fill(3), 13);
  flat.slice(1).forEach((c) => assert.ok(Math.abs(c) < 1e-9));
});

test('RMS: of a sine is A/√2', () => {
  assert.ok(Math.abs(computeRms(tone(440, 1, 0.8)) - 0.8 / Math.SQRT2) < 1e-4);
});

test('Analyzer: a pure tone lands on its pitch class and its centroid', () => {
  const analyzer = new SpectralAnalyzer(RATE);
  const frame = analyzer.analyze(tone(440, 0.1));

  assert.equal(frame.chroma.indexOf(Math.max(...frame.chroma)), 9);
  assert.ok(Math.abs(frame.centroidHz - 440) < 60);
  assert.equal(frame.mfcc.length, 13);
  assert.ok(frame.mfcc.every(Number.isFinite));
});

test('Analyzer: chroma is an octave-invariant projection', () => {
  const analyzer = new SpectralAnalyzer(RATE);
  for (const hz of [220, 440, 880, 1760]) {
    const { chroma } = analyzer.analyze(tone(hz, 0.1));
    assert.equal(chroma.indexOf(Math.max(...chroma)), 9, `${hz} Hz`);
  }
});

test('Analyzer: a brighter sound has a higher centroid', () => {
  const analyzer = new SpectralAnalyzer(RATE);
  assert.ok(analyzer.analyze(tone(3000, 0.1)).centroidHz > analyzer.analyze(tone(300, 0.1)).centroidHz * 3);
});

test('Key: each of the 24 Krumhansl profiles is recognized as itself', () => {
  for (let pitchClass = 0; pitchClass < 12; pitchClass++) {
    for (const mode of [0, 1]) {
      const profile = mode === 1 ? KRUMHANSL_MAJOR : KRUMHANSL_MINOR;
      const chroma = profile.map((_, i) => profile[(i - pitchClass + 12) % 12]);

      const estimate = estimateKey(chroma)!;
      assert.equal(estimate.pitchClass, pitchClass);
      assert.equal(estimate.mode, mode);
      assert.ok(Math.abs(estimate.correlation - 1) < TOLERANCE);
    }
  }
});

test('Key: maps straight onto the Camelot wheel, and flat chroma is no key at all', () => {
  const cMajor = KRUMHANSL_MAJOR;
  const aMinor = KRUMHANSL_MINOR.map((_, i) => KRUMHANSL_MINOR[(i - 9 + 12) % 12]);

  assert.equal(formatCamelot(estimateKey(cMajor)!.camelot), '8B');
  assert.equal(formatCamelot(estimateKey(aMinor)!.camelot), '8A');
  assert.equal(estimateKey(new Array(12).fill(1)), null);
});

test('Key: a synthesized I-IV-V progression in G major is detected from PCM', () => {
  const g = [67, 71, 74];
  const c = [60, 64, 67];
  const d = [62, 66, 69];

  const accumulator = new TrackAudioAccumulator(RATE);
  for (let bar = 0; bar < 6; bar++) {
    for (const chord of [g, c, d, g]) accumulator.push(mix(chord, 1));
  }

  const features = accumulator.finalize(10)!;
  assert.equal(features.key, 7);
  assert.equal(features.mode, 1);
  assert.equal(features.camelot, '9B');
});

test('Key: a synthesized progression in A minor is detected as minor', () => {
  const am = [69, 72, 76];
  const dm = [62, 65, 69];
  const e = [64, 68, 71];

  const accumulator = new TrackAudioAccumulator(RATE);
  for (let bar = 0; bar < 6; bar++) {
    for (const chord of [am, dm, e, am]) accumulator.push(mix(chord, 1));
  }

  const features = accumulator.finalize(10)!;
  assert.equal(features.key, 9);
  assert.equal(features.mode, 0);
  assert.equal(features.camelot, '8A');
});

function clickTrack(bpm: number, seconds: number): Float64Array {
  const output = new Float64Array(Math.floor(seconds * RATE));
  const period = (60 / bpm) * RATE;
  for (let beat = 0; beat * period < output.length; beat++) {
    const start = Math.floor(beat * period);
    for (let i = 0; i < 2000 && start + i < output.length; i++) {
      output[start + i] = Math.sin((2 * Math.PI * 1000 * i) / RATE) * Math.exp(-i / 400) * 0.8;
    }
  }
  return output;
}

test('Tempo: recovers BPM from an impulse envelope within 1%', () => {
  const framesPerSecond = 100;
  for (const bpm of [70, 90, 120, 128, 150, 174]) {
    const envelope = new Float64Array(framesPerSecond * 30);
    const period = (60 / bpm) * framesPerSecond;
    for (let beat = 0; beat * period < envelope.length; beat++) envelope[Math.round(beat * period)] = 1;

    const estimated = estimateTempo(envelope, framesPerSecond)!;
    assert.ok(Math.abs(estimated - bpm) / bpm < 0.01, `${bpm} → ${estimated}`);
  }
});

test('Tempo: recovers BPM from PCM clicks through the full pipeline', () => {
  for (const bpm of [100, 128, 160]) {
    const accumulator = new TrackAudioAccumulator(RATE);
    accumulator.push(clickTrack(bpm, 30));

    const features = accumulator.finalize(1)!;
    assert.ok(Math.abs(features.bpm! - bpm) / bpm < 0.02, `${bpm} → ${features.bpm}`);
  }
});

test('Tempo: a steady tone has no tempo, instead of a number made of noise', () => {
  const accumulator = new TrackAudioAccumulator(RATE);
  accumulator.push(mix([60, 64, 67], 25));

  assert.equal(accumulator.finalize()!.bpm, undefined);
});

test('Tempo: no pulse, no answer', () => {
  assert.equal(estimateTempo(new Float64Array(3000).fill(1), 100), null);
  assert.equal(estimateTempo(new Float64Array(10), 100), null);
});

test('Accumulator: blocks of any size give the same result as one push', () => {
  const signal = mix([60, 64, 67], 3);

  const whole = new TrackAudioAccumulator(RATE);
  whole.push(signal);

  const chunked = new TrackAudioAccumulator(RATE);
  for (let i = 0; i < signal.length; i += 777) chunked.push(signal.subarray(i, i + 777));

  assert.deepEqual(chunked.finalize(1), whole.finalize(1));
});

test('Accumulator: too little signal, or silence, yields nothing instead of a wrong track', () => {
  const short = new TrackAudioAccumulator(RATE);
  short.push(mix([60, 64, 67], 2));
  assert.equal(short.finalize(), null);

  const silent = new TrackAudioAccumulator(RATE);
  silent.push(new Float64Array(RATE * 30));
  assert.equal(silent.finalize(), null);
});

test('Accumulator: silence inside a track does not dilute the energy', () => {
  const steady = new TrackAudioAccumulator(RATE);
  steady.push(tone(440, 10));

  const gapped = new TrackAudioAccumulator(RATE);
  gapped.push(tone(440, 5));
  gapped.push(new Float64Array(RATE * 5));
  gapped.push(tone(440, 5));

  assert.ok(Math.abs(steady.finalize(1)!.energy! - gapped.finalize(1)!.energy!) < 0.02);
});

test('Accumulator: louder means more energy', () => {
  const quiet = new TrackAudioAccumulator(RATE);
  quiet.push(tone(440, 5, 0.05));
  const loud = new TrackAudioAccumulator(RATE);
  loud.push(tone(440, 5, 0.7));

  assert.ok(loud.finalize(1)!.energy! > quiet.finalize(1)!.energy! + 0.4);
});
