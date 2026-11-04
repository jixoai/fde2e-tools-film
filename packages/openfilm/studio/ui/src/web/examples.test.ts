import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBundledExampleIndex, parseBundledExampleManifest, parseLocalExamplePath } from './examples.ts';

const commit = '65d717b7ba27b9e665dc6bb6e8e3b6579048288d';
const index = {
  format: 1,
  examples: [{
    id: 'one-prompt', title: 'One Prompt', description: 'Code-drawn film', poster: '/examples/one-prompt/look.jpg', video: null,
    duration: 90.9, category: 'music', segments: [], url: `https://github.com/openfilm/examples/tree/${commit}/one-prompt`,
    manifest: '/examples/one-prompt/manifest.json',
  }],
};
const required = [
  'film.html', 'LICENSE', 'CREDITS.md', 'UPSTREAM_CREDITS.md', 'THIRD_PARTY_NOTICES.md', 'EXAMPLE-METADATA.json',
  'assets/fonts/OFL.txt', 'src/px/LICENSE-pdoom-video.txt', 'vendor/three/LICENSE',
  'vendor/three/three.module.js', 'vendor/three/three.core.js', 'vendor/three/addons/loaders/FontLoader.js',
];
const manifest = {
  format: 1, id: 'one-prompt', name: 'One Prompt',
  source: { repository: 'https://github.com/openfilm/examples', commit, folder: 'one-prompt' },
  files: required.map((path) => ({ path, size: 1, sha256: 'a'.repeat(64) })),
};

test('bundled example index accepts only same-origin paths and unique safe ids', () => {
  assert.equal(parseBundledExampleIndex(index)[0]?.id, 'one-prompt');
  assert.throws(() => parseBundledExampleIndex({ ...index, examples: [index.examples[0], index.examples[0]] }), /repeated/);
  assert.throws(() => parseBundledExampleIndex({ ...index, examples: [{ ...index.examples[0], manifest: 'https://evil.test/x' }] }), /not a local/);
  assert.throws(() => parseBundledExampleIndex({ ...index, examples: [{ ...index.examples[0], poster: '/examples/one-prompt/../escape.jpg' }] }), /traversal/);
  assert.throws(() => parseBundledExampleIndex({ ...index, examples: [{ ...index.examples[0], poster: '/examples/one-prompt/%2e%2e/escape.jpg' }] }), /traversal/);
  assert.throws(() => parseBundledExampleIndex({ ...index, examples: [{ ...index.examples[0], video: 'https://cdn.example/video.mp4' }] }), /not a local/);
});

test('local example paths reject absolute URLs, encoded separators and query/fragment escapes', () => {
  assert.equal(parseLocalExamplePath('/examples/one-prompt/look.jpg'), '/examples/one-prompt/look.jpg');
  for (const path of [
    'https://evil.test/examples/x', '/examples/../x', '/examples/%2e%2e/x',
    '/examples/one/%2Fescape', '/examples/one/x?remote=1', '/examples/one/x#remote',
  ]) assert.throws(() => parseLocalExamplePath(path), /local|traversal/);
});

test('bundled example manifest requires pinned provenance, notices, safe paths and sha256', () => {
  const parsed = parseBundledExampleManifest(manifest, 'one-prompt');
  assert.equal(parsed.files.length, required.length);
  assert.throws(() => parseBundledExampleManifest({ ...manifest, files: manifest.files.filter((file) => file.path !== 'assets/fonts/OFL.txt') }, 'one-prompt'), /missing assets\/fonts\/OFL/);
  assert.throws(() => parseBundledExampleManifest({ ...manifest, files: [{ path: '../escape', size: 1, sha256: 'a'.repeat(64) }] }, 'one-prompt'), /invalid file entry/);
  assert.throws(() => parseBundledExampleManifest({ ...manifest, id: 'other' }, 'one-prompt'), /manifest is invalid/);
  assert.throws(() => parseBundledExampleManifest({ ...manifest, source: { ...manifest.source, commit: 'floating' } }, 'one-prompt'), /manifest is invalid/);
  assert.throws(() => parseBundledExampleManifest({ ...manifest, source: { ...manifest.source, repository: 'https://evil.test/repo' } }, 'one-prompt'), /manifest is invalid/);
});
