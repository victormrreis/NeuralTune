import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ACOUSTIC_DIMENSION_COUNT,
  POPULATION_MEAN,
  acousticSimilarity,
  cosineSimilarity,
  dot,
  identityMatrix,
  invertMatrix,
  matrixVector,
  similarityMatrix,
  toAcousticPoint
} from '../src/core/AcousticVector.ts';

const metal = [0.75, 0.95, 0.25, 0.4, 0.02, 0.1, 0.1, 0.2];
const hardRock = [0.7, 0.9, 0.3, 0.45, 0.05, 0.05, 0.08, 0.25];
const ambient = [0.2, 0.1, 0.3, 0.2, 0.9, 0.9, 0.04, 0.1];

test('AcousticVector: projects features onto 8 normalized dimensions', () => {
  const point = toAcousticPoint({
    bpm: 125, energy: 0.8, valence: 0.2, danceability: 0.6,
    acousticness: 0.1, instrumentalness: 0, speechiness: 0.05, liveness: 0.3
  });

  assert.ok(point);
  assert.equal(point.values.length, ACOUSTIC_DIMENSION_COUNT);
  assert.equal(point.values[0], 0.5);
  assert.ok(point.known.every(Boolean));
});

test('AcousticVector: partial features keep unknown dimensions at the prior and flagged', () => {
  const point = toAcousticPoint({ bpm: 200 });

  assert.ok(point);
  assert.equal(point.values[0], 1);
  assert.equal(point.known[0], true);
  assert.equal(point.values[1], POPULATION_MEAN[1]);
  assert.equal(point.known[1], false);
});

test('AcousticVector: no usable feature yields no point', () => {
  assert.equal(toAcousticPoint(undefined), null);
  assert.equal(toAcousticPoint({ source: 'x' }), null);
  assert.equal(toAcousticPoint({ energy: Number.NaN }), null);
});

test('AcousticVector: out of range tempo and values are clamped', () => {
  const point = toAcousticPoint({ bpm: 400, energy: 7 });
  assert.ok(point);
  assert.equal(point.values[0], 1);
  assert.equal(point.values[1], 1);
});

test('cosineSimilarity: reference values and the zero vector', () => {
  assert.ok(Math.abs(cosineSimilarity([1, 0], [1, 0]) - 1) < 1e-12);
  assert.ok(Math.abs(cosineSimilarity([1, 0], [0, 1])) < 1e-12);
  assert.ok(Math.abs(cosineSimilarity([1, 0], [-1, 0]) + 1) < 1e-12);
  assert.equal(cosineSimilarity([0, 0], [1, 1]), 0);
});

test('acousticSimilarity: discriminates where the raw cosine cannot', () => {
  // All-positive vectors always point the same way: opposite tracks still look similar to a raw cosine
  assert.ok(cosineSimilarity(metal, ambient) > 0.25);

  assert.ok(acousticSimilarity(metal, hardRock) > 0.9);
  assert.ok(acousticSimilarity(metal, ambient) < 0);
});

test('acousticSimilarity: the population mean has no direction', () => {
  assert.equal(acousticSimilarity([...POPULATION_MEAN], metal), 0);
});

test('similarityMatrix: square, symmetric, unit diagonal and bounded', () => {
  const matrix = similarityMatrix([metal, hardRock, ambient]);

  assert.equal(matrix.length, 3);
  for (let i = 0; i < 3; i++) {
    assert.equal(matrix[i].length, 3);
    assert.ok(Math.abs(matrix[i][i] - 1) < 1e-9);
    for (let j = 0; j < 3; j++) {
      assert.equal(matrix[i][j], matrix[j][i]);
      assert.ok(matrix[i][j] >= -1 && matrix[i][j] <= 1);
    }
  }

  assert.ok(matrix[0][1] > matrix[0][2]);
});

test('similarityMatrix: empty input and a 500-track catalog', () => {
  assert.deepEqual(similarityMatrix([]), []);

  const catalog = Array.from({ length: 500 }, (_, i) =>
    Array.from({ length: ACOUSTIC_DIMENSION_COUNT }, (_, d) => ((i + 1) * (d + 3) * 37 % 100) / 100)
  );
  const matrix = similarityMatrix(catalog);
  assert.equal(matrix.length, 500);
  assert.ok(matrix.every((row) => row.every((value) => Number.isFinite(value))));
});

test('invertMatrix: A times its inverse is the identity', () => {
  const a = [
    [4, 1, 0.5],
    [1, 3, 0.2],
    [0.5, 0.2, 2]
  ];
  const inverse = invertMatrix(a);

  for (let i = 0; i < 3; i++) {
    const column = inverse.map((row) => row[i]);
    const product = matrixVector(a, column);
    for (let j = 0; j < 3; j++) {
      assert.ok(Math.abs(product[j] - (i === j ? 1 : 0)) < 1e-10);
    }
  }
});

test('invertMatrix: pivots around a zero and rejects singular matrices', () => {
  assert.deepEqual(invertMatrix([[0, 1], [1, 0]]), [[0, 1], [1, 0]]);
  assert.throws(() => invertMatrix([[1, 2], [2, 4]]), /Singular/);
});

test('identityMatrix and dot', () => {
  assert.deepEqual(identityMatrix(2, 3), [[3, 0], [0, 3]]);
  assert.equal(dot([1, 2, 3], [4, 5, 6]), 32);
});
