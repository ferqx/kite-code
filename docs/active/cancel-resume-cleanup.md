# Cancel、Resume 与工具调用清理

状态：active

读取时机：修改 abort/cancel、Runtime 恢复、Effect lease、消息工具对清理、工具参数异常、Subagent continuation 或 TUI 取消行为时。

验证：`bun test packages/agent-kernel/test packages/runtime-host/test packages/runtime-storage-sqlite/test packages/builtin-runtime/test tests/runtime tests/tui-system`、`bun run typecheck`。

App `RuntimeSessionCoordinator`、Kernel State26 与同一 Host Store5 adapter 共享唯一 persistence/abort seam；
Session、effect coordinator 与 turn coordinator 不按路径自行创建第二 Store。取消顺序、cleanup barrier、effect lease、
unknown/late receipt 与同 session 单飞语义由 Host/Kernel/App 共同保持；RMV1-16 final Gate 已完成。

RMV1-06 已把 production execution lifecycle 原子切到 Runtime Host。Host 为每个长期 turn/compaction 创建唯一
root `AbortController`，同一 Session 同时最多一个活动 operation；只有当前 operation 已收到 abort 后才允许保留
一条 successor，且 successor 必须等待旧 operation 的完整 cleanup promise 后才能进入执行桥。第三条并发请求
返回 `runtime_busy`，close/dispose 立即关闭 admission，并在关闭 bridge 与 Store 前等待所有已接收请求和 lifecycle
barrier。CLI/TUI compatibility path 只消费 Host signal，并把内部 deadline/拒绝产生的 abort 请求回送 Host；它们不再
拥有 production root controller。

`cancel_turn` 与 Host shutdown 仍先通过唯一 live Kernel control plane 提交 durable cancellation facts，再由 Host
触发 root signal。Host `EffectSupervisor` 是四类 Store5 transaction acknowledgement 与单-Store effect lease 的
production owner：intent/attempt ack 失败时外部调用为零，lease 必须在 dispatch 前取得并在运行中续租，terminal
commit 在释放 lease 前完成且由同一 SQLite transaction 原子核对 owner/expiry。续租失败或 stale owner 会中止同
Session lifecycle，拒绝后续 dispatch/commit；dispatch 后没有 receipt 的事实仍按既有 unknown/reconciliation 规则
收敛。terminal persist 必须携带执行者取得的 caller-bound owner token；Host 不允许旧执行者从相同 effectId 的
replacement claim 反查并借用新 owner。Host 在 hydrate 后、首次 resume/start/compact 前对每个 Session 恰好运行一次 restart recovery，失败时在
execution bridge 前 fail closed。RAV1-04 保持机械 single-Host invariant；State26、Store5 与 epoch
`kite-runtime-modularization-v1-2026-08-19` 是唯一 production format。

## Runtime 取消语义

取消通过 AbortSignal 传播到模型、工具和 Subagent。用户停止当前轮次时，App shell 必须先通过 live Kernel control plane 原子持久化全部未终结工具的 `tool.cancelled` 与带 `cause=user` 的 `turn.aborted`，再触发 AbortSignal；这样活动 Effect lease 会因 revision 前移而失效，队列、active 列表和 transcript 工具调用/结果对共同收敛，不能留下永久 busy 状态。公共 `RunRuntimeAgentInput.signal` 也属于相同的取消边界：无论调用方是否持有 Kernel control，它一旦 abort 必须先写出同一组 durable cancellation facts，再解除 model、tool 或 interaction 等待；不得让 generator 静默结束而把 active turn 留在 Store。该操作只终止当前 turn，不把活动 task 改为 cancelled，下一条用户消息仍可沿当前任务上下文继续。重复取消不得追加重复 Tool Result。TUI 清理运行中 block 只是上述 Runtime 事实的展示投影，不是 Runtime 取消事实本身。

工具审批中的显式“拒绝”与 Esc/取消使用同一整轮语义。Kernel 必须在一个 action batch 中先为当前审批目标写入带 `approval_rejected` failure 的 `approval.rejected`，再为其余未终结 sibling 写入 `tool.cancelled`，最后写入 `turn.aborted(cause=user)`；Runner 随即退出，不再请求后续审批、执行 queued 工具或调用模型。Agent 在观察到该用户审批拒绝时立即 abort 本轮内部执行信号，使已经启动的 Shell、Subagent 或其他可取消执行真正停止；迟到事件由 Effect lease 拒绝。该规则不适用于 `policy_denied`、sandbox 缺失或系统自动审查等非用户拒绝，它们继续按各自失败路径处理。

方案执行确认（`request_plan_review`）也是执行授权屏障。用户选择取消或按 Esc 时，Kernel 在同一 action batch 中写入 `plan.review_cancelled`，将触发确认的方案工具及其余未终结 sibling 全部写为 `tool.cancelled`，最后写入 `turn.aborted(cause=user)`；方案文档保留为可继续修改的 draft，但当前 turn 立即结束，Runner 不得再次调用模型或进入执行阶段。

`ask_user` 是用户输入交互，不是执行授权审批。用户拒答或按 Esc 时，Kernel 先写入携带 `interactionId` 与 `toolCallId` 的 `user_input.cancelled`，再为该 `ask_user` 写入 `tool.finished(ok=false, stdout=Cancelled)`，清除 `awaiting_user_input`；不得写入 `approval.rejected`、`tool.cancelled` 或 `turn.aborted`，也不得 abort 本轮执行信号。Runner 随后继续调度；模型在同一 turn 中看到拒答 Tool Result 后继续回答或调整方案。

TUI 只可通过消息本身的 live-only pending echo 标记识别“乐观渲染 prompt + 随后 durable `user.message_appended`”这一对副本；不得依赖全局 `running` 状态，因为取消可能先把 run 投影为 idle、再收到该 durable echo。收到 echo 后必须清除标记且不新增 turn。event-log replay 不得按文本去重；两个 `messageId` 不同但内容相同的连续用户消息仍是两个独立 turn，后续模型回答必须归入各自 turn。

SessionRuntime 在 sandbox `prepare()` 尚未完成时收到取消，必须同时中止该 executor 的 preparation，使 native preflight 进入 cancel/EOF cleanup；cleanup barrier 随后才允许保留的一条 successor prompt 继续。已经完成 preparation 并进入 agent loop 后的普通取消不得无条件使共享 startup decision 失效。

PS-02 后 startup `prepare()` 只做 allocation-free backend candidate discovery，不启动 probe 或用户
进程。真正 allocating preparation 属于 Tool attempt：intent ack 后任一 provider resolve、grant、
Artifact 或 ready 失败都必须先持久化 abandonment/disposal intent，再尝试清理。已有
dispatch 时取消由 Runtime-owned supervisor/Windows Job 收敛；完整 descendant exit、bounded output
drain 或 cleanup receipt 任一未确认时，Tool 与 run 保留 unknown/pending recovery authority，不得
释放 successor 的外部执行门禁或回退 host Shell。TUI startup 决策为 `sandbox | host_shell | denied`；
其中 `host_shell` 仅用于用户命令启动前的 unavailable，或 exact pre-dispatch unavailable 且 cleanup 已确认，
不得用 UI 卸载、重建 executor 或新 session 清除 durable cleanup authority。

TUI 对用户取消的终态投影遵循：已实际开始的工具保留原名称、关键参数和已有输出并显示 `cancelled`；从未开始的 queued 探索工具不计入 `read N files` 等统计；不追加独立的整轮取消提示。实时 Ctrl+C/Esc、durable `tool.cancelled` 与 `turn.aborted(cause=user)` 必须共用同一套纯函数取消投影；该投影必须幂等，且晚到取消不得覆盖 `done/error/timeout/exhausted` 等既有终态。运行中的独立工具卡可能显式携带 `expanded=false`；`expanded` 只控制 Shell/Web Fetch 输出正文，`⎿ cancelled` 等 terminal footer 必须独立于折叠状态始终可见，本地取消不得再通过强制展开正文来换取 footer 可见性。实时取消和 event-log replay 必须得到相同视觉状态与渲染结果。取消后的旧 TUI run 仍可能在后台完成清理；键盘取消必须在 ESC/Ctrl+C 同一输入轮同步触达 SessionRuntime，不能等待 reducer 的 `running=false` effect，否则下一条 prompt 可能在旧 run 仍被视为活动时被静默拒绝。旧 run 的 finally 不得把新 run 的 `running` 状态重置为 idle，下一条 prompt 必须立即显示在消息列表中，并在清理完成后继续执行；RuntimeStore 的单飞等待不得隐藏用户已经提交的消息。正常完成已发出终态 `SET_EXITED` 后，不得再由停止 effect 反向 abort 已完成的 run。取消已请求但清理尚未完成时，输入层必须接受至多一条 successor prompt 并排队等待同一 cleanup barrier；普通仍在运行的 turn 不能借此接受并丢弃并发 prompt，successor run 获得 runtime lease 后必须继续进入模型调度并产生可见响应。 实时 reducer 在插入用户 prompt 时必须同步建立新的 turn 边界，不能把 successor 追加到已取消 turn；输入层先进入 running 再插入 prompt，避免短暂 idle 渲染把旧 turn 与 successor 一起提交到 Ink 的不可变 Static 区。取消后的 successor 若快速连续收到 reasoning completed 与回答增量，仍必须遵守 Thought presentation boundary：在消费回答前等待 Ink 已把运行态 Thought 单独提交并写入终端，不能让取消恢复路径重新把 Thought 与最终文本合并到同一帧。最新 turn 在 running 时可以把连续不可变前缀渐进提交到 Static，但收到终态进入 idle 后必须冻结该分割点：已提交前缀保持不变，新结算的 dynamic tail 继续作为 live tail，直到下一条用户消息建立更新的 turn（或会话 remount）。取消纯思考阶段时尤其不得把刚结算的 Thought 与已经显示的用户提示词在同一终止帧再次提升到 append-only Static；否则 Windows 主屏 scrollback 会留下重复提示词。 运行时事件循环在每次路由前检查本轮 AbortSignal；取消后由 provider 或 generator 排出的迟到 model/tool 事件不得投影到 successor。generator 自己产生 `turn.aborted(cause=user)` 时必须视为已取消；即使 generator 在 AbortSignal 触发后没有再 yield 取消事件、而是直接正常关闭，该 run 的 signal 仍是权威取消事实，必须跳过 `SET_EXITED`，避免旧 run 的终态投影覆盖新 run 的 running 状态。终态响应如果只比已流式文本多出标点或短后缀，必须并回已有文本 block，不得新增一个可见的重复行。只要当前 `model.requested` 的 request ID 仍有效，`model.text_delta` 就必须继续按流式累计事件处理，即使旧 run 的终态竞态曾把全局 `running` 短暂置为 false；不得把 cumulative delta 降级为普通文本事件逐条追加，否则终态协调虽能收敛 reducer 状态，Ink 主屏仍会留下已发布的重复帧。

`boundedCancellationV1` 启用后，持久化 ResourceBudget deadline 触发同一 execution
AbortSignal；普通模型、compaction、tool/MCP、Subagent 和 Verification 都继承该信号。deadline
首先在一个 transaction 中取消未完成工具、将未 dispatch reservation release、将
`dispatch_started` reservation 标记 `unknown`、取消所有 durable waiter，并写入
`turn.aborted(cause=error)`，然后才 abort 执行。Abort 必须唤醒 FIFO permit wait，且之后不能
产生新的 model/tool dispatch；同一信号也必须唤醒没有后台 effect 的 ask_user、Plan/工具审批、
Verification 和 Provider action/admission 等交互等待。执行链退出后还必须追加唯一的结构化
`run.error`：清理已确认时
failure=`budget_exceeded`、terminal reason=`budget_exhausted`；存在 unknown reservation 时仍
保留 `knownExternalEffects=unknown` 和 reconciliation 入口。清理未确认时改为
failure/reason=`cancel_incomplete`。

若 deadline 命中交互等待时仍有并发 Shell 在后台运行，等待分支不得无限忽略 AbortSignal。
它必须转发已经到达的工具 terminal 与 `runtime.cancellation_diagnostic`，并在执行器不再合作时解除
Runtime wait，避免旧 run 永久阻塞同一 thread 的 successor；已 dispatch reservation 仍保持 `unknown`，后续
reconciliation 才能确认外部结果。

Abort 后，Runner 停止所有新 effect 调度，但给每个已启动 effect 最多 3 秒的 cleanup grace 来交付已有
terminal/diagnostic 事实；超过上限仍未收束的 executor 不得继续占住 Runtime。该界限同时适用于前台
effect 与并发 Shell 背景 drain：已合作的执行器可完整写出 `cancel_incomplete`，不合作的适配器则在 grace
结束后被隔离，允许同一 thread 的 successor 继续。

Shell 取消由 process-tree guard 独占：POSIX 对独立 process group 先发 SIGTERM，并立即轮询退出状态，最多等待 500ms；仍未退出时再以 SIGKILL 强制终止并进行 2 秒有界确认。Windows 先尝试 root graceful，并立即轮询退出状态，再通过 Job Object 或 `taskkill /T /F` 清理整棵树。正常退出不得因为固定 sleep 人为延迟；结果必须携带 confirmed/forced/unconfirmed count。无法确认
descendant 退出时发出结构化 `runtime.cancellation_diagnostic(cancel_incomplete)`，终态为
`unknown` 且进入 reconciliation，不能降级为普通 cancelled。

并发 Shell 的晚到 terminal 不得把 `cancelled` 工具改成 failed/succeeded，也不得启动 sibling
或模型。若 cleanup 已确认，late path 只可提交受 upper bound 约束的 resource reconciliation；
若收到 `cancel_incomplete`，reservation 保持 unknown。恢复阻断必须持久化结构化
`run.error` 与 error-caused abort，同时保留 recovery hard block，后续 `turn.started` 不能绕过。
正常完成则必须在向消费者 yield 之前，将 `run.completed` 与 `turn.completed` 原子持久化；
慢消费者不能让 deadline 在两条完成事实之间把已完成 turn 改写为 aborted。

Kernel 的 batch 后置动作必须与单事件路径等价。包含 `turn.completed` 的 batch 在事务提交后
必须保存命名 rewind 恢复点；否则正常完成虽然持久化，却无法出现在 `/rewind`。工具失败后
产生的 `provider.action_required` 必须与原 `tool.failed` 一起延后到 tool lifecycle terminal
后按序提交，不能在工具仍为 running 时提前打开 recovery interaction。

## 会话导航的客户端映射

“切换会话”是否表示取消属于 App 适配层交互语义，不是 Kernel 规则（ADR-0050）。当前 TUI 把新建或切换到另一会话仅视为前台路由变化：离开会话继续在后台运行，审批与 Plan review 保留为 durable pending interaction，只有用户显式提交取消动作时才写入 `turn.aborted`。

未来图形客户端可以同时保留多个运行中会话。它切换可见会话时必须保留离开会话的 Runtime、活动 Effect 和 pending interrupt，只有用户显式提交取消动作时才写入 `turn.aborted`。App 不得根据 foreground、路由切换或“当前可见会话”自行推断取消。

工具授权被用户拒绝时，TUI 必须将该工具卡投影为 `cancelled` 而非 `error`；即使旧事件只携带用户拒绝文本而没有 `cancelled` status，也必须同样归一。对 Shell/Web Fetch 卡，只显示一行拒绝说明，不再附加 `exit: error` 等 terminal footer。

## Resume 语义

恢复从 Runtime snapshot + event log 重建 State，并重新检查不变量。App 读取会话时必须把 rolling snapshot 之后的持久化事件尾部归并后再投影交互；已经出现 `approval.granted` 或 `approval.rejected` 的审批不得从旧快照或事件重放中复活。回放层留下的 `approval.requested` 展示投影也不能单独判定为 pending：若持久化 RuntimeState 已无 interaction（例如后续已有 `tool.started`），不得 fork 一份重复的 recovery 会话。`tool.started` 必须同步清理同一 call 的旧审批投影，否则它会阻塞后续 `approval.requested`，使真实的 `approval.rejected` 工具卡在回放中丢失。Subagent 审批的展示交互以 parent `task` call 为 owner；child Tool Call id 只标识实际待执行工具，不能导致批准或拒绝后的 Footer interrupt 残留。以下状态不得被静默丢弃：pending approval、未完成 tool call、Capability binding revision、Skill frame、required verification 和 unknown external invocation。

重启不自动重放未知外部写入；必须 reconciliation 或用户决策。瞬时 binding、approval token 和 Effect lease 只能按各自恢复规则重新签发或收敛。
Runtime recovery journal identity 由 Host 的同一 Store5 owner 按 session 恢复并与 State26 snapshot
交叉验证。conversation/recovery fork 必须为 target session 原子写入新的 private identity，并由 Kernel
清空 source journal lineage；source session 保持不变。code-only rewind 保持原 session/identity。identity
缺失、格式错误或 metadata/snapshot 不一致时，model、tool 与 Provider 调用均为零。

`ask_user`、工具审批与 Plan review 的 approve/answer、reject/cancel、revise 三类终态必须在 live action batch、
同一事件序列 replay 和 snapshot+tail restart 后得到相同的 interaction、Tool status、turn、Plan lifecycle 与
next Effect 投影。Scheduler 与 CompletionGuard 共用当前工作作用域：带 `taskId` 的调用只属于同一
`activeTaskId`，缺 `taskId` 的 legacy 调用只属于创建它的 turn。旧 Task/turn 的队列残留既不能被重新 dispatch，
也不能阻塞当前 completion。若当前作用域内 Tool 仍声明 `awaiting_user_input/review/approval/auto_review`，但
canonical interaction 已为 idle，说明持久化终态不完整；Scheduler 必须立即返回结构化
`recovery_blocked(persistence_unavailable)`，不得继续调用模型并在 CompletionGuard 中循环成通用 `tool_pending`。

用户在旧 run 已结束后发送下一条消息时，Runtime 必须先收敛当前 Task 遗留的非终态 Tool，再创建新 turn。
这些 Tool 的内存 executor 不可能跨 run/进程继承；由 App `RuntimeSessionCoordinator` 注入全部必需 port 的
`executeRuntimeTurnV1` 因而先以同一 durable batch 写入
`tool.cancelled`，并释放 reservation、取消 waiter，必要时关闭仍为 active 的旧 turn。只有 canonical
interaction 仍存在时才走原 interaction resume；不得把孤立的 `running/queued/approved` Tool 直接带入新
turn，否则它会永久触发 CompletionGuard 的 `tool_pending → wait_for_tool`。

当前工作作用域不只约束 Tool 队列。Tool-backed interaction、挂起 Subagent 与 active Skill 都必须沿其所属 Task/父 Tool 判断；旧 Task 的当前 epoch 记录可以保留用于审计，但不得劫持新 Task 的
interaction resume、模型 Skill 注入、Scheduler 或 CompletionGuard。Provider action/admission 与未知外部 invocation
仍是 Thread/session 级安全状态，不能按 Task 静默忽略。若 Scheduler 被直接调用且发现 Tool-backed interaction
属于旧 Task，它必须 fail closed；正常 current-turn 入口则先取消该 owner Tool，使 interaction 与挂起 continuation
通过同一 terminal event 原子收敛。新 `turn.started` 或真实 `user.message_appended` 同时清除上一轮
`terminalOutcome` 投影，避免旧的 `unknown/completed` 终态泄漏到后继轮次。

Required Provider admission 只能在 successor recovery 与新用户轮次持久化之后创建，避免 session-owned admission
interaction 掩盖旧 Task 的 Tool 清理或吞掉本次用户消息。`user.message_appended + turn.started` 必须通过同一 Kernel
batch 原子提交；任一持久化失败都不能留下“消息已追加但新 turn 尚未开始”的半轮次。挂起 Subagent 仅在父 `task` Tool 存在、非终态且属于当前工作时有效；缺失或终态父 Tool 的残留不得进入 `wait_for_subagent`。

## Rewind 文件恢复（ADR-0042 §4）

`/rewind` 的 TUI 默认恢复不再截断源会话。检查点列表把命名恢复点解释为其后第一条用户消息
发送前的边界，用户确认后按范围执行：

1. “恢复代码和会话”先从恢复点 fork 新 thread，成功后再按源 thread 的文件原像恢复
   工作区，最后切换到新 thread；源会话及其后续事件保持不变。
2. “仅恢复会话”只 fork 并切换新 thread，不修改共享工作区。
3. “仅恢复代码”只按原像恢复工作区，保留当前 thread 与 transcript。
4. Fork 必须复制选中恢复点及其之前的全部命名恢复点，并把事件位置、文件原像位置重映射
   到新 thread 的事件 ID；因此恢复后的会话仍可继续向更早边界回退。
5. Fork 复制事件时必须保留原始 `created_at` 与 envelope metadata；源事件 JSON 无法严格
   解析时必须在修改目标 thread 前 fail closed，不能创建空会话。新 thread 必须回到默认
   authorization，并清除命令 grant、full interaction mode、turn-scoped binding/disclosure、
   Provider waiver/pending、待处理交互、活动工具队列与 suspended subagent；稳定的已加载
   capability 与历史 invocation 事实可以保留。
6. 自动恢复点只在 `turn.completed` 已持久化后创建，快照必须投影 completed turn；不得在
   `run.completed` 与 `turn.completed` 之间暴露 active turn 恢复点。
7. 单个文件恢复失败不阻断其余文件或新会话加载，但必须逐个显式提示失败路径；若所有
   计划项均失败，结果不得误报为“没有需要恢复的文件”。
8. 每个原像窗口同时保存最后一次成功 Kite 写入后的内容指纹。恢复前当前内容必须仍匹配
   该指纹；同一路径随后发生手动编辑、Bash 修改或删除时视为冲突，跳过该路径并显式提示。
   缺少后像指纹的旧记录同样 fail closed，不得用无法验证的原像覆盖当前文件。
9. 所有恢复范围在执行文件或会话变更前都必须确认命名恢复点行存在且快照可解析；确认提交
   在浮层与执行 handler 两层同步防重，同一次确认最多执行一个 fork 和一轮文件恢复。
10. 选择代码恢复范围时，TUI 可预览当前可安全恢复路径的精确行变更总计和主路径；预览与
    执行共用同一后像指纹检查，手动/Bash 后续修改与无后像指纹的路径必须在预览中标为跳过。
    预览只反映读取时刻，执行前仍要重新校验，不能把预览视为授权或并发安全保证。超出行级
    diff 预览上限时保留文件范围而省略行数，不能阻塞确认页。

Runtime Host 的 `restoreNamedSnapshot` 仍是可供非 TUI 调用方使用的破坏性原语；调用它时恢复文件
必须先于事件与原像截断。TUI 的默认分叉路径使用 `forkSession`，不会调用该破坏性原语。

## 消息工具对清理

发送给模型的 transcript 必须保持 tool call/result 配对。取消或恢复后发现孤立 tool call 时，context sanitizer 生成明确的 cancelled/failed tool result，使模型知道该调用没有成功；不得删除调用伪装成从未发生。

## 非法工具参数

模型产生无法解析的工具参数时不得执行底层工具。系统应：

1. 保留 tool call identity 和原始解析错误；
2. 形成结构化失败 Tool Result；
3. 提供对应契约提示；
4. 让 Agent 在正常循环中修正参数；
5. 不把 parse failure 误报为 approval rejection 或 provider failure。

## Subagent continuation

子 Agent 因审批暂停时，完整 continuation 必须发布到独立 private immutable Artifact，并绑定 parent capability
invocation/attempt/tool call、child、continuation cursor、blocked tool identity、消息、步骤与 journal。新
`subagent.suspended` 只保存 opaque keyed ref 与低信息 lineage；v25 不接受 inline snapshot。完整
read-only 恢复，不能再次写出。resume 或 auto-review 前从 live Runtime authority 推导 expected owner 并 strict
回读；missing/tamper/wrong-key/cross-invocation splice 在 reviewer、Provider、Driver、Gateway 和 blocked tool
dispatch 前 fail closed，并把唯一 live outer Task attempt 收敛 unknown，不能留下 running。用户拒绝或取消审批时，
按上述规则中止整个当前 turn，不再恢复子 Agent 生成后续结果。

Subagent Provider 的 start/resume 只消费 Pipeline 签发的 single-use grant；resume 使用 snapshot、blocked Runtime
Tool identity 与保存的 model ordinal 派生独立 continuation lineage，不能把 subagent id 当 continuation id。
取消传播到 Local Provider 后只允许一个最长 3 秒的绝对 cleanup grace；prepared 未 activate 的 handle 可证明
零 Driver I/O 并直接 abandon，active handle 必须 abort、bounded settle 并 reconcile。超时立即终止 observation
authority、保留 durable cleanup pending 并把已确认 dispatch 收敛为 unknown，不得再次 observe 打开第二个 grace
或自动重放未知外部效果。进程内 consumed-grant tombstone 只保留至 grant expiry；stopped/unconfirmed handle
hint 与 pending Driver registration 使用固定总容量和短 TTL，且 expiry 采用 finite、非递减的 high-water clock。
wall-clock 回拨不能复活旧 hint；hint 被驱逐或过期只能返回
`recovery_required`，不能把缺失状态解释为 stopped。startup recovery 在 Scheduler 前执行相同路径；确认 cleanup
前 fork 和新 attempt 都被阻断。

以上协议与生命周期的物理 owner 已切到 Builtin Runtime：`@kite/runtime-spi` 定义 JSON-safe
Subagent/Provider/continuation contract，`@kite/builtin-runtime` 拥有 sealed grant、Local Provider、唯一 composition、
continuation JSON/cursor、role ceiling、replay binding 与 `BuiltinChildRuntimeDriverV1`。App composition root 只构造一个
Builtin Driver/composition，`apps/kite/src/bootstrap/runtime/subagent/task-tool.ts` 的 State26 registration adapter
仅以 invocation-scoped callback 注入 tool/receipt translation。缺少调用者已经解析的 Model 或同一
`BuiltinModelEffectCoordinatorV1` 时立即 fail closed，
不得现场 `createChatModel()`、重建 Driver/composition 或 fallback。pending registration、single-use start/resume、
expiry、capacity、abandon 与 non-decreasing clock 都只由 Builtin Driver 裁决。该物理迁移保持
private suspended ref、Artifact schema/key、approval resume、cancel grace、cleanup/reconcile 与 unknown recovery 语义，并由 State26/Store5 持久化。

并发 sibling 同时暂停时，每个 durable `subagent.suspended` 都必须立即把对应 TUI block 投影为
可见的 suspended 状态并停止 spinner 与计时；后续 Runtime 事实将其区分为“等待自动审查”、
“自动审查中”或“等待你的批准”，只有最后一种表示用户必须操作。该展示不能依赖 child 是否占有
唯一的 approval interaction。只有一个审批可以成为 canonical interaction，其余 continuation 通过
`subagent.approval_deferred` 排队。snapshot 必须保存原始人工或 auto-review 路由，历史 snapshot
缺失该字段时保守回退人工审批；重新呈现延后审批不 dispatch、不创建资源 reservation，真正批准
并恢复 child 时才创建新的 parent attempt。已经获批的 active continuation 必须先于 deferred sibling
恢复；批准事件立即将 TUI block 切回 running，后续 child step 保持该状态。

Resource budget 为每次 continuation/resume 创建新的 parent attempt reservation；每个子模型及
工具、Shell/MCP 调用再创建链接到 parent 的独立 reservation，artifact bytes 由产出它的调用一并
预留/结算。child permit waiter 按 durable FIFO 等待，取消时必须写入 waiter cancellation；若
effect lease 已因整轮取消失效，则外层取消事务负责收敛全部 waiting waiter。Provider/tool 在
dispatch 后抛错时 child reservation 转为 unknown，不得只结算 parent 或静默退款。审批或本地
策略尚未通过时不得提前创建 child reservation；Provider 最终本地 admission 明确拒绝且尚未
网络 dispatch 时，只能携带 `local_provider_admission_denied` 证明释放 reservation。取消后迟到的
child actual usage 只能经 Kernel 的 resource-only late reconciliation 入口提交；该入口不接受
child tool/model terminal event，不能复活 turn、permit 或后继调用。

## 交互终态与 TUI 回放（ADR-0071）

所有人工交互（`ask_user`、工具审批、Plan review、Provider action、Provider admission、子 Agent 工具审批）都必须先持久化用户终态，再清除 TUI。用户回答 `ask_user` 写入 `user_input.answered`；用户取消写入同时携带 `interactionId` 与 `toolCallId` 的 `user_input.cancelled`，随后写入对应的 `tool.finished`。工具审批的批准/拒绝、Plan review 的批准/修订/取消以及 Provider 终态必须校验当前交互身份；Plan review 还校验 `planId`、`version` 和 `structuralDigest`。迟到或重复的旧交互事件不得清除新的交互。

Runtime canonical event store 只记录真实用户操作。TUI 从事件日志回放时，如果发现 `awaiting_user_input`、`awaiting_tool_approval`、`awaiting_review`、`awaiting_provider_action` 或 `awaiting_provider_admission` 仍未形成终态，只在 TUI 本地投影 `用户取消执行（会话恢复时交互未完成）`，清除 Footer interrupt、pending tool、Plan `pendingPlan` 和子 Agent `awaitingApproval`；不得伪造 `approval.rejected`、`plan.rejected` 或其他用户操作事件写回 Runtime。回放后的 TUI 不得显示 pending interaction。

用户在这种本地恢复投影上首次继续新工作时，TUI 必须 fork 一个清理后的恢复会话：源会话及其 canonical pending 事实保持不变，fork 的 Runtime snapshot 清除待交互状态、活动队列和临时授权，并只从 fork 的回放事件历史中排除造成当前 pending 的那一条请求事件。这样新的 TUI 工作不会重新进入旧 interaction，也不会把本地投影伪装成源会话里的用户拒绝；当前 TUI 继续使用已投影的取消结果。

回放本地取消仅适用于尚未开始执行的交互等待工具。已经产生 `tool.started`、外部副作用、未知 Capability invocation 或未知资源 reservation 的事实必须保留为 `unknown`，进入 reconciliation，禁止自动重试或重复执行。`auto_review` 不属于人工交互：明确通过继续执行，明确拒绝终止工具；技术异常（包括超时、Provider 不可用、网络/格式/Admission 错误）先记录带 `failureType` 的 `auto_review.completed` 失败，再生成新的 `approval.requested`。缺少 `failureType` 的历史 `ok=false` 记录按未完成技术异常保守处理，TUI 只做本地取消投影，既不自动执行也不伪造成明确拒绝。用户显式取消自动审查时，Runtime 将工具持久化为 `tool.cancelled(reason=user_cancelled)`；仅进程在审查完成前退出时才在 TUI 本地投影取消，不自动通过，也不转人工审批。
