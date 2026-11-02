# components/ui — shadcn/ui 官方收编层

来源：shadcn/ui 官方 registry `base-nova` style（https://ui.shadcn.com/r/styles/base-nova/{name}.json），
2026-11-02 取回。**逐字收编，零改动**；仅两处机械适配（项目纪律允许项）：

1. `@/app/(create)/components/icon-placeholder` → `@/components/ui/icon-placeholder`
   （本仓 icon 库＝lucide-react，适配位映射取官方占位的 lucide 分支）；
2. registry 内部相对引用 → 本仓别名 `@/components/ui/*`。

主题：官方组件按 shadcn 语义令牌取色；`src/globals.css` 的 `@theme inline` 块把这些
令牌桥接到本仓 design token（--bg/--text/--accent…），主题仍由本仓单源。

升级对照：重取 registry JSON 与本目录 diff。源 JSON 不入库（体积大且可重取；重取命令
`curl https://ui.shadcn.com/r/styles/base-nova/{name}.json`）。
