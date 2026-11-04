#!/usr/bin/env node
/**
 * D6 option-C browser gate: Film owns one same-origin, single-threaded ffmpeg.wasm fallback.
 *
 * The probe proves three runtime properties that source inspection cannot:
 * 1. cold entry requests no /ffmpeg/* bytes and does not require cross-origin isolation;
 * 2. the first GIF request lazily loads only same-origin ST assets and produces a real GIF;
 * 3. a second request reuses the loaded core (no second 32MB wasm request).
 *
 * It creates two fixture files under studio/ui, starts local Vite, drives real Chromium, writes
 * screenshots/result/steps to --evidence-dir, then removes both fixtures and closes every process.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const here = dirname(fileURLToPath(import.meta.url));
const root = dirname(here);
const ui = join(root, 'studio', 'ui');
const pagePath = join(ui, '__ffmpeg_deployment_check.html');
const inputPath = join(ui, 'public', '__ffmpeg_deployment_input.mp4');
const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const port = Number(arg('--port', '13692'));
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('--port must be 1024..65535');
const evidenceDir = resolve(arg('--evidence-dir', join(process.cwd(), 'e2e-out', 'ffmpeg-deployment')));
const imgDir = join(evidenceDir, 'img');
mkdirSync(imgDir, { recursive: true });

if (existsSync(pagePath) || existsSync(inputPath)) {
  throw new Error('temporary ffmpeg deployment fixtures already exist; refusing to overwrite');
}

const executable = (() => {
  const explicit = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  if (explicit && existsSync(explicit)) return explicit;
  const cache = join(homedir(), 'Library', 'Caches', 'ms-playwright');
  const names = existsSync(cache) ? readdirSync(cache).filter((x) => /^chromium-\d+$/.test(x)).sort() : [];
  const found = names.at(-1);
  const mac = found && join(cache, found, 'chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing');
  if (mac && existsSync(mac)) return mac;
  const bundled = chromium.executablePath();
  if (bundled && existsSync(bundled)) return bundled;
  throw new Error('Playwright Chromium not found; set PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH');
})();

const fixtureHtml = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Film ffmpeg deployment gate</title><link rel="icon" href="data:,"><style>body{margin:0;background:#0c0c0f;color:#f4f4f5;font:15px/1.5 ui-monospace,monospace}main{max-width:920px;margin:48px auto;padding:28px;border:1px solid #3f3f46;border-radius:16px;background:#18181b}h1{font:600 24px/1.2 system-ui,sans-serif}dl{display:grid;grid-template-columns:220px 1fr;gap:10px 18px}dt{color:#a1a1aa}dd{margin:0;word-break:break-word}.ok{color:#86efac}.pending{color:#fde68a}</style></head><body><main><h1>Film · ffmpeg deployment gate</h1><dl><dt>mode</dt><dd id="mode">cold</dd><dt>crossOriginIsolated</dt><dd id="coi"></dd><dt>SharedArrayBuffer</dt><dd id="sab"></dd><dt>/ffmpeg requests</dt><dd id="requests">0</dd><dt>output</dt><dd id="output" class="pending">not requested</dd></dl></main><script type="module">import * as mod from '/src/web/ffmpeg-fallback.ts';const set=(id,v)=>document.getElementById(id).textContent=String(v);set('coi',crossOriginIsolated);set('sab',typeof SharedArrayBuffer);window.__gateReady=true;window.runFallback=async()=>{set('mode','loading same-origin ST');const bytes=new Uint8Array(await (await fetch('/__ffmpeg_deployment_input.mp4')).arrayBuffer());const out=await mod.encodeFallback({name:'input.mp4',bytes},'gif',{fps:6});const data=new Uint8Array(await out.blob.arrayBuffer());const magic=String.fromCharCode(...data.subarray(0,6));set('mode',mod.FFMPEG_FALLBACK_DEPLOYMENT.mode);set('output',magic+' · '+data.byteLength+' bytes · '+out.codec);document.getElementById('output').className='ok';return {deployment:mod.FFMPEG_FALLBACK_DEPLOYMENT,urls:mod.ffmpegAssetUrls(location.origin),type:out.blob.type,size:data.byteLength,magic};};window.setRequestCount=(n)=>set('requests',n);</script></body></html>`;

let server;
let browser;
let runError;
const requests = [];
const pageErrors = [];
const consoleErrors = [];
const base = `http://127.0.0.1:${port}`;
const waitForServer = async () => {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${base}/__ffmpeg_deployment_check.html`);
      if (r.ok) return;
    } catch {}
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error('Vite did not become ready in 30s');
};
const expect = (condition, message) => { if (!condition) throw new Error(message); };

try {
  writeFileSync(pagePath, fixtureHtml);
  const made = spawnSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=6',
    '-t', '0.5', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-movflags', '+faststart', '-y', inputPath,
  ], { cwd: root, encoding: 'utf8' });
  if (made.status !== 0) throw new Error(`fixture ffmpeg failed: ${made.stderr}`);

  const viteBin = join(root, 'node_modules', 'vite', 'bin', 'vite.js');
  server = spawn(process.execPath, [viteBin, '--host', '127.0.0.1', '--port', String(port), '--strictPort', '--config', 'studio/ui/vite.config.ts'], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverLog = '';
  server.stdout.on('data', (b) => { serverLog += String(b); });
  server.stderr.on('data', (b) => { serverLog += String(b); });
  await waitForServer();

  browser = await chromium.launch({ executablePath: executable, headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on('request', (r) => requests.push(r.url()));
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  await page.goto(`${base}/__ffmpeg_deployment_check.html`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.__gateReady === true);
  const cold = await page.evaluate(() => ({ coi: crossOriginIsolated, sab: typeof SharedArrayBuffer }));
  const coldFfmpeg = requests.filter((url) => new URL(url).pathname.startsWith('/ffmpeg/'));
  await page.evaluate((n) => window.setRequestCount(n), coldFfmpeg.length);
  await page.screenshot({ path: join(imgDir, 's1-cold-entry.png'), fullPage: true });
  expect(cold.coi === false, `cold crossOriginIsolated=${cold.coi}`);
  expect(cold.sab === 'undefined', `cold SharedArrayBuffer=${cold.sab}`);
  expect(coldFfmpeg.length === 0, `cold boot fetched ${coldFfmpeg.length} ffmpeg assets`);

  const first = await page.evaluate(() => window.runFallback());
  const afterFirst = requests.filter((url) => new URL(url).pathname.startsWith('/ffmpeg/'));
  await page.evaluate((n) => window.setRequestCount(n), afterFirst.length);
  await page.screenshot({ path: join(imgDir, 's2-first-gif.png'), fullPage: true });
  const assetNames = afterFirst.map((url) => new URL(url).pathname.split('/').at(-1));
  expect(first.deployment.mode === 'main-site-vendored-st', `mode=${first.deployment.mode}`);
  expect(first.deployment.multithreaded === false && first.deployment.requiresCrossOriginIsolation === false, 'deployment flags drifted');
  expect(first.type === 'image/gif' && /^GIF8[79]a$/.test(first.magic), `not a GIF: ${first.type} ${first.magic}`);
  expect(first.size > 1_000, `GIF is suspiciously small: ${first.size}`);
  expect(afterFirst.length > 0, 'on-demand run fetched no ffmpeg assets');
  expect(afterFirst.every((url) => new URL(url).origin === base), 'cross-origin ffmpeg asset requested');
  expect(assetNames.includes('ffmpeg-core.js') && assetNames.includes('ffmpeg-core.wasm') && assetNames.includes('worker.js'), `missing core assets: ${assetNames.join(',')}`);
  expect(afterFirst.every((url) => !url.includes('core-mt')), 'MT core entered runtime requests');

  const wasmBefore = afterFirst.filter((url) => url.endsWith('/ffmpeg-core.wasm')).length;
  const second = await page.evaluate(() => window.runFallback());
  const afterSecond = requests.filter((url) => new URL(url).pathname.startsWith('/ffmpeg/'));
  const wasmAfter = afterSecond.filter((url) => url.endsWith('/ffmpeg-core.wasm')).length;
  await page.evaluate((n) => window.setRequestCount(n), afterSecond.length);
  await page.screenshot({ path: join(imgDir, 's3-reuse.png'), fullPage: true });
  expect(wasmBefore === 1 && wasmAfter === 1, `wasm requests ${wasmBefore}→${wasmAfter}`);
  expect(second.type === 'image/gif' && second.size > 1_000, 'second GIF failed');
  expect(pageErrors.length === 0, `page errors: ${pageErrors.join(' | ')}`);
  expect(consoleErrors.length === 0, `console errors: ${consoleErrors.join(' | ')}`);

  const result = {
    browser: browser.version(),
    base,
    cold,
    coldFfmpeg,
    first,
    afterFirst,
    second: { type: second.type, size: second.size, magic: second.magic },
    afterSecond,
    wasmRequests: { before: wasmBefore, after: wasmAfter },
    pageErrors,
    consoleErrors,
    inputSha256: createHash('sha256').update(readFileSync(inputPath)).digest('hex'),
  };
  writeFileSync(join(evidenceDir, 'result.json'), `${JSON.stringify(result, null, 2)}\n`);
  const steps = {
    title: 'web-openfilm-editor 3.6 · ffmpeg 分叉终裁 C 真机验证',
    brand: 'FDE2E™ Film · encodeBackend 端到端报告',
    meta: `2026-11-04 · Chromium ${result.browser} · local Vite ${base} · 3 steps`,
    thesis: '选 C：Film 主站同源 vendored ST。冷启动零 wasm/零 COI；首次 GIF 才惰性加载同源 core；第二次复用实例、不重下 32MB wasm。',
    env: [
      ['决策', 'C · main-site-vendored-st；不部署 ffmpeg.tool；不引入 core-mt/COOP/COEP'],
      ['被测面', 'ffmpeg-fallback.ts 源模块 + vendor 后 public/ffmpeg 真实资产'],
      ['网络边界', `仅 ${base}；未访问 omni.fde2e.com 或任何 provider`],
      ['原始数据', 'result.json（请求 URL、GIF magic/bytes、wasm 计数、console/pageerror）'],
      ['复算', 'pnpm run ffmpeg-deployment-check -- --evidence-dir <dir> --port 13692'],
    ],
    sections: [{
      title: '1 · 冷启动与按需加载',
      steps: [
        { id: 'S1', intent: '冷进测试页，不调用任何 fallback', expect: '零 /ffmpeg 请求；crossOriginIsolated=false；SAB 不在场', assertion: `ffmpegRequests=${coldFfmpeg.length}; coi=${cold.coi}; SAB=${cold.sab}`, ok: true, image: 'img/s1-cold-entry.png', imageMeta: '1280×800 · Chromium headless' },
        { id: 'S2', intent: '首次请求 GIF（palettegen/paletteuse）', expect: '惰性加载同源 ST core，产出非空 GIF；零 core-mt', assertion: `magic=${first.magic}; bytes=${first.size}; assets=${assetNames.join(',')}; allSameOrigin=true; coreMt=0`, ok: true, image: 'img/s2-first-gif.png', imageMeta: '1280×800 · 首次 fallback 完成' },
        { id: 'S3', intent: '同页第二次请求 GIF', expect: '复用已加载实例，不再次下载 ffmpeg-core.wasm', assertion: `wasmRequests=${wasmBefore}→${wasmAfter}; secondBytes=${second.size}; pageErrors=0; consoleErrors=0`, ok: true, image: 'img/s3-reuse.png', imageMeta: '1280×800 · 二次复用完成' },
      ],
    }],
    summary: { pass: 3, fail: 0 },
  };
  writeFileSync(join(evidenceDir, 'steps.json'), `${JSON.stringify(steps, null, 2)}\n`);
  console.log(JSON.stringify({ ok: true, evidenceDir, result }, null, 2));
} catch (error) {
  runError = error;
  console.error(error instanceof Error ? error.stack : String(error));
} finally {
  if (browser) await browser.close().catch(() => {});
  if (server) {
    server.kill('SIGTERM');
    await Promise.race([
      new Promise((done) => server.once('exit', done)),
      new Promise((done) => setTimeout(done, 5_000)),
    ]);
    if (server.exitCode == null) server.kill('SIGKILL');
  }
  rmSync(pagePath, { force: true });
  rmSync(inputPath, { force: true });
}
if (runError) process.exit(1);
