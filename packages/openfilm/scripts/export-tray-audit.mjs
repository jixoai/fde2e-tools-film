#!/usr/bin/env node
/** Paired visual audit for the Web export dialog and completed-job action. */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { createFilmStaticServer } from './web-static-server.mjs';

const argv = process.argv.slice(2);
const flag = (name) => { const at = argv.indexOf(name); return at < 0 ? null : argv[at + 1]; };
const beforeDir = resolve(flag('--before-dir') ?? '');
const afterDir = resolve(flag('--after-dir') ?? join(import.meta.dirname, '../studio/ui/dist'));
const evidenceDir = resolve(flag('--evidence-dir') ?? 'e2e-out/export-tray-audit');
for (const [label, dir] of [['before', beforeDir], ['after', afterDir]]) {
  if (!dir || !existsSync(join(dir, 'index-web.html'))) throw new Error(`${label} build misses index-web.html: ${dir}`);
}
const imageDir = join(evidenceDir, 'img'); mkdirSync(imageDir, { recursive: true });
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const findChrome = () => {
  const explicit = flag('--chrome') || process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  if (explicit && existsSync(explicit)) return explicit;
  const cache = join(homedir(), 'Library', 'Caches', 'ms-playwright');
  const found = (existsSync(cache) ? readdirSync(cache).filter((name) => /^chromium-\d+$/.test(name)).sort() : []).at(-1);
  const mac = found && join(cache, found, 'chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing');
  return mac && existsSync(mac) ? mac : chromium.executablePath();
};
const screenshot = async (page, file) => {
  const path = join(imageDir, file); await page.screenshot({ path, fullPage: true });
  assert(readFileSync(path).byteLength > 10_000, `${file} is suspiciously blank`);
  return `img/${file}`;
};
const openImageExport = async (page) => {
  await page.getByRole('button', { name: '导出', exact: true }).click();
  await page.getByText('图片', { exact: true }).last().click();
  await page.getByText('每个镜头中间', { exact: true }).click();
  const button = page.locator('button').filter({ hasText: '导出 8 个文件' });
  await button.waitFor({ state: 'visible', timeout: 30_000 });
  return button;
};
const dialogState = async (page, button) => ({
  disabled: await button.isDisabled(),
  saveTo: await page.locator('button[aria-label^="保存到:"]').getAttribute('aria-label'),
  overflow: await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth),
});
const closeDialog = async (page) => page.getByRole('button', { name: '关闭', exact: true }).click();
const zipNames = (bytes) => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const names = [];
  for (let at = 0; at + 46 <= bytes.length;) {
    if (view.getUint32(at, true) !== 0x02014b50) { at += 1; continue; }
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    names.push(new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLength)));
    at += 46 + nameLength + extraLength + commentLength;
  }
  return names;
};

const browser = await chromium.launch({ executablePath: findChrome(), headless: true });
const browserVersion = browser.version();
const results = [];
try {
  for (const [label, dir] of [['before', beforeDir], ['after', afterDir]]) {
    const server = await createFilmStaticServer({ dir, port: 0 });
    const base = `http://127.0.0.1:${server.address().port}`;
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN', serviceWorkers: 'allow' });
    const page = await context.newPage(); const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    if (label === 'before') {
      /* The old Web build called server-only About/Storage endpoints and otherwise crashed before
         the state could be audited. Supply frozen read fixtures only, so its 0.2.7 UI can be
         captured as the directed defect-state artifact; no write path is faked. */
      await page.route('**/api/version*', (route) => route.fulfill({ json: { version: '0.2.7', latest: null, newer: false, checkedAt: null, checking: false, source: false } }));
      await page.route('**/api/prefs*', (route) => route.fulfill({ json: { proxies: { on: false, height: 720 }, seenVersion: '0.2.7', projectsFolder: null, keys: {}, autoVersions: false } }));
      await page.route('**/api/locations*', (route) => route.fulfill({ json: { projects: { path: 'OPFS', default: 'OPFS', chosen: false, free: null, count: 1 } } }));
    }
    try {
      await page.goto(`${base}/index-web.html`, { waitUntil: 'load', timeout: 60_000 });
      await page.waitForFunction(() => window.__webmcp_registered_tools?.size === 44, undefined, { timeout: 60_000 });
      const example = await page.evaluate(async () => JSON.parse(await window.__webmcp_registered_tools.get('projects_load_example')._execute({ id: 'one-prompt' }, { signal: new AbortController().signal })));
      assert(example.ok === true, `${label} example=${JSON.stringify(example)}`);
      await page.waitForURL(new RegExp(`/projects/${example.id}$`), { timeout: 120_000 });
      await page.waitForFunction(() => Number(document.querySelector('iframe[title="film"]')?.contentWindow?.film?.duration) > 90, undefined, { timeout: 180_000 });

      let release = null;
      if (label === 'before') {
        await page.evaluate(() => window.dispatchEvent(new CustomEvent('openfilm:whats-new')));
        await page.waitForTimeout(250);
        const releaseImage = await screenshot(page, '05-before-whats-new-unavailable.png');
        release = { notesVisible: await page.locator('[role="dialog"]').filter({ hasText: /新内容|new/i }).count() > 0, releaseImage };
        assert(release.notesVisible === false, `old Web build unexpectedly mounted release notes: ${JSON.stringify(release)}`);
      } else {
        const settings = page.locator('button[aria-label="设置"]');
        await settings.waitFor({ state: 'visible', timeout: 30_000 });
        await settings.click({ force: true });
        const settingsDialog = page.getByRole('dialog');
        await settingsDialog.waitFor({ state: 'visible', timeout: 30_000 });
        const settingsText = await settingsDialog.innerText();
        const aboutImage = await screenshot(page, '07-after-web-about.png');
        const whatsNew = settingsDialog.getByText('查看本次更新内容', { exact: true });
        await whatsNew.click();
        const releaseDialog = page.locator('[role="dialog"]').filter({ hasText: '0.3.0' }).last();
        await releaseDialog.waitFor({ state: 'visible', timeout: 30_000 });
        const releaseText = await releaseDialog.innerText();
        const releaseImage = await screenshot(page, '06-after-whats-new.png');
        release = { settingsText, releaseText, aboutImage, releaseImage };
        assert(settingsText.includes('FDE2E Film 0.3.0'), `Web About=${settingsText}`);
        assert(releaseText.includes('35 项 WebMCP') && releaseText.includes('有界内存'), `Web release notes=${releaseText}`);
        await page.keyboard.press('Escape');
        await page.keyboard.press('Escape');
      }

      let exportButton = await openImageExport(page);
      const dialog = await dialogState(page, exportButton);
      const dialogImage = await screenshot(page, label === 'before' ? '01-before-export-disabled.png' : '02-after-export-enabled.png');
      if (label === 'before') {
        assert(dialog.disabled && dialog.saveTo?.includes('—'), `before dialog=${JSON.stringify(dialog)}`);
        await closeDialog(page);
        await page.evaluate(() => localStorage.setItem('openfilm.exportCenter.v1', JSON.stringify({ folder: 'downloads' })));
        exportButton = await openImageExport(page);
        assert(!await exportButton.isDisabled(), 'baseline workaround failed to enable export');
      } else {
        assert(!dialog.disabled && dialog.saveTo?.includes('downloads'), `after dialog=${JSON.stringify(dialog)}`);
      }

      await exportButton.click();
      await page.locator('[role="dialog"]').waitFor({ state: 'hidden', timeout: 30_000 });
      await page.waitForFunction(() => [...document.querySelectorAll('div.fixed')].some((node) => /导出完成|导出失败/.test(node.textContent ?? '')), undefined, { timeout: 120_000, polling: 250 });
      const tray = await page.evaluate(() => {
        const node = [...document.querySelectorAll('div.fixed')].find((item) => item.textContent?.includes('图片'));
        if (!node) return null;
        const rect = node.getBoundingClientRect();
        return {
          text: node.textContent,
          actions: [...node.querySelectorAll('button')].map((button) => button.getAttribute('aria-label')).filter(Boolean),
          rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
          overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        };
      });
      assert(tray && tray.overflow === 0, `${label} tray=${JSON.stringify(tray)}`);
      const trayImage = await screenshot(page, label === 'before' ? '03-before-export-tray.png' : '04-after-export-tray.png');
      if (label === 'before') {
        const settings = page.locator('button[aria-label="设置"]');
        await settings.click({ force: true });
        await page.waitForTimeout(500);
        const settingsDialogs = page.locator('[role="dialog"]');
        const settingsText = (await settingsDialogs.count()) ? await settingsDialogs.last().innerText().catch(() => '') : '';
        const aboutImage = await screenshot(page, '07-before-web-about-unavailable.png');
        release = { ...release, settingsText, aboutVisible: /FDE2E Film 0\.3\.0/.test(settingsText), aboutImage };
        assert(release.aboutVisible === false, `old Web build unexpectedly exposed 0.3.0 About: ${settingsText}`);
      }
      const result = { label, base, ...(release ? { release } : {}), dialog, dialogImage, tray, trayImage, errors };

      if (label === 'after') {
        const downloadPromise = page.waitForEvent('download', { timeout: 30_000 });
        await page.getByRole('button', { name: '下载', exact: true }).click();
        const download = await downloadPromise;
        const saved = join(evidenceDir, 'after-stills.zip');
        await download.saveAs(saved);
        const downloaded = readFileSync(saved);
        const names = zipNames(downloaded);
        assert(download.suggestedFilename().endsWith('.zip'), `multi-output filename=${download.suggestedFilename()}`);
        assert(downloaded.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04])), 'multi-output download is not a zip');
        assert(names.length === 8 && new Set(names).size === 8 && names.every((name) => /\.(png|jpg)$/i.test(name)), `zip entries=${JSON.stringify(names)}`);
        result.download = { name: download.suggestedFilename(), bytes: downloaded.length, entries: names };
        rmSync(saved, { force: true });
        await closeDialog(page).catch(() => {}); // tray close, not a dialog
        const trayClose = page.getByRole('button', { name: '关闭', exact: true });
        if (await trayClose.count()) await trayClose.click();
        await page.evaluate(() => { window.filmWeb = false; });
        const negative = await openImageExport(page);
        result.negativeControl = { injected: 'window.filmWeb=false + dialog remount', exportDisabled: await negative.isDisabled() };
        assert(result.negativeControl.exportDisabled, 'negative control did not disable export');
      }
      if (label === 'after') assert(errors.length === 0, `${label} page errors=${errors.join(' | ')}`);
      else result.negativeControl = { ...result.negativeControl, settingsErrors: [...errors] };
      results.push(result);
    } finally {
      await context.close();
      await new Promise((resolveClose) => server.close(resolveClose));
    }
  }
} finally { await browser.close(); }
const before = results[0]; const after = results[1];
assert(after.release?.settingsText.includes('0.3.0') && after.release?.releaseText.includes('35 项 WebMCP'), `release surface=${JSON.stringify(after.release)}`);
assert(before.dialog.disabled && !after.dialog.disabled, 'dialog before/after did not flip disabled state');
assert(before.tray.text.includes('导出失败') && !before.tray.actions.includes('下载'), `before tray=${JSON.stringify(before.tray)}`);
assert(after.tray.text.includes('导出完成') && after.tray.actions.includes('下载') && !after.tray.actions.includes('打开') && !after.tray.actions.some((name) => name.includes('显示')), `after tray=${JSON.stringify(after.tray)}`);
writeFileSync(join(evidenceDir, 'audit-result.json'), `${JSON.stringify({ ok: true, browser: browserVersion, results }, null, 2)}\n`);
console.log(JSON.stringify({ ok: true, browser: browserVersion, results }, null, 2));
