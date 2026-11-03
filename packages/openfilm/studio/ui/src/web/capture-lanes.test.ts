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

test('with the bridge flagged in, the cdp lane answers and page clips open', () => {
  (globalThis as { window?: Record<string, unknown> }).window = {
    fde2eFilmBridge: { captureScreenshot: () => {} },
  } as Record<string, unknown>;
  try {
    assert.deepEqual(availableLanes().map((l) => l.id), ['plugin-cdp', 'in-page']);
    assert.equal(canCapture('page'), true);
    assert.equal(laneFor('page')?.id, 'plugin-cdp');
  } finally {
    delete (globalThis as { window?: unknown }).window;
  }
});
