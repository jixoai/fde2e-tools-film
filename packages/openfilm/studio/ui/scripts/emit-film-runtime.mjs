/**
 * Emits the film's in-page runtime as static files the web face serves verbatim
 * (vite copies `public/`): `__film/timeline.mjs`, `__film/film-doc.mjs`, `__film/overrides.mjs` —
 * the very files the server host served from src/ (src/host.mjs). Run before `build:ui` and `dev`.
 */
import { copyFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url)); // studio/ui
const src = join(root, '..', '..', 'src'); // studio/ui → studio → openfilm/src
const dest = join(root, 'public', '__film');
mkdirSync(dest, { recursive: true });
for (const name of ['timeline.mjs', 'film-doc.mjs', 'overrides.mjs']) {
  copyFileSync(join(src, name), join(dest, name));
}
console.log('emit-film-runtime: __film/ ready');
