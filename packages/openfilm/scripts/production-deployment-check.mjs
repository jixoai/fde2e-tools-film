#!/usr/bin/env node
/**
 * Production deployment gate for the pure-Web Film site.
 *
 * Unlike ffmpeg-deployment-check.mjs (source module + local Vite fixture), this gate only
 * touches the deployed static site. It proves the public route, SPA fallback, Range/MIME
 * contract, same-origin ST ffmpeg worker/WASM boot, WebMCP registry, bundled-example OPFS
 * copy, service-worker Range serving, and refresh persistence in a fresh real Chromium.
 */
import { createHash } from 'node:crypto';
import { resolve4 } from 'node:dns/promises';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';

const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const at = args.indexOf(name);
  return at < 0 ? fallback : args[at + 1];
};
const base = new URL(flag('--base', 'https://film.tool.fde2e.com/'));
if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) {
  throw new Error('--base must be a plain http(s) origin URL');
}
base.pathname = '/';
const origin = base.origin;
const requestedEvidenceDir = flag('--evidence-dir', join(process.cwd(), 'e2e-out', 'production-deployment'));
if (requestedEvidenceDir.includes('..')) throw new Error('--evidence-dir must not contain .. segments');
const evidenceDir = resolve(requestedEvidenceDir);
const imageDir = join(evidenceDir, 'img');
mkdirSync(imageDir, { recursive: true });

const findChrome = () => {
  const explicit = flag('--chrome') || process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  if (explicit && existsSync(explicit)) return explicit;
  const cache = join(homedir(), 'Library', 'Caches', 'ms-playwright');
  const names = existsSync(cache) ? readdirSync(cache).filter((name) => /^chromium-\d+$/.test(name)).sort() : [];
  const found = names.at(-1);
  const mac = found && join(cache, found, 'chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing');
  if (mac && existsSync(mac)) return mac;
  const bundled = chromium.executablePath();
  if (bundled && existsSync(bundled)) return bundled;
  throw new Error('Playwright Chromium not found; pass --chrome or PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH');
};

const expect = (condition, message) => { if (!condition) throw new Error(message); };
const sha256File = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
const screenshot = async (page, name) => {
  const path = join(imageDir, name);
  await page.screenshot({ path, fullPage: true });
  const bytes = readFileSync(path).byteLength;
  expect(bytes >= 10_000, `${name} is suspiciously small (${bytes} bytes)`);
  return { relative: `img/${name}`, bytes, sha256: sha256File(path) };
};
const waitForTools = async (page) => {
  await page.waitForFunction(() => Boolean(window.__webmcp_registered_tools?.size), undefined, { timeout: 30_000, polling: 250 });
  await page.waitForFunction(() => window.__webmcp_registered_tools?.size === 35, undefined, { timeout: 30_000, polling: 250 });
};
const callTool = (page, name, input = {}) => page.evaluate(async ([toolName, args_]) => {
  const tool = window.__webmcp_registered_tools?.get(toolName);
  if (!tool) throw new Error(`missing WebMCP tool: ${toolName}`);
  const raw = await tool._execute(args_, { signal: new AbortController().signal });
  return JSON.parse(typeof raw === 'string' ? raw : JSON.stringify(raw));
}, [name, input]);
const waitForExample = (page, timeout = 180_000) => page.waitForFunction(() => {
  const frame = document.querySelector('iframe[title="film"]');
  const intro = frame?.contentDocument?.querySelector('iframe#intro');
  return !document.body.innerText.includes('Drawing the first frame')
    && !document.body.innerText.includes('正在绘制第一帧')
    && Number(frame?.contentWindow?.film?.duration) > 90
    && intro != null && getComputedStyle(intro).visibility === 'visible';
}, undefined, { timeout, polling: 250 });
const previewState = (page) => page.evaluate(() => {
  const frame = document.querySelector('iframe[title="film"]');
  return { duration: Number(frame?.contentWindow?.film?.duration), url: location.href };
});
const inspectVideo = (page, projectId, path) => page.evaluate(async ({ id, outputPath }) => {
  const encoded = outputPath.split('/').map(encodeURIComponent).join('/');
  const response = await fetch(`/wf/${encodeURIComponent(id)}/${encoded}`, { headers: { Range: 'bytes=0-' } });
  if (!response.ok) throw new Error(`output fetch failed: ${response.status}`);
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const video = document.createElement('video');
  video.preload = 'auto'; video.src = url;
  try {
    await new Promise((resolveLoad, reject) => {
      video.addEventListener('loadedmetadata', resolveLoad, { once: true });
      video.addEventListener('error', () => reject(new Error(video.error?.message ?? 'video metadata failed')), { once: true });
    });
    video.currentTime = Math.min(0.75, Math.max(0, video.duration - 0.05));
    await new Promise((resolveSeek, reject) => {
      video.addEventListener('seeked', resolveSeek, { once: true });
      video.addEventListener('error', () => reject(new Error(video.error?.message ?? 'video seek failed')), { once: true });
    });
    if (typeof video.requestVideoFrameCallback === 'function') {
      await new Promise((resolveFrame) => { video.requestVideoFrameCallback(() => resolveFrame()); setTimeout(resolveFrame, 500); });
    }
    const canvas = document.createElement('canvas'); canvas.width = video.videoWidth; canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('video pixel probe has no 2D canvas');
    ctx.drawImage(video, 0, 0);
    const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let nonBlack = 0;
    for (let index = 0; index < pixels.length; index += 4) {
      if (pixels[index] + pixels[index + 1] + pixels[index + 2] > 24) nonBlack += 1;
    }
    let audio = null;
    try {
      const audioContext = new AudioContext();
      const decoded = await audioContext.decodeAudioData(await blob.arrayBuffer());
      audio = { channels: decoded.numberOfChannels, duration: decoded.duration };
      await audioContext.close();
    } catch { /* an absent audio track is asserted below */ }
    return {
      status: response.status, contentRange: response.headers.get('content-range'), bytes: blob.size, mime: blob.type,
      duration: video.duration, width: video.videoWidth, height: video.videoHeight, seeked: video.currentTime,
      nonBlack: nonBlack / (pixels.length / 4), audio,
    };
  } finally {
    video.remove(); URL.revokeObjectURL(url);
  }
}, { id: projectId, outputPath: path });

const requests = [];
const responses = [];
const pageErrors = [];
const consoleErrors = [];
const steps = [];
let browser;
let context;
let exampleId = null;

try {
  const executablePath = findChrome();
  browser = await chromium.launch({ executablePath, headless: true });
  context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN', serviceWorkers: 'allow' });
  const page = await context.newPage();
  page.on('request', (request) => requests.push({ method: request.method(), type: request.resourceType(), url: request.url() }));
  page.on('response', (response) => responses.push({ status: response.status(), url: response.url() }));
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });

  const rootResponse = await page.goto(origin, { waitUntil: 'load', timeout: 60_000 });
  expect(rootResponse?.status() === 200, `root status=${rootResponse?.status()}`);
  await waitForTools(page);
  await page.locator('[role="dialog"]').waitFor({ state: 'visible', timeout: 30_000 });
  const cold = await page.evaluate(async () => ({
    title: document.title,
    origin: location.origin,
    crossOriginIsolated,
    sharedArrayBuffer: typeof SharedArrayBuffer,
    tools: window.__webmcp_registered_tools?.size ?? 0,
    serviceWorkerRegistration: Boolean(await navigator.serviceWorker.getRegistration('/')),
  }));
  const coldFfmpeg = requests.filter(({ url }) => new URL(url).pathname.startsWith('/ffmpeg/'));
  expect(cold.title === 'FDE2E Film', `title=${cold.title}`);
  expect(cold.origin === origin, `origin=${cold.origin}`);
  expect(cold.crossOriginIsolated === false, `crossOriginIsolated=${cold.crossOriginIsolated}`);
  expect(cold.sharedArrayBuffer === 'undefined', `SharedArrayBuffer=${cold.sharedArrayBuffer}`);
  expect(cold.tools === 35, `WebMCP tools=${cold.tools}`);
  expect(coldFfmpeg.length === 0, `cold boot requested ${coldFfmpeg.length} ffmpeg assets`);
  const homeShot = await screenshot(page, 's1-production-home.png');
  steps.push({
    id: 'S1', intent: '从公网 TLS 域名冷启动 Film',
    expect: '根页 200；35 个 WebMCP 工具；COI 关闭；首屏不下载 32 MB wasm',
    assertion: `status=200; title=${cold.title}; tools=${cold.tools}; crossOriginIsolated=${cold.crossOriginIsolated}; SharedArrayBuffer=${cold.sharedArrayBuffer}; cold /ffmpeg requests=${coldFfmpeg.length}`,
    ok: true, image: homeShot.relative, imageMeta: `1440×900 · ${homeShot.bytes} bytes · sha256 ${homeShot.sha256.slice(0, 16)}…`,
  });

  const dns = await resolve4(base.hostname);
  expect(dns.length > 0, `DNS has no A record for ${base.hostname}`);
  const contract = await page.evaluate(async () => {
    const get = async (path, range = null) => {
      const response = await fetch(path, { ...(range ? { headers: { Range: range } } : {}), cache: 'no-store' });
      const bytes = new Uint8Array(await response.arrayBuffer());
      return {
        path, status: response.status, bytes: bytes.byteLength,
        contentType: response.headers.get('content-type'), contentRange: response.headers.get('content-range'),
        acceptRanges: response.headers.get('accept-ranges'), cacheControl: response.headers.get('cache-control'),
        allowOrigin: response.headers.get('access-control-allow-origin'),
        coop: response.headers.get('cross-origin-opener-policy'), coep: response.headers.get('cross-origin-embedder-policy'),
      };
    };
    return {
      root: await get('/'), spa: await get('/projects/deployment-probe'),
      media: await get('/examples/one-prompt/assets/one-prompt.mp3', 'bytes=0-31'),
      wasm: await get('/ffmpeg/ffmpeg-core.wasm', 'bytes=0-31'),
      worker: await get('/ffmpeg/worker.js', 'bytes=0-31'),
      module: await get('/__film/film-doc.mjs', 'bytes=0-31'),
      missingAsset: await get('/assets/deployment-probe-missing.js'),
    };
  });
  expect(contract.root.status === 200 && contract.root.cacheControl === 'no-cache', `root headers=${JSON.stringify(contract.root)}`);
  expect(contract.root.coop === null && contract.root.coep === null, `COI headers present: ${JSON.stringify(contract.root)}`);
  expect(contract.spa.status === 200 && /text\/html/.test(contract.spa.contentType ?? ''), `SPA fallback=${JSON.stringify(contract.spa)}`);
  expect(contract.media.status === 206 && contract.media.bytes === 32 && contract.media.contentRange?.startsWith('bytes 0-31/'), `media Range=${JSON.stringify(contract.media)}`);
  expect(contract.media.contentType === 'audio/mpeg', `media MIME=${contract.media.contentType}`);
  expect(contract.wasm.status === 206 && contract.wasm.bytes === 32 && contract.wasm.contentType === 'application/wasm', `wasm Range/MIME=${JSON.stringify(contract.wasm)}`);
  expect(contract.worker.status === 206 && /javascript/.test(contract.worker.contentType ?? ''), `worker MIME=${JSON.stringify(contract.worker)}`);
  expect(contract.module.status === 206 && /javascript/.test(contract.module.contentType ?? ''), `mjs MIME=${JSON.stringify(contract.module)}`);
  expect(contract.media.allowOrigin === '*' && contract.wasm.allowOrigin === '*', 'static CORS headers missing');
  expect(contract.missingAsset.status === 404, `missing hashed asset status=${contract.missingAsset.status}`);

  const workerResult = await page.evaluate(async () => {
    const worker = new Worker('/ffmpeg/worker.js', { type: 'module' });
    let sequence = 0;
    const call = (type, data, timeout = 120_000) => new Promise((resolve, reject) => {
      const id = `production-${++sequence}`;
      const timer = setTimeout(() => reject(new Error(`${type} timed out`)), timeout);
      const receive = (event) => {
        if (event.data?.id !== id) return;
        worker.removeEventListener('message', receive);
        clearTimeout(timer);
        if (event.data.type === 'ERROR') reject(new Error(event.data.data));
        else resolve(event.data.data);
      };
      worker.addEventListener('message', receive);
      worker.postMessage({ id, type, data });
    });
    try {
      const coreURL = new URL('/ffmpeg/ffmpeg-core.js', location.origin).href;
      const wasmURL = new URL('/ffmpeg/ffmpeg-core.wasm', location.origin).href;
      const workerURL = new URL('/ffmpeg/worker.js', location.origin).href;
      const firstLoad = await call('LOAD', { coreURL, wasmURL, workerURL });
      const root = await call('LIST_DIR', { path: '/' });
      return { firstLoad, root: root.map((entry) => entry.name), urls: { coreURL, wasmURL, workerURL } };
    } finally {
      worker.terminate();
    }
  });
  expect(workerResult.firstLoad === true, `ffmpeg firstLoad=${workerResult.firstLoad}`);
  expect(workerResult.root.includes('tmp') && workerResult.root.includes('home'), `ffmpeg FS=${workerResult.root.join(',')}`);
  const ffmpegRequests = requests.filter(({ url }) => new URL(url).pathname.startsWith('/ffmpeg/'));
  const ffmpegPaths = ffmpegRequests.map(({ url }) => new URL(url).pathname);
  expect(ffmpegRequests.every(({ url }) => new URL(url).origin === origin), 'cross-origin ffmpeg request observed');
  expect(ffmpegPaths.includes('/ffmpeg/worker.js') && ffmpegPaths.includes('/ffmpeg/ffmpeg-core.js') && ffmpegPaths.includes('/ffmpeg/ffmpeg-core.wasm'), `ffmpeg assets=${ffmpegPaths.join(',')}`);
  expect(ffmpegPaths.every((path) => !path.includes('core-mt')), 'core-mt entered production requests');
  const ffmpegResponses = responses.filter(({ url }) => new URL(url).pathname.startsWith('/ffmpeg/'));
  expect(ffmpegResponses.every(({ status }) => status === 200 || status === 206), `ffmpeg HTTP failure=${JSON.stringify(ffmpegResponses)}`);

  await page.evaluate((details) => {
    const card = document.createElement('aside');
    card.dataset.deploymentDiagnostic = '';
    card.setAttribute('role', 'status');
    card.style.cssText = 'position:fixed;right:24px;bottom:24px;z-index:9999;width:360px;padding:18px;border:1px solid #3f3f46;border-radius:14px;background:#111113;color:#fafafa;font:13px/1.55 ui-monospace,monospace;box-shadow:0 16px 48px #0008;white-space:pre-wrap';
    card.textContent = `E2E diagnostic (not product UI)\nST ffmpeg worker: loaded\nWASM: same-origin 200\nFS: ${details.root.join(', ')}\nCOI: off · core-mt: absent`;
    document.body.append(card);
  }, workerResult);
  const workerShot = await screenshot(page, 's2-same-origin-ffmpeg.png');
  await page.evaluate(() => document.querySelector('[data-deployment-diagnostic]')?.remove());
  steps.push({
    id: 'S2', intent: '核对 Nginx 静态契约并在生产页启动同源 ST ffmpeg worker/WASM',
    expect: 'media/WASM Range=206；MIME 正确；SPA=200；hash 资源 404 不回退；无 COOP/COEP；worker 真正初始化 FS',
    assertion: `DNS A=${dns.join(',')}; media=${contract.media.status}/${contract.media.contentType}; wasm=${contract.wasm.status}/${contract.wasm.contentType}; mjs=${contract.module.contentType}; SPA=${contract.spa.status}; missing hash=${contract.missingAsset.status}; ffmpeg FS=${workerResult.root.join(',')}; allSameOrigin=true; core-mt=0`,
    ok: true, image: workerShot.relative, imageMeta: `1440×900 · 诊断卡由门禁临时注入并明确标注非产品 UI · sha256 ${workerShot.sha256.slice(0, 16)}…`,
  });

  const example = await callTool(page, 'projects_load_example', { id: 'one-prompt' });
  expect(example.ok === true && typeof example.id === 'string', `load example=${JSON.stringify(example)}`);
  exampleId = example.id;
  await page.waitForURL(new RegExp(`/projects/${exampleId}$`), { timeout: 120_000 });
  await waitForExample(page);
  const exampleState = await callTool(page, 'film_state');
  const preview = await previewState(page);
  const opfs = await page.evaluate(async (id) => {
    const response = await fetch(`/wf/${id}/assets/one-prompt.mp3`, { headers: { Range: 'bytes=0-31' } });
    const baseDir = await navigator.storage.getDirectory();
    const projects = await baseDir.getDirectoryHandle('projects');
    const project = await projects.getDirectoryHandle(id);
    let files = 0;
    const walk = async (dir) => {
      for await (const [, handle] of dir.entries()) {
        if (handle.kind === 'directory') await walk(handle); else files += 1;
      }
    };
    await walk(project);
    return { files, range: { status: response.status, bytes: (await response.arrayBuffer()).byteLength, contentRange: response.headers.get('content-range') } };
  }, exampleId);
  expect(exampleState.project?.id === exampleId, `film_state project=${exampleState.project?.id}`);
  expect(exampleState.tracks?.length === 2 && preview.duration > 90, `film_state/preview=${JSON.stringify({ exampleState, preview })}`);
  expect(opfs.files >= 100, `OPFS files=${opfs.files}`);
  expect(opfs.range.status === 206 && opfs.range.bytes === 32 && opfs.range.contentRange?.startsWith('bytes 0-31/'), `OPFS Range=${JSON.stringify(opfs.range)}`);
  const foreignAtExample = requests.filter(({ url }) => /^https?:/.test(url) && new URL(url).origin !== origin);
  expect(foreignAtExample.length === 0, `foreign requests=${JSON.stringify(foreignAtExample)}`);
  const exampleShot = await screenshot(page, 's3-bundled-example.png');
  steps.push({
    id: 'S3', intent: '通过线上 WebMCP 载入 checksum 校验的 One Prompt 示例',
    expect: '普通 OPFS 项目打开；90.9s/2 轨；≥100 文件；OPFS SW Range=206；全部 HTTP(S) 请求同源',
    assertion: `project=${exampleId}; duration=${preview.duration}; tracks=${exampleState.tracks.length}; OPFS files=${opfs.files}; SW Range=${opfs.range.status}/${opfs.range.bytes}B; foreign requests=${foreignAtExample.length}`,
    ok: true, image: exampleShot.relative, imageMeta: `1440×900 · 真实生产项目页 · sha256 ${exampleShot.sha256.slice(0, 16)}…`,
  });

  const reloadStartedAt = Date.now();
  await page.reload({ waitUntil: 'load', timeout: 60_000 });
  await waitForTools(page);
  const controlledOnFirstReload = await page.evaluate(() => Boolean(navigator.serviceWorker.controller));
  if (!controlledOnFirstReload) {
    await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller), undefined, { timeout: 30_000, polling: 250 });
    await page.reload({ waitUntil: 'load', timeout: 60_000 });
    await waitForTools(page);
  }
  await waitForExample(page);
  const reloadElapsedMs = Date.now() - reloadStartedAt;
  const persisted = await callTool(page, 'film_state');
  const persistedPreview = await previewState(page);
  const serviceWorker = await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready;
    return { controlled: Boolean(navigator.serviceWorker.controller), active: registration.active?.state ?? null, script: registration.active?.scriptURL ?? null };
  });
  expect(persisted.project?.id === exampleId && persistedPreview.duration > 90, `reload state=${JSON.stringify({ persisted, persistedPreview })}`);
  expect(serviceWorker.controlled && serviceWorker.active === 'activated', `service worker=${JSON.stringify(serviceWorker)}`);
  await page.evaluate(() => {
    const card = document.createElement('aside');
    card.dataset.reloadDiagnostic = '';
    card.setAttribute('role', 'status');
    card.style.cssText = 'position:fixed;right:24px;bottom:24px;z-index:9999;width:360px;padding:18px;border:1px solid #3f3f46;border-radius:14px;background:#111113;color:#fafafa;font:13px/1.55 ui-monospace,monospace;box-shadow:0 16px 48px #0008;white-space:pre-wrap';
    card.textContent = 'E2E diagnostic (not product UI)\nSPA direct reload: 200\nOPFS project: persisted\nService worker: activated + controlling';
    document.body.append(card);
  });
  const reloadShot = await screenshot(page, 's4-spa-reload-persistence.png');
  await page.evaluate(() => document.querySelector('[data-reload-diagnostic]')?.remove());
  expect(new Set([homeShot.sha256, workerShot.sha256, exampleShot.sha256, reloadShot.sha256]).size === 4, 'two evidence screenshots are byte-identical');
  steps.push({
    id: 'S4', intent: '直接刷新生产 SPA 项目路由',
    expect: 'Nginx 回落 index-web；OPFS 项目仍在；service worker 已激活并控制页面；预览再次绘制',
    assertion: `url=${page.url()}; project=${persisted.project.id}; duration=${persistedPreview.duration}; serviceWorker=${serviceWorker.active}; controlled=${serviceWorker.controlled}; controlledOnFirstReload=${controlledOnFirstReload}; elapsed=${reloadElapsedMs}ms; screenshot hashes distinct=4/4`,
    ok: true, image: reloadShot.relative, imageMeta: `1440×900 · 刷新后的同一项目；诊断卡由门禁临时注入并明确标注非产品 UI · sha256 ${reloadShot.sha256.slice(0, 16)}…`,
  });

  const render = await callTool(page, 'produce_render', {
    kind: 'video', name: 'production-release-seek', from: 0, to: 1,
    codec: 'h264', audio: true, fps: 4, shortEdge: 64, wait: true,
  });
  expect(render.ok === true && render.status === 'done' && render.paths?.length === 1 && render.bytes > 0, `production render=${JSON.stringify(render)}`);
  const media = await inspectVideo(page, exampleId, render.paths[0]);
  expect(media.status === 206 && media.contentRange?.startsWith('bytes 0-'), `production output Range=${JSON.stringify(media)}`);
  expect(media.mime === 'video/mp4' && media.duration >= 0.9 && media.duration <= 1.6, `production output metadata=${JSON.stringify(media)}`);
  expect(media.seeked > 0.5 && media.nonBlack > 0.01, `production output seek/pixels=${JSON.stringify(media)}`);
  expect(media.audio?.channels === 2 && media.audio.duration >= 0.9, `production output audio=${JSON.stringify(media.audio)}`);
  const renderStatus = await callTool(page, 'produce_export_status');
  const renderJob = renderStatus.jobs?.find((job) => job.id === render.jobId);
  expect(renderJob?.status === 'done' && renderJob.outputs?.[0] === render.paths[0] && renderJob.bytes === render.bytes, `production output status=${JSON.stringify(renderStatus)}`);
  await page.locator('button[aria-label="设置"]').click({ force: true });
  const settings = page.getByRole('dialog');
  await settings.waitFor({ state: 'visible', timeout: 30_000 });
  const settingsText = await settings.innerText();
  expect(settingsText.includes('FDE2E Film 0.3.0'), `production About=${settingsText}`);
  const exportShot = await screenshot(page, 's5-production-export.png');
  await page.keyboard.press('Escape');
  steps.push({
    id: 'S5', intent: '在生产站用 WebMCP 真导出 H.264＋AAC，并从 OPFS Range URL seek',
    expect: 'job done；MP4 Range=206；可 seek、非黑、有双声道音轨；About=0.3.0；运行时仍零外域',
    assertion: `job=${render.jobId}; bytes=${media.bytes}; range=${media.status}/${media.contentRange}; duration=${media.duration}s; seek=${media.seeked}s; nonBlack=${media.nonBlack.toFixed(3)}; audio=${media.audio.channels}ch; version=0.3.0`,
    ok: true, image: exportShot.relative, imageMeta: `1440×900 · 生产候选 About＋真实导出已落 OPFS · sha256 ${exportShot.sha256.slice(0, 16)}…`,
  });

  const foreignRequests = requests.filter(({ url }) => /^https?:/.test(url) && new URL(url).origin !== origin);
  const forbiddenOmni = requests.filter(({ url }) => /(^|\.)omni\.fde2e\.com$/i.test(new URL(url).hostname));
  expect(foreignRequests.length === 0, `foreign requests after export=${JSON.stringify(foreignRequests)}`);
  expect(forbiddenOmni.length === 0, `production Omni requests=${JSON.stringify(forbiddenOmni)}`);
  const cleanup = await callTool(page, 'projects_delete', { id: exampleId });
  expect(cleanup.ok === true, `cleanup=${JSON.stringify(cleanup)}`);
  const httpErrors = responses.filter(({ status }) => status >= 400);
  const expectedProbe404 = httpErrors.length === 1 && httpErrors[0].status === 404
    && new URL(httpErrors[0].url).pathname === '/assets/deployment-probe-missing.js';
  const unexpectedConsoleErrors = consoleErrors.filter((message) => !expectedProbe404 || !/status of 404/.test(message));
  expect(pageErrors.length === 0, `page errors=${pageErrors.join(' | ')}`);
  expect(expectedProbe404, `unexpected HTTP errors=${JSON.stringify(httpErrors)}`);
  expect(unexpectedConsoleErrors.length === 0, `console errors=${unexpectedConsoleErrors.join(' | ')}`);

  const result = {
    ok: true, base: origin, browser: browser.version(), executablePath, dns, cold, contract,
    worker: workerResult,
    example: { id: exampleId, state: exampleState, preview, opfs, persisted, persistedPreview, reload: { controlledOnFirstReload, elapsedMs: reloadElapsedMs }, cleanup },
    productionRender: { receipt: render, media, status: renderJob, about: 'FDE2E Film 0.3.0' },
    serviceWorker,
    network: { requestCount: requests.length, responseCount: responses.length, coldFfmpeg, ffmpegRequests, ffmpegResponses, foreignRequests, forbiddenOmni, httpErrors },
    pageErrors, consoleErrors,
    screenshots: [homeShot, workerShot, exampleShot, reloadShot, exportShot],
  };
  writeFileSync(join(evidenceDir, 'result.json'), `${JSON.stringify(result, null, 2)}\n`);
  const day = new Date().toISOString().slice(0, 10);
  writeFileSync(join(evidenceDir, 'steps.json'), `${JSON.stringify({
    title: 'web-openfilm-editor 6.1 · 生产部署端到端验收',
    brand: 'FDE2E™ Film · film.tool.fde2e.com',
    meta: `${day} · Chromium ${result.browser} · production HTTPS · 5 steps`,
    thesis: '生产域名、TLS、Nginx Range/MIME/SPA、无 COI、同源 ST ffmpeg Worker/WASM、OPFS 示例/刷新，以及真实 H.264＋AAC 导出、Range seek 均由真实 Chromium 复算通过；普通进站零 wasm 成本，运行时零跨源请求。',
    env: [
      ['被测入口', origin],
      ['浏览器', `Chromium ${result.browser} · fresh context · 1440×900 · zh-CN`],
      ['部署形态', 'OpenResty static vhost · OPFS client state · same-origin vendored ffmpeg ST · COI off'],
      ['网络边界', `${origin} only；未访问 omni.fde2e.com、provider API、CDN 或 ffmpeg.tool`],
      ['原始证据', 'result.json（DNS/headers/network URLs/status/OPFS/worker/service-worker/errors）＋ img/*.png'],
      ['可复算', `pnpm run production-deployment-check -- --base ${origin} --evidence-dir <dir>`],
      ['证据边界', '活体公网与浏览器为结论级可复算；截图 sha256 仅绑定本次运行，不要求跨次字节一致'],
    ],
    sections: [
      { title: '1 · 静态部署与编码运行时', steps: steps.slice(0, 2) },
      { title: '2 · 真实应用与持久化', steps: steps.slice(2) },
    ],
    summary: { pass: steps.length, fail: 0 },
  }, null, 2)}\n`);
  console.log(JSON.stringify({ ok: true, evidenceDir, result }, null, 2));
} finally {
  if (context) await context.close().catch(() => {});
  if (browser) await browser.close().catch(() => {});
}
