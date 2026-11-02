# FDE2E Film

纯 Web 在线剪辑工具——`film.tool.fde2e.com` 的源码仓。**based on [OpenFilm](https://github.com/openfilm/openfilm)（MIT）**，经破坏性转化为纯 Web 形态：

```
CLI/playwright 操控 ──▶ WebMCP 工具面（人机双轨，同一状态机）
ffmpeg CLI 渲染   ──▶ 浏览器内 encodeBackend（WebCodecs 主力 / ffmpeg.wasm 兜底）
studio server 文件面 ─▶ OPFS（零弹窗持久化）＋ FSA 存回（高级选配）
```

由 FDE2E（昭智羽名(厦门)科技有限公司）维护；对外品牌 **FDE2E™**，不使用上游商标。

## Fork 链

- 上游锚定：`openfilm/openfilm@9375992`（2026-11-02），fork 决策与改造记录见 [FORK.md](FORK.md)。
- 许可：MIT 沿链——上游 [LICENSE](LICENSE) 与 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) 原样保留；本仓新增贡献同以 MIT 发布。
- 本仓库为独立仓（不使用 GitHub fork 网络），上游保留为 `upstream` remote；不向上游回 PR。

## 开发

```bash
pnpm install
pnpm dev          # Studio（编辑器）本地起服
pnpm test         # 全套测试
pnpm build        # 构建 Studio UI
```

格式协议见 [packages/openfilm/SPEC.md](packages/openfilm/SPEC.md)、操作动词手册见 [packages/openfilm/MANUAL.md](packages/openfilm/MANUAL.md)。
