# Managed local Runtime mode

本页是 `apps/kite-cli/src/service-mode/` 的owner-local current authority。该目录承载terminal使用的typed client adapter。默认installed
与source TUI/CLI都连接parent-owned stdio App Server：installed固定launcher-pinned immutable candidate，source固定当前checkout；多个连接共享
durable profile但不共享进程。CLI不导入Service App，也不持有Store authority。

adapter把 `KiteAppServerConnection`或legacy `LocalKiteConnection`投影为typed Runtime、History、App Control、credential与
`RuntimeSnapshotStore`，并用显式 `NativeTuiRuntimeClient` 实现现有TUI journey。Controller只存在于legacy native connection；
App Server mutation直接受Session execution generation/revision fence约束。adapter不读取descriptor/access/control
token，不自行discover/spawn owner，不创建Host/Store/SQLite/Builtin，也不使用SessionManager Proxy。

普通跨build lifecycle mutation保持owner-build fence。source已删除previous-build replacement authority；standalone TUI退出只停止自己的
exact-build owner，显式shared source发生drift时不替换owner。source↔installed或identity不确定时仍fail closed。
CLI `service *`的每个manager request都携带release composition选择的`source|installed` mode；App层不自行推断该字段。

默认`/status`展示stdio transport、profile mode、build、App Server version与same-build pairing。显式`--server`只连接指定的
Unix socket/Windows named pipe，展示exact-protocol compatible pairing；daemon的build ID只用于诊断，不参与兼容判断。client/server mismatch在initialize时关闭连接，
不会进入TUI形成build drift状态。Service PID/Web根地址只属于仍显式可调用的legacy控制面，不出现在默认TUI状态。

`kite server start/status/stop`是唯一daemon lifecycle入口；默认TUI/CLI不发现或启动daemon。daemon固定服务start时选择的canonical
Workspace，另一Workspace连接拒绝；普通connection close不停止daemon，显式stop才取消active Turn并等待carrier drain。Web route目前仍是legacy
Service readiness的一部分。release注入的`discoverWeb`先ensure唯一Service，再从Native `describe`得到`httpOrigin`，为CLI
`kite web [--json]`和TUI `/status`返回稳定根地址；TUI同时展示Service identity，不保留单独的`/web`。它不接收asset root，也没有独立status/stop。正式CLI不组合legacy Coordinator、Store migration或`web recover`；该
parser/adapter contract与tests不代表hosted Web qualification。

连接采用两阶段Trust语义。App Server的`prepareAppControl()`打开唯一exact protocol connection，以便执行Trust/App方法，但不发Runtime
mutation；TUI/CLI查询或显式更新Workspace Trust后才调用Runtime command。任何阶段失败都原样reject，不silent fallback到
embedded/InProcess或legacy Service。

reconnect为同一resolver显式spawn新的parent-owned child并切换Runtime Client generation，原子清除旧Session readiness、index与ephemeral
stream，再由replacement subscription/index reset重建；mutation不会自动重放。close关闭本client connection/subscription/snapshot
observer和child，不发送Session删除或隐式cancel-all。TUI Ctrl+C仍通过Runtime cancel command处理当前Turn。
以下Controller与跨build规则仅描述KASD-06前仍显式可达的legacy native Service seam，不是默认TUI/CLI行为。升级前仍运行的inactive installed
TUI在Protocol/client-contract兼容时可通过该路径连接current installed Service；其manager不执行
replacement，Native exact-build control fence也不允许它停止或降级current owner。不兼容client诊断保持fail closed且`spawn=0/stop=0`。
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
