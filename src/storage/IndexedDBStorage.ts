import { StorageAdapter } from './StorageAdapter.ts';
import { MemoryStorage } from './MemoryStorage.ts';
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

const DB_NAME = 'NeuralTuneDB';
const DB_VERSION = 2;

// Its own database on purpose: raising DB_VERSION would stop a restored older bundle from opening the
// ratings at all, and it would silently fall back to empty memory
const EXPOSURE_DB_NAME = 'NeuralTuneExposureDB';
const EXPOSURE_STORE = 'radio_exposures';
const HISTORY_DB_NAME = 'NeuralTuneHistoryDB';
const HISTORY_STORE = 'listening_history';

const STORES = {
  RATINGS: 'ratings',
  BLOCKED_ARTISTS: 'blocked_artists',
  VERSION_RULES: 'version_rules',
  FEEDBACK: 'comparative_feedback',
  PROFILES: 'profiles',
  PLAY_EVENTS: 'play_events',
  AUDIO_FEATURES: 'audio_features'
} as const;

export class IndexedDBStorage implements StorageAdapter {
  private db: IDBDatabase | null = null;
  private exposureDb: IDBDatabase | null = null;
  private historyDb: IDBDatabase | null = null;
  private memoryFallback: MemoryStorage = new MemoryStorage();
  private isBrowser = typeof window !== 'undefined' && typeof indexedDB !== 'undefined';

  // Fast In-Memory Set caches for synchronous O(1) checks
  private blockedTrackUris = new Set<string>();
  private blockedArtistUris = new Set<string>();

  async init(): Promise<void> {
    if (!this.isBrowser) {
      await this.memoryFallback.init();
      return;
    }

    this.exposureDb = await this.openSideDb(EXPOSURE_DB_NAME, EXPOSURE_STORE);
    this.historyDb = await this.openSideDb(HISTORY_DB_NAME, HISTORY_STORE);

    return new Promise((resolve) => {
      try {
        const req = indexedDB.open(DB_NAME, DB_VERSION);

        req.onupgradeneeded = (e) => {
          const db = (e.target as IDBOpenDBRequest).result;
          if (!db.objectStoreNames.contains(STORES.RATINGS)) {
            db.createObjectStore(STORES.RATINGS, { keyPath: 'uri' });
          }
          if (!db.objectStoreNames.contains(STORES.BLOCKED_ARTISTS)) {
            db.createObjectStore(STORES.BLOCKED_ARTISTS, { keyPath: 'artistUri' });
          }
          if (!db.objectStoreNames.contains(STORES.VERSION_RULES)) {
            db.createObjectStore(STORES.VERSION_RULES, { keyPath: ['artistName', 'trackName'] });
          }
          if (!db.objectStoreNames.contains(STORES.FEEDBACK)) {
            db.createObjectStore(STORES.FEEDBACK, { keyPath: 'id' });
          }
          if (!db.objectStoreNames.contains(STORES.PROFILES)) {
            db.createObjectStore(STORES.PROFILES, { keyPath: 'id' });
          }
          if (!db.objectStoreNames.contains(STORES.PLAY_EVENTS)) {
            db.createObjectStore(STORES.PLAY_EVENTS, { keyPath: 'id' }).createIndex('startedAt', 'startedAt');
          }
          if (!db.objectStoreNames.contains(STORES.AUDIO_FEATURES)) {
            db.createObjectStore(STORES.AUDIO_FEATURES, { keyPath: 'uri' });
          }
        };

        req.onsuccess = async () => {
          this.db = req.result;
          // A reloaded page holding the old version must not block a future upgrade
          this.db.onversionchange = () => this.db?.close();
          await this.populateCache();
          resolve();
        };

        req.onerror = () => {
          console.warn('[NeuralTune] IndexedDB open error, using memory fallback');
          resolve();
        };
      } catch (err) {
        console.warn('[NeuralTune] IndexedDB initialization error, using memory fallback', err);
        resolve();
      }
    });
  }

  /** Separate databases, so these never force a version change on the one holding the ratings. */
  private openSideDb(name: string, store: string): Promise<IDBDatabase | null> {
    return new Promise((resolve) => {
      try {
        const req = indexedDB.open(name, 1);
        req.onupgradeneeded = () => {
          req.result.createObjectStore(store, { keyPath: 'id' });
        };
        req.onsuccess = () => {
          req.result.onversionchange = () => req.result.close();
          resolve(req.result);
        };
        req.onerror = () => resolve(null);
      } catch (err) {
        console.warn('[NeuralTune] Banco auxiliar indisponível', name, err);
        resolve(null);
      }
    });
  }

  private async populateCache(): Promise<void> {
    if (!this.db) return;
    try {
      const ratings = await this.getAllRatings();
      for (const r of ratings) {
        if (r.rating === 0) {
          this.blockedTrackUris.add(r.uri);
        }
      }
      const artists = await this.getAllBlockedArtists();
      for (const a of artists) {
        this.blockedArtistUris.add(a.artistUri);
      }
    } catch (err) {
      console.error('[NeuralTune] Error populating cache from IndexedDB', err);
    }
  }

  async saveRating(record: TrackRatingRecord): Promise<void> {
    if (record.rating === 0) {
      this.blockedTrackUris.add(record.uri);
    } else {
      this.blockedTrackUris.delete(record.uri);
    }

    if (!this.db) {
      return this.memoryFallback.saveRating(record);
    }

    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction(STORES.RATINGS, 'readwrite');
      tx.objectStore(STORES.RATINGS).put(record);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async getRating(uri: string): Promise<TrackRatingRecord | null> {
    if (!this.db) {
      return this.memoryFallback.getRating(uri);
    }

    return new Promise((resolve) => {
      const tx = this.db!.transaction(STORES.RATINGS, 'readonly');
      const req = tx.objectStore(STORES.RATINGS).get(uri);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    });
  }

  async getAllRatings(): Promise<TrackRatingRecord[]> {
    if (!this.db) {
      return this.memoryFallback.getAllRatings();
    }

    return new Promise((resolve) => {
      const tx = this.db!.transaction(STORES.RATINGS, 'readonly');
      const req = tx.objectStore(STORES.RATINGS).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => resolve([]);
    });
  }

  async deleteRating(uri: string): Promise<boolean> {
    this.blockedTrackUris.delete(uri);
    if (!this.db) {
      return this.memoryFallback.deleteRating(uri);
    }

    return new Promise((resolve) => {
      const tx = this.db!.transaction(STORES.RATINGS, 'readwrite');
      const req = tx.objectStore(STORES.RATINGS).delete(uri);
      req.onsuccess = () => resolve(true);
      req.onerror = () => resolve(false);
    });
  }

  async blockArtist(record: ArtistBlockRecord): Promise<void> {
    this.blockedArtistUris.add(record.artistUri);
    if (!this.db) {
      return this.memoryFallback.blockArtist(record);
    }

    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction(STORES.BLOCKED_ARTISTS, 'readwrite');
      tx.objectStore(STORES.BLOCKED_ARTISTS).put(record);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async unblockArtist(artistUri: string): Promise<boolean> {
    this.blockedArtistUris.delete(artistUri);
    if (!this.db) {
      return this.memoryFallback.unblockArtist(artistUri);
    }

    return new Promise((resolve) => {
      const tx = this.db!.transaction(STORES.BLOCKED_ARTISTS, 'readwrite');
      const req = tx.objectStore(STORES.BLOCKED_ARTISTS).delete(artistUri);
      req.onsuccess = () => resolve(true);
      req.onerror = () => resolve(false);
    });
  }

  async isArtistBlocked(artistUri: string): Promise<boolean> {
    return this.blockedArtistUris.has(artistUri);
  }

  async getAllBlockedArtists(): Promise<ArtistBlockRecord[]> {
    if (!this.db) {
      return this.memoryFallback.getAllBlockedArtists();
    }

    return new Promise((resolve) => {
      const tx = this.db!.transaction(STORES.BLOCKED_ARTISTS, 'readonly');
      const req = tx.objectStore(STORES.BLOCKED_ARTISTS).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => resolve([]);
    });
  }

  async saveVersionRule(rule: VersionBlockRule): Promise<void> {
    if (!this.db) {
      return this.memoryFallback.saveVersionRule(rule);
    }

    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction(STORES.VERSION_RULES, 'readwrite');
      tx.objectStore(STORES.VERSION_RULES).put(rule);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async getAllVersionRules(): Promise<VersionBlockRule[]> {
    if (!this.db) {
      return this.memoryFallback.getAllVersionRules();
    }

    return new Promise((resolve) => {
      const tx = this.db!.transaction(STORES.VERSION_RULES, 'readonly');
      const req = tx.objectStore(STORES.VERSION_RULES).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => resolve([]);
    });
  }

  async deleteVersionRule(trackName: string, artistName: string): Promise<boolean> {
    if (!this.db) {
      return this.memoryFallback.deleteVersionRule(trackName, artistName);
    }

    return new Promise((resolve) => {
      const tx = this.db!.transaction(STORES.VERSION_RULES, 'readwrite');
      const req = tx.objectStore(STORES.VERSION_RULES).delete([artistName, trackName]);
      req.onsuccess = () => resolve(true);
      req.onerror = () => resolve(false);
    });
  }

  async saveComparativeFeedback(feedback: ComparativeFeedback): Promise<void> {
    if (!this.db) {
      return this.memoryFallback.saveComparativeFeedback(feedback);
    }

    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction(STORES.FEEDBACK, 'readwrite');
      tx.objectStore(STORES.FEEDBACK).put(feedback);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async getAllComparativeFeedbacks(): Promise<ComparativeFeedback[]> {
    if (!this.db) {
      return this.memoryFallback.getAllComparativeFeedbacks();
    }

    return new Promise((resolve) => {
      const tx = this.db!.transaction(STORES.FEEDBACK, 'readonly');
      const req = tx.objectStore(STORES.FEEDBACK).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => resolve([]);
    });
  }

  async saveProfile(profile: PreferenceProfile): Promise<void> {
    if (!this.db) {
      return this.memoryFallback.saveProfile(profile);
    }

    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction(STORES.PROFILES, 'readwrite');
      tx.objectStore(STORES.PROFILES).put(profile);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async getProfile(id: string): Promise<PreferenceProfile | null> {
    if (!this.db) {
      return this.memoryFallback.getProfile(id);
    }

    return new Promise((resolve) => {
      const tx = this.db!.transaction(STORES.PROFILES, 'readonly');
      const req = tx.objectStore(STORES.PROFILES).get(id);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    });
  }

  async getAllProfiles(): Promise<PreferenceProfile[]> {
    if (!this.db) {
      return this.memoryFallback.getAllProfiles();
    }

    return new Promise((resolve) => {
      const tx = this.db!.transaction(STORES.PROFILES, 'readonly');
      const req = tx.objectStore(STORES.PROFILES).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => resolve([]);
    });
  }

  async savePlayEvent(event: PlayEvent): Promise<void> {
    if (!this.db) {
      return this.memoryFallback.savePlayEvent(event);
    }

    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction(STORES.PLAY_EVENTS, 'readwrite');
      tx.objectStore(STORES.PLAY_EVENTS).put(event);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async getAllPlayEvents(): Promise<PlayEvent[]> {
    if (!this.db) {
      return this.memoryFallback.getAllPlayEvents();
    }

    return new Promise((resolve) => {
      const tx = this.db!.transaction(STORES.PLAY_EVENTS, 'readonly');
      const req = tx.objectStore(STORES.PLAY_EVENTS).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => resolve([]);
    });
  }

  async getPlayEventsSince(timestamp: number): Promise<PlayEvent[]> {
    if (!this.db) {
      return this.memoryFallback.getPlayEventsSince(timestamp);
    }

    return new Promise((resolve) => {
      const tx = this.db!.transaction(STORES.PLAY_EVENTS, 'readonly');
      const index = tx.objectStore(STORES.PLAY_EVENTS).index('startedAt');
      const req = index.getAll(IDBKeyRange.lowerBound(timestamp));
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => resolve([]);
    });
  }

  async saveAudioFeatures(records: AudioFeatureRecord[]): Promise<void> {
    if (!this.db) {
      return this.memoryFallback.saveAudioFeatures(records);
    }

    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction(STORES.AUDIO_FEATURES, 'readwrite');
      const store = tx.objectStore(STORES.AUDIO_FEATURES);
      for (const record of records) {
        store.put(record);
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async getAllAudioFeatures(): Promise<AudioFeatureRecord[]> {
    if (!this.db) {
      return this.memoryFallback.getAllAudioFeatures();
    }

    return new Promise((resolve) => {
      const tx = this.db!.transaction(STORES.AUDIO_FEATURES, 'readonly');
      const req = tx.objectStore(STORES.AUDIO_FEATURES).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => resolve([]);
    });
  }

  async saveExposures(records: RadioExposure[]): Promise<void> {
    if (!this.exposureDb) {
      return this.memoryFallback.saveExposures(records);
    }

    return new Promise((resolve, reject) => {
      const tx = this.exposureDb!.transaction(EXPOSURE_STORE, 'readwrite');
      const store = tx.objectStore(EXPOSURE_STORE);
      for (const record of records) {
        store.put(record);
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async getAllExposures(): Promise<RadioExposure[]> {
    if (!this.exposureDb) {
      return this.memoryFallback.getAllExposures();
    }

    return new Promise((resolve) => {
      const tx = this.exposureDb!.transaction(EXPOSURE_STORE, 'readonly');
      const req = tx.objectStore(EXPOSURE_STORE).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => resolve([]);
    });
  }

  async saveHistory(entries: ListeningHistoryEntry[]): Promise<void> {
    if (!this.historyDb) {
      return this.memoryFallback.saveHistory(entries);
    }

    return new Promise((resolve, reject) => {
      const tx = this.historyDb!.transaction(HISTORY_STORE, 'readwrite');
      const store = tx.objectStore(HISTORY_STORE);
      for (const entry of entries) {
        store.put(entry);
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async getAllHistory(): Promise<ListeningHistoryEntry[]> {
    if (!this.historyDb) {
      return this.memoryFallback.getAllHistory();
    }

    return new Promise((resolve) => {
      const tx = this.historyDb!.transaction(HISTORY_STORE, 'readonly');
      const req = tx.objectStore(HISTORY_STORE).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => resolve([]);
    });
  }

  isTrackBlocked(uri: string): boolean {
    return this.blockedTrackUris.has(uri);
  }

  isArtistUriBlocked(artistUri: string): boolean {
    return this.blockedArtistUris.has(artistUri);
  }

  async exportAllData(): Promise<Record<string, unknown>> {
    const ratings = await this.getAllRatings();
    const blockedArtists = await this.getAllBlockedArtists();
    const versionRules = await this.getAllVersionRules();
    const comparativeFeedbacks = await this.getAllComparativeFeedbacks();
    const profiles = await this.getAllProfiles();
    const playEvents = await this.getAllPlayEvents();

    return {
      version: 1,
      exportedAt: Date.now(),
      ratings,
      blockedArtists,
      versionRules,
      comparativeFeedbacks,
      profiles,
      playEvents
    };
  }

  async importAllData(
    data: Record<string, unknown>,
    mergeMode: 'overwrite' | 'merge' = 'merge'
  ): Promise<{ importedRatings: number; importedArtists: number }> {
    if (!this.db) {
      return this.memoryFallback.importAllData(data, mergeMode);
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
