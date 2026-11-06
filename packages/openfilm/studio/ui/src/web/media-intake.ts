/**
 * Passive media intake for the pure-Web editor (D7 / task 5.2).
 *
 * This module never calls a generation provider and never handles credentials. It accepts bytes
 * already produced elsewhere (File/Blob or base64) and copies CORS-readable media from the three
 * CDN hosts T05 verified. Every source becomes an ordinary same-origin OPFS asset before use.
 */
import { safeName } from '../lib/workspace-resources.ts';
import { getProject, listFiles, putFile } from './opfs/index.ts';

export const MEDIA_URL_HOSTS = ['images.pexels.com', 'cdn.pixabay.com', 'v3.fal.media'] as const;
export const MAX_ENCODED_MEDIA_BYTES = 64 * 1024 * 1024;
const URL_TIMEOUT_MS = 30_000;

export type MediaIntakeErrorCode =
  | 'invalid-url'
  | 'url-host'
  | 'url-read'
  | 'url-status'
  | 'invalid-base64'
  | 'too-large'
  | 'not-media'
  | 'name'
  | 'project-gone';

export class MediaIntakeError extends Error {
  readonly code: MediaIntakeErrorCode;
  constructor(code: MediaIntakeErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = 'MediaIntakeError';
  }
}

export type MediaReceipt = {
  projectId: string;
  path: string;
  name: string;
  size: number;
  mime: string;
  kind: 'image' | 'video' | 'audio' | 'other';
  source: 'file' | 'base64' | 'url';
};

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;
type MediaBytes = { bytes: Blob; name: string; mime: string; kind: MediaReceipt['kind'] };

const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif']);
const VIDEO_EXT = new Set(['mp4', 'm4v', 'mov', 'webm', 'mkv']);
const AUDIO_EXT = new Set(['mp3', 'wav', 'm4a', 'aac', 'ogg', 'opus', 'flac']);
const extOf = (name: string): string => /\.([a-z0-9]{1,12})$/i.exec(name)?.[1]?.toLowerCase() ?? '';
const kindOfExt = (ext: string): MediaReceipt['kind'] => IMAGE_EXT.has(ext) ? 'image'
  : VIDEO_EXT.has(ext) ? 'video' : AUDIO_EXT.has(ext) ? 'audio' : 'other';
const mimeOfExt = (ext: string): string => ({
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif',
  mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', mkv: 'video/x-matroska',
  mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', aac: 'audio/aac', ogg: 'audio/ogg', opus: 'audio/ogg', flac: 'audio/flac',
} as Record<string, string>)[ext] ?? 'application/octet-stream';
const extOfMime = (mime: string): string => ({
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/avif': 'avif',
  'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/webm': 'webm', 'video/x-matroska': 'mkv',
  'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/mp4': 'm4a',
  'audio/aac': 'aac', 'audio/ogg': 'ogg', 'audio/opus': 'opus', 'audio/flac': 'flac',
} as Record<string, string>)[mime] ?? '';
const kindOfMime = (mime: string): MediaReceipt['kind'] => mime.startsWith('image/') ? 'image'
  : mime.startsWith('video/') ? 'video' : mime.startsWith('audio/') ? 'audio' : 'other';
const normalizedMime = (mime: string | null | undefined): string => String(mime ?? '').split(';', 1)[0]!.trim().toLowerCase();

const bytesStart = async (blob: Blob, length = 16): Promise<Uint8Array> => new Uint8Array(await blob.slice(0, length).arrayBuffer());
const ascii = (bytes: Uint8Array, start: number, length: number): string => String.fromCharCode(...bytes.slice(start, start + length));

/** Sniff only media containers we can safely serve from a project origin; HTML/SVG/script never pass. */
export async function sniffMediaKind(blob: Blob): Promise<MediaReceipt['kind']> {
  const b = await bytesStart(blob);
  if (b.length >= 8 && b[0] === 0x89 && ascii(b, 1, 3) === 'PNG') return 'image';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image';
  if (ascii(b, 0, 6) === 'GIF87a' || ascii(b, 0, 6) === 'GIF89a') return 'image';
  if (ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP') return 'image';
  if (b.length >= 12 && ascii(b, 4, 4) === 'ftyp') {
    const brand = ascii(b, 8, 4).toLowerCase();
    return brand === 'avif' || brand === 'avis' ? 'image' : (brand === 'm4a ' || brand === 'm4b ' ? 'audio' : 'video');
  }
  if (b.length >= 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return 'video';
  if (ascii(b, 0, 3) === 'ID3' || (b.length >= 2 && b[0] === 0xff && (b[1]! & 0xe0) === 0xe0)) return 'audio';
  if (ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WAVE') return 'audio';
  if (ascii(b, 0, 4) === 'OggS' || ascii(b, 0, 4) === 'fLaC') return 'audio';
  if (b.length >= 2 && b[0] === 0xff && (b[1]! & 0xf6) === 0xf0) return 'audio'; // AAC ADTS
  return 'other';
}

export function parseMediaUrl(raw: string): URL {
  let url: URL;
  const localOrigin = typeof location !== 'undefined' ? location.origin : undefined;
  try { url = new URL(raw, localOrigin); } catch { throw new MediaIntakeError('invalid-url', 'media URL is invalid'); }
  if (localOrigin && url.origin === localOrigin && !url.username && !url.password && ['http:','https:'].includes(url.protocol)) {
    url.hash = ''; return url;
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) {
    throw new MediaIntakeError('invalid-url', 'media URL must be a plain HTTPS address');
  }
  if (!(MEDIA_URL_HOSTS as readonly string[]).includes(url.hostname.toLowerCase())) {
    throw new MediaIntakeError('url-host', `media URL host is not allowed: ${url.hostname}`);
  }
  url.hash = '';
  return url;
}

function checkedName(raw: string | undefined, fallback: string, mime: string, kind: MediaReceipt['kind']): string {
  let name = safeName(raw?.trim() || fallback) || 'media';
  const ext = extOf(name);
  const wanted = extOfMime(mime);
  if (!ext && wanted) name = `${name}.${wanted}`;
  const namedKind = kindOfExt(extOf(name));
  if (kind === 'other' || namedKind === 'other' || namedKind !== kind) {
    throw new MediaIntakeError('name', 'media name must have an image, video, or audio extension matching its bytes');
  }
  return name;
}

async function validateMedia(blob: Blob, rawName: string | undefined, fallback: string, declaredMime?: string): Promise<MediaBytes> {
  if (blob.size <= 0) throw new MediaIntakeError('not-media', 'media is empty');
  if (blob.size > MAX_ENCODED_MEDIA_BYTES) throw new MediaIntakeError('too-large', `media exceeds ${MAX_ENCODED_MEDIA_BYTES} bytes`);
  const sniffed = await sniffMediaKind(blob);
  const declared = normalizedMime(declaredMime || blob.type);
  const declaredKind = kindOfMime(declared);
  if (sniffed === 'other' || (declared && declaredKind !== 'other' && declaredKind !== sniffed)) {
    throw new MediaIntakeError('not-media', 'bytes are not a supported image, video, or audio file');
  }
  const mime = declaredKind === sniffed ? declared : mimeOfExt(extOf(rawName ?? fallback));
  const name = checkedName(rawName, fallback, mime, sniffed);
  return { bytes: blob, name, mime: mime === 'application/octet-stream' ? mimeOfExt(extOf(name)) : mime, kind: sniffed };
}

async function readLimitedBlob(response: Response, mime: string): Promise<Blob> {
  if (!response.body) {
    const blob = await response.blob();
    if (blob.size > MAX_ENCODED_MEDIA_BYTES) throw new MediaIntakeError('too-large', `media exceeds ${MAX_ENCODED_MEDIA_BYTES} bytes`);
    return blob;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_ENCODED_MEDIA_BYTES) {
        await reader.cancel('media too large');
        throw new MediaIntakeError('too-large', `media exceeds ${MAX_ENCODED_MEDIA_BYTES} bytes`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return new Blob(chunks as BlobPart[], { type: mime });
}

export async function readMediaUrl(
  rawUrl: string,
  options: { name?: string; signal?: AbortSignal; fetcher?: FetchLike } = {},
): Promise<MediaBytes> {
  const url = parseMediaUrl(rawUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException('media URL timed out', 'TimeoutError')), URL_TIMEOUT_MS);
  const abort = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener('abort', abort, { once: true });
  try {
    let response: Response;
    try {
      response = await (options.fetcher ?? fetch)(url, {
        mode: 'cors', credentials: 'omit', redirect: 'follow', referrerPolicy: 'no-referrer', cache: 'no-store', signal: controller.signal,
      });
    } catch (error) {
      throw new MediaIntakeError('url-read', error instanceof Error ? error.message : 'browser could not read the media URL');
    }
    if (!response.ok) throw new MediaIntakeError('url-status', `media URL answered ${response.status}`);
    const finalUrl = parseMediaUrl(response.url || url.href); // redirect host is checked again, fail closed
    const stated = Number(response.headers.get('content-length'));
    if (Number.isFinite(stated) && stated > MAX_ENCODED_MEDIA_BYTES) {
      throw new MediaIntakeError('too-large', `media exceeds ${MAX_ENCODED_MEDIA_BYTES} bytes`);
    }
    const fallback = decodeURIComponent(finalUrl.pathname.split('/').filter(Boolean).pop() ?? 'media');
    const mime = response.headers.get('content-type') ?? '';
    return validateMedia(await readLimitedBlob(response, mime), options.name, fallback, mime);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', abort);
  }
}

export function decodeMediaBase64(raw: string, declaredMime?: string): { blob: Blob; mime: string } {
  let base64 = raw.trim();
  let mime = normalizedMime(declaredMime);
  const data = /^data:([^;,]+)?;base64,([\s\S]+)$/i.exec(base64);
  if (data) { mime = normalizedMime(data[1]) || mime; base64 = data[2]!; }
  base64 = base64.replace(/\s+/g, '');
  if (!base64 || base64.length % 4 !== 0
    || base64.length > Math.ceil(MAX_ENCODED_MEDIA_BYTES / 3) * 4 + 4) {
    throw new MediaIntakeError('invalid-base64', 'media base64 is invalid or too large');
  }
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  // A repeated-quartet regex can exhaust the JS regexp stack on ordinary multi-MB media.
  // Scan the alphabet once; only the final one or two characters may be padding.
  for (let i = 0; i < base64.length - padding; i++) {
    const code = base64.charCodeAt(i);
    if (!((code >= 65 && code <= 90) || (code >= 97 && code <= 122)
      || (code >= 48 && code <= 57) || code === 43 || code === 47)) {
      throw new MediaIntakeError('invalid-base64', 'media base64 is invalid or too large');
    }
  }
  const decodedLength = base64.length / 4 * 3 - padding;
  if (decodedLength > MAX_ENCODED_MEDIA_BYTES) throw new MediaIntakeError('too-large', `media exceeds ${MAX_ENCODED_MEDIA_BYTES} bytes`);
  let binary: string;
  try { binary = atob(base64); } catch { throw new MediaIntakeError('invalid-base64', 'media base64 is invalid'); }
  if (binary.length > MAX_ENCODED_MEDIA_BYTES) throw new MediaIntakeError('too-large', `media exceeds ${MAX_ENCODED_MEDIA_BYTES} bytes`);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return { blob: new Blob([bytes], { type: mime }), mime };
}

const tails = new Map<string, Promise<void>>();
async function serial<T>(key: string, run: () => Promise<T>): Promise<T> {
  const before = tails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>((done) => { release = done; });
  const tail = before.catch(() => {}).then(() => next);
  tails.set(key, tail);
  await before.catch(() => {});
  try { return await run(); } finally { release(); if (tails.get(key) === tail) tails.delete(key); }
}

function safeFolder(raw: string): string {
  const folder = raw.replace(/\/+$/g, '');
  const parts = folder.split('/');
  if (parts[0] !== 'assets' || parts.some((part) => !part || part === '.' || part === '..' || part.startsWith('.')
    || part.includes('\\') || part !== safeName(part))) {
    throw new MediaIntakeError('name', 'media folder must stay under assets/');
  }
  return folder;
}

async function freePath(projectId: string, folder: string, name: string): Promise<string> {
  const listing = await listFiles(projectId);
  const used = new Set([...listing.files.map((file) => file.path), ...listing.pages.map((page) => page.path)]);
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  let path = `${folder}/${name}`;
  for (let n = 2; used.has(path); n++) path = `${folder}/${stem} (${n})${ext}`;
  return path;
}

async function commitMedia(
  projectId: string,
  media: MediaBytes,
  source: MediaReceipt['source'],
  folder = 'assets',
): Promise<MediaReceipt> {
  return serial(projectId, async () => {
    if (!await getProject(projectId)) throw new MediaIntakeError('project-gone', `no such project: ${projectId}`);
    const path = await freePath(projectId, safeFolder(folder), media.name);
    await putFile(projectId, path, media.bytes);
    return { projectId, path, name: path.slice(path.lastIndexOf('/') + 1), size: media.bytes.size, mime: media.mime, kind: media.kind, source };
  });
}

/** Browser File/drop/BU upload: binary bytes go straight into OPFS; any project file kind remains allowed. */
export async function importProjectBinary(projectId: string, file: File, folder = 'assets'): Promise<MediaReceipt> {
  const name = safeName(file.name);
  if (!name) throw new MediaIntakeError('name', 'file has no usable name');
  if (file.size <= 0) throw new MediaIntakeError('not-media', 'file is empty');
  return serial(projectId, async () => {
    if (!await getProject(projectId)) throw new MediaIntakeError('project-gone', `no such project: ${projectId}`);
    const path = await freePath(projectId, safeFolder(folder), name);
    await putFile(projectId, path, file);
    const ext = extOf(name);
    return {
      projectId, path, name: path.slice(path.lastIndexOf('/') + 1), size: file.size,
      mime: normalizedMime(file.type) || mimeOfExt(ext), kind: kindOfExt(ext), source: 'file',
    };
  });
}

export async function importMediaUrl(
  projectId: string,
  url: string,
  options: { name?: string; folder?: string; signal?: AbortSignal; fetcher?: FetchLike } = {},
): Promise<MediaReceipt> {
  return commitMedia(projectId, await readMediaUrl(url, options), 'url', options.folder);
}

export async function importMediaBase64(
  projectId: string,
  dataBase64: string,
  options: { name: string; mime?: string; folder?: string } ,
): Promise<MediaReceipt> {
  const decoded = decodeMediaBase64(dataBase64, options.mime);
  const media = await validateMedia(decoded.blob, options.name, options.name, decoded.mime);
  return commitMedia(projectId, media, 'base64', options.folder);
}


/** Browser-native metadata for an OPFS asset, used by the media pane and immediate timeline insert. */
export async function probeWebMedia(
  projectId: string,
  path: string,
  kind: 'video' | 'image' | 'audio' | 'page' | 'other',
): Promise<{ durationMs?: number; w?: number; h?: number; audio?: boolean }> {
  const url = `/wf/${encodeURIComponent(projectId)}/${path.split('/').map(encodeURIComponent).join('/')}`;
  if (kind === 'image') {
    const image = new Image();
    image.decoding = 'async';
    const loaded = new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error(`could not read image metadata: ${path}`));
    });
    image.src = url;
    await loaded;
    return { w: image.naturalWidth || undefined, h: image.naturalHeight || undefined };
  }
  if (kind === 'video' || kind === 'audio') {
    const media = document.createElement(kind === 'video' ? 'video' : 'audio');
    media.preload = 'metadata';
    const loaded = new Promise<void>((resolve, reject) => {
      media.onloadedmetadata = () => resolve();
      media.onerror = () => reject(new Error(`could not read media metadata: ${path}`));
    });
    media.src = url;
    await loaded;
    const out = {
      ...(Number.isFinite(media.duration) && media.duration > 0 ? { durationMs: Math.round(media.duration * 1000) } : {}),
      ...(media instanceof HTMLVideoElement && media.videoWidth > 0 ? { w: media.videoWidth, h: media.videoHeight } : {}),
      ...(kind === 'video' ? { audio: true } : {}),
    };
    media.removeAttribute('src');
    media.load();
    return out;
  }
  return {};
}
