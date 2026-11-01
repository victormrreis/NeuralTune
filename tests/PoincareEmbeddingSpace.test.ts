import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_NORM,
  PoincareEmbeddingSpace,
  conformalFactor,
  embedFromOrigin,
  euclideanDistanceGradient,
  expMap,
  gyroMidpoint,
  logMap,
  mobiusAdd,
  poincareDistance,
  projectToBall,
  riemannianGradient,
  squaredNorm
} from '../src/math/PoincareEmbeddingSpace.ts';

const TOLERANCE = 1e-5;

function close(actual: number, expected: number, tolerance: number = TOLERANCE, label: string = ''): void {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${label} ${actual} != ${expected}`);
}

function closeVector(actual: readonly number[], expected: readonly number[], tolerance: number = TOLERANCE): void {
  assert.equal(actual.length, expected.length);
  actual.forEach((value, i) => close(value, expected[i], tolerance, `[${i}]`));
}

function randomPoints(count: number, dimension: number, seed: number = 7): number[][] {
  let state = seed;
  const next = () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };

  return Array.from({ length: count }, () => {
    const raw = Array.from({ length: dimension }, () => next() - 0.5);
    const norm = Math.sqrt(squaredNorm(raw));
    return raw.map((value) => (value / norm) * next() * 0.9);
  });
}

test('Distance: closed form on the axis, d(0, x) = 2 artanh ‖x‖', () => {
  for (const r of [0.1, 0.5, 0.9, 0.99]) {
    close(poincareDistance([0, 0], [r, 0]), 2 * Math.atanh(r));
  }
});

test('Distance: d(0, tanh(t/2)) = t, the unit-speed geodesic through the origin', () => {
  for (const t of [0.5, 1, 2.5, 5]) {
    close(poincareDistance([0, 0, 0], [Math.tanh(t / 2), 0, 0]), t);
  }
});

test('Distance: a metric on B^8', () => {
  const points = randomPoints(30, 8);

  for (const u of points) {
    close(poincareDistance(u, u), 0);
    for (const v of points) {
      close(poincareDistance(u, v), poincareDistance(v, u), 1e-9);
      for (const w of points.slice(0, 6)) {
        assert.ok(poincareDistance(u, w) <= poincareDistance(u, v) + poincareDistance(v, w) + TOLERANCE);
      }
    }
  }
});

test('Distance: invariant under Möbius translation, the isometries of the ball', () => {
  const [u, v, a] = randomPoints(3, 8, 11);
  close(poincareDistance(mobiusAdd(a, u), mobiusAdd(a, v)), poincareDistance(u, v), 1e-8);
});

test('Distance: the same Euclidean gap is far longer near the boundary', () => {
  assert.ok(poincareDistance([0.95, 0], [0.99, 0]) > 5 * poincareDistance([0, 0], [0.04, 0]));
});

test('Möbius: identity and left inverse', () => {
  const [u] = randomPoints(1, 8);
  closeVector(mobiusAdd(new Array(8).fill(0), u), u);
  closeVector(mobiusAdd(u, new Array(8).fill(0)), u);
  closeVector(mobiusAdd(u.map((x) => -x), u), new Array(8).fill(0));
});

test('Exponential and logarithm are mutually inverse', () => {
  const points = randomPoints(20, 8, 3);
  for (let i = 0; i + 1 < points.length; i++) {
    const [u, v] = [points[i], points[i + 1]];
    closeVector(expMap(u, logMap(u, v)), v, 1e-7);
  }
});

test('Logarithm: its Riemannian length is the geodesic distance', () => {
  const points = randomPoints(20, 8, 5);
  for (let i = 0; i + 1 < points.length; i++) {
    const [u, v] = [points[i], points[i + 1]];
    const length = conformalFactor(u) * Math.sqrt(squaredNorm(logMap(u, v)));
    close(length, poincareDistance(u, v), 1e-7);
  }
});

test('Exponential: exp_u(0) = u and the result stays in the open ball', () => {
  const [u] = randomPoints(1, 8);
  closeVector(expMap(u, new Array(8).fill(0)), u);

  const huge = expMap(u, new Array(8).fill(1000));
  assert.ok(Math.sqrt(squaredNorm(huge)) < 1);
});

test('Euclidean gradient matches central finite differences', () => {
  const [u, v] = randomPoints(2, 8, 13);
  const gradient = euclideanDistanceGradient(u, v);
  const h = 1e-6;

  u.forEach((_, i) => {
    const plus = [...u];
    const minus = [...u];
    plus[i] += h;
    minus[i] -= h;
    close(gradient[i], (poincareDistance(plus, v) - poincareDistance(minus, v)) / (2 * h), 1e-5, `∂${i}`);
  });
});

test('Riemannian gradient: unit length under the metric, as for any distance function', () => {
  const points = randomPoints(20, 8, 17);
  for (let i = 0; i + 1 < points.length; i++) {
    const [u, v] = [points[i], points[i + 1]];
    const gradient = riemannianGradient(u, euclideanDistanceGradient(u, v));
    close(conformalFactor(u) * Math.sqrt(squaredNorm(gradient)), 1, 1e-7);
  }
});

test('Riemannian gradient: points straight away from v along the geodesic', () => {
  const [u, v] = randomPoints(2, 8, 19);
  const gradient = riemannianGradient(u, euclideanDistanceGradient(u, v));
  const towards = logMap(u, v);
  const scale = -poincareDistance(u, v);

  closeVector(gradient.map((x) => x * scale), towards, 1e-7);
});

test('Geodesic step: moving t against the gradient shortens the distance by exactly t', () => {
  const [u, v] = randomPoints(2, 8, 23);
  const gradient = riemannianGradient(u, euclideanDistanceGradient(u, v));
  const distance = poincareDistance(u, v);

  for (const t of [0.05, 0.2, distance / 2]) {
    const moved = expMap(u, gradient.map((x) => -x * t));
    close(poincareDistance(moved, v), distance - t, 1e-7);
  }
});

test('Gradient: zero at u = v instead of dividing by zero', () => {
  const [u] = randomPoints(1, 8);
  assert.ok(euclideanDistanceGradient(u, u).every((x) => x === 0));
});

test('Embedding from the origin: exp_0(v) = tanh(‖v‖) v/‖v‖', () => {
  const norm = 0.8;
  closeVector(embedFromOrigin([norm, 0]), [Math.tanh(norm), 0]);
  close(poincareDistance([0, 0], embedFromOrigin([norm, 0])), 2 * norm);
});

test('Projection: leaves interior points alone and clamps the boundary', () => {
  closeVector(projectToBall([0.3, 0.4]), [0.3, 0.4]);
  close(Math.sqrt(squaredNorm(projectToBall([3, 4]))), MAX_NORM);
});

test('Gyromidpoint: the geodesic midpoint of two points', () => {
  const [u, v] = randomPoints(2, 8, 29);
  const m = gyroMidpoint([u, v]);
  const half = poincareDistance(u, v) / 2;

  close(poincareDistance(u, m), half, 1e-7);
  close(poincareDistance(v, m), half, 1e-7);
});

test('Gyromidpoint: of one point, of opposite points, and of nothing', () => {
  const [u] = randomPoints(1, 8);
  closeVector(gyroMidpoint([u]), u, 1e-7);
  closeVector(gyroMidpoint([[0.5, 0], [-0.5, 0]]), [0, 0]);
  assert.throws(() => gyroMidpoint([]));
});

test('Space: 5★ pulls the user towards the track, 0★ pushes away, 3★ does nothing', () => {
  const track = [0.5, 0.2, 0, 0, 0, 0, 0, 0];

  const liked = new PoincareEmbeddingSpace();
  const start = poincareDistance(liked.getUser(), track);
  liked.update(track, 5);
  assert.ok(poincareDistance(liked.getUser(), track) < start);

  const hated = new PoincareEmbeddingSpace();
  hated.update(track, 0);
  assert.ok(poincareDistance(hated.getUser(), track) > start);

  const neutral = new PoincareEmbeddingSpace();
  neutral.update(track, 3);
  assert.deepEqual(neutral.getUser(), new Array(8).fill(0));
});

test('Space: the step follows the rule with η scaled by |r - 3|', () => {
  const track = [0.6, 0, 0, 0, 0, 0, 0, 0];
  const five = new PoincareEmbeddingSpace({ learningRate: 0.2 });
  const four = new PoincareEmbeddingSpace({ learningRate: 0.2 });
  const start = poincareDistance(five.getUser(), track);

  five.update(track, 5);
  four.update(track, 4);

  close(start - poincareDistance(five.getUser(), track), 0.2);
  close(start - poincareDistance(four.getUser(), track), 0.1);
});

test('Space: repulsion fades with distance, so a far branch is left undisturbed', () => {
  const near = [0.1, 0, 0, 0, 0, 0, 0, 0];
  const far = [0.99, 0, 0, 0, 0, 0, 0, 0];

  const a = new PoincareEmbeddingSpace();
  a.update(near, 0);
  const b = new PoincareEmbeddingSpace();
  b.update(far, 0);

  const moved = (space: PoincareEmbeddingSpace) => poincareDistance(space.getUser(), new Array(8).fill(0));
  assert.ok(moved(a) > 5 * moved(b));
});

test('Space: repeated 5★ converges on the track without overshoot, 500 ratings stay inside', () => {
  const track = [0.3, -0.2, 0.1, 0, 0, 0, 0, 0];
  const space = new PoincareEmbeddingSpace();

  for (let i = 0; i < 500; i++) space.update(track, 5);

  close(poincareDistance(space.getUser(), track), 0, 1e-6);

  const repelled = new PoincareEmbeddingSpace();
  for (let i = 0; i < 500; i++) repelled.update(track, 0);
  assert.ok(Math.sqrt(squaredNorm(repelled.getUser())) < 1);
  assert.ok(repelled.getUser().every(Number.isFinite));
});

test('Space: affinity is 1 on the user point and decays geodesically', () => {
  const space = new PoincareEmbeddingSpace();
  close(space.affinity(new Array(8).fill(0)), 1);

  const distance = 2;
  const point = [Math.tanh(distance / 2), 0, 0, 0, 0, 0, 0, 0];
  close(space.affinity(point), Math.exp(-1));
});
