# Runtime CompletionGuard V1 / V2

状态：active
读取时机：修改 `run.completed`、final 文本、Plan lifecycle、scheduler/runner/reducer 终态或 Task 完成投影时。
验证：`bun test packages/agent-kernel/test/completion.test.ts packages/agent-kernel/test/core-reducers.test.ts tests/runtime`、`bun run typecheck`。
相关：ADR-0095、`plan-mode-implementation.md`、`failure-classification.md`。

模型的无工具 final 文本只是 completion candidate。CompletionGuard 是 Agent Kernel-owned、单调版本化的纯判定；scheduler
在选择 `emit_final` 前、runner 在持久化前、reducer 在接收 `run.completed` 时都按事件绑定的 guard version 重算，
因此直接注入 `run.completed` 不能把未完成 Task 标为 `completed`。

本轮 required 后台子 Agent 是完成 blocker。它是唯一 blocker 时，CompletionGuard 返回
`required_background_pending → wait_for_background`：reducer 清除 completion candidate，持久化
`waitingReason={ kind: required_background, taskIds }`，Runtime 停止模型调用并等待可行动事实。该决定不写普通
completion correction，也不消耗纠错次数；waiting reason 只关联 required task ID，不复制 child lifecycle。
只有 Kernel 已接纳的 canonical background result 才解除对应义务，内存终态或 Artifact 单独存在都不能绕过准入。
存在交互、普通工具、required Shell、unknown invocation、active Skill 或 Plan 等混合 blocker 时，继续按既有优先级处理，
不能用后台等待遮蔽它们。准确的 required finite Shell 命中 `wait_for_tool` 时也属于真实在途等待，初次完成候选不增加
correction attempt；Service 只在所有当前 required Shell 完成清理、且 required child 已接纳后唤醒主模型。用户引导可提前
唤醒同一 Run，兄弟任务继续。Shell 已终态而模型仍不调用 `shell_read` 时，持久等待事实记录模型已回复过一次，
后续非法 final 回到原有有界纠错，避免对同一终态立即反复唤醒。

V1 只用于无 Plan task。它只使用已有 canonical state：当前完成作用域内的非终结 Tool、pending interaction、suspended subagent、unknown Capability invocation、
active Skill 与 Plan lifecycle。`building_without_plan` 和 `completed` 可通过；`planning_empty` 要求 save，draft 要求 submit，
awaiting review 要求等待审核，executing 要求先发 `plan.completed`，cancelled 永远不是成功完成。verification 与
effect evidence 不会被模型反向伪造到 V1 判定中。

非终结 Tool blocker 与 Scheduler 使用相同的当前工作作用域：带 `taskId` 的调用仅在其匹配
`activeTaskId` 时阻塞；缺少 `taskId` 的调用仅在 `createdAtTurnId` 匹配当前 turn 时阻塞。当前 Task
跨 turn 恢复的调用仍会阻塞，当前 turn 的无 Task 调用也仍会阻塞；已经属于旧 Task/旧 turn、且 Scheduler
不会再调度的残留调用不得形成永久 `tool_pending → wait_for_tool`。V1/V2 共用这一判定，不能让历史调用
遮蔽当前 Plan lifecycle，也不能忽略当前作用域内真实未终结的调用。

Task-owned active Skill 与 suspended Subagent 也按同一归属规则投影：Skill 必须匹配 `activeTaskId`，挂起
Subagent 必须通过其 parent `task` Tool 匹配当前工作。旧 Task 的残留 frame或 continuation 不阻塞后继 Task；
父 Tool 缺失或已经终态的 suspended snapshot 同样不再是可恢复 continuation，不能形成永久
`subagent_suspended`。但 pending interaction 仍由 CompletionGuard fail closed，防止绕过 Agent/Scheduler 的恢复入口
直接伪造完成事件。

当前 CompletionGuard runtime state 是 schema v27 / `kite-runtime-saq-v2-2026-09-05` 的必需事实；
restore 不再把缺失 guard state 解释为零次纠错。缺失或错误 epoch 的 snapshot 在 Guard 判定前即 fail
closed，且没有兼容 reducer 或在线 migration。

V2 仅用于当前 lifecycle 持有 PlanDocument V2 的 task。它在 V1 的 task-wide blocker 之后检查完整 Plan identity
`{ planId, version, structuralDigest }`、步骤终态和 `PlanCompletionEvidence`：required verification 未到
`passed | waived` 时返回稳定 `verification_required → complete_verification`；已经发生副作用但缺少成功
Tool receipt reference、evidence 与 canonical Runtime 投影不一致或 evidence 整体缺失时返回
`effect_evidence_required → record_effect_evidence`；skipped reason 或 unresolved failure/approval 未收敛时返回
`plan_evidence_unresolved → resolve_plan_evidence`。即使步骤和 evidence 已满足，`executing` 仍须先产生合法
`plan.completed`；只有 `completed` 的 V2 Plan 可由 V2 接受。
V2 还读取 canonical-private Tool recovery journal：存在 unresolved failure 或 journal quality guard
已因损坏/无进展而 blocked 时，同样返回 `plan_evidence_unresolved`；该读取只匹配当前 active
task/turn。旧 task/turn 已关闭，或由成功 receipt、skip/replan/user/provider revision 明确恢复的历史
记录不构成 blocker；deny/timeout/cancel/unknown、terminal exhaustion 与 `next_response_elapsed` 在原
scope 仍构成 blocker。一次合法恢复调用只有在成功
receipt 明确绑定 `recoveryOf` 后才把对应 failure 标为 recovered；Plan evidence 不再把已由该血缘
收敛的历史失败误当成永久 blocker，但 dispatch 或 effect certainty unknown 的失败仍保持 unresolved。
这里的顺序是协议：pending interaction、非终结 Tool、suspended subagent、unknown invocation 与 active Skill 等
task-wide blocker 必须先于 V2 schema/identity/evidence 校验；即使 V2 document 已损坏，也不能用较低优先级的
`plan_evidence_unresolved` 遮蔽当前交互 barrier。

PlanDocument V2 的 completion evidence/replay 门禁额外拒绝任何 pending interaction 或 approval，不限工具是否
具有副作用。ADR-0118 后，内建文件读取不再因 Workspace 外路径产生 approval；但 Shell、MCP 或其他能力
形成的 read-only approval 仍是 unresolved blocker。facade 和 reducer必须使用相同 blocker，不能形成
`planning=completed` 与 `interactions=awaiting_tool_approval` 并存的状态。

被阻断时持久化 metadata-only `completion.blocked`（guard version、固定 reason code、next action、planning lifecycle、
完整 V2 Plan identity、correction attempt），并清除 candidate。事件不含 prompt、final 正文、工具参数、命令、路径或
输出。Runtime 对同一 V2 Plan identity 在一次模型纠错窗口内至多再次调用模型一次；该 correction ceiling 跨裸
`turn.started` 与 Runtime restore 保持，防止通过空转或重启绕过。真实 `user.message_appended` 是新的用户纠正信息，
会在保留 Plan document 与 revision feedback 的同时开启新的零计数窗口；完整 identity 的 version/digest 变化或当前
已不存在相关 V2 Plan 时也会重置。同一窗口、同一 identity 的第二次错误 final 通常以
`turn.aborted(cause=error) + run.error` 收敛，不能循环或显示完成。`plan_draft_pending` 是明确例外：draft 可以按
用户要求跨 turn 暂停，因此最终纯文本 final 持久化 blocker 后只写 `turn.completed`，保留 active Task、Plan
document 与 revision feedback；不得写 `run.completed`、`task.completed` 或 `run.error`。已有 review
`revisionFeedback` 的 draft 不再要求模型重复一次确认，第一次纯文本 final 即结束 turn；没有 review feedback 的新 draft
仍保留一次纠错机会。当前 epoch 的 runner 产生的 `run.completed` 必须绑定实际 decision version；V2 completion 还必须绑定同一完整 Plan identity。普通 reducer 在任何 guard decision 前先要求 `run.completed.turnId === RuntimeState.turn.turnId`，因此上一 turn 的 completion 在新 turn 无效。

首次可纠正的 `completion.blocked` 可单独持久化并进入一次 correction。第二次或其他不可纠正的 V1/V2 blocker 必须在任何对外 yield 前，由 Kernel 单事务按顺序持久化 `[completion.blocked, turn.aborted, run.error]`；durable turn 随即为 aborted，Scheduler 返回 stop，重启不能发起第三次模型调用。Runtime restore 只接受精确 schema version 与 format epoch，不为旧 completion event 建立 migration reducer 或 recovery surface。

`wait_for_background` 与有证据的 required finite Shell 等待是上述纠错规则的专用例外。重进从持久 waiting reason 与 canonical obligation 恢复；终态、失败、取消、需父级处理的交互或新用户输入可恢复同一 Run，纯进度／心跳／日志 revision 不触发模型。Shell 的 waiting reason 只记录准确 Shell ID 与完成等待后模型是否已回复，不替代 Shell owner 的执行与清理事实。完成等待 port 缺失会明确失败，不能把仍需等待的状态落入通用 `Completion blocked...` 终态。owner generation 更替、execution authority 失效、settlement admission 失败、deadline 或取消竞争必须进入既有 unknown／recovery／取消边界，不得永久等待或把未接纳结果视为完成。

新标记的独立 required child 是唯一 blocker 时，父 Run 为准确 task ID 持久记录预算暂停，结果接纳并结束等待后补回等待实耗；旧委派保持原 deadline。暂停期间不能派发新的父资源 reservation。预算暂停不改变 child 终态与 canonical result 的接纳要求，取消或未知清理仍按原恢复边界处理。

显式 `task_wait` 是普通的有界只读工具调用，不替代该自动等待决定，也不解除 required obligation；其返回只能帮助模型协调，canonical background result 仍是完成守卫接受的唯一 child 终态事实。

已实施的[Codex 式 Agent 通信设计](../plans/background-agent-shell-conversation-coordination.md#4-codex-式-agent-通信kite-接线决定)把 `followup_task` 视为显式 Agent 消息与续轮触发，不在发送方 Run 为每条 followup 建立 required claim；现有 `task(background=true)` 的原 required 义务及本节的结果接纳规则不变。跨 Run 邮箱消息有独立低权限输入身份，不能伪装原 task 的 `subagent.background_result_persisted`。
