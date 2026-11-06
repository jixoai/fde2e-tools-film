/** Single-use, origin-bound project transfer over MessageChannel. No cookies or server required. */
import { buildPackage, importPackage, type PackageEntry } from './interchange.ts';
export const PACKAGE_PROTOCOL = 'fde2e-film-package/1';
const grants = new Map<string, { origin: string; mode: 'import' | 'export'; projectId?: string; expires: number }>();
export function authorizePackageChannel(origin: string, mode: 'import' | 'export', projectId?: string) {
  const peer = new URL(origin);
  if (peer.origin !== origin || peer.username || peer.password || (peer.protocol !== 'https:' && peer.origin !== location.origin)) throw new Error('peer must be an exact secure origin');
  if (mode === 'export' && !projectId) throw new Error('export needs a project');
  if (mode !== 'import' && mode !== 'export') throw new Error('invalid transfer mode');
  for (const [key, grant] of grants) if (grant.expires < Date.now()) grants.delete(key);
  if (grants.size >= 32) throw new Error('too many pending transfers');
  const token = crypto.randomUUID(); const expires = Date.now() + 60_000;
  grants.set(token, { origin, mode, projectId, expires });
  return { protocol: PACKAGE_PROTOCOL, token, expires, mode, origin };
}
export function installPackageChannel(openProject: (id: string) => void): () => void {
  const active = new Set<() => void>();
  const connect = (event: MessageEvent) => {
    if (event.data?.protocol !== PACKAGE_PROTOCOL || event.data?.type !== 'connect' || event.ports.length !== 1 || !event.source) return;
    const grant = grants.get(event.data.token);
    if (!grant || grant.expires < Date.now() || grant.origin !== event.origin) return;
    grants.delete(event.data.token);
    const port = event.ports[0]; const abort = new AbortController(); let running = false;
    const close = () => { abort.abort(); clearTimeout(timeout); port.close(); active.delete(close); };
    const timeout = setTimeout(close, 60_000); active.add(close);
    port.onmessage = async (message) => {
      if (message.data?.type === 'cancel') { close(); return; }
      if (running) return;
      running = true;
      try {
        if (message.data?.type !== grant.mode) throw new Error('transfer operation is not authorized');
        if (grant.mode === 'import') {
          const entries = message.data.entries as PackageEntry[];
          const project = await importPackage(entries, undefined, { signal: abort.signal });
          openProject(project.id);
          port.postMessage({ ok: true, project });
        } else {
          const pack = await buildPackage(grant.projectId!); abort.signal.throwIfAborted();
          port.postMessage({ ok: true, ...pack }, pack.entries.map((e) => e.bytes));
        }
      } catch (error) { if (!abort.signal.aborted) port.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) }); }
      finally { close(); }
    };
    port.onmessageerror = close; port.start(); port.postMessage({ protocol: PACKAGE_PROTOCOL, ready: true, mode: grant.mode });
  };
  window.addEventListener('message', connect);
  return () => { window.removeEventListener('message', connect); for (const close of [...active]) close(); grants.clear(); };
}
