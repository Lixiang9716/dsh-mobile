# system-plugins/

系统实现插件·契约适配层（JS，三端共用）：

- `dsh-fs-ios` → 实现 `ctx.fs`（security-scoped 语义 + workspace 边界）
- `dsh-subprocess-quickjs` → 实现 `ctx.subprocess`（协程化执行器）
- `dsh-notify-ios` / `dsh-credentials-ios` / `dsh-ui-ios` …

只消费 `contract/` 原语，实现上游 DSH 服务契约；上层 Harness 核心零改动。
