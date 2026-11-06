import { children } from './fs.ts';

/** Identity/history are not project source. Outputs travel in packages but are not snapshots. */
export const internalRoot = (name: string): boolean => name === '.film' || name === 'versions';
export const sourceState = new Set(['markers.json', 'subtitle-style.json', 'settings.json']);
export interface ProjectFile { path: string; handle: FileSystemFileHandle }

export async function projectFiles(dir: FileSystemDirectoryHandle, options: { outputs?: boolean } = {}): Promise<ProjectFile[]> {
  const out: ProjectFile[] = [];
  const visit = async (at: FileSystemDirectoryHandle, prefix: string) => {
    const { files, folders } = await children(at);
    for (const name of files.sort()) {
      if ((!prefix && internalRoot(name)) || (prefix === '.film/' && !sourceState.has(name))) continue;
      out.push({ path: prefix + name, handle: await at.getFileHandle(name) });
    }
    for (const name of folders.sort()) {
      if (prefix === '.film/' || (!prefix && (name === 'versions' || (!options.outputs && name === 'downloads')))) continue;
      await visit(await at.getDirectoryHandle(name), `${prefix}${name}/`);
    }
  };
  await visit(dir, '');
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/** Bounded comparison: a large media file never needs two whole copies in JS memory. */
export async function sameFile(a: FileSystemFileHandle, b: FileSystemFileHandle): Promise<boolean> {
  const [left, right] = await Promise.all([a.getFile(), b.getFile()]);
  if (left.size !== right.size) return false;
  for (let offset = 0; offset < left.size; offset += 65536) {
    const [x, y] = await Promise.all([left.slice(offset, offset + 65536).arrayBuffer(), right.slice(offset, offset + 65536).arrayBuffer()]);
    const aa = new Uint8Array(x); const bb = new Uint8Array(y);
    if (aa.some((value, index) => value !== bb[index])) return false;
  }
  return true;
}
