const BACKUP_PREFIX = 'neuraltune-backup-';
const BACKUP_SUFFIX = '.json';
const BACKUP_INTERVAL_MS = 7 * 24 * 3_600_000;
const KEEP_BACKUPS = 8;
const STATUS_KEY = 'neuraltune:backup-status';

// A much smaller export than the last one means something is wrong here, not that history shrank
const MIN_SHARE_OF_LAST = 0.5;

export interface BackupFolder {
  write(name: string, content: string): Promise<void>;
  read(name: string): Promise<string>;
  list(): Promise<string[]>;
  remove(name: string): Promise<void>;
}
export const BackupFolder = {};

export interface BackupStatus {
  lastAt: string | null;
  lastFile: string | null;
  ratings: number;
  /** Largest export so far. A shrunken run must not lower it, or the next run would look normal. */
  peakRatings: number;
  error: string | null;
}
export const BackupStatus = {};

export interface AutoBackupDeps {
  folder: () => Promise<BackupFolder | null>;
  snapshot: () => Promise<string>;
  store: { get(key: string): string | null; set(key: string, value: string): void };
  now?: () => number;
}
export const AutoBackupDeps = {};

function ratingCount(json: string): number | null {
  const data: unknown = JSON.parse(json);
  const ratings = (data as { ratings?: unknown } | null)?.ratings;
  return Array.isArray(ratings) ? ratings.length : null;
}

/**
 * Old copies are removed only after the new one was read back and matched, and never because of a
 * suspicious export: a run that hits an emptied database must not rotate the good backups away.
 */
export class AutoBackup {
  private deps: AutoBackupDeps;
  private now: () => number;

  constructor(deps: AutoBackupDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
  }

  getStatus(): BackupStatus {
    try {
      const stored = JSON.parse(this.deps.store.get(STATUS_KEY) ?? 'null') as BackupStatus | null;
      if (stored) return stored;
    } catch {}
    return { lastAt: null, lastFile: null, ratings: 0, peakRatings: 0, error: null };
  }

  isDue(): boolean {
    const { lastAt } = this.getStatus();
    return !lastAt || this.now() - Date.parse(lastAt) >= BACKUP_INTERVAL_MS;
  }

  async run(): Promise<BackupStatus> {
    const previous = this.getStatus();

    try {
      const folder = await this.deps.folder();
      if (!folder) throw new Error('Escolha a pasta de backup na aba Dados.');

      const content = await this.deps.snapshot();
      const ratings = ratingCount(content);
      if (ratings === null) throw new Error('A exportação não contém notas.');

      const stamp = new Date(this.now()).toISOString().replace(/[:.]/g, '-');
      const name = `${BACKUP_PREFIX}${stamp}${BACKUP_SUFFIX}`;
      await folder.write(name, content);

      const written = await folder.read(name);
      if (written !== content || ratingCount(written) !== ratings) {
        throw new Error('O arquivo gravado não confere com a exportação.');
      }

      const peakRatings = Math.max(previous.peakRatings ?? previous.ratings, ratings);
      const shrank = ratings < peakRatings * MIN_SHARE_OF_LAST;
      if (!shrank) await this.prune(folder);

      return this.save({
        lastAt: new Date(this.now()).toISOString(),
        lastFile: name,
        ratings,
        peakRatings,
        error: shrank ? `Backup com ${ratings} notas, contra ${peakRatings} antes. Os antigos foram mantidos.` : null
      });
    } catch (err) {
      return this.save({ ...previous, error: err instanceof Error ? err.message : String(err) });
    }
  }

  private async prune(folder: BackupFolder): Promise<void> {
    const backups = (await folder.list())
      .filter((name) => name.startsWith(BACKUP_PREFIX) && name.endsWith(BACKUP_SUFFIX))
      .sort();

    for (const name of backups.slice(0, Math.max(0, backups.length - KEEP_BACKUPS))) {
      await folder.remove(name);
    }
  }

  private save(status: BackupStatus): BackupStatus {
    this.deps.store.set(STATUS_KEY, JSON.stringify(status));
    return status;
  }
}
