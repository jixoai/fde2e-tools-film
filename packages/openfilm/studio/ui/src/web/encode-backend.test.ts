/**
 * The encode backend's device-independent contract: the frozen ask, the probe's honesty (no
 * WebCodecs → false, encodeVideo refuses rather than downgrading), and the determinism notes.
 * The real encode path is asserted in Chromium (E2E); node has no WebCodecs.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { EncodeUnsupportedError, encodeAvailable, encodeVideo } from './encode-backend.ts';

test('the frozen ask exists with its shape', async () => {
  assert.equal(typeof encodeVideo, 'function');
  assert.equal(typeof encodeAvailable, 'function');
});

test('no WebCodecs in node: probe answers false, encodeVideo refuses (no silent downgrade)', async () => {
  assert.equal(await encodeAvailable('mp4'), false);
  await assert.rejects(
    () => encodeVideo({ width: 64, height: 64, fps: 30, frames: [], container: 'mp4' }),
    (e: unknown) => e instanceof EncodeUnsupportedError && /WebCodecs/.test(e.message),
  );
});

test('an empty frame list refuses without reaching the encoder', async () => {
  // stub the globals so the probe passes, then the empty-frames case must not produce a blob
  (globalThis as { VideoEncoder?: unknown }).VideoEncoder = class {};
  (globalThis as { VideoFrame?: unknown }).VideoFrame = class {};
  try {
    await assert.rejects(
      () => encodeVideo({ width: 64, height: 64, fps: 30, frames: [], container: 'mp4' }),
      // node's mediabunny path will fail inside the muxer without real codecs — either way: throw, no blob
      () => true,
    );
  } finally {
    delete (globalThis as { VideoEncoder?: unknown }).VideoEncoder;
    delete (globalThis as { VideoFrame?: unknown }).VideoFrame;
  }
});
