import { artistIdentity, songKeys } from '../core/SongIdentity.ts';
import { COUNTED_PLAY_MS } from '../core/PlaybackHistoryTracker.ts';
import { ListeningHistoryEntry, PlayEvent, TrackMetadata } from '../types/index.ts';

/**
 * What the user has already heard, from the plays recorded here and the imported history. Kept in
 * memory and updated in place: every radio asks, and history can hold tens of thousands of tracks.
 */
export class HeardLedger {
  private uris = new Set<string>();
  private keys = new Set<string>();
  private artists = new Set<string>();

  get size(): number {
    return this.uris.size;
  }

  addPlay({ uri, name, artistNames, playedMs }: PlayEvent): void {
    if (playedMs < COUNTED_PLAY_MS) return;

    this.uris.add(uri);
    this.addSong(name, artistNames ?? []);
  }

  addHistory({ uri, name, artist, msPlayed }: ListeningHistoryEntry): void {
    if (msPlayed < COUNTED_PLAY_MS) return;

    if (uri) this.uris.add(uri);
    this.addSong(name, [artist]);
  }

  private addSong(name: string, artists: readonly string[]): void {
    const credited = artists.map((artist) => ({ name: artist }));
    for (const key of songKeys({ name, artists: credited })) this.keys.add(key);
    for (const artist of credited) this.artists.add(artistIdentity(artist));
  }

  isHeard(track: TrackMetadata): boolean {
    return this.uris.has(track.uri) || songKeys(track).some((key) => this.keys.has(key));
  }

  knowsArtist(track: TrackMetadata): boolean {
    return track.artists.some((artist) => this.artists.has(artistIdentity(artist)));
  }
}
