# Managed Local Service mode

本页是 `apps/kite-cli/src/service-mode/` 的 owner-local current authority。KLSV1-06 后该目录承载默认 Native client
adapter，不再是 opt-in migration path。release/source composition负责注入 connector与lifecycle；CLI不导入Service App。

adapter把 `LocalKiteConnection` 投影为 typed Runtime、History、App Control、Native credential、service status与
`RuntimeSnapshotStore`，并用显式 `NativeTuiRuntimeClient` 实现现有TUI journey。它不读取descriptor/access/control
token，不discover/spawn Service，不创建Host/Store/SQLite/Builtin，也不使用SessionManager Proxy。

连接采用两阶段 Trust。`prepareAppControl()` 只完成 manager ensure、state discovery与authenticated App Control准备；
TUI/CLI查询或显式更新 Workspace Trust后才调用 `connect()`，取得 Workspace-bound ticket并初始化Runtime。任何阶段失败
都原样reject，不silent fallback到embedded/InProcess。

reconnect重新ensure/discover并切换Runtime Client generation，原子清除旧Session readiness、index与ephemeral stream，
再由replacement subscription/index reset重建；mutation不会自动重放。close只关闭本client connection/subscription/
snapshot observer，不发送owner shutdown，也不dispose Service Host。TUI Ctrl+C仍通过Runtime cancel command处理当前Turn。

Native subscription按canonical Server顺序串行消费notification。前台`reasoning.activity(state=completed)` dispatch后必须
等待注入的Ink presentation flush，再读取下一条text、interaction或terminal；background session只缓冲event。这个
client屏障与Service 50ms framing共同保持旧InProcess可见顺序，不在adapter内按数据源添加渲染分支。
Server的initial snapshot、reconnect reset与revision gap snapshot在wire上都是event-free durable projection。adapter必须
把权威`activeWork`及完整`interactionQueue`显式交给presentation reducer：waiting snapshot恢复当前Footer，idle snapshot
结束本地run promise与“执行中”。它不得把snapshot解释成approval settlement、用户取消或成功terminal，也不得让低于
已接受command receipt revision的迟到snapshot结束新run。这样event、history replay与snapshot recovery仍只有一个TUI
presentation state machine，Runtime Client cache不是第二套UI lifecycle authority。

普通消息提交使用per-TUI FIFO，不在当前Turn仍active时调用`tryReservePrompt()`后静默丢弃。每条消息先等待本Session
Host idle，再取得唯一prompt reservation并发送`start_turn`；连续输入按提交顺序逐条执行。重连/恢复时即使本地没有
`runPromise`，只要authoritative projection仍是queued/running/waiting，client就轮询exact Session projection直到远端
cleanup barrier idle后才放行下一条消息。等待或command失败必须返回TUI可见的“未发送”错误，不能只清空输入框。

Native interaction提交必须等待`respond_interaction`的applied/idempotent receipt，不能fire-and-forget或吞掉
transport/protocol/identity错误。确认失败时approval仍保留并允许用户显式重试；TUI不能在receipt前显示已授权。
React owner切换时action sink按实例释放，旧effect cleanup不能清除新Runtime client binding。
pending interaction期间若无关durable event推进Host revision，后续snapshot会以相同稳定interaction identity和新的
`sessionRevision` settlement CAS替换本地queue；client提交该current projection，Service在receipt transaction内再次
核对当前State。只有command admission与最新snapshot竞态产生的revision conflict才用新的command ID和
`currentRevision`有界重试；不等待Service重发未改变的interaction。durable settlement在async提交期间
清除Footer时属于该用户动作，React cleanup不得补发cancel。

验证：`bun test apps/kite-cli/test/service-mode apps/kite-cli/test/cli.test.ts apps/kite-cli/test/isolated/tui-runtime-client-conformance.test.ts`。
