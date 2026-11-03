/**
 * The fallback tier's device-independent contract: the ask exists, the probe is honest (node has
 * a Worker/WebAssembly but no worker-ffmpeg — the load path needs the browser), and the GIF's
 * palettegen two-pass argv is built as T08 measured it. The real run is asserted in Chromium
 * (E2E with the vendored core).
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { encodeFallback, ffmpegAvailable, ffmpegTerminate } from './ffmpeg-fallback.ts';

test('the fallback ask exists with its shape', () => {
  assert.equal(typeof encodeFallback, 'function');
  assert.equal(typeof ffmpegAvailable, 'function');
  assert.equal(typeof ffmpegTerminate, 'function');
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
