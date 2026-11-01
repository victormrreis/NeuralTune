import { StorageAdapter } from '../storage/StorageAdapter.ts';
import {
  TrackMetadata,
  ArtistBlockRecord,
  VersionBlockRule
} from '../types/index.ts';

export class BlacklistManager {
  private storage: StorageAdapter;
  private versionRulesCache: VersionBlockRule[] = [];

  constructor(storage: StorageAdapter) {
    this.storage = storage;
  }

  async init(): Promise<void> {
    this.versionRulesCache = await this.storage.getAllVersionRules();
  }

  /**
   * Fast synchronous check for time-critical queue processing.
   * Checks direct track URI and artist URIs in O(1).
   */
  isBlockedFast(uri: string, artistUris: string[]): boolean {
    if (this.storage.isTrackBlocked(uri)) {
      return true;
    }
    for (const aUri of artistUris) {
      if (this.storage.isArtistUriBlocked(aUri)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Comprehensive check including version rules (live, remix, all versions of composition).
   */
  async isTrackBlocked(track: TrackMetadata): Promise<{ blocked: boolean; reason?: string }> {
    // 1. Direct track URI block
    if (this.storage.isTrackBlocked(track.uri)) {
      return { blocked: true, reason: 'Track is in personal blacklist' };
    }

    // 2. Artist block check
    for (const artist of track.artists) {
      if (this.storage.isArtistUriBlocked(artist.uri)) {
        return { blocked: true, reason: `Artist "${artist.name}" is blocked` };
      }
    }

    // 3. Version rules check
    if (this.versionRulesCache.length === 0) {
      this.versionRulesCache = await this.storage.getAllVersionRules();
    }

    const reason = this.matchesVersionRule(track);
    return reason ? { blocked: true, reason } : { blocked: false };
  }

  /** Everything that keeps a track from playing, with no async step. */
  isRejected(track: TrackMetadata): boolean {
    return this.isBlockedFast(track.uri, track.artists.map((a) => a.uri)) || this.matchesVersionRule(track) !== null;
  }

  /** The reason a loaded version rule rejects this track, or null. */
  matchesVersionRule(track: TrackMetadata): string | null {
    const trackNameLower = (track.name ?? '').toLowerCase();
    for (const rule of this.versionRulesCache) {
      const matchArtist = track.artists.some((a) => a.name.toLowerCase() === rule.artistName.toLowerCase());
      if (!matchArtist) continue;

      const ruleTrackLower = rule.trackName.toLowerCase();
      if (!ruleTrackLower) continue;
      const isSameComposition = trackNameLower.includes(ruleTrackLower) || ruleTrackLower.includes(trackNameLower);

      if (isSameComposition) {
        if (rule.blockAllVersions) return `All versions of "${rule.trackName}" are blocked`;
        if (rule.blockLiveVersionsOnly && this.isLiveVersion(track.name)) return `Live version of "${rule.trackName}" is blocked`;
        if (rule.blockRemixesOnly && this.isRemixVersion(track.name)) return `Remix version of "${rule.trackName}" is blocked`;
      }
    }

    return null;
  }

  isLiveVersion(trackName: string): boolean {
    const liveRegex = /\b(live|ao vivo|en vivo|live at|live in|recorded live)\b/i;
    return liveRegex.test(trackName);
  }

  isRemixVersion(trackName: string): boolean {
    const remixRegex = /\b(remix|rmx|club mix|extended mix|dub mix|radio edit)\b/i;
    return remixRegex.test(trackName);
  }

  async blockArtist(artistUri: string, artistName: string, reason?: string): Promise<void> {
    const record: ArtistBlockRecord = {
      artistUri,
      artistName,
      timestamp: Date.now(),
      reason
    };
    await this.storage.blockArtist(record);
  }

  async unblockArtist(artistUri: string): Promise<boolean> {
    return this.storage.unblockArtist(artistUri);
  }

  async addVersionRule(rule: VersionBlockRule): Promise<void> {
    await this.storage.saveVersionRule(rule);
    this.versionRulesCache = await this.storage.getAllVersionRules();
  }

  async removeVersionRule(trackName: string, artistName: string): Promise<boolean> {
    const res = await this.storage.deleteVersionRule(trackName, artistName);
    this.versionRulesCache = await this.storage.getAllVersionRules();
    return res;
  }

  /**
   * Imports legacy TrashBin data from raw objects (e.g. from LocalStorage)
   */
  async importFromTrashBin(
    trashSongList: Record<string, boolean>,
    trashArtistList: Record<string, boolean>
  ): Promise<{ importedSongs: number; importedArtists: number }> {
    let importedSongs = 0;
    let importedArtists = 0;

    for (const [uri, isBanned] of Object.entries(trashSongList)) {
      if (isBanned && uri.startsWith('spotify:track:')) {
        const existing = await this.storage.getRating(uri);
        if (existing?.rating === 0) continue;

        await this.storage.saveRating({
          uri,
          rating: 0,
          timestamp: Date.now(),
          metadata: existing?.metadata ?? {
            uri,
            name: 'Imported from TrashBin',
            artists: [],
            album: { name: '', uri: '' }
          }
        });
        importedSongs++;
      }
    }

    for (const [artistUri, isBanned] of Object.entries(trashArtistList)) {
      if (isBanned && artistUri.startsWith('spotify:artist:')) {
        if (this.storage.isArtistUriBlocked(artistUri)) continue;

        await this.blockArtist(artistUri, 'Unknown Artist', 'Imported from TrashBin');
        importedArtists++;
      }
    }

    return { importedSongs, importedArtists };
  }
}
