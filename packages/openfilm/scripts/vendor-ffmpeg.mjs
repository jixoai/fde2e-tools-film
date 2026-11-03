/**
 * Vendor the ffmpeg.wasm ST core (T08: @ffmpeg/core 0.12.10, ffmpeg 5.1.4) into the build's
 * public tree, so the site self-hosts the 31 MB wasm instead of fetching a CDN (纯静态铁律:
 * 零第三方运行时依赖) and the version is pinned by the lockfile, not by a URL someone edits.
 *
 * The ESM class worker (worker.js) plus its sibling chunks (const.js, errors.js) ride along —
 * the umd 814 chunk is a classic worker that importScripts()es the core, which dies as a module
 * worker. core-mt is deliberately NOT vendored: MT needs COOP+COEP (T08), the site does not
 * deploy COI headers, and MT output is not bit-reproducible — the deterministic tier is ST
 * (spec's 确定性产物只走 ST).
 */
import { copyFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url))); // packages/openfilm
const core = join(root, 'node_modules', '@ffmpeg', 'core', 'dist', 'esm'); // the worker import()s the core: the ESM build
const shell = join(root, 'node_modules', '@ffmpeg', 'ffmpeg', 'dist', 'esm');
const to = join(root, 'studio', 'ui', 'public', 'ffmpeg');
mkdirSync(to, { recursive: true });
for (const [name, from] of [
  ['ffmpeg-core.js', core],
  ['ffmpeg-core.wasm', core],
  ['worker.js', shell],
  ['const.js', shell],
  ['errors.js', shell],
]) {
  copyFileSync(join(from, name), join(to, name));
  console.log(`vendor-ffmpeg: ${name} → studio/ui/public/ffmpeg/`);
}
