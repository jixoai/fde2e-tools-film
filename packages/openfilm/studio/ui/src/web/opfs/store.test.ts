/**
 * The store against a real OPFS — run in a browser context (vitest browser mode, or the E2E
 * green-gate's page). Node has no OPFS; these skip when it is absent, so `node --test` stays
 * green on a machine without a browser harness while the E2E gate asserts the real thing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const hasOpfs = typeof navigator !== 'undefined' && Boolean(navigator.storage?.getDirectory);


test('project seeds reject traversal, reserved state and incomplete trees before touching OPFS', async () => {
  const { createProjectFromFiles } = await import('./store.ts');
  const film = { path: 'film.html', data: '<html><body><section></section></body></html>' };
  await assert.rejects(createProjectFromFiles('bad', [film, { path: '../escape', data: '' }]), /invalid or repeated/);
  await assert.rejects(createProjectFromFiles('bad', [film, { path: '.film/id', data: 'spoof' }]), /invalid or repeated/);
  await assert.rejects(createProjectFromFiles('bad', [film, film]), /invalid or repeated/);
  await assert.rejects(createProjectFromFiles('bad', [{ path: 'page.html', data: '' }]), /must include film.html/);
});

test('a new project is listed, read, written against its rev, and deleted', { skip: !hasOpfs && 'needs a browser (OPFS)' }, async () => {
  const { createProject, readFilm, writeFilm, listProjects, deleteProject } = await import('./store');
  const made = await createProject();
  const listed = await listProjects();
  if (!listed.some((p) => p.id === made.id)) throw new Error('the new project is not listed');
  const film = await readFilm(made.id);
  if (!film || !film.text.includes('window.film')) throw new Error('the first film is not the format\'s empty one');
  const next = `${film.text}\n<!-- touched -->`;
  const rev = await writeFilm(made.id, next, film.rev);
  if (!rev) throw new Error('a matching rev was refused');
  const stale = await writeFilm(made.id, `${next}\n<!-- stale -->`, film.rev);
  if (stale !== null) throw new Error('a stale rev was taken');
  await deleteProject(made.id);
  if ((await listProjects()).some((p) => p.id === made.id)) throw new Error('the project is still listed');
});
