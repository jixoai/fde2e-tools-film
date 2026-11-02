/**
 * The web backend's switch: is this the pure-web editor (OPFS store), or Studio on its server?
 *
 * One flag decides it — `window.filmWeb` set by the web entry before any component runs — because
 * "which file face am I on" is a build/entry concern, not something to probe at every call. The
 * server face keeps every answer it ever gave; the web face answers the same asks out of OPFS
 * (src/web/opfs) and hides what a static site cannot have (providers, update checks, the doctor).
 *
 * The guard `web()` throws a plain Error (not ApiError): a web call that has no OPFS answer is a
 * wiring bug, and the console should say so loudly.
 */
import type { StoreProject } from './opfs';

declare global {
  interface Window {
    /** set by the web entry (main-web.tsx) before modules run: the OPFS store is the file face */
    filmWeb?: boolean;
  }
}

export const isWeb = (): boolean => Boolean(window.filmWeb);

/** Inside an `if (isWeb())` branch, after the check. */
export function web(): true {
  if (!window.filmWeb) throw new Error('web store asked on the server face — wiring bug');
  return true;
}

/** The store's project shape read as the api's `Project` (path is the store id: nothing outside
    OPFS can hold it, and nothing web reads path as a real folder). */
export function asProject(p: StoreProject) {
  return { ...p, path: p.id };
}
