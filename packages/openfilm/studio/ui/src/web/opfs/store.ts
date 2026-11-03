/**
 * The OPFS project store: the web editor's file face (design D2). One store, the only writer of
 * `projects/`, answering the same asks the server did — projects CRUD, files, the film text with
 * revisions, settings, history — and telling the same events (`StoreEvent`) so the UI's parts stay
 * in step without a WebSocket. Cross-tab (and cross-broadcast) news goes over a BroadcastChannel;
 * same-tab listeners hear everything at once.
 *
 * Revisions are content hashes of the film text (film-doc.mjs `filmRev`), so an edit made against
 * rev R lands only if the film is still at R — the same optimistic-concurrency the server kept.
 */
import { children, ensureDir, projectDir, readBytes, readText, removeFile, removeTree, root, statFile, walk, writeBytes, writeText } from './fs.ts';
import { newId, untitled } from './id.ts';
import { emptyFilmHtml } from './film-template.ts';
import type { StoreEvent, StoreFile, StoreListing, StoreListener, StoreProject } from './types.ts';

const STATE = '.film';
const STATE_ID = 'id';
const STATE_NAME = 'name';
const STATE_OPENED = 'opened';
const STATE_COVER = 'cover.ts';
const FILM = 'film.html';
const ASSETS = 'assets';

const listeners = new Set<StoreListener>();
let channel: BroadcastChannel | null = null;

/** Cross-tab news: another tab changed the library or a project. */
function wire() {
  channel ??= typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel('fde2e.film.store');
  channel?.addEventListener('message', (e: MessageEvent) => {
    for (const fn of [...listeners]) fn(e.data as StoreEvent);
  });
}

function tell(event: StoreEvent, spread = true) {
  for (const fn of [...listeners]) fn(event);
  if (spread) channel?.postMessage(event);
}

export function subscribe(fn: StoreListener): () => void {
  wire();
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/* ── project records: `.film/` holds the truth; the listing walks `projects/` ── */

const readId = async (dir: FileSystemDirectoryHandle): Promise<string> => (await readText(dir, STATE, STATE_ID))?.trim() ?? '';

const writeState = async (dir: FileSystemDirectoryHandle, name: string, value: string) => {
  await ensureDir(dir, [STATE]);
  await writeText(dir, value, STATE, name);
};

async function describe(dir: FileSystemDirectoryHandle, id: string): Promise<StoreProject | null> {
  const text = await readText(dir, FILM);
  const opened = Number((await readText(dir, STATE, STATE_OPENED))?.trim()) || 0;
  const cover = Number((await readText(dir, STATE, STATE_COVER))?.trim()) || 0;
  let folderId: string | undefined;
  try {
    const filed = await readText(dir, STATE, 'folder');
    folderId = filed ? ((JSON.parse(filed).id as string | null) ?? undefined) : undefined;
  } catch { /* unfiled */ }
  const shown = (await readText(dir, STATE, STATE_NAME))?.trim() || 'Untitled';
  return {
    id,
    name: shown,
    openedAt: opened,
    createdAt: opened, // a web project is born opened; the list's `newest` order uses it
    missing: text === null,
    missingReason: text === null ? 'film' : undefined,
    ...(cover ? { cover } : {}),
    ...(folderId ? { folderId } : {}),
  };
}

/** Every project, newest-opened first (the list's `recent` order). */
export async function listProjects(): Promise<StoreProject[]> {
  const base = await root();
  const { folders } = await children(base);
  const all: StoreProject[] = [];
  for (const name of folders) {
    const dir = await base.getDirectoryHandle(name, { create: false });
    const id = await readId(dir);
    if (!id) continue; // not a project (a stray folder)
    all.push((await describe(dir, id))!);
  }
  return all.sort((a, b) => b.openedAt - a.openedAt);
}

/** One project, or null. */
export async function getProject(id: string): Promise<StoreProject | null> {
  const dir = await projectDir(id);
  if (!dir) return null;
  const found = await readId(dir);
  return found === id ? describe(dir, id) : null;
}

/** A new project: `projects/<id>/` with film.html, `.film/` and an empty `assets/`. */
export async function createProject(name?: string): Promise<StoreProject> {
  const id = newId();
  /* the folder's name IS the id — the one key every reader (URL, events, rename) uses; the name a
     person sees lives beside it (.film/name) and follows renameProject */
  const dir = (await projectDir(id, true))!;
  const all = await listProjects();
  const shown = name?.trim().replace(/[/\\:*?"<>|]/g, ' ').replace(/\s+/g, ' ').trim() || untitled(new Set(all.map((p) => p.name)));
  const now = String(Date.now());
  await writeState(dir, STATE_ID, id);
  await writeState(dir, STATE_NAME, shown);
  await writeState(dir, STATE_OPENED, now);
  await writeText(dir, emptyFilmHtml(), FILM);
  await ensureDir(dir, [ASSETS]);
  return (await describe(dir, id))!;
}

/** A project's film text with its revision; null when the project (or its film) is not there. */
export async function readFilm(id: string): Promise<{ text: string; rev: string } | null> {
  const dir = await projectDir(id);
  if (!dir) return null;
  const text = await readText(dir, FILM);
  return text === null ? null : { text, rev: await filmRev(text) };
}

/**
 * The revision of a film's text: the same 16-hex-char contract as the server's `revOf`
 * (studio/server/film.mjs), made with WebCrypto instead of node:crypto. Async, so every
 * rev comparison awaits it.
 */
export async function filmRev(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
}

/** The film written when it is still at `expect` (optimistic); answers the new rev, or null when
    someone else moved it first. `expect === null` means "no condition": the first write, or an
    import that owns the project it just made. */
export async function writeFilm(id: string, text: string, expect: string | null): Promise<string | null> {
  const dir = await projectDir(id);
  if (!dir) return null;
  if (expect !== null) {
    const current = await readText(dir, FILM);
    const currentRev = current === null ? null : await filmRev(current);
    if (currentRev !== expect) return null;
  }
  await writeText(dir, text, FILM);
  const rev = await filmRev(text);
  tell({ type: 'film', rev });
  return rev;
}

/** A project deleted whole (its folder out of OPFS). */
export async function deleteProject(id: string): Promise<void> {
  await removeTree(await root(), id);
  tell({ type: 'gone' });
}

/** A project renamed (the name a person sees; the folder — the id — stays). */
export async function renameProject(id: string, name: string): Promise<StoreProject | null> {
  const dir = await projectDir(id);
  if (!dir) return null;
  const clean = name.trim().replace(/[/\\:*?"<>|]/g, ' ').replace(/\s+/g, ' ').slice(0, 120) || 'Untitled';
  await writeState(dir, STATE_NAME, clean);
  tell({ type: 'project' });
  return describe(dir, id);
}


/** Opened now: the list's `recent` order follows it. */
export async function markOpened(id: string): Promise<void> {
  const dir = await projectDir(id);
  if (!dir) return;
  await writeState(dir, STATE_OPENED, String(Date.now()));
  tell({ type: 'project' });
}

/** A cover the person chose (an image's bytes); clears when `data` is null. */
export async function setCover(id: string, data: ArrayBuffer | null): Promise<number | null> {
  const dir = await projectDir(id);
  if (!dir) return null;
  if (data === null) {
    await removeFile(dir, STATE, 'cover.png');
    await writeState(dir, STATE_COVER, '');
    tell({ type: 'project' });
    return null;
  }
  await ensureDir(dir, [STATE]);
  await writeBytes(dir, data, STATE, 'cover.png');
  const at = Date.now();
  await writeState(dir, STATE_COVER, String(at));
  tell({ type: 'project' });
  return at;
}

/* ── files: the project's assets/ (and its own pages at the top) ── */

const kindOf = (name: string): StoreFile['kind'] => {
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
  if (['mp4', 'webm', 'mov', 'm4v', 'mkv'].includes(ext)) return 'video';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'svg'].includes(ext)) return 'image';
  if (['mp3', 'wav', 'm4a', 'aac', 'ogg', 'opus', 'flac'].includes(ext)) return 'audio';
  if (ext === 'html') return 'page';
  return 'other';
};

async function collect(dir: FileSystemDirectoryHandle, prefix: string, out: StoreFile[]): Promise<void> {
  const { files, folders } = await children(dir);
  for (const name of files) {
    const path = prefix ? `${prefix}/${name}` : name;
    const st = await statFile(dir, name);
    if (st) out.push({ path, kind: kindOf(name), size: st.size, mtime: st.mtime });
  }
  for (const name of folders) {
    await collect(await dir.getDirectoryHandle(name, { create: false }), prefix ? `${prefix}/${name}` : name, out);
  }
}

/** A project's files: its pages (top-level html) and everything under `assets/`. */
export async function listFiles(id: string): Promise<StoreListing> {
  const dir = await projectDir(id);
  const out: StoreFile[] = [];
  if (!dir) return { files: out, folders: [], pages: [] };
  const { files } = await children(dir);
  const pages: { path: string; size: number; mtime: number }[] = [];
  for (const name of files) {
    if (name === FILM) continue;
    if (kindOf(name) === 'page') {
      const st = await statFile(dir, name);
      if (st) pages.push({ path: name, size: st.size, mtime: st.mtime });
      continue;
    }
    const st = await statFile(dir, name);
    if (st) out.push({ path: name, kind: kindOf(name), size: st.size, mtime: st.mtime });
  }
  const assets = await walk(dir, [ASSETS]);
  if (assets) await collect(assets, ASSETS, out);
  return { files: out, folders: [ASSETS], pages };
}

/** A file of the project read as text (a page, a style, a worker script). */
export async function readFileText(id: string, path: string): Promise<string | null> {
  const dir = await projectDir(id);
  if (!dir) return null;
  return readText(dir, ...path.split('/'));
}

/** A file of the project read as bytes (media into an object URL). */
export async function readFileBytes(id: string, path: string): Promise<ArrayBuffer | null> {
  const dir = await projectDir(id);
  if (!dir) return null;
  return readBytes(dir, ...path.split('/'));
}

/** A file put into the project (a dropped or pasted one). */
export async function putFile(id: string, path: string, data: Blob | ArrayBuffer): Promise<void> {
  const dir = await projectDir(id);
  if (!dir) return;
  await writeBytes(dir, data, ...path.split('/'));
  tell({ type: 'files', paths: [path] });
}

/** A file taken away. */
export async function deleteFile(id: string, path: string): Promise<void> {
  const dir = await projectDir(id);
  if (!dir) return;
  await removeFile(dir, ...path.split('/'));
  tell({ type: 'files', paths: [path] });
}
