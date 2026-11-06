/**
 * The edit family, verb by verb (4.2, T07/T10): the editor's own operations (studio/server/ops.mjs's
 * `applyOps` — the ONE implementation the UI and the writes share) as named tools an agent can call.
 * Every verb goes through the page's own edit path (`api.edit` against the film's current revision),
 * so the person watches the change land at once (use-film's `server` read), and it is exactly what
 * their UI would have written — no second writer, no second truth.
 *
 * The guardrails the UI keeps (and the raw ops would not — they are file-level):
 *   · a locked track is the person's (lib/track-lock): verbs that would change a clip on one are
 *     refused, whichever way the edit came — the same words the timeline says;
 *   · `speed` outside 0.1–100 is refused BEFORE the write (applyOps would take it and the film
 *     would then not read back — a broken film.html);
 *   · a split's halves are worked out as the timeline does (lib/timeline-split's `splitHalves`,
 *     with the preview's spans telling the length a clip with no written end has).
 *
 * The version layer rides beside the verbs (T07: 编辑层操作同层级暴露): list/save/checkout/discard/
 * copy through the same `historyApi` the Version history panel drives, on the same settled gate.
 * `restore_overrides` (L2 — it erases the person's changes) and `write_page` (L3 — it writes a
 * project file whole) carry the consequential annotations; the caller's hub decides.
 *
 * Track indexes at the tool boundary are 1-based (the way film.html numbers its sections top-first
 * and the tool caller sees them); the conversion to ops.mjs's 0-based happens once, here.
 */
import { historyExtraTools } from './webmcp-history.ts';
import { currentProjectId, jsonSchema, say, type WebMCPToolDef } from './webmcp-kit.ts';

type Api = typeof import('../api')['api'];
const api = async (): Promise<Api> => (await import('../api')).api;
const historyApiModule = async () => (await import('../lib/project-history.ts')).historyApi;

/** The settled gate (lib/film-runtime): version ops wait for pending writes as the panel does. */
const settled = async (id: string) => (await import('../lib/film-runtime.ts')).settledFor(id);

/** The preview's spans (film seconds + the source's own length): a clip's length when film.html writes no end. */
const spans = async (id: string) => (await import('../lib/film-runtime.ts')).spansFor(id);

type FilmDoc = NonNullable<Awaited<ReturnType<Api['film']>>['doc']>;
type Clip = { id?: string; src: string; at?: number; time?: [number] | [number, number]; speed?: number; volume?: number; box?: Record<string, unknown>; overrides?: unknown[]; sound?: true; [field: string]: unknown };

/** The film's doc and its clips, found by id. */
type FilmRead = { doc: FilmDoc; rev: string; byId: Map<string, { clip: Clip; track: number }> };

const readFilm = async (id: string): Promise<FilmRead | { error: string }> => {
  const film = await (await api()).film(id);
  if (!film.doc) return { error: 'film.html cannot be read' };
  const byId = new Map<string, { clip: Clip; track: number }>();
  film.doc.tracks.forEach((track, ti) => {
    for (const clip of track.clips as unknown as Clip[]) {
      if (typeof clip.id === 'string' && !byId.has(clip.id)) byId.set(clip.id, { clip, track: ti });
    }
  });
  return { doc: film.doc, rev: film.rev, byId };
};

const isFilmRead = (r: FilmRead | { error: string }): r is FilmRead => !('error' in r);

/** One shared error shape; 409 keeps the current rev so the caller can re-read and retry. */
const fail = (e: unknown): string => {
  const status = (e as { status?: number }).status;
  const rev = (e as unknown as { rev?: string }).rev;
  if (status === 409) return say({ error: 'the film moved under this edit; read film_state and retry', ...(rev ? { rev } : {}) });
  return say({ error: e instanceof Error ? e.message : String(e) });
};

/** Apply ops through the page's own edit path (the same state machine the UI drives). */
const apply = async (id: string | null, base: string, ops: unknown[]): Promise<string> => {
  if (!id) return say({ error: 'no project is open' });
  try {
    const done = await (await api()).edit(id, base, ops as never[]);
    return say({ ok: true, rev: done.rev, applied: ops.length });
  } catch (e) { return fail(e); }
};

/** The verb's op, compiled and checked BEFORE it goes at the film: locks, bounds, existence. */
const planned = async (id: string | null, make: (read: FilmRead) => { ops: unknown[] } | { error: string }): Promise<string> => {
  if (!id) return say({ error: 'no project is open' });
  const read = await readFilm(id);
  if (!isFilmRead(read)) return say({ error: read.error });
  const out = make(read);
  if ('error' in out) return say({ error: out.error });
  return apply(id, read.rev, out.ops);
};

/** A locked track is the person's: refuse by the same rule the UI's edits keep (lib/track-lock). */
const lockOf = (read: FilmRead, clipId: string): boolean => {
  const at = read.byId.get(clipId);
  return Boolean(at && read.doc.tracks[at.track]?.locked);
};

const lockedAnswer = (clipId: string): string =>
  say({ error: `clip "${clipId}" is on a locked track — the person's; ask them to unlock it first` });

const noClip = (clipId: string): string => say({ error: `no such clip: ${clipId}` });

/** The clip's own trim end in source seconds (its `#t=`), when it writes one. */
const sourceEndOf = (clip: Clip): number | undefined =>
  Array.isArray(clip.time) && clip.time.length === 2 ? clip.time[1] : undefined;

/** The number the caller sent, whole and finite. */
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** The edit family's tools, appended to the four families in webmcp.ts (same defs shape). */
export const editFamilyTools = (): WebMCPToolDef[] => [
  ...historyExtraTools(),
  {
    name: 'edit_move_clip',
    title: 'Move a clip',
    description: 'Move one clip in time (at, seconds on the film), and/or to another track (track, 1-based as film.html numbers its sections top-first; newTrack inserts a fresh one there). Clips on one track do not overlap — ops refuses a taken spot; read film_state for where things are.',
    inputSchema: jsonSchema({
      clip: { type: 'string', description: 'The clip\'s id' },
      at: { type: 'number', description: 'Where it starts, seconds on the film from 0' },
      track: { type: 'integer', description: 'Destination track, 1-based (optional)' },
      newTrack: { type: 'integer', description: 'Insert a new empty track at this 1-based place and move the clip onto it (optional)' },
    }, ['clip', 'at']),
    annotations: { readOnlyHint: false },
    execute: async ({ clip, at, track, newTrack }) => {
      const id = currentProjectId();
      const sec = num(at);
      if (sec === null || sec < 0) return say({ error: 'at has to be seconds on the film, 0 or more' });
      return planned(id, (read) => {
        if (!read.byId.has(String(clip))) return { error: `no such clip: ${clip}` };
        if (lockOf(read, String(clip))) return { error: `clip "${clip}" is on a locked track — the person's; ask them to unlock it first` };
        return { ops: [{ op: 'move', clip, at: sec, ...(num(track) != null ? { track: num(track)! - 1 } : {}), ...(num(newTrack) != null ? { newTrack: num(newTrack)! - 1 } : {}) }] };
      });
    },
  },
  {
    name: 'edit_remove_clip',
    title: 'Remove a clip',
    description: 'Take one clip out of the film. It does not close the gap behind it (a ripple is the timeline\'s hand, not a verb); locked tracks refuse.',
    inputSchema: jsonSchema({ clip: { type: 'string', description: 'The clip\'s id' } }, ['clip']),
    annotations: { readOnlyHint: false },
    execute: async ({ clip }) => {
      const id = currentProjectId();
      return planned(id, (read) => {
        if (!read.byId.has(String(clip))) return { error: `no such clip: ${clip}` };
        if (lockOf(read, String(clip))) return { error: `clip "${clip}" is on a locked track — the person's; ask them to unlock it first` };
        return { ops: [{ op: 'remove', clip }] };
      });
    },
  },
  {
    name: 'edit_insert_clip',
    title: 'Insert a clip',
    description: 'Put a new clip on the film: its src (a project file: assets/… or a page film.html can load; pictures and pages need time [0, seconds] — how long they stay), at (seconds on the film), and where it sits (track 1-based, newTrack to open one, after a clip\'s id). A copy of a clip already in the film: pass from instead of src. The file\'s kind picks the track when none is named.',
    inputSchema: jsonSchema({
      src: { type: 'string', description: 'The project file the clip plays (assets/…, or a page)' },
      at: { type: 'number', description: 'Where it starts, seconds on the film' },
      time: { type: 'array', items: { type: 'number' }, description: '[start, end] of its source, seconds — required for a picture or a page without a duration (e.g. [0, 4])' },
      track: { type: 'integer', description: 'Track to land on, 1-based (optional)' },
      newTrack: { type: 'integer', description: 'Open a new empty track at this 1-based place (optional)' },
      after: { type: 'string', description: 'Land right after this clip, on its track (optional)' },
      from: { type: 'string', description: 'Copy this clip (every field) instead of src (optional)' },
      volume: { type: 'number', description: 'Sound level, 1 = the file\'s own (optional)' },
    }, ['src']),
    annotations: { readOnlyHint: false },
    execute: async (input) => {
      const id = currentProjectId();
      const src = typeof input.src === 'string' ? input.src : typeof input.from === 'string' ? '' : null;
      if (!src && typeof input.from !== 'string') return say({ error: 'an insert needs src (a project file), or from (a clip to copy)' });
      const at = num(input.at);
      if (at != null && at < 0) return say({ error: 'at has to be seconds on the film, 0 or more' });
      const time = Array.isArray(input.time) ? input.time : null;
      if (time && (time.length !== 2 || !time.every((v) => typeof v === 'number' && Number.isFinite(v) && v >= 0) || time[0]! >= time[1]!)) {
        return say({ error: 'time has to be [start, end], seconds of the source, end after start' });
      }
      return planned(id, (read) => {
        if (typeof input.from === 'string' && !read.byId.has(input.from)) return { error: `no such clip: ${input.from}` };
        const clip = typeof input.from === 'string'
          ? { from: input.from }
          : { clip: { src, ...(time ? { time: [time[0]!, time[1]!] as [number, number] } : {}), ...(num(input.volume) != null ? { volume: num(input.volume)! } : {}) } };
        return { ops: [{ op: 'insert', ...clip, ...(at != null ? { at } : {}), ...(num(input.track) != null ? { track: num(input.track)! - 1 } : {}), ...(num(input.newTrack) != null ? { newTrack: num(input.newTrack)! - 1 } : {}), ...(typeof input.after === 'string' ? { after: input.after } : {}) }] };
      });
    },
  },
  {
    name: 'edit_split_clip',
    title: 'Split a clip',
    description: 'Cut one clip in two at a moment on the film (at, seconds). The halves meet exactly, as the timeline\'s own split does; the right half is named after the left (<id>-b). A clip with no written end needs the preview to have placed it once (its length), else the split cannot be worked out.',
    inputSchema: jsonSchema({ clip: { type: 'string', description: 'The clip\'s id' }, at: { type: 'number', description: 'Where to cut, seconds on the film' } }, ['clip', 'at']),
    annotations: { readOnlyHint: false },
    execute: async ({ clip, at }) => {
      const id = currentProjectId();
      const sec = num(at);
      if (sec === null) return say({ error: 'at has to be seconds on the film' });
      const read = id ? await readFilm(id) : { error: 'no project is open' };
      if (!isFilmRead(read)) return say({ error: read.error });
      const at2 = read.byId.get(String(clip));
      if (!at2) return noClip(String(clip));
      if (lockOf(read, String(clip))) return lockedAnswer(String(clip));
      const speed = typeof at2.clip.speed === 'number' && at2.clip.speed > 0 ? at2.clip.speed : 1;
      const startMs = Math.round((at2.clip.at ?? 0) * 1000);
      const ownEnd = sourceEndOf(at2.clip);
      const now = await spans(id!);
      const span = now?.find((s) => s.id === clip);
      let endMs: number;
      if (ownEnd != null) endMs = startMs + Math.round(((ownEnd - (Array.isArray(at2.clip.time) ? at2.clip.time[0]! : 0)) / speed) * 1000);
      else if (span && span.end > span.at) endMs = Math.round(span.end * 1000);
      else return say({ error: `clip "${clip}" has no length yet (the preview has not placed it) — try again once it has` });
      const { splitHalves } = await import('../lib/timeline-split.ts');
      const halves = splitHalves({ startMs, endMs, speed, anchor: { trimFrom: Array.isArray(at2.clip.time) ? at2.clip.time[0]! : 0, parentStartMs: 0 } }, sec * 1000, ownEnd);
      if (!halves) return say({ error: 'the cut is not inside the clip' });
      return apply(id!, read.rev, [{ op: 'split', clip, left: halves.left, right: halves.right }]);
    },
  },
  {
    name: 'edit_trim_clip',
    title: 'Trim a clip',
    description: 'Which part of the clip\'s file plays: in (seconds into its source; 0 keeps the head) and out (seconds; left out, the rest plays to the end of its file — a still or a page without a duration has to keep both). The clip keeps its place on the film; its length changes. Locked tracks refuse.',
    inputSchema: jsonSchema({ clip: { type: 'string', description: 'The clip\'s id' }, in: { type: 'number', description: 'The source second it starts at (optional, 0 keeps the head)' }, out: { type: 'number', description: 'The source second it stops at (optional; left out, to the file\'s end where the file has one)' } }, ['clip']),
    annotations: { readOnlyHint: false },
    execute: async ({ clip, ...edges }) => {
      const id = currentProjectId();
      const read = id ? await readFilm(id) : { error: 'no project is open' };
      if (!isFilmRead(read)) return say({ error: read.error });
      const at = read.byId.get(String(clip));
      if (!at) return noClip(String(clip));
      if (lockOf(read, String(clip))) return lockedAnswer(String(clip));
      const time = Array.isArray(at.clip.time) ? [...at.clip.time as number[]] : null;
      const hasStart = num(edges.in) != null;
      const hasEnd = num(edges.out) != null;
      if (!hasStart && !hasEnd) return say({ error: 'a trim needs in or out' });
      const now = time ?? [0];
      const start = hasStart ? num(edges.in)! : now[0]!;
      /* a written end only when it had one or the caller names one: a clip without plays to its file's end */
      let end: number | undefined = time && time.length === 2 ? time[1] : undefined;
      if (hasEnd) end = num(edges.out)!;
      if (start < 0) return say({ error: 'in is a second of the file, 0 or more' });
      if (end != null && end <= start) return say({ error: 'out has to be after in' });
      const edits: unknown[] = [{ clip, prop: 'start', value: start === 0 ? null : start }];
      if (end != null) edits.push({ clip, prop: 'end', value: end });
      return apply(id!, read.rev, [{ op: 'props', edits }]);
    },
  },
  {
    name: 'edit_set_speed',
    title: 'Set a clip\'s speed',
    description: 'How fast a video or sound clip plays its source (0.1–100; 1 is normal). The clip keeps its part of the source, so its length on the film changes; the person\'s subtitles follow on their own. What comes after on its track does NOT move — make room first (move clips) if the change would run into one.',
    inputSchema: jsonSchema({ clip: { type: 'string', description: 'The clip\'s id' }, speed: { type: 'number', description: '0.1 to 100; 1 is normal' } }, ['clip', 'speed']),
    annotations: { readOnlyHint: false },
    execute: async ({ clip, speed }) => {
      const id = currentProjectId();
      const v = num(speed);
      /* refused here, not at the file: applyOps would take 0 and the film would not read back */
      if (v === null || v < 0.1 || v > 100) return say({ error: 'speed has to be a number from 0.1 to 100' });
      return planned(id, (read) => {
        if (!read.byId.has(String(clip))) return { error: `no such clip: ${clip}` };
        if (lockOf(read, String(clip))) return { error: `clip "${clip}" is on a locked track — the person's; ask them to unlock it first` };
        return { ops: [{ op: 'props', edits: [{ clip, prop: 'speed', value: v === 1 ? null : v }] }] };
      });
    },
  },
  {
    name: 'edit_set_volume',
    title: 'Set a clip\'s volume',
    description: 'How loud a video or sound clip plays (1 = the file\'s own level; gainDb in decibels instead; muted true silences it). null or 1 puts the level back as the file has it.',
    inputSchema: jsonSchema({
      clip: { type: 'string', description: 'The clip\'s id' },
      volume: { type: 'number', description: 'The level as the file\'s own fraction (0.., 1 = own); optional' },
      gainDb: { type: 'number', description: 'The level in dB (0 = own); optional' },
      muted: { type: 'boolean', description: 'Silence it (volume 0); optional' },
    }, ['clip']),
    annotations: { readOnlyHint: false },
    execute: async ({ clip, volume, gainDb, muted }) => {
      const id = currentProjectId();
      const hasAny = num(volume) != null || num(gainDb) != null || typeof muted === 'boolean';
      if (!hasAny) return say({ error: 'a volume needs volume, gainDb or muted' });
      if (num(volume) != null && num(gainDb) != null) return say({ error: 'name volume or gainDb, not both' });
      return planned(id, (read) => {
        if (!read.byId.has(String(clip))) return { error: `no such clip: ${clip}` };
        if (lockOf(read, String(clip))) return { error: `clip "${clip}" is on a locked track — the person's; ask them to unlock it first` };
        const edits: unknown[] = [];
        if (muted === true) edits.push({ clip, prop: 'volume', value: 0 });
        else if (muted === false && num(volume) == null && num(gainDb) == null) edits.push({ clip, prop: 'volume', value: null });
        else if (num(volume) != null) edits.push({ clip, prop: 'volume', value: num(volume)! });
        else if (num(gainDb) != null) edits.push({ clip, prop: 'gainDb', value: num(gainDb)! });
        return { ops: [{ op: 'props', edits }] };
      });
    },
  },
  {
    name: 'edit_set_box',
    title: 'Set a clip\'s place and size',
    description: 'Where a picture (video, page, still) sits on the film\'s frame: left, top in px from the top-left, width and height in px (with one of them alone the other follows the picture\'s proportions; none = the frame), rotate in degrees clockwise. A sound has none.',
    inputSchema: jsonSchema({
      clip: { type: 'string', description: 'The clip\'s id' },
      left: { type: 'number', description: 'px from the frame\'s left (optional)' },
      top: { type: 'number', description: 'px from the frame\'s top (optional)' },
      width: { type: 'number', description: 'px (optional)' },
      height: { type: 'number', description: 'px (optional)' },
      rotate: { type: 'number', description: 'degrees, clockwise (optional)' },
      reset: { type: 'boolean', description: 'true: take the box off — the clip plays whole in the frame (optional)' },
    }, ['clip']),
    annotations: { readOnlyHint: false },
    execute: async ({ clip, left, top, width, height, rotate, reset }) => {
      const id = currentProjectId();
      return planned(id, (read) => {
        if (!read.byId.has(String(clip))) return { error: `no such clip: ${clip}` };
        if (lockOf(read, String(clip))) return { error: `clip "${clip}" is on a locked track — the person's; ask them to unlock it first` };
        if (reset === true) return { ops: [{ op: 'props', edits: [{ clip, prop: 'box', value: null }] }] };
        const was = (read.byId.get(String(clip))!.clip.box ?? {}) as Record<string, number>;
        const box: Record<string, number> = {};
        const x = num(left) ?? num(was.x);
        const y = num(top) ?? num(was.y);
        if (x == null || y == null) return { error: 'the clip has no place yet — give left and top' };
        box.x = x; box.y = y;
        const w = num(width) ?? num(was.w);
        const h = num(height) ?? num(was.h);
        if (w != null && w <= 0) return { error: 'width has to be px above 0' };
        if (h != null && h <= 0) return { error: 'height has to be px above 0' };
        if (w != null) box.w = w;
        if (h != null) box.h = h;
        const r = num(rotate);
        if (r != null) box.r = r;
        return { ops: [{ op: 'props', edits: [{ clip, prop: 'box', value: box }] }] };
      });
    },
  },
  {
    name: 'edit_set_props',
    title: 'Set clip properties (batch)',
    description: 'One batch of clip fields, each by clip id — the timeline\'s own property vocabulary: at, start, end, volume, gainDb, speed, box, size, overrides, link, fade, track, trackOrder, locked, hidden, muted. null takes a field off. Fields the editor does not set by hand are refused (they are the file\'s).',
    inputSchema: jsonSchema({
      edits: {
        type: 'array',
        description: 'The changes, in order (each: clip, prop, value)',
        items: {
          type: 'object',
          properties: {
            clip: { type: 'string' },
            prop: { type: 'string', enum: ['at', 'start', 'end', 'volume', 'gainDb', 'speed', 'box', 'size', 'overrides', 'link', 'fade', 'track', 'trackOrder', 'locked', 'hidden', 'muted'] },
            value: {},
          },
          required: ['clip', 'prop'],
          additionalProperties: false,
        },
      },
    }, ['edits']),
    annotations: { readOnlyHint: false },
    execute: async ({ edits }) => {
      const id = currentProjectId();
      if (!Array.isArray(edits) || !edits.length) return say({ error: 'props needs edits' });
      for (const e of edits as Array<{ clip?: unknown; prop?: unknown }>) {
        if (typeof e.clip !== 'string' || typeof e.prop !== 'string') return say({ error: 'each edit names a clip and a prop' });
      }
      return planned(id, (read) => {
        for (const e of edits as Array<{ clip: string; prop: string }>) {
          if (!read.byId.has(e.clip)) return { error: `no such clip: ${e.clip}` };
          if (!['locked', 'hidden', 'muted', 'trackOrder'].includes(e.prop) && lockOf(read, e.clip)) {
            return { error: `clip "${e.clip}" is on a locked track — the person's; ask them to unlock it first` };
          }
        }
        return { ops: [{ op: 'props', edits }] };
      });
    },
  },
  {
    name: 'edit_set_track',
    title: 'Set a track\'s flag',
    description: 'Lock (the person\'s — nothing on it changes), hide (it shows and plays nothing), or mute (it plays no sound) a track. track is 1-based, as film.html numbers its sections top-first.',
    inputSchema: jsonSchema({
      track: { type: 'integer', description: 'The track, 1-based (top section = 1)' },
      field: { type: 'string', enum: ['locked', 'hidden', 'muted'] },
      value: { type: 'boolean' },
    }, ['track', 'field', 'value']),
    annotations: { readOnlyHint: false },
    execute: async ({ track, field, value }) => {
      const id = currentProjectId();
      const t = num(track);
      if (t === null || t < 1) return say({ error: 'track is 1-based: the film\'s top section is 1' });
      if (typeof value !== 'boolean') return say({ error: 'value has to be true or false' });
      return planned(id, (read) => {
        if (t > read.doc.tracks.length) return { error: `no track ${t}: the film has ${read.doc.tracks.length}` };
        return { ops: [{ op: 'track', track: t - 1, field, value }] };
      });
    },
  },
  {
    name: 'edit_reorder_tracks',
    title: 'Reorder tracks',
    description: 'Move one track to another place. The first section is the top of the film; pictures drawn on it cover the ones below. 1-based.',
    inputSchema: jsonSchema({ from: { type: 'integer', description: 'The track to move, 1-based' }, to: { type: 'integer', description: 'Where it goes, 1-based' } }, ['from', 'to']),
    annotations: { readOnlyHint: false },
    execute: async ({ from, to }) => {
      const id = currentProjectId();
      const f = num(from); const t = num(to);
      if (f === null || f < 1 || t === null || t < 1) return say({ error: 'from and to are 1-based track places' });
      return planned(id, (read) => {
        if (f > read.doc.tracks.length || t > read.doc.tracks.length) return { error: `the film has ${read.doc.tracks.length} tracks` };
        return { ops: [{ op: 'reorder', from: f - 1, to: t - 1 }] };
      });
    },
  },
  {
    name: 'edit_set_stage',
    title: 'Set the film\'s frame',
    description: 'The film\'s canvas in whole px, up to 8192. What is on it keeps its place; the picture\'s own fit changes (a page without a size of its own is laid out for the new frame).',
    inputSchema: jsonSchema({ w: { type: 'integer', description: 'Width px' }, h: { type: 'integer', description: 'Height px' } }, ['w', 'h']),
    annotations: { readOnlyHint: false },
    execute: async ({ w, h }) => {
      const id = currentProjectId();
      const W = num(w); const H = num(h);
      if (W === null || H === null || !Number.isInteger(W) || !Number.isInteger(H) || W < 1 || H < 1 || W > 8192 || H > 8192) {
        return say({ error: 'a stage is whole pixels, up to 8192' });
      }
      return planned(id, () => ({ ops: [{ op: 'stage', w: W, h: H }] }));
    },
  },
  {
    name: 'edit_restore_overrides',
    title: 'Restore a clip\'s person-made changes',
    description: 'Take the person\'s override layer off one clip (their fades, their tweaks of a page\'s elements) — back to the clip as the file itself says it. Destructive: their changes are not kept anywhere else; the caller\'s guardrail should confirm with the person.',
    inputSchema: jsonSchema({ clip: { type: 'string', description: 'The clip\'s id' } }, ['clip']),
    annotations: { readOnlyHint: false, consequentialHint: true },
    execute: async ({ clip }) => {
      const id = currentProjectId();
      return planned(id, (read) => {
        const at = read.byId.get(String(clip));
        if (!at) return { error: `no such clip: ${clip}` };
        if (lockOf(read, String(clip))) return { error: `clip "${clip}" is on a locked track — the person's; ask them to unlock it first` };
        if (!at.clip.overrides?.length) return { error: `clip "${clip}" has no overrides to restore` };
        return { ops: [{ op: 'set', clip, field: 'overrides', value: null }] };
      });
    },
  },
  {
    name: 'edit_write_page',
    title: 'Write a page of the project',
    description: 'Write a project file whole (a page: title.html; a text side: notes.md). This REPLACES the file — read it first (film_state does not show pages; the project\'s files are read with read_page below), and pass expect: the text you read, so a write that would cover someone else\'s change is refused. Destructive.',
    inputSchema: jsonSchema({
      path: { type: 'string', description: 'The file, project-relative ("title.html"; film.html itself is NOT written here — edit verbs shape it)' },
      text: { type: 'string', description: 'The file\'s whole new text' },
      expect: { type: 'string', description: 'What you read last (refused when the file is not still that); empty = only when there is no file yet' },
    }, ['path', 'text']),
    annotations: { readOnlyHint: false, consequentialHint: true },
    execute: async ({ path, text, expect }) => {
      const id = currentProjectId();
      if (!id) return say({ error: 'no project is open' });
      if (typeof path !== 'string' || !path || path === 'film.html' || path.includes('..') || path.startsWith('/')) {
        return say({ error: 'path is a project-relative file (film.html itself is not written here)' });
      }
      if (typeof text !== 'string') return say({ error: 'text is the file\'s whole content' });
      try {
        const apiNow = await api();
        const was = await apiNow.readPage(id, path).catch((e: unknown) => {
          const status = (e as { status?: number }).status;
          if (status === 404) return null;
          throw e;
        });
        const expectGiven = typeof expect === 'string';
        if (was && expectGiven && was.text !== expect) return say({ error: 'the file changed since you read it (expect mismatch) — read it again' });
        if (was && !expectGiven) return say({ error: 'read the existing page and supply expect before replacing it' });
        if (!was && expectGiven && expect !== '') return say({ error: 'expect was given but the file is not there — read the project\'s files first' });
        const rev = await apiNow.writePage(id, path, text, was ? was.rev : null);
        return say({ ok: true, path, rev });
      } catch (e) { return fail(e); }
    },
  },
  {
    name: 'edit_read_page',
    title: 'Read a page of the project',
    description: 'A project file as text (a page: title.html; a side file), with the rev a write_page\'s expect takes. film.html itself is read through film_state.',
    inputSchema: jsonSchema({ path: { type: 'string', description: 'The file, project-relative' } }, ['path']),
    annotations: { readOnlyHint: true },
    execute: async ({ path }) => {
      const id = currentProjectId();
      if (!id) return say({ error: 'no project is open' });
      if (typeof path !== 'string' || !path || path.includes('..') || path.startsWith('/')) return say({ error: 'path is a project-relative file' });
      try {
        if (path === 'film.html') {
          const film = await (await api()).film(id);
          return say({ path, rev: film.rev, text: film.text });
        }
        const page = await (await api()).readPage(id, path);
        return say({ path, rev: page.rev, text: page.text });
      } catch (e) { return fail(e); }
    },
  },
  // ── the version layer, beside the verbs (T07: 编辑层操作同层级暴露) ──
  {
    name: 'edit_list_versions',
    title: 'List versions',
    description: 'The project\'s saved versions, newest first, with which one is head and whether the working copy differs from it. Read-only.',
    inputSchema: jsonSchema({}),
    annotations: { readOnlyHint: true },
    execute: async () => {
      const id = currentProjectId();
      if (!id) return say({ error: 'no project is open' });
      await settled(id);
      const history = await (await historyApiModule()).load(id);
      if (!history) return say({ error: 'the project has no history' });
      return say({
        head: history.status.head,
        workingDiffers: history.status.changes != null,
        versions: history.versions.slice(0, 50).map((v) => ({ commit: v.commit, name: v.name, at: v.at, kind: v.kind })),
        more: history.more,
      });
    },
  },
  {
    name: 'edit_save_version',
    title: 'Save a version',
    description: 'Freeze the working copy as a named version. An empty message gets the panel\'s own name. Saving does not check the film out — the working copy goes on.',
    inputSchema: jsonSchema({ message: { type: 'string', description: 'The version\'s name (optional)' } }),
    annotations: { readOnlyHint: false },
    execute: async ({ message }) => {
      const id = currentProjectId();
      if (!id) return say({ error: 'no project is open' });
      await settled(id);
      try {
        const done = await (await historyApiModule()).save(id, typeof message === 'string' ? message : '');
        if (!done.ok) return say({ error: 'the save was refused' });
        return say({ ok: true, commit: done.body.commit });
      } catch (e) { return fail(e); }
    },
  },
  {
    name: 'edit_checkout_version',
    title: 'Check a version out',
    description: 'Put the working files back as a saved version holds them — the film, the pages, the assets, all of it. Refused while the working copy differs from head (pass discard to throw those changes away — destructive). The person\'s undo history does not reach across a checkout.',
    inputSchema: jsonSchema({
      commit: { type: 'string', description: 'The version to check out (edit_list_versions lists them; empty = head)' },
      discard: { type: 'boolean', description: 'Throw the working copy\'s changes away first (destructive)' },
    }),
    annotations: { readOnlyHint: false, consequentialHint: true },
    execute: async ({ commit, discard }) => {
      const id = currentProjectId();
      if (!id) return say({ error: 'no project is open' });
      await settled(id);
      const historyApi = await historyApiModule();
      const history = await historyApi.load(id);
      const differs = history?.status.changes != null;
      if (differs && discard !== true) return say({ error: 'the working copy has changes — save them (edit_save_version) or throw them away (discard: true)', workingDiffers: true });
      const head = history?.status.head ?? '';
      const want = typeof commit === 'string' && commit ? commit : head;
      if (!want) return say({ error: 'the project has no versions yet' });
      if (!history?.versions.some((v) => v.commit === want)) return say({ error: `no such version: ${want}` });
      const result = await historyApi.checkout(id, want, discard === true);
      if (!result.ok) return say({ error: result.code === 'dirty' ? 'the working copy has changes — save or discard them first' : 'the checkout was refused' });
      return say({ ok: true, commit: result.body.commit, ...(result.body.missing?.length ? { missing: result.body.missing } : {}) });
    },
  },
  {
    name: 'edit_discard_changes',
    title: 'Discard the working copy',
    description: 'Throw the working copy\'s changes away — everything since the last save, gone (back to head, or to an empty film before the first version). Destructive.',
    inputSchema: jsonSchema({}),
    annotations: { readOnlyHint: false, consequentialHint: true },
    execute: async () => {
      const id = currentProjectId();
      if (!id) return say({ error: 'no project is open' });
      await settled(id);
      try {
        const result = await (await historyApiModule()).discard(id);
        return result.ok ? say({ ok: true }) : say({ error: 'the discard was refused' });
      } catch (e) { return fail(e); }
    },
  },
  {
    name: 'edit_copy_version',
    title: 'Copy a version to a new project',
    description: 'A saved version\'s snapshot as its own new project (named). The working copy is not touched.',
    inputSchema: jsonSchema({ commit: { type: 'string', description: 'The version to copy (empty = head)' }, name: { type: 'string', description: 'The new project\'s name' } }, ['name']),
    annotations: { readOnlyHint: false },
    execute: async ({ commit, name }) => {
      const id = currentProjectId();
      if (!id) return say({ error: 'no project is open' });
      if (typeof name !== 'string' || !name.trim()) return say({ error: 'the copy needs a name' });
      await settled(id);
      const historyApi = await historyApiModule();
      const history = await historyApi.load(id);
      const want = typeof commit === 'string' && commit ? commit : history?.status.head ?? '';
      if (!want) return say({ error: 'the project has no versions yet' });
      if (!history?.versions.some((v) => v.commit === want)) return say({ error: `no such version: ${want}` });
      const result = await historyApi.copy(id, want, name.trim());
      if (!result.ok) return say({ error: 'the copy was refused' });
      const project = result.body.project as { id: string; name: string };
      return say({ ok: true, project });
    },
  },
];
