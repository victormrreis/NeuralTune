export interface WeightedObservation {
  values: readonly number[];
  known: readonly boolean[];
  weight: number;
}
export const WeightedObservation = {};

export interface CovarianceResult {
  mean: number[];
  covariance: number[][];
  observationsPerDimension: number[];
}

export interface EigenPair {
  value: number;
  vector: number[];
}

const JACOBI_SWEEPS = 100;
const JACOBI_TOLERANCE = 1e-14;

/**
 * Weighted covariance. An unknown dimension sits at that dimension's mean, so it adds nothing to the
 * cross terms: Σ stays positive semidefinite, which pairwise deletion does not guarantee.
 */
export function weightedCovariance(observations: readonly WeightedObservation[], size: number): CovarianceResult {
  const mean = new Array<number>(size).fill(0);
  const dimensionWeight = new Array<number>(size).fill(0);
  const observationsPerDimension = new Array<number>(size).fill(0);
  let totalWeight = 0;

  for (const { values, known, weight } of observations) {
    totalWeight += weight;
    for (let i = 0; i < size; i++) {
      if (!known[i]) continue;
      mean[i] += weight * values[i];
      dimensionWeight[i] += weight;
      observationsPerDimension[i]++;
    }
  }

  for (let i = 0; i < size; i++) {
    if (dimensionWeight[i] > 0) mean[i] /= dimensionWeight[i];
  }

  const covariance = mean.map(() => new Array<number>(size).fill(0));
  if (totalWeight === 0) return { mean, covariance, observationsPerDimension };

  for (const { values, known, weight } of observations) {
    for (let i = 0; i < size; i++) {
      const left = known[i] ? values[i] - mean[i] : 0;
      for (let j = i; j < size; j++) {
        const right = known[j] ? values[j] - mean[j] : 0;
        covariance[i][j] += (weight * left * right) / totalWeight;
      }
    }
  }

  for (let i = 0; i < size; i++) {
    for (let j = 0; j < i; j++) covariance[i][j] = covariance[j][i];
  }

  return { mean, covariance, observationsPerDimension };
}

/** Cyclic Jacobi rotations for a symmetric matrix. Eigenpairs sorted by descending eigenvalue. */
export function symmetricEigen(input: ReadonlyArray<readonly number[]>): EigenPair[] {
  const size = input.length;
  const a = input.map((row) => [...row]);
  const v: number[][] = input.map((_, i) => input.map((__, j) => (i === j ? 1 : 0)));

  for (let sweep = 0; sweep < JACOBI_SWEEPS; sweep++) {
    let offDiagonal = 0;
    for (let i = 0; i < size; i++) {
      for (let j = i + 1; j < size; j++) offDiagonal += a[i][j] * a[i][j];
    }
    if (offDiagonal < JACOBI_TOLERANCE * JACOBI_TOLERANCE) break;

    for (let p = 0; p < size; p++) {
      for (let q = p + 1; q < size; q++) {
        if (Math.abs(a[p][q]) < 1e-300) continue;

        const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
        const t = (theta >= 0 ? 1 : -1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;

        for (let k = 0; k < size; k++) {
          const akp = a[k][p];
          const akq = a[k][q];
          a[k][p] = c * akp - s * akq;
          a[k][q] = s * akp + c * akq;
        }
        for (let k = 0; k < size; k++) {
          const apk = a[p][k];
          const aqk = a[q][k];
          a[p][k] = c * apk - s * aqk;
          a[q][k] = s * apk + c * aqk;
        }
        for (let k = 0; k < size; k++) {
          const vkp = v[k][p];
          const vkq = v[k][q];
          v[k][p] = c * vkp - s * vkq;
          v[k][q] = s * vkp + c * vkq;
        }
      }
    }
  }

  return a
    .map((row, i) => ({ value: row[i], vector: v.map((column) => column[i]) }))
    .sort((x, y) => y.value - x.value);
}

export interface PrincipalAxes {
  axes: number[][];
  eigenvalues: number[];
  explained: number[];
  orthogonality: number;
}
export const PrincipalAxes = {};

/** Power iteration with Hotelling deflation: Σ ← Σ - λ v vᵀ after each component. */
export function powerIterationPca(covariance: ReadonlyArray<readonly number[]>, components: number = 2, iterations: number = 500): PrincipalAxes {
  const size = covariance.length;
  const matrix = covariance.map((row) => [...row]);
  const trace = covariance.reduce((sum, row, i) => sum + row[i], 0);
  const axes: number[][] = [];
  const eigenvalues: number[] = [];

  for (let c = 0; c < components; c++) {
    // A fixed, non-symmetric start: deterministic, and not orthogonal to the leading axis by accident
    let vector = Array.from({ length: size }, (_, i) => 1 + (i + 1) * 0.1 + c);

    for (let iteration = 0; iteration < iterations; iteration++) {
      for (const previous of axes) {
        const projection = previous.reduce((sum, value, i) => sum + value * vector[i], 0);
        vector = vector.map((value, i) => value - projection * previous[i]);
      }
      const next = matrix.map((row) => row.reduce((sum, value, i) => sum + value * vector[i], 0));
      const norm = Math.sqrt(next.reduce((sum, value) => sum + value * value, 0));
      if (norm < 1e-14) break; // Nothing left to explain: the orthogonalized start stands as a zero-variance axis
      const change = next.reduce((sum, value, i) => sum + Math.abs(Math.abs(value / norm) - Math.abs(vector[i])), 0);
      vector = next.map((value) => value / norm);
      if (change < 1e-12) break;
    }

    const lengthOf = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
    const unit = lengthOf > 0 ? vector.map((value) => value / lengthOf) : vector;
    const product = matrix.map((row) => row.reduce((sum, value, i) => sum + value * unit[i], 0));
    const eigenvalue = product.reduce((sum, value, i) => sum + value * unit[i], 0);

    for (let i = 0; i < size; i++) {
      for (let j = 0; j < size; j++) matrix[i][j] -= eigenvalue * unit[i] * unit[j];
    }

    axes.push(unit);
    eigenvalues.push(eigenvalue);
  }

  let orthogonality = 0;
  for (let i = 0; i < axes.length; i++) {
    for (let j = i + 1; j < axes.length; j++) {
      orthogonality = Math.max(orthogonality, Math.abs(axes[i].reduce((sum, value, k) => sum + value * axes[j][k], 0)));
    }
  }

  return { axes, eigenvalues, explained: eigenvalues.map((value) => (trace > 0 ? Math.max(0, value) / trace : 0)), orthogonality };
}