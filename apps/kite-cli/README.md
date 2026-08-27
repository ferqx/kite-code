# Kite CLI

## 定位

`@kite-ai/kite-cli` 是 terminal presentation 与 Native client App。KLSV1-06 clean cutover 后，它不再是 Runtime
composition root；默认 TUI、`run` 与 `resume` 只连接由 companion `kite-service` 拥有的 Local Runtime Service。

## 拥有职责

- 拥有 CLI parser/output、Ink TUI、terminal interaction/rendering、client-safe reducer/projection，以及 language、theme、
  color preset、key binding 等 presentation-local preference。
- 通过 release composition 注入的 `kite-local-runtime/client` connector 取得 Runtime、History、App Control、Native
  credential 与 connection snapshot；CLI/TUI 自身不读取 descriptor/token/lock，也不 spawn Service。
- `src/service-mode/` 将 authenticated `LocalKiteConnection` 显式适配为 CLI/TUI facade；每个 surface 都是 typed
  method，不使用 `SessionManager` Proxy、Reflect fallback 或动态 registry。
- 完整 durable history 只走 `LocalKiteConnection.history` 的 client-safe DTO，并与 live event 使用同一 reducer；短期
  subscription replay、JSONL、trace 或 SQLite raw event 不是完整 history source。
- Workspace Trust 使用两阶段 admission：先 `prepareAppControl()`，经 exact App Control query/decision 与 revision CAS
  得到 Service-owned canonical identity；只有 trusted 后才 `connect()` 并取得 Workspace-bound one-shot Runtime ticket。
  untrusted/conflict/connection failure 均 fail closed，不打开 Runtime，也不回退 embedded。
- TUI exit 只关闭本 client connection、subscription 与 presentation resource；不 `abortAll()`、不 dispose Service Host。
  Ctrl+C 仍通过显式 Runtime cancel command 取消当前 Turn。

## 不拥有职责

- 不创建或依赖 Runtime Host、Runtime Server、SQLite Store、Builtin Runtime、Kernel、raw History projector、App Control
  repository、MCP Supervisor、Sandbox/Shell、Git backend、session logger 或 release authority。
- 不保留 InProcess/default embedded、direct Host/SQLite、old bridge、app-to-app import、try-new-catch-old 或复制 backend
  fallback。managed Service 不可用时直接失败。
- 不拥有 Service process/state/lifecycle manager。`kite service ensure/status/stop/restart` 只把命令转交给 release
  composition 注入的窄 manager port；CLI 不自行 discover、spawn、kill 或清理 Service state。
- 不提供 public `server --stdio` production entry；该旧 parser shape会被明确拒绝。Service-owned stdio 只用于
  parent-owned test/internal、显式非默认 Store 场景。

## 允许依赖

只允许依赖 browser-safe App Contract、Native-only local-runtime client、Runtime Client/Contract 与 presentation
libraries。不得依赖 `@kite-ai/runtime-host`、`@kite-ai/runtime-server`、`@kite-ai/runtime-storage-sqlite`、
`@kite-ai/builtin-runtime`、`@kite-ai/agent-kernel` 或 `apps/kite-service` source。

## 公开入口

导出 package 根入口以及 `@kite-ai/kite-cli/cli`、`@kite-ai/kite-cli/tui`。release/source entrypoint在 CLI 外组合
managed connector/lifecycle；installed candidate 从相邻的 `bin/kite-service` companion 启动同一 Service owner。

## 关键不变量

- terminal process 永远只有 client/presentation authority；新增 journey 必须显式扩展 client contract、adapter 与
  fake/native conformance test，不能重新取得 backend object。
- Runtime initialize 前必须完成 Service-owned Workspace Trust query/decision；wire path、cwd 或 client metadata不能
  提升 Workspace authority。
- connection close 与 Service owner shutdown分离。exit/reconnect只处理本 client generation；Service Session、Turn、
  interaction 与 Store lifecycle仍由 Service决定。
- client preference 只能包含纯展示设置；provider/model、credential、MCP、Trust、execution/release 与 checkpoints
  都由 Service owner处理。

## 本地文档

- [TUI 交互](docs/tui-interaction.md)
- [TUI 渲染](docs/tui-rendering.md)
- [TUI 本地化](docs/tui-localization.md)
- [TUI 系统测试](docs/tui-system-testing.md)
- [Runtime carrier client boundary](docs/runtime-server-carrier.md)
- [Runtime Application client boundary](docs/runtime-application.md)
- [Managed Local Service mode](docs/service-mode.md)

## 测试

`bun test apps/kite-cli/test`。这组测试验证 presentation、fake/native client facade 与 default fail-closed cutover；
Service Host/Store owner tests位于 `apps/kite-service/test`。当前CLI owner为680 parallel + 76 sandbox + 1
conformance，共757 tests；完整TUI system另通过40个isolated PTY scenario files。

## 文档影响

模块局部变化更新本 README 或上述本地文档；跨包 Runtime、Trust、process、release 或 qualification 行为同时更新
匹配的 `docs/active/` current authority。
