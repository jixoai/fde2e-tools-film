/** Complete OPFS snapshots. One atomic metadata file publishes head, saves and recycle-bin rows. */
import { children, ensureDir, projectDir, readText, walk, writeBytes, writeText, removeTree } from './fs.ts';
import { emptyFilmHtml } from './film-template.ts';
import { projectFiles, sameFile, internalRoot, sourceState } from './project-files.ts';
import { withProjectLock } from './project-lock.ts';
import type { StoreEvent } from './types.ts';

export interface WVersion { commit: string; at: number; name: string; kind: 'named'; treeVersion?: 1 }
export interface WHistory { head: string; versions: WVersion[] }
export interface WDeleted { version: WVersion; at: number }
export interface WDeletedState { deleted: WDeleted[]; count: number }
interface HistoryIndex { format: 1; head: string; versions: WVersion[]; deleted: WDeleted[] }
const VDIR = 'versions'; // existing installations and preview URLs use this directory
const STATE = 'state.json';
const FILM = 'film.html';
const validCommit = (value: unknown): value is string => typeof value === 'string' && /^v[a-z0-9]+$/.test(value);
const validVersion = (v: WVersion): boolean => !!v && validCommit(v.commit) && Number.isFinite(v.at) && typeof v.name === 'string';
const tell = (fn?: (e: StoreEvent) => void) => fn?.({ type: 'history', moved: true });
const directory = async (id: string) => {
  const dir = await projectDir(id);
  if (!dir) throw new Error('the project is gone');
  return dir;
};

async function readState(dir: FileSystemDirectoryHandle): Promise<HistoryIndex> {
  const raw = await readText(dir, VDIR, STATE);
  if (raw !== null) {
    const s = JSON.parse(raw) as HistoryIndex;
    if (s.format !== 1 || !Array.isArray(s.versions) || !s.versions.every(validVersion)
      || !Array.isArray(s.deleted) || !s.deleted.every((d) => validVersion(d.version) && Number.isFinite(d.at))
      || (s.head !== '' && !s.versions.some((v) => v.commit === s.head))) throw new Error('invalid history index');
    return s;
  }
  // Read the old two-file format once; the next mutation publishes an atomic unified state.
  const versions = JSON.parse(await readText(dir, VDIR, 'versions.json') ?? '[]') as WVersion[];
  const deleted = JSON.parse(await readText(dir, VDIR, 'deleted.json') || '[]') as WDeleted[];
  if (!Array.isArray(versions) || !versions.every(validVersion) || !Array.isArray(deleted)
    || !deleted.every((d) => validVersion(d.version) && Number.isFinite(d.at))) throw new Error('invalid legacy history index');
  versions.sort((a, b) => b.at - a.at);
  return { format: 1, head: versions[0]?.commit ?? '', versions, deleted };
}
const writeState = (dir: FileSystemDirectoryHandle, state: HistoryIndex) => writeText(dir, JSON.stringify(state), VDIR, STATE);

async function snapshot(dir: FileSystemDirectoryHandle, commit: string): Promise<FileSystemDirectoryHandle> {
  if (!validCommit(commit)) throw new Error('no such version');
  const state = await readState(dir);
  if (![...state.versions, ...state.deleted.map((d) => d.version)].some((v) => v.commit === commit)) throw new Error(`no such version: ${commit}`);
  const version = await walk(dir, [VDIR, commit]);
  if (!version || await readText(version, FILM) === null) throw new Error(`incomplete version: ${commit}`);
  return version;
}

export function loadHistory(id: string): Promise<WHistory> {
  return withProjectLock(id, async () => {
    const s = await readState(await directory(id));
    return { head: s.head, versions: [...s.versions].sort((a, b) => b.at - a.at) };
  });
}
async function differs(dir: FileSystemDirectoryHandle, head: string): Promise<boolean> {
  if (!head) return true;
  const saved = await snapshot(dir, head);
  let [working, frozen] = await Promise.all([projectFiles(dir), projectFiles(saved)]);
  const legacy = (await readState(dir)).versions.find((v) => v.commit === head)?.treeVersion !== 1;
  if (legacy) working = working.filter((f) => !f.path.includes('/') || f.path.startsWith('assets/'));
  if (working.length !== frozen.length) return true;
  for (let i = 0; i < working.length; i++) {
    if (working[i].path !== frozen[i].path || !await sameFile(working[i].handle, frozen[i].handle)) return true;
  }
  return false;
}
export function workingDiffers(id: string): Promise<boolean> {
  return withProjectLock(id, async () => { const d = await directory(id); return differs(d, (await readState(d)).head); });
}

export function saveVersion(id: string, name: string, onEvent?: (e: StoreEvent) => void): Promise<string> {
  return withProjectLock(id, async () => {
    const dir = await directory(id);
    const state = await readState(dir);
    if (await readText(dir, FILM) === null) throw new Error('the project has no film');
    const commit = `v${Date.now().toString(36)}${crypto.randomUUID().replace(/-/g, '')}`;
    try {
      const dest = await ensureDir(dir, [VDIR, commit]);
      for (const file of await projectFiles(dir)) await writeBytes(dest, await file.handle.getFile(), ...file.path.split('/'));
      state.versions.push({ commit, at: Date.now(), name: name.trim().slice(0, 200) || 'Saved version', kind: 'named', treeVersion: 1 });
      state.head = commit;
      await writeState(dir, state); // snapshot becomes visible only after every file has closed
    } catch (error) { await removeTree(dir, VDIR, commit); throw error; }
    tell(onEvent);
    return commit;
  });
}

async function checkout(dir: FileSystemDirectoryHandle, commit: string): Promise<void> {
  const state = await readState(dir);
  if (commit && !state.versions.some((v) => v.commit === commit)) throw new Error(`no such version: ${commit}`);
  const record = state.versions.find((v) => v.commit === commit);
  const legacy = Boolean(record && record.treeVersion !== 1);
  const version = commit ? await snapshot(dir, commit) : null;
  const backupName = `.restore-${crypto.randomUUID()}`;
  const backup = await ensureDir(dir, [VDIR, backupName]);
  const before = await projectFiles(dir);
  for (const file of before) await writeBytes(backup, await file.handle.getFile(), ...file.path.split('/'));
  const replace = async (source: FileSystemDirectoryHandle | null, keepLegacy: boolean) => {
    const { files, folders } = await children(dir);
    for (const name of [...files, ...folders]) {
      if (internalRoot(name) || name === 'downloads' || (keepLegacy && folders.includes(name) && name !== 'assets')) continue;
      await dir.removeEntry(name, { recursive: true });
    }
    if (!keepLegacy) for (const name of sourceState) await removeTree(dir, '.film', name);
    if (source) for (const file of await projectFiles(source)) await writeBytes(dir, await file.handle.getFile(), ...file.path.split('/'));
    else await writeText(dir, emptyFilmHtml(), FILM);
  };
  try {
    await replace(version, legacy);
    await writeState(dir, { ...state, head: commit });
  } catch (error) {
    try { await replace(backup, false); await writeState(dir, state); }
    catch { throw new Error(`restore failed; recovery data retained at ${VDIR}/${backupName}`, { cause: error }); }
    await removeTree(dir, VDIR, backupName);
    throw error;
  }
  await removeTree(dir, VDIR, backupName);
}
export function checkoutVersion(id: string, commit: string, onEvent?: (e: StoreEvent) => void): Promise<void> {
  return withProjectLock(id, async () => { await checkout(await directory(id), commit); tell(onEvent); });
}
export function discardChanges(id: string, onEvent?: (e: StoreEvent) => void): Promise<void> {
  return withProjectLock(id, async () => {
    const dir = await directory(id); await checkout(dir, (await readState(dir)).head); tell(onEvent);
  });
}
export function versionFilm(id: string, commit: string): Promise<string | null> {
  return withProjectLock(id, async () => readText(await snapshot(await directory(id), commit), FILM));
}
export function versionEntries(id: string, commit: string): Promise<Array<{ path: string; bytes: ArrayBuffer }>> {
  return withProjectLock(id, async () => {
    const files = await projectFiles(await snapshot(await directory(id), commit));
    const out: Array<{ path: string; bytes: ArrayBuffer }> = [];
    for (const file of files) out.push({ path: file.path, bytes: await (await file.handle.getFile()).arrayBuffer() });
    return out;
  });
}
export function deleteVersions(id: string, commits: string[]): Promise<string[]> {
  return withProjectLock(id, async () => {
    const dir = await directory(id); const s = await readState(dir);
    if (s.head && commits.includes(s.head)) throw new Error('the version currently in use cannot be deleted');
    const removed = s.versions.filter((v) => commits.includes(v.commit));
    s.versions = s.versions.filter((v) => !commits.includes(v.commit));
    s.deleted.push(...removed.map((version) => ({ version, at: Date.now() })));
    await writeState(dir, s);
    return removed.map((v) => v.commit);
  });
}
export function recoverVersions(id: string, commits: string[]): Promise<string[]> {
  return withProjectLock(id, async () => {
    const dir = await directory(id); const s = await readState(dir);
    const restored = s.deleted.filter((d) => commits.includes(d.version.commit));
    s.deleted = s.deleted.filter((d) => !commits.includes(d.version.commit));
    for (const d of restored) if (!s.versions.some((v) => v.commit === d.version.commit)) s.versions.push(d.version);
    await writeState(dir, s);
    return restored.map((d) => d.version.commit);
  });
}
export function loadDeleted(id: string): Promise<WDeletedState> {
  return withProjectLock(id, async () => {
    const { deleted } = await readState(await directory(id));
    return { deleted: [...deleted].sort((a, b) => a.at - b.at), count: deleted.length };
  });
}
