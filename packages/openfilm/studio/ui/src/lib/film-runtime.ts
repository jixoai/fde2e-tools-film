/**
 * The editor's live handles, registered by ProjectView when a project is mounted: the WebMCP tool
 * surface waits on the same write queue the person's edits go through (T02's 同源铁律 — one state
 * machine, one door). A version op that skips this could snapshot (or check out under) a film
 * the person is still editing; `settled` is what the Version history panel itself awaits.
 */
type Runtime = { projectId: string; settled: () => Promise<unknown> };

let current: Runtime | null = null;

/** ProjectView registers on mount (and clears on leave); the newest mounted project wins. */
export function registerFilmRuntime(runtime: Runtime | null): void {
  current = runtime;
}

/** Waits for this project's pending writes to land; at once when the page has moved on. */
export function settledFor(projectId: string): Promise<unknown> {
  return current && current.projectId === projectId ? current.settled() : Promise.resolve();
}
