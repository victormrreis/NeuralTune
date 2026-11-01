/**
 * Riemannian geometry of the Poincaré ball B^d with curvature -1:
 * metric g_x = λ_x² I, conformal factor λ_x = 2 / (1 - ‖x‖²).
 */

/** Keeps 1 - ‖x‖² representable: the metric diverges at the boundary. */
export const MAX_NORM = 1 - 1e-5;

const EPSILON = 1e-12;

export type BallPoint = number[];

function dot(a: readonly number[], b: readonly number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}

function scale(v: readonly number[], factor: number): number[] {
  return v.map((value) => value * factor);
}

export function squaredNorm(v: readonly number[]): number {
  return dot(v, v);
}

export function conformalFactor(x: readonly number[]): number {
  return 2 / (1 - squaredNorm(x));
}

/** Nearest point inside the ball of radius MAX_NORM. */
export function projectToBall(x: readonly number[]): BallPoint {
  const norm = Math.sqrt(squaredNorm(x));
  return norm <= MAX_NORM ? [...x] : scale(x, MAX_NORM / norm);
}

/** d(u, v) = arcosh(1 + 2‖u - v‖² / ((1 - ‖u‖²)(1 - ‖v‖²))) */
export function poincareDistance(u: readonly number[], v: readonly number[]): number {
  let squaredGap = 0;
  for (let i = 0; i < u.length; i++) squaredGap += (u[i] - v[i]) ** 2;

  const denominator = (1 - squaredNorm(u)) * (1 - squaredNorm(v));
  return Math.acosh(1 + (2 * squaredGap) / denominator);
}

/** Möbius addition x ⊕ y, the gyrogroup operation that plays the role of + in the ball. */
export function mobiusAdd(x: readonly number[], y: readonly number[]): BallPoint {
  const xy = dot(x, y);
  const xx = squaredNorm(x);
  const yy = squaredNorm(y);
  const denominator = 1 + 2 * xy + xx * yy;

  return x.map((value, i) => ((1 + 2 * xy + yy) * value + (1 - xx) * y[i]) / denominator);
}

/** exp_u(v) = u ⊕ (tanh(λ_u ‖v‖ / 2) · v / ‖v‖), with v a Euclidean tangent vector at u. */
export function expMap(u: readonly number[], v: readonly number[]): BallPoint {
  const norm = Math.sqrt(squaredNorm(v));
  if (norm < EPSILON) return [...u];

  const step = scale(v, Math.tanh((conformalFactor(u) * norm) / 2) / norm);
  return projectToBall(mobiusAdd(u, step));
}

/** log_u(v) = (2 / λ_u) · artanh(‖-u ⊕ v‖) · (-u ⊕ v) / ‖-u ⊕ v‖, the inverse of expMap. */
export function logMap(u: readonly number[], v: readonly number[]): number[] {
  const difference = mobiusAdd(scale(u, -1), v);
  const norm = Math.sqrt(squaredNorm(difference));
  if (norm < EPSILON) return u.map(() => 0);

  return scale(difference, ((2 / conformalFactor(u)) * Math.atanh(norm)) / norm);
}

/**
 * ∂d(u, v)/∂u in Euclidean coordinates. With α = 1 + 2‖u - v‖² / ((1 - ‖u‖²)(1 - ‖v‖²)) and
 * d = arcosh α, the chain rule gives ∇_E d = ∇_u α / √(α² - 1). Zero at u = v, where d is not smooth.
 */
export function euclideanDistanceGradient(u: readonly number[], v: readonly number[]): number[] {
  const uu = 1 - squaredNorm(u);
  const vv = 1 - squaredNorm(v);
  let squaredGap = 0;
  for (let i = 0; i < u.length; i++) squaredGap += (u[i] - v[i]) ** 2;

  const alpha = 1 + (2 * squaredGap) / (uu * vv);
  const root = Math.sqrt(alpha * alpha - 1);
  if (root < EPSILON) return u.map(() => 0);

  return u.map((value, i) => {
    const partial = (4 * (value - v[i])) / (uu * vv) + (4 * squaredGap * value) / (uu * uu * vv);
    return partial / root;
  });
}

/** ∇_R = g_u⁻¹ ∇_E = ((1 - ‖u‖²)² / 4) ∇_E */
export function riemannianGradient(u: readonly number[], euclideanGradient: readonly number[]): number[] {
  return scale(euclideanGradient, (1 - squaredNorm(u)) ** 2 / 4);
}

/** Maps a tangent vector at the origin into the ball: exp_0(v) = tanh(‖v‖) · v / ‖v‖ */
export function embedFromOrigin(tangent: readonly number[]): BallPoint {
  return expMap(tangent.map(() => 0), tangent);
}

/**
 * Gyromidpoint: the hyperbolic mean, with m = ½ ⊗ (Σ λ_i x_i / Σ (λ_i - 1)). Used as an artist's
 * position, the parent of its tracks in the tree.
 */
export function gyroMidpoint(points: ReadonlyArray<readonly number[]>): BallPoint {
  if (points.length === 0) throw new Error('gyroMidpoint needs at least one point');

  const size = points[0].length;
  const numerator = new Array<number>(size).fill(0);
  let denominator = 0;

  for (const point of points) {
    const lambda = conformalFactor(point);
    denominator += lambda - 1;
    for (let i = 0; i < size; i++) numerator[i] += lambda * point[i];
  }

  const klein = scale(numerator, 1 / denominator);
  const norm = Math.sqrt(squaredNorm(klein));
  if (norm < EPSILON) return klein;

  // ½ ⊗ x = tanh(½ artanh ‖x‖) · x / ‖x‖
  return projectToBall(scale(klein, Math.tanh(Math.atanh(Math.min(norm, MAX_NORM)) / 2) / norm));
}

export interface PoincareConfig {
  dimension: number;
  learningRate: number;
  repulsionRange: number;
}

const DEFAULT_CONFIG: PoincareConfig = { dimension: 8, learningRate: 0.25, repulsionRange: 2 };

export class PoincareEmbeddingSpace {
  private config: PoincareConfig;
  private user: BallPoint;

  constructor(config: Partial<PoincareConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.user = new Array<number>(this.config.dimension).fill(0);
  }

  getUser(): BallPoint {
    return [...this.user];
  }

  reset(): void {
    this.user = new Array<number>(this.config.dimension).fill(0);
  }

  /**
   * u ← exp_u(-η · sign(r - 3) · ∇_R d(u, v)). η grows with |r - 3|, so 5★ pulls harder than 4★. For
   * r < 3 it also fades with distance: the geodesic gradient has unit length everywhere, so without
   * this a disliked track on a far branch would push the profile as hard as a neighbor would.
   */
  update(track: readonly number[], rating: number): void {
    const direction = Math.sign(rating - 3);
    if (direction === 0) return;

    const distance = poincareDistance(this.user, track);
    const reach = direction < 0 ? Math.exp(-distance / this.config.repulsionRange) : 1;
    const eta = this.config.learningRate * (Math.abs(rating - 3) / 2) * reach;

    // Moving past the track on attraction would oscillate around it
    const step = direction > 0 ? Math.min(eta, distance) : eta;

    const gradient = riemannianGradient(this.user, euclideanDistanceGradient(this.user, track));
    this.user = expMap(this.user, scale(gradient, -direction * step));
  }

  /** Geodesic affinity in (0, 1]: 1 on the user's point, decaying exponentially with distance. */
  affinity(track: readonly number[]): number {
    return Math.exp(-poincareDistance(this.user, track) / 2);
  }
}
