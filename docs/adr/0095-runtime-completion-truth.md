# ADR-0095：Runtime CompletionGuard 统一任务与计划完成真值

状态：accepted
日期：2026-08-09
决策者：github:@ferqx
关联：ADR-0001、ADR-0002、ADR-0008

## 背景

当前 Runtime 可以在模型写出 final 后直接结束 run；scheduler 没有同时检查 `PlanningState`，runner 会持久化
`run.completed`，reducer 随后把活动 Task 标记为 completed。结果是仍处于 `planning_draft`、
`replanning_draft` 或 `executing` 且存在未完成步骤的任务，也可能被记录并展示为完成。

Prompt 不能成为完成语义的唯一防线。模型可能漏调 `write_plan`、`update_plan` 或 `plan.completed`，测试模型也可能
直接输出 final；只依靠工具描述会把状态机错误隐藏成模型质量波动，并使 replay、TUI 和运行记录出现不同真值。

此外，Plan schema、artifact 校验、Runtime transition 与 prompt contract 目前存在约束漂移；进度更新缺少版本绑定，
恢复后的 subagent 终态也可能在 event、result 与 TUI 中投影不一致。

## 决策

1. 模型无工具的最终文本只是 completion candidate，不是 durable completion truth，也不能在 guard 接受前作为 TUI 的真正
   final。Core Runtime 引入纯 `CompletionGuard`；scheduler、runner 持久化边界和 reducer 使用同一 versioned decision。
2. guard 的目标规则先检查 task-wide blockers，再检查 `PlanningState`。任何未终结 tool call、running/suspended
   subagent、unknown external invocation、required verification 缺失、未解决 terminal tool failure，或 effect 后缺少最低
   验证事实，都会阻止完成；`building_without_plan` 不豁免。实现按 decision version 单调增强：V1 只使用当前已有 canonical
   state 可可靠判定的 lifecycle、未终结调用/子 Agent 与交互阻断项；Plan evidence 落地后加入 verification/effect gate；
   ADR-0096 recovery lineage 落地后再加入 unresolved-failure gate。旧事件严格按其记录的 decision version replay，不能用
   尚不存在的证据回填或猜测。
3. draft state 增加显式 `draftDisposition = needs_save | saved` 与 revision identity，或拆成等价的精确 union variant。
   guard 不从可选 feedback 猜 next action。Plan lifecycle 决策矩阵为：
   - `building_without_plan`：task-wide blockers 清零后可成功完成；
   - `planning_empty`：blocked → save；
   - `planning_draft/replanning_draft + needs_save`：blocked → save revision；
   - `planning_draft/replanning_draft + saved`：blocked → submit；
   - `awaiting_review`：不调用模型、不完成，只等待 review；
   - `executing`：步骤和验证满足后仍需先产生 `plan.completed`；
   - `completed`：通过 Plan lifecycle gate；
   - `cancelled`：只能进入 cancelled/aborted 非成功终态，永远不能产生 `run.completed`。
4. blocked 闭环为：持久化 `completion.blocked` → 消费并清除 completion candidate → 把 typed reason/next action 注入
   下一次模型请求 → 最多一次 completion correction。相同 decision identity 再次失败后，产生显式非成功 blocked terminal，
   不继续自动调用模型。事件至少包含 decision version、reason code、planning lifecycle、plan ID/revision/digest、next action
   和 correction attempt。
5. reducer 对带新 decision version 的非法 `run.completed` fail closed。新 `run.completed` 必须引用 guard decision identity。
   旧 Store 通过显式 snapshot/event migration materialize legacy terminal state，保持历史可读但不伪造新完成证据；不得让
   新 reducer 临时忽略旧事件而改变 active Task 归属。
6. 建立一个共享 `PlanDocumentSchema`，明确区分 `planSchemaVersion`、`artifactFormatVersion` 与 `planRevision`。新 save
   只写新 schema；legacy artifact 可只读，不合法 legacy plan 若要继续执行必须显式 replan/save，不静默修复。新 schema
   冻结为：title 最多 120 字且单行，body 至少 20 字，1–12 个唯一 step ID，step title 最多 160 字且单行。
7. `update_plan` 必须绑定 `plan_id`、完整 revision 与 structural digest。approval Tool Result 顶层返回同名完整字段；
   runtime context 与 contract 使用一致命名，正常进度不要求额外 `read_plan`。进度矩阵为 `pending → in_progress |
   completed | skipped`、`in_progress → completed | skipped`，completed/skipped 为终态；恢复它们必须结构 replan。同一调用
   不得重复 step ID，全部 skipped 不能成功，completion evidence 必须来自 Runtime execution records 而非模型自报。
8. subagent lifecycle 分为 `running | suspended | terminal`；等待父 Runtime approval 的 blocked 是 suspended，不是终态。
   terminal outcome 为 `completed | completed_with_recoveries | failed | cancelled`；`completed_with_recoveries` 只作为
   task/subagent evidence，顶层成功仍使用 `run.completed`。Plan lifecycle 不与 subagent 状态机共用 union。

## 备选方案

1. **只修改 system prompt**：拒绝。无法约束测试模型、provider 偏差、恢复路径或 reducer replay。
2. **只在 TUI 隐藏错误完成状态**：拒绝。会让持久化事实继续错误，并使其他客户端与 TUI 不一致。
3. **只在 scheduler 增加条件**：拒绝。恢复、旧事件或未来调用方仍可能越过 scheduler；Kernel/reducer 必须保留最终防线。
4. **遇到未完成计划时自动补齐步骤**：拒绝。Runtime 不应伪造执行或验证事实。

## 影响

- 未提交计划、待 review 或未执行完的计划不再被 final 文本提前结束；相同错误 final 也不会形成 correction loop。
- 模型可以收到短、稳定且可执行的恢复指引，但完成判定不再依赖模型是否遵循提示。
- 需要迁移 Plan schema、Runtime event 与工具参数；旧持久化状态通过显式兼容读取或 migration 处理，不静默改写。
- production TUI E2E 必须覆盖完整 save → submit → review → approve → execute → verify → complete → final 链路。

## 回滚

实现阶段保留旧读取兼容；但不得通过关闭 reducer 防线回滚。若新 guard 误阻断，回滚到最近已验证的 decision version
或针对明确 state 修正规则，并保留 `completion.blocked` 观测证据。任何临时兼容开关必须默认 fail closed、限定候选
版本并有删除条件。
