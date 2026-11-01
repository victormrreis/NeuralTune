import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  camelotAdjacencyMatrix,
  camelotCost,
  formatCamelot,
  isCamelotCompatible,
  parseCamelot,
  toCamelot
} from '../src/math/Camelot.ts';
import { SolverOptions, SolverTrack, solveHarmonicQueue, transitionCost } from '../src/queue/HarmonicQueueSolver.ts';

const key = (text: string) => parseCamelot(text)!;

function solverTrack(id: string, camelot: string | null, score: number, extra: Partial<SolverTrack<null>> = {}): SolverTrack<null> {
  return {
    id,
    artistIds: [`artist-${id}`],
    score,
    camelot: camelot ? key(camelot) : undefined,
    payload: null,
    ...extra
  };
}

test('Camelot: reference positions of the wheel', () => {
  const reference: Array<[number, number, string]> = [
    [0, 1, '8B'], [9, 0, '8A'], [7, 1, '9B'], [4, 0, '9A'], [5, 1, '7B'], [2, 0, '7A'],
    [2, 1, '10B'], [11, 0, '10A'], [6, 1, '2B'], [3, 0, '2A'], [1, 1, '3B'], [10, 0, '3A'],
    [11, 1, '1B'], [8, 0, '1A'], [4, 1, '12B'], [1, 0, '12A']
  ];

  for (const [pitchClass, mode, expected] of reference) {
    assert.equal(formatCamelot(toCamelot(pitchClass, mode)), expected);
  }
});

test('Camelot: the 24 keys map one-to-one onto the wheel', () => {
  const seen = new Set<string>();
  for (let pitchClass = 0; pitchClass < 12; pitchClass++) {
    for (const mode of [0, 1]) seen.add(formatCamelot(toCamelot(pitchClass, mode)));
  }
  assert.equal(seen.size, 24);
});

test('Camelot: a step on the wheel is a perfect fifth', () => {
  for (let pitchClass = 0; pitchClass < 12; pitchClass++) {
    const here = toCamelot(pitchClass, 1).number;
    const fifth = toCamelot((pitchClass + 7) % 12, 1).number;
    assert.equal((here % 12) + 1, fifth);
  }
});

test('Camelot: relative keys share a number', () => {
  for (let pitchClass = 0; pitchClass < 12; pitchClass++) {
    assert.equal(toCamelot(pitchClass, 1).number, toCamelot((pitchClass + 9) % 12, 0).number);
  }
});

test('Camelot: compatibility rule, including the wrap from 12 to 1', () => {
  assert.equal(isCamelotCompatible(key('8A'), key('8A')), true);
  assert.equal(isCamelotCompatible(key('8A'), key('9A')), true);
  assert.equal(isCamelotCompatible(key('8A'), key('7A')), true);
  assert.equal(isCamelotCompatible(key('8A'), key('8B')), true);
  assert.equal(isCamelotCompatible(key('12B'), key('1B')), true);
  assert.equal(isCamelotCompatible(key('1A'), key('12A')), true);

  assert.equal(isCamelotCompatible(key('8A'), key('10A')), false);
  assert.equal(isCamelotCompatible(key('8A'), key('9B')), false);
  assert.equal(isCamelotCompatible(key('8A'), key('2A')), false);
});

test('Camelot: adjacency matrix is symmetric with exactly 4 neighbors per key, self included', () => {
  const matrix = camelotAdjacencyMatrix();

  assert.equal(matrix.length, 24);
  matrix.forEach((row, i) => {
    assert.equal(row.reduce((sum, value) => sum + value, 0), 4);
    assert.equal(row[i], 1);
    row.forEach((value, j) => assert.equal(value, matrix[j][i]));
  });
});

test('Camelot: costs order same key < neighbor < relative, and forbid the rest', () => {
  assert.equal(camelotCost(key('8A'), key('8A')), 0);
  assert.ok(camelotCost(key('8A'), key('9A')) < camelotCost(key('8A'), key('8B')));
  assert.equal(camelotCost(key('8A'), key('3B')), Number.POSITIVE_INFINITY);
});

test('Camelot: parser rejects what is not a position', () => {
  assert.equal(parseCamelot('0A'), null);
  assert.equal(parseCamelot('13B'), null);
  assert.equal(parseCamelot('8C'), null);
  assert.deepEqual(parseCamelot('12B'), { number: 12, letter: 'B' });
});

test('Transition: BPM tolerance is ±8% of the outgoing track', () => {
  const at = (bpm: number) => solverTrack(`t${bpm}`, null, 1, { bpm });

  assert.ok(transitionCost(at(100), at(108)));
  assert.ok(transitionCost(at(100), at(92)));
  assert.equal(transitionCost(at(100), at(108.1)), null);
  assert.equal(transitionCost(at(100), at(91.9)), null);
});

test('Transition: energy continuity is enforced, missing metadata imposes nothing', () => {
  const low = solverTrack('a', null, 1, { energy: 0.2 });
  const high = solverTrack('b', null, 1, { energy: 0.9 });
  const plain = solverTrack('c', null, 1);

  assert.equal(transitionCost(low, high, { energyTolerance: 0.3 }), null);
  assert.ok(transitionCost(low, plain));
  assert.ok(transitionCost(plain, high));
});

test('Transition: relaxation marks and penalizes what the strict rule forbids', () => {
  const a = solverTrack('a', '8A', 1);
  const b = solverTrack('b', '2A', 1);

  assert.equal(transitionCost(a, b), null);
  const relaxed = transitionCost(a, b, { relaxedTransitionCost: 0.6 }, true);
  assert.equal(relaxed?.relaxed, true);
  assert.equal(relaxed?.cost, 0.6);
});

function assertConstraints(
  tracks: Array<SolverTrack<null>>,
  options: { window?: number; bpm?: number; energy?: number } = {}
): void {
  const window = options.window ?? 4;

  tracks.forEach((track, i) => {
    for (let j = 1; j < window && i + j < tracks.length; j++) {
      const other = tracks[i + j];
      assert.ok(!track.artistIds.some((a) => other.artistIds.includes(a)), `artist repeats at ${i},${i + j}`);
    }

    const next = tracks[i + 1];
    if (!next) return;
    if (track.camelot && next.camelot) {
      assert.ok(isCamelotCompatible(track.camelot, next.camelot), `${i}: incompatible keys`);
    }
    if (track.bpm && next.bpm) {
      assert.ok(Math.abs(next.bpm - track.bpm) / track.bpm <= (options.bpm ?? 0.08) + 1e-12, `${i}: bpm`);
    }
    if (track.energy !== undefined && next.energy !== undefined) {
      assert.ok(Math.abs(next.energy - track.energy) <= (options.energy ?? 0.25) + 1e-12, `${i}: energy`);
    }
  });
}

function catalog(size: number, seed: number = 1): Array<SolverTrack<null>> {
  let state = seed;
  const next = () => {
    state = (state * 16807) % 2147483647;
    return state / 2147483647;
  };

  return Array.from({ length: size }, (_, i) => solverTrack(
    `t${i}`,
    `${1 + Math.floor(next() * 12)}${next() < 0.5 ? 'A' : 'B'}`,
    next(),
    {
      artistIds: [`artist${Math.floor(next() * Math.max(6, size / 4))}`],
      bpm: 110 + next() * 30,
      energy: 0.3 + next() * 0.5
    }
  ));
}

test('Solver: every transition of a large queue respects all hard constraints', () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    const result = solveHarmonicQueue(catalog(200, seed), { length: 25 });
    assert.equal(result.tracks.length, 25);
    assert.equal(result.relaxedTransitions, 0);
    assert.equal(result.harmonicTransitions, 24);
    assertConstraints(result.tracks);
  }
});

test('Solver: no track appears twice', () => {
  const { tracks } = solveHarmonicQueue(catalog(120), { length: 40 });
  assert.equal(new Set(tracks.map((t) => t.id)).size, tracks.length);
});

test('Solver: the reported objective is Σs - ΣCost of the returned sequence', () => {
  const { tracks, objective } = solveHarmonicQueue(catalog(100), { length: 12 });

  let expected = tracks[0].score;
  for (let i = 1; i < tracks.length; i++) {
    expected += tracks[i].score - transitionCost(tracks[i - 1], tracks[i])!.cost;
  }

  assert.ok(Math.abs(objective - expected) < 1e-9);
});

test('Solver: lookahead gives up the best first track to reach a better path', () => {
  const bait = solverTrack('bait', '3A', 1.0);
  const a = solverTrack('a', '8A', 0.9);
  const b = solverTrack('b', '9A', 0.9);
  const c = solverTrack('c', '10A', 0.9);

  const { tracks } = solveHarmonicQueue([bait, a, b, c], { length: 3, artistWindow: 1 });

  assert.deepEqual(tracks.map((t) => t.id).sort(), ['a', 'b', 'c']);
});

function bruteForceOptimum(pool: Array<SolverTrack<null>>, length: number, options: Partial<SolverOptions>): number {
  let best = -Infinity;

  const walk = (sequence: Array<SolverTrack<null>>, objective: number) => {
    if (sequence.length === length) {
      best = Math.max(best, objective);
      return;
    }
    for (const candidate of pool) {
      if (sequence.includes(candidate)) continue;
      const window = options.artistWindow ?? 4;
      const recent = sequence.slice(-(window - 1));
      if (recent.some((t) => t.artistIds.some((a) => candidate.artistIds.includes(a)))) continue;

      const tail = sequence[sequence.length - 1];
      const transition = tail ? transitionCost(tail, candidate, options) : { cost: 0 };
      if (transition) walk([...sequence, candidate], objective + candidate.score - transition.cost);
    }
  };

  walk([], 0);
  return best;
}

test('Solver: reaches the brute-force optimum on small instances', () => {
  for (const seed of [11, 12, 13, 14, 15, 16]) {
    const pool = catalog(8, seed);
    const options: Partial<SolverOptions> = { length: 4, beamWidth: 256, energyTolerance: 0.6, bpmTolerance: 0.3 };
    const optimum = bruteForceOptimum(pool, 4, options);
    if (optimum === -Infinity) continue;

    const { objective, tracks, relaxedTransitions } = solveHarmonicQueue(pool, options);
    assert.equal(tracks.length, 4);
    assert.equal(relaxedTransitions, 0);
    assert.ok(Math.abs(objective - optimum) < 1e-9, `seed ${seed}: ${objective} vs ${optimum}`);
  }
});

test('Solver: an artist window of 4 means at least 3 other tracks between repeats', () => {
  const pool = Array.from({ length: 12 }, (_, i) => solverTrack(`t${i}`, '8A', 1, { artistIds: [`artist${i % 4}`] }));
  const { tracks } = solveHarmonicQueue(pool, { length: 12 });

  assert.equal(tracks.length, 12);
  assertConstraints(tracks);
});

test('Solver: featured artists count towards the window', () => {
  const pool = [
    solverTrack('a', '8A', 1, { artistIds: ['x', 'y'] }),
    solverTrack('b', '8A', 1, { artistIds: ['y'] }),
    solverTrack('c', '8A', 1, { artistIds: ['z'] })
  ];
  const { tracks } = solveHarmonicQueue(pool, { length: 3 });
  assert.ok(tracks.length < 3);
});

test('Solver: without key data it degrades to ranking, it does not stop', () => {
  const pool = Array.from({ length: 10 }, (_, i) => solverTrack(`t${i}`, null, 1 - i / 100));
  const result = solveHarmonicQueue(pool, { length: 10 });

  assert.equal(result.tracks.length, 10);
  assert.equal(result.unknownTransitions, 9);
  assert.equal(result.harmonicTransitions, 0);
});

test('Solver: an impossible pool is completed with relaxed, counted transitions', () => {
  const pool = [solverTrack('a', '1A', 1), solverTrack('b', '4A', 1), solverTrack('c', '7A', 1), solverTrack('d', '10A', 1)];
  const result = solveHarmonicQueue(pool, { length: 4 });

  assert.equal(result.tracks.length, 4);
  assert.equal(result.relaxedTransitions, 3);
});

test('Solver: empty pool, single track and a request larger than the pool', () => {
  assert.equal(solveHarmonicQueue([]).tracks.length, 0);
  assert.equal(solveHarmonicQueue([solverTrack('a', '8A', 1)]).tracks.length, 1);
  assert.equal(solveHarmonicQueue(catalog(3), { length: 50, energyTolerance: 1, bpmTolerance: 1 }).tracks.length <= 3, true);
});

test('Solver: 300 candidates and 30 tracks stay fast enough to start a radio', () => {
  const started = performance.now();
  const { tracks } = solveHarmonicQueue(catalog(300), { length: 30 });
  const elapsed = performance.now() - started;

  assert.equal(tracks.length, 30);
  assert.ok(elapsed < 1500, `${elapsed} ms`);
});
