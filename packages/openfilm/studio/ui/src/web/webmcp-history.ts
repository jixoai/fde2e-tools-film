import { currentProjectId, jsonSchema, say, type WebMCPToolDef } from './webmcp-kit.ts';
export function historyExtraTools(): WebMCPToolDef[] {
  return [
    {
      name: 'edit_list_deleted_versions', title: 'List deleted versions',
      description: 'Read recoverable versions from the same recycle-bin view the person uses. The current version is never deleted.',
      inputSchema: jsonSchema({}), annotations: { readOnlyHint: true },
      execute: async () => {
        const id = currentProjectId(); if (!id) return say({ error: 'no project is open' });
        const { historyApi } = await import('../lib/project-history.ts');
        return say(await historyApi.load(id, 10000, true));
      },
    },
    ...(['delete', 'recover'] as const).map((action): WebMCPToolDef => ({
      name: `edit_${action}_versions`, title: action === 'delete' ? 'Delete versions' : 'Recover versions',
      description: action === 'delete' ? 'Move named versions into the recoverable recycle bin. The current version is protected. Uses the same action as the history panel.' : 'Restore deleted versions into history without changing the current working version. Uses the same action as the history recycle bin.',
      inputSchema: jsonSchema({ commits: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 100 } }, ['commits']),
      annotations: { readOnlyHint: false, consequentialHint: action === 'delete' },
      execute: async ({ commits }) => {
        try {
          const id = currentProjectId(); if (!id) throw new Error('no project is open');
          if (!Array.isArray(commits) || !commits.length || commits.length > 100 || commits.some((v) => typeof v !== 'string' || !/^v[a-z0-9]+$/.test(v))) throw new Error('invalid version list');
          await (await import('../lib/film-runtime.ts')).settledFor(id);
          const { historyApi } = await import('../lib/project-history.ts');
          const result = await historyApi[action](id, commits);
          return say(result.ok ? { ok: true, ...result.body } : { error: result.code ?? `${action} refused` });
        } catch (error) { return say({ error: error instanceof Error ? error.message : String(error) }); }
      },
    })),
    {
      name: 'edit_restore_film', title: 'Restore only film.html',
      description: 'Restore film.html from a saved version while preserving current media and other project files. Destructive; the caller should confirm overwriting unsaved timeline changes.',
      inputSchema: jsonSchema({ commit: { type: 'string' } }, ['commit']), annotations: { readOnlyHint: false, consequentialHint: true },
      execute: async ({ commit }) => {
        try {
          const id = currentProjectId(); if (!id || typeof commit !== 'string') throw new Error('project and version required');
          await (await import('../lib/film-runtime.ts')).settledFor(id);
          const { historyApi } = await import('../lib/project-history.ts'); const result = await historyApi.restoreFilm(id, commit);
          return say(result.ok ? { ok: true, ...result.body } : { error: result.code ?? 'restore refused' });
        } catch (error) { return say({ error: error instanceof Error ? error.message : String(error) }); }
      },
    },
  ];
}
