# Kite CLI

## 定位

`@kite-ai/kite-cli` 是 terminal presentation 与 Native client App。它不再是 Runtime composition root；当前 release/source
entrypoint的默认TUI、`run/resume`、`service *`与`web`按canonical Kite Home连接唯一Local Service；CLI不拥有Runtime或Store。

## 拥有职责

- 拥有 CLI parser/output、Ink TUI、terminal interaction/rendering、client-safe reducer/projection，以及 language、theme、
  color preset、key binding 等 presentation-local preference。偏好写入使用`@kite-ai/kite-local-runtime/config`的per-file lock与atomic
  replacement；两个TUI或TUI/App Server并发修改不同字段不得lost update。
- 通过release composition注入的single-Service connector取得Runtime、History、App Control、Native credential与connection
  snapshot；CLI/TUI自身不读取descriptor/token/lock，也不直接spawn后端进程。
- `src/service-mode/` 将 authenticated `LocalKiteConnection` 显式适配为 CLI/TUI facade；每个 surface 都是 typed
  method，不使用 `SessionManager` Proxy、Reflect fallback 或动态 registry。
- CLI parser/main只保留`kite web [--json]`：它ensure唯一Service并通过Native `describe`打印稳定的Service根地址。Web assets已在Service
  ready前验证和挂载，不存在独立`web status/stop`、asset root客户端注入或Web lifecycle diagnostic。
- release entrypoint把已选择的`source|installed` executable mode显式注入`service ensure/status/stop/restart`请求；CLI不从cwd、argv形状或
  Service返回值猜部署形态，因此installed active-candidate换代不会因mode丢失退化为`build_mismatch`。
- single-Service Web callback由release/source默认入口选择；`/status`在同一状态输出中展示Service identity与稳定Web根地址。TUI启动只ensure Service，
  不额外attach route、启动进程或取得Browser/Controller authority。
- 完整 durable history 只走 `LocalKiteConnection.history` 的 client-safe DTO，并与 live event 使用同一 reducer；短期
  subscription replay、JSONL、trace 或 SQLite raw event 不是完整 history source。
- Workspace Trust 使用两阶段 admission：先 `prepareAppControl()`，经 exact App Control query/decision 与 revision CAS
  得到 Service-owned canonical identity；只有 trusted 后才 `connect()` 并取得 Workspace-bound one-shot Runtime ticket。
  untrusted/conflict/connection failure 均 fail closed，不打开 Runtime，也不回退 embedded。
- TUI exit 只关闭本 client connection、subscription 与 presentation resource；不 `abortAll()`、不 dispose Service Host。
  退出前按 exact Session projection确认Controller disposition：idle且无pending interaction时release，active/pending或query不确定时
  detach；Ctrl+C 仍通过显式 Runtime cancel command 取消当前 Turn。
- 连续普通prompt使用client-local FIFO；terminal通知仍携带active work时，每一轮都建立绑定该轮completion callback的remote-idle waiter。
  每轮只有applied receipt后才登记accepted completion identity，并启动2秒后、至多每2秒一次的bounded query fallback；它只在projection满足
  当前revision floor且权威idle时收敛current run，弥补terminal/idle notification gap，迟到waiter/finally不能清除后继轮状态。Ink flush只作展示屏障：
  正常等待真实commit，但最多1秒；UI promise迟到或失败不能停止canonical subscription、后续answer/terminal或下一条prompt。
- run promise只接受跨过当前command revision floor、且与receipt canonical `runId`一致的`run.terminal|run.failure`；`turn.terminal`
  与`task.terminal`只参与展示。上一轮迟到的Turn/Task终态不能结束刚applied的后继Run。
- 普通模型正文仍只按完整Markdown组件发布；未到段落边界的cumulative text保存在request-scoped隐藏buffer。`model.responded`
  可以省略optional summary，reducer必须用已接收buffer收口最后一段，不能把合法回答清成空白。

## 不拥有职责

- 不创建或依赖 Runtime Host、Runtime Server、SQLite Store、Builtin Runtime、Kernel、raw History projector、App Control
  repository、MCP Supervisor、Sandbox/Shell、Git backend、session logger 或 release authority。
- 不保留 InProcess/default embedded、direct Host/SQLite、old bridge、app-to-app import、try-new-catch-old 或复制 backend
  fallback。managed Service 不可用时直接失败。
- 不拥有Service/Coordinator/Worker process state。`kite service ensure/status/stop/restart`与默认run/resume/TUI使用同一
  single-Service manager/connector；CLI不自行discover、spawn、kill或清理owner state。
- `scripts/release/entrypoints/cli.ts`只注入single-Service manager/connector/Web root discovery，不组合legacy Coordinator或Store migration。
  任一owner不可用时fail closed。parser/main contract与本地tests不等于三平台qualification。
- 不提供 public `server --stdio` production entry；该旧 parser shape会被明确拒绝。Service-owned stdio 只用于
  parent-owned test/internal、显式非默认 Store 场景。

## 允许依赖

只允许依赖 browser-safe App Contract、Native-only local-runtime client、Runtime Client/Contract 与 presentation
libraries。不得依赖 `@kite-ai/runtime-host`、`@kite-ai/runtime-server`、`@kite-ai/runtime-storage-sqlite`、
`@kite-ai/builtin-runtime`、`@kite-ai/agent-kernel` 或 `apps/kite-service` source。

## 公开入口

导出 package 根入口以及 `@kite-ai/kite-cli/cli`、`@kite-ai/kite-cli/tui`。release/source entrypoint在 CLI 外组合
managed connector/lifecycle；installed candidate从同一immutable release root解析Service与Web assets。额外Coordinator/Worker/Gateway
executable、release entrypoint与slot均已删除。

## 关键不变量

- terminal process 永远只有 client/presentation authority；新增 journey 必须显式扩展 client contract、adapter 与
  fake/native conformance test，不能重新取得 backend object。
- Runtime initialize 前必须完成 Service-owned Workspace Trust query/decision；wire path、cwd 或 client metadata不能
  提升 Workspace authority。
- connection close与Service owner shutdown分离。exit/reconnect只处理本client generation；Session、Turn、interaction、Controller与
  Store lifecycle仍由Service决定。
- first-run连接同一个Service，但Provider未配置时只使用neutral App Control/credential surface；CLI不创建bootstrap Host、第二Runtime或
  本地config authority。配置完成后的首个Runtime请求才创建Workspace execution context。
- installed connector只ensure canonical shared Service；source TUI默认使用invocation-scoped standalone endpoint，并在退出时关闭connection后停止
  composition-owned Service。source只有显式`--server shared`才使用canonical endpoint。exact dead owner才清理reservation/socket并spawn，alive/uncertain/corrupt identity不替换。
  Native `describe`返回兼容Service的actual build；显式shared source只读复用另一`dev:` build及其Web root，installed active candidate对另一installed
  build执行verified replacement，source↔installed返回typed `build_mismatch`且不替换。Protocol/client-contract/identity不兼容保持fail closed。
  普通跨build `service stop/restart`由owner build控制并返回typed `build_mismatch`；source不再拥有previous-build replacement authority。
  manager mutation不自动重放，也不会回退legacy Coordinator/Worker或embedded backend。
- TUI `/status`显示client/service version、actual/expected build与派生version status；显式shared source的`dev:`→`dev:` drift只显示事实，
  installed或source↔installed mismatch不得伪装成开发态drift。该状态只由当前connection identity派生，不新增持久化升级状态。
- client preference 只能包含纯展示设置；provider/model、credential、MCP、Trust、execution/release 与 checkpoints
  都由 Service owner处理。
- TUI启动只ensure唯一Service；Web assets已经是Service readiness的一部分。`/status`调用可选的`discoverWeb` callback，通过Native
  `describe`取得稳定的`origin/`；它不attach route、不启动第二进程、不取得Controller。

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
