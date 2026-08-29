# Kite CLI

## 定位

`@kite-ai/kite-cli` 是 terminal presentation 与 Native client App。它不再是 Runtime composition root；当前 release/source
entrypoint 的默认 TUI、`run` 与 `resume` 经 Local Coordinator 定位 canonical Workspace 对应的 Workspace Worker，随后直接连接
该 Worker 的 Runtime data plane。`kite service *` 只保留为显式 legacy Service maintenance surface，不是默认执行路径。

## 拥有职责

- 拥有 CLI parser/output、Ink TUI、terminal interaction/rendering、client-safe reducer/projection，以及 language、theme、
  color preset、key binding 等 presentation-local preference。
- 通过 release composition 注入的 Worker connector 取得 Runtime、History、App Control、Native credential 与 connection
  snapshot；CLI/TUI 自身不读取 descriptor/token/lock，也不直接 spawn Worker。Coordinator client 只负责 closed resolve/ensure/mint。
- `src/service-mode/` 将 authenticated `LocalKiteConnection` 显式适配为 CLI/TUI facade；每个 surface 都是 typed
  method，不使用 `SessionManager` Proxy、Reflect fallback 或动态 registry。
- CLI parser/main 已实现封闭的 Web Gateway lifecycle surface：`kite web [--json]` 请求 ensure 并打印 Coordinator
  返回的一次性 launch URL，`kite web status [--json]` 只 discovery 已有 Gateway，`kite web stop` 请求显式 stop。
  这些命令只接受注入的 `CoordinatorRequestClient`，CLI 不自行发现、spawn、访问 Gateway 或取得 Controller。
- CLI另提供唯一显式Store迁移入口`kite maintenance migrate-run-store --target-generation <fresh-generation>`；parser只接受该exact
  shape与可选absolute`--kite-home`。CLI只输出release owner返回的closed JSON结果；blocked为非零退出，normal run/resume/ensure永不调用迁移。
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
- 不拥有 Service/Coordinator/Worker process state。`kite service ensure/status/stop/restart` 只把显式 maintenance 命令转交 legacy
  Service manager；默认 run/resume/TUI 使用 Coordinator + Worker connector。CLI 不自行 discover、spawn、kill 或清理 owner state。
  Store迁移命令同样只调用release注入的maintenance owner，不接收barrier boolean、不打开SQLite或解释State。
- `scripts/release/entrypoints/cli.ts` 按命令注入 legacy Service manager、production `CoordinatorRequestClient` 或 Worker connector；
  layout、Coordinator、Worker 或 Gateway 不可用时均 fail closed。parser/main contract 与本地 tests 不等于三平台 qualification。
- 不提供 public `server --stdio` production entry；该旧 parser shape会被明确拒绝。Service-owned stdio 只用于
  parent-owned test/internal、显式非默认 Store 场景。

## 允许依赖

只允许依赖 browser-safe App Contract、Native-only local-runtime client、Runtime Client/Contract 与 presentation
libraries。不得依赖 `@kite-ai/runtime-host`、`@kite-ai/runtime-server`、`@kite-ai/runtime-storage-sqlite`、
`@kite-ai/builtin-runtime`、`@kite-ai/agent-kernel` 或 `apps/kite-service` source。

## 公开入口

导出 package 根入口以及 `@kite-ai/kite-cli/cli`、`@kite-ai/kite-cli/tui`。release/source entrypoint在 CLI 外组合
managed connector/lifecycle；installed candidate 从同一 immutable release root 解析相邻 Coordinator、Worker、Gateway 与显式 legacy
Service companion。

## 关键不变量

- terminal process 永远只有 client/presentation authority；新增 journey 必须显式扩展 client contract、adapter 与
  fake/native conformance test，不能重新取得 backend object。
- Runtime initialize 前必须完成 Service-owned Workspace Trust query/decision；wire path、cwd 或 client metadata不能
  提升 Workspace authority。
- connection close 与 Worker owner shutdown分离。exit/reconnect只处理本 client generation；Session、Turn、interaction、Controller
  与 Store lifecycle仍由所属 Worker决定。
- release/source Worker connector 在同一 canonical Workspace 的 ensure、capability mint 或 instance handshake 返回短暂
  recovery-pending/unavailable 时，只在一次 `connect()` 内执行总计不超过 1.6 秒的有界全链重试，以闭合 dead/draining
  Worker descriptor 回收窗口；Manager 对 uncertain identity 不清理、不二次 spawn，Coordinator transport、protocol 或
  exact identity mismatch仍立即fail closed，且不会回退legacy Service或embedded backend。每个默认logical connection使用独立
  client identity，不能让并发generation互相覆盖capability。
- client preference 只能包含纯展示设置；provider/model、credential、MCP、Trust、execution/release 与 checkpoints
  都由 Service owner处理。
- TUI `/web` 是 discovery-only：只调用可选的 `discoverWebGateway` callback；没有已有 Gateway 时显示
  `Kite Web is not running. Run \`kite-code web\`.`，不启动 Gateway、不取得 Controller。release TUI entrypoint 已注入该
  discovery callback；它不会把 Browser Observer 升级为 Controller，也不能把本地 asset/entrypoint smoke 写成 hosted support。

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
Service/Worker Host/Store owner tests位于 `apps/kite-service/test`。当前default runner的CLI owner为704 tests，加76个sandbox与
1个native conformance，共781 tests；完整TUI system由独立PTY runner验证。

## 文档影响

模块局部变化更新本 README 或上述本地文档；跨包 Runtime、Trust、process、release 或 qualification 行为同时更新
匹配的 `docs/active/` current authority。
