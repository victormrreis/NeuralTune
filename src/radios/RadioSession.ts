import { ACOUSTIC_DIMENSION_COUNT, cosineSimilarity, standardize, toAcousticPoint } from '../core/AcousticVector.ts';
import { PlayEvent, QueueStateSummary, TrackMetadata } from '../types/index.ts';

const LOW_WATER_MARK = 3;
const BATCH_SIZE = 5;
const QUEUE_DEPTH = 15;
const MAX_SESSION_TRACKS = 120;
const SKIPS_TO_DROP_ARTIST = 2;
const SKIP_STEER = 0.5;
const STEER_WEIGHT = 1.5;

export type SteerDirection = 1 | -1;
export const SteerDirection = {};

export interface RadioSessionBridge {
  getQueueState(): QueueStateSummary | null;
  addToQueue(tracks: TrackMetadata[]): Promise<void>;
  setQueue(tracks: TrackMetadata[]): Promise<void>;
  /** Re-checks against current ratings and likes: the session can outlive what was true when it began. */
  filterAllowed(tracks: TrackMetadata[]): Promise<TrackMetadata[]>;
  /** More tracks for the same radio, for when the first selection runs out. */
  replenish(excluded: ReadonlySet<string>): Promise<TrackMetadata[]>;
  onSent(tracks: TrackMetadata[]): Promise<void>;
}
export const RadioSessionBridge = {};

/**
 * Keeps a radio going past the tracks sent at the start, and lets what happens during it change what
 * comes next. Ending is the user's: playing anything outside the radio ends the session. Learning here
 * lasts for the session only, since one mood is no evidence about a lasting taste.
 */
export class RadioSession {
  private bridge: RadioSessionBridge;
  private active = false;
  private ticking = false;
  private generation = 0;
  private pending: TrackMetadata[] = [];
  private seen = new Set<string>();
  private known = new Map<string, TrackMetadata>();
  private sent = 0;
  private exhausted = false;
  private direction = new Array<number>(ACOUSTIC_DIMENSION_COUNT).fill(0);
  private droppedArtists = new Set<string>();
  private skipsByArtist = new Map<string, number>();

  constructor(bridge: RadioSessionBridge) {
    this.bridge = bridge;
  }

  isActive(): boolean {
    return this.active;
  }

  /** `tracks` in playing order, of which the first `alreadySent` reached the player. */
  start(tracks: readonly TrackMetadata[], alreadySent: number): void {
    this.generation++;
    this.active = true;
    this.pending = tracks.slice(alreadySent);
    this.seen = new Set(tracks.map((t) => t.uri));
    this.known = new Map(tracks.map((t) => [t.uri, t]));
    this.sent = Math.min(alreadySent, tracks.length);
    this.exhausted = false;
    this.direction.fill(0);
    this.droppedArtists.clear();
    this.skipsByArtist.clear();
  }

  stop(): void {
    this.generation++;
    this.active = false;
    this.pending = [];
  }

  /** A skip counts for half a "less like this", and a second one of an artist drops that artist. */
  observePlay(event: PlayEvent): void {
    if (!this.active || !this.seen.has(event.uri) || !event.skipped) return;

    this.learn(this.known.get(event.uri), -SKIP_STEER);
    for (const artist of event.artistUris) {
      const skips = (this.skipsByArtist.get(artist) ?? 0) + 1;
      this.skipsByArtist.set(artist, skips);
      if (skips >= SKIPS_TO_DROP_ARTIST) this.droppedArtists.add(artist);
    }
  }

  /**
   * Fifteen tracks sit queued ahead, so adjusting only future refills would change nothing for an hour.
   * The waiting tracks are ranked again and the queue replaced. Tracks the user queued by hand stay first.
   */
  async steer(track: TrackMetadata, direction: SteerDirection): Promise<boolean> {
    if (!this.active) return false;

    this.learn(this.known.get(track.uri) ?? track, direction);
    if (direction < 0) {
      for (const artist of track.artists) this.droppedArtists.add(artist.uri);
    }

    const queued = this.bridge.getQueueState()?.queued ?? [];
    const manual = queued.filter((t) => !this.known.has(t.uri));
    const waiting = queued.flatMap((t) => this.known.get(t.uri) ?? []).filter((t) => t.uri !== track.uri);

    const ranked = this.rank([...waiting, ...this.pending].filter((t) => t.uri !== track.uri));
    const room = Math.max(0, QUEUE_DEPTH - manual.length);
    this.pending = ranked.slice(room);
    await this.bridge.setQueue([...manual, ...ranked.slice(0, room)]);
    return true;
  }

  /** Runs on song and queue changes. Reentrant calls are dropped: the running tick sees the same state. */
  async tick(): Promise<number> {
    if (!this.active || this.ticking) return 0;

    const state = this.bridge.getQueueState();
    if (!state) return 0;

    if (state.current && !this.seen.has(state.current.uri)) {
      this.stop();
      return 0;
    }
    if (state.queued.length >= LOW_WATER_MARK || this.sent >= MAX_SESSION_TRACKS) return 0;

    this.ticking = true;
    const generation = this.generation;

    try {
      if (this.pending.length < BATCH_SIZE && !this.exhausted) {
        const fresh = (await this.bridge.replenish(new Set(this.seen))).filter((t) => !this.seen.has(t.uri));
        if (generation !== this.generation) return 0;

        if (fresh.length === 0) this.exhausted = true;
        for (const track of fresh) {
          this.seen.add(track.uri);
          this.known.set(track.uri, track);
        }
        this.pending.push(...fresh);
      }

      const ranked = this.rank(this.pending);
      const allowed = await this.bridge.filterAllowed(ranked.slice(0, BATCH_SIZE * 2));
      if (generation !== this.generation) return 0;

      const batch = allowed.slice(0, BATCH_SIZE);
      const consumed = new Set(ranked.slice(0, BATCH_SIZE * 2).map((t) => t.uri));
      for (const track of allowed.slice(BATCH_SIZE)) consumed.delete(track.uri);
      this.pending = ranked.filter((t) => !consumed.has(t.uri));
      if (batch.length === 0) return 0;

      await this.bridge.addToQueue(batch);
      this.sent += batch.length;
      await this.bridge.onSent(batch);
      return batch.length;
    } catch (err) {
      console.warn('[NeuralTune] Rádio contínua: não foi possível repor a fila', err);
      return 0;
    } finally {
      this.ticking = false;
    }
  }

  private learn(track: TrackMetadata | undefined, amount: number): void {
    const point = toAcousticPoint(track?.acousticFeatures);
    if (!point) return;
    standardize(point.values).forEach((value, i) => {
      if (point.known[i]) this.direction[i] += amount * value;
    });
  }

  /** The original order is the ranker's verdict, and steering bends it instead of replacing it. */
  private rank(tracks: readonly TrackMetadata[]): TrackMetadata[] {
    const steered = this.direction.some((value) => value !== 0);

    return tracks
      .filter((t) => !t.artists.some((a) => this.droppedArtists.has(a.uri)))
      .map((track, index) => {
        const point = steered ? toAcousticPoint(track.acousticFeatures) : null;
        const match = point ? cosineSimilarity(standardize(point.values), this.direction) : 0;
        return { track, value: -index / Math.max(1, tracks.length) + STEER_WEIGHT * match };
      })
      .sort((a, b) => b.value - a.value)
      .map((item) => item.track);
  }
}
