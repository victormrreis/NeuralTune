import { BackupFolder } from '../storage/AutoBackup.ts';

const HANDLE_DB = 'NeuralTuneBackupDB';
const HANDLE_STORE = 'handles';
const HANDLE_KEY = 'backup-folder';

interface FileHandle {
  getFile(): Promise<{ text(): Promise<string> }>;
  createWritable(): Promise<{ write(data: Blob): Promise<void>; close(): Promise<void> }>;
}

interface DirectoryHandle {
  name: string;
  getFileHandle(name: string, options?: { create: boolean }): Promise<FileHandle>;
  removeEntry(name: string): Promise<void>;
  keys(): AsyncIterable<string>;
  queryPermission(options: { mode: 'readwrite' }): Promise<string>;
  requestPermission(options: { mode: 'readwrite' }): Promise<string>;
}

function openHandles(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(HANDLE_DB, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(HANDLE_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function storeHandle(handle: DirectoryHandle): Promise<void> {
  const db = await openHandles();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(HANDLE_STORE, 'readwrite');
    tx.objectStore(HANDLE_STORE).put(handle, HANDLE_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

async function loadHandle(): Promise<DirectoryHandle | null> {
  const db = await openHandles();
  const handle = await new Promise<DirectoryHandle | null>((resolve) => {
    const req = db.transaction(HANDLE_STORE, 'readonly').objectStore(HANDLE_STORE).get(HANDLE_KEY);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => resolve(null);
  });
  db.close();
  return handle;
}

function toFolder(handle: DirectoryHandle): BackupFolder {
  return {
    async write(name, content) {
      const stream = await (await handle.getFileHandle(name, { create: true })).createWritable();
      await stream.write(new Blob([content], { type: 'application/json' }));
      await stream.close();
    },
    async read(name) {
      return (await (await handle.getFileHandle(name)).getFile()).text();
    },
    async list() {
      const names: string[] = [];
      for await (const name of handle.keys()) names.push(name);
      return names;
    },
    remove: (name) => handle.removeEntry(name)
  };
}

/** Needs a click: the picker refuses to open without a user gesture. */
export async function chooseBackupFolder(): Promise<string | null> {
  const picker = (window as unknown as { showDirectoryPicker?(options: unknown): Promise<DirectoryHandle> }).showDirectoryPicker;
  if (!picker) throw new Error('Este cliente não permite escolher pastas.');

  try {
    const handle = await picker.call(window, { id: 'neuraltune-backup', mode: 'readwrite' });
    await storeHandle(handle);
    return handle.name || 'pasta escolhida'; // A drive root has an empty name, and null means cancelled
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') return null;
    throw err;
  }
}

/**
 * The chosen folder, when it can be used now. Permission may lapse between sessions, and asking again
 * needs a click, so a background run gets null and the status says so instead of prompting.
 */
export async function usableBackupFolder(allowPrompt: boolean): Promise<BackupFolder | null> {
  const handle = await loadHandle();
  if (!handle) return null;

  const options = { mode: 'readwrite' as const };
  if (await handle.queryPermission(options) === 'granted') return toFolder(handle);
  if (allowPrompt && await handle.requestPermission(options) === 'granted') return toFolder(handle);
  return null;
}
