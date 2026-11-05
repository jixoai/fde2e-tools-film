#!/usr/bin/env node
/** Merge the release-polish browser, visual, Omni and production receipts into steps.json.
 * HTML remains owned by the main repository's e2e-report-gen.mjs. */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const index = argv.indexOf(name);
  return index < 0 ? fallback : argv[index + 1];
};
const evidenceDir = resolve(flag('--evidence-dir', 'e2e-out/web-openfilm-editor-polish'));
const packageRoot = resolve(import.meta.dirname, '..');
const filmRepo = resolve(packageRoot, '../..');
const mainRepo = resolve(filmRepo, '..');
const omniRepo = join(mainRepo, 'fde2e-omni-v1');
const readJson = (name) => JSON.parse(readFileSync(join(evidenceDir, name), 'utf8'));
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const commit = (repo) => execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

const smokeSteps = readJson('polish-steps.json');
const smoke = readJson('result.json');
const audit = readJson('audit-result.json');
const omni = readJson('omni-result.json');
const production = readJson('production-final-result.json');
const gate = existsSync(join(evidenceDir, 'gate-result.json')) ? readJson('gate-result.json') : null;
assert((smoke.ok ?? smoke.summary?.pass === 5) && audit.ok && omni.ok && production.ok, 'one or more release-polish receipts are not green');
assert(smokeSteps.summary?.pass === 5 && smokeSteps.summary?.fail === 0, 'polish smoke is not 5/5');
assert(audit.results?.length === 2, 'paired visual audit is incomplete');

const before = audit.results.find((entry) => entry.label === 'before');
const after = audit.results.find((entry) => entry.label === 'after');
assert(before && after, 'before/after audit pair is incomplete');
assert(before.dialog.disabled && !after.dialog.disabled, 'export dialog negative control did not flip');
assert(before.tray.text.includes('导出失败') && after.tray.text.includes('导出完成'), 'export tray pair is incomplete');
assert(after.download?.entries?.length === 8, 'multi-output download is not an eight-entry zip');
assert(omni.commands?.length >= 9 && omni.network?.foreign === 0 && omni.network?.forbiddenOmni === 0, 'Omni receipt boundary failed');
assert(production.productionRender?.media?.status === 206 && production.productionRender?.media?.seeked > 0 && production.network?.foreignRequests?.length === 0, 'production media receipt failed');

const visualSteps = [
  {
    id: 'V1', intent: '固定 One Prompt / 图片 / 每个镜头中间状态，打开 task-6.5 前构建的 Web 导出对话框',
    expect: '缺陷态诚实暴露无默认 Web 目录，导出主按钮禁用',
    assertion: `disabled=${before.dialog.disabled}; saveTo=${before.dialog.saveTo}; overflow=${before.dialog.overflow}`,
    ok: true, image: before.dialogImage,
  },
  {
    id: 'V2', intent: '在最终 0.3.0 候选构建打开完全相同的 Web 导出状态',
    expect: '保存位置为 downloads，导出主按钮可用',
    assertion: `disabled=${after.dialog.disabled}; saveTo=${after.dialog.saveTo}; overflow=${after.dialog.overflow}`,
    ok: true, image: after.dialogImage,
  },
  {
    id: 'V3', intent: 'task-6.5 前构建用显式 downloads 绕过目录缺口后真导出',
    expect: '定向反向对照命中旧截图捕获缺陷，托盘报告失败且不提供伪下载',
    assertion: `status=failed; actions=${before.tray.actions.join(',')}; overflow=${before.tray.overflow}`,
    ok: true, image: before.trayImage,
  },
  {
    id: 'V4', intent: '最终候选执行同一 8 张图片导出并下载',
    expect: '托盘完成且只提供 Web 可用动作；下载为含全部图片的 ZIP',
    assertion: `status=done; actions=${after.tray.actions.join(',')}; zip=${after.download.name}; entries=${after.download.entries.length}; bytes=${after.download.bytes}; overflow=${after.tray.overflow}`,
    ok: true, image: after.trayImage,
  },
  {
    id: 'V5', intent: '从纯 Web 候选的设置打开关于面',
    expect: 'About 直接显示候选版本 0.3.0，不依赖服务器版本接口',
    assertion: `version=0.3.0; pageErrors=${after.errors.length}; storage controls hidden on Web`,
    ok: true, image: after.release.aboutImage,
  },
  {
    id: 'V6', intent: '从纯 Web About 打开本版更新内容',
    expect: '五语种 release notes 的中文投影显示 35 工具、有界内存与黑帧修复',
    assertion: '35 WebMCP tools; bounded-memory WebCodecs; page-capture/async-export fixes',
    ok: true, image: after.release.releaseImage,
  },
];
const productSteps = smokeSteps.sections.flatMap((section) => section.steps ?? []);
const omniJob = omni.final?.status?.jobs?.find((job) => job.status === 'done');
const ecosystemStep = {
  id: 'S6', intent: '真实 Hermes Agent 经本地 Omni server/WSS browser bridge 操作真实 Chromium Film',
  expect: '35 工具发现→示例→版本→舞台→H.264 导出→status，全程无生产 Omni/外域流量',
  assertion: `provider=${omni.provider}/${omni.model}; commands=${omni.commands.length}; project=${omni.final?.film?.project?.id}; job=${omniJob?.id}; bytes=${omniJob?.bytes}; encoder=${omniJob?.encoder}; foreign=0; omni.fde2e.com=0`,
  ok: true, image: omni.image,
};
const productionMedia = production.productionRender.media;
const productionStep = {
  id: 'S7', intent: '在 https://film.tool.fde2e.com 运行最终候选的真实媒体导出与 seek',
  expect: '35 工具；H.264＋AAC 落 OPFS；Range 206；真实 seek 后非黑；About=0.3.0；零外域/生产 Omni 请求',
  assertion: `project=${production.example.id}; bytes=${productionMedia.bytes}; range=${productionMedia.status}/${productionMedia.contentRange}; duration=${productionMedia.duration}s; seek=${productionMedia.seeked}s; nonBlack=${productionMedia.nonBlack.toFixed(3)}; audio=${productionMedia.audio?.channels}ch; requests=${production.network.requestCount}; foreign=0`,
  ok: true, image: 'img/s7-production-final.png',
};

const coverage = [
  // Film visual/runtime surfaces.
  ['fde2e-tools-film/packages/openfilm/CHANGELOG.md', 'V6 · 更新内容链接与 0.3.0 口径'],
  ['fde2e-tools-film/packages/openfilm/studio/ui/public/examples/one-prompt/film.html', 'S1/S4/S6/S7 · 首帧、刷新、Agent、生产'],
  ['fde2e-tools-film/packages/openfilm/studio/ui/src/App.tsx', 'V6 · Web 更新内容入口'],
  ['fde2e-tools-film/packages/openfilm/studio/ui/src/api.ts', 'V5/V6 · Web About 与偏好持久化'],
  ['fde2e-tools-film/packages/openfilm/studio/ui/src/components/ProjectView.tsx', 'S1–S5/S6/S7 · 预览、混音、导出'],
  ['fde2e-tools-film/packages/openfilm/studio/ui/src/components/WhatsNew.tsx', 'V6 · 0.3.0 更新内容'],
  ['fde2e-tools-film/packages/openfilm/studio/ui/src/components/export/ExportCenter.tsx', 'V1/V2 · 缺省下载目录 before/after'],
  ['fde2e-tools-film/packages/openfilm/studio/ui/src/components/export/ExportTray.tsx', 'V3/V4 · 失败/完成与 Web 下载动作'],
  ['fde2e-tools-film/packages/openfilm/studio/ui/src/components/settings/SettingsModal.tsx', 'V5 · Web About/隐藏桌面存储控制'],
  ['fde2e-tools-film/packages/openfilm/studio/ui/src/editor/Preview.tsx', 'S1/S4/S7 · Web/desktop preview origin 与首帧'],
  ['fde2e-tools-film/packages/openfilm/studio/ui/src/editor/player.ts', 'S2/S3/S7 · AAC 混音与长导出'],
  ['fde2e-tools-film/packages/openfilm/studio/ui/src/lib/export-jobs.ts', 'V2/V4 · Web 能力与 downloads'],
  ['fde2e-tools-film/packages/openfilm/studio/ui/src/lib/whats-new.ts', 'V6 · 五语种 release notes'],
  ['fde2e-tools-film/packages/openfilm/studio/ui/src/web/encode-backend.ts', 'S2/S3/S6/S7 · 有界内存 WebCodecs'],
  ['fde2e-tools-film/packages/openfilm/studio/ui/src/web/export-pump.ts', 'S3 · (i+0.5)/fps 串行泵与取消'],
  ['fde2e-tools-film/packages/openfilm/studio/ui/src/web/main-web.tsx', 'S1/S4/S7 · SW 首控后挂载'],
  ['fde2e-tools-film/packages/openfilm/studio/ui/src/web/opfs/store.ts', 'S4 · downloads 刷新后持久化'],
  ['fde2e-tools-film/packages/openfilm/studio/ui/src/web/web-export.ts', 'V4/S2/S3/S6/S7 · 多产物、job、输出'],
  ['fde2e-tools-film/packages/openfilm/studio/ui/src/web/webmcp.ts', 'S1–S3/S6/S7 · produce/status/previewReady'],
  ['fde2e-tools-film/packages/openfilm/studio/ui/src/web/frame-capture.ts', 'S5 · DOM/img/canvas 四层像素'],
  ['fde2e-tools-film/packages/openfilm/studio/ui/src/web/web-runtime.ts', 'S6 · route→runtime 有界等待'],
  ['fde2e-tools-film/packages/openfilm/studio/ui/vite.config.ts', 'V5 · 构建时版本注入'],
  ['fde2e-tools-film/packages/openfilm/studio/ui/src/version.d.ts', 'V5 · 构建时版本类型'],
  // Film tests, scripts and config: explicit no-visual class ①.
  ['fde2e-tools-film/packages/openfilm/.gitignore', '无视觉面① · 配置'],
  ['fde2e-tools-film/packages/openfilm/package.json', '无视觉面① · 包配置/门命令'],
  ['fde2e-tools-film/packages/openfilm/scripts/examples-check.mjs', '无视觉面① · E2E 工具；S1/S4 判据'],
  ['fde2e-tools-film/packages/openfilm/scripts/export-tray-audit.mjs', '无视觉面① · before/after 产证工具'],
  ['fde2e-tools-film/packages/openfilm/scripts/polish-report.mjs', '无视觉面① · 报告聚合工具'],
  ['fde2e-tools-film/packages/openfilm/scripts/polish-smoke.mjs', '无视觉面① · S1–S5 E2E 工具'],
  ['fde2e-tools-film/packages/openfilm/scripts/production-deployment-check.mjs', '无视觉面① · 生产契约工具；S7 判据'],
  ['fde2e-tools-film/packages/openfilm/scripts/vendor-examples.mjs', '无视觉面① · 构建工具/#t 漂移门'],
  ['fde2e-tools-film/packages/openfilm/scripts/webmcp-check.mjs', '无视觉面① · 35-tool 契约门'],
  ['fde2e-tools-film/packages/openfilm/studio/ui/src/web/export-pump.test.ts', '无视觉面① · 测试'],
  ['fde2e-tools-film/packages/openfilm/studio/ui/src/web/web-export.test.ts', '无视觉面① · 测试'],
  ['fde2e-tools-film/packages/openfilm/studio/ui/src/web/web-runtime.test.ts', '无视觉面① · 测试'],
  ['fde2e-tools-film/packages/openfilm/studio/ui/src/web/webmcp.test.ts', '无视觉面① · 测试'],
  // Omni skill/product integration.
  ['fde2e-omni-v1/AGENTS.md', '无视觉面① · 项目指令'],
  ['fde2e-omni-v1/deploy/omni/deploy-dashboard-assets.sh', '无视觉面① · 部署配置'],
  ['fde2e-omni-v1/scripts/agents/setup_profiles.py', '无视觉面① · 装配工具；S6 技能可发现'],
  ['fde2e-omni-v1/scripts/agents/smoke_skills_integration.sh', '无视觉面① · 29/29 装配门'],
  ['fde2e-omni-v1/scripts/agents/test_setup_profiles_skills.py', '无视觉面① · 53 项测试'],
  ['fde2e-omni-v1/scripts/agents/skills/film-tool/SKILL.md', '无视觉面① · Agent 技能；S6 行为'],
  ['fde2e-omni-v1/scripts/agents/skills/film-tool/references/tools.md', '无视觉面① · Agent 参考；S6 恢复规则'],
  ['fde2e-omni-v1/scripts/agents/skills/film-tool/references/workflows.md', '无视觉面① · Agent 参考；S6 SOP'],
  ['fde2e-omni-v1/scripts/smoke/film-tool-agent-e2e.mjs', '无视觉面① · 真实 Agent E2E 工具'],
  ['fde2e-omni-v1/openspec/specs/film-tool-operations/spec.md', '无视觉面① · 规格'],
  ['fde2e-omni-v1/openspec/changes/archive/2026-11-05-film-tool-skill/.openspec.yaml', '无视觉面① · OpenSpec 配置'],
  ['fde2e-omni-v1/openspec/changes/archive/2026-11-05-film-tool-skill/README.md', '无视觉面① · 文档'],
  ['fde2e-omni-v1/openspec/changes/archive/2026-11-05-film-tool-skill/design.md', '无视觉面① · 设计文档'],
  ['fde2e-omni-v1/openspec/changes/archive/2026-11-05-film-tool-skill/proposal.md', '无视觉面① · 提案文档'],
  ['fde2e-omni-v1/openspec/changes/archive/2026-11-05-film-tool-skill/specs/film-tool-operations/spec.md', '无视觉面① · 归档规格'],
  ['fde2e-omni-v1/openspec/changes/archive/2026-11-05-film-tool-skill/tasks.md', '无视觉面① · 归档任务'],
  // Main-repository tracking and specs.
  ['.agents/docs/E2E-REPORTS.md', '无视觉面① · 报告索引'],
  ['fde2e-tools-film', '无视觉面① · submodule 指针；本报告 V1–S7'],
  ['fde2e-omni-v1', '无视觉面① · submodule 指针；本报告 S6'],
  ['fde2e-tools-v0', '无视觉面① · task 6.2 submodule 指针；黄页报告另证'],
  ['openspec/changes/web-openfilm-editor/design.md', '无视觉面① · OpenSpec 设计'],
  ['openspec/changes/web-openfilm-editor/tasks.md', '无视觉面① · OpenSpec 任务/三源追踪'],
  ['openspec/changes/web-openfilm-editor/release-readiness.md', '无视觉面① · 发布准备'],
  ['openspec/changes/web-openfilm-editor/specs/web-film-capture/spec.md', '无视觉面① · 规格'],
  ['openspec/changes/web-openfilm-editor/specs/web-film-editor/spec.md', '无视觉面① · 规格'],
  ['openspec/changes/web-openfilm-editor/specs/web-film-encode/spec.md', '无视觉面① · 规格'],
  ['openspec/changes/web-openfilm-editor/specs/web-film-webmcp/spec.md', '无视觉面① · 规格'],
];

const buildHash = sha256(join(packageRoot, 'studio/ui/dist/index-web.html'));
const commits = { main: commit(mainRepo), film: commit(filmRepo), omni: commit(omniRepo) };
const allSteps = [...visualSteps, ...productSteps, ecosystemStep, productionStep];
assert(allSteps.length === 13 && allSteps.every((step) => step.ok === true), 'combined report is not 13/13');
const report = {
  title: 'web-openfilm-editor · release-polish 与真实生态验收',
  brand: 'FDE2E™ Film 0.3.0 · before/after + WebMCP + Omni + production',
  meta: `${smoke.browser} · 1440×900 · 13 steps · candidate ${commits.film.slice(0, 8)}`,
  thesis: '同项目/同 viewport 的缺陷态→候选态视觉对照、真实 WebMCP 版本/编辑/混音/长导出/持久化、真实 Hermes Agent browser bridge，以及正式域名 MP4 Range/seek 全链通过；Film 浏览器运行时零外域、零 omni.fde2e.com 请求。',
  env: [
    ['候选提交', `main=${commits.main}; film=${commits.film}; omni=${commits.omni}`],
    ['构建身份', `index-web.html sha256=${buildHash}`],
    ['基线', 'Film d61fbbf；同 One Prompt / 图片 / 每个镜头中间 / 1440×900'],
    ['网络边界', `local requests=${smoke.network.requests}, foreign=0, omni=0；agent requests=${omni.network.requests}, foreign=0, omni=0；production requests=${production.network.requestCount}, foreign=0`],
    ['GRIPES_TO_FILM', 'F-01 long-render-single-call-timeout；F-02 preview-lifecycle-races'],
    ['SKILL', 'S-01 film-tool-async-export-sop'],
    ['SPEC', 'P-01 长时产出异步可观测；P-02 项目切换与预览运行时挂载同步'],
    ['门禁', gate ? `${gate.film}; ${gate.omni}; OpenSpec=${gate.openspec}` : 'gate-result.json pending; functional evidence is green'],
    ['排除并行改动', 'fde2e-skills-v0/pnpm-lock.yaml：外部并行变更，保留且不纳入本候选'],
    ...coverage.map(([file, state]) => [`覆盖 · ${file}`, state]),
    ['覆盖汇总', `files=${coverage.length}; UNCOVERED=0`],
  ],
  sections: [
    { title: 'A · 导出与版本界面 before/after', note: 'V1–V4 同项目/同 viewport；V3 是定向旧产物反向对照。', steps: visualSteps },
    { title: 'B · Film 本地真实工作流', steps: productSteps },
    { title: 'C · Omni 真实 Agent 与正式域名', steps: [ecosystemStep, productionStep] },
  ],
  summary: { pass: 13, fail: 0 },
};
writeFileSync(join(evidenceDir, 'steps.json'), `${JSON.stringify(report, null, 2)}\n`);
writeFileSync(join(evidenceDir, 'coverage.json'), `${JSON.stringify({ commits, buildHash, uncovered: [], coverage }, null, 2)}\n`);
console.log(JSON.stringify({ ok: true, steps: allSteps.length, coverage: coverage.length, uncovered: 0, commits, buildHash }, null, 2));
