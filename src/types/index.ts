export type Rating = 0 | 1 | 2 | 3 | 4 | 5;
export const Rating = {};

export interface AcousticFeatures {
  bpm?: number;
  key?: number;
  energy?: number;
  danceability?: number;
  acousticness?: number;
  instrumentalness?: number;
  valence?: number;
  speechiness?: number;
  liveness?: number;
  mode?: number;           // 1 = major, 0 = minor
  keyConfidence?: number;
  camelot?: string;
  chroma?: number[];
  timbre?: number[];
  timbreVariance?: number[];
  synthesisVersion?: number;
  predictive?: {
    harmonicSurprise?: number;
    harmonicUncertainty?: number;
    rhythmicSurprise?: number;
    timbralSurprise?: number;
  };
  rhythm?: { regularity: number; syncopation: number; tempoStability: number; pattern: number[] };
  morphology?: {
    intro: { loudness: number; brightness: number; density: number; camelot?: { number: number; letter: 'A' | 'B' } };
    core: { loudness: number; brightness: number; density: number; camelot?: { number: number; letter: 'A' | 'B' } };
    outro: { loudness: number; brightness: number; density: number; camelot?: { number: number; letter: 'A' | 'B' } };
    bpm?: number;
    timeline: number[];
  };
  source?: string;
}
export const AcousticFeatures = {};

export interface TrackMetadata {
  uri: string;
  uid?: string;
  name: string;
  artists: Array<{ name: string; uri: string }>;
  album: { name: string; uri: string };
  duration_ms?: number;
  is_queued?: boolean;
  provider?: string;
  acousticFeatures?: AcousticFeatures;
  genres?: string[];
  releaseYear?: number;
}
export const TrackMetadata = {};

export interface TrackRatingRecord {
  uri: string;
  rating: Rating;
  timestamp: number;
  metadata: TrackMetadata;
  manualOverride?: boolean;
  /** Set only on change notifications: the rating no longer exists in storage. */
  removed?: boolean;
}
export const TrackRatingRecord = {};

export interface PlayEvent {
  id: string;
  uri: string;
  name: string;
  artistUris: string[];
  startedAt: number;
  endedAt: number;
  playedMs: number;
  durationMs?: number;
  skipped: boolean;
  /** Who picked the track. Absent in history recorded before this field existed. */
  origin?: PlayOrigin;
  feedback?: PlayFeedback;
  /** Names, unlike URIs, match the imported history, which has none. */
  artistNames?: string[];
}
export const PlayEvent = {};

/** One track of the imported Spotify history, summed over all its plays. */
export interface ListeningHistoryEntry {
  id: string;
  uri?: string;
  name: string;
  artist: string;
  plays: number;
  completions: number;
  earlySkips: number;
  msPlayed: number;
  firstAt: number;
  lastAt: number;
}
export const ListeningHistoryEntry = {};

export type PlayFeedback = 'mais' | 'menos';
export const PlayFeedback = {};

export type PlayOrigin = 'radio' | 'autoplay' | 'organic';
export const PlayOrigin = {};

/** A track NeuralTune actually sent to the player, and what the draw knew when it chose it. */
export interface RadioExposure {
  id: string;
  runId: string;
  radio: string;
  uri: string;
  position: number;
  at: number;
  propensity: number | null;
  source: 'playlist' | 'descoberta';
  newArtist: boolean;
  /** Randomized per run, which is what makes a comparison between arms causal. */
  arm?: RadioArm;
  /** Second, independent coin: whether this radio used past "more/less like this" signals. */
  carry?: boolean;
  score?: number;
}
export const RadioExposure = {};

export type RadioArm = 'padrao' | 'exploratorio';
export const RadioArm = {};

export interface AudioFeatureRecord {
  uri: string;
  features: AcousticFeatures;
  fetchedAt: number;
}
export const AudioFeatureRecord = {};

export interface ArtistBlockRecord {
  artistUri: string;
  artistName: string;
  timestamp: number;
  reason?: string;
}
export const ArtistBlockRecord = {};

export interface VersionBlockRule {
  compositionId?: string;
  trackName: string;
  artistName: string;
  blockAllVersions: boolean;
  blockLiveVersionsOnly: boolean;
  blockRemixesOnly: boolean;
  timestamp: number;
}
export const VersionBlockRule = {};

export interface ComparativeFeedback {
  id: string;
  winnerUri: string;
  loserUri: string;
  timestamp: number;
  context?: string;
}
export const ComparativeFeedback = {};

export interface AttributeWeight {
  weight: number;      // -1.0 to +1.0
  count: number;       // Number of samples observed
  confidence: number;  // 0.0 to 1.0 (based on sample size & bayesian shrinkage)
  variance: number;
}
export const AttributeWeight = {};

export interface PreferenceProfile {
  id: string;
  name: string;
  signalScale?: number;
  attributeWeights: Record<string, AttributeWeight>;
  artistAffinities: Record<string, { score: number; count: number }>;
  explorationFactor: number; // 0.0 (only familiar) to 1.0 (full novelty)
  antiFatigue: {
    minArtistDistance: number;
    recentPenaltyWindow: number;
  };
  userVector?: number[];     // Derived from ratings; rebuilt on load, stored for inspection and export
  vectorSamples?: number;
}
export const PreferenceProfile = {};

export interface QueueStateSummary {
  current?: TrackMetadata;
  queued: TrackMetadata[];
  nextUp: TrackMetadata[];
}
export const QueueStateSummary = {};

export interface ExplanationItem {
  attribute: string;
  impact: number;      // Positive or negative contribution
  description: string;
  source: string;
}
export const ExplanationItem = {};

export interface ScoreComponent {
  key: 'acoustic' | 'bandit' | 'artist' | 'attributes' | 'exploration' | 'avoidance' | 'fatigue' | 'graph' | 'nostalgia';
  label: string;
  points: number;      // Signed contribution to the 0-100 score around the neutral 50
  share: number;       // points / sum of positive points (or of absolute points when none is positive)
}
export const ScoreComponent = {};

export interface PredictionResult {
  track: TrackMetadata;
  score: number;       // 0 to 100
  confidence: number;  // 0 to 1
  eligible: boolean;
  rejectionReason?: string;
  reasons: ExplanationItem[];
  noveltyScore: number;
  breakdown?: ScoreComponent[];
}
export const PredictionResult = {};

export interface RadioParameters {
  genres?: string[];
  minBpm?: number;
  maxBpm?: number;
  minEnergy?: number;
  maxEnergy?: number;
  targetValence?: number;
  eraStart?: number;
  eraEnd?: number;
  instrumentalOnly?: boolean;
  explorationFactor?: number;
  profileId?: string;
  minValence?: number;
  maxValence?: number;
  vocalOnly?: boolean;
}
export const RadioParameters = {};

export interface LoopProtectionConfig {
  maxSkipsInWindow: number;
  windowMs: number;
  maxConsecutiveRemovals: number;
}
export const LoopProtectionConfig = {};
