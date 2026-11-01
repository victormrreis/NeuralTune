export interface CalibrationItem<T = unknown> {
  id: string;
  score: number;      // In [0, 1]
  cluster: number;
  payload: T;
}
export const CalibrationItem = {};

const SMOOTHING = 0.01;

export function normalizeDistribution(weights: ReadonlyMap<number, number>): Map<number, number> {
  const total = Array.from(weights.values()).reduce((sum, value) => sum + Math.max(0, value), 0);
  return new Map(Array.from(weights, ([key, value]) => [key, total > 0 ? Math.max(0, value) / total : 0]));
}

/** D_KL(P ‖ Q̃), with Q̃ = (1 - ε)Q + εP (Steck, 2018), which keeps it finite when Q misses a class. */
export function calibrationDivergence(
  target: ReadonlyMap<number, number>,
  counts: ReadonlyMap<number, number>,
  total: number,
  epsilon: number = SMOOTHING
): number {
  let divergence = 0;
  for (const [cluster, p] of target) {
    if (p <= 0) continue;
    const q = total > 0 ? (counts.get(cluster) ?? 0) / total : 0;
    divergence += p * Math.log(p / ((1 - epsilon) * q + epsilon * p));
  }
  return divergence;
}

/**
 * Greedy Utility(x | S) = (1 - λ) Score(x) - λ ΔD_KL. Steck's objective is submodular, which gives the
 * greedy order its (1 - 1/e) guarantee there; this signed variant keeps the procedure, not the proof.
 */
export function rerankCalibrated<T>(
  items: ReadonlyArray<CalibrationItem<T>>,
  target: ReadonlyMap<number, number>,
  length: number,
  lambda: number = 0.5
): Array<CalibrationItem<T>> {
  const remaining = [...items];
  const chosen: Array<CalibrationItem<T>> = [];
  const counts = new Map<number, number>();
  let divergence = calibrationDivergence(target, counts, 0);

  while (chosen.length < length && remaining.length > 0) {
    let bestIndex = 0;
    let bestUtility = Number.NEGATIVE_INFINITY;
    let bestDivergence = divergence;

    remaining.forEach((item, index) => {
      counts.set(item.cluster, (counts.get(item.cluster) ?? 0) + 1);
      const next = calibrationDivergence(target, counts, chosen.length + 1);
      counts.set(item.cluster, counts.get(item.cluster)! - 1);

      const utility = (1 - lambda) * item.score - lambda * (next - divergence);
      if (utility > bestUtility) {
        bestUtility = utility;
        bestIndex = index;
        bestDivergence = next;
      }
    });

    const [item] = remaining.splice(bestIndex, 1);
    counts.set(item.cluster, (counts.get(item.cluster) ?? 0) + 1);
    chosen.push(item);
    divergence = bestDivergence;
  }

  return chosen;
}

export interface ExposureEstimate {
  propensity: number | null;
  reason: string;
}
export const ExposureEstimate = {};

/**
 * w_IPS = 1 / max(0.1, π̂). The client exposes no log of what was recommended and shown but not chosen,
 * so a defensible π̂ exists only for tracks NeuralTune itself queued, with the probability it drew them
 * with. Anything else returns weight 1 and leaves the bias in place, stated rather than hidden.
 */
export function ipsWeight(estimate: ExposureEstimate): number {
  return estimate.propensity === null ? 1 : 1 / Math.max(0.1, estimate.propensity);
}
