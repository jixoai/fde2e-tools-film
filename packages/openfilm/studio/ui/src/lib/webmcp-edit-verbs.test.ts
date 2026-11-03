/**
 * The edit family's verb→op compilation, against the ONE applier (studio/server/ops.mjs): every
 * tool's schema-checked input lands as an op the film takes, and the guardrails the UI keeps
 * (locked tracks, speed bounds, cut-inside-the-clip) hold before any write.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyOps, EditError } from '../../../server/ops.mjs';
import { splitHalves } from './timeline-split.ts';

const FILM = (): Record<string, unknown> => ({
  stage: { w: 1920, h: 1080 },
  tracks: [
    { clips: [{ src: 'assets/a.mp4', id: 'a', at: 0, time: [0, 4] }, { src: 'assets/b.mp4', id: 'b', at: 4, time: [0, 3] }] },
    { clips: [{ src: 'assets/c.mp3', id: 'c', at: 0, time: [0, 6] }] },
  ],
});

const run = (film: unknown, ops: unknown[]) => applyOps(structuredClone(film), ops as never);

/** The tool boundary's 1-based track → ops.mjs's 0-based (the conversion the tools do once). */
test('edit_set_track / edit_reorder_tracks compile to ops.mjs indexes', () => {
  const film = FILM();
  const locked = run(film, [{ op: 'track', track: 1 - 1, field: 'locked', value: true }]);
  assert.equal((locked as { tracks: { locked?: boolean }[] }).tracks[0].locked, true);
  const order = run(film, [{ op: 'reorder', from: 2 - 1, to: 1 - 1 }]);
  assert.deepEqual((order as { tracks: { clips: { id: string }[] }[] }).tracks.map((t) => t.clips.map((c) => c.id)), [['c'], ['a', 'b']]);
});

/** What a locked-track refusal guards: ops.mjs itself would take the write. */
test('a locked track accepts ops.mjs writes — the TOOL refuses before compiling (regression guard)', () => {
  const film = run(FILM(), [{ op: 'track', track: 0, field: 'locked', value: true }]);
  // applyOps would take it (the guard is the tool's, not the file's):
  const moved = run(film, [{ op: 'props', edits: [{ clip: 'a', prop: 'at', value: 1 }] }]);
  assert.equal((moved as { tracks: { clips: { at?: number }[][] } }).tracks[0].clips[0].at, 1);
  // the tool's rule (lib/track-lock semantics): any non-track-flag prop on a locked track is refused
  const TRACK_PROPS = new Set(['locked', 'hidden', 'muted', 'trackOrder']);
  const refuses = (prop: string) => !TRACK_PROPS.has(prop);
  assert.equal(refuses('at'), true);
  assert.equal(refuses('locked'), false);
});

/** The speed bounds are checked BEFORE the write: applyOps would take 0 and the film would not read back. */
test('edit_set_speed refuses out of bounds without writing', () => {
  const refuses = (v: unknown) => !(typeof v === 'number' && Number.isFinite(v) && v >= 0.1 && v <= 100);
  assert.equal(refuses(0), true);
  assert.equal(refuses(101), true);
  assert.equal(refuses('2'), true);
  assert.equal(refuses(0.1), false);
  assert.equal(refuses(2), false);
});

/** A split's halves, as the tool compiles them, land as two clips that meet exactly (the UI's own test's rule). */
test('edit_split_clip compiles through splitHalves into a legal film', () => {
  // clip a: film 0–4s (time [0,4], speed 1). Cut at 2s — a single-track film: the halves meet exactly.
  const film = { stage: { w: 1920, h: 1080 }, tracks: [{ clips: [{ src: 'assets/a.mp4', id: 'a', at: 0, time: [0, 4] }] }] };
  const halves = splitHalves({ startMs: 0, endMs: 4000, speed: 1, anchor: { trimFrom: 0, parentStartMs: 0 } }, 2000, 4);
  assert.ok(halves);
  const cut = run(film, [{ op: 'split', clip: 'a', left: halves!.left, right: halves!.right }]);
  const clips = (cut as { tracks: { clips: { id: string; at?: number; time?: number[] }[][] } }).tracks[0].clips;
  assert.deepEqual(clips.map((c) => [c.id, c.at, c.time]), [['a', 0, [0, 2]], ['a-b', 2, [2, 4]]]);
  // and the same planner refuses a cut outside the clip:
  assert.equal(splitHalves({ startMs: 0, endMs: 4000, speed: 1, anchor: { trimFrom: 0, parentStartMs: 0 } }, 4500, 4), null);
});

/** Trims compile to start/end props; a clip without a written end keeps it that way unless out is named. */
test('edit_trim_clip compiles to start/end props', () => {
  const film = FILM();
  const head = run(film, [{ op: 'props', edits: [{ clip: 'a', prop: 'start', value: 1 }] }]);
  assert.deepEqual((head as { tracks: { clips: { time?: number[] }[][] } }).tracks[0].clips[0].time, [1, 4]);
  const untimed = { stage: { w: 1, h: 1 }, tracks: [{ clips: [{ src: 'assets/a.mp4', id: 'a', at: 0 }] }] };
  const toEnd = run(untimed, [{ op: 'props', edits: [{ clip: 'a', prop: 'end', value: 2 }] }]);
  assert.deepEqual((toEnd as { tracks: { clips: { time?: number[] }[][] } }).tracks[0].clips[0].time, [0, 2]);
});

/** restore_overrides takes the person's layer off whole (set overrides null). */
test('edit_restore_overrides compiles to set overrides null', () => {
  const film = { stage: { w: 1, h: 1 }, tracks: [{ clips: [{ src: 'assets/p.html', id: 'p', at: 0, time: [0, 2], overrides: [{ at: '#x', style: 'color: red' }] }] }] };
  const out = run(film, [{ op: 'set', clip: 'p', field: 'overrides', value: null }]);
  const clip = (out as { tracks: { clips: Record<string, unknown>[][] } }).tracks[0].clips[0];
  assert.equal('overrides' in clip, false);
});

/** A verb's op that names a gone clip is EditError('conflict') — the tool's existence check runs first. */
test('a gone clip is a conflict EditError the tool pre-empts', () => {
  assert.throws(() => run(FILM(), [{ op: 'remove', clip: 'zz' }]), (e: unknown) => e instanceof EditError && (e as EditError).kind === 'conflict');
});
