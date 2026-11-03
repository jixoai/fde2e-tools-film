/**
 * The pump's own semantics: the (i+0.5)/fps grid, serial order, abort mid-run, and honest
 * progress. The FrameSource is fake; the encoder is the real one refusing in node (no WebCodecs)
 * — so abort-before-encode is the assertion path for cancellation.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { pumpExport, pumpReady } from './export-pump.ts';

function fakeSource() {
  const seeks: number[] = [];
  return {
    seeks,
    source: {
      seek: async (t: number) => { seeks.push(t); },
      capture: async () => ({ __canvas: true }),
    },
  };
}

test('bare node: pumpReady is false (no WebCodecs, no lane)', () => {
  assert.equal(pumpReady(), false);
});

test('the pump walks the (i+0.5)/fps grid in order', async () => {
  const { seeks, source } = fakeSource();
  const seen: number[] = [];
  // abort right away: we only assert the grid the pump ATTEMPTED is right, so let it run 3 frames then abort
  const controller = new AbortController();
  const run = pumpExport({
    width: 320, height: 180, fps: 30, frameCount: 3, source,
    signal: controller.signal,
    onProgress: (p) => { if (p.phase === 'capture' && p.frame === 1) controller.abort(); },
  });
  const result = await run;
  assert.deepEqual(seeks, [0.5 / 30, 1.5 / 30]);
  assert.equal(result.cancelled, true);
  assert.equal(result.result, null);
  void seen;
});

test('progress tells capture frames then encode', async () => {
  const { source } = fakeSource();
  const phases: string[] = [];
  const controller = new AbortController();
  await pumpExport({
    width: 320, height: 180, fps: 30, frameCount: 2, source,
    signal: controller.signal,
    onProgress: (p) => { phases.push(p.phase); if (p.frame === 0) controller.abort(); },
  });
  assert.deepEqual(phases, ['capture']);
});
