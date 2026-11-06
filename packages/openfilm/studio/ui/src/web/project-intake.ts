import { importFilmText, looksLikeFilmHtml } from './import.ts';
import { importPackage, unzipEntries, MAX_PACKAGE_BYTES, type PackageEntry } from './interchange.ts';
import { packageBase64 } from './webmcp-projects.ts';

/** Install once at boot: BU intake does not depend on whether the library popover is open. */
export function installProjectIntake(openProject: (id: string) => void): () => void {
  const pending = new Map<string, { promise: Promise<{ id: string; name: string }>; abort: AbortController; opened: boolean }>();
  const cancel = (event: Event) => pending.get((event as CustomEvent).detail?.requestId)?.abort.abort();
  const accept = (event: Event) => {
    const d = (event as CustomEvent).detail;
    if (!d || typeof d !== 'object') return;
    const count = ['html', 'zipBase64', 'entries'].filter((key) => d[key] !== undefined).length;
    if (count !== 1) return;
    // This flag proves a listener accepted the event; the asynchronous receipt proves persistence.
    event.preventDefault();
    const requestId = typeof d.requestId === 'string' ? d.requestId : crypto.randomUUID();
    if (requestId.length > 128 || pending.size >= 64) return;
    let task = pending.get(requestId);
    if (!task) {
      const abort = new AbortController();
      const promise = (async () => {
        if (typeof d.html === 'string') {
          if (d.html.length > 4 * 1024 * 1024 || !looksLikeFilmHtml(d.html)) throw new Error('invalid film HTML');
          return importFilmText(d.html, typeof d.name === 'string' ? d.name : undefined, { signal: abort.signal });
        }
        const entries = d.zipBase64 !== undefined ? await unzipEntries(packageBase64(d.zipBase64, MAX_PACKAGE_BYTES)) : d.entries as PackageEntry[];
        return importPackage(entries, typeof d.name === 'string' ? d.name : undefined, { signal: abort.signal });
      })();
      task = { promise, abort, opened: false }; pending.set(requestId, task);
      setTimeout(() => pending.delete(requestId), 60_000);
    }
    const entry = task;
    void entry.promise.then((project) => {
      if (!entry.opened) { entry.opened = true; openProject(project.id); }
      window.dispatchEvent(new CustomEvent('fde2e-film-inject-result', { detail: { requestId, ok: true, project } }));
    }).catch((error) => {
      window.dispatchEvent(new CustomEvent('fde2e-film-inject-result', { detail: { requestId, ok: false, error: error instanceof Error ? error.message : String(error) } }));
    });
  };
  window.addEventListener('fde2e-film-inject', accept);
  window.addEventListener('fde2e-film-inject-cancel', cancel);
  return () => {
    window.removeEventListener('fde2e-film-inject', accept);
    window.removeEventListener('fde2e-film-inject-cancel', cancel);
    for (const task of pending.values()) task.abort.abort(); pending.clear();
  };
}
