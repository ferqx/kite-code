# Managed local Runtime mode

本页是 `apps/kite-cli/src/service-mode/` 的owner-local current authority。该目录承载terminal使用的typed client adapter。默认installed
与source TUI/CLI都连接parent-owned stdio App Server：installed固定launcher-pinned immutable candidate，source固定当前checkout；多个连接共享
durable profile但不共享进程。CLI不导入Service App，也不持有Store authority。

adapter把 `KiteAppServerConnection`投影为typed Runtime、History、App Control、credential与
`RuntimeSnapshotStore`，并用显式 `NativeTuiRuntimeClient` 实现现有TUI journey。App Server mutation直接受Session execution
generation/revision fence约束。adapter不读取descriptor/access/control
token，不自行discover/spawn owner，不创建Host/Store/SQLite/Builtin，也不使用legacy session-manager Proxy。

默认parent-child必须exact build；显式daemon只按exact protocol/capability判断兼容。任何mismatch都fail closed，不执行previous-build
stop、replacement或fallback。默认配套模式的mismatch在TUI启动前提示安装可能不完整并要求更新或重新安装；显式daemon的mismatch
提示更新Kite Code或改用matching client，升级后仍不兼容时由用户关闭旧daemon再显式启动。提示不比较client semver，也不自动stop、
replace或upgrade daemon。

默认`/status`展示stdio transport、profile mode、build、App Server version与same-build pairing。显式`--server`只连接指定的
Unix socket/Windows named pipe，展示exact-protocol compatible pairing；daemon的build ID只用于诊断，不参与兼容判断。client/server mismatch在initialize时关闭连接，
不会进入TUI形成build drift状态。legacy Service PID与daemon Web根地址都不出现在TUI `/status`，Web URL不是Runtime identity。

`kite server start/status/stop`是唯一daemon lifecycle入口；默认TUI/CLI不发现或启动daemon。daemon固定服务start时选择的canonical
Workspace，另一Workspace连接拒绝；普通connection close不停止daemon，显式stop才取消active Turn并等待Runtime与Web carrier drain。
`kite web [--server <endpoint>] [--json]`只读取现存daemon v2 status中的strict loopback `webOrigin`；absent提示先显式start，protocol mismatch
提示使用matching client，均不spawn/replace。TUI没有Web discovery callback或`/web`。正式CLI不组合legacy Coordinator、Store migration或`web recover`；该
parser/adapter contract与tests不代表hosted Web qualification。

连接采用两阶段Trust语义。App Server的`prepareAppControl()`打开唯一exact protocol connection，以便执行Trust/App方法，但不发Runtime
mutation；TUI/CLI查询或显式更新Workspace Trust后才调用Runtime command。任何阶段失败都原样reject，不silent fallback到
embedded/InProcess或legacy Service。

reconnect为同一resolver显式spawn新的parent-owned child并切换Runtime Client generation，原子清除旧Session readiness、index与ephemeral
stream，再由replacement subscription/index reset重建；mutation不会自动重放。close关闭本client connection/subscription/snapshot
observer和child，不发送Session删除或隐式cancel-all。TUI Ctrl+C仍通过Runtime cancel command处理当前Turn。
TUI dispose在connection仍可查询时读取exact Session projection：只有durable idle且interaction queue为空才release本client持有的
Controller；queued/running/waiting、pending interaction或query失败一律detach。它不做force takeover，也不替其他client释放lease。

Native subscription按canonical Server顺序串行消费notification。前台`reasoning.activity(state=completed)` dispatch后先等待
注入的Ink presentation flush，再读取下一条text、interaction或terminal；background session只缓冲event。该等待以1秒为上限：正常路径仍
等待真实commit，不用固定sleep猜顺序；Ink promise迟到或失败时继续消费canonical event，不能让presentation阻断Runtime subscription。
这个client屏障与Service 50ms framing共同保持旧InProcess可见顺序，不在adapter内按数据源添加渲染分支。
Server的initial snapshot、reconnect reset与revision gap snapshot在wire上都是event-free durable projection。adapter必须
把权威`activeTask/currentRun`及完整`interactionQueue`显式交给presentation reducer：waiting snapshot恢复当前Footer，terminal snapshot
结束本地run promise与“执行中”。它不得把snapshot解释成approval settlement、用户取消或成功terminal，也不得让低于
已接受command receipt revision的迟到snapshot结束新run。这样event、history replay与snapshot recovery仍只有一个TUI
presentation state machine，Runtime Client cache不是第二套UI lifecycle authority。

普通消息提交使用per-TUI FIFO，不在当前Turn仍active时调用`tryReservePrompt()`后静默丢弃。每条消息先等待本Session
Host idle，再取得唯一prompt reservation并发送`start_turn`；连续输入按提交顺序逐条执行。重连/恢复时即使本地没有
`runPromise`，只要authoritative projection仍是queued/running/waiting，client就轮询exact Session projection直到远端
cleanup barrier idle后才放行下一条消息。等待或command失败必须返回TUI可见的“未发送”错误，不能只清空输入框。
活动Turn的重复Esc/Ctrl+C共享每Session唯一的in-flight取消Promise；第一次按键即可进入`Cancelling`展示，只有权威终态或
取消receipt失败才清除该pending状态。前驱含Subagent时，Service返回`runtime_busy`直至Provider lifecycle cleanup全部确认；
client保留queued prompt并退避重试，不能在前驱用户可见终态与实际cleanup之间启动后继。
若terminal projection与下一条`start_turn`交叉而返回明确未执行的`revision_conflict`，client使用原command ID并更新
Service返回的`currentRevision`。active Subagent可能在每次CAS往返期间继续推进revision，因此client不得按固定尝试次数失败；它在既有Run deadline内等待
authoritative remote-idle/cleanup边界，再以最新projection revision重试。deadline耗尽仍必须失败可见，且全过程不能创建第二Turn。
terminal event若先于event-free idle projection到达，adapter会为当前`resolveRun`建立remote-idle waiter；waiter identity与该轮
completion callback绑定，旧轮waiter的迟到finally不能占用或清除后继轮waiter。applied receipt后另登记current accepted completion；
每轮同时启动2秒后、至多每2秒一次的bounded query fallback，只有projection满足current revision floor且权威idle时才收敛accepted run，
因此terminal/idle notification gap不会永久挂起；正常subscription先完成时fallback按callback identity退出。
第二轮完成后触发同样有界的Ink presentation flush；flush超时后`SET_IDLE`仍触发后续render，不能出现模型请求已发出但subscription永远停在
未提交React frame之前的状态。
run completion只接受跨过当前command revision floor、并在receipt提供resource时exact匹配canonical `runId`的
`run.terminal`。failed Run由该事件的terminal outcome表达；`turn.terminal`与`task.terminal`仍进入presentation reducer，但不能解决run promise；这样前轮迟到的Turn终态
不会在后继`start_turn`之后把新Run误判完成。

Native interaction提交必须等待`respond_interaction`的applied/idempotent receipt，不能fire-and-forget或吞掉
transport/protocol/identity错误。确认失败时approval仍保留并允许用户显式重试；TUI不能在receipt前显示已授权。
React owner切换时action sink按实例释放，旧effect cleanup不能清除新Runtime client binding。
pending interaction期间若无关durable event推进Host revision，后续snapshot会以相同稳定interaction identity和新的
`sessionRevision` settlement CAS替换本地queue；client对每个权威durable projection同步内部interaction Map，即使notification同时携带event。
client提交该current projection，Service在receipt transaction内再次核对当前State。command admission与最新projection竞态产生
revision conflict时，client在有界deadline内查询权威projection、核对稳定interaction identity，并以相同command ID及相等的
`interaction.sessionRevision/expectedRevision`重建请求；不把旧interaction与新CAS拼接。durable settlement在async提交期间
清除Footer时属于该用户动作，React cleanup不得补发cancel。

checkpoint list/preview是同一Runtime query surface上的只读操作，不等待目标Session的long-lived subscription ready；目标bridge可由
query权威投影独立hydrate。rewind mutation、Controller命令与普通turn仍必须等待Session readiness。TUI调用时以Reducer当前
`activeSessionId`为准，mutable ref只作尚未建立Reducer identity时的fallback。

验证：`bun test apps/kite-cli/test/service-mode apps/kite-cli/test/cli.test.ts apps/kite-cli/test/isolated/tui-runtime-client-conformance.test.ts`。
