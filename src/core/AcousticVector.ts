import { AcousticFeatures } from '../types/index.ts';

export const ACOUSTIC_DIMENSIONS = [
  'tempo',
  'energy',
  'valence',
  'danceability',
  'acousticness',
  'instrumentalness',
  'speechiness',
  'liveness'
] as const;

export type AcousticDimension = (typeof ACOUSTIC_DIMENSIONS)[number];
export const AcousticDimension = {};

export const ACOUSTIC_DIMENSION_COUNT = ACOUSTIC_DIMENSIONS.length;

/**
 * Prior location and spread of catalog music in each dimension. Audio features all live in [0, 1],
 * so raw vectors share one orthant and any two have a high cosine. Cosine is only informative after
 * centering on these values. They are rounded estimates, not fitted to this user's library.
 */
export const POPULATION_MEAN: readonly number[] = [0.47, 0.6, 0.5, 0.58, 0.3, 0.15, 0.09, 0.2];
export const POPULATION_STD: readonly number[] = [0.2, 0.2, 0.24, 0.16, 0.3, 0.3, 0.1, 0.17];

const TEMPO_MIN_BPM = 50;
const TEMPO_MAX_BPM = 200;
const STANDARDIZED_CLIP = 3;

export interface AcousticPoint {
  values: number[];
  known: boolean[];
}
export const AcousticPoint = {};

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function isUsable(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Projects features onto the 8-dimensional space. Absent dimensions take the population mean and are
 * flagged as unknown, so a tempo-only analysis fallback cannot teach the model anything about energy.
 * Returns null when no dimension is known.
 */
export function toAcousticPoint(features: AcousticFeatures | undefined): AcousticPoint | null {
  if (!features) return null;

  const hasTempo = isUsable(features.bpm) && features.bpm > 0;
  const raw: Array<number | undefined> = [
    hasTempo ? (features.bpm! - TEMPO_MIN_BPM) / (TEMPO_MAX_BPM - TEMPO_MIN_BPM) : undefined,
    features.energy,
    features.valence,
    features.danceability,
    features.acousticness,
    features.instrumentalness,
    features.speechiness,
    features.liveness
  ];

  const values = new Array<number>(ACOUSTIC_DIMENSION_COUNT);
  const known = new Array<boolean>(ACOUSTIC_DIMENSION_COUNT);
  let knownCount = 0;

  for (let i = 0; i < ACOUSTIC_DIMENSION_COUNT; i++) {
    const value = raw[i];
    known[i] = isUsable(value);
    values[i] = known[i] ? clamp01(value as number) : POPULATION_MEAN[i];
    if (known[i]) knownCount++;
  }

  return knownCount > 0 ? { values, known } : null;
}

export function standardize(values: readonly number[]): number[] {
  return values.map((value, i) => {
    const z = (value - POPULATION_MEAN[i]) / POPULATION_STD[i];
    return Math.max(-STANDARDIZED_CLIP, Math.min(STANDARDIZED_CLIP, z));
  });
}

export function dot(a: readonly number[], b: readonly number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}

/** Cosine in [-1, 1]. A zero vector carries no direction, so its similarity to anything is 0. */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  const denominator = Math.sqrt(dot(a, a) * dot(b, b));
  if (denominator === 0) return 0;
  return Math.max(-1, Math.min(1, dot(a, b) / denominator));
}

export function acousticSimilarity(a: readonly number[], b: readonly number[]): number {
  return cosineSimilarity(standardize(a), standardize(b));
}

const CROSS_TERMS: ReadonlyArray<readonly [AcousticDimension, AcousticDimension]> = [
  ['energy', 'valence'],
  ['energy', 'acousticness'],
  ['danceability', 'tempo'],
  ['instrumentalness', 'energy']
];

/** Bias, 8 linear terms, 8 squares and 4 crossings: what lets a linear model draw curved boundaries. */
export const BANDIT_CONTEXT_SIZE = 1 + 2 * ACOUSTIC_DIMENSION_COUNT + CROSS_TERMS.length;

const CROSS_INDEXES = CROSS_TERMS.map(([a, b]) => [ACOUSTIC_DIMENSIONS.indexOf(a), ACOUSTIC_DIMENSIONS.indexOf(b)]);

/** φ(z), normalized to unit length so the LinUCB uncertainty stays in (0, 1]. */
export function banditContext(values: readonly number[]): number[] {
  const z = standardize(values);
  const phi = [1, ...z];
  for (const value of z) phi.push(value * value - 1); // Centered: E[z²] = 1
  for (const [a, b] of CROSS_INDEXES) phi.push(z[a] * z[b]);

  const norm = Math.sqrt(dot(phi, phi));
  return phi.map((value) => value / norm);
}

/** Symmetric pairwise acoustic similarity between points given in the raw [0, 1] space. */
export function similarityMatrix(points: ReadonlyArray<readonly number[]>): number[][] {
  const standardized = points.map(standardize);
  const matrix = points.map(() => new Array<number>(points.length).fill(0));

  for (let i = 0; i < points.length; i++) {
    matrix[i][i] = cosineSimilarity(standardized[i], standardized[i]);
    for (let j = i + 1; j < points.length; j++) {
      const similarity = cosineSimilarity(standardized[i], standardized[j]);
      matrix[i][j] = similarity;
      matrix[j][i] = similarity;
    }
  }

  return matrix;
}

/** Gaussian kernel over the mean squared standardized distance of the dimensions known in `point`. */
export function acousticKernel(point: AcousticPoint, other: readonly number[], bandwidth: number): number {
  let squared = 0;
  let count = 0;

  for (let i = 0; i < ACOUSTIC_DIMENSION_COUNT; i++) {
    if (!point.known[i]) continue;
    const delta = (point.values[i] - other[i]) / POPULATION_STD[i];
    squared += delta * delta;
    count++;
  }

  return count === 0 ? 0 : Math.exp(-(squared / count) / (2 * bandwidth * bandwidth));
}

export function identityMatrix(size: number, scale: number = 1): number[][] {
  const matrix: number[][] = [];
  for (let i = 0; i < size; i++) {
    const row = new Array<number>(size).fill(0);
    row[i] = scale;
    matrix.push(row);
  }
  return matrix;
}

export function matrixVector(matrix: ReadonlyArray<readonly number[]>, vector: readonly number[]): number[] {
  return matrix.map((row) => dot(row, vector));
}

/** Gauss-Jordan inversion with partial pivoting. Throws on a singular matrix. */
export function invertMatrix(matrix: ReadonlyArray<readonly number[]>): number[][] {
  const size = matrix.length;
  const left = matrix.map((row) => [...row]);
  const right = identityMatrix(size);

  for (let column = 0; column < size; column++) {
    let pivotRow = column;
    for (let row = column + 1; row < size; row++) {
      if (Math.abs(left[row][column]) > Math.abs(left[pivotRow][column])) pivotRow = row;
    }

    const pivot = left[pivotRow][column];
    if (Math.abs(pivot) < 1e-12) throw new Error('Singular matrix');

    [left[column], left[pivotRow]] = [left[pivotRow], left[column]];
    [right[column], right[pivotRow]] = [right[pivotRow], right[column]];

    for (let i = 0; i < size; i++) {
      left[column][i] /= pivot;
      right[column][i] /= pivot;
    }

    for (let row = 0; row < size; row++) {
      if (row === column) continue;
      const factor = left[row][column];
      if (factor === 0) continue;
      for (let i = 0; i < size; i++) {
        left[row][i] -= factor * left[column][i];
        right[row][i] -= factor * right[column][i];
      }
    }
  }

  return right;
}
