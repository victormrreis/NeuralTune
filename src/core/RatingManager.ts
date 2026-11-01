import { StorageAdapter } from '../storage/StorageAdapter.ts';
import { Rating, TrackMetadata, TrackRatingRecord } from '../types/index.ts';

export type RatingChangeCallback = (record: TrackRatingRecord, previousRecord: TrackRatingRecord | null) => void;

interface HistoryAction {
  type: 'rate' | 'delete';
  record: TrackRatingRecord;
  previousRecord: TrackRatingRecord | null;
}

export class RatingManager {
  private storage: StorageAdapter;
  private changeListeners: Set<RatingChangeCallback> = new Set();
  private undoStack: HistoryAction[] = [];
  private redoStack: HistoryAction[] = [];
  private pendingByUri = new Map<string, Promise<unknown>>();

  constructor(storage: StorageAdapter) {
    this.storage = storage;
  }

  onRatingChange(callback: RatingChangeCallback): () => void {
    this.changeListeners.add(callback);
    return () => this.changeListeners.delete(callback);
  }

  private notifyListeners(record: TrackRatingRecord, previous: TrackRatingRecord | null) {
    for (const listener of this.changeListeners) {
      try {
        const outcome: unknown = listener(record, previous);
        if (outcome instanceof Promise) {
          outcome.catch((err) => console.error('[NeuralTune] Error in rating change listener', err));
        }
      } catch (err) {
        console.error('[NeuralTune] Error in rating change listener', err);
      }
    }
  }

  /** Each change reads the record the one before it wrote. A failed change does not stop the next. */
  private serialize<T>(uri: string, work: () => Promise<T>): Promise<T> {
    const run = (this.pendingByUri.get(uri) ?? Promise.resolve()).then(work);
    const settled: Promise<unknown> = run.catch(() => undefined).finally(() => {
      if (this.pendingByUri.get(uri) === settled) this.pendingByUri.delete(uri);
    });
    this.pendingByUri.set(uri, settled);
    return run;
  }

  rateTrack(
    track: TrackMetadata,
    rating: Rating,
    manualOverride: boolean = false
  ): Promise<TrackRatingRecord> {
    return this.serialize(track.uri, () => this.applyRating(track, rating, manualOverride));
  }

  private async applyRating(track: TrackMetadata, rating: Rating, manualOverride: boolean): Promise<TrackRatingRecord> {
    const existing = await this.storage.getRating(track.uri);

    const record: TrackRatingRecord = {
      uri: track.uri,
      rating,
      timestamp: Date.now(),
      metadata: track,
      manualOverride
    };

    await this.storage.saveRating(record);

    this.undoStack.push({
      type: 'rate',
      record,
      previousRecord: existing
    });
    this.redoStack = []; // Clear redo stack on new action

    this.notifyListeners(record, existing);
    return record;
  }

  /** A bulk change bypasses this class: undoing across it would restore records from before the change. */
  clearHistory(): void {
    this.undoStack = [];
    this.redoStack = [];
  }

  async getRating(uri: string): Promise<TrackRatingRecord | null> {
    return this.storage.getRating(uri);
  }

  deleteRating(uri: string): Promise<boolean> {
    return this.serialize(uri, () => this.applyDeletion(uri));
  }

  private async applyDeletion(uri: string): Promise<boolean> {
    const existing = await this.storage.getRating(uri);
    if (!existing) return false;

    const deleted = await this.storage.deleteRating(uri);
    if (deleted) {
      this.undoStack.push({
        type: 'delete',
        record: existing,
        previousRecord: existing
      });
      this.redoStack = [];

      this.notifyListeners({
        ...existing,
        rating: 3, // Treat deletion as neutral notification
        timestamp: Date.now(),
        removed: true
      }, existing);
    }
    return deleted;
  }

  async undo(): Promise<boolean> {
    const action = this.undoStack.pop();
    if (!action) return false;

    this.redoStack.push(action);

    await this.serialize(action.record.uri, async () => {
      if (action.previousRecord) {
        await this.storage.saveRating(action.previousRecord);
        // Undoing a deletion brings a rating back: nothing is in place for it to replace
        this.notifyListeners(action.previousRecord, action.type === 'delete' ? null : action.record);
      } else {
        await this.storage.deleteRating(action.record.uri);
        this.notifyListeners({
          ...action.record,
          rating: 3,
          timestamp: Date.now(),
          removed: true
        }, action.record);
      }
    });

    return true;
  }

  async redo(): Promise<boolean> {
    const action = this.redoStack.pop();
    if (!action) return false;

    this.undoStack.push(action);

    await this.serialize(action.record.uri, async () => {
      if (action.type === 'rate') {
        await this.storage.saveRating(action.record);
        this.notifyListeners(action.record, action.previousRecord);
      } else if (action.type === 'delete') {
        await this.storage.deleteRating(action.record.uri);
        this.notifyListeners({
          ...action.record,
          rating: 3,
          timestamp: Date.now(),
          removed: true
        }, action.record);
      }
    });

    return true;
  }

  async getAllRatings(): Promise<TrackRatingRecord[]> {
    return this.storage.getAllRatings();
  }

  async getRatingsDistribution(): Promise<Record<Rating, number>> {
    const all = await this.storage.getAllRatings();
    const dist: Record<Rating, number> = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    for (const r of all) {
      if (r.rating in dist) {
        dist[r.rating]++;
      }
    }
    return dist;
  }
}
