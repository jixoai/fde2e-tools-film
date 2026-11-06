/**
 * The OPFS root, with the small helpers every store call stands on. Zero-pop-up persistence
 * (design D2): everything lives under the origin's `projects/` directory, no permission prompt
 * asked, nothing lost on reload. A browser without OPFS (a non-secure context, or an old engine)
 * fails at the first call; the app says so instead of pretending.
 */

const ROOT_NAME = 'projects';

let rootPromise: Promise<FileSystemDirectoryHandle> | null = null;

/** The `projects/` directory of this origin's OPFS (made when missing). */
export function root(): Promise<FileSystemDirectoryHandle> {
  rootPromise ??= (async () => {
    if (!navigator.storage?.getDirectory) throw new Error('OPFS is not available in this browser');
    const base = await navigator.storage.getDirectory();
    return base.getDirectoryHandle(ROOT_NAME, { create: true });
  })();
  return rootPromise;
}

/** A project's directory under `projects/`; null when it is not there. */
export async function projectDir(id: string, create = false): Promise<FileSystemDirectoryHandle | null> {
  try {
    return await (await root()).getDirectoryHandle(id, { create });
  } catch (e) {
    if (create) throw e; // creating one that cannot be made is a real failure
    return null;
  }
}

/** Walk to a nested directory; null when any part is missing. */
export async function walk(from: FileSystemDirectoryHandle, parts: string[]): Promise<FileSystemDirectoryHandle | null> {
  let at = from;
  for (const part of parts) {
    try {
      at = await at.getDirectoryHandle(part, { create: false });
    } catch {
      return null;
    }
  }
  return at;
}

/** Make every directory of `parts` under `from`; the deepest one. */
export async function ensureDir(from: FileSystemDirectoryHandle, parts: string[]): Promise<FileSystemDirectoryHandle> {
  let at = from;
  for (const part of parts) at = await at.getDirectoryHandle(part, { create: true });
  return at;
}

/** Read a file as text; null when it is not there. */
export async function readText(dir: FileSystemDirectoryHandle, ...parts: string[]): Promise<string | null> {
  return readContents(dir, parts, (file) => file.text());
}

/** Read a file as an ArrayBuffer; null when it is not there. */
export async function readBytes(dir: FileSystemDirectoryHandle, ...parts: string[]): Promise<ArrayBuffer | null> {
  return readContents(dir, parts, (file) => file.arrayBuffer());
}

/** OPFS invalidates File snapshots when another writer closes the same path. Reopen that path
 * for a fresh snapshot; a concurrent metadata touch must not make opening a project fail. */
async function readContents<T>(dir: FileSystemDirectoryHandle, parts: string[], read: (file: File) => Promise<T>): Promise<T | null> {
  for (let attempt = 0; ; attempt++) {
    const handle = await readFileHandle(dir, parts); if (!handle) return null;
    try { return await read(await handle.getFile()); }
    catch (error) {
      if (attempt >= 2 || !['NotFoundError', 'NotReadableError'].includes((error as Error).name)) throw error;
    }
  }
}

async function readFileHandle(dir: FileSystemDirectoryHandle, parts: string[]): Promise<FileSystemFileHandle | null> {
  if (!parts.length) return null;
  /* the last part is the file; the ones before it are its folders (`readText(dir, '.film', 'id')`) */
  const name = parts[parts.length - 1];
  const parent = parts.length > 1 ? await walk(dir, parts.slice(0, -1)) : dir;
  if (!parent) return null;
  try {
    return await parent.getFileHandle(name, { create: false });
  } catch {
    return null;
  }
}

/** Write a file (text or bytes), making the folders it needs. Writes whole: a half-written film.html
    is the one state the format cannot read, so text goes in one write (OPFS writes are atomic in
    practice within one origin) and a `.part` rename is not needed. */
export async function writeText(dir: FileSystemDirectoryHandle, text: string, ...parts: string[]): Promise<void> {
  return writeBytes(dir, new Blob([text]), ...parts);
}

export async function writeBytes(dir: FileSystemDirectoryHandle, data: Blob | ArrayBuffer, ...parts: string[]): Promise<void> {
  const parent = await ensureDir(dir, parts.slice(0, -1));
  const name = parts[parts.length - 1]!;
  let existed = true;
  try { await parent.getFileHandle(name); } catch (error) {
    if ((error as Error).name !== 'NotFoundError' && (error as Error).message !== 'NotFoundError') throw error;
    existed = false;
  }
  let writable: FileSystemWritableFileStream | undefined;
  try {
    const file = await parent.getFileHandle(name, { create: true });
    writable = await file.createWritable(); await writable.write(data); await writable.close();
  } catch (error) {
    await writable?.abort().catch(() => {});
    // create:true publishes an empty handle before close. Do not let a failed first index write
    // shadow a complete legacy index; existing files retain their previous atomic contents.
    if (!existed) await parent.removeEntry(name).catch(() => {});
    throw error;
  }
}

/** Remove a file; nothing when it is not there. */
export async function removeFile(dir: FileSystemDirectoryHandle, ...parts: string[]): Promise<void> {
  const parent = parts.length > 1 ? await walk(dir, parts.slice(0, -1)) : dir;
  if (!parent) return;
  try {
    await parent.removeEntry(parts[parts.length - 1]);
  } catch {
    /* not there: done */
  }
}

type DirHandle = FileSystemDirectoryHandle & {
  /** in the DOM lib's next edition; cast keeps us honest on the async-iterator contract */
  entries?: () => AsyncIterableIterator<[string, FileSystemHandle]>;
};

/** A directory's children, told apart. */
export async function children(dir: FileSystemDirectoryHandle): Promise<{ files: string[]; folders: string[] }> {
  const files: string[] = [];
  const folders: string[] = [];
  const entries = (dir as DirHandle).entries?.bind(dir);
  if (!entries) throw new Error('this browser cannot list OPFS directories');
  for await (const [name, handle] of entries()) {
    if (handle.kind === 'file') files.push(name);
    else folders.push(name);
  }
  return { files, folders };
}

/** A file's size and last-write time, as the store's listing wants them. */
export async function statFile(dir: FileSystemDirectoryHandle, ...parts: string[]): Promise<{ size: number; mtime: number } | null> {
  const file = await readFileHandle(dir, parts);
  if (!file) return null;
  const f = await file.getFile();
  return { size: f.size, mtime: f.lastModified };
}

/** Remove a directory and everything in it (a project's `.film`, a folder of assets). */
export async function removeTree(dir: FileSystemDirectoryHandle, ...parts: string[]): Promise<void> {
  const parent = parts.length > 1 ? await walk(dir, parts.slice(0, -1)) : dir;
  const name = parts[parts.length - 1];
  if (!parent || !name) return;
  try {
    await parent.removeEntry(name, { recursive: true });
  } catch {
    /* not there: done */
  }
}
