import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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

test('base64 accepts raw or data URL bytes', () => {
  const raw = decodeMediaBase64(png64, 'image/png');
  assert.equal(raw.blob.size, png.length);
  assert.equal(raw.mime, 'image/png');
  const data = decodeMediaBase64(`data:image/png;base64,${png64}`);
  assert.equal(data.blob.size, png.length);
  assert.equal(data.mime, 'image/png');
});

test('base64 preserves quartet, padding, whitespace and MIME compatibility', async () => {
  for (const [encoded, expected] of [
    ['TWFu', [77, 97, 110]], ['TWE=', [77, 97]], ['TQ==', [77]],
    ['+/8=', [251, 255]], ['/w==', [255]],
    // The existing intake accepts nonzero unused pad bits, as does atob.
    ['TR==', [77]], ['TWF=', [77, 97]],
    [' \nT\tQ\r=\u00a0= ', [77]],
  ] as const) {
    const decoded = decodeMediaBase64(encoded);
    assert.deepEqual(new Uint8Array(await decoded.blob.arrayBuffer()), Uint8Array.from(expected));
  }
  const data = decodeMediaBase64(' \nDaTa:AuDiO/WaV;BaSe64,T Q = = \n', 'image/png');
  assert.equal(data.mime, 'audio/wav');
  assert.equal(data.blob.type, 'audio/wav');
  assert.equal(await data.blob.text(), 'M');
  assert.equal(decodeMediaBase64('data:;base64,TQ==', ' AUDIO/WAV;codec=pcm ').mime, 'audio/wav');
});

test('base64 rejects invalid length, alphabet and misplaced padding before decoding', (t) => {
  const decoder = t.mock.method(globalThis, 'atob');
  for (const encoded of [
    '', ' \n\t', 'A', 'AA', 'AAA', 'AAAAA', 'AA=', 'A===', '====', 'AAA===',
    'AA=A', 'TQ==AAAA', 'TWE=AAAA', 'TWFu=', 'TWFu====',
    'T-Q=', 'T_Q=', 'T\0==', 'TÀ==', 'TQ\u200b=', 'not base64!',
    'data:audio/wav;base64,', 'data:audio/wav;charset=utf-8;base64,TQ==',
  ]) {
    assert.throws(() => decodeMediaBase64(encoded), { name: 'MediaIntakeError', code: 'invalid-base64' }, encoded);
  }
  // Force validation to reach the end of a multi-MB payload, including a padding violation.
  for (const tail of ['AAA!', 'AA=A']) {
    assert.throws(() => decodeMediaBase64('A'.repeat(16 * 1024 * 1024) + tail), { code: 'invalid-base64' });
  }
  assert.equal(decoder.mock.callCount(), 0);
});

test('base64 decodes a 60-second stereo WAV without exhausting the regexp stack', async () => {
  // Same byte count as the 11,520,044-byte background track that failed WebMCP import.
  const wav = Buffer.alloc(44 + 48_000 * 2 * 2 * 60);
  wav.fill(Buffer.from([0x00, 0x00, 0xff, 0x7f, 0x00, 0x80, 0xff, 0xff]), 44);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(2, 22);
  wav.writeUInt32LE(48_000, 24);
  wav.writeUInt32LE(48_000 * 4, 28);
  wav.writeUInt16LE(4, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(wav.length - 44, 40);
  const decoded = decodeMediaBase64(`data:audio/wav;base64,${wav.toString('base64')}`);
  assert.equal(decoded.blob.size, wav.length);
  assert.equal(decoded.mime, 'audio/wav');
  assert.equal(await sniffMediaKind(decoded.blob), 'audio');
  assert.ok(Buffer.from(await decoded.blob.arrayBuffer()).equals(wav));
});

test('base64 accepts all padding forms near and at the 64 MiB decoded limit', async () => {
  const bytes = Buffer.alloc(MAX_ENCODED_MEDIA_BYTES, 0xa5);
  bytes[0] = 0x01;
  bytes.set([0x02, 0x03, 0x04], bytes.length - 3);
  // These lengths end in one, zero and two padding characters respectively.
  for (const size of [MAX_ENCODED_MEDIA_BYTES - 2, MAX_ENCODED_MEDIA_BYTES - 1, MAX_ENCODED_MEDIA_BYTES]) {
    const expected = bytes.subarray(0, size);
    const decoded = decodeMediaBase64(expected.toString('base64'));
    assert.equal(decoded.blob.size, size);
    const hash = createHash('sha256');
    for await (const chunk of decoded.blob.stream()) hash.update(chunk);
    assert.equal(hash.digest('hex'), createHash('sha256').update(expected).digest('hex'));
  }
});

test('base64 rejects decoded oversize and excessive encoded length before decoding', (t) => {
  const decoder = t.mock.method(globalThis, 'atob');
  // One byte over has the same encoded length as the accepted maximum, but less padding.
  const oneOver = 'A'.repeat(Math.floor((MAX_ENCODED_MEDIA_BYTES + 1) / 3) * 4) + 'AAA=';
  assert.throws(() => decodeMediaBase64(oneOver), { name: 'MediaIntakeError', code: 'too-large' });
  assert.throws(() => decodeMediaBase64('A'.repeat(Math.ceil(MAX_ENCODED_MEDIA_BYTES / 3) * 4 + 8)), {
    name: 'MediaIntakeError', code: 'invalid-base64', message: 'media base64 is invalid or too large',
  });
  assert.equal(decoder.mock.callCount(), 0);
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
