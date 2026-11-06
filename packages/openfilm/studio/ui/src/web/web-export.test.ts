/** Web export state/guards around the real work: unsupported asks, single writer, cancel and wait receipts. */
import { test } from 'node:test';
import assert from 'node:assert';
import { cancelWebExport, listWebExports, startWebExport, waitForWebExport, webExportCapabilities, webExportSupports } from './web-export.ts';

const source = () => ({
  seek: async () => {},
  capture: async () => ({ __canvas: true }) as unknown as HTMLCanvasElement,
  size: () => ({ w: 320, h: 180 }),
  duration: () => 1,
});
const deps = { putFile: async () => {}, readFile: async () => null };

test('web export capability matrix is honest', () => {
  assert.equal(webExportSupports({ kind: 'video', codec: 'h264', fps: 30, quality: 'high', audio: false }), true);
  assert.equal(webExportSupports({ kind: 'video', codec: 'prores422hq', fps: 30, quality: 'high', audio: false }), true);
  assert.equal(webExportSupports({ kind: 'gif', width: 320, fps: 10 }), true);
  assert.equal(webExportSupports({ kind: 'audio', format: 'wav', mix: true, stems: false }), true);
  assert.equal(webExportCapabilities().mp3, false);
});

test('one project has one export writer; cancel settles the same receipt', async () => {
  const id = `guard-${Date.now()}`;
  let unblock!: () => void;
  const slow = { ...source(), seek: () => new Promise<void>((done) => { unblock = done; }) };
  const first = startWebExport(id, { kind: 'stills', as: 'files', format: 'png', shortEdge: 320, at: [0], name: 'first' }, slow, deps);
  await new Promise<void>((resolve) => {
    const wait = () => { if (unblock) resolve(); else setTimeout(wait, 0); };
    wait();
  });
  assert.throws(() => startWebExport(id, { kind: 'poster', format: 'png', shortEdge: 320, at: 0 }, source(), deps), (error: unknown) => (error as { code?: string }).code === 'E_EXPORT_BUSY');
  assert.equal(cancelWebExport(id, first.id), true);
  const settledPromise = waitForWebExport(id, first.id);
  unblock();
  const settled = await settledPromise;
  assert.equal(settled.status, 'cancelled', settled.error);
  assert.equal(listWebExports(id).length, 1);
});

test('simultaneous projects get distinct job and cancellation identities', async () => {
  let unblockA!: () => void;
  let unblockB!: () => void;
  const sourceA = { ...source(), seek: () => new Promise<void>((done) => { unblockA = done; }) };
  const sourceB = { ...source(), seek: () => new Promise<void>((done) => { unblockB = done; }) };
  const request = { kind: 'poster', format: 'png', shortEdge: 320, at: 0 } as const;
  const a = startWebExport('project-a', request, sourceA, deps);
  const b = startWebExport('project-b', request, sourceB, deps);
  assert.notEqual(a.id, b.id);
  while (!unblockA || !unblockB) await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(cancelWebExport('project-a', a.id), true);
  assert.equal(cancelWebExport('project-b', b.id), true);
  const settledA = waitForWebExport('project-a', a.id);
  const settledB = waitForWebExport('project-b', b.id);
  unblockA(); unblockB();
  assert.equal((await settledA).status, 'cancelled');
  assert.equal((await settledB).status, 'cancelled');
});


test('a waiter whose signal is already aborted cancels instead of hanging', async () => {
  const id = `abort-${Date.now()}`;
  let unblock!: () => void;
  const slow = { ...source(), seek: () => new Promise<void>((done) => { unblock = done; }) };
  const job = startWebExport(id, { kind: 'poster', format: 'png', shortEdge: 320, at: 0 }, slow, deps);
  while (!unblock) await new Promise((resolve) => setTimeout(resolve, 0));
  const controller = new AbortController();
  controller.abort(new DOMException('already stopped', 'AbortError'));
  await assert.rejects(waitForWebExport(id, job.id, controller.signal), /already stopped/);
  unblock();
  const terminal = await waitForWebExport(id, job.id);
  assert.equal(terminal.status, 'cancelled');
});
