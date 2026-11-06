/**
 * The interchange package (design D9, spec web-film-interchange): the ONE way a project moves.
 *
 *   ProjectPackage = manifest.film.json + film.html + assets/** (+ the project's own files)
 *
 * The same manifest the FSA save-back writes and the zip download packs, and the only shape the
 * receiver accepts — zip in (upload/drop/BU payload) and MessageChannel payloads share the
 * checksums and the asset index, so byte-for-byte agreement can be checked. Checksums are
 * sha-256 (WebCrypto), the digest family the store's rev uses.
 *
 * zip: stored entries (media is compressed already — the upstream zip.mjs discipline), so the
 * writer here is ~80 lines and the reader needs inflate only for foreign zips, via the browser's
 * own DecompressionStream('deflate-raw'). Chromium only, like the rest of the web face.
 */
import { withProjectLock } from './opfs/project-lock.ts';
import { safeProjectPath } from './opfs/store.ts';
import { createProjectFromFiles, getProject, listFiles, readFileBytes } from './opfs/index.ts';

export const MANIFEST = 'manifest.film.json';
export const PACKAGE_KIND = 'fde2e-film-project';
export const PACKAGE_FORMAT = 1;
export const MAX_PACKAGE_BYTES = 256 * 1024 * 1024;
export const MAX_PACKAGE_FILES = 4096;

export interface PackageFile { path: string; size: number; sha256: string }
export interface PackageManifest {
  format: typeof PACKAGE_FORMAT;
  kind: typeof PACKAGE_KIND;
  name: string;
  projectId?: string;
  savedAt: number;
  filmRev: string;
  files: PackageFile[];
}
/** One file of a package: its in-package path and its bytes. */
export interface PackageEntry { path: string; bytes: ArrayBuffer }

const sha256 = async (data: ArrayBuffer): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
};

/* ── building: OPFS project → package files ───────────────────────────── */

/** The project as package entries: manifest.film.json + film.html + every project file.
    `.film/` (state, versions) stays out — the package is the working copy, not the archive. */
export async function buildPackage(id: string): Promise<{ name: string; entries: PackageEntry[]; manifest: PackageManifest }> {
  return withProjectLock(id, async () => {
  const project = await getProject(id);
  if (!project) throw new Error('the project is gone');
  const filmBytes = await readFileBytes(id, 'film.html');
  if (!filmBytes) throw new Error('the project has no film');

  const files: PackageFile[] = [{ path: 'film.html', size: filmBytes.byteLength, sha256: await sha256(filmBytes) }];
  const entries: PackageEntry[] = [{ path: 'film.html', bytes: filmBytes }];
  const listing = await listFiles(id);
  for (const f of [...listing.files, ...listing.pages].sort((a, b) => a.path.localeCompare(b.path))) {
    if (f.path === 'film.html') continue;
    const bytes = await readFileBytes(id, f.path);
    if (bytes === null) throw new Error(`project file disappeared: ${f.path}`);
    files.push({ path: f.path, size: bytes.byteLength, sha256: await sha256(bytes) });
    entries.push({ path: f.path, bytes });
  }
  const manifest: PackageManifest = {
    format: PACKAGE_FORMAT,
    kind: PACKAGE_KIND,
    name: project.name,
    projectId: id,
    savedAt: Date.now(),
    filmRev: files[0].sha256.slice(0, 16),
    files,
  };
  entries.push({ path: MANIFEST, bytes: new TextEncoder().encode(JSON.stringify(manifest, null, 1) + '\n').buffer as ArrayBuffer });
  await verifyPackage(entries);
  return { name: project.name, entries, manifest };
  });
}

/* ── the zip writer: stored entries, zip64 when a size needs it ────────── */

const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
export const crc32 = (data: Uint8Array, seed = 0): number => {
  let c = seed ^ 0xffffffff;
  for (let i = 0; i < data.length; i++) c = crcTable[(c ^ data[i]) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

const u16 = (v: number) => new Uint8Array([v & 0xff, (v >>> 8) & 0xff]);
const u32 = (v: number) => new Uint8Array([v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff]);
/** little-endian pieces into one buffer */
const join = (pieces: Uint8Array[]): ArrayBuffer => {
  const at = new Uint8Array(pieces.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of pieces) { at.set(p, o); o += p.length; }
  return at.buffer;
};
const dosStamp = () => {
  const d = new Date();
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    day: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
};
const MAX32 = 0xffffffff;

/** The entries as one stored zip (the package's own transport). */
export function zipEntries(entries: readonly PackageEntry[]): ArrayBuffer {
  if (entries.length > MAX_PACKAGE_FILES || entries.reduce((n, e) => n + e.bytes.byteLength + new TextEncoder().encode(e.path).length * 2 + 76, 22) > MAX_PACKAGE_BYTES) throw new Error('package exceeds transport limit');
  const { time, day } = dosStamp();
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  const put = (p: Uint8Array | ArrayBuffer) => { const u = p instanceof Uint8Array ? p : new Uint8Array(p); parts.push(u); offset += u.length; };
  for (const e of entries) {
    const localAt = offset; // the central record names the local header's place
    const data = new Uint8Array(e.bytes);
    const big = data.length >= MAX32 || offset >= MAX32;
    const name = new TextEncoder().encode(e.path);
    const big64 = (n: bigint) => new Uint8Array(new BigUint64Array([n]).buffer);
    const extra = big ? new Uint8Array(join([u16(0x0001), u16(16), big64(BigInt(data.length)), big64(BigInt(data.length))])) : new Uint8Array(0);
    const crc = crc32(data);
    put(join([u32(0x04034b50), u16(big ? 45 : 20), u16(0x0800), u16(0), u16(time), u16(day), u32(crc), u32(big ? MAX32 : data.length), u32(big ? MAX32 : data.length), u16(name.length), u16(extra.length)]));
    put(name); put(extra); put(data);
    central.push(new Uint8Array(join([u32(0x02014b50), u16(big ? 45 : 20), u16(big ? 45 : 20), u16(0x0800), u16(0), u16(time), u16(day), u32(crc), u32(big ? MAX32 : data.length), u32(big ? MAX32 : data.length), u16(name.length), u16(extra.length), u16(0), u16(0), u16(0), u32(0), u32(localAt)])));
    central.push(name); central.push(extra);
  }
  const centralAt = offset;
  let centralSize = 0;
  for (const p of central) centralSize += p.length;
  put(join(central));
  put(join([u32(0x06054b50), u16(0), u16(0), u16(entries.length), u16(entries.length), u32(centralSize), u32(centralAt), u16(0)]));
  return join(parts);
}

/* ── the zip reader: stored (ours) + deflate-raw (foreign zips) ────────── */

const raw = (b: ArrayBuffer) => new DataView(b);
const text = (b: ArrayBuffer, at: number, len: number) => new TextDecoder().decode(new Uint8Array(b, at, len));
async function inflate(bytes: Uint8Array, limit: number): Promise<ArrayBuffer> {
  const reader = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader();
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      size += value.byteLength; if (size > limit) throw new Error('package exceeds declared size');
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  return new Blob(chunks as BlobPart[]).arrayBuffer();
}

/** The zip's entries (files only), stored or deflated. Throws when it is not a zip. */
export async function unzipEntries(zip: ArrayBuffer): Promise<PackageEntry[]> {
  if (zip.byteLength > MAX_PACKAGE_BYTES) throw new Error('package is too large');
  const v = raw(zip);
  if (zip.byteLength < 22 || v.getUint32(0, true) !== 0x04034b50) throw new Error('not a zip file');
  // find the end-of-central-directory record (comment can trail it)
  let eocd = -1;
  for (let at = zip.byteLength - 22; at >= Math.max(0, zip.byteLength - 65557); at--) {
    if (v.getUint32(at, true) === 0x06054b50) { eocd = at; break; }
  }
  if (eocd < 0) throw new Error('not a zip file');
  const count = v.getUint16(eocd + 10, true);
  if (count > MAX_PACKAGE_FILES) throw new Error('too many package files');
  let expanded = 0;
  let at = v.getUint32(eocd + 16, true);
  const out: PackageEntry[] = [];
  for (let i = 0; i < count; i++) {
    if (v.getUint32(at, true) !== 0x02014b50) throw new Error('not a zip file');
    const method = v.getUint16(at + 10, true);
    const compressedSize = v.getUint32(at + 20, true);
    const size = v.getUint32(at + 24, true);
    expanded += size; if (expanded > MAX_PACKAGE_BYTES) throw new Error('package expands beyond limit');
    const nameLen = v.getUint16(at + 28, true);
    const extraLen = v.getUint16(at + 30, true);
    const commentLen = v.getUint16(at + 32, true);
    const local = v.getUint32(at + 42, true);
    const name = text(zip, at + 46, nameLen);
    const localNameLen = v.getUint16(local + 26, true);
    const localExtraLen = v.getUint16(local + 28, true);
    const dataAt = local + 30 + localNameLen + localExtraLen;
    if (!name.endsWith('/')) {
      if (dataAt + compressedSize > zip.byteLength) throw new Error('truncated zip entry');
      const stored = new Uint8Array(zip, dataAt, compressedSize);
      const bytes = method === 0 ? stored.slice().buffer
        : method === 8 ? await inflate(stored, size)
        : (() => { throw new Error(`unsupported zip method ${method}`); })();
      if (bytes.byteLength !== size) throw new Error('zip size mismatch');
      out.push({ path: name, bytes });
    }
    at += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/* ── verify + receive: entries → project ──────────────────────────────── */

/** The package checked: a manifest of ours, and every indexed file present with its exact
    checksum. Answers the manifest. Anything missing or a byte off refuses (no partial project). */
export async function verifyPackage(entries: readonly PackageEntry[]): Promise<PackageManifest> {
  if (!Array.isArray(entries) || entries.length > MAX_PACKAGE_FILES) throw new Error('invalid package entries');
  const byPath = new Map<string, PackageEntry>(); let total = 0;
  for (const entry of entries) {
    if (!entry || typeof entry.path !== 'string' || !safeProjectPath(entry.path) || byPath.has(entry.path)
      || !(entry.bytes instanceof ArrayBuffer)) throw new Error('invalid or duplicate package path');
    total += entry.bytes.byteLength;
    if (total > MAX_PACKAGE_BYTES) throw new Error('package is too large');
    byPath.set(entry.path, entry);
  }
  const manifestEntry = byPath.get(MANIFEST);
  if (!manifestEntry || manifestEntry.bytes.byteLength > 2 * 1024 * 1024) throw new Error(`missing or oversized ${MANIFEST}`);
  const manifest = JSON.parse(new TextDecoder().decode(manifestEntry.bytes)) as PackageManifest;
  if (!manifest || manifest.kind !== PACKAGE_KIND || manifest.format !== PACKAGE_FORMAT || typeof manifest.name !== 'string') throw new Error('not a fde2e film package');
  if (!Array.isArray(manifest.files) || !manifest.files.some((f) => f.path === 'film.html') || manifest.files.length + 1 !== entries.length) throw new Error('package file index mismatch');
  const seen = new Set<string>();
  for (const f of manifest.files) {
    if (!f || typeof f.path !== 'string' || f.path === MANIFEST || seen.has(f.path) || !safeProjectPath(f.path)
      || !Number.isSafeInteger(f.size) || f.size < 0 || !/^[a-f0-9]{64}$/.test(f.sha256)) throw new Error('invalid package file index');
    seen.add(f.path);
    const e = byPath.get(f.path);
    if (!e) throw new Error(`the package is missing ${f.path}`);
    if (e.bytes.byteLength !== f.size || (await sha256(e.bytes)) !== f.sha256) throw new Error(`${f.path}: does not match its checksum`);
  }
  if (manifest.filmRev !== manifest.files.find((f) => f.path === 'film.html')!.sha256.slice(0, 16)) throw new Error('film revision mismatch');
  return manifest;
}

/** A verified package in: a new project (its name from the manifest, or the one given — a copy
    names itself), every file put. Answers it. */
export async function importPackage(entries: readonly PackageEntry[], name?: string, options: { signal?: AbortSignal } = {}): Promise<{ id: string; name: string }> {
  options.signal?.throwIfAborted();
  const manifest = await verifyPackage(entries);
  options.signal?.throwIfAborted();
  const project = await createProjectFromFiles((name ?? '').trim() || manifest.name, manifest.files.map((file) => {
    const entry = entries.find((candidate) => candidate.path === file.path)!;
    return { path: file.path, data: entry.bytes };
  }), options);
  return { id: project.id, name: project.name };
}

/** A version snapshot's entries as a package: the manifest is built fresh from what the snapshot
    holds (the snapshot tree has no manifest of its own — the index carries its name). */
export async function importVersion(entries: readonly PackageEntry[], name?: string): Promise<{ id: string; name: string }> {
  const files: PackageFile[] = [];
  for (const e of entries) {
    if (e.path === MANIFEST) continue;
    files.push({ path: e.path, size: e.bytes.byteLength, sha256: await sha256(e.bytes) });
  }
  const film = files.find((f) => f.path === 'film.html');
  if (!film) throw new Error('the version has no film');
  const manifest: PackageManifest = {
    format: PACKAGE_FORMAT,
    kind: PACKAGE_KIND,
    name: name ?? 'Copy',
    savedAt: Date.now(),
    filmRev: film.sha256.slice(0, 16),
    files,
  };
  const withManifest = [...entries.filter((e) => e.path !== MANIFEST), { path: MANIFEST, bytes: new TextEncoder().encode(JSON.stringify(manifest, null, 1) + '\n').buffer as ArrayBuffer }];
  return importPackage(withManifest, name);
}

/** Whether a dropped/picked file is a package (a zip whose manifest is ours) — cheap first read. */
export const looksLikePackage = (file: File): boolean => /\.zip$/i.test(file.name);
