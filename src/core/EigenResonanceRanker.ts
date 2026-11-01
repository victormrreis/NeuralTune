import { PreferenceEngine, RatedSample } from './PreferenceEngine.ts';
import { cosineSimilarity, standardize, toAcousticPoint } from './AcousticVector.ts';
import {
  BoltzmannResult,
  RandomSource,
  ThompsonBanditOptimizer,
  boltzmannDistribution,
  resolveTemperature,
  sampleWithoutReplacement
} from './ThompsonBanditOptimizer.ts';
import { NeuralContextModel } from './NeuralContextModel.ts';
import { rerankCalibrated, normalizeDistribution } from './CalibratedRanker.ts';
import { CamelotKey, parseCamelot, toCamelot } from '../math/Camelot.ts';
import { PoincareEmbeddingSpace, embedFromOrigin, gyroMidpoint } from '../math/PoincareEmbeddingSpace.ts';
import { SolverResult, solveHarmonicQueue } from '../queue/HarmonicQueueSolver.ts';
import { TrajectoryTrack, solveTrajectory } from '../queue/HarmonicTrajectorySolver.ts';
import { AcousticFeatures, PredictionResult, TrackMetadata } from '../types/index.ts';

// Standardized z reaches ±3 in 8 dimensions: this keeps the embedding away from the boundary
const EMBEDDING_SCALE = 0.25;

const WEIGHT_SCORE = 0.5;
const WEIGHT_HYPERBOLIC = 0.25;
const WEIGHT_THOMPSON = 0.25;
const WEIGHT_TARGET = 0.5;
const NEUTRAL = 0.5;

const POOL_FACTOR = 3;
const MIN_POOL = 40;

// Temperature must decide what enters the pool, not only the order of a pool holding everything
const MIN_DRAW_PROBABILITY_RATIO = 1e-3;

const REWARD: Record<number, number> = { 0: -1, 1: -0.6, 2: -0.3, 3: 0, 4: 0.5, 5: 1 };

export interface ComposeContext {
  radio?: string;
  date?: Date;
  length?: number;
  target?: readonly number[] | null;
  temperature?: number;
  strictHarmonic?: boolean;
  carryFeedback?: boolean;
}
export const ComposeContext = {};

export interface ResonanceQueue {
  tracks: TrackMetadata[];
  temperature: number;
  thermodynamics: BoltzmannResult;
  solver: SolverResult<TrackMetadata>;
}
export const ResonanceQueue = {};

function embed(values: readonly number[]): number[] {
  return embedFromOrigin(standardize(values).map((z) => z * EMBEDDING_SCALE));
}

export function camelotOf(features: AcousticFeatures | undefined): CamelotKey | undefined {
  if (!features) return undefined;

  const parsed = features.camelot ? parseCamelot(features.camelot) : null;
  if (parsed) return parsed;

  const { key, mode } = features;
  return typeof key === 'number' && key >= 0 && (mode === 0 || mode === 1) ? toCamelot(key, mode) : undefined;
}

/**
 * Draws and orders a radio. PreferenceEngine stays the deterministic score behind the explanations;
 * this layer adds the stochastic choice, so two radios from one profile differ by a controlled amount.
 */
export class EigenResonanceRanker {
  private preference: PreferenceEngine;
  private random: RandomSource;
  private space = new PoincareEmbeddingSpace();
  private thompson: ThompsonBanditOptimizer;
  private artistPositions = new Map<string, number[]>();
  private context: NeuralContextModel | null;

  constructor(preference: PreferenceEngine, random: RandomSource = Math.random, context: NeuralContextModel | null = null) {
    this.preference = preference;
    this.random = random;
    this.context = context;
    this.thompson = new ThompsonBanditOptimizer(8, random);
  }

  getUserPosition(): number[] {
    return this.space.getUser();
  }

  /** Both models are replays of the ratings, so undo and import cannot leave them out of date. */
  refit(): void {
    const samples = this.preference.getRatedSamples();

    this.space.reset();
    for (const { point, rating } of samples) {
      this.space.update(embed(point.values), rating);
    }

    this.thompson.fit(samples.map(({ point, rating }) => ({
      context: standardize(point.values),
      known: point.known,
      reward: REWARD[rating] ?? 0
    })));

    this.artistPositions = this.computeArtistPositions(samples);
  }

  compose(predictions: readonly PredictionResult[], context: ComposeContext = {}): ResonanceQueue {
    this.refit();

    const length = context.length ?? 30;
    const temperature = context.temperature ?? resolveTemperature(context);
    const theta = this.thompson.sampleTheta();
    const target = context.target ? standardize(context.target) : null;
    const date = context.date ?? new Date();
    const utilities = predictions.map((prediction) => {
      const contextual = this.context?.adjustment(prediction.track, date, context.carryFeedback) ?? 0;
      return this.utilityOf(prediction, theta, target) + contextual;
    });
    const thermodynamics = boltzmannDistribution(utilities, temperature);

    const poolSize = Math.min(predictions.length, Math.max(length * POOL_FACTOR, MIN_POOL));
    const peak = Math.max(...thermodynamics.probabilities);
    const reachable = thermodynamics.probabilities.map((p) => (p >= peak * MIN_DRAW_PROBABILITY_RATIO ? p : 0));
    const drawn = sampleWithoutReplacement(reachable, poolSize, this.random).filter((index) => reachable[index] > 0);

    const pool: Array<TrajectoryTrack<TrackMetadata>> = drawn.map((index) => {
      const { track } = predictions[index];
      const features = track.acousticFeatures;
      const point = toAcousticPoint(features);
      return {
        id: track.uri,
        artistIds: track.artists.map((a) => a.uri).filter(Boolean),
        score: utilities[index],
        camelot: camelotOf(features),
        bpm: features?.bpm,
        energy: features?.energy,
        vector: point ? standardize(point.values) : undefined,
        morphology: this.context?.getFlags().morphology ? features?.morphology : undefined,
        rhythm: this.context?.getFlags().rhythm ? features?.rhythm : undefined,
        payload: track
      };
    });

    const ordered = this.context?.getFlags().calibrated && !context.target ? this.calibrate(pool) : pool;
    const solver = context.strictHarmonic ? solveHarmonicQueue(ordered, { length }) : solveTrajectory(ordered, { length, relaxSpacing: true });

    return { tracks: solver.tracks.map((t) => t.payload), temperature, thermodynamics, solver };
  }

  /** Keeps every minority taste in the pool the sequencer chooses from, in proportion. */
  private calibrate(pool: Array<TrajectoryTrack<TrackMetadata>>): Array<TrajectoryTrack<TrackMetadata>> {
    const { clusters } = this.preference.getModelSnapshot();
    if (clusters.length < 2) return pool;

    const target = normalizeDistribution(new Map(clusters.map((cluster, i) => [i, cluster.share])));
    const items = pool.map((track) => {
      const point = toAcousticPoint(track.payload.acousticFeatures);
      return { id: track.id, score: track.score, cluster: (point ? this.preference.clusterOf(point) : null) ?? -1, payload: track };
    });

    return rerankCalibrated(items, target, items.length, 0.3).map((item) => item.payload);
  }

  private utilityOf({ track, score }: PredictionResult, theta: readonly number[], target: readonly number[] | null): number {
    const point = toAcousticPoint(track.acousticFeatures);

    let hyperbolic = NEUTRAL;
    let sampled = NEUTRAL;

    if (point) {
      const z = standardize(point.values);
      const projection = z.reduce((sum, value, i) => sum + value * theta[i], 0);
      hyperbolic = this.space.affinity(embed(point.values));
      sampled = 0.5 + Math.tanh(projection / 4) / 2;
    } else {
      const position = track.artists.map((a) => this.artistPositions.get(a.uri)).find(Boolean);
      if (position) hyperbolic = this.space.affinity(position);
    }

    const utility = WEIGHT_SCORE * (score / 100) + WEIGHT_HYPERBOLIC * hyperbolic + WEIGHT_THOMPSON * sampled;
    if (!target) return utility;

    // A request in words is about this session: it outweighs the standing profile
    const match = point ? cosineSimilarity(standardize(point.values), target) : 0;
    return (1 - WEIGHT_TARGET) * utility + WEIGHT_TARGET * (0.5 + match / 2);
  }

  private computeArtistPositions(samples: readonly RatedSample[]): Map<string, number[]> {
    const tracksByArtist = new Map<string, number[][]>();

    for (const { point, artistUris } of samples) {
      const position = embed(point.values);
      for (const uri of artistUris) {
        const list = tracksByArtist.get(uri);
        if (list) list.push(position);
        else tracksByArtist.set(uri, [position]);
      }
    }

    return new Map(Array.from(tracksByArtist, ([uri, tracks]) => [uri, gyroMidpoint(tracks)]));
  }
}
