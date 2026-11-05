/** Project navigation may finish before React registers the live preview runtime. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerWebProjectRuntime, waitForWebProjectRuntime, type WebProjectRuntime } from './web-runtime.ts';

const runtime = (projectId: string): WebProjectRuntime => ({
  projectId,
  source: {
    seek: async () => {},
    capture: async () => ({}) as HTMLCanvasElement,
    size: () => ({ w: 320, h: 180 }),
    duration: () => 1,
  },
  duration: () => 1,
  fps: () => 30,
});

test('a produce caller waiting across project mount receives the registered runtime', async () => {
  const pending = waitForWebProjectRuntime('late-project', { timeoutMs: 1_000 });
  const mounted = runtime('late-project');
  const stop = registerWebProjectRuntime(mounted);
  assert.equal(await pending, mounted);
  stop();
});

test('runtime waiting is abortable and times out with an actionable error', async () => {
  const controller = new AbortController();
  const aborted = waitForWebProjectRuntime('aborted-project', { signal: controller.signal, timeoutMs: 1_000 });
  controller.abort(new DOMException('test stop', 'AbortError'));
  await assert.rejects(aborted, /test stop/);
  await assert.rejects(waitForWebProjectRuntime('missing-project', { timeoutMs: 5 }), /did not become ready within/);
});
