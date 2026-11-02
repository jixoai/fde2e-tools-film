# Fork 链 — fde2e-tools-film

> FDE2E Film：纯 Web 在线剪辑工具。本仓是 [openfilm/openfilm](https://github.com/openfilm/openfilm)（MIT）的
> 破坏性转化 fork——CLI 操控转 WebMCP、ffmpeg CLI 转浏览器内 encodeBackend、本地文件面转 OPFS。
> 对外部署 `film.tool.fde2e.com`；对外品牌 **FDE2E**（不挂上游商标——上游 TRADEMARK.md 随 fork 切除，其商标边界以本文件为准）。

## 锚定

| 项 | 值 |
|---|---|
| 上游 | https://github.com/openfilm/openfilm |
| 锚定 commit | `9375992`（2026-11-02，main tip at fork time） |
| fork 方式 | 上传全树后新建 `origin`（jixoai/fde2e-tools-film），上游保留为 `upstream` remote；**不向上游回 PR**，fork 独立演进 |
| 示例索引 | 上游 `openfilm/examples`，锚定见 `packages/openfilm/examples-index/SOURCE`（T13 牌照核查引用 `65d717b` / index 锚 `2e8f478`） |
| 官方 skills | 上游 `openfilm/skills`，锚定见 `packages/openfilm/skills/SOURCE` |
| 暂留面 | `src/skills-cli.mjs`（CLI 技能安装逻辑）与 `playwright-core` 渲染管线均为**暂留**：后者由 batch 3 捕获车道接管时切，前者随 WebMCP 技能面定形时处置（FORK.md 登记，避免未申报残渣） |

## 改名决策记录

- 上游 MIT LICENSE 文本**原样保留**（© OpenFilm contributors 沿链）；本仓新增贡献归 FDE2E（昭智羽名(厦门)科技有限公司）。
- 上游 `THIRD_PARTY_NOTICES.md` **原样保留**于本仓根与 `packages/openfilm/`（沿链义务）。
- 对外不使用 OpenFilm 商标名/logo 作为品牌（页面脚注 "based on OpenFilm" 指向本 fork 仓，不直跳上游）。
- 破坏性改造清单随 openspec change `web-openfilm-editor` 演进（见主仓 openspec/changes/web-openfilm-editor）。

## 与上游的关系

- 随上游演进：定期对照 upstream（Studio/MANUAL/film 协议非稳定面，锚点登记处同步）。
- 不回 PR：改造是产品级分叉（Web 化），不适用于上游。
