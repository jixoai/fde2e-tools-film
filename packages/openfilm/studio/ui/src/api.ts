/**
 * Studio's API, as the editor calls it (studio/server/server.mjs). Same origin, so the launch key travels as the
 * cookie `/open` set; writes are refused from any other origin.
 */
import type { ExportJob } from '@/lib/export-jobs';
import type { SubtitleStyle } from '@/lib/subtitles';
import { studioHost } from '@/lib/host';
import { watchStudioVersion } from '@/lib/studio-version';

/** `working`: an agent of the app's chat is working in it right now (it cannot be deleted meanwhile). */
/** GET /api/version: this Studio's, and npm's latest (null when never learnt; `checking` false: never asked). */
import { readFilmFile } from '../../../src/film-doc.mjs';
import * as store from './web/opfs';
import { isWeb, web, asProject } from './web/backend';

export interface StudioVersion { version: string; latest: string | null; newer: boolean; checkedAt: number | null; checking: boolean; source: boolean;
  /** the update Studio runs from the top bar (lib/web-update), or one that failed */
  update?: { status: 'updating' | 'failed'; version: string; error?: string } }

/** `cover`: when the person set a cover of its own (studio/server/cover.mjs), absent when it has none. */
export type Project = { id: string; path: string; name: string; openedAt: number; missing: boolean; missingReason?: 'folder' | 'film'; working?: boolean; cover?: number };
export type Clip = { src: string; id: string; at?: number; time?: [number] | [number, number];
  box?: { x: number; y: number; w?: number; h?: number; r?: number }; volume?: number; speed?: number; overrides?: unknown[];
  /** a page that sets no size of its own: the px it is laid out at (the stage's without it) */
  size?: { w: number; h: number };
  /** a video's sound alone (an <audio> of its file) */
  sound?: true;
  /** its look: class names for the film's styles, and its own CSS */
  class?: string; style?: string; attrs?: Record<string, string> };
export type Track = { clips: Clip[]; locked?: boolean; hidden?: boolean; muted?: boolean; attrs?: Record<string, string> };
export type Film = { stage?: { w: number; h: number }; tracks: Track[] };
/** `value`: film.html as read, every clip named (a clip with no id takes its file's name, as the server and preview do). */
/** `filmMissing`: the folder is there but film.html is not (read as an empty film; see FolderEvent `film-missing`). */
export type ProjectFilm = { project: Project; folder: string; text: string; rev: string; value: Film | null; doc: Film | null; problems: string[]; filmMissing?: boolean };
export type MediaFile = { path: string; kind: 'video' | 'image' | 'audio' | 'page' | 'other'; size: number; mtime: number; added?: number };
/** A project's editor settings (studio/server/project-settings.mjs). */
export type ProjectSettings = { fps?: number; trackNames?: { name: string; index: number; clips: string[] }[]; trackHeights?: { height: number; index: number; clips: string[] }[] };
export type Listing = { files: MediaFile[]; folders: string[]; pages: { path: string; size: number; mtime: number }[] };
export type Op =
  | { op: 'set'; clip: string; field: string; value?: unknown }
  | { op: 'move'; clip: string; at: number; track?: number; newTrack?: number }
  | { op: 'insert'; clip?: Partial<Clip> & { src: string }; from?: string; at?: number; after?: string; track?: number | { insert: number }; newTrack?: number; link?: string | null }
  | { op: 'remove'; clip: string }
  | { op: 'split'; clip: string; at: number; time: [number, number]; restTime: [number, number] }
  | { op: 'split'; clip: string; left: Record<string, PropValue>; right: Record<string, PropValue>; rightId?: string }
  | { op: 'track'; track: number; field: 'locked' | 'hidden' | 'muted'; value: boolean }
  | { op: 'reorder'; from: number; to: number }
  | { op: 'props'; edits: PropEdit[] }
  | { op: 'stage'; w: number; h: number }
  | { op: 'fields'; clip: string; fields: Record<string, unknown> };

/** A value a clip's property takes (null removes it). */
export type PropValue = number | string | boolean | readonly number[] | Record<string, unknown> | null;
/** One property of one clip, by the clip's id (see studio/server/ops.mjs). */
export type PropEdit = { clip: string; prop: string; value: PropValue };

export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly body: Record<string, unknown>) {
    super(message);
  }
}

/** Writes on their way (edits, renames…): a reload for a new Studio waits for them (studioVersion). */
let writing = 0;

async function call<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const { json, ...rest } = init;
  const write = (rest.method ?? 'GET') !== 'GET';
  if (write) writing += 1;
  try {
    const res = await fetch(`/api/${path}`, {
      ...rest,
      headers: json === undefined ? rest.headers : { 'content-type': 'application/json', ...rest.headers },
      body: json === undefined ? rest.body : JSON.stringify(json),
    });
    const body = await res.json().catch(() => ({}));
    if (res.status === 401) markLocked();
    if (!res.ok) throw new ApiError(String(body.error ?? `Studio answered ${res.status}`), res.status, body);
    return body as T;
  } finally {
    if (write) writing -= 1;
  }
}

const p = (id: string) => `projects/${encodeURIComponent(id)}`;

/** Studio's own preferences, the same for every project (studio/server/prefs.mjs). */
export interface StudioPrefs {
  proxies: { on: boolean; height: 540 | 720 | 1080 };
  seenVersion: string | null;
  projectsFolder: string | null;
  /** the keyboard shortcuts: the scheme in use and the custom ones (lib/keymap `KeyPrefs`, checked there) */
  keys?: unknown;
  /** whether open projects save versions on their own (studio/server/auto-versions.mjs) */
  autoVersions?: boolean;
}
/** Where the projects library is (src/locations.mjs): the folder, its default, whether the person chose it, the free space on its disk, how many projects are in it. */
export interface StudioLocation { path: string; default: string; chosen: boolean; free: number | null; count: number }
export interface StudioLocations { projects: StudioLocation }
/** Said on the window when they change, for what plays by them (the preview's proxies). */
export const PREFS_EVENT = 'openfilm:prefs';
/** Said on the window when the library moved, for the Projects list. */
export const LIBRARY_EVENT = 'openfilm:library';

/** A problem as Studio keeps it (src/problems.mjs): when, what it was about, what it said. */
export interface StudioProblem {
  t: string;
  area: string;
  what: string;
  agent?: string;
  step?: string;
}

const WEB_PREFS_KEY = 'fde2e.film.web-prefs.v1';
const webPrefs = (): StudioPrefs => {
  let saved: Partial<StudioPrefs> = {};
  try { saved = JSON.parse(localStorage.getItem(WEB_PREFS_KEY) ?? '{}') as Partial<StudioPrefs>; } catch { /* reset malformed prefs */ }
  return {
    proxies: { on: false, height: 720 }, seenVersion: null, projectsFolder: null,
    keys: {}, autoVersions: false, ...saved,
  };
};

export const api = {
  /** this Studio's version and the latest openfilm on npm; `check`: ask npm now */
  version: (check = false) => isWeb()
    ? Promise.resolve({ version: __FILM_VERSION__, latest: null, newer: false, checkedAt: null, checking: false, source: false })
    : call<StudioVersion>(`version${check ? '?check=1' : ''}`),
  /** the newest openfilm, run in the background (`openfilm update`): Studio starts again on it; refused (ApiError, `body.code`) while busy */
  update: () => call<{ update: NonNullable<StudioVersion['update']> }>('update', { method: 'POST', json: {} }),
  /** `openfilm doctor`, run by this Studio: the report to paste into an issue (src/doctor.mjs) */
  doctor: () => call<{ ok: boolean; text: string }>('doctor'),
  /** what went wrong in the last two weeks, newest first (src/problems.mjs) */
  problems: () => call<{ problems: StudioProblem[] }>('diagnostics/problems').then((r) => r.problems),
  /** the diagnostic file (server/diagnostics.mjs): `report` and the rest, zipped into the exports folder and shown there */
  exportDiagnostics: (report: string, conversations: boolean) => call<{ path: string; files: string[]; conversations: boolean }>('diagnostics/export', { method: 'POST', json: { report, conversations } }),
  projects: (): Promise<Project[]> => isWeb()
    ? store.listProjects().then((all) => all.map(asProject))
    : call<{ projects: Project[] }>('projects').then((r) => r.projects),
  prefs: (): Promise<StudioPrefs> => (isWeb() ? Promise.resolve(webPrefs()) : call<StudioPrefs>('prefs')),
  /** where new projects and exports go, and the free space there */
  locations: () => call<StudioLocations>('locations'),
  /** move the library to `path` (null: the default); with `move`, its projects go too (those that could not are in `failed`) */
  moveLibrary: (path: string | null, move: boolean) => call<{ moved: number; failed: { name: string; error: string }[]; locations: StudioLocations }>('locations/projects', { method: 'PUT', json: { path, move } }).then((done) => {
    window.dispatchEvent(new Event(LIBRARY_EVENT));
    return done;
  }),
  /** a project's folder, shown in the system's file manager */
  revealProject: (id: string) => call<object>(`projects/${encodeURIComponent(id)}/reveal`, { method: 'POST', json: {} }),
  /** one of them in the system's file manager */
  openLocation: (which: keyof StudioLocations) => call<{ ok: true }>(`locations/${which}`, { method: 'POST', json: {} }),
  setPrefs: (patch: { proxies?: Partial<StudioPrefs['proxies']>; seenVersion?: string; projectsFolder?: string | null; keys?: unknown; autoVersions?: boolean }) => (isWeb()
    ? Promise.resolve().then((): StudioPrefs => {
      const current = webPrefs();
      const prefs: StudioPrefs = { ...current, ...patch, proxies: { ...current.proxies, ...(patch.proxies ?? {}) } };
      localStorage.setItem(WEB_PREFS_KEY, JSON.stringify(prefs));
      return prefs;
    })
    : call<StudioPrefs>('prefs', { method: 'PATCH', json: patch })).then((prefs) => {
      window.dispatchEvent(new Event(PREFS_EVENT));
      return prefs;
    }),
  /** the system's folder dialog, opened by Studio (a page in a browser cannot learn a path): the folder, or null when
      cancelled; throws (501) where this system has none */
  pickFolder: (title: string, at?: string) => call<{ path: string | null }>('pick-folder', { method: 'POST', json: { title, ...(at ? { at } : {}) } }).then((r) => r.path),
  newProject: (name?: string, _subtitleStyle?: SubtitleStyle): Promise<Project> => isWeb()
    ? store.createProject(name).then(asProject)
    : call<{ project: Project }>('projects', { method: 'POST', json: { name, subtitleStyle: _subtitleStyle } }).then((r) => r.project),
  /** open a folder (its full path) as a project: made one when it is not yet */
  openFolder: (path: string) => call<{ project: Project }>('projects', { method: 'POST', json: { path } }).then((r) => r.project),
  rename: (id: string, name: string): Promise<Project> => {
    if (isWeb()) return store.renameProject(id, name).then((r) => { if (!r) throw new ApiError('the project is gone', 404, {}); return asProject(r); });
    return call<{ project: Project }>(p(id), { method: 'PATCH', json: { name } }).then((r) => {
      studioHost?.projectChanged?.(r.project);
      return r.project;
    });
  },
  forget: (id: string): Promise<object> => {
    if (isWeb()) return store.deleteProject(id).then(() => ({}));
    return call<object>(p(id), { method: 'DELETE' });
  },
  film: (id: string): Promise<ProjectFilm> => {
    if (isWeb()) {
      web();
      return store.getProject(id).then(async (project) => {
        if (!project) throw new ApiError('gone', 404, {});
        const text = (await store.readFilm(id))?.text ?? '';
        const rev = text ? await store.filmRev(text) : '';
        /* the value is read by the format's own reader through ops.mjs at apply time; a web film
           hands the raw text and an empty value, and the editor reads it through use-film's
           `broken` path only when the text cannot be read — so parse it here with the same code
           the server used (readFilmFile lives in src/film-doc.mjs, browser-safe) */
        const read = readFilmFile(text);
        return {
          project: asProject(project),
          /* the web file server's route to this project (Preview loads `folder + 'film.html'`,
             the player resolves media against it); trailing slash: the frame src concatenates */
          folder: isWeb() ? `/wf/${id}/` : id,
          text,
          rev,
          value: read.doc ? read.value : null,
          doc: read.doc,
          problems: read.problems ?? [],
          filmMissing: text.trim() === '',
        };
      });
    }
    return call<ProjectFilm>(p(id));
  },
  /** the person opened it here: the one `openfilm open` alone comes back to */
  opened: (id: string): Promise<{ project: Project }> => {
    if (isWeb()) return store.markOpened(id).then(() => store.getProject(id)).then((r) => { if (!r) throw new ApiError('gone', 404, {}); return { project: asProject(r) }; });
    return call<{ project: Project }>(`${p(id)}/opened`, { method: 'POST' });
  },
  /* `undo`: the edit puts back an earlier one (Studio keeps the person's edits over an agent's writes until then).
     Web: the same contract out of OPFS — applyOps here (the editor already holds the module), filmHtml writes
     back over the text it read, and the rev is the written text's hash. `base` mismatch answers null the
     caller turns into its conflict path (the server face's 409). */
  edit: async (id: string, base: string | null, ops: Op[], undo = false) => {
    if (isWeb()) {
      web();
      const current = await store.readFilm(id);
      if (!current) throw new ApiError('the project is gone', 404, {});
      if (base !== null && base !== current.rev) {
        const read = readFilmFile(current.text);
        throw Object.assign(new ApiError('the film moved under this edit', 409, {}), { value: read.doc, rev: current.rev });
      }
      const { guardedOps } = await import('./web/guarded-ops.ts');
      const { filmHtml } = await import('../../../src/film-doc.mjs');
      const read = readFilmFile(current.text);
      if (!read.doc) throw new ApiError(read.problems.join('\n') || 'film.html cannot be read', 422, {});
      const after = guardedOps(read.value! as Film, ops);
      const text = filmHtml(after, current.text);
      const valid = readFilmFile(text);
      if (!valid.doc || valid.problems.length) throw new ApiError(valid.problems.join('\n') || 'invalid edit', 422, {});
      const rev = await store.writeFilm(id, text, current.rev);
      if (rev === null) throw Object.assign(new ApiError('the film moved under this edit', 409, {}), { value: read.doc, rev: current.rev });
      const written = readFilmFile(text);
      return { text, rev, value: written.doc ? written.value : after, doc: written.doc, rebased: false };
    }
    return call<{ text: string; rev: string; value: Film; doc: Film; rebased: boolean }>(`${p(id)}/edit`, { method: 'POST', json: { base, ops, ...(undo ? { undo: true } : {}) } });
  },
  files: (id: string): Promise<Listing> => isWeb()
    ? store.listFiles(id).then((l) => ({ files: l.files, folders: l.folders, pages: l.pages }))
    : call<Listing>(`${p(id)}/files`),
  /** the editor's settings of the project (`.film/settings.json`): its frame rate, its tracks' names */
  settings: (id: string): Promise<ProjectSettings> => (isWeb()
    ? store.readFileText(id, '.film/settings.json').then((text) => text ? JSON.parse(text) as ProjectSettings : {})
    : call<{ settings: ProjectSettings }>(`${p(id)}/settings`).then((r) => r.settings)),
  /** change some of them (null takes one away); answers them all as kept */
  patchSettings: (id: string, patch: { fps?: number | null; trackNames?: ProjectSettings['trackNames'] | null; trackHeights?: ProjectSettings['trackHeights'] | null }): Promise<ProjectSettings> => (isWeb()
    ? store.readFileText(id, '.film/settings.json').then(async (text) => {
      const settings = text ? JSON.parse(text) as Record<string, unknown> : {};
      for (const [key, value] of Object.entries(patch)) { if (value === null) delete settings[key]; else settings[key] = value; }
      await store.putFile(id, '.film/settings.json', new Blob([JSON.stringify(settings)]));
      return settings as ProjectSettings;
    })
    : (
      call<{ settings: ProjectSettings }>(`${p(id)}/settings`, { method: 'PATCH', json: patch }).then((r) => r.settings)
    )),
  /** its markers (`.film/markers.json`, lib/markers): the whole list, read and written */
  markers: (id: string): Promise<unknown> => (isWeb()
    ? store.readFileText(id, '.film/markers.json').then((text) => (text ? JSON.parse(text) : []))
    : call<{ markers: unknown }>(`${p(id)}/markers`).then((r) => r.markers)),
  putMarkers: (id: string, markers: unknown[]): Promise<unknown> => {
    if (isWeb()) {
      web();
      return store.putFile(id, '.film/markers.json', new Blob([JSON.stringify(markers)])).then(() => markers);
    }
    return (
      call<{ markers: unknown }>(`${p(id)}/markers`, { method: 'PUT', json: { markers } }).then((r) => r.markers)
    );
  },
  /** the loudness of a part of a file's sound (its own seconds): integrated LUFS (null: silent) and true peak.
      Web: no ffmpeg here — answers "not measured"; the web normalize flow waits for the OfflineAudioContext
      batch (tracked in tasks 2.x), and until then reports unmeasured rather than guessing. */
  loudness: (id: string, path: string, from: number, to: number): Promise<{ lufs: number | null; peak: number | null }> => {
    if (isWeb()) return Promise.resolve({ lufs: null, peak: null });
    return call<{ lufs: number | null; peak: number | null }>(
      `${p(id)}/media?what=loudness&path=${encodeURIComponent(path)}&from=${from}&to=${to}`,
    );
  },
  /** a video's frame (`ms` of its own time) made a still beside it; answers its path.
      Web: waits for the capture batch (3.x) — a plain "not implemented" beats a wrong frame. */
  freezeFrame: (id: string, path: string, ms: number): Promise<string> => {
    if (isWeb()) return Promise.reject(new ApiError('freeze frame needs the capture batch (3.x)', 501, {}));
    return call<{ path: string }>(`${p(id)}/files/still`, { method: 'POST', json: { path, ms } }).then((r) => r.path);
  },
  /** The project's own cover for its card (studio/server/cover.mjs): a picture from this computer, a picture of the project,
      the film at `ms`, or none (null: its film's poster again). Each answers when it was set. */
  setCover: (id: string, from: { file: Blob } | { path: string } | { ms: number }): Promise<number | null> => {
    if (isWeb()) {
      web();
      if (!('file' in from)) throw new ApiError('a web cover is a file', 400, {});
      return from.file.arrayBuffer().then((data) => store.setCover(id, data));
    }
    return call<{ cover: number | null }>(`${p(id)}/cover`,
      'file' in from ? { method: 'PUT', body: from.file, headers: { 'content-type': 'application/octet-stream' } } : { method: 'POST', json: from }).then((r) => r.cover);
  },
  clearCover: (id: string): Promise<null> => (isWeb()
    ? store.setCover(id, null).then(() => null)
    : call<{ cover: null }>(`${p(id)}/cover`, { method: 'DELETE' }).then(() => null)),
  answerAsk: (askId: string, allow: boolean) => call<{ answered: boolean }>(`get/asks/${encodeURIComponent(askId)}`, { method: 'POST', json: { allow } }),
  /** the provider's own page for its balance, opened in the person's browser */
  openBilling: (providerId: string) => call<Record<string, never>>(`providers/${encodeURIComponent(providerId)}/billing`, { method: 'POST' }),
  /** clips (by id), clips together (a group) and files (by path) of a project put in Saved (studio/server/saved.mjs):
      each one's place there */
  save: (id: string, what: { clips?: SavedAsk[]; groups?: Array<SavedAsk & { ids: string[] }>; files?: Array<SavedAsk & { path: string }>; into?: string }) => (
    call<{ paths: string[] }>(`${p(id)}/saved`, { method: 'POST', json: what }).then((r) => r.paths)
  ),
  /** a thing of Saved (its `saved/` path) used in the project: a file imported (its place), or a bundle's files brought in
      and the clip, a group's clips or the page to put on the timeline */
  takeSaved: (id: string, path: string) => call<{ clip: Record<string, unknown> & { src: string } } | { clips: SavedGroupClip[] } | { path: string }>(
    `${p(id)}/saved/take`, { method: 'POST', json: { path } },
  ),
  /** a page of the project as text, with its rev (studio/server/page-text.mjs) */
  readPage: (id: string, path: string): Promise<{ text: string; rev: string }> => {
    if (isWeb()) {
      web();
      return store.readFileText(id, path).then(async (text) => {
        if (text === null) throw new ApiError('no such page', 404, {});
        return { text, rev: await store.filmRev(text) };
      });
    }
    return call<{ text: string; rev: string }>(`${p(id)}/page?path=${encodeURIComponent(path)}`);
  },
  /** a page written (text null: taken away) when it is still the page of rev `expect` (null: none there yet); its new
      rev. `undo`: the write takes back one of Studio's (a paste undone) */
  writePage: (id: string, path: string, text: string | null, _expect: string | null, _undo = false): Promise<string | null> => {
    if (isWeb()) {
      web();
      return store.writePage(id, path, text, _expect);
    }
    return (
      call<{ rev: string | null }>(`${p(id)}/page`, { method: 'PUT', json: { path, text, expect: _expect, ...(_undo ? { undo: true } : {}) } }).then((r) => r.rev)
    );
  },
  /** a clip of project `from` brought into this one with the files it needs (layers pasted from there): its src here */
  bringClip: (id: string, from: string, clip: Record<string, unknown> & { src: string }) => (
    call<{ clip: Record<string, unknown> & { src: string } }>(`${p(id)}/bring`, { method: 'POST', json: { from, clip } }).then((r) => r.clip)
  ),
};

/** A clip of a saved group: its track counted from the group's top one, its time in seconds from the group's start. */
export type SavedGroupClip = { track: number; at: number; clip: Record<string, unknown> & { src: string } };

/** What is said of a thing put in Saved: a clip's id (a file's path beside it), a name, and how long and big it is. */
export type SavedAsk = { id?: string; name?: string; durationMs?: number; w?: number; h?: number };

/** What an agent's `openfilm get` asks the person before it spends (studio/server/get.mjs). */
export type SpendAsk = {
  id: string; kind: 'video'; provider: string; model?: string; seconds?: number; prompt?: string;
};

/** What the person is told without a question (studio/server/get.mjs): a provider with no balance left for a run. */
export type StudioNotice = { id: string; kind: 'balance'; provider: string; providerId: string };

export type FolderEvent = { type: 'film'; rev: string } | { type: 'files'; paths?: string[] } | { type: 'history'; moved?: boolean } | { type: 'export'; job: ExportJob } | { type: 'open'; to: string }
  | { type: 'history-progress'; op: string; phase: string; done: number; total: number }
  | { type: 'ask'; ask: SpendAsk } | { type: 'asked'; id: string } | { type: 'notice'; notice: StudioNotice } | { type: 'project'; project: Project }
  /* its folder is there but film.html is not (an agent writing it again, or it lost): the project stays open and
     says so, until a `film` event says it is back */
  | { type: 'film-missing' }
  /* the project was deleted, or its folder is missing: its pages leave it */
  | { type: 'gone' };

/**
 * Listen to a stream of events (a WebSocket: a browser's six HTTP connections to Studio stay free for the page's
 * requests, however many pages are open); returns a function that stops listening. It reconnects on its own;
 * `onBack` runs when it does (Studio stopped and started again: what changed meanwhile was not told). `watch`: this
 * stream says whether Studio answers (studioConnection), and reloads the page when Studio comes back as another
 * version (lib/studio-version); the page's own one does. It also tells Studio whether the page is in sight, so
 * `openfilm open` opens a browser when no page is (a tab behind others, a minimized window).
 */
export function listen(path: string, on: (event: FolderEvent) => void, { onBack, watch = false, gone }: { onBack?: () => void; watch?: boolean; gone?: () => Promise<boolean> } = {}): () => void {
  /* the web face has no server to lose: the stream is quiet, the connection always up. Project
     events reach the page through the store's BroadcastChannel (src/web/opfs subscribe). */
  if (isWeb()) {
    if (watch) setConnection('up');
    const stopStore = on.length
      ? store.subscribe((event) => {
        if (event.type === 'project') {
          if (event.project) on({ type: 'project', project: asProject(event.project) });
          return;
        }
        on(event);
      })
      : () => {};
    return stopStore;
  }
  const inSight = () => document.visibilityState === 'visible';
  const url = () => `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/${path}${watch ? `?visible=${inSight() ? 1 : 0}` : ''}`;
  const tell = () => { if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ visible: inSight() })); };
  if (watch) document.addEventListener('visibilitychange', tell);
  let socket: WebSocket | null = null;
  let stopped = false, lost = false, tries = 0;
  let again: ReturnType<typeof setTimeout> | null = null;
  const watcher = watch ? watchConnection() : null;
  if (watch && !isWeb()) studioVersion ??= watchStudioVersion({
    version: () => fetch('/api/health', { cache: 'no-store' }).then((r) => r.json()).then((h) => (typeof h?.version === 'string' ? h.version : null)),
    idle: () => writing === 0,
    reload: () => location.reload(),
    storage: (() => { try { return sessionStorage; } catch { return null; } })(),
  }); // web: no server version to watch (the page ships whole with the site)
  const connect = () => {
    const s = new WebSocket(url());
    socket = s;
    s.onopen = () => {
      tries = 0;
      watcher?.up();
      if (lost) {
        lost = false;
        onBack?.();
        /* back as another version (a newer openfilm, or the desktop app's): this page's code is reloaded to match */
        if (watch) void studioVersion?.back();
      }
    };
    s.onmessage = (e) => { try { on(JSON.parse(String(e.data)) as FolderEvent); } catch { /* not ours */ } };
    s.onclose = () => {
      if (stopped) return;
      lost = true;
      watcher?.down();
      /* refused, not gone: Studio is there but this browser has no key (the stream says no reason, a request does) */
      if (watch && tries === 0) void fetch('/api/version', { cache: 'no-store' }).then((r) => { if (r.status === 401) markLocked(); }, () => {});
      /* soon at first, then every second: Studio restarting (`openfilm open` starts it afresh) is back within one
         or two, and waits a few for the pages before it */
      again = setTimeout(connect, Math.min(1000, 250 * 2 ** tries++));
      /* refused again and again while Studio answers: what it streams may be gone (a project deleted, its folder
         moved away), which reconnecting can't change; asked, and if so said once and left */
      if (gone && (tries === 3 || tries % 20 === 0)) {
        void gone().then((yes) => {
          if (!yes || stopped) return;
          stopped = true;
          if (again) clearTimeout(again);
          on({ type: 'gone' });
        }, () => {});
      }
    };
  };
  connect();
  return () => { stopped = true; if (again) clearTimeout(again); if (watch) document.removeEventListener('visibilitychange', tell); watcher?.stop(); socket?.close(); };
}

/** Which version of Studio served this page (see listen's `watch`). */
let studioVersion: ReturnType<typeof watchStudioVersion> | null = null;

/**
 * Whether Studio answers, for the notice when it does not: 'up', 'lost' (stopped a moment ago, reconnecting), 'gone'
 * (still not back), or 'locked': Studio answers but not this browser, which was never let in (its address was typed
 * or pasted without the key `openfilm open` prints, or its key is another launch's). Waiting does not fix that one.
 */
export type Connection = 'up' | 'lost' | 'gone' | 'locked';
let connection: Connection = 'up';
const connectionListeners = new Set<() => void>();
export const studioConnection = {
  get: () => connection,
  subscribe(fn: () => void) { connectionListeners.add(fn); return () => { connectionListeners.delete(fn); }; },
};
/** Studio answered this page 401: it was never let in (see Connection). */
export function markLocked() { setConnection('locked'); }
function setConnection(next: Connection) {
  if (next === connection || (connection === 'locked' && next !== 'up')) return;
  connection = next;
  for (const fn of [...connectionListeners]) fn();
}
/** A moment without Studio is said, a long one more plainly. */
function watchConnection() {
  let timers: ReturnType<typeof setTimeout>[] = [];
  const clear = () => { for (const timer of timers) clearTimeout(timer); timers = []; };
  return {
    down() {
      if (timers.length || connection !== 'up') return;
      /* a blip (the computer woke, the stream was cut and came straight back) is not worth a notice */
      timers = [setTimeout(() => setConnection('lost'), 2000), setTimeout(() => setConnection('gone'), 20_000)];
    },
    up() { clear(); setConnection('up'); },
    stop: clear,
  };
}
/* One stream per project, shared by everyone listening on the page. */
const streams = new Map<string, { stop: () => void; listeners: Set<(event: FolderEvent) => void> }>();
export function projectEvents(id: string, on: (event: FolderEvent) => void): () => void {
  let stream = streams.get(id);
  if (!stream) {
    const listeners = new Set<(event: FolderEvent) => void>();
    const tell = (event: FolderEvent) => {
      if (listeners.size && event.type === 'project') studioHost?.projectChanged?.(event.project);
      for (const fn of [...listeners]) fn(event);
    };
    /* back after Studio was away: the film, the files and the history may all have changed meanwhile */
    const stop = listen(`${p(id)}/events`, tell, {
      onBack: () => { tell({ type: 'film', rev: '' }); tell({ type: 'files' }); tell({ type: 'history' }); },
      /* off the list, or missing its folder: gone (an unreadable list says nothing). Missing only film.html is not */
      gone: () => call<{ projects: Project[] }>('projects').then((r) => { const found = r.projects.find((x) => x.id === id); return !found || (found.missing && found.missingReason !== 'film'); }),
    });
    stream = { stop, listeners };
    streams.set(id, stream);
  }
  stream.listeners.add(on);
  const mine = stream;
  return () => {
    mine.listeners.delete(on);
    if (!mine.listeners.size && streams.get(id) === mine) { mine.stop(); streams.delete(id); }
  };
}
