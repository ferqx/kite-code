# Prepared execution、Attempt 与清理

入口：[execution bridge](../src/execution/execution-bridge.ts)、[tool coordinator](../src/execution/tool-pipeline-coordinator.ts)、[lifecycle 目录](../src/lifecycle/)、[process port](../src/process/execution-port.ts)。

## 从决定到执行

Kernel 选择 effect；Host 将已提交命令对应的 prepared execution 绑定准确 Session、操作和 committed revision。外部 Provider work 前完成 durable attempt acknowledgement。准备对象与一次 attempt 的执行身份不能由 UI、Server 或工具参数重新拼装。

Tool coordinator 在 preparation、dispatch、receipt 和结果提交之间维持同一 identity。Builtin 提供实际执行机制，Host 管理 attempt、lease 和提交资格，Store 验证持久 generation/revision。三者职责不能合并为“执行器返回成功即可完成”。

续轮子工具审批的父 Tool 身份使用 [Host storage codec](../src/storage/followup-child-approval-identity.ts) 统一编码和解析。Service 审批路由与 SQLite Store 使用同一版本前缀、字段界限及 canonical 复编码规则；SQLite 保留原公开导出作兼容，但 Service 的运行时逻辑不从具体 Store 包取得该解析权威。格式回归见 [Store 审批代理测试](../../runtime-storage-sqlite/test/kite-child-approval-proxy.test.ts) 与 [Service 代理测试](../../../apps/kite-service/test/child-approval-proxy.test.ts)。

预派发子 Session 的失败结算通常在父事务中提交预算释放、失败与结果三个事件。父 Run 已由用户取消且准确子预留先前已释放时，Host 仅对 revision 0 的未激活子 Session 接受显式 `alreadyReleasedAfterParentCancel` 变体，凭原 Run 的持久取消证明提交取消与结果两个事件；Store 再核对原 Run 的取消状态、用户取消事件、原释放及子线程未派发证明。当前 turn 可以属于后来的 Run，不能替代或否定原 Run 的证据。其他路径不能省去预算释放或重放外部操作。

## 并发与失效

dispatch 前严格检查 fence；已 dispatch 的同一模型 invocation 可按当前规则接受与无关用户控制 revision 并发的流和终态，但 Turn 终止、invocation 替换或 identity 漂移后拒绝迟到结果。后台 child 结算可能在 `task_read`、`task_wait` 或 `task_cancel` 已派发后先推进 revision；Host 只在原 Turn 仍活动、精确 Tool／Capability identity 仍 live 且返回批次仅关闭该调用时接纳其旧 lease 终态。该例外不适用于 attempt start、其他工具或已结束调用，也不把接纳已执行结果扩展为重试许可。

命令返回和执行清理不是同一时刻。排队后继要等相应 lifecycle 可调度，不能因客户端已看到取消消息而越过 Provider 或子进程 cleanup；会话关闭后，即使带有排队许可也不得再调度。
`waitForSessionIdle()` 等待当前执行及其清理期间排入的后继执行，直到该会话没有 scheduled work；关闭 Host 也使用同一空闲判定。
Host 关闭时并发请求各 Session 的持久取消，单个 Session 的取消写入迟滞不会阻止其他 Session 开始取消；各 Session 的本地执行仍须在其取消请求之后中止并等待清理。
关闭全过程使用固定 10 秒预算，留出 Desktop 进程退出的剩余窗口。取消写入或 Provider 清理超时时，Host 拒绝关闭结果、停止后续 bridge/module/Store 释放，不把未知清理当作成功；本地执行会收到 abort，但其实际结束仍需进程退出或恢复证据确认。

## 进程与恢复

POSIX 使用 process group/watchdog 边界处理正常取消与 Host 意外退出；Windows 使用相应 Job/process-tree guard。Host 关闭先关闭 bridge，再按 module 生命周期释放，不创建额外业务 daemon。

未知外部结果保持 unknown，不通过重复运行“试试看”恢复。持久恢复事实由 Storage 检查，业务恢复选择由 Kernel 决定，Host 组织执行。流程见[取消恢复链路](../../../docs/development/flows/cancellation-recovery.md)。

验证：[tool coordinator](../test/tool-pipeline-coordinator.test.ts)、[effect supervisor](../test/effect-supervisor.test.ts)、[process execution](../test/process-execution-port.test.ts)、[state recovery](../test/state-recovery.test.ts)。

## 跨 Session Agent 停止意图

`interrupt_agent` 的模型入口在独立父子 Session 的完整 Host 邮箱 Port 就绪时开放。Host 只接受来源当前 Run/Turn 中准确的 `interrupt_agent` Tool attempt，并在持有来源 effect lease 的同一事务提交 `background_execution.stop_requested`、命令回执和 Store 私有停止意图。`agent_id` 先由 Store 解析为直系 child Session 的准确任务、Run 与 controller generation；来源不能把 child ID 当成可直接执行的命令。目标 owner 随后固定原任务身份接纳停止，并使用原 task control 的取消、清理和 unknown 证据；自然完成竞态回报 idle，不伪造刚停止成功。正式 App Server 已验证真实直接子任务的 Stop 结算与非直系拒绝；queued revision 0 子线程的真实 SIGKILL 恢复也已验证。

预算激活前的排队 child 没有目标 Run 或 generation，使用单独的父作用域意图：固定原 child intent 的 `childInvocationId` 和 `toolEventId`，仅父 owner 复用 `task_cancel` 权威。Store 在此意图未结算时拒绝该 child 的预算激活与 Run 创建，因而停止与首次派发按同一持久 writer 串行；兄弟 child 不受影响。恢复扫描只从私有 pending intent 表找候选目标，不从旧同 Session `agent_nodes` 重建活任务权威。

## 空闲执行权

App Server 的释放回调由 Host 在会话 mailbox 中调用，与下一条命令取得执行权串行。命令提交、activation 和 scheduled work 的 completion 全部结束后，Service 等待 coordinator 清理并核对未决 effect/Provider 事实，才以原 generation 与 authority revision 释放；不再续约空闲会话。下一次执行重新获取 generation 并恢复 coordinator。终态通知先于清理时仍等待实际 completion；等待用户交互只在没有活动执行资源时释放。
延迟发布前一轮 State 的通知时，Run 投影选用该 State revision 当时已创建的 Run；不能把后续新 Run 的排队状态投到旧 revision，造成同 revision 投影冲突。

get_command_receipt 只读取原命令的持久结果，校验查询 scope 与原命令相符，不进入 mailbox、不获取执行权、不执行 activation。缺失回执保持未知；命令自身的持久幂等校验继续保留。验证见[命令与清理回归](../test/persistent-command-host.test.ts)。

## 引导与后台控制

`steer_turn`、`stop_background_execution` 与普通 Run 命令共用 Session mailbox 和持久 command receipt。引导首次受理时在同一事务核对活动 Run/Turn、owner 与队列容量并追加输入；相同 commandId 与摘要重放原回执，即使目标随后已经结束。后台停止先持久化精确 execution identity 和 stop intent，再由 activation 驱动实际 owner 清理；崩溃恢复重复扫描同一 intent，丢失活句柄时落为 unknown，不伪造成功。

CompletionGuard 的 `wait_for_background` 保持原 Run、Turn、deadline、预算、取消入口与 execution authority；Host 只投影关联 required task ID 的 waiting reason，不复制 child 状态。活动 Run 中的新纯文本仍通过 `steer_turn` 恢复同一 Run，不会取消 child 或创建第二个 Run；处理后义务仍未解除时可再次进入等待。纯进度 revision 不构成模型恢复理由，authority／owner generation 漂移和 deadline／取消竞争沿既有恢复或 unknown 边界收敛。

普通工具调用中的 `task_wait` 只借用 Host 已有的 State revision 通知识别当前 Turn 的新输入，并复用 Background owner watermark 等待目标变化。它的单次 timeout 不持久化，不取得 CompletionGuard 或 child lifecycle 的写权限；新输入、timeout 或 Run abort 结束等待时均不取消 child。required 自动等待与 Kernel 接纳终态的权威关系不变。

[后台 Agent 与 Shell 会话协调方案](../../../docs/plans/background-agent-shell-conversation-coordination.md)的等待修复保留主 Agent `steer_turn` 和原 task 结果权威；Kernel 为有限 Shell 等待保存准确 Shell ID 与模型已回复标记，Host 只将 `required_background` 的初始 task ID 集合投影为 Run 等待原因，各执行卡反映实时状态。阶段 D 的独立 Agent 身份、持久邮箱、QueueOnly／TriggerTurn 路由、模型输入水位及来源后备 reservation 已接入生产事务。旧 v1 `new_turn` 在准确 checkpoint 和新 grant 下将未派发后备原子替换为新 child turn 与首模型 Surface reservation；旧 v1 `current_turn` 仅用已准入旧 Run 的本地模型预算，在准确 call_model lease 内提交目标路由和邮件水位，再由来源事务释放后备，派发前复核来源 ACK。两条旧路由均不改写原 task 结果，跨 Run 邮件仍是低权限输入；不完整或已尝试的外部效果保持 unknown，不能重派。

独立子 Session 的新首轮委派在父 Run 有效时受理有限模型、turn、token、Artifact 与并发额度；其子 Run 在预算激活时独立开始完整的 30 分钟期限，父 Run 先前耗时和排队时长不扣减它。新委派的持久上界带 `independentChildTurnDeadline` 与 `unboundedToolInvocations` 标记，允许该子 Run 依角色、策略、审批和并发约束调用工具，而无累计工具次数上限。Host 的 [resource budget adapter](../src/kernel-adapter/resource-budget.ts) 以该标记验证子 Run 的激活期限和工具额度，旧委派无标记时仍验证原父资金期限与有限工具上界。仅当原父 Run 等待的 required child 均有新标记，Kernel 才记录 `required_child_wait_started`／`ended`，暂停并补回父 Run 实际等待时长；等待中禁止新的父资源派发，原 required 结果仍须准确接纳。

`followup_task` 的新 `independent_turn_v2` 在来源 Run 受理时保留有限 Model、token、Artifact、turn 与并发备付，目标 child 新 Run 从启动时独立计时 30 分钟。`followup_task` 工具本身不写工作区 Artifact，其工具 reservation 不重复占用目标备付的 Artifact 额度。Host 依来源备付上的 `independentFollowupTurn`／`unboundedToolInvocations` 标记和目标原角色 grant 验证预算、可见 Tool Surface 与执行权限；没有累计工具次数上限，不继承来源 Run 后续完成与否作为目标 Run 截止时间。目标派发后，来源备付与目标支出按同一 submission 身份结算；确定未派发则释放备付，外部尝试不明则保持 unknown。缺少 v2 标记的旧 followup 仍走原期限、一次模型请求与零 Tool 的 v1 恢复路径。初始子 Run 已持久激活并收到父派发 ACK 后，短期启动 grant 过期不截断无模型／工具尝试的首轮恢复；Service 必须先以 Store 执行权隔离旧 owner，核对激活时授权有效、父预留已派发、子 Run 未到期和原工具上界。未激活的 child 仍要求有效启动 grant，结果不明的外部尝试不能重派。

阶段 D0 的独立 Agent Session 已接入默认 Store11 App Server：父线程在原 `task` Tool 回执中受理确定性 child intent、required claim 和有限委派预算，子线程分别拥有 State revision、effect lease 与 execution generation；子终态先在子 Session 封存，父线程只从准确结果桥接一次性导入并结算原 claim。新 Run 的 Limited 预算默认允许三个活跃子 Agent，Service 配置可改变该数量；超过子 Agent 或写者额度的创建请求在父工具回执前失败，不记录 child intent，也不创建 revision 0 子 Session。历史 queued 委派仍由父 CAS 的 `resource_budget.child_slot_acquired` 在预算位释放后激活；排队子任务在派发前被精确取消时继续使用独立取消事实与释放收据。新建子 Session 立即登记到本机 execution lease 续约 owner；旧 revision 0 子 Session 的初始租约若已过期，预派发失败结算先隔离旧 generation 并验证没有模型或工具尝试。重启扫描依据同一父意图、子创建回执和预算状态重放内部步骤；已 dispatch 或 unknown 的外部操作不得重试。人工审批的独立子工具由父作用域代理交互承接，具体授权仍按现行代理回执核验。

子恢复动作无法取得安全结算证据时，Host 可按原父工具、子线程、attempt 与 grant 精确身份提交非终态 `subagent.child_recovery_required`；同一诊断幂等，冲突诊断拒绝。它只推进父 State revision，供等待与查询观察，不把单个子恢复故障伪装为父 `run.error`，不结算 required claim 或改变预算。Store 在 receipt 事务中复核待处理意图及子执行权；活动或已封存的子线程拒绝该诊断。

独立子线程恢复中的 unknown 终态使用与已确认清理的终态不同的 receipt digest。Host 只在子 State 已为 unknown Run 结果、外部尝试及预算用量仍未知时接受 `cleanupConfirmed=false` 的封存导入，并向父资金 Run 提交 `resource_budget.unknown`；Store 另核对 fenced recovery generation 与释放后的 `recovery_required` authority。结果 Artifact 和 required claim 可一次性交付，但 Host 不将未知用量调和成成功，亦不重派子线程的外部尝试。

已 ACK 但尚未启动外部调用的子 Run 遇持久停止请求时，由 fenced recovery generation 提交用户取消与已确认清理的终态，父结果桥接只导入该封存。queued Run 在这种终态转移时以终态发生时刻填 `startedAtMs`，满足 Run 索引的时间戳不变量；它不表示曾派发模型或工具。父级已先把委派 reservation 标为 unknown 时，导入验证原预算事件与当前 ledger，不追加第二个相同 unknown 事件。

后台 task 接受后，父工具 reservation 可以按工具终态正常结算；在其仍属于同一 Run 且未显式释放时，派发期间创建的 descendant admission 继续作为 child 后续模型轮次和工具调用的预算血缘。admission 仍只能在父 reservation 为 `dispatch_started` 时创建，不能从已结算事实重新构造或扩大授权。

After-turn 具名结果事实持久保存首次启动的 admission revision；内部启动和重试据此重建同一完整 canonical `start_turn` 命令并查询持久回执。首次执行在 Session mailbox 内另行绑定最新投影 revision 作为变更 CAS，该瞬时值不改变 canonical 请求摘要，因此持久回执和崩溃重放仍使用稳定身份。相同 commandId 的摘要不匹配属于 identity collision，必须抑制，不能视作成功重放；缺少该 revision 的旧 after-turn 事实 fail closed。调度失败或被抑制时，Service 释放原 after-turn reservation，不留下第二个预算 owner。 原父 Run 的报告模型预留只为自动汇报保留启动资格：新汇报 Run 准备模型时先释放该旧预留，实际模型请求从新 Run 的活动账本预留，且其输入／输出上界仍不能超过旧报告预留，避免向已清账的旧 Run 新增 reservation 或扩大原授权。
Host 在等待旧 Run 空闲前先读最新投影，并在等待后再核一次；Session 已有用户启动的新活动 Run 时，`human_start_preferred` 抑制自动 continuation；持久结果保持可读，但 Host 不把迟到结果注入该活动 Run，也不并发创建第二个主 Run。

活动或正在停止的 Shell/service/subagent 会阻止 Fork 与 Rewind。Session close 继续由 bridge 管理资源清理。删除是独立数据操作：Host 取消真实活动执行并关闭后续调度，Service 管理异步资源收尾；数据删除不等待旧工具、Run、恢复标记或 cleanup 确认。当前 Store composition 直接读取元数据并原子保存回执和 tombstone，不重建业务投影或恢复任务。迟到 callback 不能恢复已删除会话。