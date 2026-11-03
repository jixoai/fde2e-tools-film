/**
 * The web face's version history (design D2's `.film/versions/` tree; spec: named/discard/restore
 * 全集, semantics aligned with the server's history.mjs but without git): each named save is a
 * folder of the files it holds (film.html plus what else changed), with a record in
 * `versions.json`. Discard puts the working files back to head; restore checks a version out.
 *
 * Simplified line — the server face's graph (auto versions, branches, parked lines) is a property
 * of git there; here the person's named saves are the tree: head is "now", a save freezes it.
 */
import { children, ensureDir, projectDir, readBytes, readText, walk, writeBytes, writeText, removeTree } from './fs.ts';
import type { StoreEvent } from './types.ts';

export interface WVersion { commit: string; at: number; name: string; kind: 'named' }
export interface WHistory { head: string; versions: WVersion[] }
/** A deleted record: the version folder is kept, only its index entry moves aside (the server's
    deleted-versions.json semantics, simplified: the web face keeps the whole snapshot). */
export interface WDeleted { version: WVersion; at: number }
export interface WDeletedState { deleted: WDeleted[]; count: number }

const VDIR = 'versions';
const INDEX = 'versions.json';
const DELETED = 'deleted.json';
const FILM = 'film.html';

const now = () => Date.now();
const token = () => `v${now().toString(36)}${crypto.randomUUID().slice(0, 6).replace(/-/g, '')}`;

const tell = (fn?: (e: StoreEvent) => void) => fn?.({ type: 'history', moved: true });

async function readIndex(id: string): Promise<WVersion[]> {
  const raw = await readStoreText(id, `${VDIR}/${INDEX}`);
  if (!raw) return [];
  try {
    const list = JSON.parse(raw) as WVersion[];
    return Array.isArray(list) ? list.filter((v) => v && typeof v.commit === 'string') : [];
  } catch { return []; }
}

async function writeIndex(id: string, versions: WVersion[]): Promise<void> {
  await writeStoreText(id, `${VDIR}/${INDEX}`, JSON.stringify(versions, null, 1));
}

/** The deleted records, oldest first (the Deleted view lists them as they went away). */
async function readDeleted(id: string): Promise<WDeleted[]> {
  const raw = await readStoreText(id, `${VDIR}/${DELETED}`);
  if (!raw) return [];
  try {
    const list = JSON.parse(raw) as WDeleted[];
    return Array.isArray(list)
      ? list.filter((d) => d && d.version && typeof d.version.commit === 'string' && typeof d.at === 'number')
      : [];
  } catch { return []; }
}

async function writeDeleted(id: string, deleted: WDeleted[]): Promise<void> {
  await writeStoreText(id, `${VDIR}/${DELETED}`, deleted.length ? JSON.stringify(deleted, null, 1) : '');
}

/* store.ts's primitives re-declared locally: importing store.ts here would make a cycle
   (store ← index ← history ← store). The reads are the same shape as fs.ts's. */
async function readStoreText(id: string, path: string): Promise<string | null> {
  const parts = path.split('/');
  try {
    const base = await navigator.storage.getDirectory();
    let at = await base.getDirectoryHandle('projects', { create: false });
    at = await at.getDirectoryHandle(id, { create: false });
    for (let i = 0; i < parts.length - 1; i++) at = await at.getDirectoryHandle(parts[i], { create: false });
    return await (await (await at.getFileHandle(parts[parts.length - 1])).getFile()).text();
  } catch { return null; }
}

async function writeStoreText(id: string, path: string, text: string): Promise<void> {
  const dir = (await projectDir(id, true))!;
  await writeText(dir, text, ...path.split('/'));
}

/** The named versions, newest first, and head (the newest's commit, or '' before the first save). */
export async function loadHistory(id: string): Promise<WHistory> {
  const versions = (await readIndex(id)).sort((a, b) => b.at - a.at);
  return { head: versions[0]?.commit ?? '', versions };
}

/** Whether the working film differs from head's (true when there is no version yet): the panel's
    "Save version" enables on it, as the server face's `changes` does. */
export async function workingDiffers(id: string): Promise<boolean> {
  const versions = (await readIndex(id)).sort((a, b) => b.at - a.at);
  const head = versions[0]?.commit;
  if (!head) return true;
  const working = await readStoreText(id, FILM);
  const saved = await readStoreText(id, `${VDIR}/${head}/${FILM}`);
  return working !== saved;
}

/** Save now as a named version: the working files (film.html and every project file but caches)
    frozen into `versions/<commit>/`. Answers the commit id. */
export async function saveVersion(id: string, name: string, onEvent?: (e: StoreEvent) => void): Promise<string> {
  const dir = (await projectDir(id, true))!;
  const commit = token();
  const dest = await ensureDir(dir, [VDIR, commit]);
  const { files } = await children(dir);
  for (const name2 of files) {
    if (name2 === FILM) continue; // film.html goes last, as the tree's crown
    const bytes = await readBytes(dir, name2);
    if (bytes !== null) await writeBytes(dest, bytes, name2);
  }
  const assets = await walk(dir, ['assets']);
  if (assets) {
    await copyTree(assets, await ensureDir(dest, ['assets']));
  }
  const film = await readText(dir, FILM);
  if (film !== null) await writeText(dest, film, FILM);
  const versions = await readIndex(id);
  versions.push({ commit, at: now(), name: name.trim().slice(0, 200) || 'Saved version', kind: 'named' });
  await writeIndex(id, versions);
  tell(onEvent);
  return commit;
}

/** The working files put back as head (or as nothing when no version yet) holds them; files the
    version does not have are dropped. */
export async function discardChanges(id: string, onEvent?: (e: StoreEvent) => void): Promise<void> {
  const versions = (await readIndex(id)).sort((a, b) => b.at - a.at);
  await checkoutVersion(id, versions[0]?.commit ?? '', onEvent);
}

/** The working files put back as `commit` holds them (files it does not have are dropped). */
export async function checkoutVersion(id: string, commit: string, onEvent?: (e: StoreEvent) => void): Promise<void> {
  const dir = (await projectDir(id, true))!;
  const version = commit ? await walk(dir, [VDIR, commit]) : null;
  if (commit && !version) throw new Error(`no such version: ${commit}`);
  // working files outside the version's set go: read the version's names first
  const kept = new Set<string>();
  if (version) {
    const { files } = await children(version);
    for (const f of files) kept.add(f);
    const assets = await walk(version, ['assets']);
    if (assets) {
      const list = await collectPaths(assets, 'assets');
      for (const p of list) kept.add(p);
    }
  }
  // drop working files the version does not hold
  const { files } = await children(dir);
  for (const f of files) {
    if (f === FILM || kept.has(f)) continue;
    await removeTree(dir, f);
  }
  const assets = await walk(dir, ['assets']);
  if (assets) {
    const list = await collectPaths(assets, 'assets');
    for (const p of list) if (!kept.has(p)) await removeTree(dir, p);
    if (list.length === 0) { /* keep the empty folder */ }
  }
  // write the version's files back
  if (version) {
    const { files: vfiles } = await children(version);
    for (const f of vfiles) {
      if (f === FILM) continue;
      const bytes = await readVersionFile(version, f);
      if (bytes !== null) await writeBytes(dir, bytes, f);
    }
    const vassets = await walk(version, ['assets']);
    if (vassets) await copyTree(vassets, await ensureDir(dir, ['assets']));
    const film = await readVersionFile(version, FILM);
    if (film !== null) await writeText(dir, new TextDecoder().decode(film), FILM);
  } else {
    // no version at all: an empty film back
    await writeStoreText(id, FILM, '<!doctype html>\n<html>\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=1920, height=1080">\n</head>\n<body>\n</body>\n</html>\n');
  }
  tell(onEvent);
}

/** The film.html of a version (restoreFilm: the film alone brought back). */
export async function versionFilm(id: string, commit: string): Promise<string | null> {
  const dir = await projectDir(id);
  if (!dir) return null;
  return readStoreText(id, `${VDIR}/${commit}/${FILM}`);
}

/** A version's snapshot as package entries (interchange.ts reads them): every file it holds,
    each with its in-package path. Refuses when the version is not there. */
export async function versionEntries(id: string, commit: string): Promise<Array<{ path: string; bytes: ArrayBuffer }>> {
  const dir = (await projectDir(id))!;
  const version = await walk(dir, [VDIR, commit]);
  if (!version) throw new Error(`no such version: ${commit}`);
  const out: Array<{ path: string; bytes: ArrayBuffer }> = [];
  for (const f of (await children(version)).files) {
    const bytes = await readVersionFile(version, f);
    if (bytes !== null) out.push({ path: f, bytes });
  }
  const assets = await walk(version, ['assets']);
  if (assets) {
    for (const p of await collectPaths(assets, 'assets')) {
      const bytes = await readVersionPath(id, `${VDIR}/${commit}/${p}`);
      if (bytes !== null) out.push({ path: p, bytes });
    }
  }
  return out;
}

async function readVersionPath(id: string, path: string): Promise<ArrayBuffer | null> {
  try {
    const base = await navigator.storage.getDirectory();
    let at = await base.getDirectoryHandle('projects', { create: false });
    at = await at.getDirectoryHandle(id, { create: false });
    const parts = path.split('/');
    for (let i = 0; i < parts.length - 1; i++) at = await at.getDirectoryHandle(parts[i]!, { create: false });
    return await (await (await at.getFileHandle(parts[parts.length - 1]!)).getFile()).arrayBuffer();
  } catch { return null; }
}

/** Records move to the deleted list; the snapshots stay, so a record can come back whole.
    Head is refused (the server face's 'current'): it is what the folder is checked out as. */
export async function deleteVersions(id: string, commits: string[]): Promise<string[]> {
  const versions = (await readIndex(id)).sort((a, b) => b.at - a.at);
  const head = versions[0]?.commit;
  if (head && commits.includes(head)) throw new Error('the version currently in use cannot be deleted');
  const deleted = await readDeleted(id);
  const done: string[] = [];
  const left: WVersion[] = [];
  const gone = new Set(commits);
  for (const v of versions) {
    if (gone.has(v.commit)) { deleted.push({ version: v, at: now() }); done.push(v.commit); }
    else left.push(v);
  }
  await writeIndex(id, left);
  await writeDeleted(id, deleted);
  return done;
}

/** Deleted records back to the list, their snapshots never having left. */
export async function recoverVersions(id: string, commits: string[]): Promise<string[]> {
  const versions = await readIndex(id);
  const deleted = await readDeleted(id);
  const back = new Set(commits);
  const kept: WDeleted[] = [];
  const done: string[] = [];
  for (const d of deleted) {
    if (back.has(d.version.commit) && !versions.some((v) => v.commit === d.version.commit)) {
      versions.push(d.version);
      done.push(d.version.commit);
    } else kept.push(d);
  }
  await writeIndex(id, versions);
  await writeDeleted(id, kept);
  return done;
}

/** The deleted records (the Deleted view's list), oldest first. */
export async function loadDeleted(id: string): Promise<WDeletedState> {
  const deleted = (await readDeleted(id)).sort((a, b) => a.at - b.at);
  return { deleted, count: deleted.length };
}

async function readVersionFile(version: FileSystemDirectoryHandle, name: string): Promise<ArrayBuffer | null> {
  try {
    return await (await (await version.getFileHandle(name)).getFile()).arrayBuffer();
  } catch { return null; }
}

async function copyTree(from: FileSystemDirectoryHandle, to: FileSystemDirectoryHandle): Promise<void> {
  const { files, folders } = await children(from);
  for (const f of files) {
    const data = await (await (await from.getFileHandle(f)).getFile()).arrayBuffer();
    await writeBytes(to, data, f);
  }
  for (const d of folders) await copyTree(await from.getDirectoryHandle(d), await ensureDir(to, [d]));
}

async function collectPaths(from: FileSystemDirectoryHandle, prefix: string): Promise<string[]> {
  const out: string[] = [];
  const { files, folders } = await children(from);
  for (const f of files) out.push(`${prefix}/${f}`);
  for (const d of folders) out.push(...(await collectPaths(await from.getDirectoryHandle(d), `${prefix}/${d}`)));
  return out;
}
