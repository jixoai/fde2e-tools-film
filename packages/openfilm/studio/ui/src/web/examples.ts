/**
 * Bundled example projects for the pure-Web editor (task 5.1 / T09 / T13).
 *
 * The static index and per-example manifest are emitted by scripts/vendor-examples.mjs. Loading is
 * atomic at the project level: fetch every same-origin file, validate path/size/sha256, then commit
 * one OPFS project with `.film/id` written last. A failed fetch, write, checksum or cancellation is
 * never visible as a project.
 */
import { createProjectFromFiles, type StoreProject } from './opfs/index.ts';

export const DEFAULT_EXAMPLE_ID = 'one-prompt';
const EXAMPLES_ROOT = '/examples/';
const INDEX_URL = `${EXAMPLES_ROOT}examples.json`;
const FETCH_CONCURRENCY = 8;
const MAX_FILES = 512;
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_PROJECT_BYTES = 128 * 1024 * 1024;
const PINNED_SOURCE = 'https://github.com/openfilm/examples';

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export type BundledExample = {
  id: string;
  title: string;
  description: string;
  poster: string | null;
  video: string | null;
  duration: number | null;
  category: string | null;
  segments: { title: string; from: number; to: number }[];
  /** Attribution link only. Runtime bytes never load from this address. */
  url: string;
  manifest: string;
};
export type BundledExampleManifest = {
  format: 1;
  id: string;
  name: string;
  source: { repository: string; commit: string; folder: string };
  files: { path: string; size: number; sha256: string }[];
};

type VerifiedFile = { path: string; bytes: ArrayBuffer };

const plain = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const safePath = (path: string): boolean => path.length > 0 && path.length <= 240
  && !path.startsWith('/') && !path.includes('\\') && !path.includes('\0')
  && path.split('/').every((part) => part !== '' && part !== '.' && part !== '..');

/** A URL path the browser may request for an example: absolute-on-origin, no traversal/query/hash. */
export function parseLocalExamplePath(value: unknown, prefix = EXAMPLES_ROOT): string {
  if (typeof value !== 'string' || !value.startsWith(prefix) || value.includes('\\') || value.includes('?') || value.includes('#')) {
    throw new Error(`example asset is not a local ${prefix} path`);
  }
  const parts = value.split('/');
  for (const encoded of parts.slice(1)) {
    let part = '';
    try { part = decodeURIComponent(encoded); } catch { throw new Error('example asset path has invalid encoding'); }
    if (!part || part === '.' || part === '..' || part.includes('/') || part.includes('\\') || part.includes('\0')) {
      throw new Error('example asset path contains traversal');
    }
  }
  return value;
}

const sourceUrl = (value: unknown, id: string): string => {
  if (typeof value !== 'string') throw new Error(`example ${id} source URL is invalid`);
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new Error(`example ${id} source URL is invalid`); }
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'github.com' || !parsed.pathname.startsWith('/openfilm/examples/')) {
    throw new Error(`example ${id} source URL is invalid`);
  }
  return parsed.href;
};

export function parseBundledExampleIndex(raw: unknown): BundledExample[] {
  if (!plain(raw) || raw.format !== 1 || !Array.isArray(raw.examples)) throw new Error('the bundled examples index is invalid');
  const ids = new Set<string>();
  return raw.examples.map((item, i) => {
    if (!plain(item)) throw new Error(`example ${i + 1} is invalid`);
    const id = typeof item.id === 'string' ? item.id : '';
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id) || ids.has(id)) throw new Error(`example id is invalid or repeated: ${id}`);
    ids.add(id);
    if (typeof item.title !== 'string' || !item.title.trim() || item.title.length > 120 || typeof item.description !== 'string') {
      throw new Error(`example ${id} has no valid title/description`);
    }
    const base = `${EXAMPLES_ROOT}${id}/`;
    const manifest = parseLocalExamplePath(item.manifest, base);
    if (manifest !== `${base}manifest.json`) throw new Error(`example ${id} manifest path is invalid`);
    const poster = item.poster === null ? null : parseLocalExamplePath(item.poster, base);
    const video = item.video === null ? null : parseLocalExamplePath(item.video, base);
    const segments = Array.isArray(item.segments) ? item.segments.map((segment) => {
      if (!plain(segment) || typeof segment.title !== 'string' || typeof segment.from !== 'number' || typeof segment.to !== 'number'
        || segment.from < 0 || segment.to <= segment.from) throw new Error(`example ${id} has an invalid segment`);
      return { title: segment.title, from: segment.from, to: segment.to };
    }) : [];
    return {
      id,
      title: item.title,
      description: item.description,
      poster,
      video,
      duration: typeof item.duration === 'number' && item.duration > 0 ? item.duration : null,
      category: typeof item.category === 'string' ? item.category : null,
      segments,
      url: sourceUrl(item.url, id),
      manifest,
    };
  });
}

export function parseBundledExampleManifest(raw: unknown, expectedId: string): BundledExampleManifest {
  if (!plain(raw) || raw.format !== 1 || raw.id !== expectedId || typeof raw.name !== 'string' || !raw.name.trim() || raw.name.length > 120
    || !plain(raw.source) || raw.source.repository !== PINNED_SOURCE || !/^[a-f0-9]{40}$/.test(String(raw.source.commit))
    || raw.source.folder !== expectedId || !Array.isArray(raw.files) || raw.files.length === 0 || raw.files.length > MAX_FILES) {
    throw new Error(`example manifest is invalid: ${expectedId}`);
  }
  const seen = new Set<string>();
  let total = 0;
  const files = raw.files.map((file) => {
    if (!plain(file) || typeof file.path !== 'string' || !safePath(file.path) || seen.has(file.path)
      || !Number.isInteger(file.size) || (file.size as number) < 0 || (file.size as number) > MAX_FILE_BYTES
      || typeof file.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(file.sha256)) {
      throw new Error(`example ${expectedId} has an invalid file entry`);
    }
    seen.add(file.path);
    total += file.size as number;
    if (total > MAX_PROJECT_BYTES) throw new Error(`example ${expectedId} is too large`);
    return { path: file.path, size: file.size as number, sha256: file.sha256 };
  });
  for (const required of [
    'film.html', 'LICENSE', 'CREDITS.md', 'UPSTREAM_CREDITS.md', 'THIRD_PARTY_NOTICES.md', 'EXAMPLE-METADATA.json',
    'assets/fonts/OFL.txt', 'src/px/LICENSE-pdoom-video.txt', 'vendor/three/LICENSE',
    'vendor/three/three.module.js', 'vendor/three/three.core.js', 'vendor/three/addons/loaders/FontLoader.js',
  ]) {
    if (!seen.has(required)) throw new Error(`example ${expectedId} is missing ${required}`);
  }
  return {
    format: 1,
    id: expectedId,
    name: raw.name,
    source: { repository: raw.source.repository, commit: String(raw.source.commit), folder: raw.source.folder },
    files,
  };
}

const sha256 = async (bytes: ArrayBuffer): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
};

const browserOrigin = (): string => {
  if (typeof location === 'undefined' || !location.origin) throw new Error('bundled examples require a browser origin');
  return location.origin;
};

async function fetchLocal(
  path: string,
  init: RequestInit,
  fetcher: FetchLike = fetch,
  origin = browserOrigin(),
): Promise<Response> {
  const url = new URL(path, origin);
  if (url.origin !== origin || !url.pathname.startsWith(EXAMPLES_ROOT)) throw new Error(`example request escaped the Film origin: ${path}`);
  const response = await fetcher(url.href, {
    ...init,
    mode: 'same-origin',
    credentials: 'same-origin',
    redirect: 'error',
  });
  if (response.url && new URL(response.url).origin !== origin) throw new Error(`example response escaped the Film origin: ${path}`);
  return response;
}

let indexRead: Promise<BundledExample[]> | null = null;
export function listBundledExamples(): Promise<BundledExample[]> {
  indexRead ??= fetchLocal(INDEX_URL, { cache: 'no-cache' }).then(async (response) => {
    if (!response.ok) throw new Error(`examples index answered ${response.status}`);
    return parseBundledExampleIndex(await response.json());
  }).catch((error) => { indexRead = null; throw error; });
  return indexRead;
}

async function fetchVerifiedFiles(
  example: BundledExample,
  manifest: BundledExampleManifest,
  signal?: AbortSignal,
): Promise<VerifiedFile[]> {
  const base = new URL('.', new URL(example.manifest, browserOrigin()));
  const out = new Array<VerifiedFile>(manifest.files.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= manifest.files.length) return;
      const entry = manifest.files[i]!;
      const path = new URL(entry.path.split('/').map(encodeURIComponent).join('/'), base).pathname;
      const response = await fetchLocal(path, { cache: 'force-cache', signal });
      if (!response.ok) throw new Error(`example file answered ${response.status}: ${entry.path}`);
      const bytes = await response.arrayBuffer();
      if (bytes.byteLength !== entry.size) throw new Error(`example file size mismatch: ${entry.path}`);
      if (await sha256(bytes) !== entry.sha256) throw new Error(`example file checksum mismatch: ${entry.path}`);
      out[i] = { path: entry.path, bytes };
    }
  };
  await Promise.all(Array.from({ length: Math.min(FETCH_CONCURRENCY, manifest.files.length) }, worker));
  return out;
}

/** Load a bundled example into an independent normal OPFS project. Repeated loads create new ids. */
export async function loadBundledExample(
  id = DEFAULT_EXAMPLE_ID,
  options: { signal?: AbortSignal } = {},
): Promise<StoreProject> {
  const example = (await listBundledExamples()).find((item) => item.id === id);
  if (!example) throw new Error(`no such bundled example: ${id}`);
  const manifestResponse = await fetchLocal(example.manifest, { cache: 'no-cache', signal: options.signal });
  if (!manifestResponse.ok) throw new Error(`example manifest answered ${manifestResponse.status}: ${id}`);
  const manifest = parseBundledExampleManifest(await manifestResponse.json(), id);
  const verified = await fetchVerifiedFiles(example, manifest, options.signal);
  if (options.signal?.aborted) throw new DOMException('example load cancelled', 'AbortError');
  return createProjectFromFiles(
    manifest.name,
    verified.map((file) => ({ path: file.path, data: file.bytes })),
    options,
  );
}
