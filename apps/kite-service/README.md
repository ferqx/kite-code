# Kite App Server

## 定位

`@kite-ai/kite-service` 是 Kite 的 backend composition owner。默认 TUI/CLI 为每个 client 启动同 build、parent-owned
`app-server run-stdio`；多个 App Server 进程共享同一 profile 的 `kite-session.sqlite`，但由 durable
`controllerGeneration` 保证一个 Session 同时只有一个 execution writer。进程、连接、PID 与 build identity 都不是 Session authority。

显式 `kite server start` 启动同一 composition 的本机 daemon。daemon 使用 owner-only Unix socket 或 current-user named pipe
服务 TUI/CLI，并用唯一 loopback HTTP listener 提供同 build Web assets、API Docs 与 Browser read-only `/v1`。普通 client 断开
不停止 daemon；只有 `server stop` 或 OS signal 触发 cancel、drain 与 endpoint cleanup。

## 拥有职责

- `src/app-server.ts` 解析 parent 明确提供的 profile、Workspace、build 与配置路径，并组合 Runtime、History、App Control、
  credential、Host、Builtin 与 Store owner。
- `src/app-server-daemon.ts` 只增加显式 process owner、stable local endpoint、server control 和 Web listener；它不增加
  Session registry、Storage daemon 或 build replacement。
- `src/composition.ts` 组合 application domain；transport 由 stdio parent 或 daemon endpoint owner 持有。
- `bootstrap.ts` 打开 `kite-session.sqlite`，提供 multi-connection SQLite、Session execution fencing、revision CAS、
  effect receipt/recovery、checkpoint 与 typed Artifact backend。
- 用户配置、Provider/model、MCP、Project approval 与 Workspace Trust 使用 owner-specific file lock、持锁重读和 atomic
  replacement，不建立 global config daemon。
- Web 只读 principal 与 Native Runtime principal 严格分离；Browser cookie 不能调用 Runtime mutation/control。

## 不拥有职责

- 不拥有terminal presentation、client preference、release pointer、remote discovery或Browser mutation。
- 不把process、PID、socket、build或Web origin提升为Session/Store authority。
- 不提供第二默认Store、embedded fallback、dual write、后台migration或upgrade watcher。

## 允许依赖

允许依赖backend composition所需的Runtime Host/Server/SPI/Contract/Protocol、Builtin Runtime、SQLite adapter、App Contract、
Agent API Contract与local-runtime substrate；禁止依赖CLI/TUI source。

## 公开入口

compiled `kite-service` 只接受内部入口：

- `app-server run-stdio`：由默认 TUI/CLI parent 启动；
- `app-server run-daemon`：由显式 `kite server start` 启动；
- MCP stdio wrapper 与 process-tree supervisor 的 fixed private marker。

旧 `service run-single`、`kite service ensure/status/stop/restart`、canonical Service discovery、previous-build replacement、
Native lifecycle token/descriptor 与 Service-owned Web listener 均已删除。无法识别的入口直接失败。

## 关键不变量

- source 与 installed 使用相同协议、Store schema 和 execution 语义；source 按 canonical checkout 隔离 profile，installed 使用
  canonical profile。
- parent-owned App Server 必须与 client exact build 配对；显式 daemon 只按 fixed protocol/capability 判断兼容，build 仅用于诊断。
- release upgrade/rollback 只切换 active candidate；不发现、停止、替换或升级运行中的 daemon。
- App Server 退出不删除 Session/History；同 Session takeover 只能通过 durable generation、cleanup 与 recovery rules。
- unknown effect outcome 不重放；stale generation 不能 dispatch 或 commit。
- 并发 Shell effect 即使把终态直接持久化并返回空事件数组，也必须依据共享 State revision 重新调度；空返回只能登记为
  零进展候选，全部后台 sibling 收敛、待发布事件排空且 revision 仍完全未前进后才可停止。全部 sibling 终结后必须继续模型调用并
  产生明确 Run/Turn terminal；runner 意外返回时必须在同一 durable batch 持久化失败与 Turn abort，不能留下孤立的 `running` Run或
  投影虚假的 completed。
- `CliRuntimeBridge`不维护`#running/#activeWork`影子生命周期；admission读取Coordinator，投影读取committed
  Task与Store Run。bridge/presentation异常若发生在active Turn内，会原子持久化unknown outcome与`turn.aborted`，使Store Run进入
  recovery-required边界；缺少真实Turn identity的`run.error`不会伪造Run id进入Client。
- 模型选择保存成功后只更新desired config；active Run继续使用`start_turn` admission时冻结的完整配置与真实Provider route，
  下一Run才解析desired config。Runtime投影在active期间保持该Run的model identity，不能让Header先于Provider request切换。
- Kernel event到Runtime Client的投影使用穷尽coverage表；每个event必须明确归类为client-visible、internal-only、
  client-unavailable或由canonical event规范化。新增event不得通过`default: undefined`静默消失，无法安全投影时只发布有界
  `unavailable`。可选client-safe文本字段为空时必须省略；尤其无匹配内容的Subagent工具结果不得投影`summary: ""`并破坏
  notification消费与后续取消。
- `user_input.answered`投影必须保留经过client-safe长度限制的answer summary；不得只发送interaction identity而让TUI在Footer
  关闭后丢失用户选择，也不得把完整内部Tool Result作为答案恢复来源。
- 用户取消并发Subagent后，当前execution owner必须在释放Session单飞权之前完成全部Provider lifecycle cleanup；cleanup pending时
  后继`start_turn`只返回`runtime_busy`。同进程cleanup保留取消事务已写入的waived capability终态，只有真正的restore/crash恢复才收敛unknown。
- Service的production Subagent adapter始终向Builtin child模型循环提供固定的12轮工具响应上限；该本地收敛边界在共享
  `resourceBudget`关闭时仍生效。达到上限后只执行一次无工具总结调用，不能以30分钟执行超时替代循环收敛。
- 一个已接纳Run的所有公开durable/ephemeral presentation notification复用admission时固定的`runId/taskId/turnId`；取消事务和Turn终态后迟到的Subagent/Tool cleanup事实不得从已settled的Session snapshot反推identity。
- Effect stream因取消、presentation/bridge关闭或consumer退出而结束时，必须先关闭该stream的事件确认通道；非协作executor的
  late `persistEvent(s)`立即返回未应用，不能进入无人消费的队列、永久悬挂Promise或修改已经关闭的Run投影。
- default TUI/CLI 不启动 HTTP，也不发现 daemon；`kite web` 只读取已经运行的 daemon status。
- 不提供 remote/LAN、多租户、Browser mutation、dual write、旧 Store 自动迁移或 embedded fallback。

## 文档

- [Runtime application](docs/runtime-application.md)
- [Runtime carrier](docs/runtime-server-carrier.md)
- [App Server auth](docs/service-auth.md)
- [Agent API](docs/agent-api.md)
- [跨包 App Server 与 Session authority](../../docs/active/app-server-local-runtime.md)

## 测试

`bun run --cwd apps/kite-service test`、`bun run --cwd apps/kite-service typecheck`、`bun test tests/release`、
`bun run release:build`、`bun run release:verify` 与 `bun run release:smoke`。

## 文档影响

App Server、Session/Store authority、daemon/Web、Trust、安全、恢复或release行为变化时，必须同步更新本README、对应本地文档与
`docs/active/` current authority；架构决策另增ADR。
