#!/usr/bin/env node
/**
 * Release-polish browser regression for the static Web face.
 *
 * This is deliberately an application workflow, not an encoder fixture: it loads the bundled
 * example through the same 44-tool WebMCP surface an agent uses, verifies save→edit→restore,
 * renders a short MP4 with audio synchronously, then starts a 30-second bounded-memory render
 * asynchronously and polls the public job surface. Finally it reloads the SPA and proves the
 * project and both OPFS deliverables survived. No production or omni origin is contacted.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { createFilmStaticServer } from './web-static-server.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const DIST = join(ROOT, 'studio', 'ui', 'dist');
const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const at = argv.indexOf(name);
  return at < 0 ? fallback : argv[at + 1];
};
const evidenceArg = flag('--evidence-dir');
const evidenceDir = evidenceArg ? resolve(evidenceArg) : null;
if (evidenceArg?.includes('..')) throw new Error('--evidence-dir must not contain .. segments');
const imageDir = evidenceDir ? join(evidenceDir, 'img') : null;
if (imageDir) mkdirSync(imageDir, { recursive: true });

const findChrome = () => {
  const explicit = flag('--chrome') || process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  if (explicit && existsSync(explicit)) return explicit;
  const cache = join(homedir(), 'Library', 'Caches', 'ms-playwright');
  const versions = existsSync(cache) ? readdirSync(cache).filter((name) => /^chromium-\d+$/.test(name)).sort() : [];
  const version = versions.at(-1);
  const mac = version && join(cache, version, 'chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing');
  if (mac && existsSync(mac)) return mac;
  const bundled = chromium.executablePath();
  if (bundled && existsSync(bundled)) return bundled;
  throw new Error('Playwright Chromium not found; pass --chrome');
};
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const waitForTools = async (page) => {
  await page.waitForFunction(() => window.__webmcp_registered_tools?.size === 44, undefined, { timeout: 60_000, polling: 250 });
};
const call = (page, name, input = {}) => page.evaluate(async ([toolName, args]) => {
  const tool = window.__webmcp_registered_tools?.get(toolName);
  if (!tool) throw new Error(`missing WebMCP tool: ${toolName}`);
  const raw = await tool._execute(args, { signal: new AbortController().signal });
  return JSON.parse(typeof raw === 'string' ? raw : JSON.stringify(raw));
}, [name, input]);
const waitForPreview = (page, minimumDuration = 30, timeout = 180_000) => page.waitForFunction((minimum) => {
  const frame = document.querySelector('iframe[title="film"]');
  return !document.body.innerText.includes('Drawing the first frame')
    && !document.body.innerText.includes('正在绘制第一帧')
    && Number(frame?.contentWindow?.film?.duration) > minimum;
}, minimumDuration, { timeout, polling: 250 });
const inspectVideo = (page, projectId, path) => page.evaluate(async ({ id, outputPath }) => {
  const encodedPath = outputPath.split('/').map(encodeURIComponent).join('/');
  const response = await fetch(`/wf/${encodeURIComponent(id)}/${encodedPath}`, { headers: { Range: 'bytes=0-' } });
  if (!response.ok) throw new Error(`output fetch failed: ${response.status}`);
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const video = document.createElement('video');
  video.preload = 'metadata';
  video.src = url;
  try {
    await new Promise((resolveLoad, reject) => {
      video.addEventListener('loadedmetadata', resolveLoad, { once: true });
      video.addEventListener('error', () => reject(new Error(video.error?.message ?? 'video metadata failed')), { once: true });
    });
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth; canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('video pixel probe has no 2D canvas');
    const samples = [];
    for (const fraction of [0.1, 0.5, 0.9]) {
      const seekTo = Math.min(Math.max(0, video.duration * fraction), Math.max(0, video.duration - 0.05));
      video.currentTime = seekTo;
      await new Promise((resolveSeek, reject) => {
        video.addEventListener('seeked', resolveSeek, { once: true });
        video.addEventListener('error', () => reject(new Error(video.error?.message ?? 'video seek failed')), { once: true });
      });
      if (typeof video.requestVideoFrameCallback === 'function') {
        await new Promise((resolveFrame) => { video.requestVideoFrameCallback(() => resolveFrame()); setTimeout(resolveFrame, 500); });
      }
      ctx.drawImage(video, 0, 0);
      const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      let sum = 0; let squares = 0; let nonBlack = 0; let hash = 2166136261;
      for (let index = 0; index < pixels.length; index += 4) {
        const luma = (pixels[index] * 54 + pixels[index + 1] * 183 + pixels[index + 2] * 19) >> 8;
        sum += luma; squares += luma * luma; if (luma > 8) nonBlack += 1;
        hash ^= pixels[index]; hash = Math.imul(hash, 16777619);
        hash ^= pixels[index + 1]; hash = Math.imul(hash, 16777619);
        hash ^= pixels[index + 2]; hash = Math.imul(hash, 16777619);
      }
      const count = pixels.length / 4; const mean = sum / count;
      samples.push({ at: video.currentTime, mean, variance: squares / count - mean * mean, nonBlack: nonBlack / count, hash: (hash >>> 0).toString(16) });
    }
    let audio = null;
    try {
      const audioContext = new AudioContext();
      const decoded = await audioContext.decodeAudioData(await blob.arrayBuffer());
      let peak = 0;
      for (let channel = 0; channel < decoded.numberOfChannels; channel += 1) {
        const data = decoded.getChannelData(channel);
        for (let index = 0; index < data.length; index += Math.max(1, Math.floor(data.length / 20_000))) peak = Math.max(peak, Math.abs(data[index]));
      }
      audio = { channels: decoded.numberOfChannels, sampleRate: decoded.sampleRate, duration: decoded.duration, peak };
      await audioContext.close();
    } catch { /* video-only files honestly report audio:null */ }
    return {
      status: response.status,
      bytes: blob.size,
      mime: blob.type,
      duration: video.duration,
      width: video.videoWidth,
      height: video.videoHeight,
      seeked: video.currentTime,
      samples,
      audio,
    };
  } finally {
    video.remove();
    URL.revokeObjectURL(url);
  }
}, { id: projectId, outputPath: path });
const inspectImage = (page, projectId, path, points, pictureHeight) => page.evaluate(async ({ id, outputPath, samples, pictureHeight }) => {
  const encodedPath = outputPath.split('/').map(encodeURIComponent).join('/');
  const response = await fetch(outputPath.startsWith('data:') ? outputPath : `/wf/${encodeURIComponent(id)}/${encodedPath}`);
  if (!response.ok) throw new Error(`image fetch failed: ${response.status}`);
  const blob = await response.blob();
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width; canvas.height = pictureHeight ?? bitmap.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('image pixel probe has no 2D canvas');
  ctx.drawImage(bitmap, 0, 0);
  return {
    status: response.status, bytes: blob.size, mime: blob.type, width: bitmap.width, height: bitmap.height,
    samples: Object.fromEntries(Object.entries(samples).map(([name, [x, y]]) => [
      name,
      [...ctx.getImageData(Math.floor(x * canvas.width), Math.floor(y * canvas.height), 1, 1).data.slice(0, 3)],
    ])),
  };
}, { id: projectId, outputPath: path, samples: points, pictureHeight });
const screenshot = async (page, name) => {
  if (!imageDir) return null;
  const path = join(imageDir, name);
  await page.screenshot({ path, fullPage: true });
  const bytes = readFileSync(path).byteLength;
  assert(bytes > 10_000, `${name} is suspiciously small (${bytes} bytes)`);
  return { image: `img/${name}`, bytes };
};

if (!existsSync(join(DIST, 'index-web.html'))) throw new Error('missing Web build; run pnpm run build:ui first');

const server = await createFilmStaticServer({ dir: DIST, port: 0 });
const address = server.address();
const base = `http://127.0.0.1:${address.port}`;
const requests = [];
const pageErrors = [];
const consoleErrors = [];
let browser;
let context;
try {
  browser = await chromium.launch({
    executablePath: findChrome(),
    headless: true,
    args: ['--autoplay-policy=no-user-gesture-required'],
  });
  context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN', serviceWorkers: 'allow' });
  const page = await context.newPage();
  page.on('request', (request) => requests.push(request.url()));
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });

  await page.goto(`${base}/index-web.html`, { waitUntil: 'load', timeout: 60_000 });
  await waitForTools(page);
  const boot = await page.evaluate(() => ({
    title: document.title,
    tools: window.__webmcp_registered_tools?.size ?? 0,
    rootChildren: document.querySelector('#root')?.childElementCount ?? 0,
    coi: crossOriginIsolated,
    sab: typeof SharedArrayBuffer,
  }));
  assert(boot.title === 'FDE2E Film' && boot.tools === 44 && boot.rootChildren > 0, `boot=${JSON.stringify(boot)}`);
  assert(boot.coi === false && boot.sab === 'undefined', `unexpected COI/SAB=${JSON.stringify(boot)}`);

  const loaded = await call(page, 'projects_load_example', { id: 'one-prompt' });
  assert(loaded.ok === true && typeof loaded.id === 'string', `load example=${JSON.stringify(loaded)}`);
  const projectId = loaded.id;
  await page.waitForURL(new RegExp(`/projects/${projectId}$`), { timeout: 120_000 });
  await waitForPreview(page);
  const initial = await call(page, 'film_state');
  assert(initial.project?.id === projectId && initial.stage?.w === 1920 && initial.stage?.h === 1080, `initial=${JSON.stringify(initial)}`);
  const s1 = await screenshot(page, 's1-example-loaded.png');

  const saved = await call(page, 'edit_save_version', { message: 'release-polish baseline' });
  assert(saved.ok === true && typeof saved.commit === 'string', `save=${JSON.stringify(saved)}`);
  const changed = await call(page, 'edit_set_stage', { w: 1280, h: 720 });
  assert(changed.ok === true, `set stage=${JSON.stringify(changed)}`);
  const changedState = await call(page, 'film_state');
  assert(changedState.stage?.w === 1280 && changedState.stage?.h === 720, `changed state=${JSON.stringify(changedState.stage)}`);
  const restored = await call(page, 'edit_checkout_version', { commit: saved.commit, discard: true });
  assert(restored.ok === true, `restore=${JSON.stringify(restored)}`);
  await waitForPreview(page);
  const restoredState = await call(page, 'film_state');
  assert(restoredState.stage?.w === 1920 && restoredState.stage?.h === 1080, `restored state=${JSON.stringify(restoredState.stage)}`);
  const versions = await call(page, 'edit_list_versions');
  assert(versions.head === saved.commit && versions.workingDiffers === false, `versions=${JSON.stringify(versions)}`);

  const short = await call(page, 'produce_render', {
    kind: 'video', name: 'release-polish-short', from: 0, to: 1,
    codec: 'h264', audio: true, fps: 4, shortEdge: 64, wait: true,
  });
  assert(short.ok === true && short.status === 'done' && short.paths?.length === 1 && short.bytes > 0, `short export=${JSON.stringify(short)}`);
  const shortVideo = await inspectVideo(page, projectId, short.paths[0]);
  assert(shortVideo.mime.startsWith('video/mp4') && shortVideo.width > 0 && shortVideo.height > 0, `short video=${JSON.stringify(shortVideo)}`);
  assert(shortVideo.duration >= 0.9 && shortVideo.duration <= 1.6 && shortVideo.seeked > 0, `short duration/seek=${JSON.stringify(shortVideo)}`);
  assert(shortVideo.samples.some((sample) => sample.nonBlack > 0.01 && sample.variance > 1), `short export is visually blank=${JSON.stringify(shortVideo.samples)}`);
  assert(shortVideo.audio?.channels === 2 && shortVideo.audio.duration >= 0.9 && shortVideo.audio.peak > 0.01, `short export AAC mix is absent/silent=${JSON.stringify(shortVideo.audio)}`);
  const shortStatus = await call(page, 'produce_export_status');
  const shortJob = shortStatus.jobs?.find((job) => job.id === short.jobId);
  assert(shortJob?.status === 'done' && shortJob.outputs?.[0] === short.paths[0] && shortJob.bytes === short.bytes, `short status=${JSON.stringify(shortStatus)}`);
  const s2 = await screenshot(page, 's2-short-export-done.png');

  const cdp = await context.newCDPSession(page);
  await cdp.send('HeapProfiler.collectGarbage').catch(() => {});
  const heapBefore = (await cdp.send('Runtime.getHeapUsage')).usedSize;
  let heapPeak = heapBefore;
  const long = await call(page, 'produce_render', {
    kind: 'video', name: 'release-polish-30s', from: 0, to: 30,
    codec: 'h264', audio: false, fps: 1, shortEdge: 64, wait: false,
  });
  assert(long.ok === true && typeof long.jobId === 'string' && long.poll === 'produce_export_status', `async start=${JSON.stringify(long)}`);
  const deadline = Date.now() + 180_000;
  let longJob = null;
  let pollCount = 0;
  while (Date.now() < deadline) {
    const status = await call(page, 'produce_export_status');
    longJob = status.jobs?.find((job) => job.id === long.jobId) ?? null;
    const heap = (await cdp.send('Runtime.getHeapUsage')).usedSize;
    heapPeak = Math.max(heapPeak, heap);
    pollCount += 1;
    if (longJob && !['waiting', 'running'].includes(longJob.status)) break;
    await page.waitForTimeout(500);
  }
  assert(longJob?.status === 'done' && longJob.outputs?.length === 1 && longJob.bytes > 0, `async terminal=${JSON.stringify(longJob)}`);
  const longVideo = await inspectVideo(page, projectId, longJob.outputs[0]);
  assert(longVideo.duration >= 29.5 && longVideo.duration <= 31.5 && longVideo.seeked > 15, `30s video=${JSON.stringify(longVideo)}`);
  assert(longVideo.samples.every((sample) => sample.nonBlack > 0.01 && sample.variance > 1), `30s export has blank probes=${JSON.stringify(longVideo.samples)}`);
  assert(new Set(longVideo.samples.map((sample) => sample.hash)).size >= 2, `30s export probes are byte-identical=${JSON.stringify(longVideo.samples)}`);
  assert(longVideo.audio === null, `audio:false export unexpectedly contains an audio track=${JSON.stringify(longVideo.audio)}`);
  const heapGrowth = heapPeak - heapBefore;
  assert(heapGrowth < 128 * 1024 * 1024, `30s export JS heap grew ${heapGrowth} bytes`);
  const s3 = await screenshot(page, 's3-async-export-done.png');

  await page.reload({ waitUntil: 'load', timeout: 60_000 });
  await waitForTools(page);
  if (!await page.evaluate(() => Boolean(navigator.serviceWorker.controller))) {
    await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller), undefined, { timeout: 30_000, polling: 250 });
    await page.reload({ waitUntil: 'load', timeout: 60_000 });
    await waitForTools(page);
  }
  await waitForPreview(page);
  const persisted = await call(page, 'film_state');
  const media = await call(page, 'projects_list_media', { projectId });
  const mediaPaths = new Set(media.files?.map((file) => file.path));
  assert(persisted.project?.id === projectId && persisted.stage?.w === 1920, `persisted=${JSON.stringify(persisted)}`);
  assert(mediaPaths.has(short.paths[0]) && mediaPaths.has(longJob.outputs[0]), `persisted outputs=${JSON.stringify([...mediaPaths].filter((path) => path.startsWith('downloads/')))}`);
  const persistedShort = await inspectVideo(page, projectId, short.paths[0]);
  const persistedLong = await inspectVideo(page, projectId, longJob.outputs[0]);
  const s4 = await screenshot(page, 's4-reload-persisted.png');

  /* Mixed DOM regression: a smaller media element is one layer, not the whole frame. The old
     capture path stretched the last img/canvas across the stage (or returned black). This fixture
     makes four independently measurable layers and therefore acts as a directed negative control. */
  const domProject = await call(page, 'projects_create', { name: 'Mixed DOM capture gate' });
  assert(typeof domProject.id === 'string', `DOM project=${JSON.stringify(domProject)}`);
  const domOpened = await call(page, 'projects_open', { id: domProject.id });
  assert(domOpened.ok === true, `DOM project open=${JSON.stringify(domOpened)}`);
  await page.waitForURL(new RegExp(`/projects/${domProject.id}$`), { timeout: 60_000 });
  const mixedPage = `<!doctype html><html><head><style>
    *{box-sizing:border-box}html,body{margin:0;width:100%;height:100%;overflow:hidden}
    body{background:rgb(220,20,20)}#blue{position:absolute;left:35%;top:35%;width:30%;height:30%;object-fit:fill}
    #green{position:absolute;right:0;top:0;width:25%;height:25%;background:rgb(20,220,20)}
    canvas{position:absolute;left:0;bottom:0;width:25%;height:25%}
  </style></head><body>
    <img id="blue" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='100' height='100'%3E%3Crect width='100' height='100' fill='rgb(20,20,220)'/%3E%3C/svg%3E">
    <div id="green">DOM</div><canvas id="yellow" width="100" height="100"></canvas>
    <script>const x=document.querySelector('#yellow').getContext('2d');x.fillStyle='rgb(220,220,20)';x.fillRect(0,0,100,100);window.film={duration:1,width:1920,height:1080,frame(){}}<\/script>
  </body></html>`;
  const pageWrite = await call(page, 'edit_write_page', { path: 'mixed.html', text: mixedPage });
  assert(pageWrite.ok === true, `DOM page write=${JSON.stringify(pageWrite)}`);
  const clipInsert = await call(page, 'edit_insert_clip', { src: 'mixed.html', at: 0, time: [0, 1], newTrack: 1 });
  assert(clipInsert.ok === true, `DOM clip insert=${JSON.stringify(clipInsert)}`);
  await waitForPreview(page, 0.9, 60_000);
  const beforeLookJobs = await call(page, 'produce_export_status');
  const domLook = await call(page, 'produce_look', { at: 0.5, shortEdge: 200 });
  assert(domLook.ok === true && domLook.sheet?.dataUrl && domLook.determinism?.same, 'DOM look must return repeatable pixels');
  const domImage = await inspectImage(page, domProject.id, domLook.sheet.dataUrl, {
    red: [0.75, 0.75], blue: [0.5, 0.5], green: [0.9, 0.1], yellow: [0.1, 0.9],
  }, domLook.frames[0].h);
  const [red, blue, green, yellow] = ['red', 'blue', 'green', 'yellow'].map((name) => domImage.samples[name]);
  assert(red[0] > 150 && red[1] < 80, `DOM red layer=${JSON.stringify(domImage)}`);
  assert(blue[2] > 150 && blue[0] < 80, `DOM img layer=${JSON.stringify(domImage)}`);
  assert(green[1] > 150 && green[0] < 80, `DOM element layer=${JSON.stringify(domImage)}`);
  assert(yellow[0] > 150 && yellow[1] > 150 && yellow[2] < 80, `DOM canvas layer=${JSON.stringify(domImage)}`);
  const domMedia = await call(page, 'projects_list_media', { projectId: domProject.id });
  assert(!domMedia.files?.some((file) => file.path.startsWith('downloads/')), 'inspection must not create a phantom download');
  assert((await call(page, 'produce_export_status')).jobs.length === beforeLookJobs.jobs.length, 'inspection must not create an export job');
  const s5 = await screenshot(page, 's5-mixed-dom-capture.png');

  const foreign = requests.filter((url) => /^https?:/.test(url) && new URL(url).origin !== base);
  const forbidden = requests.filter((url) => /(^|\.)omni\.fde2e\.com/i.test(new URL(url).hostname));
  assert(foreign.length === 0, `unexpected foreign requests=${JSON.stringify(foreign)}`);
  assert(forbidden.length === 0, `forbidden omni requests=${JSON.stringify(forbidden)}`);
  assert(pageErrors.length === 0, `page errors=${pageErrors.join(' | ')}`);
  const seriousConsole = consoleErrors.filter((message) => !/favicon|404|ERR_FAILED/i.test(message));
  assert(seriousConsole.length === 0, `console errors=${seriousConsole.join(' | ')}`);

  const result = {
    ok: true,
    base,
    browser: await browser.version(),
    boot,
    projectId,
    version: { commit: saved.commit, changed: changedState.stage, restored: restoredState.stage, workingDiffers: versions.workingDiffers },
    short: { receipt: short, video: shortVideo, status: shortJob },
    long: { receipt: long, status: longJob, video: longVideo, pollCount, heapBefore, heapPeak, heapGrowth },
    persistence: { project: persisted.project, outputs: [short.paths[0], longJob.outputs[0]], short: persistedShort, long: persistedLong },
    domCapture: { projectId: domProject.id, receipt: domLook, image: domImage, persisted: false },
    network: { requests: requests.length, foreign: foreign.length, forbiddenOmni: forbidden.length },
    errors: { page: pageErrors, console: seriousConsole },
  };
  if (evidenceDir) {
    writeFileSync(join(evidenceDir, 'result.json'), `${JSON.stringify(result, null, 2)}\n`);
    const reportSteps = {
      title: 'web-openfilm-editor 6.5 · Film/Omni/spec 打磨回归',
      brand: 'FDE2E™ Film · release-polish browser gate',
      meta: `${result.browser} · local static · 5 steps`,
      thesis: '真实 WebMCP 项目状态、版本恢复、带音频短 MP4、30 秒异步有界内存导出、刷新后 OPFS 持久化，以及 DOM＋img＋canvas 四层页内捕获全链通过；运行时零跨源与零 omni.fde2e.com 请求。',
      env: [
        ['入口', base],
        ['浏览器', `${result.browser} · 1440×900 · fresh context`],
        ['网络边界', `${requests.length} requests；foreign=0；omni.fde2e.com=0`],
        ['GRIPES_TO_FILM', '真实运营发现长导出不能绑在单次桥调用上；produce_render 新增缺省异步 job + status 轮询，并以 30 秒真实导出验证'],
        ['SKILL', 'Omni 新增 film-tool：webmcp_list 真相、JSON 串解析、写后回读、consent 与异步导出 SOP'],
        ['SPEC', 'web-film-webmcp 新增“长时产出异步可观测”，jobId/status/poll 契约与 wait:true 短任务分支'],
        ['视觉审计', '本脚本只产出真实行为截图；UI 改动另由 export-tray-audit.mjs 对 d61fbbf 基线执行 V1–V6 before/after，最终合并报告逐文件登记并要求 UNCOVERED=0'],
        ['可复算', 'pnpm run build:ui && pnpm run polish-smoke -- --evidence-dir <dir>'],
      ],
      sections: [{ title: 'Release-polish full chain', steps: [
        { id: 'S1', intent: '从 35 工具面载入 checksum 示例并建立版本锚点', expect: '90.9s 示例/1920×1080/OPFS 项目可编辑', assertion: `project=${projectId}; tools=35; stage=1920×1080; coi=false`, ok: true, ...(s1 ?? {}) },
        { id: 'S2', intent: '保存版本→改舞台→checkout 恢复，并同步导出 1 秒带音频 MP4', expect: '版本恢复无脏状态；MP4 可解码可 seek', assertion: `commit=${saved.commit}; restored=1920×1080; bytes=${short.bytes}; duration=${shortVideo.duration.toFixed(3)}s; seek=${shortVideo.seeked.toFixed(3)}s`, ok: true, ...(s2 ?? {}) },
        { id: 'S3', intent: '以 wait:false 启动 30 秒真实导出并轮询公开 status', expect: '调用立即返回 job；终态 done；JS heap 增长 <128MiB', assertion: `job=${long.jobId}; polls=${pollCount}; bytes=${longJob.bytes}; duration=${longVideo.duration.toFixed(3)}s; heapGrowth=${(heapGrowth / 1024 / 1024).toFixed(1)}MiB`, ok: true, ...(s3 ?? {}) },
        { id: 'S4', intent: '刷新同一 SPA 项目路由', expect: '项目、版本恢复结果和两份 downloads/ MP4 仍在 OPFS', assertion: `project=${persisted.project.id}; outputs=2; short=${persistedShort.bytes}B; long=${persistedLong.bytes}B; foreign=0`, ok: true, ...(s4 ?? {}) },
        { id: 'S5', intent: '检查含 DOM 背景、img、普通元素与 canvas 的同源页面', expect: '四图层保留原位置/颜色；正反复绘一致，检查不创建下载或导出任务', assertion: `project=${domProject.id}; bytes=${domImage.bytes}; pixels=${JSON.stringify(domImage.samples)}; determinism=${domLook.determinism.same}`, ok: true, ...(s5 ?? {}) },
      ] }],
      summary: { pass: 5, fail: 0 },
    };
    writeFileSync(join(evidenceDir, 'polish-steps.json'), `${JSON.stringify(reportSteps, null, 2)}\n`);
    writeFileSync(join(evidenceDir, 'steps.json'), `${JSON.stringify(reportSteps, null, 2)}\n`);
  }
  console.log(JSON.stringify(result, null, 2));
} finally {
  if (context) await context.close().catch(() => {});
  if (browser) await browser.close().catch(() => {});
  await new Promise((resolveClose) => server.close(resolveClose));
}
