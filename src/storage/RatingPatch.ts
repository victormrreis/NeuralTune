import { StorageAdapter } from './StorageAdapter.ts';
import { TrackMetadata } from '../types/index.ts';

/**
 * Updates what is known about a rated track without touching the rating. Slow background work must
 * call this instead of saving a record read earlier: the user may have rated, blocked or removed the
 * track in the meantime, and a stale record would silently undo that. Returns false if it is gone.
 */
export async function patchRatingMetadata(
  storage: StorageAdapter,
  uri: string,
  patch: (metadata: TrackMetadata) => TrackMetadata
): Promise<boolean> {
  const live = await storage.getRating(uri);
  if (!live) return false;

  await storage.saveRating({ ...live, metadata: patch(live.metadata) });
  return true;
}
