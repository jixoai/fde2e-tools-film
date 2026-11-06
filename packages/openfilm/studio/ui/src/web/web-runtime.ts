/**
 * Live runtime registry for the pure-Web face.
 *
 * WebMCP registers before React has mounted a project, while capture/export need ProjectView's
 * currently shown preview. This module is the one narrow bridge between them: ProjectView owns
 * the source and registers it while mounted; produce tools only borrow it by project id. It is
 * capability injection, not a second editor state machine.
 */
import type { PreviewPixelSource } from './web-export.ts';

export interface WebProjectRuntime {
  projectId: string;
  source: PreviewPixelSource;
  duration: () => number;
  fps: () => number;
}

const runtimes = new Map<string, WebProjectRuntime>();
const waiters = new Map<string, Set<(runtime: WebProjectRuntime) => void>>();

export function registerWebProjectRuntime(runtime: WebProjectRuntime): () => void {
  runtimes.set(runtime.projectId, runtime);
  const waiting = waiters.get(runtime.projectId);
  if (waiting) {
    waiters.delete(runtime.projectId);
    for (const resolve of waiting) resolve(runtime);
  }
  return () => {
    if (runtimes.get(runtime.projectId) === runtime) runtimes.delete(runtime.projectId);
  };
}

export const webProjectRuntime = (projectId: string): WebProjectRuntime | null => runtimes.get(projectId) ?? null;

/** Project navigation and React mounting are asynchronous, while a WebMCP caller can issue the
 *  next command immediately after projects_open/load_example. Hold produce briefly at this seam
 *  instead of turning normal UI scheduling into a flaky "preview is not ready" business error. */
export function waitForWebProjectRuntime(
  projectId: string,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<WebProjectRuntime> {
  const current = webProjectRuntime(projectId);
  if (current && current.source.ready?.() !== false && !options.signal?.aborted) return Promise.resolve(current);
  const timeoutMs = options.timeoutMs ?? 20_000;
  return new Promise<WebProjectRuntime>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    let pulse: ReturnType<typeof setInterval>;
    const waiting = waiters.get(projectId) ?? new Set<(runtime: WebProjectRuntime) => void>();
    waiters.set(projectId, waiting);
    const cleanup = () => {
      clearTimeout(timer);
      clearInterval(pulse);
      options.signal?.removeEventListener('abort', onAbort);
      waiting.delete(onRuntime);
      if (waiting.size === 0 && waiters.get(projectId) === waiting) waiters.delete(projectId);
    };
    const finish = (runtime: WebProjectRuntime) => {
      if (settled || runtime.source.ready?.() === false) return;
      settled = true;
      cleanup();
      resolve(runtime);
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onRuntime = (runtime: WebProjectRuntime) => finish(runtime);
    const onAbort = () => fail(options.signal?.reason ?? new DOMException('aborted', 'AbortError'));
    waiting.add(onRuntime);
    timer = setTimeout(() => fail(new Error(`the open project preview did not become ready within ${timeoutMs / 1000}s`)), timeoutMs);
    pulse = setInterval(() => { const value = webProjectRuntime(projectId); if (value) finish(value); }, 25);
    if (options.signal?.aborted) { onAbort(); return; }
    options.signal?.addEventListener('abort', onAbort, { once: true });
    const raced = webProjectRuntime(projectId);
    if (raced) finish(raced);
  });
}
