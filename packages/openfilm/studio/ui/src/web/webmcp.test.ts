/**
 * The WebMCP surface's shape contract: four families, guardrail annotations on the destructive
 * ones, complete JSON Schema, and the registration helper's honesty outside a browser.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { filmToolDefs } from './webmcp.ts';
import { editFamilyTools } from './webmcp-edit.ts';
import { registerWebMCPTools } from './webmcp-register.ts';

const defs = [...filmToolDefs(() => {}), ...editFamilyTools()];
const byName = new Map(defs.map((d) => [d.name, d]));

test('four families present with their tools', () => {
  const families = {
    inspect: ['film_state', 'film_problems', 'film_overrides'],
    edit: [
      'edit_apply', 'edit_move_clip', 'edit_remove_clip', 'edit_insert_clip', 'edit_split_clip',
      'edit_trim_clip', 'edit_set_speed', 'edit_set_volume', 'edit_set_box', 'edit_set_props',
      'edit_set_track', 'edit_reorder_tracks', 'edit_set_stage', 'edit_restore_overrides',
      'edit_write_page', 'edit_read_page', 'edit_list_versions', 'edit_save_version',
      'edit_checkout_version', 'edit_discard_changes', 'edit_copy_version',
    ],
    projects: ['projects_list', 'projects_list_media', 'projects_import_media', 'projects_create', 'projects_open', 'projects_delete', 'projects_export_package', 'projects_load_example'],
    produce: ['produce_look', 'produce_render', 'produce_export_status'],
  };
  for (const tools of Object.values(families)) {
    for (const name of tools) assert.ok(byName.has(name), `missing tool: ${name}`);
  }
  assert.equal(defs.length, 35); // 15 four-family tools + 20 edit-family verbs
});

test('guardrail annotations: read-only where promised, consequential on delete', () => {
  for (const name of ['film_state', 'film_problems', 'film_overrides', 'projects_list', 'projects_list_media', 'projects_export_package', 'produce_export_status']) {
    assert.equal(byName.get(name)?.annotations?.readOnlyHint, true, `${name} should be read-only`);
  }
  for (const name of ['produce_look', 'produce_render']) {
    assert.equal(byName.get(name)?.annotations?.readOnlyHint, false, `${name} creates an export artifact`);
  }
  assert.equal(byName.get('projects_delete')?.annotations?.consequentialHint, true);
  assert.equal(byName.get('projects_delete')?.annotations?.readOnlyHint, false);
  assert.equal(byName.get('projects_load_example')?.annotations?.readOnlyHint, false);
  assert.equal(byName.get('projects_import_media')?.annotations?.readOnlyHint, false);
  assert.equal(byName.get('projects_import_media')?.annotations?.untrustedContentHint, true);
  assert.equal(byName.get('edit_apply')?.annotations?.readOnlyHint, false);
});

test('every def has a complete JSON Schema object', () => {
  for (const def of defs) {
    assert.equal(def.inputSchema.type, 'object');
    assert.equal(def.inputSchema.additionalProperties, false);
    assert.ok(typeof def.inputSchema.properties === 'object');
    assert.ok(def.description.length > 20, `${def.name} needs a real description`);
  }
});

test('edit family guardrails: consequential on the destructive verbs, read-only on reads', () => {
  for (const name of ['edit_restore_overrides', 'edit_write_page', 'edit_checkout_version', 'edit_discard_changes']) {
    assert.equal(byName.get(name)?.annotations?.consequentialHint, true, `${name} should be consequential`);
    assert.equal(byName.get(name)?.annotations?.readOnlyHint, false);
  }
  assert.equal(byName.get('edit_read_page')?.annotations?.readOnlyHint, true);
  assert.equal(byName.get('edit_list_versions')?.annotations?.readOnlyHint, true);
  assert.equal(byName.get('edit_move_clip')?.annotations?.readOnlyHint, false);
});

test('edit schemas are complete JSON Schema objects', () => {
  for (const name of ['edit_move_clip', 'edit_split_clip', 'edit_set_speed', 'edit_set_track', 'edit_write_page']) {
    const schema = byName.get(name)!.inputSchema as { type: string; additionalProperties: boolean; properties: Record<string, unknown> };
    assert.equal(schema.type, 'object');
    assert.equal(schema.additionalProperties, false);
    assert.ok(Object.keys(schema.properties).length > 0, `${name} names its inputs`);
  }
});

test('edit_apply requires ops as an array of objects', () => {
  const schema = byName.get('edit_apply')!.inputSchema as { required: string[]; properties: { ops: { type: string; items: { type: string } } } };
  assert.deepEqual(schema.required, ['ops']);
  assert.equal(schema.properties.ops.type, 'array');
  assert.equal(schema.properties.ops.items.type, 'object');
});

test('registration outside a browser answers supported:false (no document)', async () => {
  const result = await registerWebMCPTools(() => {});
  assert.equal(result.supported, false);
  assert.deepEqual(result.registered, []);
  assert.deepEqual(result.failures, []);
});


test('produce schemas expose executable capture and render controls', () => {
  const look = byName.get('produce_look')!.inputSchema as { properties: Record<string, unknown> };
  const render = byName.get('produce_render')!.inputSchema as { properties: Record<string, unknown> };
  assert.deepEqual(Object.keys(look.properties), ['at', 'name', 'shortEdge', 'frame', 'fill']);
  assert.ok(['kind', 'from', 'to', 'moments', 'codec', 'format', 'download', 'wait'].every((key) => key in render.properties));
  assert.match(byName.get('produce_render')!.description, /writes atomically to OPFS downloads/);
  assert.match(byName.get('produce_render')!.description, /job immediately by default/);
  assert.match((render.properties.wait as { description: string }).description, /default false/);
});

test('produce status promises the terminal encoder and progress receipt used by agents', () => {
  const status = byName.get('produce_export_status')!;
  assert.match(status.description, /jobs|任务/i);
  const source = String(status.execute);
  for (const field of ['previewReady', 'phase', 'framesDone', 'framesTotal', 'rate', 'etaMs', 'encoder', 'outputs', 'bytes']) {
    assert.match(source, new RegExp(`\\b${field}\\b`), `${field} is missing from the public status projection`);
  }
});


test('produce handlers fail closed on malformed kind, frame and fill values', async () => {
  const runtime = await import('./web-runtime.ts');
  const stop = runtime.registerWebProjectRuntime({
    projectId: 'guard-project',
    source: { seek: async () => {}, capture: async () => ({}) as HTMLCanvasElement, size: () => ({ w: 1920, h: 1080 }), duration: () => 1 },
    duration: () => 1,
    fps: () => 30,
  });
  const originalLocation = globalThis.location;
  Object.defineProperty(globalThis, 'location', { value: { pathname: '/projects/guard-project' }, configurable: true });
  try {
    for (const [name, input, word] of [
      ['produce_look', { frame: 'bogus' }, 'frame'],
      ['produce_render', { kind: 'audio' }, 'kind'],
      ['produce_render', { fill: 'stretch' }, 'fill'],
    ] as const) {
      const raw = await byName.get(name)!.execute(input, {});
      const answer = JSON.parse(raw);
      assert.match(answer.error, new RegExp(word));
    }
  } finally {
    stop();
    Object.defineProperty(globalThis, 'location', { value: originalLocation, configurable: true });
  }
});
