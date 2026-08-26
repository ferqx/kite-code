# Kite App

## 定位

`@kite-ai/kite-cli` 是唯一 concrete composition root，也是 CLI、TUI、carrier 与 App-owned Runtime coordination 的 owner。

## 拥有职责

- 在 `src/bootstrap.ts` 组装唯一 Host、Builtin Runtime、SQLite、Server、Client、CLI、TUI 与 carrier adapter。
- 管理 App Session、Tool routing/persistence、配置、展示 projection、complete local history adapter、workspace integration 与 transport admission。
- TUI 与 foreground CLI 的 command/query/subscribe 都走 `RuntimeClient → RuntimeServer → RuntimeAccess` 一条路径；InProcess 仅是这条 Protocol 路径的 App-composed carrier，不是 Host bypass 或 fallback。
- 完整 durable history 走 `RuntimeClient.history → App exhaustive client-event projection → RuntimeLogQueryPort`，
  TUI list/load 不穿透 SessionManager 读取 Store，也不以 Server notification history、JSONL 或 trace 代替。
- `TuiRuntimeClientFacade` 与 `TuiSessionFacade` 是显式 InProcess client seam；不使用 Manager/SessionRuntime
  Proxy、Reflect fallback、动态 method 或 set trap。App Control 的 InProcess conformance adapter 对每个 use case
  独立经过 `@kite-ai/kite-app-contract` request/response codec。

## 不拥有职责

- 不直接依赖 Agent Kernel，不创建第二 Runtime assembly path。
- TUI/foreground CLI 不取得 Kernel、Host execution、SQLite 或 Builtin executor authority，也不保留 direct Host/SQLite/old bridge fallback。
- App 不复制 Store、Reducer、Registry 或 Tool handler。

## 允许依赖

允许依赖 browser-safe App Contract、Native local-runtime contract、Runtime Client/Contract/Protocol/Server、SPI、
Host、Builtin Runtime 与 SQLite adapter；不得直接依赖 `@kite-ai/agent-kernel`。当前 production 仍为 InProcess，
Native package 尚未启动或连接独立 Service。

## 公开入口

导出根入口以及 `@kite-ai/kite-cli/cli`、`@kite-ai/kite-cli/tui`。具体 Runtime 组合只存在于 `src/bootstrap.ts`。

## 关键不变量

- App 是唯一 composition root；Server、Client 与 carrier 都不得创建第二个 Host/Store/Kernel/Reducer authority。
- Runtime Session、Tool execution 与 Tool persistence 分别位于明确 owner 目录。
- 所有 TUI 行为只消费 typed projection 和 `RuntimeHistoryClient`，并遵守本地文档定义的交互和渲染边界。
- 新 client surface 必须显式增加 method/type/test；不能从 `SessionManager` 派生或自动代理新增 implementation 成员。
- `kite server --stdio` 是 parent-owned Desktop/test child carrier：stdout 只输出 JSONL protocol，stderr 只写诊断；EOF 只关闭该 connection，parent-owned signal/shutdown 才 drain Server 并释放 composition。它不是独立 daemon 或公开服务入口。
- development-only loopback WebSocket/reference carrier 仅用于本地 qualification。当前没有 `kite server --web`；ADR-0053 的 Web No-Go 仍有效，reference 不进入 production support。

## 本地文档

- [TUI 交互](docs/tui-interaction.md)
- [TUI 渲染](docs/tui-rendering.md)
- [TUI 本地化](docs/tui-localization.md)
- [TUI 系统测试](docs/tui-system-testing.md)
- [Runtime Server carriers](docs/runtime-server-carrier.md)

## 测试

`bun test apps/kite-cli/test`

## 文档影响

模块局部变化更新本 README 或上述本地文档；跨包 Runtime 行为同时更新 [Runtime 架构](../../docs/active/six-concept-runtime-architecture.md)。
