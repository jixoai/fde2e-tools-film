const pending = new Map<string, Promise<unknown>>();

/** A single project writer across tabs; the queue also works in runtimes without Web Locks. */
export async function withProjectLock<T>(id: string, body: () => Promise<T>): Promise<T> {
  if (!id || id.includes('/') || id.includes('\\') || id === '.' || id === '..') throw new Error('invalid project id');
  if (typeof navigator !== 'undefined' && navigator.locks?.request) {
    return navigator.locks.request(`fde2e.film.project.${id}`, { mode: 'exclusive' }, body);
  }
  const previous = pending.get(id) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(body);
  pending.set(id, next);
  try { return await next; } finally { if (pending.get(id) === next) pending.delete(id); }
}
