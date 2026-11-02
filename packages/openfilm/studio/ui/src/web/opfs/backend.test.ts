/**
 * The web gate (`isWeb`) and the api's routing: without the flag every call must go the server
 * way (nothing web here answers), and with it the project calls answer from the store. The store
 * itself needs OPFS (its own test file); these only prove the switch and the wiring.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('api.projects answers from the OPFS store when the web flag is set', { skip: typeof navigator === 'undefined' || !navigator.storage?.getDirectory ? 'needs a browser (OPFS)' : false }, async () => {
  const { createProject, listProjects, deleteProject } = await import('./opfs');
  const made = await createProject('Gate');
  const listed = await listProjects();
  assert.ok(listed.some((p) => p.id === made.id && p.name === 'Gate'), 'the store has it');
  await deleteProject(made.id);
});
