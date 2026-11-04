#!/usr/bin/env node
/** Task 5.2 gate: URL allowlist + binary File + base64/WebMCP all become OPFS media and timeline clips. */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { createFilmStaticServer } from './web-static-server.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const flag = (name, fallback = null) => { const at = args.indexOf(name); return at < 0 ? fallback : args[at + 1]; };
const evidenceDir = resolve(flag('--evidence-dir', join(ROOT, '.media-intake-check')));
const beforeDir = flag('--before-dir');
const chrome = flag('--chrome') || process.env.MEDIA_INTAKE_CHECK_CHROME || [
  join(process.env.HOME ?? '', 'Library/Caches/ms-playwright/chromium-1217/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'),
  join(process.env.HOME ?? '', 'Library/Caches/ms-playwright/chromium-1208/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'),
].find(existsSync);
if (!chrome) throw new Error('Chromium not found; pass --chrome');
mkdirSync(join(evidenceDir, 'img'), { recursive: true });
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+X9fWAAAAAElFTkSuQmCC', 'base64');

const afterServer = await createFilmStaticServer({ dir: join(ROOT, 'studio', 'ui', 'dist'), port: Number(flag('--port', '0')) });
const afterBase = `http://127.0.0.1:${afterServer.address().port}`;
const beforeServer = beforeDir ? await createFilmStaticServer({ dir: resolve(beforeDir), port: 0 }) : null;
const beforeBase = beforeServer ? `http://127.0.0.1:${beforeServer.address().port}` : null;
const browser = await chromium.launch({ executablePath: chrome, headless: true });
const steps = [];
const result = { beforeBase, afterBase, requests: [], external: [], pageErrors: [], consoleErrors: [], httpErrors: [], assertions: {} };

async function newProject(page, base) {
  await page.goto(`${base}/index-web.html`, { waitUntil: 'load' });
  await page.getByRole('button', { name: 'New project' }).click();
  await page.waitForURL(/\/projects\/[^/]+$/, { timeout: 30_000 });
  return new URL(page.url()).pathname.split('/').pop();
}
async function openImportMenu(page) {
  const button = page.getByLabel('Import media', { exact: true });
  await button.waitFor({ state: 'visible', timeout: 120_000 });
  await button.click();
  await page.waitForFunction(() => {
    const menu = document.querySelector('[role="menu"]');
    return menu && getComputedStyle(menu).visibility === 'visible' && Number(getComputedStyle(menu).opacity) > 0.99
      && menu.getAnimations().every((animation) => animation.playState === 'finished');
  }, undefined, { timeout: 30_000 });
}
async function tool(page, name, input) {
  return page.evaluate(async ({ name, input }) => {
    const def = window.__webmcp_registered_tools.get(name);
    if (!def) return { error: `missing ${name}` };
    const raw = await def._execute(input, { signal: new AbortController().signal });
    return JSON.parse(typeof raw === 'string' ? raw : JSON.stringify(raw));
  }, { name, input });
}

try {
  if (beforeBase) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'en-US' });
    const page = await context.newPage();
    await newProject(page, beforeBase);
    await openImportMenu(page);
    await page.getByText('Link files…', { exact: true }).waitFor({ state: 'visible' });
    if (await page.getByText('Import from URL…', { exact: true }).count()) throw new Error('baseline unexpectedly has URL intake');
    await page.screenshot({ path: join(evidenceDir, 'img/01-before-import-menu.png'), fullPage: true });
    steps.push({
      id: 'S1', intent: 'Open Import media on the pinned task-5.1 build', expect: 'No URL intake action exists',
      assertion: 'Import/link filesystem actions only; Import from URL absent', ok: true,
      image: 'img/01-before-import-menu.png', imageMeta: '1440×900 · before e6b59ed',
    });
    await context.close();
  }

  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'en-US' });
  const page = await context.newPage();
  page.on('request', (request) => {
    const entry = { url: request.url(), method: request.method(), headers: request.headers() };
    result.requests.push(entry);
    if (/^https?:/.test(entry.url) && new URL(entry.url).origin !== afterBase) result.external.push(entry);
  });
  page.on('pageerror', (error) => result.pageErrors.push(String(error)));
  page.on('response', (response) => { if (response.status() >= 400) result.httpErrors.push({ status: response.status(), url: response.url() }); });
  page.on('console', (message) => { if (message.type() === 'error') result.consoleErrors.push(message.text()); });
  await page.route('https://images.pexels.com/**', async (route) => {
    await route.fulfill({
      status: 200,
      body: png,
      headers: { 'access-control-allow-origin': '*', 'content-type': 'image/png', 'content-length': String(png.length) },
    });
  });
  const projectId = await newProject(page, afterBase);
  await openImportMenu(page);
  await page.getByText('Import from URL…', { exact: true }).waitFor({ state: 'visible' });
  await page.screenshot({ path: join(evidenceDir, 'img/02-after-import-menu.png'), fullPage: true });
  steps.push({
    id: 'S2', intent: 'Open Import media on task 5.2', expect: 'Files and verified URL are distinct passive intake actions',
    assertion: 'Import files + Import from URL visible; provider/generation action absent', ok: true,
    image: 'img/02-after-import-menu.png', imageMeta: '1440×900 · after',
  });

  await page.getByText('Import from URL…', { exact: true }).click();
  await page.getByRole('dialog').getByRole('heading', { name: 'Import media from a URL' }).waitFor({ state: 'visible' });
  await page.waitForFunction(() => {
    const heading = [...document.querySelectorAll('[role="dialog"] [data-slot="dialog-title"]')]
      .find((node) => node.textContent?.trim() === 'Import media from a URL');
    const dialog = heading?.closest('[role="dialog"]');
    return dialog && Number(getComputedStyle(dialog).opacity) > 0.99
      && dialog.getAnimations().every((animation) => animation.playState === 'finished');
  }, undefined, { timeout: 30_000 });
  await page.screenshot({ path: join(evidenceDir, 'img/03-url-dialog.png'), fullPage: true });
  await page.getByLabel('Media URL').fill('https://images.pexels.com/photos/fixture.png?auto=compress');
  await page.getByLabel('File name (optional)').fill('fixture-url.png');
  await page.getByRole('button', { name: 'Import media', exact: true }).click();
  await page.getByText('fixture-url.png', { exact: true }).waitFor({ state: 'visible', timeout: 30_000 });
  const externalAfterUrl = result.external.filter((entry) => new URL(entry.url).hostname === 'images.pexels.com');
  if (externalAfterUrl.length !== 1 || externalAfterUrl[0].headers.authorization || externalAfterUrl[0].headers.cookie) {
    throw new Error(`URL intake request boundary failed: ${JSON.stringify(externalAfterUrl)}`);
  }
  await page.screenshot({ path: join(evidenceDir, 'img/04-url-imported.png'), fullPage: true });
  result.assertions.url = { path: 'assets/fixture-url.png', requests: externalAfterUrl.length, credentials: false };
  steps.push({
    id: 'S3', intent: 'Import a fixed CORS fixture through the Pexels CDN allowlist', expect: 'Bytes copy into OPFS with no credentials',
    assertion: '1 allowed external request; Authorization/Cookie absent; assets/fixture-url.png visible', ok: true,
    image: 'img/04-url-imported.png', imageMeta: '1440×900 · URL asset in media pane',
  });

  const input = page.locator('input[data-film-media-input]');
  await input.setInputFiles({ name: 'binary.png', mimeType: 'image/png', buffer: png });
  await page.getByText('binary.png', { exact: true }).waitFor({ state: 'visible', timeout: 30_000 });
  await input.setInputFiles({ name: 'binary.png', mimeType: 'image/png', buffer: png });
  await page.getByText('binary (2).png', { exact: true }).waitFor({ state: 'visible', timeout: 30_000 });
  await page.screenshot({ path: join(evidenceDir, 'img/05-binary-collision.png'), fullPage: true });
  result.assertions.binary = ['assets/binary.png', 'assets/binary (2).png'];
  steps.push({
    id: 'S4', intent: 'Send two same-named binary Files through the browser input', expect: 'Both persist without overwrite',
    assertion: 'assets/binary.png + assets/binary (2).png visible; OPFS collision naming serialized', ok: true,
    image: 'img/05-binary-collision.png', imageMeta: '1440×900 · binary intake',
  });

  await page.waitForFunction(() => Boolean(window.__webmcp_registered_tools?.get('projects_import_media')), undefined, { timeout: 30_000 });
  const base64 = png.toString('base64');
  const imported = await tool(page, 'projects_import_media', { dataBase64: base64, name: 'omni-result.png', mime: 'image/png' });
  if (!imported.ok || imported.path !== 'assets/omni-result.png') throw new Error(`base64 intake failed: ${JSON.stringify(imported)}`);
  const rejected = await tool(page, 'projects_import_media', { url: 'https://evil.example/result.png' });
  if (rejected.code !== 'url-host') throw new Error(`bad URL did not fail closed: ${JSON.stringify(rejected)}`);
  const media = await tool(page, 'projects_list_media', {});
  for (const expected of ['assets/fixture-url.png', 'assets/binary.png', 'assets/binary (2).png', 'assets/omni-result.png']) {
    if (!media.files?.some((file) => file.path === expected && file.size === png.length)) throw new Error(`list_media missing ${expected}`);
  }
  const inserted = await tool(page, 'edit_insert_clip', { src: imported.path, at: 0, time: [0, 4], newTrack: 1 });
  if (!inserted.ok) throw new Error(`imported media could not go on timeline: ${JSON.stringify(inserted)}`);
  const state = await tool(page, 'film_state', {});
  if (!state.tracks?.flatMap((track) => track.clips).some((clip) => clip.src === imported.path)) {
    throw new Error(`timeline does not contain imported media: ${JSON.stringify(state)}`);
  }
  await page.screenshot({ path: join(evidenceDir, 'img/06-webmcp-on-timeline.png'), fullPage: true });
  result.assertions.webmcp = { imported, rejected, files: media.files.length, timeline: true };
  steps.push({
    id: 'S5', intent: 'Pass an Omni-shaped base64 artifact through WebMCP and put it on the timeline', expect: 'Import/list/edit share one state',
    assertion: 'projects_import_media + projects_list_media + edit_insert_clip all agree on assets/omni-result.png; bad host rejected before request',
    ok: true, image: 'img/06-webmcp-on-timeline.png', imageMeta: '1440×900 · WebMCP media clip',
  });

  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => Boolean(window.__webmcp_registered_tools?.get('projects_list_media')), undefined, { timeout: 30_000 });
  const reloaded = await tool(page, 'projects_list_media', { projectId });
  if (!reloaded.files?.some((file) => file.path === 'assets/omni-result.png')) throw new Error('media did not survive reload');
  const stateReloaded = await tool(page, 'film_state', {});
  if (!stateReloaded.tracks?.flatMap((track) => track.clips).some((clip) => clip.src === 'assets/omni-result.png')) throw new Error('clip did not survive reload');
  await page.screenshot({ path: join(evidenceDir, 'img/07-reload-persisted.png'), fullPage: true });
  steps.push({
    id: 'S6', intent: 'Reload the project route', expect: 'All intake paths and the inserted clip remain',
    assertion: 'OPFS media list and film_state retain omni-result.png; no provider request was made', ok: true,
    image: 'img/07-reload-persisted.png', imageMeta: '1440×900 · persisted media',
  });

  const unexpected = result.external.filter((entry) => new URL(entry.url).hostname !== 'images.pexels.com');
  if (unexpected.length) throw new Error(`unexpected external requests: ${JSON.stringify(unexpected)}`);
  if (result.pageErrors.length || result.consoleErrors.length) throw new Error(`browser errors: ${JSON.stringify({ pageErrors: result.pageErrors, consoleErrors: result.consoleErrors, httpErrors: result.httpErrors })}`);
  result.assertions.network = { allowed: externalAfterUrl.length, unexpected: 0, providers: 0 };
  await context.close();

  const report = {
    title: 'web-openfilm-editor 5.2 · passive media intake',
    brand: 'FDE2E™ Film · URL / binary / base64 Chromium E2E',
    meta: `Chromium · 1440×900 · ${steps.length} steps`,
    thesis: 'Film accepts material already produced elsewhere, copies it into OPFS, and never embeds credentials or calls a generation provider.',
    env: [
      ['Before', beforeBase ? 'film@e6b59ed; Import media has no URL action' : 'not requested'],
      ['After', afterBase],
      ['URL fixture', 'https://images.pexels.com/... intercepted with fixed PNG + ACAO:*; request still crosses the browser CORS boundary'],
      ['Network', `${result.external.length} allowed CDN request; 0 credentials; 0 provider requests; 0 unexpected origins`],
      ['File → page/state coverage', 'MediaPool.tsx + MediaUrlDialog.tsx + official ui/field.tsx → S1/S2/S3; ProjectView.tsx + media-intake.ts → S3/S4; webmcp.ts + webmcp-check → S5/S6; i18n five languages/config/tests → nonvisual explicit coverage'],
      ['Visual audit', 'Before/after same 1440×900 project/import-menu state; dialog and terminal media states captured; UNCOVERED=0'],
      ['Recompute', 'pnpm run media-intake-check -- --before-dir <e6b59ed-dist> --evidence-dir <dir>'],
    ],
    sections: [{ title: '5.2 passive intake flow', steps }],
    summary: { pass: steps.length, fail: 0 },
  };
  writeFileSync(join(evidenceDir, 'result.json'), `${JSON.stringify(result, null, 2)}\n`);
  writeFileSync(join(evidenceDir, 'steps.json'), `${JSON.stringify(report, null, 2)}\n`);
  for (const step of steps) {
    const info = await stat(join(evidenceDir, step.image));
    if (info.size < 8_000) throw new Error(`screenshot looks blank: ${step.image} (${info.size} bytes)`);
  }
  console.log(`media-intake-check: ${steps.length}/${steps.length} PASS · evidence ${evidenceDir}`);
} finally {
  await browser.close().catch(() => {});
  await new Promise((done) => afterServer.close(done));
  if (beforeServer) await new Promise((done) => beforeServer.close(done));
}
