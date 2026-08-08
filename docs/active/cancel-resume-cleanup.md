# Cancel、Resume 与工具调用清理

状态：active

读取时机：修改 abort/cancel、Runtime 恢复、Effect lease、消息工具对清理、工具参数异常、Subagent continuation 或 TUI 取消行为时。

验证：`bun test tests/runtime/agent-deadline.test.ts tests/runtime/cancel-resume.test.ts tests/runtime/concurrent-shell-cancel.test.ts tests/runtime/kernel.test.ts tests/runtime/reducer.test.ts tests/runtime/stability.test.ts tests/runtime/store.test.ts tests/runtime/file-checkpoints.test.ts tests/shell-exec.test.ts tests/tool-runner.test.ts tests/tool-parse-error.test.ts tests/context.test.ts tests/subagent-continuation-codec.test.ts tests/session-manager.test.ts tests/tui-reducer.test.ts tests/tui-replay-blocks.test.ts tests/tui-layout.test.tsx tests/tui-interrupt-clear.test.ts tests/tui-rewind-handler.test.ts`、`bun test --parallel=1 --max-concurrency=1 tests/tui-system/scenarios/file-rewind.test.ts`、`bun run typecheck`。

## Runtime 取消语义

取消通过 AbortSignal 传播到模型、工具和 Subagent。用户停止当前轮次时，App shell 必须先通过 live Kernel control plane 原子持久化全部未终结工具的 `tool.cancelled` 与带 `cause=user` 的 `turn.aborted`，再触发 AbortSignal；这样活动 Effect lease 会因 revision 前移而失效，队列、active 列表和 transcript 工具调用/结果对共同收敛，不能留下永久 busy 状态。该操作只终止当前 turn，不把活动 task 改为 cancelled，下一条用户消息仍可沿当前任务上下文继续。重复取消不得追加重复 Tool Result。TUI 清理运行中 block 只是上述 Runtime 事实的展示投影，不是 Runtime 取消事实本身。

工具审批中的显式“拒绝”与 Esc/取消使用同一整轮语义。Kernel 必须在一个 action batch 中先为当前审批目标写入带 `approval_rejected` failure 的 `approval.rejected`，再为其余未终结 sibling 写入 `tool.cancelled`，最后写入 `turn.aborted(cause=user)`；Runner 随即退出，不再请求后续审批、执行 queued 工具或调用模型。Agent 在观察到该用户审批拒绝时立即 abort 本轮内部执行信号，使已经启动的 Shell、Subagent 或其他可取消执行真正停止；迟到事件由 Effect lease 拒绝。该规则不适用于 `policy_denied`、sandbox 缺失或系统自动审查等非用户拒绝，它们继续按各自失败路径处理。

方案执行确认（`request_plan_review`）也是执行授权屏障。用户选择取消或按 Esc 时，Kernel 在同一 action batch 中写入 `plan.review_cancelled`，将触发确认的方案工具及其余未终结 sibling 全部写为 `tool.cancelled`，最后写入 `turn.aborted(cause=user)`；方案文档保留为可继续修改的 draft，但当前 turn 立即结束，Runner 不得再次调用模型或进入执行阶段。

`ask_user` 是用户输入交互，不是执行授权审批。用户拒答或按 Esc 时，Kernel 先写入携带 `interactionId` 与 `toolCallId` 的 `user_input.cancelled`，再为该 `ask_user` 写入 `tool.finished(ok=false, stdout=Cancelled)`，清除 `awaiting_user_input`；不得写入 `approval.rejected`、`tool.cancelled` 或 `turn.aborted`，也不得 abort 本轮执行信号。Runner 随后继续调度；模型在同一 turn 中看到拒答 Tool Result 后继续回答或调整方案。

TUI 对用户取消的终态投影遵循：已实际开始的工具保留原名称、关键参数和已有输出并显示 `cancelled`；从未开始的 queued 探索工具不计入 `read N files` 等统计；不追加独立的整轮取消提示。实时取消和 event-log replay 必须得到相同投影。

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

若 deadline 命中交互等待时仍有并发 Shell 在后台运行，等待分支不得因 AbortSignal 直接返回。
它必须先有界排空后台 effect，转发工具 terminal 与 `runtime.cancellation_diagnostic`，确认
process-tree cleanup 已完成后才能关闭 RuntimeStore/logger 并形成 deadline terminal。

Shell 取消由 process-tree guard 独占：POSIX 对独立 process group 先发 SIGTERM，等待 500ms，
再以 SIGKILL 强制终止并进行 2 秒有界确认；Windows 先尝试 root graceful，再通过 Job Object
或 `taskkill /T /F` 清理整棵树。结果必须携带 confirmed/forced/unconfirmed count。无法确认
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

“切换会话”是否表示取消属于 App 适配层交互语义，不是 Core Runtime 规则（ADR-0050）。当前 TUI 是单前台、终端式交互：新建或切换到另一会话时，`SessionManager` 必须先对离开的活动 turn 调用持久化取消，再把会话切到后台，因此 TUI 中切换会话等同用户取消当前 turn。

未来图形客户端可以同时保留多个运行中会话。它切换可见会话时必须保留离开会话的 Runtime、活动 Effect 和 pending interrupt，只有用户显式提交取消动作时才写入 `turn.aborted`。Core 不得根据 foreground、路由切换或“当前可见会话”自行推断取消。

## Resume 语义

恢复从 Runtime snapshot + event log 重建 State，并重新检查不变量。App 读取会话时必须把 rolling snapshot 之后的持久化事件尾部归并后再投影交互；已经出现 `approval.granted` 或 `approval.rejected` 的审批不得从旧快照或事件重放中复活。以下状态不得被静默丢弃：pending approval、未完成 tool call、Capability binding revision、Skill frame、required verification 和 unknown external invocation。

重启不自动重放未知外部写入；必须 reconciliation 或用户决策。瞬时 binding、approval token 和 Effect lease 只能按各自恢复规则重新签发或收敛。

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

Core 的 `restoreNamedSnapshot` 仍是可供非 TUI 调用方使用的破坏性原语；调用它时恢复文件
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

子 Agent 因审批暂停时，continuation 必须可序列化并绑定原 tool call、消息、步骤与 journal。恢复前重新校验批准内容和能力边界；用户拒绝或取消该审批时，清除 continuation，并按上述规则中止整个当前 turn，不再恢复子 Agent 生成后续结果。

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
