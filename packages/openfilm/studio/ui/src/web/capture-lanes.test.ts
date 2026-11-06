/**
 * The lane registry's contract: three lanes registered, capability probing without identity
 * enumeration, and the clip×lane matrix exactly as D5's table draws it.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { availableLanes, canCapture, captureLanes, laneFor, laneSupports } from './capture-lanes.ts';

test('three lanes registered, in preference order', () => {
  assert.deepEqual(captureLanes().map((l) => l.id), ['plugin-cdp', 'in-page', 'html-in-canvas']);
});

test('bare page: only the in-page lane is available (probe without a bridge)', () => {
  assert.deepEqual(availableLanes().map((l) => l.id), ['in-page']);
});

test('the matrix as D5 draws it, per lane', () => {
  // plugin-cdp: everything visual, byte-reproducible
  assert.equal(laneSupports('plugin-cdp', 'page'), true);
  assert.equal(laneSupports('plugin-cdp', 'still'), true);
  assert.equal(laneSupports('plugin-cdp', 'video'), true);
  // sound has no pixels
  assert.equal(laneSupports('plugin-cdp', 'sound'), false);
  // in-page: four-class convergence — a page sandbox cannot read an iframe's pixels
  assert.equal(laneSupports('in-page', 'page'), false);
  assert.equal(laneSupports('in-page', 'still'), true);
  assert.equal(laneSupports('in-page', 'video'), true);
  // html-in-canvas: future, same-origin pages included
  assert.equal(laneSupports('html-in-canvas', 'page'), true);
  assert.equal(laneSupports('no-such-lane' as never, 'page'), false);
});

test('canCapture gates the type on available lanes (page clip: bridge only)', () => {
  assert.equal(canCapture('still'), true);
  assert.equal(canCapture('video'), true);
  assert.equal(canCapture('page'), false); // no bridge on a bare page
});

test('laneFor picks the first available lane that supports the kind', () => {
  assert.equal(laneFor('page'), null);
  assert.equal(laneFor('still')?.id, 'in-page');
});

test('a legacy page-global placeholder cannot claim a working CDP lane', () => {
  (globalThis as { window?: Record<string, unknown> }).window = {
    fde2eFilmBridge: { captureScreenshot: () => {} },
  } as Record<string, unknown>;
  try {
    assert.deepEqual(availableLanes().map((l) => l.id), ['in-page']);
    assert.equal(canCapture('page'), false);
    assert.equal(laneFor('page'), null);
  } finally {
    delete (globalThis as { window?: unknown }).window;
  }
});

test('runScreencast: bringToFront before start, frames decoded, stop idempotent', async () => {
  const { runScreencast } = await import('./capture-lanes.ts');
  const order: string[] = [];
  let sink: ((frame: { data: string }) => void) | null = null;
  let stops = 0;
  const screencast = {
    bringToFront: async () => { order.push('front'); },
    startScreencast: async (_opts: object, onFrame: (frame: { data: string }) => void) => { order.push('start'); sink = onFrame; },
    stopScreencast: async () => { order.push('stop'); stops += 1; },
  };
  const frames: number[] = [];
  const session = await runScreencast(screencast, (f) => frames.push(f.bytes.length));
  sink?.({ data: btoa('AB') }); // two bytes
  sink?.({ data: btoa('C') });
  await session.stop();
  await session.stop();
  sink?.({ data: btoa('never') }); // after stop: not news
  assert.deepEqual(order, ['front', 'start', 'stop'], 'front before start; the second stop is absorbed');
  assert.equal(stops, 1, 'stopScreencast called once (session-level idempotence)');
  assert.deepEqual(frames, [2, 1], 'frames decoded in order, none after stop');
});
