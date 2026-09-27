# Agent Note: Codex 式 Agent 邮箱与续轮保留唯一结果权威

Status: implemented

## Problem
用户要求主 Agent 与子 Agent 都能在活动轮接受引导，并按 Codex 的排队消息、显式续轮、邮箱等待和状态查询来协调后台工作。[OpenAI Multi-agent 文档](https://developers.openai.com/api/docs/guides/responses-multi-agent)将这些操作分开。原决定形成时，Kite 只有单次 child `task_id`、原 Run 的 required 结果接纳和用户→主 Agent 的 `steer_turn`。现有 child terminal 由唯一 watcher 保存结果 Artifact，再按原 Run／Turn／Tool／attempt 交给 Kernel；跨 Run 重发旧 `subagent.background_result_persisted` 既不合法也会改写结果血缘。当时的子 Agent 模型循环没有普通续轮的已结算对话 checkpoint，资源预算也要求每次模型／工具执行先准入。

本记录保存通信和续轮协议的架构取舍；当前交付范围以产品手册与 owner 文档为准。

## Current scope
本记录保留原决定的理由。Agent 身份与逐轮 task、QueueOnly 与 TriggerTurn、低权限结果与邮件、准确预算授权及唯一终态已由阶段 D 的独立子 Session 实现。下文历史接线草案中凡依赖父子 Agent 共用一个 Store Session、一个 Session revision、同 Session 邮箱事务或子 Agent 直接写父 State 的部分，已由[现行方案 §4.0](../../../../docs/plans/background-agent-shell-conversation-coordination.md)及[Agent Note 0191](2026-09-26-independent-agent-sessions-and-result-bridge.md)的每 Agent 独立 Session 边界替代，不再指导实施。当前跨线程事务与恢复范围以该记录和 owner 文档为准。

## Decision
Agent 邮箱与续轮已采用每 Agent 独立持久 Session、来源 outbox 与目标 inbox、准确预算和结果桥接；队列消息不唤醒空闲目标，显式续轮与精确停止经 Host/Store 受理。原 `task` 结果仍由唯一结果桥接接纳，跨 Run 邮件保持低权限。当前实现、限制与验证由 [Host owner](../../../../packages/runtime-host/docs/execution-lifecycle.md) 和 [协调方案](../../../../docs/plans/background-agent-shell-conversation-coordination.md)维护。

## Historical implementation choice (partially superseded)
以下第 1–7 项保留原方案细节与取舍；共享父 Session 的接线范围已由 [Agent Note 0191](2026-09-26-independent-agent-sessions-and-result-bridge.md) 替代，不能作为当前实现契约。

1. 首轮 `childInvocationId` 作为稳定 `agent_id`，沿用 [Agent Note 0114](../testing/2026-08-18-stable-subagent-actor-identity-for-strict-replay.md) 的 actor lineage，不把它当授权。每一轮另有 `task_id`；首轮可与 `agent_id` 相同以保留当前结果，后续轮使用新 task ID、新 Tool attempt、结果 Artifact 与 grant。根 Agent 身份绑定 Session 而非单个 Run。Agent tree 与当前活轮映射由 Host/Store 持久保存。
2. Host/Store 的 Session 事务是 Agent inbox、调用者 mailbox、命令 receipt 与路由顺序的唯一权威。`send_message` 只持久排队，不启动空闲目标；`followup_task` 提交 TriggerTurn 意图。活动目标只有在发送方 ceiling 允许触发旧 grant、含邮件的准确下一模型 Surface 已从旧预算准入后才走 `current_turn`；final 先结算、权限不兼容或旧预算不能准入时，可信终态后走 `new_turn`。两种路由以 Agent lane 顺序互斥。`wait_agent` 等调用者邮箱更新；`list_agents` 只读整体状态。用户→主 Agent `steer_turn` 保留原用户权限与同 Run 语义，Agent 消息始终是低权限内容。
3. Builtin child runtime 在完整对话仍可用时生成私有不可变 checkpoint；Service watcher 验证它并与本轮结果 Artifact 的 canonical terminal 一起提交。只有已结算 checkpoint 可作为下一轮上下文；旧 grant、审批和未确认外部副作用不得重用。checkpoint 不可用时，本轮结果仍准确结算，但 Agent 不可续轮。可恢复的写入故障让既有邮件继续 queued、暂拒新信；永久故障在 terminal settlement 中将未准备邮件及未路由 TriggerTurn 标为可查询的 `context_unavailable`，保留原 receipt／正文引用、释放待投递容量与未 dispatch 后备预算，并向发送者邮箱只发布一次具名失败。
4. 原 `task(background=true)` 的结果接纳路径不变。后续 followup 新轮以 submission 为来源，仍由唯一 watcher 写独立结果 Artifact，但通过 Agent tree 的 `agent.task_settled` 结算，不伪装旧 `task` Tool attempt 的 `subagent.background_result_persisted`。跨 Run 反馈使用带来源、相关 submission、结果引用的 Agent mailbox 消息，在接收 Agent 的准确模型输入边界另行接纳；它是派生通信事实，不是第二个 task terminal，不重发旧结果事件，也不在发送方 Run 建立逐条 required claim。发送方可以显式等待或继续；结束后的邮件保持可读，不自动开启主 Run，也不把旧结果注入后来的人类新 Run。
5. `send_message` 不预留目标模型调用。`followup_task` 的发送方须有活执行 scope：主 Agent 的活动 Run/Turn，或子 Agent 的有效 grant 与可寻址的原资金 Run。受理时从该资金 Run 的持久共享 ResourceBudget 预留首个模型请求和一次新 child turn 的模型最坏有界上界，固化原调用身份、授权／能力／effects digest、phase ceiling、workspace/mode/policy revision、reservation、deadline。资金账本必须在发送方根 Run 正常结束后保持可寻址，直到 followup 结算；当前 Host/Store 若不能证明此点，就不能开放该工具。受理显式校验原 deadline 尚有至少 `max(60 秒, Provider 首次尝试超时 + 5 秒)`，模型界限未知、预算不足或账本 unknown 均提前拒绝。
6. `followup_task` 成功只证明意图、授权快照和首个模型／turn 后备预算已持久受理，不证明已经执行。新轮须在原 deadline 和有界等待期限内取得子 Agent 并发执行位，启动失败以可查询状态结算。`current_turn` 必须先将含邮件的准确模型 Surface 从目标旧资金账本准入，才可提交路由／输入水位并释放发送方未 dispatch 后备；单有输入草稿不能释放。`new_turn` 以发送方受理时 ceiling、目标 role 与激活时最新策略的交集签发 grant；准确 Surface 与后备的原子替换必须由新增 reducer/admission 不变量逐字段证明不超过上界。现有 `planModelInvocationResource(replaceReservationId)` 没有该不变量，不能直接作为实现。后继调用逐项受同一资金账本和原 deadline 限制；dispatch 与 unknown 仍按持久证据调和。
7. 消息受理与工具 receipt、后备预留同事务；从准确 Tool call identity 派生 submission ID，重试先查持久 receipt，事务已提交时不得先重新生成随机 reservation。模型输入准备绑定准确 Surface、邮箱水位和 invocation；terminal／checkpoint／邮箱通知按准确 identity 幂等恢复。等待器、UI 查看和状态查询不能消费邮件。Service 的活句柄与 watcher 不能成为第二个持久邮箱或调度器。

## Alternatives considered
- 把 `task_wait` 改名为 `wait_agent`，或只用内存 owner Map 存消息：拒绝。指定 task 的 wait-any 与调用者邮箱等待不同，内存事实也无法证明重启后的成功受理。
- 每次 `followup_task` 都创建新的 task，或强制活动 child 当前 final 等消息：拒绝。前者失去活动轮引导，后者把受理误写成“当前轮必读”，均偏离选定的 Codex 交互。
- 将旧 `subagent.background_result_persisted` 改写到后续 Run，或给每条 followup 加发送方 required claim：拒绝。它破坏原结果身份与 CompletionGuard 的当前工作边界。
- 复用审批专用 continuation、旧 grant 或旧 Run 额度开启新轮：拒绝。它们都不能证明普通终态上下文及本次授权。
- 成功入队后才尝试取得新轮预算，失败时静默停留在 queued：拒绝。TriggerTurn 的成功回执必须已有可用的首模型／turn 后备预算；后续执行位和策略变化以可查询状态结算。
- 在资金 Run 结束时丢弃原账本，再把 reservation 改指向新 Run：拒绝。现有账本和 reservation 都严格绑定一个 runId；Stage D 保留资金账本至意图结算，不隐式跨账本挪用额度。

## Consequences
Kernel、Host/Store、Builtin child runtime、Service watcher、Runtime Contract 和客户端承担各自的窄范围协议。一次后台结果仍只有一个 terminal Artifact 与原 Kernel 结果接纳；邮箱提供通信和可追踪的输入准备事实。跨 Session 提交与恢复增加了事务和验证成本；当前行为以负责文档与测试证据为准。

## 回滚
撤回已交付的消息或续轮能力时，须先停止新消息准入、结算已受理邮箱与后备 reservation、保留历史 task Artifact 可读，再按实际 State 格式决定迁移或 epoch 处理；不能直接删除仍可能被恢复的 Agent 消息。

## Historical relationships

决策者：产品需求由用户确认采用 Codex 的 Agent 交互；Kite 的接线取舍由 Runtime 设计负责

相关：[后台 Agent 与 Shell 的会话协调方案](../../../../docs/plans/background-agent-shell-conversation-coordination.md)、[执行手册](../../../../docs/handbook/features/execution.md)、[CompletionGuard](../../../../docs/active/completion-guard.md)、[Agent Note 0114](../testing/2026-08-18-stable-subagent-actor-identity-for-strict-replay.md)、[Agent Note 0055](../architecture/2026-07-30-cumulative-runtime-resource-governance.md)
