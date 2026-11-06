import { test } from 'node:test';
import assert from 'node:assert/strict';
import { projectDir, writeText, readText, ensureDir } from './fs.ts';
import * as history from './history.ts';
import { createProjectFromFiles, listFiles, putFile, writeFilm } from './store.ts';
import { buildPackage, importPackage } from '../interchange.ts';

class MemoryFile {
  kind = 'file'; data: Blob = new Blob([]);
  name: string;
  constructor(name: string) { this.name = name; }
  async getFile() { return new File([this.data], this.name, { lastModified: 1 }); }
  async createWritable() {
    let pending: Blob;
    return { write: async (data: BlobPart) => { pending = new Blob([data]); }, close: async () => { this.data = pending; } };
  }
}
class MemoryDirectory {
  kind = 'directory'; nodes = new Map<string, MemoryDirectory | MemoryFile>();
  name: string;
  constructor(name: string) { this.name = name; }
  async getDirectoryHandle(name: string, { create = false } = {}) { return this.child(name, 'directory', create); }
  async getFileHandle(name: string, { create = false } = {}) { return this.child(name, 'file', create); }
  child(name: string, kind: string, create: boolean) {
    if (!name || name.includes('/')) throw new Error('Invalid OPFS basename');
    if (!this.nodes.has(name) && create) this.nodes.set(name, kind === 'directory' ? new MemoryDirectory(name) : new MemoryFile(name));
    const value = this.nodes.get(name); if (!value || value.kind !== kind) throw new Error('NotFoundError'); return value;
  }
  async *entries() { yield* this.nodes.entries(); }
  async removeEntry(name: string) { if (name.includes('/')) throw new Error('Invalid OPFS basename'); this.nodes.delete(name); }
}
const root = new MemoryDirectory('OPFS');
Object.defineProperty(globalThis, 'navigator', { value: { storage: { getDirectory: async () => root } }, configurable: true });
const bytes = (text: string) => new TextEncoder().encode(text).buffer;
const make = (name: string) => createProjectFromFiles(name, [
  { path: 'film.html', data: '<!doctype html><script>window.film={tracks:[]}</script>' },
  { path: 'page.html', data: 'root-v1' }, { path: 'pages/title.html', data: 'nested-v1' },
  { path: 'vendor/runtime.js', data: 'vendor-v1' }, { path: 'fonts/font.woff2', data: bytes('font-v1') },
  { path: 'assets/image.bin', data: bytes('image-v1') },
]);

test('source-only edits are dirty; snapshots restore and copy every nested dependency', async () => {
  const project = await make('history'); const id = project.id;
  const v1 = await history.saveVersion(id, 'v1');
  assert.equal(await history.workingDiffers(id), false);
  for (const path of ['page.html', 'pages/title.html', 'vendor/runtime.js', 'fonts/font.woff2', 'assets/image.bin']) {
    await putFile(id, path, bytes('changed'));
    assert.equal(await history.workingDiffers(id), true, path);
    await history.checkoutVersion(id, v1);
    assert.equal(await history.workingDiffers(id), false, path);
  }
  await putFile(id, 'later/nested.txt', bytes('later'));
  await putFile(id, 'downloads/out.mp4', bytes('output'));
  await history.checkoutVersion(id, v1);
  const dir = (await projectDir(id))!;
  assert.equal(await readText(dir, 'later', 'nested.txt'), null);
  assert.equal(await readText(dir, 'pages', 'title.html'), 'nested-v1');
  assert.equal(await readText(dir, 'downloads', 'out.mp4'), 'output');
  const saved = await history.versionEntries(id, v1);
  assert(saved.some((f) => f.path === 'vendor/runtime.js'));
  assert(saved.every((f) => !f.path.startsWith('versions/') && !f.path.startsWith('.film/') && !f.path.startsWith('downloads/')));
});

test('checkout changes the base; discard and current-version protection follow it', async () => {
  const { id } = await make('head');
  const v1 = await history.saveVersion(id, 'v1');
  await writeFilm(id, '<html>v2</html>', null);
  const v2 = await history.saveVersion(id, 'v2');
  await history.checkoutVersion(id, v1);
  assert.equal((await history.loadHistory(id)).head, v1);
  assert.equal(await history.workingDiffers(id), false);
  await writeFilm(id, '<html>working</html>', null);
  await history.discardChanges(id);
  assert.equal(await history.workingDiffers(id), false);
  await assert.rejects(history.deleteVersions(id, [v1]), /currently in use/);
  assert.deepEqual(await history.deleteVersions(id, [v2]), [v2]);
  assert.equal((await history.loadDeleted(id)).count, 1);
  assert.deepEqual(await history.recoverVersions(id, [v2]), [v2]);
  assert.equal((await history.loadHistory(id)).head, v1);
});

test('concurrent saves retain all rows; stale writes use the same project lock', async () => {
  const { id } = await make('parallel');
  const versions = await Promise.all([history.saveVersion(id, 'one'), history.saveVersion(id, 'two')]);
  assert.equal((await history.loadHistory(id)).versions.length, 2);
  assert.equal(new Set(versions).size, 2);
  await assert.rejects(putFile(id, 'versions/state.json', bytes('{}')), /invalid/);
  await assert.rejects(putFile(id, '../elsewhere', bytes('bad')), /invalid/);
});

test('legacy metadata migrates without losing deleted records; malformed state fails closed', async () => {
  const { id } = await make('legacy'); const dir = (await projectDir(id))!;
  await ensureDir(dir, ['versions', 'vlegacy']);
  await writeText(dir, '<html>legacy</html>', 'versions', 'vlegacy', 'film.html');
  await writeText(dir, JSON.stringify([{commit:'vlegacy',at:1,name:'legacy',kind:'named'}]), 'versions', 'versions.json');
  assert.equal((await history.loadHistory(id)).head, 'vlegacy');
  await history.checkoutVersion(id, 'vlegacy');
  assert.equal(await readText(dir, 'vendor', 'runtime.js'), 'vendor-v1');
  assert.equal(await readText(dir, 'pages', 'title.html'), 'nested-v1');
  await history.saveVersion(id, 'complete');
  assert(await readText(dir, 'versions', 'state.json'));
  await writeText(dir, '{broken', 'versions', 'state.json');
  await assert.rejects(history.loadHistory(id));
});

test('package and listing include root pages, nested pages, fonts, vendor and outputs', async () => {
  const { id } = await make('package');
  await putFile(id, 'downloads/out.mp4', bytes('output'));
  const listing = await listFiles(id);
  assert(listing.pages.some((f) => f.path === 'pages/title.html'));
  assert(listing.files.some((f) => f.path === 'fonts/font.woff2'));
  const pack = await buildPackage(id);
  const paths = pack.manifest.files.map((f) => f.path);
  for (const path of ['page.html','pages/title.html','vendor/runtime.js','fonts/font.woff2','assets/image.bin','downloads/out.mp4']) assert(paths.includes(path), path);
  const copy = await importPackage(pack.entries, 'copy');
  const copied = await buildPackage(copy.id);
  assert.deepEqual(copied.manifest.files, pack.manifest.files);
});

test('failed first history index publication leaves legacy history readable', async () => {
  const { id } = await make('failed index'); const dir = (await projectDir(id))!;
  await ensureDir(dir, ['versions', 'vlegacy']);
  await writeText(dir, '<html>legacy</html>', 'versions', 'vlegacy', 'film.html');
  await writeText(dir, JSON.stringify([{commit:'vlegacy',at:1,name:'legacy',kind:'named'}]), 'versions', 'versions.json');
  const original = MemoryFile.prototype.createWritable;
  MemoryFile.prototype.createWritable = async function() {
    if(this.name === 'state.json') return { write: async()=>{}, close: async()=>{throw new DOMException('quota','QuotaExceededError');}, abort: async()=>{} };
    return original.call(this);
  };
  try { await assert.rejects(history.saveVersion(id, 'fail'), /quota/); }
  finally { MemoryFile.prototype.createWritable = original; }
  assert.equal((await history.loadHistory(id)).head, 'vlegacy');
  assert.equal(await readText(dir, 'versions', 'state.json'), null);
});

test('page compare-and-swap refuses a stale concurrent writer and protects create-only writes', async () => {
  const store = await import('./store.ts'); const {id}=await make('page cas');
  const rev=await store.filmRev('nested-v1');
  await assert.rejects(store.writePage(id,'pages/title.html','overwrite',null), {status:409});
  const results=await Promise.allSettled([store.writePage(id,'pages/title.html','first',rev),store.writePage(id,'pages/title.html','second',rev)]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  assert.equal(results.filter(r=>r.status==='rejected').length,1);
  await store.writePage(id,'new/page.html','new',null);
});
