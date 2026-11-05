#!/usr/bin/env node
/**
 * Make the bundled Web examples self-contained and emit their checksum manifests.
 *
 * Source films live in studio/ui/public/examples/<id>. Third-party runtime bytes are copied from
 * lockfile-pinned node_modules at build/dev time; generated vendor directories and manifests are
 * ignored by Git. The browser loader verifies every sha256 before it creates an OPFS project.
 */
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const examplesRoot = join(root, 'studio', 'ui', 'public', 'examples');
const exampleRoot = join(examplesRoot, 'one-prompt');
const threeRoot = join(root, 'node_modules', 'three');
const vendorRoot = join(exampleRoot, 'vendor', 'three');
const check = process.argv.includes('--check');

const vendorFiles = [
  [join(threeRoot, 'build', 'three.module.js'), join(vendorRoot, 'three.module.js')],
  [join(threeRoot, 'build', 'three.core.js'), join(vendorRoot, 'three.core.js')],
  [join(threeRoot, 'examples', 'jsm', 'loaders', 'FontLoader.js'), join(vendorRoot, 'addons', 'loaders', 'FontLoader.js')],
  [join(threeRoot, 'LICENSE'), join(vendorRoot, 'LICENSE')],
];
const copy = (from, to) => { mkdirSync(dirname(to), { recursive: true }); copyFileSync(from, to); };
if (!check) {
  rmSync(vendorRoot, { recursive: true, force: true });
  for (const [from, to] of vendorFiles) copy(from, to);
} else {
  for (const [from, to] of vendorFiles) {
    if (!readFileSync(from).equals(readFileSync(to))) throw new Error(`${to} drifted from lockfile-pinned three; run pnpm vendor-examples`);
  }
}

const posix = (p) => p.split(sep).join('/');
const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
  const full = join(dir, entry.name);
  if (entry.isDirectory()) return walk(full);
  if (!entry.isFile()) return [];
  const rel = posix(relative(exampleRoot, full));
  if (rel === 'manifest.json') return [];
  const bytes = readFileSync(full);
  return [{ path: rel, size: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex') }];
}).sort((a, b) => a.path.localeCompare(b.path));

const files = walk(exampleRoot);
const manifest = {
  format: 1,
  id: 'one-prompt',
  name: 'One Prompt — FDE2E edition',
  source: {
    repository: 'https://github.com/openfilm/examples',
    commit: '65d717b7ba27b9e665dc6bb6e8e3b6579048288d',
    folder: 'one-prompt',
  },
  files,
};
const index = {
  format: 1,
  examples: [{
    id: manifest.id,
    title: manifest.name,
    description: 'A 90-second code-drawn lyric film. three.js is self-hosted; notices and AI-music provenance travel with the project.',
    poster: '/examples/one-prompt/look.jpg',
    video: null,
    duration: 90.9,
    category: 'music',
    segments: [],
    url: 'https://github.com/openfilm/examples/tree/65d717b7ba27b9e665dc6bb6e8e3b6579048288d/one-prompt',
    manifest: '/examples/one-prompt/manifest.json',
  }],
};
const serialized = new Map([
  [join(exampleRoot, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`],
  [join(examplesRoot, 'examples.json'), `${JSON.stringify(index, null, 2)}\n`],
]);
for (const [file, text] of serialized) {
  if (check) {
    if (readFileSync(file, 'utf8') !== text) throw new Error(`${file} drifted; run pnpm vendor-examples`);
  } else {
    writeFileSync(file, text);
  }
}

const required = new Set([
  'LICENSE', 'CREDITS.md', 'UPSTREAM_CREDITS.md', 'THIRD_PARTY_NOTICES.md', 'EXAMPLE-METADATA.json',
  'assets/fonts/OFL.txt', 'src/px/LICENSE-pdoom-video.txt', 'vendor/three/LICENSE',
  'vendor/three/three.module.js', 'vendor/three/three.core.js', 'vendor/three/addons/loaders/FontLoader.js',
]);
for (const name of required) if (!files.some((file) => file.path === name)) throw new Error(`example is missing ${name}`);
/* One Prompt has eight WebGL page clips. Their exact lengths are known by the edit, so keep the
   #t ranges in film.html instead of forcing a fresh editor preview to initialize all eight page
   runtimes merely to discover duration. This is both protocol truth and the first-load timeout
   guard for production hardware. */
const exampleFilm = readFileSync(join(exampleRoot, 'film.html'), 'utf8');
const pageSources = [...exampleFilm.matchAll(/<iframe\b[^>]*\bsrc=["']([^"']+)["']/gi)].map((match) => match[1]);
if (!pageSources.length || pageSources.some((src) => !/#t=0,\d+(?:\.\d+)?$/.test(src))) {
  throw new Error('one-prompt page clips must carry explicit #t=0,duration ranges');
}
const runtimeText = files.filter((file) => /\.(?:html|js|css)$/i.test(file.path) && !file.path.startsWith('vendor/three/'));
const executableText = (file) => readFileSync(join(exampleRoot, file.path), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')
  .replace(/<!--[\s\S]*?-->/g, '');
const remoteRuntime = runtimeText.filter((file) => /https?:\/\//i.test(executableText(file)));
if (remoteRuntime.length) throw new Error(`runtime remote URL remains in ${remoteRuntime.map((file) => file.path).join(', ')}`);
if (files.some((file) => file.path === 'src/plates/brand.js')) throw new Error('the upstream trademark geometry is still bundled');
const endPlate = readFileSync(join(exampleRoot, 'src', 'plates', 'brandout.js'), 'utf8');
if (!endPlate.includes("fillText('FDE2E'") || /openfilm\.(?:dev|com)|OpenFilm's logo/i.test(endPlate)) {
  throw new Error('the FDE2E end-plate adaptation is missing or still branded upstream');
}
console.log(`vendor-examples: one-prompt ${files.length} files / ${files.reduce((n, f) => n + f.size, 0)} bytes (three ${JSON.parse(readFileSync(join(threeRoot, 'package.json'), 'utf8')).version})${check ? ' — check ok' : ''}`);
