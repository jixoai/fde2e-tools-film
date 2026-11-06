import { currentProjectId, jsonSchema, say, type WebMCPToolDef } from './webmcp-kit.ts';
const failure = (error: unknown) => say({ error: error instanceof Error ? error.message : String(error) });
export function packageBase64(raw: unknown, max: number): ArrayBuffer {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > Math.ceil(max / 3) * 4 || raw.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(raw)) throw new Error('invalid or oversized base64');
  const binary = atob(raw); if (binary.length > max) throw new Error('payload is too large');
  return Uint8Array.from(binary, (c) => c.charCodeAt(0)).buffer;
}
export function projectExtraTools(openProject: (id: string) => void): WebMCPToolDef[] {
  return [
    {
      name: 'projects_import_package', title: 'Import a project package',
      description: 'Verify a complete interchange ZIP and create an independent editable project, including pages, fonts, scripts and media. A rejected or cancelled package creates no visible project.',
      inputSchema: jsonSchema({ zipBase64: { type: 'string' }, name: { type: 'string' }, open: { type: 'boolean', description: 'Open the imported project (default true)' } }, ['zipBase64']),
      annotations: { readOnlyHint: false, untrustedContentHint: true },
      execute: async ({ zipBase64, name, open }, { signal }) => {
        try {
          const { MAX_PACKAGE_BYTES, unzipEntries, importPackage } = await import('./interchange.ts');
          const entries = await unzipEntries(packageBase64(zipBase64, MAX_PACKAGE_BYTES));
          const project = await importPackage(entries, typeof name === 'string' ? name : undefined, { signal });
          if (open !== false) openProject(project.id);
          return say({ ok: true, ...project });
        } catch (error) { return failure(error); }
      },
    },
    {
      name: 'projects_rename', title: 'Rename a project',
      description: 'Rename an existing project through the same API as its library card. Its identity and files are preserved; the human sees the updated name.',
      inputSchema: jsonSchema({ id: { type: 'string' }, name: { type: 'string' } }, ['id', 'name']),
      annotations: { readOnlyHint: false },
      execute: async ({ id, name }) => {
        try {
          if (typeof id !== 'string' || typeof name !== 'string' || !name.trim()) throw new Error('id and a non-empty name are required');
          const { api } = await import('../api'); const project = await api.rename(id, name);
          return say({ ok: true, project });
        } catch (error) { return failure(error); }
      },
    },
    {
      name: 'projects_read_file', title: 'Read or download a project file',
      description: 'Read a bounded byte range of an existing project file, or trigger its real browser download for the caller to transfer to its media library. Returns the same-origin OPFS URL, size and selected base64 bytes.',
      inputSchema: jsonSchema({ projectId: { type: 'string' }, path: { type: 'string' }, offset: { type: 'integer', minimum: 0 }, length: { type: 'integer', minimum: 0, maximum: 1048576 }, download: { type: 'boolean' } }, ['path']),
      annotations: { readOnlyHint: true },
      execute: async ({ projectId, path, offset = 0, length = 0, download }) => {
        try {
          const id = typeof projectId === 'string' ? projectId : currentProjectId();
          if (!id || typeof path !== 'string') throw new Error('project and path are required');
          if (!Number.isSafeInteger(offset) || Number(offset) < 0 || !Number.isSafeInteger(length) || Number(length) < 0 || Number(length) > 1048576) throw new Error('invalid byte range');
          const { safeProjectPath } = await import('./opfs/store.ts'); if (!safeProjectPath(path)) throw new Error('invalid project file path');
          const url = `/wf/${encodeURIComponent(id)}/${path.split('/').map(encodeURIComponent).join('/')}?film-host=0`;
          const response = await fetch(url, { method: 'HEAD' }); if (!response.ok) throw new Error('file not found');
          const size = Number(response.headers.get('content-length')); const mime = response.headers.get('content-type');
          let dataBase64: string | undefined;
          if (Number(length) > 0) {
            if (Number(offset) >= size) throw new Error('offset is outside the file');
            const bytes = new Uint8Array(await (await fetch(url, { headers: { Range: `bytes=${offset}-${Math.min(size, Number(offset) + Number(length)) - 1}` } })).arrayBuffer());
            let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte); dataBase64 = btoa(binary);
          }
          if (download === true) {
            const data = await fetch(url); if (!data.ok) throw new Error('file download failed');
            const blobUrl = URL.createObjectURL(await data.blob()); const a = document.createElement('a');
            a.href = blobUrl; a.download = path.split('/').at(-1)!; a.hidden = true;
            document.body.append(a); a.click(); a.remove();
            setTimeout(() => URL.revokeObjectURL(blobUrl), 30_000);
          }
          return say({ ok: true, projectId: id, path, url: new URL(url, location.origin).href, size, mime, ...(dataBase64 !== undefined ? { offset, dataBase64 } : {}) });
        } catch (error) { return failure(error); }
      },
    },
    {
      name: 'projects_package_channel', title: 'Authorize a project transfer',
      description: 'Create a single-use, 60-second, exact-origin grant for a MessageChannel project import or export. Give the token to the intended peer only; arbitrary pages cannot read or replace projects.',
      inputSchema: jsonSchema({ origin: { type: 'string' }, mode: { type: 'string', enum: ['import', 'export'] }, projectId: { type: 'string' } }, ['origin', 'mode']),
      annotations: { readOnlyHint: false, consequentialHint: true },
      execute: async ({ origin, mode, projectId }) => {
        try {
          if (typeof origin !== 'string' || (mode !== 'import' && mode !== 'export')) throw new Error('origin and mode are required');
          const { authorizePackageChannel } = await import('./package-channel.ts');
          return say({ ok: true, ...authorizePackageChannel(origin, mode, typeof projectId === 'string' ? projectId : currentProjectId() ?? undefined) });
        } catch (error) { return failure(error); }
      },
    },
  ];
}
