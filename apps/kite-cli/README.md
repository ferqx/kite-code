# Kite CLI

## 定位

`@kite-ai/kite-cli` 是 terminal presentation 与 client App。它不再是 Runtime composition root；当前release/source默认TUI与CLI
`run/resume`各自连接配套的parent-owned stdio App Server，多个客户端共享durable Session Store但不共享进程。`kite web`
只发现显式daemon；旧`service *`控制面已经删除。CLI不拥有Runtime或Store。

## 拥有职责

- 拥有 CLI parser/output、Ink TUI、terminal interaction/rendering、client-safe reducer/projection，以及 language、theme、
  color preset、key binding 等 presentation-local preference。偏好写入使用`@kite-ai/kite-local-runtime/config`的per-file lock与atomic
  replacement；两个TUI或TUI/App Server并发修改不同字段不得lost update。
- 通过release composition注入的Runtime connector取得Runtime、History、App Control、credential与connection snapshot；release owner
  spawn配套child，CLI/TUI App本身不解析executable、descriptor、token或Store。
- `src/service-mode/` 将parent-owned `KiteAppServerConnection`投影为中性
  Runtime mode facade；每个 surface 都是 typed
  method，不使用 legacy session-manager Proxy、Reflect fallback 或动态 registry。
- CLI parser/main提供显式`kite server start/status/stop`与`run/resume --server <endpoint>`；它们只连接调用者指定或当前profile的
  owner-only Unix socket/Windows named pipe，不参与默认run/TUI发现。daemon启动时固定一个canonical Workspace；另一Workspace连接会
  fail closed。`kite web [--server <endpoint>] [--json]`只读取已经显式启动的daemon status并打印stable `webOrigin`；absent、incompatible或
  identity uncertain直接失败，不隐式start/upgrade/stop。不存在独立`web status/stop`或客户端asset root注入。
- 默认TUI `/status`展示`stdio` transport、source/installed profile、build、App Server version与initialize已证明的same-build pairing；
  显式`--server`显示Unix/named-pipe transport与exact-protocol compatible pairing，daemon build只作诊断；
  不展示Service PID、Web URL或build drift。
- initialize返回`server_mismatch`时，启动入口按已选择的pairing给出恢复建议：默认same-build提示更新或重新安装不完整的Kite Code，
  显式daemon提示更新或使用matching client，并在升级后关闭旧daemon再启动；不按client semver推断兼容性，也不自动操作daemon。
- 完整 durable history 只走 `KiteAppServerConnection.history` 的 client-safe DTO，并与 live event 使用同一 reducer；短期
  subscription replay、JSONL、trace 或 SQLite raw event 不是完整 history source。
- Workspace Trust 使用两阶段 admission：先 `prepareAppControl()`，经 exact App Control query/decision 与 revision CAS
  得到 Service-owned canonical identity；只有 trusted 后才 `connect()` 并取得 Workspace-bound one-shot Runtime ticket。
  untrusted/conflict/connection failure 均 fail closed，不打开 Runtime，也不回退 embedded。
- Native interaction始终从最新权威Session projection取得完整queue。无关durable event推进CAS后，client用相同稳定identity和最新
  `sessionRevision`重建`respond_interaction`；interaction revision必须等于command expected revision，过期Enter/Esc不得回退到active Session。
- TUI exit只关闭本client connection、subscription、presentation resource及其parent-owned App Server；不删除durable facts，也不`abortAll()`。
  确认退出后先同步unmount并归还terminal/cursor，再执行有界observability和connection清理，慢速清理不能让最后一帧继续占用终端。
  退出前按 exact Session projection确认Controller disposition：idle且无pending interaction时release，active/pending或query不确定时
  detach；Ctrl+C 仍通过显式 Runtime cancel command 取消当前 Turn。
- 连续普通prompt使用per-Session client-local FIFO，不同Session互不阻塞；active Run期间的新prompt进入独立的live-only queued展示层，不插入当前Turn blocks、
  不改变子Agent或工具卡。轮到执行时移除queued展示并建立新Turn；`runtime_busy`保持排队并使用新command identity重试，
  不显示发送失败。等待期间到达的前序Run terminal按revision隔离，不能污染后继receipt的Run identity。queued展示只有在
  `start_turn` receipt被接受后才移除并建立可见新Turn；后台Session也按prompt identity清理展示。receipt与durable `user.message`
  允许乱序：queued entry与pending echo必须原子交接，message先到时消费对应live-only queue entry，receipt先到时建立pending echo，最终都只保留
  一个以`messageId`为权威的用户块。活动Session的queued展示按FIFO逐条显示为浅色背景的单行`↵ 消息内容`，队列可见时隐藏`Working`状态行，首项前与相邻项之间各保留一行间距；稳定Footer owner与浅比较隔离的OutputArea保证queue增减不重挂载当前消息、
  不重算或改变当前Thought、Tool及Delegating的折叠形态。非空prompt拥有提交Enter，OutputArea不得用同一个按键展开最后一个动态块；空prompt的Enter才保留既有展开/折叠入口。queued chrome不参与消息区的动态高度预算。Enter后普通idle启动同样先显示带live-only pending标记的本地prompt，durable `user.message`只原位补齐
  `messageId`，提交失败移除仍未确认的pending echo。每轮只有applied receipt后才登记
  `sessionId/runId/commandId/revisionFloor` accepted identity，并启动2秒后、至多每2秒一次的bounded exact `get_run` fallback；
  query只接受同runId且不早于revision floor的precise terminal，迟到candidate/waiter/finally不能清除后继轮状态。Ink flush只作展示屏障：
  正常等待真实commit，但最多1秒；UI promise迟到或失败不能停止canonical subscription、后续answer/terminal或下一条prompt。
- run promise只接受跨过当前command revision floor、且与receipt canonical `runId`一致的`run.terminal`；失败由
  `status=failed`及其terminal outcome表达；`turn.terminal`
  与`task.terminal`只参与展示。上一轮迟到的Turn/Task终态不能结束刚applied的后继Run。本地run Promise收尾不向
  reducer生成idle/cancelled事实；Session投影暂缺`currentRun`也不结束Run。subscription gap只查询exact Run resource；
  `unknown/recovery_required`返回recovery-needed错误并继续阻塞successor，failed拒绝，completed/cancelled按现有facade语义收敛。
- 活动Turn收到Esc/Ctrl+C时，TUI在同一输入轮先显示`Cancelling`，并把重复按键合并到该Session唯一的in-flight
  `cancel_turn` Promise。连接恢复后若替换的Service controller尚未恢复该Session，首个`session_unavailable`拒绝证明取消未提交；
  client先用同一Session恢复mutation authority，再核对仍是原Run并以刷新revision重试一次。其他receipt失败清除本地pending状态并显示可重试诊断。排队后继只有在前驱Subagent Provider
  cleanup全部确认后才可取得`start_turn` receipt，用户取消已经写入的waived capability终态不得在同进程cleanup中被改写为unknown。
- 普通模型正文仍按完整Markdown组件提交；没有待判定Thought归属时，完成的段落、列表项和已闭合结构组件立即进入Static，
  只有仍增长的表格/围栏代码容器留在dynamic。当前仍有探索Thought时，待分类正文只保存在有界`RequestAssembly`，
  不创建隐藏OutputBlock；`model.responded(toolCallCount=0)`才补齐并发布最终正文，`toolCallCount>0`丢弃待分类正文、把过程旁白
  留在同一Thought且不渲染，匹配工具和后续模型调用继续原聚合块。未到提交边界的cumulative text继续留在request source。
  `model.responded`可以省略optional summary，reducer必须用已接收buffer收口最后一段，不能把合法回答清成空白。

## 不拥有职责

- 不创建或依赖 Runtime Host、Runtime Server、SQLite Store、Builtin Runtime、Kernel、raw History projector、App Control
  repository、MCP Supervisor、Sandbox/Shell、Git backend、session logger 或 release authority。
- 不保留 InProcess/default embedded、direct Host/SQLite、old bridge、app-to-app import、try-new-catch-old 或复制 backend fallback。
  配套App Server不可用时直接失败，不回退legacy Service。
- 不拥有App Server/Coordinator/Worker process state。daemon lifecycle与Web discovery由release composition持有；普通client断开不停止daemon，
  `server stop`取消active Turn并完成bounded drain。默认run/resume/TUI不discover或ensure该owner。
- `scripts/release/entrypoints/cli.ts`为run/resume注入App Server connector，为`kite web`注入daemon status discovery；
  不组合legacy Coordinator或Store migration。
  任一owner不可用时fail closed。parser/main contract与本地tests不等于三平台qualification。
- 不提供 public `server --stdio` production entry；该旧 parser shape会被明确拒绝。Service-owned stdio 只用于
  parent-owned test/internal、显式非默认 Store 场景。

## 允许依赖

只允许依赖 browser-safe App Contract、Native-only local-runtime client、Runtime Client/Contract 与 presentation
libraries。不得依赖 `@kite-ai/runtime-host`、`@kite-ai/runtime-server`、`@kite-ai/runtime-storage-sqlite`、
`@kite-ai/builtin-runtime`、`@kite-ai/agent-kernel` 或 `apps/kite-service` source。

## 公开入口

导出 package 根入口以及 `@kite-ai/kite-cli/cli`、`@kite-ai/kite-cli/tui`。release/source entrypoint在 CLI 外组合
managed connector/lifecycle；installed candidate从同一immutable release root解析App Server executable与Web assets。额外Coordinator/Worker/Gateway
executable、release entrypoint与slot均已删除。

## 关键不变量

- terminal process 永远只有 client/presentation authority；新增 journey 必须显式扩展 client contract、adapter 与
  fake/native conformance test，不能重新取得 backend object。
- App Server协议initialize只建立transport/App Control能力；Runtime mutation前必须完成Workspace Trust query/decision。wire path、cwd或
  client metadata不能提升Workspace authority。
- connection close会收掉本client-owned App Server但不删除Session facts；Session、Turn、interaction与Store authority仍由durable Store fencing决定。
- first-run连接配套App Server，但Provider未配置时只使用neutral App Control/credential surface；CLI不创建bootstrap Host、第二Runtime或
  本地config authority。配置完成后的首个Runtime请求才创建Workspace execution context。
- installed默认从launcher-pinned immutable candidate解析同candidate `kite-service`；source默认使用当前Bun与checked-in Service entrypoint。
  两者都spawn parent-owned stdio App Server，以同一build ID和完整capability在initialize精确复核；source使用worktree profile，installed使用
  canonical `kite-session.sqlite`，不查PATH、running Service或fallback。配对build/protocol/capability不匹配时fail closed；不存在
  previous-build replacement。mutation不自动重放，也不会回退legacy Coordinator/Worker或embedded backend。
- TUI `/status`显示当前App Server transport/profile/build/version与exact pairing事实；mismatch在initialize时fail closed，因此普通启动不产生
  build drift告警，也不把Web URL当Runtime identity。
- client preference 只能包含纯展示设置；provider/model、credential、MCP、Trust、execution/release 与 checkpoints
  都由 Service owner处理。
- TUI启动不构建Web assets、不ensure canonical Service/daemon、不监听HTTP；两个默认TUI各有一个child且共享同一durable profile。

## 本地文档

- [TUI 交互](docs/tui-interaction.md)
- [TUI 渲染](docs/tui-rendering.md)
- [TUI 本地化](docs/tui-localization.md)
- [TUI 系统测试](docs/tui-system-testing.md)
- [Runtime carrier client boundary](docs/runtime-server-carrier.md)
- [Runtime Application client boundary](docs/runtime-application.md)
- [App Server client mode](docs/service-mode.md)

## 测试

`bun test apps/kite-cli/test`。这组测试验证 presentation、fake/native client facade 与 default fail-closed cutover；
Service/Worker Host/Store owner tests位于 `apps/kite-service/test`。当前CLI workspace共833 tests；完整TUI system由独立PTY runner验证。

## 文档影响

模块局部变化更新本 README 或上述本地文档；跨包 Runtime、Trust、process、release 或 qualification 行为同时更新
匹配的 `docs/active/` current authority。
