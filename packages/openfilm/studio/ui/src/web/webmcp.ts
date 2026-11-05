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
import { currentProjectId, jsonSchema, say, type ModelContextLike, type WebMCPToolDef } from './webmcp-kit.ts';
import { frameRatioOf, type FilmFrameId } from '../lib/film-frame.ts';
export type { ModelContextLike, WebMCPToolDef } from './webmcp-kit.ts';

/** The api and friends load lazily: the defs must be inspectable (tests, listing) without the
    app graph, and a tool call is rare enough to pay the dynamic import. */
type Api = typeof import('../api')['api'];
const api = async (): Promise<Api> => (await import('../api')).api;
const historyApiModule = async () => (await import('../lib/project-history.ts')).historyApi;
const lanes = async () => (await import('./capture-lanes.ts')).availableLanes;
const canEncode = async () => (await import('./encode-backend.ts')).encodeAvailable;
const canSaveBack = async () => (await import('./save-back.ts')).saveBackAvailable;
const webRuntime = async () => import('./web-runtime.ts');
const webExports = async () => import('./web-export.ts');
const opfs = async () => import('./opfs/index.ts');

const requestedFrame = (value: unknown): FilmFrameId | null => (
  value === undefined || value === 'native'
    ? 'native'
    : typeof value === 'string' && frameRatioOf(value) !== null
      ? value as FilmFrameId
      : null
);

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
      name: 'projects_list_media',
      title: 'List project media',
      description: 'List every file already in a project’s media library, including its OPFS path, type and byte size. Read-only; use this to verify a passive intake before editing the timeline.',
      inputSchema: jsonSchema({ projectId: { type: 'string', description: 'Project id; defaults to the open project' } }),
      annotations: { readOnlyHint: true },
      execute: async ({ projectId }) => {
        const id = typeof projectId === 'string' && projectId ? projectId : currentProjectId();
        if (!id) return say({ error: 'no project is open; provide projectId' });
        try {
          const listing = await (await api()).files(id);
          return say({ projectId: id, files: [...listing.files, ...listing.pages].map((file) => ({
            path: file.path, kind: 'kind' in file ? file.kind : 'page', size: file.size, mtime: file.mtime,
          })) });
        } catch (error) {
          return say({ error: error instanceof Error ? error.message : String(error) });
        }
      },
    },
    {
      name: 'projects_import_media',
      title: 'Import media into a project',
      description: 'Passive intake only: copy one allowlisted CORS URL or a base64 image/video/audio payload into OPFS assets. No provider is called and no credential is accepted. For large local/Omni artifacts, use the browser bridge upload command on Film’s file input instead.',
      inputSchema: jsonSchema({
        projectId: { type: 'string', description: 'Project id; defaults to the open project' },
        url: { type: 'string', description: 'HTTPS media URL on images.pexels.com, cdn.pixabay.com or v3.fal.media' },
        dataBase64: { type: 'string', description: 'Raw base64 or a base64 data URL (max 64 MiB decoded)' },
        name: { type: 'string', description: 'File name. Required for dataBase64; optional for URL.' },
        mime: { type: 'string', description: 'Declared media MIME for raw base64, such as image/png' },
        folder: { type: 'string', description: 'Project folder under assets/ (default assets)' },
      }),
      annotations: { readOnlyHint: false, untrustedContentHint: true },
      execute: async ({ projectId, url, dataBase64, name, mime, folder }, options) => {
        const id = typeof projectId === 'string' && projectId ? projectId : currentProjectId();
        if (!id) return say({ error: 'no project is open; provide projectId' });
        const hasUrl = typeof url === 'string' && Boolean(url.trim());
        const hasBase64 = typeof dataBase64 === 'string' && Boolean(dataBase64.trim());
        if (hasUrl === hasBase64) return say({ error: 'provide exactly one of url or dataBase64' });
        if (hasBase64 && (typeof name !== 'string' || !name.trim())) return say({ error: 'dataBase64 intake needs a file name' });
        try {
          const intake = await import('./media-intake.ts');
          const receipt = hasUrl
            ? await intake.importMediaUrl(id, String(url), {
              name: typeof name === 'string' && name.trim() ? name : undefined,
              folder: typeof folder === 'string' && folder ? folder : undefined,
              signal: options.signal,
            })
            : await intake.importMediaBase64(id, String(dataBase64), {
              name: String(name),
              mime: typeof mime === 'string' ? mime : undefined,
              folder: typeof folder === 'string' && folder ? folder : undefined,
            });
          return say({ ok: true, ...receipt });
        } catch (error) {
          return say({
            error: error instanceof Error ? error.message : String(error),
            ...((error as { code?: unknown })?.code ? { code: (error as { code: unknown }).code } : {}),
          });
        }
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
        const projects = await (await api()).projects();
        if (!projects.some((p) => p.id === id)) return say({ error: `no such project: ${id}` });
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
      description: 'Copy a bundled, checksum-verified example into a normal OPFS project and open it. The project includes its source, AI-material provenance and all license notices.',
      inputSchema: jsonSchema({ id: { type: 'string', description: `Bundled example id (default: one-prompt)` } }),
      annotations: { readOnlyHint: false },
      execute: async ({ id }) => {
        try {
          const { DEFAULT_EXAMPLE_ID, loadBundledExample } = await import('./examples.ts');
          const project = await loadBundledExample(typeof id === 'string' && id ? id : DEFAULT_EXAMPLE_ID);
          openProject(project.id);
          return say({ ok: true, id: project.id, name: project.name, example: typeof id === 'string' && id ? id : DEFAULT_EXAMPLE_ID });
        } catch (e) {
          return say({ error: e instanceof Error ? e.message : String(e) });
        }
      },
    },

    // ── produce ──
    {
      name: 'produce_look',
      title: 'Capture a look',
      description: 'Capture the open film at one exact second through the same in-page preview lane the human viewer sees. Writes a PNG under downloads/ and returns its OPFS path and bytes. Read-only over the edit timeline; creates an export artifact.',
      inputSchema: jsonSchema({
        at: { type: 'number', description: 'Film second to capture (default: 0)' },
        name: { type: 'string', description: 'Output base name (default: <project> - look)' },
        shortEdge: { type: 'integer', description: 'Output short edge, 64..4096 (default: native short edge)' },
        frame: { type: 'string', description: 'native or a W:H ratio such as 9:16 (default: native)' },
        fill: { type: 'string', enum: ['contain', 'cover'], description: 'How the film fits another frame shape' },
      }),
      annotations: { readOnlyHint: false },
      execute: async ({ at, name, shortEdge, frame, fill }, options) => {
        const id = currentProjectId();
        if (!id) return say({ error: 'no project is open' });
        if (at !== undefined && (typeof at !== 'number' || !Number.isFinite(at) || at < 0)) return say({ error: 'at has to be a film second, 0 or more' });
        if (shortEdge !== undefined && (typeof shortEdge !== 'number' || !Number.isInteger(shortEdge) || shortEdge < 64 || shortEdge > 4096)) return say({ error: 'shortEdge has to be a whole pixel count from 64 to 4096' });
        const chosenFrame = requestedFrame(frame);
        if (chosenFrame === null) return say({ error: 'frame has to be native or a W:H ratio from 1:4 to 4:1' });
        if (fill !== undefined && fill !== 'contain' && fill !== 'cover') return say({ error: 'fill has to be contain or cover' });
        let runtime;
        try { runtime = await (await webRuntime()).waitForWebProjectRuntime(id, { signal: options?.signal }); }
        catch (error) { return say({ error: error instanceof Error ? error.message : String(error) }); }
        if (typeof at === 'number' && at > runtime.duration() + 1e-3) return say({ error: `at has to stay inside 0..${runtime.duration()}` });
        const film = await (await api()).film(id);
        const request = {
          kind: 'poster' as const, format: 'png' as const, at: typeof at === 'number' ? at : 0,
          shortEdge: typeof shortEdge === 'number' ? shortEdge : Math.min(runtime.source.size().w, runtime.source.size().h),
          frame: chosenFrame,
          fill: fill === 'cover' ? 'cover' as const : 'contain' as const,
          name: typeof name === 'string' && name.trim() ? name.trim() : `${film.project.name} - look`, label: 'Look',
        };
        try {
          const exports = await webExports(); const store = await opfs();
          const job = exports.startWebExport(id, request, runtime.source, { putFile: store.putFile, readFile: store.readFileBytes });
          const result = await exports.waitForWebExport(id, job.id);
          return result.status === 'done'
            ? say({ ok: true, jobId: result.id, path: result.outputs[0], bytes: result.bytes, at: request.at, mime: 'image/png' })
            : say({ error: result.error ?? `look ${result.status}`, jobId: result.id, status: result.status });
        } catch (error) { return say({ error: error instanceof Error ? error.message : String(error) }); }
      },
    },
    {
      name: 'produce_render',
      title: 'Render an export',
      description: 'Start an MP4/WebM, GIF, PNG-stills or poster export in this browser. Uses the live preview, WebCodecs and same-origin ST ffmpeg where needed; writes atomically to OPFS downloads/. Returns a job immediately by default so long renders outlive the bridge call; poll produce_export_status. Pass wait:true only for a short export that must return exact paths inline. One export runs at a time.',
      inputSchema: jsonSchema({
        kind: { type: 'string', enum: ['video', 'gif', 'stills', 'poster'], description: 'Export family (default: video)' },
        name: { type: 'string', description: 'Output base name (default: project name)' },
        from: { type: 'number', description: 'Start second for video/GIF (default: 0)' },
        to: { type: 'number', description: 'End second for video/GIF (default: film end)' },
        at: { type: 'number', description: 'Poster second, or first still second' },
        moments: { type: 'array', items: { type: 'number' }, description: 'Still seconds (max 100)' },
        codec: { type: 'string', enum: ['h264', 'vp9'], description: 'Video codec/container (default: h264/mp4)' },
        audio: { type: 'boolean', description: 'Include the film mix in video (default: true)' },
        format: { type: 'string', enum: ['png', 'jpg'], description: 'Still/poster format (default: png)' },
        fps: { type: 'number', description: 'Frames a second, 1..60 (default: project fps; GIF default 12)' },
        shortEdge: { type: 'integer', description: 'Video/still short edge, 64..4096 (default: 720)' },
        width: { type: 'integer', description: 'GIF long edge, 64..1920 (default: 640)' },
        frame: { type: 'string', description: 'native or W:H ratio (default: native)' },
        fill: { type: 'string', enum: ['contain', 'cover'], description: 'contain or cover (default: contain)' },
        download: { type: 'boolean', description: 'Also trigger a browser download after success; implies wait:true' },
        wait: { type: 'boolean', description: 'Wait for completion and return exact paths inline (default false; use only for short exports)' },
      }),
      annotations: { readOnlyHint: false },
      execute: async (input, options) => {
        const id = currentProjectId();
        if (!id) return say({ error: 'no project is open' });
        const kind = typeof input.kind === 'string' ? input.kind : 'video';
        if (!['video', 'gif', 'stills', 'poster'].includes(kind)) return say({ error: 'kind has to be video, gif, stills or poster' });
        const chosenFrame = requestedFrame(input.frame);
        if (chosenFrame === null) return say({ error: 'frame has to be native or a W:H ratio from 1:4 to 4:1' });
        if (input.fill !== undefined && input.fill !== 'contain' && input.fill !== 'cover') return say({ error: 'fill has to be contain or cover' });
        let runtime;
        try { runtime = await (await webRuntime()).waitForWebProjectRuntime(id, { signal: options?.signal }); }
        catch (error) { return say({ error: error instanceof Error ? error.message : String(error) }); }
        const duration = runtime.duration(); const from = typeof input.from === 'number' ? input.from : 0;
        const to = typeof input.to === 'number' ? input.to : duration;
        const fps = typeof input.fps === 'number' ? input.fps : kind === 'gif' ? 12 : runtime.fps();
        if (!(duration > 0)) return say({ error: 'the open film has no duration yet' });
        if (!(fps >= 1 && fps <= 60)) return say({ error: 'fps has to be from 1 to 60' });
        if ((kind === 'video' || kind === 'gif') && (!(from >= 0) || !(to > from) || to > duration + 1e-3)) return say({ error: `range has to stay inside 0..${duration}` });
        const shortEdge = typeof input.shortEdge === 'number' ? input.shortEdge : 720;
        if (!Number.isInteger(shortEdge) || shortEdge < 64 || shortEdge > 4096) return say({ error: 'shortEdge has to be a whole pixel count from 64 to 4096' });
        const width = typeof input.width === 'number' ? input.width : 640;
        if (!Number.isInteger(width) || width < 64 || width > 1920) return say({ error: 'width has to be a whole pixel count from 64 to 1920' });
        const moments = Array.isArray(input.moments) ? input.moments : typeof input.at === 'number' ? [input.at] : [0];
        if (moments.length > 100 || moments.some((value) => typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > duration)) return say({ error: `moments have to stay inside 0..${duration} (max 100)` });
        const film = await (await api()).film(id); const name = typeof input.name === 'string' && input.name.trim() ? input.name.trim() : film.project.name;
        const common = { name, label: kind === 'video' ? 'Video' : kind.toUpperCase(), frame: chosenFrame, fill: input.fill === 'cover' ? 'cover' as const : 'contain' as const };
        const request = kind === 'video'
          ? { ...common, kind: 'video' as const, codec: input.codec === 'vp9' ? 'vp9' as const : 'h264' as const, fps, quality: 'high' as const, audio: input.audio !== false, shortEdge, range: [from, to] as [number, number] }
          : kind === 'gif'
            ? { ...common, kind: 'gif' as const, fps, width, range: [from, to] as [number, number] }
            : kind === 'poster'
              ? { ...common, kind: 'poster' as const, format: input.format === 'jpg' ? 'jpg' as const : 'png' as const, shortEdge, at: moments[0] ?? 0 }
              : { ...common, kind: 'stills' as const, as: 'files' as const, format: input.format === 'jpg' ? 'jpg' as const : 'png' as const, shortEdge, at: moments };
        try {
          const exports = await webExports(); const store = await opfs();
          const job = exports.startWebExport(id, request, runtime.source, { putFile: store.putFile, readFile: store.readFileBytes });
          if (input.wait !== true && input.download !== true) {
            return say({ ok: true, jobId: job.id, kind, status: job.status, poll: 'produce_export_status' });
          }
          const result = await exports.waitForWebExport(id, job.id, options?.signal);
          if (result.status !== 'done') return say({ error: result.error ?? `render ${result.status}`, jobId: result.id, status: result.status });
          const download = input.download === true ? await exports.downloadWebExport(id, result.id, store.readFileBytes) : null;
          return say({ ok: true, jobId: result.id, kind, status: result.status, paths: result.outputs, bytes: result.bytes, encoder: result.encoder, ...(download ? { download } : {}) });
        } catch (error) { return say({ error: error instanceof Error ? error.message : String(error) }); }
      },
    },
    {
      name: 'produce_export_status',
      title: 'Export status',
      description: 'Read preview readiness, current Web export jobs, encode capabilities, byte totals and project versions. Read-only.',
      inputSchema: jsonSchema({}),
      annotations: { readOnlyHint: true },
      execute: async () => {
        const id = currentProjectId(); const history = id ? await (await historyApiModule()).load(id) : null;
        const exports = await webExports();
        return say({
          projectId: id, previewReady: id ? Boolean((await webRuntime()).webProjectRuntime(id)) : false,
          encodeAvailable: await (await canEncode())('mp4').catch(() => false),
          capabilities: exports.webExportCapabilities(), busy: id ? exports.webExportBusy(id) : false,
          bytes: id ? exports.webExportBytes(id) : 0,
          jobs: id ? exports.listWebExports(id).map((job) => ({
            id: job.id, kind: job.kind, status: job.status, phase: job.phase,
            progress: job.progress, framesDone: job.framesDone, framesTotal: job.framesTotal,
            rate: job.rate, etaMs: job.etaMs, encoder: job.encoder,
            outputs: job.outputs, bytes: job.bytes, error: job.error,
          })) : [],
          versions: history?.versions.length ?? 0,
        });
      },
    },
  ];
}
