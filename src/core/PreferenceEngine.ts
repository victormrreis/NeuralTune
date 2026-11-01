import { StorageAdapter } from '../storage/StorageAdapter.ts';
import {
  ACOUSTIC_DIMENSIONS,
  ACOUSTIC_DIMENSION_COUNT,
  AcousticPoint,
  BANDIT_CONTEXT_SIZE,
  POPULATION_MEAN,
  acousticKernel,
  banditContext,
  cosineSimilarity,
  dot,
  identityMatrix,
  invertMatrix,
  matrixVector,
  standardize,
  toAcousticPoint
} from './AcousticVector.ts';
import { COUNTED_PLAY_MS } from './PlaybackHistoryTracker.ts';
import { GraphTrack, MusicGraphEngine } from './MusicGraphEngine.ts';
import { halfLifeDays, nostalgiaBonus, satiationExposure } from './CognitiveMemoryModel.ts';
import {
  TrackMetadata,
  TrackRatingRecord,
  PreferenceProfile,
  AttributeWeight,
  PredictionResult,
  ExplanationItem,
  PlayEvent,
  ScoreComponent,
  AcousticFeatures,
  ListeningHistoryEntry
} from '../types/index.ts';

const DEFAULT_PROFILE_ID = 'default';
const BAYESIAN_PSEUDO_COUNT = 4; // Prior strength for shrinkage

// User vector gradient step: u += LEARNING_RATE * weight * kernel * (x - u)
const LEARNING_RATE = 0.12;
const GRADIENT_WEIGHT: Record<number, number> = { 0: -1.0, 1: -0.6, 2: -0.3, 3: 0, 4: 0.5, 5: 1.0 };
const KERNEL_BANDWIDTH = 0.6;

// Raised when the signal of a rating changes: stored weights were summed on the old scale
const SIGNAL_SCALE = 2;
const VECTOR_CONFIDENCE_SAMPLES = 8;
const MAX_AVOIDANCE_POINTS = 256;

// LinUCB over φ(z): bias, linear, quadratic and crossed terms, normalized to unit length
const BANDIT_DIMENSION = BANDIT_CONTEXT_SIZE;
const RIDGE_LAMBDA = 1;

// DP-means over the liked tracks: a track this far from every centroid founds a new taste
const MAX_CLUSTERS = 6;
const CLUSTER_SPLIT_DISTANCE = 1.2;
const CLUSTER_WEIGHT_EXPONENT = 0.25;
const CLUSTER_MEMBERSHIP_WIDTH = 0.8;

// Implicit feedback: an explicit rating is sovereign, and these never outweigh it
const IMPLICIT_COMPLETE_RATIO = 0.85;
const IMPLICIT_MAX_CONFIDENCE = 0.6;
const IMPLICIT_COMPLETE_REWARD = 0.45;
const IMPLICIT_RELISTEN_REWARD = 0.7;
const IMPLICIT_SKIP_REWARD = -0.55;
const IMPLICIT_SKIP_MIN_MS = 5_000;
const IMPLICIT_SKIP_MAX_MS = 25_000;
const IMPLICIT_RELISTEN_WINDOW_MS = 7 * 24 * 60 * 60_000;
const COMPLETION_AFFINITY_RATE = 0.8;
const COMPLETION_AFFINITY_MIN_PLAYS = 3;
const SESSION_WINDOW_MS = 45 * 60_000;

// Maximum points each component can move the score away from the neutral 50
const NEUTRAL_SCORE = 50;
const POINTS = {
  acoustic: 22,
  bandit: 18,
  artist: 20,
  attributes: 25,
  exploration: 40, // Multiplied by the profile's exploration factor
  avoidance: 25,
  fatigue: 40,
  graph: 15
};

const HOUR_MS = 3_600_000;
const FATIGUE_MEMORY_MS = 72 * HOUR_MS;
const ARTIST_FATIGUE_SHARE = 0.5;
const SEQUENCE_FATIGUE_STRENGTH = 0.9;

const MIN_REASON_POINTS = 0.5;

const DIMENSION_LABELS: Record<(typeof ACOUSTIC_DIMENSIONS)[number], [low: string, high: string]> = {
  tempo: ['andamento lento', 'andamento rápido'],
  energy: ['baixa energia', 'alta energia'],
  valence: ['baixa valência', 'alta valência'],
  danceability: ['pouco dançante', 'muito dançante'],
  acousticness: ['som eletrônico', 'som acústico'],
  instrumentalness: ['vocal', 'instrumental'],
  speechiness: ['pouca fala', 'muita fala'],
  liveness: ['gravação de estúdio', 'gravação ao vivo']
};

interface TrainingSample {
  point: AcousticPoint;
  rating: number;
  timestamp: number;
  artistUris: string[];
  features?: AcousticFeatures;
}

export interface TasteCluster {
  centroid: number[]; // Standardized space
  weight: number;
  share: number;
  variance: number[];
  samples: number;
  description: string;
}
export const TasteCluster = {};

interface ImplicitStats {
  plays: number;
  completions: number;
  earlySkips: number;
  lastPositiveAt: number;
  relistened: boolean;
}

export type RatedSample = TrainingSample;
export const RatedSample = {};

interface BanditModel {
  inverse: number[][];
  theta: number[];
}

export interface ModelSnapshot {
  dimensions: readonly string[];
  vector: number[];
  samples: number;
  avoidancePoints: number;
  clusters: TasteCluster[];
  implicitSignals: number;
}
export const ModelSnapshot = {};

function createBanditModel(): BanditModel {
  return {
    inverse: identityMatrix(BANDIT_DIMENSION, 1 / RIDGE_LAMBDA),
    theta: new Array<number>(BANDIT_DIMENSION).fill(0)
  };
}

function pushTimestamp(index: Map<string, number[]>, key: string, timestamp: number): void {
  const list = index.get(key);
  if (list) list.push(timestamp);
  else index.set(key, [timestamp]);
}

/** Root mean squared gap over the dimensions the point actually knows. */
function clusterDistance(point: AcousticPoint, z: readonly number[], centroid: readonly number[]): number {
  let squared = 0;
  let count = 0;
  for (let i = 0; i < ACOUSTIC_DIMENSION_COUNT; i++) {
    if (!point.known[i]) continue;
    squared += (z[i] - centroid[i]) ** 2;
    count++;
  }
  return count === 0 ? 0 : Math.sqrt(squared / count);
}

function describeCentroid(centroid: readonly number[]): string {
  const traits = ACOUSTIC_DIMENSIONS
    .map((dimension, i) => ({ strength: Math.abs(centroid[i]), label: DIMENSION_LABELS[dimension][centroid[i] >= 0 ? 1 : 0] }))
    .filter((trait) => trait.strength > 0.3)
    .sort((a, b) => b.strength - a.strength)
    .slice(0, 2)
    .map((trait) => trait.label.charAt(0).toUpperCase() + trait.label.slice(1));

  return traits.length > 0 ? traits.join(' + ') : 'Perfil equilibrado';
}
export class PreferenceEngine {
  private storage: StorageAdapter;
  private now: () => number;
  private currentProfile: PreferenceProfile;

  private samples = new Map<string, TrainingSample>();
  private userVector: number[] = [...POPULATION_MEAN];
  private vectorSamples = 0;
  private avoidancePoints: AcousticPoint[] = [];
  private bandit: BanditModel = createBanditModel();

  private trackPlays = new Map<string, number[]>();
  private artistPlays = new Map<string, number[]>();

  private clusters: TasteCluster[] = [];
  private ratedTracks = new Map<string, { rating: number; timestamp: number; graph: GraphTrack }>();
  private implicit = new Map<string, ImplicitStats>();
  private implicitSignals = 0;
  private recentEvents: PlayEvent[] = [];
  private transitions: Array<readonly [string, string]> = [];
  private contexts: ReadonlyMap<string, readonly string[]> = new Map();
  private graph = new MusicGraphEngine();
  private featureLookup: (uri: string) => AcousticFeatures | undefined = () => undefined;
  private modelStale = false;
  private graphStale = true;

  constructor(storage: StorageAdapter, now: () => number = Date.now) {
    this.storage = storage;
    this.now = now;
    this.currentProfile = this.createDefaultProfile();
  }

  createDefaultProfile(id: string = DEFAULT_PROFILE_ID, name: string = 'Padrão'): PreferenceProfile {
    return {
      id,
      name,
      attributeWeights: {},
      artistAffinities: {},
      signalScale: SIGNAL_SCALE,
      explorationFactor: 0.2, // 20% exploration by default
      antiFatigue: {
        minArtistDistance: 3,
        recentPenaltyWindow: 5
      }
    };
  }

  async init(profileId: string = DEFAULT_PROFILE_ID): Promise<void> {
    const saved = await this.storage.getProfile(profileId);
    if (saved) {
      this.currentProfile = this.withDefaults(saved);
    } else {
      this.currentProfile = this.createDefaultProfile(profileId);
      await this.storage.saveProfile(this.currentProfile);
    }

    const plays = await this.storage.getAllPlayEvents();
    plays.sort((a, b) => a.startedAt - b.startedAt);
    for (const event of plays) {
      this.recordPlay(event);
    }

    this.loadSamples(await this.storage.getAllRatings());
    this.retrain();
    if (saved && saved.signalScale !== SIGNAL_SCALE) await this.reloadFromStorage();
  }

  /** Profiles saved by an older release can lack fields added since. */
  private withDefaults(saved: PreferenceProfile): PreferenceProfile {
    const defaults = this.createDefaultProfile(saved.id, saved.name);
    return {
      ...defaults,
      ...saved,
      attributeWeights: saved.attributeWeights ?? {},
      artistAffinities: saved.artistAffinities ?? {},
      explorationFactor: Number.isFinite(saved.explorationFactor) ? saved.explorationFactor : defaults.explorationFactor,
      antiFatigue: { ...defaults.antiFatigue, ...saved.antiFatigue }
    };
  }

  /** Lets implicit feedback reach tracks that have acoustic data but no rating. */
  setFeatureLookup(lookup: (uri: string) => AcousticFeatures | undefined): void {
    this.featureLookup = lookup;
    this.modelStale = true;
  }

  /** Playlist membership: the context nodes of the graph. */
  setContexts(contexts: ReadonlyMap<string, readonly string[]>): void {
    this.contexts = contexts;
    this.graphStale = true;
  }

  getGraph(): MusicGraphEngine {
    this.refreshGraph();
    return this.graph;
  }

  /** Half-life of a track's memory at each rating, for the diagnostics. */
  getMemoryHalfLives(): { fourStars: number; fiveStars: number } {
    return { fourStars: halfLifeDays(0.6), fiveStars: halfLifeDays(1) };
  }

  getProfile(): PreferenceProfile {
    return this.currentProfile;
  }

  async setProfile(profile: PreferenceProfile): Promise<void> {
    this.currentProfile = profile;
    await this.storage.saveProfile(profile);
  }

  /** Index in the snapshot's cluster list of the taste this point sits closest to. */
  clusterOf(point: AcousticPoint): number | null {
    this.refreshModel();

    const z = standardize(point.values);
    let best: number | null = null;
    let distance = Number.POSITIVE_INFINITY;
    this.clusters.forEach((cluster, index) => {
      const gap = clusterDistance(point, z, cluster.centroid);
      if (gap < distance) {
        distance = gap;
        best = index;
      }
    });
    return best;
  }

  /** Rated tracks with acoustic data, oldest first: the input of every model replayed from ratings. */
  getRatedSamples(): RatedSample[] {
    return Array.from(this.samples.values()).sort((a, b) => a.timestamp - b.timestamp);
  }

  getModelSnapshot(): ModelSnapshot {
    this.refreshModel();
    return {
      dimensions: ACOUSTIC_DIMENSIONS,
      vector: [...this.userVector],
      samples: this.vectorSamples,
      avoidancePoints: this.avoidancePoints.length,
      clusters: this.clusters.map((c) => ({ ...c, centroid: [...c.centroid], variance: [...c.variance] })),
      implicitSignals: this.implicitSignals
    };
  }

  /**
   * Translates 0-5 stars rating to a continuous mathematical signal between -1.0 and +1.0
   */
  private ratingToSignal(rating: number): number {
    return GRADIENT_WEIGHT[rating] ?? 0;
  }

  /**
   * Extracts discrete feature keys from track metadata for attribution and learning.
   */
  extractAttributes(track: TrackMetadata): string[] {
    const attrs: string[] = [];

    // 1. Genres
    if (track.genres && track.genres.length > 0) {
      for (const g of track.genres) {
        attrs.push(`genre:${g.toLowerCase().trim()}`);
      }
    }

    // 2. Era / Decade
    if (track.releaseYear && track.releaseYear > 1900) {
      const decade = Math.floor(track.releaseYear / 10) * 10;
      attrs.push(`era:${decade}s`);
    }

    // 3. Acoustic structural features (discretized into bins)
    const af = track.acousticFeatures;
    if (af) {
      if (Number.isFinite(af.bpm) && af.bpm! > 0) {
        if (af.bpm! < 90) attrs.push('tempo:slow');
        else if (af.bpm! <= 130) attrs.push('tempo:moderate');
        else attrs.push('tempo:fast');
      }

      if (Number.isFinite(af.energy)) {
        if (af.energy! < 0.35) attrs.push('energy:low');
        else if (af.energy! <= 0.7) attrs.push('energy:medium');
        else attrs.push('energy:high');
      }

      if (Number.isFinite(af.danceability)) {
        if (af.danceability! > 0.65) attrs.push('mood:danceable');
      }

      if (Number.isFinite(af.acousticness)) {
        if (af.acousticness! > 0.65) attrs.push('sound:acoustic');
        else if (af.acousticness! < 0.2) attrs.push('sound:electronic');
      }

      if (Number.isFinite(af.instrumentalness)) {
        if (af.instrumentalness! > 0.5) attrs.push('style:instrumental');
        else attrs.push('style:vocal');
      }

      if (Number.isFinite(af.valence)) {
        if (af.valence! > 0.65) attrs.push('valence:positive');
        else if (af.valence! < 0.35) attrs.push('valence:melancholic');
      }
    }

    return attrs;
  }

  /**
   * Incremental Bayesian update when a track is rated.
   * Ensures ratings do not destroy an entire category, but scale proportionally.
   */
  async updateWithRating(record: TrackRatingRecord, previousRecord: TrackRatingRecord | null): Promise<void> {
    this.applyToWeights(record, previousRecord);

    if (record.removed) this.ratedTracks.delete(record.uri);
    else this.indexRating(record);
    this.graphStale = true;

    const point = record.removed ? null : toAcousticPoint(record.metadata.acousticFeatures);
    if (point) {
      this.samples.set(record.uri, this.toSample(record, point));
    } else {
      this.samples.delete(record.uri);
    }
    this.retrain();

    await this.storage.saveProfile(this.currentProfile);
  }

  /**
   * Rebuilds everything learned from the stored ratings. Needed when ratings change outside
   * updateWithRating: JSON import, Trash Bin migration and acoustic feature backfill.
   */
  async reloadFromStorage(): Promise<void> {
    const ratings = await this.storage.getAllRatings();
    ratings.sort((a, b) => a.timestamp - b.timestamp);

    this.currentProfile.attributeWeights = {};
    this.currentProfile.artistAffinities = {};
    this.currentProfile.signalScale = SIGNAL_SCALE;
    for (const record of ratings) {
      this.applyToWeights(record, null);
    }

    this.loadSamples(ratings);
    this.retrain();
    await this.storage.saveProfile(this.currentProfile);
  }

  /**
   * The imported history as implicit feedback, the weakest evidence the model takes. It reaches only
   * tracks with acoustic data, carries no timestamps per play, and so adds nothing to fatigue.
   */
  ingestHistory(entries: readonly ListeningHistoryEntry[]): void {
    for (const { uri, plays, completions, earlySkips, lastAt } of entries) {
      if (!uri) continue;

      const stats = this.implicit.get(uri)
        ?? { plays: 0, completions: 0, earlySkips: 0, lastPositiveAt: 0, relistened: false };
      stats.plays += plays;
      stats.completions += completions;
      stats.earlySkips += earlySkips;
      stats.relistened ||= completions >= 2;
      stats.lastPositiveAt = Math.max(stats.lastPositiveAt, completions > 0 ? lastAt : 0);
      this.implicit.set(uri, stats);
    }
    this.modelStale = true;
  }

  /** Feeds fatigue, long-term memory and implicit feedback. Auto-skips and mis-clicks do not tire. */
  recordPlay(event: PlayEvent): void {
    this.recordImplicit(event);
    this.recordTransition(event);
    this.modelStale = true;

    if (event.playedMs < COUNTED_PLAY_MS) return;

    pushTimestamp(this.trackPlays, event.uri, event.startedAt);
    for (const artistUri of event.artistUris) {
      pushTimestamp(this.artistPlays, artistUri, event.startedAt);
    }
    this.pruneFatigue();
  }
  /**
   * Scores a candidate track and generates explainability evidence.
   */
  evaluateCandidate(
    track: TrackMetadata,
    recentPlayedArtists: string[] = []
  ): PredictionResult {
    this.refreshModel();
    this.refreshGraph();

    // 1. Blacklist check
    if (this.storage.isTrackBlocked(track.uri)) {
      return {
        track,
        score: 0,
        confidence: 1.0,
        eligible: false,
        rejectionReason: 'Faixa presente na blacklist permanente (nota 0)',
        reasons: [],
        noveltyScore: 0
      };
    }

    for (const artist of track.artists) {
      if (this.storage.isArtistUriBlocked(artist.uri)) {
        return {
          track,
          score: 0,
          confidence: 1.0,
          eligible: false,
          rejectionReason: `Artista "${artist.name}" bloqueado`,
          reasons: [],
          noveltyScore: 0
        };
      }
    }

    // 2. Each signal contributes signed points around the neutral score
    const components: Array<Omit<ScoreComponent, 'share'>> = [];
    const attributes = this.scoreAttributes(track);
    const artist = this.scoreArtists(track);
    const point = toAcousticPoint(track.acousticFeatures);
    let uncertainty: number | null = null;

    if (attributes.points !== 0) {
      components.push({ key: 'attributes', label: attributes.label, points: attributes.points });
    }
    if (artist !== 0) {
      components.push({ key: 'artist', label: 'afinidade com o artista', points: artist });
    }

    if (point) {
      const zPoint = standardize(point.values);
      const resonant = this.resonantCentroid(zPoint);
      const zUser = resonant?.centroid ?? standardize(this.userVector);
      const vectorConfidence = 1 - Math.exp(-this.vectorSamples / VECTOR_CONFIDENCE_SAMPLES);
      const acoustic = (resonant ? resonant.affinity : cosineSimilarity(zPoint, zUser)) * vectorConfidence * POINTS.acoustic;
      components.push({
        key: 'acoustic',
        label: this.describeAcoustic(point, zPoint, zUser, acoustic),
        points: acoustic
      });
      const phi = banditContext(point.values);
      const predicted = Math.max(-1, Math.min(1, dot(this.bandit.theta, phi)));
      uncertainty = Math.sqrt(Math.max(0, dot(phi, matrixVector(this.bandit.inverse, phi))));
      components.push({ key: 'bandit', label: 'previsão do modelo de notas', points: predicted * POINTS.bandit });
      components.push({
        key: 'exploration',
        label: 'bônus de descoberta',
        points: POINTS.exploration * this.currentProfile.explorationFactor * uncertainty
      });

      const nearestBlocked = this.nearestAvoidance(point.values);
      if (nearestBlocked > 0) {
        components.push({
          key: 'avoidance',
          label: 'semelhança acústica com faixas bloqueadas',
          points: -nearestBlocked * POINTS.avoidance
        });
      }
    }

    const structural = this.graph.affinity(track.uri, track.artists.map((a) => a.uri));
    if (structural !== 0) {
      components.push({ key: 'graph', label: 'afinidade estrutural no grafo', points: structural * POINTS.graph });
    }

    const fatigue = this.fatiguePenalty(track, recentPlayedArtists);
    if (fatigue > 0) {
      components.push({ key: 'fatigue', label: 'penalidade por repetição recente', points: -fatigue });
    }

    const nostalgia = this.nostalgiaPoints(track.uri);
    if (nostalgia > 0) {
      components.push({ key: 'nostalgia', label: 'redescoberta nostálgica', points: nostalgia });
    }

    // 3. Final score and its decomposition
    const total = components.reduce((sum, c) => sum + c.points, 0);
    const score = Math.round(Math.max(0, Math.min(100, NEUTRAL_SCORE + total)));
    const breakdown = this.withShares(components);

    const knownAttributes = attributes.total - attributes.unknown;
    const attributeNovelty = attributes.total > 0 ? attributes.unknown / attributes.total : 1.0;
    const attributeConfidence = knownAttributes > 0 ? Math.min(1.0, attributes.importance / (attributes.total + 1)) : 0.1;

    return {
      track,
      score,
      confidence: uncertainty === null ? attributeConfidence : Math.max(0.1, 1 - uncertainty),
      eligible: true,
      reasons: this.toReasons(breakdown),
      noveltyScore: uncertainty ?? attributeNovelty,
      breakdown
    };
  }

  /**
   * Takes back what the previous record taught, from the attributes it had then, before teaching the
   * new one: a track can gain acoustic data between two ratings, and the two sets then differ.
   */
  private applyToWeights(record: TrackRatingRecord, previousRecord: TrackRatingRecord | null): void {
    if (previousRecord) this.contribute(previousRecord, -1);
    if (!record.removed) this.contribute(record, 1);
  }

  private contribute(record: TrackRatingRecord, direction: 1 | -1): void {
    const signal = this.ratingToSignal(record.rating);

    // 1. Update Attribute Weights with Bayesian Shrinkage
    for (const attr of this.extractAttributes(record.metadata)) {
      const current: AttributeWeight = this.currentProfile.attributeWeights[attr]
        ?? { weight: 0, count: 0, confidence: 0, variance: 1.0 };

      const updated = this.shrink(current.weight, current.count, signal, direction);
      current.weight = updated.value;
      current.count = updated.count;

      // Confidence approaches 1.0 as count grows
      current.confidence = 1 - 1 / Math.sqrt(1 + current.count);
      this.currentProfile.attributeWeights[attr] = current;
    }

    // 2. Update Artist Affinities. An empty URI is "unknown artist", not one artist shared by all of them
    for (const artist of record.metadata.artists) {
      if (!artist.uri) continue;
      const aff = this.currentProfile.artistAffinities[artist.uri] ?? { score: 0, count: 0 };
      const updated = this.shrink(aff.score, aff.count, signal, direction);
      aff.score = updated.value;
      aff.count = updated.count;
      this.currentProfile.artistAffinities[artist.uri] = aff;
    }
  }

  /** Adds or takes back one observation. With none left the value is exactly the prior, without residue. */
  private shrink(value: number, count: number, signal: number, direction: 1 | -1): { value: number; count: number } {
    const remaining = count + direction;
    if (remaining <= 0) return { value: 0, count: 0 };

    const sum = value * (BAYESIAN_PSEUDO_COUNT + count) + direction * signal;
    return { value: sum / (BAYESIAN_PSEUDO_COUNT + remaining), count: remaining };
  }

  private loadSamples(ratings: TrackRatingRecord[]): void {
    this.samples.clear();
    this.ratedTracks.clear();
    this.graphStale = true;
    for (const record of ratings) {
      if (record.metadata) this.indexRating(record);
      const point = toAcousticPoint(record.metadata?.acousticFeatures);
      if (point) {
        this.samples.set(record.uri, this.toSample(record, point));
      }
    }
  }

  private toSample(record: TrackRatingRecord, point: AcousticPoint): TrainingSample {
    return {
      point,
      rating: record.rating,
      timestamp: record.timestamp,
      artistUris: record.metadata.artists.map((a) => a.uri).filter(Boolean),
      features: record.metadata.acousticFeatures
    };
  }

  /**
   * The model is a pure function of the rated tracks, replayed chronologically. The gradient update is
   * path-dependent, so undoing or re-rating incrementally would leave the vector somewhere no rating
   * history can explain. Replaying costs O(n) with a small constant, once per rating.
   */
  private retrain(): void {
    const ordered = Array.from(this.samples.values()).sort((a, b) => a.timestamp - b.timestamp);

    const vector = [...POPULATION_MEAN];
    const avoidance: AcousticPoint[] = [];
    const design = new Float64Array(BANDIT_DIMENSION * BANDIT_DIMENSION);
    const response = new Array<number>(BANDIT_DIMENSION).fill(0);
    const clusters: TasteCluster[] = [];
    let vectorSamples = 0;

    const observe = (phi: readonly number[], reward: number, confidence: number): void => {
      for (let row = 0; row < BANDIT_DIMENSION; row++) {
        response[row] += confidence * reward * phi[row];
        for (let column = row; column < BANDIT_DIMENSION; column++) {
          design[row * BANDIT_DIMENSION + column] += confidence * phi[row] * phi[column];
        }
      }
    };

    for (const { point, rating } of ordered) {
      const weight = GRADIENT_WEIGHT[rating] ?? 0;

      if (weight !== 0) {
        // Repulsion fades with distance: disliking something far away says nothing about this region
        const kernel = weight > 0 ? 1 : acousticKernel(point, vector, KERNEL_BANDWIDTH);
        for (let i = 0; i < ACOUSTIC_DIMENSION_COUNT; i++) {
          if (!point.known[i]) continue;
          const stepped = vector[i] + LEARNING_RATE * weight * kernel * (point.values[i] - vector[i]);
          vector[i] = Math.max(0, Math.min(1, stepped));
        }
        vectorSamples++;
      }

      if (rating === 0) avoidance.push(point);
      if (weight > 0) this.assignToCluster(clusters, point, weight);

      observe(banditContext(point.values), weight, 1);
    }

    this.implicitSignals = 0;
    for (const [uri, stats] of this.implicit) {
      if (this.ratedTracks.has(uri)) continue;

      const signal = this.implicitSignal(stats);
      const point = signal ? toAcousticPoint(this.featureLookup(uri)) : null;
      if (signal && point) {
        observe(banditContext(point.values), signal.reward, signal.confidence);
        this.implicitSignals++;
      }
    }

    const matrix = identityMatrix(BANDIT_DIMENSION, RIDGE_LAMBDA);
    for (let row = 0; row < BANDIT_DIMENSION; row++) {
      for (let column = row; column < BANDIT_DIMENSION; column++) {
        const value = design[row * BANDIT_DIMENSION + column];
        matrix[row][column] += value;
        if (row !== column) matrix[column][row] += value;
      }
    }

    const inverse = invertMatrix(matrix);
    const totalWeight = clusters.reduce((sum, cluster) => sum + cluster.weight, 0);

    this.clusters = clusters
      .map((cluster) => ({
        ...cluster,
        share: totalWeight > 0 ? cluster.weight / totalWeight : 0,
        description: describeCentroid(cluster.centroid)
      }))
      .sort((a, b) => b.share - a.share);
    this.bandit = { inverse, theta: matrixVector(inverse, response) };
    this.userVector = vector;
    this.vectorSamples = vectorSamples;
    this.avoidancePoints = avoidance.slice(-MAX_AVOIDANCE_POINTS);
    this.currentProfile.userVector = vector;
    this.currentProfile.vectorSamples = vectorSamples;
    this.modelStale = false;
  }

  /** Online DP-means: nearest centroid, or a new one past the split distance while K < 6. */
  private assignToCluster(clusters: TasteCluster[], point: AcousticPoint, weight: number): void {
    const z = standardize(point.values);

    let nearest: TasteCluster | null = null;
    let distance = Number.POSITIVE_INFINITY;
    for (const cluster of clusters) {
      const gap = clusterDistance(point, z, cluster.centroid);
      if (gap < distance) {
        distance = gap;
        nearest = cluster;
      }
    }

    if (!nearest || (distance > CLUSTER_SPLIT_DISTANCE && clusters.length < MAX_CLUSTERS)) {
      clusters.push({
        centroid: z.map((value, i) => (point.known[i] ? value : 0)),
        weight,
        share: 0,
        variance: new Array<number>(ACOUSTIC_DIMENSION_COUNT).fill(0),
        samples: 1,
        description: ''
      });
      return;
    }

    const total = nearest.weight + weight;
    for (let i = 0; i < ACOUSTIC_DIMENSION_COUNT; i++) {
      if (!point.known[i]) continue;
      const delta = z[i] - nearest.centroid[i];
      nearest.centroid[i] += (weight / total) * delta;
      nearest.variance[i] = (nearest.weight / total) * (nearest.variance[i] + (weight / total) * delta * delta);
    }
    nearest.weight = total;
    nearest.samples++;
  }

  /**
   * max_k π_k^β cos(z, c_k) · exp(-d²/2h²): the taste this track belongs to, never the average of all.
   * The Gaussian gate is an addition to the cosine, which is blind to magnitude: a middling track lies
   * in the same direction as a strong centroid while being far from it, and would score as a member.
   */
  private resonantCentroid(z: readonly number[]): { centroid: number[]; affinity: number } | null {
    let best: { centroid: number[]; affinity: number } | null = null;

    for (const cluster of this.clusters) {
      let squared = 0;
      for (let i = 0; i < ACOUSTIC_DIMENSION_COUNT; i++) squared += (z[i] - cluster.centroid[i]) ** 2;
      const gate = Math.exp(-(squared / ACOUSTIC_DIMENSION_COUNT) / (2 * CLUSTER_MEMBERSHIP_WIDTH ** 2));

      const similarity = cosineSimilarity(z, cluster.centroid);
      const affinity = similarity * gate * cluster.share ** CLUSTER_WEIGHT_EXPONENT;
      if (!best || affinity > best.affinity) best = { centroid: cluster.centroid, affinity };
    }

    return best;
  }

  private indexRating(record: TrackRatingRecord): void {
    this.ratedTracks.set(record.uri, {
      rating: record.rating,
      timestamp: record.timestamp,
      graph: {
        uri: record.uri,
        signal: this.ratingToSignal(record.rating),
        artistUris: record.metadata.artists.map((a) => a.uri).filter(Boolean),
        albumUri: record.metadata.album?.uri || undefined
      }
    });
  }

  private recordImplicit(event: PlayEvent): void {
    const stats = this.implicit.get(event.uri)
      ?? { plays: 0, completions: 0, earlySkips: 0, lastPositiveAt: 0, relistened: false };

    stats.plays++;

    const complete = !!event.durationMs && event.playedMs / event.durationMs >= IMPLICIT_COMPLETE_RATIO;
    if (complete) {
      stats.completions++;
      if (stats.lastPositiveAt > 0 && event.startedAt - stats.lastPositiveAt < IMPLICIT_RELISTEN_WINDOW_MS) {
        stats.relistened = true;
      }
      stats.lastPositiveAt = event.startedAt;
    }

    if (event.playedMs >= IMPLICIT_SKIP_MIN_MS && event.playedMs < IMPLICIT_SKIP_MAX_MS) stats.earlySkips++;

    this.implicit.set(event.uri, stats);
  }

  private implicitSignal(stats: ImplicitStats): { reward: number; confidence: number } | null {
    const confidence = Math.min(IMPLICIT_MAX_CONFIDENCE, 0.15 * Math.log(1 + stats.plays));

    if (stats.earlySkips >= 2 && stats.earlySkips > stats.completions) {
      return { reward: IMPLICIT_SKIP_REWARD, confidence };
    }
    if (stats.relistened) return { reward: IMPLICIT_RELISTEN_REWARD, confidence };
    if (stats.completions > 0) return { reward: IMPLICIT_COMPLETE_REWARD, confidence };
    return null;
  }

  private recordTransition(event: PlayEvent): void {
    const previous = this.recentEvents[0];
    if (previous && event.startedAt - previous.endedAt <= SESSION_WINDOW_MS && !event.skipped) {
      this.transitions.push([previous.uri, event.uri]);
      this.graphStale = true;
    }
    this.recentEvents[0] = event;
  }

  private refreshModel(): void {
    if (this.modelStale) this.retrain();
  }

  private refreshGraph(): void {
    if (!this.graphStale) return;

    this.graph.rebuild({
      tracks: Array.from(this.ratedTracks.values(), (rated) => rated.graph),
      transitions: this.transitions,
      contexts: this.contexts
    });
    this.graphStale = false;
  }

  private nostalgiaPoints(uri: string): number {
    const rated = this.ratedTracks.get(uri);
    const stats = this.implicit.get(uri);

    let affinity = 0;
    if (rated) {
      affinity = rated.rating === 5 ? 1 : rated.rating === 4 ? 0.6 : 0;
    } else if (stats && stats.plays >= COMPLETION_AFFINITY_MIN_PLAYS && stats.completions / stats.plays >= COMPLETION_AFFINITY_RATE) {
      affinity = 0.5;
    }
    if (affinity === 0) return 0;

    const plays = this.trackPlays.get(uri) ?? [];
    return nostalgiaBonus(rated ? [...plays, rated.timestamp] : plays, this.now(), affinity);
  }
  private scoreAttributes(track: TrackMetadata): {
    points: number;
    label: string;
    total: number;
    unknown: number;
    importance: number;
  } {
    const inferred = track.genres?.length ? track.genres : this.graph.inferGenres(track.uri, track.artists.map((a) => a.uri));
    const attributes = this.extractAttributes({ ...track, genres: inferred });
    let weighted = 0;
    let importance = 0;
    let unknown = 0;
    let strongest: { attr: string; impact: number } | null = null;

    for (const attr of attributes) {
      const info = this.currentProfile.attributeWeights[attr];
      if (!info || info.count === 0) {
        unknown++;
        continue;
      }

      const impact = info.weight * info.confidence;
      weighted += impact;
      importance += info.confidence;
      if (!strongest || Math.abs(impact) > Math.abs(strongest.impact)) {
        strongest = { attr, impact };
      }
    }

    return {
      points: importance > 0 ? (weighted / importance) * POINTS.attributes : 0,
      label: strongest ? `afinidade com ${this.formatAttributeName(strongest.attr)}` : 'atributos da faixa',
      total: attributes.length,
      unknown,
      importance
    };
  }

  private scoreArtists(track: TrackMetadata): number {
    let sum = 0;
    let count = 0;

    for (const artist of track.artists) {
      const aff = this.currentProfile.artistAffinities[artist.uri];
      if (aff && aff.count > 0) {
        sum += aff.score;
        count++;
      }
    }

    return count > 0 ? (sum / count) * POINTS.artist : 0;
  }

  /** A blocked track penalizes its acoustic neighborhood, never a whole genre. */
  private nearestAvoidance(values: readonly number[]): number {
    let nearest = 0;
    for (const blocked of this.avoidancePoints) {
      nearest = Math.max(nearest, acousticKernel(blocked, values, KERNEL_BANDWIDTH));
    }
    return nearest;
  }

  /**
   * Saturating exponential over a multi-horizon exposure. Exposure sums one decaying term per listen
   * across the 30 min, 2 h and 24 h horizons; the sequence term covers tracks a virtual queue already
   * scheduled, which have no timestamp yet.
   */
  private fatiguePenalty(track: TrackMetadata, recentPlayedArtists: string[]): number {
    const now = this.now();
    let exposure = satiationExposure(this.trackPlays.get(track.uri), now);

    let artistExposure = 0;
    for (const artist of track.artists) {
      artistExposure = Math.max(artistExposure, satiationExposure(this.artistPlays.get(artist.uri), now));
    }
    exposure += ARTIST_FATIGUE_SHARE * artistExposure;

    const window = this.currentProfile.antiFatigue.recentPenaltyWindow;
    const distance = recentPlayedArtists.findIndex((uri) => track.artists.some((a) => a.uri === uri));
    if (distance !== -1 && distance < window) {
      exposure += SEQUENCE_FATIGUE_STRENGTH * ((window - distance) / window);
    }

    return POINTS.fatigue * (1 - Math.exp(-exposure));
  }

  private pruneFatigue(): void {
    const cutoff = this.now() - FATIGUE_MEMORY_MS;
    // Tracks keep their full history: long-term memory needs it, and only artists can grow unbounded
    for (const [key, timestamps] of this.artistPlays) {
      const kept = timestamps.filter((timestamp) => timestamp >= cutoff);
      if (kept.length === 0) this.artistPlays.delete(key);
      else if (kept.length !== timestamps.length) this.artistPlays.set(key, kept);
    }
  }

  private describeAcoustic(
    point: AcousticPoint,
    zPoint: readonly number[],
    zUser: readonly number[],
    points: number
  ): string {
    // Which dimensions drove the cosine, and in the direction that matches its sign
    const direction = points >= 0 ? 1 : -1;
    const drivers = ACOUSTIC_DIMENSIONS
      .map((dimension, i) => ({
        pull: point.known[i] ? zPoint[i] * zUser[i] * direction : 0,
        label: DIMENSION_LABELS[dimension][zPoint[i] >= 0 ? 1 : 0]
      }))
      .filter((driver) => driver.pull > 0.05)
      .sort((a, b) => b.pull - a.pull)
      .slice(0, 2)
      .map((driver) => driver.label);

    return drivers.length > 0 ? `afinidade acústica (${drivers.join(' + ')})` : 'afinidade acústica';
  }

  private withShares(components: Array<Omit<ScoreComponent, 'share'>>): ScoreComponent[] {
    const positive = components.reduce((sum, c) => sum + Math.max(0, c.points), 0);
    const absolute = components.reduce((sum, c) => sum + Math.abs(c.points), 0);
    const denominator = positive > 0 ? positive : absolute;

    return components
      .filter((c) => Math.abs(c.points) >= MIN_REASON_POINTS)
      .map((c) => ({ ...c, share: denominator > 0 ? c.points / denominator : 0 }))
      .sort((a, b) => b.points - a.points);
  }

  private toReasons(breakdown: ScoreComponent[]): ExplanationItem[] {
    const sources: Record<ScoreComponent['key'], string> = {
      acoustic: 'Vetor acústico',
      bandit: 'Modelo LinUCB',
      artist: 'Afinidade de artista',
      attributes: 'Avaliações de atributos',
      exploration: 'Modelo LinUCB',
      avoidance: 'Vetor acústico',
      fatigue: 'Motor Antifadiga',
      graph: 'Grafo musical',
      nostalgia: 'Memória ACT-R'
    };

    return breakdown
      .map((c) => ({
        attribute: c.key === 'fatigue' ? 'anti-fatigue' : c.key,
        impact: c.share,
        description: c.label.charAt(0).toUpperCase() + c.label.slice(1),
        source: sources[c.key]
      }))
      .sort((a, b) => Math.abs(b.impact) - Math.abs(a.impact));
  }

  private formatAttributeName(attr: string): string {
    const [category, val] = attr.split(':');
    switch (category) {
      case 'genre': return `Gênero ${val}`;
      case 'era': return `Década de ${val}`;
      case 'tempo': return `Andamento ${val === 'fast' ? 'rápido' : val === 'slow' ? 'lento' : 'moderado'}`;
      case 'energy': return `Energia ${val === 'high' ? 'alta' : val === 'low' ? 'baixa' : 'média'}`;
      case 'sound': return val === 'acoustic' ? 'Acústico' : 'Eletrônico';
      case 'style': return val === 'instrumental' ? 'Instrumental' : 'Vocal';
      case 'valence': return val === 'positive' ? 'Vibração positiva' : 'Atmosfera melancólica';
      default: return val || attr;
    }
  }
}
