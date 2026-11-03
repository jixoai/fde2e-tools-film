/**
 * 「存回真实文件夹」(the spec's 存回硬盘): the project package — manifest.film.json, film.html,
 * assets/** — written into a folder of the person's disk through the File System Access API.
 * The person picks the folder once (`showDirectoryPicker`); the write is then plain file work,
 * no further prompts. Advanced and optional: nothing else touches this module, and a browser
 * without the API simply never sees the entry (web/saveBackAvailable).
 *
 * The package shape is the interchange contract's single source (web/interchange.ts): the same
 * buildPackage the zip download packs and the receiver verifies — one manifest, one checksum set.
 */
import { buildPackage } from './interchange.ts';
import { getProject, readFilm } from './opfs/index.ts';
import { children, ensureDir } from './opfs/fs.ts';

export const saveBackAvailable = (): boolean => typeof (window as { showDirectoryPicker?: unknown }).showDirectoryPicker === 'function';

/** The person picks (or re-picks) the folder. Null: they cancelled the picker. */
export async function pickFolder(): Promise<FileSystemDirectoryHandle | null> {
  const pick = (window as { showDirectoryPicker?: (o?: { mode?: 'read' | 'readwrite'; id?: string; startIn?: string }) => Promise<FileSystemDirectoryHandle> }).showDirectoryPicker;
  if (!pick) return null;
  try {
    return await pick({ mode: 'readwrite', id: 'fde2e-film-save-back', startIn: 'documents' });
  } catch (e) {
    // AbortError: the person closed the picker — not a failure
    if (e instanceof DOMException && e.name === 'AbortError') return null;
    throw e;
  }
}

/** A real folder's file put (nested path), tolerant of a read-only entry (throws with its name). */
async function write(dir: FileSystemDirectoryHandle, path: string, data: ArrayBuffer | string): Promise<void> {
  const parts = path.split('/');
  const at = await ensureDir(dir, parts.slice(0, -1) as [string, ...string[]]);
  const f = await at.getFileHandle(parts[parts.length - 1]!, { create: true });
  const w = await f.createWritable();
  await w.write(typeof data === 'string' ? new TextEncoder().encode(data) : data);
  await w.close();
}

/** The project package into `dir`: manifest, film.html, every asset — the interchange contract's
    buildPackage, written file by file. Answers the file count. `.film/` (versions, settings) stays
    in OPFS — the package is the working copy, not the archive. */
export async function saveProjectBack(id: string, dir: FileSystemDirectoryHandle): Promise<{ files: number; name: string }> {
  const { name, entries } = await buildPackage(id);
  for (const e of entries) await write(dir, e.path, e.bytes);
  return { files: entries.length, name };
}

/** Whether `dir` already holds a package of this film: its manifest is ours and names the film
    revision the OPFS store has now (a save-back that would land on the same work). */
export async function savedHere(id: string, dir: FileSystemDirectoryHandle): Promise<boolean> {
  try {
    const film = await readFilm(id);
    if (!film) return false;
    const f = await dir.getFileHandle('manifest.film.json');
    const text = JSON.parse(await (await f.getFile()).text()) as { kind?: string; filmRev?: string };
    return text.kind === 'fde2e-film-project' && text.filmRev === film.rev;
  } catch { return false; }
}

/** The project's name, for the folder the person saves into (they can rename it there). */
export async function suggestFolderName(id: string): Promise<string> {
  const project = await getProject(id);
  return project?.name ?? 'Untitled';
}

/** Children of a real folder (used to warn before overwriting unrelated files). */
export async function folderHasFiles(dir: FileSystemDirectoryHandle): Promise<boolean> {
  const { files, folders } = await children(dir);
  return files.length > 0 || folders.length > 0;
}
