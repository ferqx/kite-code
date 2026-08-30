# Managed Local Service mode

本页是 `apps/kite-cli/src/service-mode/` 的 owner-local current authority。该目录承载 terminal 使用的 Native client adapter；
当前 release/source 默认 connector 由 Coordinator resolve/mint 后直接连接 Workspace Worker。显式 `kite service *` 仍注入 legacy
Service lifecycle manager，但不是默认 run/resume/TUI data plane；CLI不导入Service App。

adapter把 `LocalKiteConnection` 投影为 typed Runtime、History、App Control、Native credential、owner status与
`RuntimeSnapshotStore`，并用显式 `NativeTuiRuntimeClient` 实现现有TUI journey。它不读取descriptor/access/control
token，不自行discover/spawn owner，不创建Host/Store/SQLite/Builtin，也不使用SessionManager Proxy。

Web Gateway lifecycle 不属于该 Service adapter。CLI 的 `kite web [--json]`、`kite web status [--json]` 与 `kite web stop`
只通过单独注入的 `CoordinatorRequestClient` 分别执行 ensure、已有 Gateway discovery 与 stop；CLI 不自行启动 Gateway、
读取其内部状态或取得 Controller。`scripts/release/entrypoints/cli.ts` 已按命令注入 managed Coordinator client；layout、
Coordinator 或 Gateway 不可用时明确返回 unavailable。该 parser/adapter contract 与 tests 不代表 hosted Web qualification；
candidate `releaseSlots` 已绑定 Coordinator、Worker、Gateway、Web entrypoint/identity。

Store generation maintenance也不属于Service-mode adapter。`kite maintenance migrate-run-store --target-generation <fresh-generation>`
只接受release entrypoint注入的offline owner：owner关闭Coordinator admission、验证并停止Gateway/idle Worker、深检State与SQLite authority后
才执行whole-generation copy-and-switch。CLI不构造maintenance barrier；busy/unknown/corrupt返回closed blocked JSON与非零退出。
普通`run/resume`、TUI、`web`和`service ensure`均不会隐式调用该命令。

连接采用两阶段 Trust。`prepareAppControl()` 只完成 manager ensure、state discovery与authenticated App Control准备；
TUI/CLI查询或显式更新 Workspace Trust后才调用 `connect()`，取得 Workspace-bound ticket并初始化Runtime。任何阶段失败
都原样reject，不silent fallback到embedded/InProcess。

reconnect重新ensure/discover并切换Runtime Client generation，原子清除旧Session readiness、index与ephemeral stream，
再由replacement subscription/index reset重建；mutation不会自动重放。close只关闭本client connection/subscription/
snapshot observer，不发送owner shutdown，也不dispose Service Host。TUI Ctrl+C仍通过Runtime cancel command处理当前Turn。
TUI dispose在connection仍可查询时读取exact Session projection：只有durable idle且interaction queue为空才release本client持有的
Controller；queued/running/waiting、pending interaction或query失败一律detach。它不做force takeover，也不替其他client释放lease。

Native subscription按canonical Server顺序串行消费notification。前台`reasoning.activity(state=completed)` dispatch后先等待
注入的Ink presentation flush，再读取下一条text、interaction或terminal；background session只缓冲event。该等待以1秒为上限：正常路径仍
等待真实commit，不用固定sleep猜顺序；Ink promise迟到或失败时继续消费canonical event，不能让presentation阻断Runtime subscription。
这个client屏障与Service 50ms framing共同保持旧InProcess可见顺序，不在adapter内按数据源添加渲染分支。
Server的initial snapshot、reconnect reset与revision gap snapshot在wire上都是event-free durable projection。adapter必须
把权威`activeWork`及完整`interactionQueue`显式交给presentation reducer：waiting snapshot恢复当前Footer，idle snapshot
结束本地run promise与“执行中”。它不得把snapshot解释成approval settlement、用户取消或成功terminal，也不得让低于
已接受command receipt revision的迟到snapshot结束新run。这样event、history replay与snapshot recovery仍只有一个TUI
presentation state machine，Runtime Client cache不是第二套UI lifecycle authority。

普通消息提交使用per-TUI FIFO，不在当前Turn仍active时调用`tryReservePrompt()`后静默丢弃。每条消息先等待本Session
Host idle，再取得唯一prompt reservation并发送`start_turn`；连续输入按提交顺序逐条执行。重连/恢复时即使本地没有
`runPromise`，只要authoritative projection仍是queued/running/waiting，client就轮询exact Session projection直到远端
cleanup barrier idle后才放行下一条消息。等待或command失败必须返回TUI可见的“未发送”错误，不能只清空输入框。
若terminal projection与下一条`start_turn`交叉而返回明确未执行的`revision_conflict`，client只可使用原command ID与
Service返回的`currentRevision`有界重试；重复冲突必须失败可见，不能无限重放或创建第二Turn。
terminal event若先于event-free idle projection到达，adapter会为当前`resolveRun`建立remote-idle waiter；waiter identity与该轮
completion callback绑定，旧轮waiter的迟到finally不能占用或清除后继轮waiter。applied receipt后另登记current accepted completion；
每轮同时启动2秒后、至多每2秒一次的bounded query fallback，只有projection满足current revision floor且权威idle时才收敛accepted run，
因此terminal/idle notification gap不会永久挂起；正常subscription先完成时fallback按callback identity退出。
第二轮完成后触发同样有界的Ink presentation flush；flush超时后`SET_IDLE`仍触发后续render，不能出现模型请求已发出但subscription永远停在
未提交React frame之前的状态。
run completion只接受跨过当前command revision floor、并在receipt提供resource时exact匹配canonical `runId`的
`run.terminal|run.failure`。`turn.terminal`与`task.terminal`仍进入presentation reducer，但不能解决run promise；这样前轮迟到的Turn终态
不会在后继`start_turn`之后把新Run误判完成。

Native interaction提交必须等待`respond_interaction`的applied/idempotent receipt，不能fire-and-forget或吞掉
transport/protocol/identity错误。确认失败时approval仍保留并允许用户显式重试；TUI不能在receipt前显示已授权。
React owner切换时action sink按实例释放，旧effect cleanup不能清除新Runtime client binding。
pending interaction期间若无关durable event推进Host revision，后续snapshot会以相同稳定interaction identity和新的
`sessionRevision` settlement CAS替换本地queue；client提交该current projection，Service在receipt transaction内再次
核对当前State。只有command admission与最新snapshot竞态产生的revision conflict才用新的command ID和
`currentRevision`有界重试；不等待Service重发未改变的interaction。durable settlement在async提交期间
清除Footer时属于该用户动作，React cleanup不得补发cancel。

checkpoint list/preview是同一Runtime query surface上的只读操作，不等待目标Session的long-lived subscription ready；目标bridge可由
query权威投影独立hydrate。rewind mutation、Controller命令与普通turn仍必须等待Session readiness。TUI调用时以Reducer当前
`activeSessionId`为准，mutable ref只作尚未建立Reducer identity时的fallback。

验证：`bun test apps/kite-cli/test/service-mode apps/kite-cli/test/cli.test.ts apps/kite-cli/test/isolated/tui-runtime-client-conformance.test.ts`。
