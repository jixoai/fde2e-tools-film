/**
 * The WebMCP tool surface (design D8, spec web-film-webmcp; T07's four families): the editor's
 * state as named operations an agent can call — the SAME state the UI drives (T02's 同源铁律:
 * whatever a person can do, a tool can do; nothing a tool does is invisible to the person).
 *
 * Four families:
 *   inspect   film_state / problems / overrides — the agent's read-only eyes. Zero risk.
 *   projects  list / create / open-request / delete / package-download — destructive ones carry
 *             the guardrail annotations (readOnlyHint false; the caller's hub decides).
 *   produce   look (contact sheet / single frame) / render / export_status — 3.4's encoder.
 *   edit      the declarative op set (applyOps, the editor's own vocabulary) — the full
 *             verb-by-verb projection is 4.2; this registers the op passthrough so the family is
 *             live from day one, with the same concurrency the editor has.
 *
 * Registration is tolerant: the native modelContext when present, else the vendored official
 * polyfill (GoogleChromeLabs/webmcp-tools, Apache-2.0 — the same copy tools-v0 vendors); failures
 * per tool are recorded, never fatal. Response is always a JSON string.
 */
/** The api and friends load lazily: the defs must be inspectable (tests, listing) without the
    app graph, and a tool call is rare enough to pay the dynamic import. */
type Api = typeof import('../api')['api'];
const api = async (): Promise<Api> => (await import('../api')).api;
const historyApiModule = async () => (await import('../lib/project-history.ts')).historyApi;
const lanes = async () => (await import('./capture-lanes.ts')).availableLanes;
const canEncode = async () => (await import('./encode-backend.ts')).encodeAvailable;
const canSaveBack = async () => (await import('./save-back.ts')).saveBackAvailable;


/** document.modelContext's structural minimum (native or polyfill). */
export interface ModelContextLike {
  registerTool: (tool: WebMCPToolDef) => Promise<unknown>;
  getTools: (options?: Record<string, unknown>) => Promise<Array<{ name: string }>>;
  executeTool: (tool: unknown, input?: Record<string, unknown>) => Promise<string>;
}

export interface WebMCPToolDef {
  name: string;
  title?: string;
  description: string;
  inputSchema: Record<string, unknown>;
  execute: (input: Record<string, unknown>, options: { signal: AbortSignal }) => Promise<unknown>;
  annotations?: {
    readOnlyHint?: boolean;
    untrustedContentHint?: boolean;
    consequentialHint?: boolean;
    debugging?: boolean;
  };
}

/** Native first, else the vendored polyfill's side effect. Null: the environment can't. */
export async function ensureModelContext(): Promise<ModelContextLike | null> {
  if (typeof document === 'undefined') return null;
  const native = (document as unknown as { modelContext?: ModelContextLike }).modelContext;
  if (native) return native;
  if (!window.isSecureContext) return null;
  try {
    await import('./vendor/webmcp-polyfill.js');
  } catch {
    return null;
  }
  return (document as unknown as { modelContext?: ModelContextLike }).modelContext ?? null;
}

/** A tool's answer, always a JSON string (the polyfill's executeTool returns objects as-is). */
const say = (value: unknown): string => JSON.stringify(value);

/** The project the page has open (/projects/<id>), or null at the launcher. */
const currentProjectId = (): string | null => /^\/projects\/([\w-]+)/.exec(location.pathname)?.[1] ?? null;

const jsonSchema = (properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});

/** The four families' tool defs. `openProject` is injected (the App owns navigation). */
export function filmToolDefs(openProject: (id: string) => void): WebMCPToolDef[] {
  return [
    // ── inspect ──
    {
      name: 'film_state',
      title: 'Film state',
      description: 'The open film\'s full projection: stage, tracks, clips with their fields, and the capture/encode capabilities of this environment. Read-only.',
      inputSchema: jsonSchema({}),
      annotations: { readOnlyHint: true },
      execute: async () => {
        const id = currentProjectId();
        if (!id) return say({ error: 'no project is open' });
        const film = await (await api()).film(id);
        const settings = await (await api()).settings(id).catch(() => ({}));
        return say({
          project: { id, name: film.project.name },
          stage: film.doc?.stage ?? null,
          tracks: film.doc?.tracks ?? [],
          problems: film.problems,
          filmMissing: film.filmMissing === true,
          settings,
          capabilities: {
            lanes: (await lanes())().map((l) => l.id),
            encode: await (await canEncode())('mp4').catch(() => false),
            saveBack: (await canSaveBack())(),
          },
        });
      },
    },
    {
      name: 'film_problems',
      title: 'Film problems',
      description: 'Why the film cannot be read or edited right now (protocol problems, broken film.html). Empty when healthy. Read-only.',
      inputSchema: jsonSchema({}),
      annotations: { readOnlyHint: true },
      execute: async () => {
        const id = currentProjectId();
        if (!id) return say({ error: 'no project is open' });
        const film = await (await api()).film(id);
        return say({ problems: film.problems, broken: film.problems.length > 0 && !film.doc });
      },
    },
    {
      name: 'film_overrides',
      title: 'Film overrides',
      description: 'A page clip\'s person-level override layer, read-only: the selectors and their edits kept beside the page.',
      inputSchema: jsonSchema({ clip: { type: 'string', description: 'The page clip\'s id' } }, ['clip']),
      annotations: { readOnlyHint: true },
      execute: async ({ clip }) => {
        const id = currentProjectId();
        if (!id) return say({ error: 'no project is open' });
        const film = await (await api()).film(id);
        const target = (film.doc?.tracks ?? []).flatMap((t) => t.clips).find((c) => c.id === clip);
        if (!target) return say({ error: `no such clip: ${clip}` });
        return say({ clip, overrides: target.overrides ?? [] });
      },
    },

    // ── edit ──
    {
      name: 'edit_apply',
      title: 'Apply edit operations',
      description: 'Apply the editor\'s declarative operations (op: set/move/insert/remove/split/track/reorder/props/stage/fields — the official MANUAL verb set\'s state vocabulary) to the open film, against its current revision. The person sees the change at once; undo works as with any edit. The full verb-by-verb projection lands with 4.2.',
      inputSchema: jsonSchema({
        ops: {
          type: 'array',
          description: 'The operations in order (each names a clip by its id, never by its place)',
          items: { type: 'object' },
        },
      }, ['ops']),
      annotations: { readOnlyHint: false },
      execute: async ({ ops }) => {
        const id = currentProjectId();
        if (!id) return say({ error: 'no project is open' });
        if (!Array.isArray(ops) || !ops.length) return say({ error: 'an edit needs at least one operation' });
        const film = await (await api()).film(id);
        if (!film.doc) return say({ error: 'film.html cannot be read', problems: film.problems });
        try {
          const done = await (await api()).edit(id, film.rev, ops as never[]);
          return say({ ok: true, rev: done.rev, applied: ops.length });
        } catch (e) {
          const status = (e as { status?: number }).status;
          if (status === 409) return say({ error: 'the film moved under this edit; read film_state and retry', rev: (e as unknown as { rev?: string }).rev });
          return say({ error: e instanceof Error ? e.message : String(e) });
        }
      },
    },

    // ── projects ──
    {
      name: 'projects_list',
      title: 'List projects',
      description: 'Every project in the library, newest-opened first. Read-only.',
      inputSchema: jsonSchema({}),
      annotations: { readOnlyHint: true },
      execute: async () => {
        const projects = await (await api()).projects();
        return say({ projects: projects.map((p) => ({ id: p.id, name: p.name, openedAt: p.openedAt, working: p.working === true })) });
      },
    },
    {
      name: 'projects_create',
      title: 'Create project',
      description: 'A new empty project (named, or Untitled). It does not open by itself; projects_open does.',
      inputSchema: jsonSchema({ name: { type: 'string', description: 'The project\'s name (optional)' } }),
      annotations: { readOnlyHint: false },
      execute: async ({ name }) => {
        const project = await (await api()).newProject(typeof name === 'string' && name.trim() ? name : undefined);
        return say({ id: project.id, name: project.name });
      },
    },
    {
      name: 'projects_open',
      title: 'Open project',
      description: 'Ask the page to show a project (the person sees the switch happen).',
      inputSchema: jsonSchema({ id: { type: 'string', description: 'The project\'s id' } }, ['id']),
      annotations: { readOnlyHint: false },
      execute: async ({ id }) => {
        if (typeof id !== 'string' || !id) return say({ error: 'projects_open needs an id' });
        const project = await (await api()).opened(id).catch(() => null);
        if (!project) return say({ error: `no such project: ${id}` });
        openProject(id);
        return say({ ok: true, id, name: project.project.name });
      },
    },
    {
      name: 'projects_delete',
      title: 'Delete project',
      description: 'Delete a project whole (its files out of the library). Destructive: the caller\'s guardrail should confirm with the person.',
      inputSchema: jsonSchema({ id: { type: 'string', description: 'The project\'s id' } }, ['id']),
      annotations: { readOnlyHint: false, consequentialHint: true },
      execute: async ({ id }) => {
        if (typeof id !== 'string' || !id) return say({ error: 'projects_delete needs an id' });
        await (await api()).forget(id);
        return say({ ok: true, deleted: id });
      },
    },
    {
      name: 'projects_export_package',
      title: 'Export project package',
      description: 'The open project as one interchange .zip (manifest + film.html + assets), returned base64 in the answer. Destructive: no — read-only over the project.',
      inputSchema: jsonSchema({}),
      annotations: { readOnlyHint: true },
      execute: async () => {
        const id = currentProjectId();
        if (!id) return say({ error: 'no project is open' });
        const { buildPackage, zipEntries } = await import('./interchange.ts');
        const { name, entries } = await buildPackage(id);
        const zip = new Uint8Array(zipEntries(entries));
        let binary = '';
        for (let i = 0; i < zip.length; i++) binary += String.fromCharCode(zip[i]!);
        return say({ name, size: zip.byteLength, zipBase64: btoa(binary) });
      },
    },
    {
      name: 'projects_load_example',
      title: 'Load example',
      description: 'Not yet: the example films land with batch 5.1. Present so agents can probe the surface; answers unavailable.',
      inputSchema: jsonSchema({}),
      annotations: { readOnlyHint: true },
      execute: async () => say({ error: 'examples land with batch 5.1' }),
    },

    // ── produce ──
    {
      name: 'produce_look',
      title: 'Look (contact sheet / frame)',
      description: 'Not yet: frame capture rides the export pump wiring (3.3). Present so agents can probe the surface.',
      inputSchema: jsonSchema({}),
      annotations: { readOnlyHint: true },
      execute: async () => say({ error: 'produce_look lands with the export pump wiring' }),
    },
    {
      name: 'produce_render',
      title: 'Render (export video)',
      description: 'Not yet: the export pump wiring (3.3) feeds 3.4\'s encoder. Present so agents can probe the surface.',
      inputSchema: jsonSchema({}),
      annotations: { readOnlyHint: false },
      execute: async () => say({ error: 'produce_render lands with the export pump wiring' }),
    },
    {
      name: 'produce_export_status',
      title: 'Export status',
      description: 'Whether the environment can encode (WebCodecs) and what the project\'s version history holds. Read-only.',
      inputSchema: jsonSchema({}),
      annotations: { readOnlyHint: true },
      execute: async () => {
        const id = currentProjectId();
        const history = id ? await (await historyApiModule()).load(id) : null;
        return say({
          encodeAvailable: await (await canEncode())('mp4').catch(() => false),
          versions: history?.versions.length ?? 0,
          projectId: id,
        });
      },
    },
  ];
}
