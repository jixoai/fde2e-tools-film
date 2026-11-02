/**
 * Project ids and names. An id is a short random token (the folder's name in OPFS, never shown);
 * a name is what the person sees, and what `Untitled` starts as. Mirrors the server's
 * projects.mjs naming rules: names are cleaned for the file system, ids never reused.
 */
const TOKEN = () => crypto.randomUUID().slice(0, 8);

export const newId = (): string => `p-${Date.now().toString(36)}-${TOKEN()}`;

/** A file-system-safe folder name from a project name (informational; ids are the real keys). */
export function cleanName(name: string): string {
  const cleaned = name.trim().replace(/[/\\:*?"<>|]/g, ' ').replace(/\s+/g, ' ');
  return cleaned || 'Untitled';
}

/** The next free `Untitled`/`Untitled 2`/… among `taken`. */
export function untitled(taken: Set<string>): string {
  if (!taken.has('Untitled')) return 'Untitled';
  for (let n = 2; ; n++) if (!taken.has(`Untitled ${n}`)) return `Untitled ${n}`;
}
