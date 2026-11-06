/**
 * Emits the film's in-page runtime as static files the web face serves verbatim
 * (vite copies `public/`): the timeline modules plus Studio's bridge/stage templates. The OPFS
 * service worker injects the latter with the current editor origin, matching studio/server/pages.mjs.
 * Run before `build:ui` and `dev`.
 */
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { HOST_FLAG } from '../../../src/host-clock.mjs';

const root = fileURLToPath(new URL('..', import.meta.url)); // studio/ui
const src = join(root, '..', '..', 'src'); // studio/ui → studio → openfilm/src
const dest = join(root, 'public', '__film');
mkdirSync(dest, { recursive: true });
writeFileSync(join(dest, 'host-flag.js'), HOST_FLAG);
for (const name of ['timeline.mjs', 'film-doc.mjs', 'overrides.mjs']) {
  copyFileSync(join(src, name), join(dest, name));
}
const server = join(root, '..', 'server');
for (const name of ['bridge.js', 'stage.js']) copyFileSync(join(server, name), join(dest, name));
console.log('emit-film-runtime: __film/ ready');
