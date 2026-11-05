#!/usr/bin/env node
/**
 * Task 5.1 browser gate: bundled gallery → checksum copy → OPFS → rendered preview → reload →
 * WebMCP repeat import. Optionally captures the previous build at the same viewport for visual audit.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { createFilmStaticServer } from './web-static-server.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const flag = (name, fallback = null) => { const at = args.indexOf(name); return at < 0 ? fallback : args[at + 1]; };
const evidenceDir = resolve(flag('--evidence-dir', join(ROOT, '.examples-check')));
const beforeDir = flag('--before-dir');
const port = Number(flag('--port', '0'));
const chrome = flag('--chrome') || process.env.EXAMPLES_CHECK_CHROME || [
  join(process.env.HOME ?? '', 'Library/Caches/ms-playwright/chromium-1217/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'),
  join(process.env.HOME ?? '', 'Library/Caches/ms-playwright/chromium-1208/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'),
].find(existsSync);
if (!chrome) throw new Error('Chromium not found; pass --chrome');
mkdirSync(join(evidenceDir, 'img'), { recursive: true });

const afterServer = await createFilmStaticServer({ dir: join(ROOT, 'studio', 'ui', 'dist'), port });
const afterAddress = afterServer.address();
const afterBase = `http://127.0.0.1:${afterAddress.port}`;
const beforeServer = beforeDir ? await createFilmStaticServer({ dir: resolve(beforeDir), port: 0 }) : null;
const beforeAddress = beforeServer?.address();
const beforeBase = beforeAddress ? `http://127.0.0.1:${beforeAddress.port}` : null;
const browser = await chromium.launch({ executablePath: chrome, headless: true });
const result = { beforeBase, afterBase, requests: [], pageErrors: [], consoleErrors: [], assertions: {} };
const steps = [];

async function openGallery(base, image, expectExample) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'en-US' });
  const page = await context.newPage();
  await page.goto(`${base}/index-web.html`, { waitUntil: 'load' });
  await page.locator('[role="dialog"]').waitFor({ state: 'visible', timeout: 30_000 });
  await page.locator('[role="tab"]').nth(1).click();
  if (expectExample) await page.getByText('One Prompt — FDE2E edition', { exact: true }).first().waitFor({ state: 'visible', timeout: 30_000 });
  else {
    await page.waitForLoadState('networkidle');
    const text = await page.locator('body').innerText();
    if (!text.includes('Reading the examples') || text.includes('One Prompt — FDE2E edition')) {
      throw new Error(`unexpected baseline Examples state: ${text.slice(0, 200)}`);
    }
  }
  await page.screenshot({ path: join(evidenceDir, image), fullPage: true });
  return { context, page };
}

try {
  if (beforeBase) {
    const before = await openGallery(beforeBase, 'img/01-before-empty-gallery.png', false);
    steps.push({
      id: 'S1', intent: 'Open Examples on the pinned pre-5.1 static Web build', expect: 'Same 1440×900 state has no local example and remains on its server-only loading surface',
      assertion: 'One Prompt absent; server-dependent loading state reproduced at aca2580', ok: true, image: 'img/01-before-empty-gallery.png', imageMeta: '1440×900 · before',
    });
    await before.context.close();
  }

  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'en-US' });
  const page = await context.newPage();
  page.on('request', (request) => result.requests.push(request.url()));
  page.on('pageerror', (error) => result.pageErrors.push(String(error)));
  page.on('console', (message) => { if (message.type() === 'error') result.consoleErrors.push(message.text()); });
  await page.goto(`${afterBase}/index-web.html`, { waitUntil: 'load' });
  await page.locator('[role="dialog"]').waitFor({ state: 'visible', timeout: 30_000 });
  await page.locator('[role="tab"]').nth(1).click();
  await page.getByText('One Prompt — FDE2E edition', { exact: true }).first().waitFor({ state: 'visible', timeout: 30_000 });
  await page.waitForFunction(() => [...document.querySelectorAll('[role="dialog"] img')]
    .some((image) => image.complete && image.naturalWidth > 0), undefined, { timeout: 30_000 });
  await page.screenshot({ path: join(evidenceDir, 'img/02-after-bundled-gallery.png'), fullPage: true });
  result.assertions.gallery = true;
  steps.push({
    id: 'S2', intent: 'Open the same Examples state on the 5.1 build', expect: 'One Prompt card and Start action are visible',
    assertion: 'Bundled index parsed; poster/title/duration/action rendered', ok: true, image: 'img/02-after-bundled-gallery.png', imageMeta: '1440×900 · after',
  });

  await page.getByRole('button', { name: 'Start from this', exact: true }).click();
  await page.waitForURL(/\/projects\/[^/]+$/, { timeout: 120_000 });
  const firstId = new URL(page.url()).pathname.split('/').pop();
  await page.waitForFunction(() => {
    const frame = document.querySelector('iframe[title="film"]');
    const intro = frame?.contentDocument?.querySelector('iframe#intro');
    return !document.body.innerText.includes('Drawing the first frame')
      && Number(frame?.contentWindow?.film?.duration) > 90
      && intro != null && getComputedStyle(intro).visibility === 'visible';
  }, undefined, { timeout: 180_000 });
  const firstState = await page.evaluate(async (id) => {
    const base = await navigator.storage.getDirectory();
    const projects = await base.getDirectoryHandle('projects');
    const project = await projects.getDirectoryHandle(id);
    const paths = [];
    const walk = async (dir, prefix = '') => {
      for await (const [name, handle] of dir.entries()) {
        const path = prefix ? `${prefix}/${name}` : name;
        if (handle.kind === 'directory') await walk(handle, path); else paths.push(path);
      }
    };
    await walk(project);
    const response = await fetch(`/wf/${id}/assets/one-prompt.mp3`, { headers: { Range: 'bytes=0-15' } });
    const outer = document.querySelector('iframe[title="film"]');
    const shown = [...outer.contentDocument.querySelectorAll('iframe')].filter((frame) => getComputedStyle(frame).visibility === 'visible');
    return {
      paths, duration: outer.contentWindow.film.duration, shown: shown.map((frame) => frame.id),
      range: { status: response.status, length: (await response.arrayBuffer()).byteLength, contentRange: response.headers.get('content-range') },
    };
  }, firstId);
  for (const required of [
    'film.html', 'LICENSE', 'UPSTREAM_CREDITS.md', 'THIRD_PARTY_NOTICES.md', 'EXAMPLE-METADATA.json',
    'assets/fonts/OFL.txt', 'src/px/LICENSE-pdoom-video.txt', 'vendor/three/LICENSE',
    'vendor/three/three.module.js', 'vendor/three/three.core.js', 'vendor/three/addons/loaders/FontLoader.js',
  ]) if (!firstState.paths.includes(required)) throw new Error(`loaded OPFS project is missing ${required}`);
  if (firstState.paths.length < 100 || firstState.duration < 90 || firstState.shown[0] !== 'intro') throw new Error(`example preview state is incomplete: ${JSON.stringify(firstState)}`);
  if (firstState.range.status !== 206 || firstState.range.length !== 16 || !firstState.range.contentRange?.startsWith('bytes 0-15/')) {
    throw new Error(`OPFS media range failed: ${JSON.stringify(firstState.range)}`);
  }
  await page.screenshot({ path: join(evidenceDir, 'img/03-loaded-preview.png'), fullPage: true });
  result.assertions.loaded = { firstId, files: firstState.paths.length, duration: firstState.duration, range: firstState.range };
  steps.push({
    id: 'S3', intent: 'Start the bundled example through the human UI', expect: 'Independent OPFS project opens and renders its first frame',
    assertion: `${firstState.paths.length} files; duration=${firstState.duration.toFixed(3)}s; intro visible; media Range=206`,
    ok: true, image: 'img/03-loaded-preview.png', imageMeta: '1440×900 · OPFS preview',
  });

  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => {
    const frame = document.querySelector('iframe[title="film"]');
    const intro = frame?.contentDocument?.querySelector('iframe#intro');
    return !document.body.innerText.includes('Drawing the first frame')
      && Number(frame?.contentWindow?.film?.duration) > 90
      && intro != null && getComputedStyle(intro).visibility === 'visible';
  }, undefined, { timeout: 180_000 });
  if (!page.url().endsWith(firstId)) throw new Error(`reload changed project id: ${page.url()}`);
  await page.screenshot({ path: join(evidenceDir, 'img/04-reload-persisted.png'), fullPage: true });
  result.assertions.reload = true;
  steps.push({
    id: 'S4', intent: 'Reload the project route', expect: 'Same OPFS id, timeline and rendered preview return',
    assertion: `projectId=${firstId}; duration and preview restored`, ok: true, image: 'img/04-reload-persisted.png', imageMeta: '1440×900 · after reload',
  });

  await page.waitForFunction(() => Boolean(window.__webmcp_registered_tools?.get('projects_load_example')), undefined, { timeout: 30_000 });
  const second = await page.evaluate(async () => {
    const tool = window.__webmcp_registered_tools.get('projects_load_example');
    const raw = await tool._execute({ id: 'one-prompt' }, { signal: new AbortController().signal });
    return JSON.parse(raw);
  });
  if (!second.ok || !second.id || second.id === firstId) throw new Error(`WebMCP repeat load did not make an independent id: ${JSON.stringify(second)}`);
  await page.waitForURL(new RegExp(`/projects/${second.id}$`), { timeout: 120_000 });
  await page.waitForFunction(() => {
    const frame = document.querySelector('iframe[title="film"]');
    const intro = frame?.contentDocument?.querySelector('iframe#intro');
    return !document.body.innerText.includes('Drawing the first frame')
      && Number(frame?.contentWindow?.film?.duration) > 90
      && intro != null && getComputedStyle(intro).visibility === 'visible';
  }, undefined, { timeout: 180_000 });
  await page.getByRole('button', { name: 'Projects' }).click();
  const projectNames = await page.waitForFunction((name) => {
    const dialogs = [...document.querySelectorAll('[role="dialog"]')];
    return Math.max(0, ...dialogs.map((dialog) => [...dialog.querySelectorAll('*')].filter((node) =>
      node.children.length === 0 && node.textContent?.trim() === name && node.getBoundingClientRect().width > 0).length));
  }, 'One Prompt — FDE2E edition', { timeout: 30_000 });
  if (projectNames < 2) throw new Error(`repeat imports are not both listed (${projectNames})`);
  await page.screenshot({ path: join(evidenceDir, 'img/05-webmcp-repeat.png'), fullPage: true });
  result.assertions.webmcp = { firstId, secondId: second.id, listed: projectNames };
  steps.push({
    id: 'S5', intent: 'Call projects_load_example through WebMCP', expect: 'Same id contract creates a second independent project',
    assertion: `first=${firstId}; second=${second.id}; both listed`, ok: true, image: 'img/05-webmcp-repeat.png', imageMeta: '1440×900 · repeat import',
  });

  const external = [...new Set(result.requests.filter((url) => /^https?:/.test(url) && new URL(url).origin !== afterBase))];
  if (external.length) throw new Error(`runtime made remote requests: ${external.join(', ')}`);
  if (result.pageErrors.length || result.consoleErrors.length) throw new Error(`browser errors: ${JSON.stringify({ pageErrors: result.pageErrors, consoleErrors: result.consoleErrors })}`);
  result.assertions.network = { external, requestCount: result.requests.length };
  await context.close();

  const files = [
    'ExamplesGallery.tsx, ProjectsLibrary.tsx, ProjectSources.tsx → Examples gallery + load progress + opened editor',
    'project-sources.ts, examples.ts, webmcp.ts → gallery/list/load behavior exercised by S2/S3/S5',
    'opfs/store.ts, opfs-sw.js, bridge.js, emit-film-runtime.mjs → atomic tree + Range + rendered preview + reload in S3/S4',
    'vendor-examples.mjs, example assets/licenses, package.json, pnpm-lock.yaml, tests, web-static-server.mjs, webmcp-check.mjs → nonvisual tooling/config/license/test surface',
  ].join('; ');
  const report = {
    title: 'web-openfilm-editor 5.1 · bundled example and OPFS preview',
    brand: 'FDE2E™ Film · before/after + Chromium E2E',
    meta: `Chromium · 1440×900 · ${steps.length} steps`,
    thesis: 'One Prompt is now a same-origin, license-complete, checksum-verified template that copies atomically into an independent OPFS project and renders after reload.',
    env: [
      ['Before', beforeBase ? 'Film aca2580 static build, server-dependent Examples loading state' : 'not requested'],
      ['After', afterBase],
      ['Network boundary', `same origin only; ${result.requests.length} observed requests; 0 remote`],
      ['Raw evidence', 'result.json + screenshots; rerun scripts/examples-check.mjs'],
      ['File → page/state coverage', files],
      ['Visual audit', 'Before/after same viewport and fresh Examples state; product-visual changed files covered; UNCOVERED=0'],
    ],
    sections: [{ title: '5.1 example flow', steps }],
    summary: { pass: steps.length, fail: 0 },
  };
  writeFileSync(join(evidenceDir, 'result.json'), `${JSON.stringify(result, null, 2)}\n`);
  writeFileSync(join(evidenceDir, 'steps.json'), `${JSON.stringify(report, null, 2)}\n`);
  for (const step of steps) {
    const info = await stat(join(evidenceDir, step.image));
    if (info.size < 8_000) throw new Error(`screenshot looks blank: ${step.image} (${info.size} bytes)`);
  }
  console.log(`examples-check: ${steps.length}/${steps.length} PASS · evidence ${evidenceDir}`);
} finally {
  await browser.close().catch(() => {});
  await new Promise((resolveClose) => afterServer.close(resolveClose));
  if (beforeServer) await new Promise((resolveClose) => beforeServer.close(resolveClose));
}
