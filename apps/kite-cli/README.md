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
- `src/runtime-application/` 与 `src/app-control/` 是当前 app-local、可迁移的 InProcess owner seam。一个真实
  Host/SQLite Store 可通过 canonical Workspace context router承载多个 Workspace 与 Session；每个 logical
  connection 具有独立 admission，只有 create 使用 connection admitted Workspace，resume/query/subscribe/fork
  必须匹配持久 Session identity。connection close 只释放 client/subscription/broker binding，不取消 Turn、交互
  waiter 或关闭 owner；drain/cancel/Host close 是显式 Runtime Application lifecycle。
- Workspace Trust、Provider/model、MCP、Skill、execution/release 与 first-run credential 已经通过 exact App Control
  或 Native credential client 进入 TUI。Config repository、MCP Supervisor、actual Skill manifest、Sandbox/Shell、
  observability 与 checkpoint composition 留在 app-local owner，不跨 TUI client seam。
- `src/service-mode/`提供KLSV1-05 opt-in typed connection view，只暴露Native connection的Runtime/History/App Control/
  credential/service status/snapshot generation并委托reconnect/close；它不读descriptor/token file、不启动Service、不发送cancel或
  Host dispose，也不在connector失败时回退InProcess。普通production bootstrap仍未切换。

## 不拥有职责

- 不直接依赖 Agent Kernel，不创建第二 Runtime assembly path。
- TUI/foreground CLI 不取得 Kernel、Host execution、SQLite 或 Builtin executor authority，也不保留 direct Host/SQLite/old bridge fallback。
- App 不复制 Store、Reducer、Registry 或 Tool handler。

## 允许依赖

允许依赖 browser-safe App Contract、Native local-runtime contract、Runtime Client/Contract/Protocol/Server、SPI、
Host、Builtin Runtime 与 SQLite adapter；不得直接依赖 `@kite-ai/agent-kernel`。当前 production 仍为 InProcess；
Native connector与Service-mode adapter只由KLSV1-05 opt-in/process harness使用。

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
- [Runtime Application 与 App Control](docs/runtime-application.md)
- [Opt-in Service mode](docs/service-mode.md)

## 测试

`bun test apps/kite-cli/test`

## 文档影响

模块局部变化更新本 README 或上述本地文档；跨包 Runtime 行为同时更新 [Runtime 架构](../../docs/active/six-concept-runtime-architecture.md)。
