/**
 * The WebMCP surface's shape contract: four families, guardrail annotations on the destructive
 * ones, complete JSON Schema, and the registration helper's honesty outside a browser.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { filmToolDefs } from './webmcp.ts';
import { registerWebMCPTools } from './webmcp-register.ts';

const defs = filmToolDefs(() => {});
const byName = new Map(defs.map((d) => [d.name, d]));

test('four families present with their tools', () => {
  const families = {
    inspect: ['film_state', 'film_problems', 'film_overrides'],
    edit: ['edit_apply'],
    projects: ['projects_list', 'projects_create', 'projects_open', 'projects_delete', 'projects_export_package', 'projects_load_example'],
    produce: ['produce_look', 'produce_render', 'produce_export_status'],
  };
  for (const tools of Object.values(families)) {
    for (const name of tools) assert.ok(byName.has(name), `missing tool: ${name}`);
  }
  assert.equal(defs.length, 13);
});

test('guardrail annotations: read-only where promised, consequential on delete', () => {
  for (const name of ['film_state', 'film_problems', 'film_overrides', 'projects_list', 'projects_export_package', 'produce_export_status']) {
    assert.equal(byName.get(name)?.annotations?.readOnlyHint, true, `${name} should be read-only`);
  }
  assert.equal(byName.get('projects_delete')?.annotations?.consequentialHint, true);
  assert.equal(byName.get('projects_delete')?.annotations?.readOnlyHint, false);
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
