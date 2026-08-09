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

被阻断时持久化 metadata-only `completion.blocked`（guard version、固定 reason code、next action、planning lifecycle、
correction attempt），并清除 candidate。Runtime 至多再次调用模型一次；同一 turn 的第二次错误 final 以
`turn.aborted(cause=error) + run.error` 收敛，不能循环或显示完成。新 runner 产生的 `run.completed` 绑定
`completion_guard_v1`；没有该 state 的旧 snapshot 视为零 correction attempts，但 reducer 仍重新判定当前生命周期。
