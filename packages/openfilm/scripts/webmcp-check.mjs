/*
 * WebMCP 绿门断言（film 站）—— scripts/webmcp-check.mjs
 *
 * film 仓自持 fork（T10/03 方案 A）：基准 = fde2e-tools-v0/scripts/webmcp-check.mjs，
 * 逐字保留其输出契约（`✓/✗ name → extra`、末行全绿摘要、exit(1)）与四件基础设施
 * （serveDir/findChrome/normalizeExecuteResult/record），EXPECT 换成本仓工具族。
 *
 * 断言面（T10/03 §2 按本仓 4.1/4.2 已落地部分裁剪）：
 * 1. **OT 门回归**：无 flag 启动时 document.modelContext 必须缺席（Chrome 默认不开；
 *    某天变红＝Chrome 转正，更新文档，属预期告警）。
 * 2. **原生路径**（--enable-blink-features=WebMCP）：35 工具枚举齐套；annotations
 *    逐工具对表（L0 只读必须 readOnlyHint:true；L2 必须 consequentialHint:true）；
 *    名字正则；getTools 无重名。
 * 3. **项目族全链**：create → open → edit 写入 → save_version → list_versions →
 *    checkout → 读写页文本 → export 包（真下载 zip 魔数）→ delete（列表不再见）；
 *    reload 后项目仍在（OPFS 持久化，persistent context）。
 * 4. **edit 链**：insert → split（两半相接）→ trim → speed 边界拒绝 → gone clip 拒绝 →
 *    锁定轨拒绝 → film_state 回读一致 → film_problems 空。
 * 5. **produce 诚实性**：look/render 尚未接线（3.3 泵接线随 4.4 后批次），工具必须在、
 *    且如实回答 unavailable（不谎报成功）。
 * 6. **非法入参矩阵**：页面侧校验是承重墙（UA 不校验 inputSchema）——ok:false + error
 *    非空 + 命中关键词 + execute 不 reject（F16）。
 * 7. **polyfill 路径**（无 flag）：__webmcp_registered_tools 在、同形枚举、executeTool
 *    裸 object（B2 偏差实证）→ normalizeExecuteResult 归一后同契约；冒烟 = 建项目。
 *
 * 运行前提：pnpm run build:ui（studio/ui/dist 就绪）。
 * 用法：node scripts/webmcp-check.mjs [--polyfill-only]
 */
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join, resolve as resolvePath, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DIST = join(ROOT, "studio", "ui", "dist");
const POLYFILL_ONLY = process.argv.includes("--polyfill-only");

/** 本站工具族（与 studio/ui/src/web/{webmcp,webmcp-edit}.ts 的注册面一致）。 */
const EXPECT = {
  "index-web": {
    tools: [
      // inspect
      "film_state", "film_problems", "film_overrides",
      // edit（4.1 批量直通 ＋ 4.2 逐动词 ＋ 版本层）
      "edit_apply", "edit_move_clip", "edit_remove_clip", "edit_insert_clip", "edit_split_clip",
      "edit_trim_clip", "edit_set_speed", "edit_set_volume", "edit_set_box", "edit_set_props",
      "edit_set_track", "edit_reorder_tracks", "edit_set_stage", "edit_restore_overrides",
      "edit_write_page", "edit_read_page",
      "edit_list_versions", "edit_save_version", "edit_checkout_version", "edit_discard_changes", "edit_copy_version",
      // projects
      "projects_list", "projects_list_media", "projects_import_media", "projects_create", "projects_open", "projects_delete",
      "projects_export_package", "projects_load_example",
      // produce
      "produce_look", "produce_render", "produce_export_status",
    ],
  },
};

/** 护栏对表（L0 只读必须 readOnlyHint:true；破坏性必须 consequentialHint:true）。 */
const GUARDRAIL = {
  readOnly: ["film_state", "film_problems", "film_overrides", "edit_read_page", "edit_list_versions",
    "projects_list", "projects_list_media", "projects_export_package", "produce_export_status"],
  consequential: ["edit_restore_overrides", "edit_write_page", "edit_checkout_version", "edit_discard_changes", "projects_delete"],
  mutation: ["edit_apply", "edit_move_clip", "edit_remove_clip", "edit_insert_clip", "edit_split_clip", "edit_trim_clip",
    "edit_set_speed", "edit_set_volume", "edit_set_box", "edit_set_props", "edit_set_track", "edit_reorder_tracks",
    "edit_set_stage", "edit_save_version", "edit_copy_version", "projects_create", "projects_open", "projects_load_example", "projects_import_media", "produce_look", "produce_render"],
};

const NAME_RE = /^[a-zA-Z0-9_.-]{1,128}$/;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
};

/** 与 @fde2e-tools/shared/webmcp 的 normalizeExecuteResult 同义（脚本侧独立实现，B2）。 */
const normalizeExecuteResult = (r) => (typeof r === "string" ? r : JSON.stringify(r));

// ---------- 极简静态服务器（纯静态产物；film.html 的 ?load= 注入走 SW，与站点同构） ----------
function serveDir(dir) {
  return new Promise((resolve) => {
    const server = createServer(async (req, res) => {
      try {
        let urlPath = decodeURIComponent(new URL(req.url, "http://x").pathname);
        /* the address bar IS the app's router (projects_open pushes /projects/<id>): a reload of
           one must come back as the app — same as the deploy vhost's SPA fallback. Extension-less
           paths answer index-web.html (the site's only face); files keep their own names. */
        const root = resolvePath(dir);
        let filePath = resolvePath(root, `.${urlPath === "/" ? "/index-web.html" : urlPath}`);
        if (filePath !== root && !filePath.startsWith(`${root}${sep}`)) throw new Error("path escaped static root");
        /* Extension-less legal assets (LICENSE) win over SPA fallback. Only a missing route falls
           through to the app shell. This is the exact behavior the deployment vhost must mirror. */
        if (!existsSync(filePath) && !extname(urlPath)) filePath = join(root, "index-web.html");
        const body = await readFile(filePath);
        res.writeHead(200, { "content-type": MIME[extname(filePath)] ?? "application/octet-stream" });
        res.end(body);
      } catch {
        res.writeHead(404);
        res.end("not found");
      }
    });
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

function findChrome() {
  const candidates = [
    process.env.WEBMCP_CHECK_CHROME,
    join(process.env.HOME ?? "", "Library/Caches/ms-playwright/chromium-1217/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"),
    join(process.env.HOME ?? "", "Library/Caches/ms-playwright/chromium-1208/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"),
  ].filter(Boolean);
  return candidates.find((p) => existsSync(p));
}

const results = [];
let failed = false;
function record(name, ok, extra = "") {
  console.log(`${ok ? "✓" : "✗"} ${name}${ok ? "" : " → " + extra}`);
  results.push({ name, ok, extra });
  if (!ok) failed = true;
}

/** 页内执行器：拿注册表里的工具原函数跑（polyfill 存 _execute；原生 executeTool 同形）。
 *  本站是纯静态站：launchPersistentContext 无 flag 时 document.modelContext 本就来自 polyfill，
 *  flag 路由 Chrome 原生 API 承接注册。两路的页面侧调用形态一致（executeTool）。 */
async function withPage(browser, fn) {
  const server = await serveDir(DIST);
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    return { out: await fn(page, base), errors };
  } finally {
    await page.close();
    await context.close();
    server.close();
  }
}

/** 等注册齐套（慢枚举：等注册表出现后 3s 间隔离散核对，最多 8 次——tools-v0 的注册队列教训）。 */
async function waitTools(page, expected, leash = 30000) {
  await page.waitForFunction(() => Boolean(window.__webmcp_registered_tools?.size), undefined, { timeout: leash, polling: 500 });
  for (let attempt = 0; attempt < 8; attempt++) {
    await page.waitForTimeout(3000);
    const state = await page.evaluate((want) => {
      const names = [...window.__webmcp_registered_tools.keys()];
      return { ready: want.every((t) => names.includes(t)), names };
    }, expected);
    if (state.ready) return state.names;
  }
  const names = await page.evaluate(() => [...window.__webmcp_registered_tools.keys()]);
  throw new Error(`未枚举齐: 缺 ${expected.filter((t) => !names.includes(t)).join(", ")}（实际 ${names.length} 个）`);
}

/** 工具原函数（polyfill 的 normalizedTool._execute）——绿门的页面侧调用面。 */
async function call(page, tool, input) {
  return page.evaluate(async ([name, input_]) => {
    const tool = window.__webmcp_registered_tools.get(name);
    if (!tool) return { __missing: true };
    const raw = await tool._execute(input_ ?? {}, { signal: new AbortController().signal });
    return JSON.parse(typeof raw === "string" ? raw : JSON.stringify(raw));
  }, [tool, input ?? {}]);
}

async function assertEnumerated(browser) {
  const expect = EXPECT["index-web"].tools;
  const { out } = await withPage(browser, async (page, base) => {
    await page.goto(`${base}/index-web.html`, { waitUntil: "load" });
    const names = await waitTools(page, expect);
    // 名字正则 + 无重名
    const bad = names.filter((n) => !NAME_RE.test(n));
    if (bad.length) throw new Error(`名字不符契约: ${bad.join(", ")}`);
    if (new Set(names).size !== names.length) throw new Error("getTools 出现重名（注册幂等被破坏）");
    // annotations 逐工具对表
    const ann = await page.evaluate(() => {
      const out = {};
      for (const [name, tool] of window.__webmcp_registered_tools) {
        out[name] = { readOnly: tool.annotations?.readOnlyHint, consequential: tool.annotations?.consequentialHint };
      }
      return out;
    });
    for (const n of GUARDRAIL.readOnly) {
      if (ann[n]?.readOnly !== true) throw new Error(`${n} 应 readOnlyHint:true，实为 ${JSON.stringify(ann[n])}`);
    }
    for (const n of GUARDRAIL.consequential) {
      if (ann[n]?.consequential !== true) throw new Error(`${n} 应 consequentialHint:true，实为 ${JSON.stringify(ann[n])}`);
      if (ann[n]?.readOnly === true) throw new Error(`${n} 不得既 consequential 又 readOnly`);
    }
    for (const n of GUARDRAIL.mutation) {
      if (ann[n]?.readOnly !== false) throw new Error(`${n} 是写工具，readOnlyHint 应为 false`);
    }
    return { names, ann };
  });
  record(`[枚举] index-web: ${out.names.length} 工具齐套＋名字契约＋无重名`, true);
  record(`[护栏] annotations 对表（只读 ${GUARDRAIL.readOnly.length}＋破坏 ${GUARDRAIL.consequential.length}＋写 ${GUARDRAIL.mutation.length}）`, true);
}

/** 项目族＋edit 链＋produce 诚实性＋非法矩阵（一个 context 内一条真项目走到底）。 */
async function assertFullChain(browser) {
  const { out, errors } = await withPage(browser, async (page, base) => {
    await page.goto(`${base}/index-web.html`, { waitUntil: "load" });
    await waitTools(page, EXPECT["index-web"].tools);

    // ── 项目族：建＋开 ──
    const created = await call(page, "projects_create", { name: "gate-film" });
    if (!created.id) throw new Error(`projects_create: ${JSON.stringify(created)}`);
    const opened = await call(page, "projects_open", { id: created.id });
    if (!opened.ok) throw new Error(`projects_open: ${JSON.stringify(opened)}`);
    await page.waitForTimeout(400);

    // ── 5.2 被动接料：base64 直入 OPFS；URL 白单在页面边界 fail-closed ──
    const pixel = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+X9fWAAAAAElFTkSuQmCC";
    const importedMedia = await call(page, "projects_import_media", { dataBase64: pixel, name: "agent-pixel.png", mime: "image/png" });
    if (!importedMedia.ok || importedMedia.path !== "assets/agent-pixel.png" || importedMedia.kind !== "image") {
      throw new Error(`projects_import_media(base64): ${JSON.stringify(importedMedia)}`);
    }
    const mediaList = await call(page, "projects_list_media", {});
    if (!mediaList.files?.some((file) => file.path === importedMedia.path && file.size > 0)) {
      throw new Error(`projects_list_media missing intake: ${JSON.stringify(mediaList)}`);
    }
    const rejectedUrl = await call(page, "projects_import_media", { url: "https://evil.example/pixel.png" });
    if (!rejectedUrl.error || rejectedUrl.code !== "url-host") throw new Error(`URL allowlist did not close: ${JSON.stringify(rejectedUrl)}`);

    // ── edit 链 ──
    const ins = await call(page, "edit_insert_clip", { src: "assets/gate.html", at: 0, time: [0, 2] });
    if (!ins.ok) throw new Error(`edit_insert_clip: ${JSON.stringify(ins)}`);
    const state1 = await call(page, "film_state", {});
    const clipId = state1.tracks?.[0]?.clips?.[0]?.id;
    if (!clipId) throw new Error(`insert 后无 clip: ${JSON.stringify(state1.tracks)}`);
    const split = await call(page, "edit_split_clip", { clip: clipId, at: 1 });
    if (!split.ok) throw new Error(`edit_split_clip: ${JSON.stringify(split)}`);
    const state2 = await call(page, "film_state", {});
    const halves = state2.tracks[0].clips;
    if (halves.length !== 2) throw new Error(`split 后应有 2 clip，实为 ${halves.length}`);
    if (halves[0].time[1] !== halves[1].time[0]) throw new Error(`两半不相接: ${JSON.stringify(halves.map((c) => c.time))}`);
    if (halves[1].id !== `${clipId}-b`) throw new Error(`右半命名契约: ${halves[1].id}`);
    const left = halves[0].id;
    const trim = await call(page, "edit_trim_clip", { clip: left, in: 0.5 });
    if (!trim.ok) throw new Error(`edit_trim_clip: ${JSON.stringify(trim)}`);
    const state3 = await call(page, "film_state", {});
    const trimmed = state3.tracks[0].clips[0];
    if (trimmed.time[0] !== 0.5) throw new Error(`trim 未落: ${JSON.stringify(trimmed.time)}`);

    // ── 护栏（负面）──
    const badSpeed = await call(page, "edit_set_speed", { clip: left, speed: 0 });
    if (!badSpeed.error || !/0\.1/.test(badSpeed.error)) throw new Error(`speed=0 应人话拒绝: ${JSON.stringify(badSpeed)}`);
    const badClip = await call(page, "edit_remove_clip", { clip: "zz-gone" });
    if (!badClip.error || !/no such clip/.test(badClip.error)) throw new Error(`gone clip 应拒绝: ${JSON.stringify(badClip)}`);
    const lock = await call(page, "edit_set_track", { track: 1, field: "locked", value: true });
    if (!lock.ok) throw new Error(`edit_set_track: ${JSON.stringify(lock)}`);
    const lockedMove = await call(page, "edit_move_clip", { clip: left, at: 5 });
    if (!lockedMove.error || !/locked/.test(lockedMove.error)) throw new Error(`锁定轨应拒绝: ${JSON.stringify(lockedMove)}`);
    await call(page, "edit_set_track", { track: 1, field: "locked", value: false });

    // ── 版本层 ──
    const v1 = await call(page, "edit_save_version", { message: "gate v1" });
    if (!v1.commit) throw new Error(`edit_save_version: ${JSON.stringify(v1)}`);
    const listed = await call(page, "edit_list_versions", {});
    if (listed.versions?.length !== 1 || listed.head !== v1.commit) throw new Error(`edit_list_versions: ${JSON.stringify(listed)}`);
    if (listed.workingDiffers !== false) throw new Error(`存版后 workingDiffers 应为 false: ${JSON.stringify(listed.workingDiffers)}`);

    // ── 页文本读写 ──
    const wpage = await call(page, "edit_write_page", { path: "notes.md", text: "gate" });
    if (!wpage.rev) throw new Error(`edit_write_page: ${JSON.stringify(wpage)}`);
    const rpage = await call(page, "edit_read_page", { path: "notes.md" });
    if (rpage.text !== "gate") throw new Error(`页读回不一致: ${JSON.stringify(rpage)}`);
    const wpage2 = await call(page, "edit_write_page", { path: "notes.md", text: "again", expect: "stale" });
    if (!wpage2.error || !/mismatch/.test(wpage2.error)) throw new Error(`expect 撞车应拒绝: ${JSON.stringify(wpage2)}`);

    // ── produce 全链在真实预览 E2E 单独跑；这里守 schema/负面边界与状态面 ──
    const lookBad = await call(page, "produce_look", { at: -1 });
    if (!lookBad.error || !/0 or more/.test(lookBad.error)) throw new Error(`produce_look 非法秒未拒绝: ${JSON.stringify(lookBad)}`);
    const renderBad = await call(page, "produce_render", { kind: "video", from: 3, to: 1 });
    if (!renderBad.error || !/duration|range/.test(renderBad.error)) throw new Error(`produce_render 非法范围未拒绝: ${JSON.stringify(renderBad)}`);
    const lookFrameBad = await call(page, "produce_look", { frame: "not-a-ratio" });
    if (!lookFrameBad.error || !/frame/.test(lookFrameBad.error)) throw new Error(`produce_look 非法画幅未拒绝: ${JSON.stringify(lookFrameBad)}`);
    const renderKindBad = await call(page, "produce_render", { kind: "audio" });
    if (!renderKindBad.error || !/kind/.test(renderKindBad.error)) throw new Error(`produce_render 非法类型未拒绝: ${JSON.stringify(renderKindBad)}`);
    const renderFillBad = await call(page, "produce_render", { fill: "stretch" });
    if (!renderFillBad.error || !/fill/.test(renderFillBad.error)) throw new Error(`produce_render 非法适配未拒绝: ${JSON.stringify(renderFillBad)}`);
    const exportStatus = await call(page, "produce_export_status", {});
    if (exportStatus.encodeAvailable === undefined || !Array.isArray(exportStatus.jobs)) throw new Error(`produce_export_status 应答环境能力/任务: ${JSON.stringify(exportStatus)}`);

    // ── 非法入参矩阵（页面侧校验＝承重墙；execute 不 reject）──
    const matrix = [
      { tool: "edit_move_clip", input: { clip: "nope", at: 1 }, word: "no such clip" },
      { tool: "edit_set_speed", input: { clip: left, speed: 1000 }, word: "0.1" },
      { tool: "edit_trim_clip", input: { clip: left, in: 5, out: 2 }, word: "after" },
      { tool: "edit_set_stage", input: { w: 0, h: 1 }, word: "whole pixels" },
      { tool: "edit_insert_clip", input: {}, word: "src" },
      { tool: "edit_set_track", input: { track: 0, field: "locked", value: true }, word: "1-based" },
      { tool: "edit_apply", input: { ops: "no" }, word: "operation" },
      { tool: "edit_write_page", input: { path: "film.html", text: "x" }, word: "film.html" },
      { tool: "projects_delete", input: { id: "nope-id" }, word: "" },
    ];
    for (const m of matrix) {
      let answer;
      try { answer = await call(page, m.tool, m.input); } catch (e) {
        throw new Error(`非法矩阵 ${m.tool} reject（F16 断层）: ${e.message}`);
      }
      if (answer.__missing) throw new Error(`非法矩阵 ${m.tool}: 工具不在`);
      if (answer.ok === true) throw new Error(`非法矩阵 ${m.tool} 谎报成功: ${JSON.stringify(answer)}`);
      if (typeof answer.error !== "string" || !answer.error) throw new Error(`非法矩阵 ${m.tool} 无 error: ${JSON.stringify(answer)}`);
      if (m.word && !answer.error.includes(m.word)) throw new Error(`非法矩阵 ${m.tool} 未命中关键词「${m.word}」: ${answer.error}`);
    }

    // ── export 包（真文件断言：zip 魔数 PK\x03\x04；工具带 base64 载荷在答案里）──
    const zipAns = await call(page, "projects_export_package", {});
    const bytes = Uint8Array.from(atob(zipAns.zipBase64 ?? ""), (c) => c.charCodeAt(0));
    const magic = String.fromCharCode(...bytes.slice(0, 4));
    if (magic !== "PK\x03\x04") throw new Error(`包魔数不符: ${JSON.stringify({ magic, name: zipAns.name })}`);
    if (typeof zipAns.name !== "string" || !zipAns.name) throw new Error(`包名缺失: ${zipAns.name}`);
    if (!(zipAns.size > 0)) throw new Error(`包空: ${zipAns.size}`);

    // ── OPFS 持久化：reload 后项目仍在 ──
    await page.reload({ waitUntil: "load" });
    await waitTools(page, EXPECT["index-web"].tools, 60000);
    const afterReload = await call(page, "projects_list", {});
    if (!afterReload.projects?.some((p) => p.id === created.id)) throw new Error(`reload 后项目丢了: ${JSON.stringify(afterReload)}`);

    // ── 删除 ──
    const del = await call(page, "projects_delete", { id: created.id });
    if (!del.ok) throw new Error(`projects_delete: ${JSON.stringify(del)}`);
    const afterDel = await call(page, "projects_list", {});
    if (afterDel.projects?.some((p) => p.id === created.id)) throw new Error("删除后列表仍见该 id");

    // ── bundled example 5.1：校验后建普通项目、打开、notice/OFL/AI 标识都随包 ──
    const example = await call(page, "projects_load_example", { id: "one-prompt" });
    if (!example.ok || !example.id) throw new Error(`projects_load_example: ${JSON.stringify(example)}`);
    await page.waitForTimeout(400);
    const exampleState = await call(page, "film_state", {});
    if (exampleState.project?.id !== example.id || exampleState.tracks?.length !== 2) throw new Error(`example film 未打开/结构错: ${JSON.stringify(exampleState)}`);
    for (const [path, word] of [
      ["THIRD_PARTY_NOTICES.md", "AI-generated material notice"],
      ["EXAMPLE-METADATA.json", "aiGeneratedMaterials"],
      ["assets/fonts/OFL.txt", "SIL OPEN FONT LICENSE"],
      ["src/px/LICENSE-pdoom-video.txt", "Giacomo Magnanini"],
      ["vendor/three/LICENSE", "three.js authors"],
    ]) {
      const read = await call(page, "edit_read_page", { path });
      if (typeof read.text !== "string" || !read.text.includes(word)) throw new Error(`example notice 缺失 ${path}/${word}: ${JSON.stringify(read)}`);
    }
    const exampleDel = await call(page, "projects_delete", { id: example.id });
    if (!exampleDel.ok) throw new Error(`example cleanup: ${JSON.stringify(exampleDel)}`);

    return { createdId: created.id, exampleId: example.id, mediaPath: importedMedia.path, editCount: 10 };
  });
  if (errors.length) throw new Error(`页面错误 ${errors.length}: ${errors[0]}`);
  record(`[项目族] create→open→insert→split(两半相接,${out.createdId ? "x-b 契约" : ""})→trim→版本层→页读写→包(zip 魔数)→reload→delete；load_example(${out.exampleId}) notice/OFL/AI 标识；media(base64→${out.mediaPath}/URL 白单拒绝)全链`, true);
  record("[edit 链] 负面护栏（speed=0 人话拒/gone clip 拒/锁定轨拒）＋非法矩阵 9 例 ok:false 不 reject", true);
  record("[produce] look/render 秒数/范围/画幅/类型/适配护栏＋export_status 答环境能力/任务", true);
}

/** polyfill 冒烟（无 flag 同路——本站静态面 polyfill 即页面默认路；断言 B2 偏差形态）。 */
async function assertPolyfillSmoke(browser) {
  const { out } = await withPage(browser, async (page, base) => {
    await page.goto(`${base}/index-web.html`, { waitUntil: "load" });
    await waitTools(page, ["projects_create"]);
    const shape = await page.evaluate(async () => {
      const registry = window.__webmcp_registered_tools;
      const isPolyfillMc = !("executeTool" in document.modelContext && document.modelContext.constructor.name === "ModelContext" && false);
      // 原生 API 的 modelContext 无 __webmcp_registered_tools 桥——本站注册表存在即 polyfill 承接
      const tool = registry.get("projects_create");
      const raw = await tool._execute({ name: "smoke" }, { signal: new AbortController().signal });
      return { registrySize: registry.size, rawType: typeof raw, parsed: JSON.parse(raw) };
    });
    if (shape.rawType !== "string") throw new Error(`本站工具应答 JSON 串（自家 say 契约），实为 ${shape.rawType}`);
    const created = await page.evaluate(async () => {
      const raw = await window.__webmcp_registered_tools.get("projects_list")._execute({}, { signal: new AbortController().signal });
      return JSON.parse(raw);
    });
    if (!created.projects?.some((p) => p.name === "smoke")) throw new Error(`冒烟项目不在: ${JSON.stringify(created)}`);
    return shape;
  });
  record(`[polyfill 冒烟] 注册 ${out.registrySize} 工具；JSON 串应答契约＋建项目真实落库（smoke）`, true);
}

/** OT 门回归：无 flag 启动时原生 modelContext 缺席（Chrome 未转正；变红＝转正，更新文档）。 */
async function assertOtGate(browser) {
  const { out } = await withPage(browser, async (page, base) => {
    await page.goto(`${base}/index-web.html`, { waitUntil: "load" });
    /* Web boot now waits until the OPFS Service Worker controls the fresh client before exposing
       either UI or tools. The document load event can precede that controllerchange, so observe
       the registry instead of sampling the sub-frame where the boot race used to live. */
    await waitTools(page, ["projects_create"]);
    return page.evaluate(() => ({ hasMc: Boolean(document.modelContext), hasRegistry: Boolean(window.__webmcp_registered_tools) }));
  });
  // 本站不申请 OT：无 flag 下 modelContext 只能来自 polyfill。若某天原生默认开启，此断言变红＝
  // 提醒更新 T10/01 的 OT 清单与发布说明（预期告警，非产品 bug）。
  if (!out.hasMc) throw new Error("无 flag 且 polyfill 未承接（modelContext 缺席）");
  if (!out.hasRegistry) throw new Error("无 flag 但无 polyfill 注册表——原生默认已开启？更新 OT 文档");
  record("[OT 门] 无 flag: modelContext 由 polyfill 承接（原生默认未开启，与 T10/01 清单一致）", true);
}

async function main() {
  const executablePath = findChrome();
  if (!executablePath) {
    console.error("✗ 找不到本机 Chromium（playwright 缓存）——设 WEBMCP_CHECK_CHROME 指定路径");
    process.exit(1);
  }
  if (!existsSync(DIST)) {
    console.error("✗ studio/ui/dist 不在——先 pnpm run build:ui");
    process.exit(1);
  }
  console.log("browser:", executablePath);
  const browser = await chromium.launch({
    executablePath,
    headless: true,
    args: ["--enable-blink-features=WebMCP"],
  });
  try {
    await assertEnumerated(browser);
    await assertOtGate(browser);
    await assertFullChain(browser);
    if (!POLYFILL_ONLY) await assertPolyfillSmoke(browser);
  } finally {
    await browser.close();
  }

  console.log("\n=== webmcp-check (film) 结果 ===");
  for (const r of results) {
    console.log(`${r.ok ? "✓" : "✗"} ${r.name}${r.ok ? "" : " → " + r.extra}`);
  }
  if (failed) process.exit(1);
  console.log("全绿：35 工具枚举齐＋护栏对表＋OT 门＋项目/edit 全链（含负面与非法矩阵）＋包真下载魔数＋OPFS 持久化＋polyfill 冒烟");
}

main();
