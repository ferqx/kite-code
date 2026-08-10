# Runtime CompletionGuard V1

状态：active
读取时机：修改 `run.completed`、final 文本、Plan lifecycle、scheduler/runner/reducer 终态或 Task 完成投影时。
验证：`bun test tests/runtime/completion-guard.test.ts tests/runtime/task-plan-lifecycle.test.ts tests/runtime/kernel.test.ts`、`bun run typecheck`。
相关：ADR-0095、`plan-mode-implementation.md`、`failure-classification.md`。

模型的无工具 final 文本只是 completion candidate。`CompletionGuard V1` 是 Core-only 纯函数，scheduler 在选择
`emit_final` 前、runner 在持久化前、reducer 在接收 `run.completed` 时都重新使用同一个判定；因此直接注入
`run.completed` 不能把未完成 Task 标为 `completed`。

V1 只使用已有 canonical state：非终结 Tool、pending interaction、suspended subagent、unknown Capability invocation、
active Skill 与 Plan lifecycle。`building_without_plan` 和 `completed` 可通过；`planning_empty` 要求 save，draft 要求 submit，
awaiting review 要求等待审核，executing 要求先发 `plan.completed`，cancelled 永远不是成功完成。verification 与
unresolved typed tool failure 将在后续 decision version 引入，V1 不猜测尚不存在的证据。

PlanDocument V2 的 completion evidence/replay 门禁额外拒绝任何 pending interaction 或 approval，不限工具是否
具有副作用。因工作区外读取而等待审批的 `sideEffect=false` call 也属于 unresolved blocker；facade 和 reducer
必须使用相同 blocker，不能形成 `planning=completed` 与 `interactions=awaiting_tool_approval` 并存的状态。

被阻断时持久化 metadata-only `completion.blocked`（guard version、固定 reason code、next action、planning lifecycle、
correction attempt），并清除 candidate。Runtime 至多再次调用模型一次；同一 turn 的第二次错误 final 以
`turn.aborted(cause=error) + run.error` 收敛，不能循环或显示完成。新 runner 产生的 `run.completed` 绑定
`completion_guard_v1`；没有该 state 的旧 snapshot 视为零 correction attempts，但 reducer 仍重新判定当前生命周期。

历史 V1 executing Plan 的 `legacy_plan_recovery` 也复用该收敛上限。受限模型返回 final 而未保存 V2 Plan，
或返回包含非 `read_plan`/`write_plan` 的伪造 Tool Call，都作为当前 turn 的 completion candidate failure：
首次写入相同的 metadata-only `completion.blocked` 并允许一次纠正；同一 Plan identity 的第二次失败必须
`turn.aborted(cause=error) + run.error`，不得继续 `call_model` 直到 effect limit。受限 surface 标记只作为
Runtime response metadata 持久化，不保存 prompt、模型正文或工具参数。
白名单 Plan Tool 也不能形成无限重试旁路：只有成功的 `read_plan` 可继续下一次受限模型调用；
failed/rejected/cancelled/exhausted 的 `read_plan` 或 `write_plan`，包括 submit、identity/schema 冲突与
invalid arguments，都消费同一 correction。成功产生 V2 draft 的 `write_plan(save)` 会先退出 legacy gate。
