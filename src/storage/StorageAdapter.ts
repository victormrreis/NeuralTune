import {
  TrackRatingRecord,
  ArtistBlockRecord,
  VersionBlockRule,
  ComparativeFeedback,
  PreferenceProfile,
  PlayEvent,
  AudioFeatureRecord,
  RadioExposure,
  ListeningHistoryEntry
} from '../types/index.ts';

export interface StorageAdapter {
  init(): Promise<void>;
  
  // Ratings
  saveRating(record: TrackRatingRecord): Promise<void>;
  getRating(uri: string): Promise<TrackRatingRecord | null>;
  getAllRatings(): Promise<TrackRatingRecord[]>;
  deleteRating(uri: string): Promise<boolean>;

  // Artist Blacklist
  blockArtist(record: ArtistBlockRecord): Promise<void>;
  unblockArtist(artistUri: string): Promise<boolean>;
  isArtistBlocked(artistUri: string): Promise<boolean>;
  getAllBlockedArtists(): Promise<ArtistBlockRecord[]>;

  // Version Rules
  saveVersionRule(rule: VersionBlockRule): Promise<void>;
  getAllVersionRules(): Promise<VersionBlockRule[]>;
  deleteVersionRule(trackName: string, artistName: string): Promise<boolean>;

  // Comparative Feedback
  saveComparativeFeedback(feedback: ComparativeFeedback): Promise<void>;
  getAllComparativeFeedbacks(): Promise<ComparativeFeedback[]>;

  // Preference Profiles
  saveProfile(profile: PreferenceProfile): Promise<void>;
  getProfile(id: string): Promise<PreferenceProfile | null>;
  getAllProfiles(): Promise<PreferenceProfile[]>;

  // Playback History
  savePlayEvent(event: PlayEvent): Promise<void>;
  getAllPlayEvents(): Promise<PlayEvent[]>;
  getPlayEventsSince(timestamp: number): Promise<PlayEvent[]>;

  // Audio Feature Cache
  saveAudioFeatures(records: AudioFeatureRecord[]): Promise<void>;
  getAllAudioFeatures(): Promise<AudioFeatureRecord[]>;

  // Radio Exposure Log
  saveExposures(records: RadioExposure[]): Promise<void>;
  getAllExposures(): Promise<RadioExposure[]>;

  // Imported Listening History
  saveHistory(entries: ListeningHistoryEntry[]): Promise<void>;
  getAllHistory(): Promise<ListeningHistoryEntry[]>;

  // Export / Import
  exportAllData(): Promise<Record<string, unknown>>;
  importAllData(data: Record<string, unknown>, mergeMode?: 'overwrite' | 'merge'): Promise<{ importedRatings: number; importedArtists: number }>;

  // Fast In-Memory Set queries (O(1))
  isTrackBlocked(uri: string): boolean;
  isArtistUriBlocked(artistUri: string): boolean;
}

export const StorageAdapter = {};
