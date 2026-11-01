import { camelotCost } from '../math/Camelot.ts';
import { SolverResult, SolverTrack } from './HarmonicQueueSolver.ts';
import { TrackMorphology, seamCost } from '../core/SegmentMorphologyEngine.ts';
import { rhythmicCompatibility, RhythmProfile } from '../neuroscience/RhythmDynamicsEngine.ts';

export interface TrajectoryTrack<T = unknown> extends SolverTrack<T> {
  vector?: readonly number[]; // Standardized acoustic position, for diversity and timbral continuity
  morphology?: TrackMorphology;
  rhythm?: Pick<RhythmProfile, 'pattern'>;
}
export const TrajectoryTrack = {};

export interface TrajectoryOptions {
  length: number;
  artistWindow: number;
  lambdaScore: number;
  lambdaTransition: number;
  lambdaDiversity: number;
  bpmTolerance: number;
  energyTolerance: number;
  neighbors: number;
  relaxSpacing: boolean; // Shrinks the artist window only when no artist left fits it
}
export const TrajectoryOptions = {};

const DEFAULT_OPTIONS: TrajectoryOptions = {
  length: 30,
  artistWindow: 4,
  lambdaScore: 1,
  lambdaTransition: 0.6,
  lambdaDiversity: 0.05,
  bpmTolerance: 0.12,
  energyTolerance: 0.35,
  neighbors: 10,
  relaxSpacing: false
};

const KERNEL_WIDTH = 2;
const SAME_ARTIST_SIMILARITY = 0.9;
const NEUTRAL_SIMILARITY = 0.3;
const DIAGONAL_JITTER = 1e-6;

// Floor of the share of a track not explained by those chosen. Below it the track is a duplicate, and
// how exact a duplicate must not outweigh its score
const MIN_NOVELTY = 0.02;
const OVER_LIMIT_COST = 1;
const SEAM_WEIGHT = 0.15;
const RHYTHM_WEIGHT = 0.3;
const CLASH_COST = 0.8;
const UNKNOWN_KEY_COST = 0.1;

/** Smallest relative tempo change, with 2:1 and 1:2 counted as the same pulse. */
export function tempoDrift(from: number, to: number): number {
  return Math.min(...[to, to * 2, to / 2].map((candidate) => Math.abs(candidate - from) / from));
}

export function softTransitionCost<T>(
  a: TrajectoryTrack<T>,
  b: TrajectoryTrack<T>,
  options: Partial<TrajectoryOptions> = {}
): number {
  const o = { ...DEFAULT_OPTIONS, ...options };
  let cost = 0;

  if (a.bpm && b.bpm) {
    const drift = tempoDrift(a.bpm, b.bpm);
    cost += drift > o.bpmTolerance ? OVER_LIMIT_COST + drift : drift;
  }

  if (a.camelot && b.camelot) {
    const harmonic = camelotCost(a.camelot, b.camelot);
    cost += Number.isFinite(harmonic) ? harmonic : CLASH_COST;
  } else {
    cost += UNKNOWN_KEY_COST;
  }

  if (a.energy !== undefined && b.energy !== undefined) {
    const jump = Math.abs(a.energy - b.energy);
    cost += jump > o.energyTolerance ? OVER_LIMIT_COST + jump : 0.5 * jump;
  }

  // Where the real ends of both tracks are known, they replace the track-level proxies above
  if (a.morphology && b.morphology) cost = SEAM_WEIGHT * seamCost(a.morphology, b.morphology);

  if (a.rhythm && b.rhythm && a.bpm && b.bpm) {
    cost += RHYTHM_WEIGHT * (1 - rhythmicCompatibility({ ...a.rhythm, bpm: a.bpm } as RhythmProfile, { ...b.rhythm, bpm: b.bpm } as RhythmProfile));
  }

  return cost;
}

function rawSimilarity<T>(a: TrajectoryTrack<T>, b: TrajectoryTrack<T>): number {
  if (a.artistIds.some((id) => b.artistIds.includes(id))) return SAME_ARTIST_SIMILARITY;
  if (!a.vector || !b.vector) return NEUTRAL_SIMILARITY;

  let squared = 0;
  for (let i = 0; i < a.vector.length; i++) squared += (a.vector[i] - b.vector[i]) ** 2;
  return Math.exp(-squared / a.vector.length / KERNEL_WIDTH);
}

/**
 * Ŝ(x, y) = S(x, y) / √(S̄_k(x) · S̄_k(y)), Schnitzer's local scaling: a hub, close to everything, has
 * a high S̄_k and loses part of that advantage. Part only: with a uniform hub at similarity h, overtaking
 * it would need a neighbor above h, so this softens hubs and mutualProximity removes them.
 */
export function localScaling(similarity: readonly Float64Array[], neighbors: number): Float64Array[] {
  const size = similarity.length;
  const meanOfNearest = similarity.map((row, i) => {
    const others = Array.from(row).filter((_, j) => j !== i).sort((a, b) => b - a).slice(0, neighbors);
    return others.length > 0 ? others.reduce((sum, value) => sum + value, 0) / others.length : 1;
  });

  const scaled = similarity.map((row, i) => row.map((value, j) => {
    return i === j ? 1 : value / Math.sqrt(meanOfNearest[i] * meanOfNearest[j] || 1);
  }));

  let peak = 1;
  for (let i = 0; i < size; i++) {
    for (let j = 0; j < size; j++) {
      if (i !== j && scaled[i][j] > peak) peak = scaled[i][j];
    }
  }

  return scaled.map((row, i) => row.map((value, j) => (i === j ? 1 : value / peak)));
}

/**
 * Empirical Mutual Proximity: MP(x, y) = P(S < s_xy | x) · P(S < s_xy | y), the chance that each is, by
 * its own standards, a near neighbor of the other. A hub is close to everyone and so special to nobody:
 * it ranks high in others' lists but they rank at the middle of its own, and the product falls.
 */
export function mutualProximity(similarity: readonly Float64Array[]): Float64Array[] {
  const size = similarity.length;
  if (size < 3) return similarity.map((row) => Float64Array.from(row));

  const sorted = similarity.map((row, i) => Array.from(row).filter((_, j) => j !== i).sort((a, b) => a - b));

  const rankOf = (values: readonly number[], value: number): number => {
    let below = 0;
    let notAbove = 0;
    for (let low = 0, high = values.length; low < high;) {
      const middle = (low + high) >> 1;
      if (values[middle] < value) low = below = middle + 1;
      else high = middle;
    }
    for (let low = 0, high = values.length; low < high;) {
      const middle = (low + high) >> 1;
      if (values[middle] <= value) low = notAbove = middle + 1;
      else high = middle;
    }
    return (below + notAbove) / 2 / values.length; // Ties count half
  };

  return similarity.map((row, i) => row.map((value, j) => {
    return i === j ? 1 : rankOf(sorted[i], value) * rankOf(sorted[j], similarity[j][i]);
  }));
}

/**
 * Greedy order maximizing λ₁ Score - λ₂ TransitionCost + λ₃ log det(L). The marginal log det comes from
 * the fast greedy MAP of Chen et al. (2018): an incremental Cholesky costs O(K·N) per step, against
 * O(K·N³) for computing determinants. Each new track pays for what it repeats of those already chosen.
 */
export function solveTrajectory<T>(
  pool: ReadonlyArray<TrajectoryTrack<T>>,
  options: Partial<TrajectoryOptions> = {}
): SolverResult<T> {
  const o = { ...DEFAULT_OPTIONS, ...options };
  const size = pool.length;
  const target = Math.min(o.length, size);

  const empty: SolverResult<T> = {
    tracks: [], objective: 0, harmonicTransitions: 0, unknownTransitions: 0, relaxedTransitions: 0
  };
  if (target === 0) return empty;

  const raw = pool.map((a) => Float64Array.from(pool, (b) => (a === b ? 1 : rawSimilarity(a, b))));
  const similarity = mutualProximity(localScaling(raw, o.neighbors));
  const quality = pool.map((track) => Math.exp(track.score));

  const residual = Float64Array.from(pool, (_, i) => quality[i] * quality[i] * (1 + DIAGONAL_JITTER));
  const factors: Float64Array[] = [];
  const remaining = new Set(pool.map((_, i) => i));
  const chosen: number[] = [];
  let objective = 0;

  while (chosen.length < target) {
    const tail = chosen.length > 0 ? pool[chosen[chosen.length - 1]] : null;

    let best = -1;
    let bestValue = Number.NEGATIVE_INFINITY;
    let bestCost = 0;

    for (let spacing = o.artistWindow - 1; best < 0 && spacing >= (o.relaxSpacing ? 0 : o.artistWindow - 1); spacing--) {
      const recent = spacing > 0 ? chosen.slice(-spacing).map((i) => pool[i]) : [];

      for (const candidate of remaining) {
        const track = pool[candidate];
        if (recent.some((other) => other.artistIds.some((id) => track.artistIds.includes(id)))) continue;

        const cost = tail ? softTransitionCost(tail, track, o) : 0;
        const value = o.lambdaScore * track.score
          - o.lambdaTransition * cost
          + o.lambdaDiversity * Math.log(Math.max(residual[candidate] / (quality[candidate] * quality[candidate]), MIN_NOVELTY));

        if (value > bestValue) {
          best = candidate;
          bestValue = value;
          bestCost = cost;
        }
      }
    }

    if (best < 0) break; // Strict mode: artist spacing is not relaxed

    const factor = new Float64Array(size);
    const pivot = Math.sqrt(Math.max(residual[best], 1e-12));
    for (const candidate of remaining) {
      let projection = quality[best] * similarity[best][candidate] * quality[candidate];
      for (const previous of factors) projection -= previous[best] * previous[candidate];
      factor[candidate] = projection / pivot;
      residual[candidate] -= factor[candidate] * factor[candidate];
    }

    factors.push(factor);
    remaining.delete(best);
    chosen.push(best);
    objective += pool[best].score - bestCost;
  }

  const tracks = chosen.map((i) => pool[i]);
  let harmonicTransitions = 0;
  let unknownTransitions = 0;
  let relaxedTransitions = 0;

  for (let i = 1; i < tracks.length; i++) {
    const [a, b] = [tracks[i - 1], tracks[i]];
    if (!a.camelot || !b.camelot) unknownTransitions++;
    else if (Number.isFinite(camelotCost(a.camelot, b.camelot))) harmonicTransitions++;
    else relaxedTransitions++;
  }

  return { tracks, objective, harmonicTransitions, unknownTransitions, relaxedTransitions };
}
