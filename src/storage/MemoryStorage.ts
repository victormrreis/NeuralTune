import { StorageAdapter } from './StorageAdapter.ts';
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

export class MemoryStorage implements StorageAdapter {
  private ratings = new Map<string, TrackRatingRecord>();
  private blockedArtists = new Map<string, ArtistBlockRecord>();
  private versionRules = new Map<string, VersionBlockRule>();
  private comparativeFeedbacks: ComparativeFeedback[] = [];
  private profiles = new Map<string, PreferenceProfile>();
  private playEvents = new Map<string, PlayEvent>();
  private audioFeatures = new Map<string, AudioFeatureRecord>();
  private exposures = new Map<string, RadioExposure>();
  private history = new Map<string, ListeningHistoryEntry>();

  // In-memory Fast O(1) Sets
  private blockedTrackUris = new Set<string>();
  private blockedArtistUris = new Set<string>();

  async init(): Promise<void> {
    // In-memory does not require async setup
  }

  async saveRating(record: TrackRatingRecord): Promise<void> {
    this.ratings.set(record.uri, record);
    if (record.rating === 0) {
      this.blockedTrackUris.add(record.uri);
    } else {
      this.blockedTrackUris.delete(record.uri);
    }
  }

  async getRating(uri: string): Promise<TrackRatingRecord | null> {
    return this.ratings.get(uri) || null;
  }

  async getAllRatings(): Promise<TrackRatingRecord[]> {
    return Array.from(this.ratings.values());
  }

  async deleteRating(uri: string): Promise<boolean> {
    this.blockedTrackUris.delete(uri);
    return this.ratings.delete(uri);
  }

  async blockArtist(record: ArtistBlockRecord): Promise<void> {
    this.blockedArtists.set(record.artistUri, record);
    this.blockedArtistUris.add(record.artistUri);
  }

  async unblockArtist(artistUri: string): Promise<boolean> {
    this.blockedArtistUris.delete(artistUri);
    return this.blockedArtists.delete(artistUri);
  }

  async isArtistBlocked(artistUri: string): Promise<boolean> {
    return this.blockedArtistUris.has(artistUri);
  }

  async getAllBlockedArtists(): Promise<ArtistBlockRecord[]> {
    return Array.from(this.blockedArtists.values());
  }

  async saveVersionRule(rule: VersionBlockRule): Promise<void> {
    const key = `${rule.artistName.toLowerCase()}:::${rule.trackName.toLowerCase()}`;
    this.versionRules.set(key, rule);
  }

  async getAllVersionRules(): Promise<VersionBlockRule[]> {
    return Array.from(this.versionRules.values());
  }

  async deleteVersionRule(trackName: string, artistName: string): Promise<boolean> {
    const key = `${artistName.toLowerCase()}:::${trackName.toLowerCase()}`;
    return this.versionRules.delete(key);
  }

  async saveComparativeFeedback(feedback: ComparativeFeedback): Promise<void> {
    this.comparativeFeedbacks.push(feedback);
  }

  async getAllComparativeFeedbacks(): Promise<ComparativeFeedback[]> {
    return [...this.comparativeFeedbacks];
  }

  async saveProfile(profile: PreferenceProfile): Promise<void> {
    this.profiles.set(profile.id, profile);
  }

  async getProfile(id: string): Promise<PreferenceProfile | null> {
    return this.profiles.get(id) || null;
  }

  async getAllProfiles(): Promise<PreferenceProfile[]> {
    return Array.from(this.profiles.values());
  }

  async savePlayEvent(event: PlayEvent): Promise<void> {
    this.playEvents.set(event.id, event);
  }

  async getAllPlayEvents(): Promise<PlayEvent[]> {
    return Array.from(this.playEvents.values());
  }

  async getPlayEventsSince(timestamp: number): Promise<PlayEvent[]> {
    return Array.from(this.playEvents.values()).filter((e) => e.startedAt >= timestamp);
  }

  async saveAudioFeatures(records: AudioFeatureRecord[]): Promise<void> {
    for (const record of records) {
      this.audioFeatures.set(record.uri, record);
    }
  }

  async getAllAudioFeatures(): Promise<AudioFeatureRecord[]> {
    return Array.from(this.audioFeatures.values());
  }

  async saveExposures(records: RadioExposure[]): Promise<void> {
    for (const record of records) {
      this.exposures.set(record.id, record);
    }
  }

  async getAllExposures(): Promise<RadioExposure[]> {
    return Array.from(this.exposures.values());
  }

  async saveHistory(entries: ListeningHistoryEntry[]): Promise<void> {
    for (const entry of entries) {
      this.history.set(entry.id, entry);
    }
  }

  async getAllHistory(): Promise<ListeningHistoryEntry[]> {
    return Array.from(this.history.values());
  }

  isTrackBlocked(uri: string): boolean {
    return this.blockedTrackUris.has(uri);
  }

  isArtistUriBlocked(artistUri: string): boolean {
    return this.blockedArtistUris.has(artistUri);
  }

  async exportAllData(): Promise<Record<string, unknown>> {
    return {
      version: 1,
      exportedAt: Date.now(),
      ratings: Array.from(this.ratings.values()),
      blockedArtists: Array.from(this.blockedArtists.values()),
      versionRules: Array.from(this.versionRules.values()),
      comparativeFeedbacks: this.comparativeFeedbacks,
      profiles: Array.from(this.profiles.values()),
      playEvents: Array.from(this.playEvents.values()),
    };
  }

  async importAllData(
    data: Record<string, unknown>,
    mergeMode: 'overwrite' | 'merge' = 'merge'
  ): Promise<{ importedRatings: number; importedArtists: number }> {
    if (mergeMode === 'overwrite') {
      this.ratings.clear();
      this.blockedArtists.clear();
      this.versionRules.clear();
      this.comparativeFeedbacks = [];
      this.profiles.clear();
      this.blockedTrackUris.clear();
      this.blockedArtistUris.clear();
    }

    let importedRatings = 0;
    let importedArtists = 0;

    if (Array.isArray(data.ratings)) {
      for (const r of data.ratings as TrackRatingRecord[]) {
        if (r && r.uri && typeof r.rating === 'number') {
          await this.saveRating(r);
          importedRatings++;
        }
      }
    }

    if (Array.isArray(data.blockedArtists)) {
      for (const a of data.blockedArtists as ArtistBlockRecord[]) {
        if (a && a.artistUri) {
          await this.blockArtist(a);
          importedArtists++;
        }
      }
    }

    return { importedRatings, importedArtists };
  }
}
