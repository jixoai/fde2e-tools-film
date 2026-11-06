import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_ENCODED_MEDIA_BYTES,
  MediaIntakeError,
  decodeMediaBase64,
  parseMediaUrl,
  readMediaUrl,
  sniffMediaKind,
} from './media-intake.ts';

const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0, 0, 0, 0]);
const png64 = btoa(String.fromCharCode(...png));

test('same-origin media needs no CDN proxy and cannot escape to another local service', () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'location');
  Object.defineProperty(globalThis, 'location', { value: { origin: 'http://127.0.0.1:13689' }, configurable: true });
  try {
    assert.equal(parseMediaUrl('/examples/music.mp3').origin, 'http://127.0.0.1:13689');
    assert.throws(() => parseMediaUrl('http://127.0.0.1:13688/music.mp3'), MediaIntakeError);
    assert.throws(() => parseMediaUrl('http://user:pass@127.0.0.1:13689/music.mp3'), MediaIntakeError);
  } finally { if (previous) Object.defineProperty(globalThis, 'location', previous); else delete (globalThis as { location?: unknown }).location; }
});

test('URL intake is HTTPS and exact-host allowlisted', () => {
  assert.equal(parseMediaUrl('https://images.pexels.com/photos/a.jpg?w=20').hostname, 'images.pexels.com');
  assert.equal(parseMediaUrl('https://cdn.pixabay.com/photo/a.png').hostname, 'cdn.pixabay.com');
  assert.equal(parseMediaUrl('https://v3.fal.media/files/a.webp').hostname, 'v3.fal.media');
  for (const url of [
    'http://images.pexels.com/a.jpg', 'https://evil.test/a.jpg', 'https://images.pexels.com.evil.test/a.jpg',
    'https://user:pass@images.pexels.com/a.jpg', 'https://images.pexels.com:444/a.jpg',
  ]) assert.throws(() => parseMediaUrl(url), MediaIntakeError);
});

test('base64 accepts raw or data URL bytes and rejects malformed/oversized input before allocation', () => {
  const raw = decodeMediaBase64(png64, 'image/png');
  assert.equal(raw.blob.size, png.length);
  assert.equal(raw.mime, 'image/png');
  const data = decodeMediaBase64(`data:image/png;base64,${png64}`);
  assert.equal(data.blob.size, png.length);
  assert.equal(data.mime, 'image/png');
  assert.throws(() => decodeMediaBase64('not base64!'), /invalid/);
  assert.throws(() => decodeMediaBase64('A'.repeat(Math.ceil(MAX_ENCODED_MEDIA_BYTES / 3) * 4 + 8)), /too large/);
});

test('sniffer distinguishes safe media containers and refuses active text', async () => {
  assert.equal(await sniffMediaKind(new Blob([png])), 'image');
  assert.equal(await sniffMediaKind(new Blob(['<svg><script>alert(1)</script></svg>'], { type: 'image/svg+xml' })), 'other');
  assert.equal(await sniffMediaKind(new Blob(['<!doctype html><script>alert(1)</script>'], { type: 'text/html' })), 'other');
  assert.equal(await sniffMediaKind(new Blob([Uint8Array.from([0x49, 0x44, 0x33, 4, 0, 0])])), 'audio');
  assert.equal(await sniffMediaKind(new Blob([Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3, 0, 0])])), 'video');
});

test('remote intake rechecks redirects, content type, size and media magic', async () => {
  const ok = await readMediaUrl('https://images.pexels.com/a', {
    name: 'hero.png',
    fetcher: async () => new Response(png, {
      status: 200,
      headers: { 'content-type': 'image/png', 'content-length': String(png.length) },
    }),
  });
  assert.equal(ok.name, 'hero.png');
  assert.equal(ok.kind, 'image');

  await assert.rejects(readMediaUrl('https://images.pexels.com/a.jpg', {
    fetcher: async () => Object.defineProperty(new Response(png, { headers: { 'content-type': 'image/png' } }), 'url', { value: 'https://evil.test/a.jpg' }),
  }), /not allowed/);
  await assert.rejects(readMediaUrl('https://images.pexels.com/a.jpg', {
    fetcher: async () => new Response('<html>no</html>', { headers: { 'content-type': 'text/html' } }),
  }), /not a supported/);
  await assert.rejects(readMediaUrl('https://images.pexels.com/a.jpg', {
    fetcher: async () => new Response(png, { headers: { 'content-type': 'image/png', 'content-length': String(MAX_ENCODED_MEDIA_BYTES + 1) } }),
  }), /exceeds/);
});
