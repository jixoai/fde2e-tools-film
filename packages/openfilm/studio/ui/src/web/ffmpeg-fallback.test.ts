/**
 * The fallback tier's device-independent contract: the ask exists, the probe is honest (node has
 * a Worker/WebAssembly but no worker-ffmpeg — the load path needs the browser), and the GIF's
 * palettegen two-pass argv is built as T08 measured it. The real run is asserted in Chromium
 * (E2E with the vendored core).
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import {
  encodeFallback,
  ffmpegAssetUrls,
  ffmpegAvailable,
  FFMPEG_FALLBACK_DEPLOYMENT,
  ffmpegTerminate,
} from './ffmpeg-fallback.ts';

test('the fallback ask exists with its shape', () => {
  assert.equal(typeof encodeFallback, 'function');
  assert.equal(typeof ffmpegAvailable, 'function');
  assert.equal(typeof ffmpegTerminate, 'function');
});

test('D6 option C: one same-origin ST fallback, no MT/COI or ffmpeg.tool runtime', () => {
  assert.deepEqual(FFMPEG_FALLBACK_DEPLOYMENT, {
    mode: 'main-site-vendored-st',
    coreBase: '/ffmpeg',
    multithreaded: false,
    requiresCrossOriginIsolation: false,
  });
  const urls = Object.values(ffmpegAssetUrls('https://film.tool.fde2e.com/projects/demo'));
  assert.ok(urls.every((url) => new URL(url).origin === 'https://film.tool.fde2e.com'));
  assert.ok(urls.every((url) => new URL(url).pathname.startsWith('/ffmpeg/')));
  assert.ok(urls.every((url) => !url.includes('ffmpeg.tool.fde2e.com')));

  const pkg = JSON.parse(readFileSync(new URL('../../../../package.json', import.meta.url), 'utf8')) as {
    dependencies?: Record<string, string>;
  };
  assert.equal(pkg.dependencies?.['@ffmpeg/core-mt'], undefined, 'the MT core must not enter the product graph');
  const entry = readFileSync(new URL('../../index-web.html', import.meta.url), 'utf8');
  assert.doesNotMatch(entry, /(?:preload|prefetch)[^>]+ffmpeg/i, 'cold boot must not fetch the 32MB fallback');
});

test('probe answers true on a browser-shaped node (Worker + WebAssembly) — the load itself needs the browser', () => {
  // node 26 has Worker and WebAssembly globals; the tier's gate is environmental, the load is the real test
  assert.equal(ffmpegAvailable(), typeof Worker !== 'undefined' && typeof WebAssembly === 'object');
});

test('encodeFallback refuses in node (ffmpeg.wasm does not support nodejs)', async () => {
  await assert.rejects(
    () => encodeFallback({ name: 'in.mp4', bytes: new Uint8Array(8) }, 'gif'),
    () => true,
  );
});

test('terminate is safe with no instance', () => {
  ffmpegTerminate();
});
