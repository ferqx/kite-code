# Kite App

## 定位

`@kite-ai/kite` 是唯一 concrete composition root，也是 CLI、TUI 和 App-owned Runtime coordination 的 owner。

## 拥有职责

- 在 `src/bootstrap.ts` 组装 Host、Builtin Runtime、SQLite、CLI 与 TUI adapter。
- 管理 App Session、Tool routing/persistence、配置、展示 projection 与 workspace integration。
- 通过 typed session adapter 向 TUI 提供 client surface。

## 不拥有职责

- 不直接依赖 Agent Kernel，不创建第二 Runtime assembly path。
- TUI 不取得 Kernel、Host execution、SQLite 或 Builtin executor authority。
- App 不复制 Store、Reducer、Registry 或 Tool handler。

## 允许依赖

允许依赖 Runtime Contract、SPI、Host、Builtin Runtime 与 SQLite adapter；不得直接依赖 `@kite-ai/agent-kernel`。

## 公开入口

导出根入口以及 `@kite-ai/kite/cli`、`@kite-ai/kite/tui`。具体 Runtime 组合只存在于 `src/bootstrap.ts`。

## 关键不变量

- App 是唯一 composition root。
- Runtime Session、Tool execution 与 Tool persistence 分别位于明确 owner 目录。
- 所有 TUI 行为只消费 typed projection，并遵守本地文档定义的交互和渲染边界。

## 本地文档

- [TUI 交互](docs/tui-interaction.md)
- [TUI 渲染](docs/tui-rendering.md)
- [TUI 本地化](docs/tui-localization.md)
- [TUI 系统测试](docs/tui-system-testing.md)

## 测试

`bun test apps/kite/test`

## 文档影响

模块局部变化更新本 README 或上述本地文档；跨包 Runtime 行为同时更新 [Runtime 架构](../../docs/active/six-concept-runtime-architecture.md)。
