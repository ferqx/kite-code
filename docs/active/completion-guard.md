# Runtime CompletionGuard V1 / V2

状态：active
读取时机：修改 `run.completed`、final 文本、Plan lifecycle、scheduler/runner/reducer 终态或 Task 完成投影时。
验证：`bun test tests/runtime/completion-guard.test.ts tests/runtime/task-plan-lifecycle.test.ts tests/runtime/kernel.test.ts`、`bun run typecheck`。
相关：ADR-0095、`plan-mode-implementation.md`、`failure-classification.md`。

模型的无工具 final 文本只是 completion candidate。CompletionGuard 是 Core-only、单调版本化的纯判定；scheduler
在选择 `emit_final` 前、runner 在持久化前、reducer 在接收 `run.completed` 时都按事件绑定的 guard version 重算，
因此直接注入 `run.completed` 不能把未完成 Task 标为 `completed`。

V1 保留给没有 `planSchemaVersion=2` 的 legacy replay 和无 Plan task。它只使用已有 canonical state：非终结 Tool、pending interaction、suspended subagent、unknown Capability invocation、
active Skill 与 Plan lifecycle。`building_without_plan` 和 `completed` 可通过；`planning_empty` 要求 save，draft 要求 submit，
awaiting review 要求等待审核，executing 要求先发 `plan.completed`，cancelled 永远不是成功完成。verification 与
effect evidence 不会被反向伪造到 V1 历史中。

V2 仅用于当前 lifecycle 持有 PlanDocument V2 的 task。它在 V1 的 task-wide blocker 之后检查完整 Plan identity
`{ planId, version, structuralDigest }`、步骤终态和 `PlanCompletionEvidenceV1`：required verification 未到
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
收敛的历史失败误当成永久 blocker，但 legacy 或 effect certainty unknown 的失败仍保持 unresolved。
这里的顺序是协议：pending interaction、非终结 Tool、suspended subagent、unknown invocation 与 active Skill 等
task-wide blocker 必须先于 V2 schema/identity/evidence 校验；即使 V2 document 已损坏，也不能用较低优先级的
`plan_evidence_unresolved` 遮蔽当前交互 barrier。

PlanDocument V2 的 completion evidence/replay 门禁额外拒绝任何 pending interaction 或 approval，不限工具是否
具有副作用。因工作区外读取而等待审批的 `sideEffect=false` call 也属于 unresolved blocker；facade 和 reducer
必须使用相同 blocker，不能形成 `planning=completed` 与 `interactions=awaiting_tool_approval` 并存的状态。

被阻断时持久化 metadata-only `completion.blocked`（guard version、固定 reason code、next action、planning lifecycle、
完整 V2 Plan identity、correction attempt），并清除 candidate。事件不含 prompt、final 正文、工具参数、命令、路径或
输出。Runtime 对同一 V2 Plan identity 至多再次调用模型一次；该 correction ceiling 跨 `turn.started` 与 Runtime
restore 保持，只有完整 identity 的 version/digest 变化或当前已不存在相关 V2 Plan 时才重置。同一 identity 的第二次错误 final 以
`turn.aborted(cause=error) + run.error` 收敛，不能循环或显示完成。新 runner 产生的 `run.completed` 绑定
实际 decision version；V2 completion 还必须绑定同一完整 Plan identity。没有 completion state 的旧 snapshot 视为零
correction attempts。Runtime schema v22 是可信版本边界：只有从 v21 或更早 snapshot 的持久化 event tail 执行 migration
replay 时，记录为 V1 的旧 event 才继续由 `decideCompletionV1` 读取；当前 v22 state 上的 event payload 不能通过自报
`completion_guard_v1` 取得 legacy 权限。新/current V2 completion 必须由 V2 decision 与完整 identity 接受，不用 V2
证据改写历史，也不让历史兼容成为新事件旁路。普通 current reducer 在任何 guard decision 前先要求
`run.completed.turnId === RuntimeState.turn.turnId`，因此上一 turn 的 V1/V2 completion 在新 turn 均无效；historical
migration reducer 也只按 event journal 的持久化顺序应用同一 turn identity 规则。

首次可纠正的 `completion.blocked` 仍可单独持久化和暴露，再进入一次 correction。第二次或其他不可纠正的 V1/V2
blocked 必须在任何对外 yield 前，由 Kernel 单事务按顺序持久化
`[completion.blocked, turn.aborted, run.error]`；因此消费者即使在看到 attempt 2 blocked 时立即停止，durable turn 已是
aborted，scheduler 为 stop，重启不能发起第三次 model call。

v22 migration snapshot 只能写回 restore 本次实际读取的 snapshot/event-tail 边界。Kernel 以 snapshot 的
event position、state revision、checksum、schema version 与该次 event query 的末尾 position 建立 restore boundary，
并通过现有 `appendEventsAndSnapshot` 事务执行 CAS；另一连接在读取后 append 或替换 snapshot 会使 CAS 冲突，Kernel
必须重新 restore/replay 后再尝试，不能把旧 migrated state 写成新的 event position。

历史 V1 executing Plan 的 `legacy_plan_recovery` 继续复用 V1 收敛上限。受限模型返回 final 而未保存 V2 Plan，
或返回包含非 `read_plan`/`write_plan` 的伪造 Tool Call，都作为当前 turn 的 completion candidate failure：
首次写入相同的 metadata-only `completion.blocked` 并允许一次纠正；同一 Plan identity 的第二次失败必须
`turn.aborted(cause=error) + run.error`，不得继续 `call_model` 直到 effect limit。受限 surface 标记只作为
Runtime response metadata 持久化，不保存 prompt、模型正文或工具参数。
白名单 Plan Tool 也不能形成无限重试旁路：只有成功的 `read_plan` 可继续下一次受限模型调用；
failed/rejected/cancelled/exhausted 的 `read_plan` 或 `write_plan`，包括 submit、identity/schema 冲突与
invalid arguments，都消费同一 correction。成功产生 V2 draft 的 `write_plan(save)` 会先退出 legacy gate。
