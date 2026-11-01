import { ExportFile } from '../storage/DataPortabilityManager.ts';

export interface ExportTarget {
  filename: string;
  mimeType: string;
  build: () => Promise<ExportFile>;
}
export const ExportTarget = {};

interface WritableHandle {
  createWritable(): Promise<{ write(data: Blob): Promise<void>; close(): Promise<void> }>;
}

interface DirectoryHandle {
  getFileHandle(name: string, options: { create: boolean }): Promise<WritableHandle>;
}

interface FilePickerWindow {
  showSaveFilePicker?(options: unknown): Promise<WritableHandle>;
  showDirectoryPicker?(options?: unknown): Promise<DirectoryHandle>;
}

function isCancel(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError';
}

function pickerWindow(): FilePickerWindow {
  return window as unknown as FilePickerWindow;
}

async function write(handle: WritableHandle, file: ExportFile): Promise<void> {
  const stream = await handle.createWritable();
  await stream.write(new Blob([file.content], { type: file.mimeType }));
  await stream.close();
}

function download(file: ExportFile): void {
  const url = URL.createObjectURL(new Blob([file.content], { type: file.mimeType }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = file.filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/**
 * Saves through the File System Access API, the route Marketplace uses inside this client. The picker
 * opens before the export is built: it needs the user gesture, which does not survive the awaits of
 * reading the database. Returns false when the user cancels.
 */
export async function saveExports(targets: ExportTarget[]): Promise<boolean> {
  const picker = pickerWindow();

  try {
    if (targets.length > 1 && picker.showDirectoryPicker) {
      const directory = await picker.showDirectoryPicker({ id: 'neuraltune-export', mode: 'readwrite' });
      for (const target of targets) {
        await write(await directory.getFileHandle(target.filename, { create: true }), await target.build());
      }
      return true;
    }

    if (targets.length === 1 && picker.showSaveFilePicker) {
      const [target] = targets;
      const extension = target.filename.slice(target.filename.lastIndexOf('.'));
      const handle = await picker.showSaveFilePicker({
        id: 'neuraltune-export',
        suggestedName: target.filename,
        types: [{ description: target.filename, accept: { [target.mimeType.split(';')[0]]: [extension] } }]
      });
      await write(handle, await target.build());
      return true;
    }
  } catch (err) {
    if (isCancel(err)) return false;
    console.warn('[NeuralTune] File System Access indisponível, usando download', err);
  }

  for (const target of targets) {
    download(await target.build());
  }
  return true;
}
