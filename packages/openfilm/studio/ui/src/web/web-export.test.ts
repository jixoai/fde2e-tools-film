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

test('closing a cancelled render during capture preserves cancellation and releases the writer', async () => {
  const id = `capture-abort-${Date.now()}`;
  let captureStarted!: () => void;
  const started = new Promise<void>((resolve) => { captureStarted = resolve; });
  let closed = 0;
  const isolated = {
    ...source(),
    open: async (signal: AbortSignal) => ({
      source: { ...source(), capture: () => new Promise<HTMLCanvasElement>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('Frame with ID 0 was removed.')), { once: true });
        captureStarted();
      }) },
      close: () => { closed += 1; },
    }),
  };
  const request = { kind: 'poster', format: 'png', shortEdge: 320, at: 0 } as const;
  const job = startWebExport(id, request, isolated, deps);
  await started;
  cancelWebExport(id, job.id);
  const terminal = await waitForWebExport(id, job.id);
  assert.equal(terminal.status, 'cancelled');
  assert.equal(terminal.error, undefined);
  assert.equal(closed, 1);
  // An identical renderer error without cancellation must still be a failure.
  const retry = startWebExport(id, request, { ...source(), capture: async () => { throw new Error('Frame with ID 0 was removed.'); } }, deps);
  const failed = await waitForWebExport(id, retry.id);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error, 'Frame with ID 0 was removed.');
});

test('cancel completion hands the writer to the queued job before an immediate retry', async () => {
  const id = `queued-abort-${Date.now()}`;
  const entered: string[] = [];
  const release = new Map<string, () => void>();
  const slow = (name: string) => ({ ...source(), seek: () => new Promise<void>((resolve) => {
    entered.push(name); release.set(name, resolve);
  }) });
  const request = { kind: 'poster', format: 'png', shortEdge: 320, at: 0 } as const;
  const a = startWebExport(id, request, slow('A'), deps);
  const b = startWebExport(id, request, slow('B'), deps, true);
  cancelWebExport(id, a.id); release.get('A')!();
  assert.equal((await waitForWebExport(id, a.id)).status, 'cancelled');
  assert.throws(() => startWebExport(id, request, slow('C'), deps), (e: unknown) => (e as {code: string}).code === 'E_EXPORT_BUSY');
  assert.deepEqual(entered, ['A', 'B']);
  assert.equal(listWebExports(id).filter(j => j.status === 'running').length, 1);
  cancelWebExport(id, b.id); release.get('B')!();
  assert.equal((await waitForWebExport(id, b.id)).status, 'cancelled');
  const c = startWebExport(id, request, slow('C'), deps);
  cancelWebExport(id, c.id); release.get('C')!();
  assert.equal((await waitForWebExport(id, c.id)).status, 'cancelled');
});
