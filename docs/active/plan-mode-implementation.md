# Plan Mode 当前实现

状态：active

读取时机：修改 Plan Artifact、plan_review、planning/building 阶段、计划工具、计划恢复或 TUI 计划交互时。

验证：`bun test tests/runtime/agent.integration.test.ts tests/runtime/plan-actions.test.ts tests/runtime/plan-artifacts.test.ts tests/runtime/plan-persistence.test.ts tests/runtime/plan-state.test.ts tests/runtime/plan-tools.test.ts tests/runtime/task-plan-lifecycle.test.ts tests/session-manager.test.ts tests/tui-system/scenarios/plan-review.test.ts tests/tui-system/scenarios/plan-mode-policy.test.ts tests/tui-system/scenarios/session-lifecycle.test.ts`、`bun run typecheck`。

相关：ADR-0002、`plan-artifact-lifecycle.md`、`authorization.md`、`tool-gated-autonomy.md`。

## 当前架构

Plan 是 Runtime Kernel 管理的版本化 Artifact，不是模型消息中的临时字段。所有生命周期变化通过 `plan.*` Runtime events 进入 reducer；Scheduler 根据计划和交互状态产生模型调用、审核请求或执行 Effect。

ToolSpec Registry 阶段 3 已把 Plan 工具收口到
`src/core/runtime/plan-facade.ts`。Runtime Action 使用统一发射协议：成功结果携带按提交顺序排列的
`RuntimeEvent[]`，拒绝结果不得携带领域事件。`read_plan`、`write_plan` 与 `update_plan`
均只通过该门面读取状态、访问 Artifact 并产生领域事件；各 ToolSpec 只保留 Schema、契约、
effects 与结果投影。模型 Schema、Artifact 格式、事件 discriminant 与回放形状不变。

```text
用户进入 planning
  → Agent 调研并写入 Plan Artifact
  → Runtime 记录 plan revision / structural digest
  → plan_review interrupt
      ├── approve → building（accept_edits 或 auto）
      ├── revise  → 带反馈回到 planning
      └── cancel  → 终止本次计划流程
```

## 三个独立维度

- `phase`：planning/building 的能力边界；
- `interactionMode`：`accept_edits`、`auto`、`full` 的确认体验；
- `authorization`：当前 thread 的具体执行授权。

三者不能互相隐式替代。批准计划不会自动授予 `full_access`；授权也不能绕过 planning 的只读边界。

## Plan Artifact 不变量

1. Plan ID、version 和 structural digest 必须与审核对象一致。
2. 纯进度更新不应触发新的结构审核；目标、说明或步骤结构变化必须产生新 revision。
3. 审核后的内容不得通过 transcript 或 UI 状态静默替换。
4. Plan Artifact 写入失败时不得宣布计划已保存或已批准。
5. 恢复和 fork 必须从 Runtime Store/Artifact Store 重建计划事实。

## 工具与策略

Planning 允许读取、搜索、研究、提问、计划维护和只读 Subagent；写文件、非只读 Shell、实现型 Subagent 和权限提升不得执行。所有决定由 Runtime Policy 与 Tool Controller 执行，不由 TUI 或工具描述决定，也不能通过用户审批提升权限绕过 phase 边界。

非只读 Shell 在 planning 中仍按 fail-closed 终结该 Tool Call，但 Runtime 将这类结果分类为 `phase_deferred`，而不是通用 `policy_denied`。模型收到的成对 Tool Result 明确包含 `deferred=true`、`until_phase=building`、原始参数和下一步约束：当前阶段不得重试或请求审批，应把命令保留到方案的执行/验证部分，待方案批准进入 building 后重新调用。

`write_file`、`edit_file`、实现型 Subagent，以及其他可修改工作区或外部状态的能力，在 planning 中越界时使用 `phase_denied` 硬拒绝，不进入审批。System Prompt 与各工具契约必须先主动要求模型在 planning 中只描述预期变更、不得调用编辑或副作用工具；Runtime 兜底结果再明确返回“工具未运行、当前阶段不可审批、把实现意图写入 Plan、方案批准后执行”。TUI 对文件编辑拒绝保留一条面向用户的只读边界说明，例如 `Plan mode is read-only. No file was written...`，但不把未获准执行的调用物化为 Tool Card，也不得只显示缺少下一步的通用 `Rejected ...`。破坏性 Shell 仍使用硬安全策略拒绝。

TUI 不把 `phase_deferred` 物化为 Bash 工具卡、失败提示或 deferred command 行；它只消费并清除对应的离屏 `tool.queued` 元数据。该调用属于模型在错误阶段产生并由 Runtime 内部纠正的无效意图，不是面向用户的执行事实，也不是可恢复执行队列。需要执行的命令应由模型写入 Plan 的执行/验证章节；批准进入 building 后再重新发起，并经过正常策略与审批。实时与 replay 必须保持同样的无展示结果。

## 用户交互

`plan_review_decision` 是结构化 UserAction，包含 approve/revise/cancel。批准时明确选择下一 interaction mode；revise 必须携带反馈。Cancel 与 Esc 都表示撤销本次方案执行授权：Runtime 保留 draft，取消方案工具及所有未终结 sibling，写入 `turn.aborted(cause=user)` 并立即结束当前 turn，不再调用模型或进入执行阶段。TUI 继续展示已经持久化的 draft，但不添加本地 `Plan declined` 消息；取消终态完全由 Runtime events 投影，保证实时与 replay 一致。Ask-user 与 plan review 以 interaction/toolCall ID 精确关联，不能依赖展示文本匹配；`ask_user` 拒答仍是可继续当前 turn 的普通 Tool Result，不使用方案授权取消语义。

TUI 新建会话时，新 Runtime 与新展示快照必须统一从 `building` 开始，并清空旧会话的 pending plan；不得把离开会话的 `planning` 投影复制到新会话。历史会话切回时仍恢复该会话自己的持久化状态。该约束保证 InputLine 因会话切换重挂载后，Shift+Tab 进入/退出 Plan Mode 仍操作同一个 Runtime 事实，而不是无法退出的 UI-only 状态。

Shift+Tab 在尚无输入时可以创建 `planning_empty` 占位 Task，但用户提交首个 prompt 后必须先用 `task.cancelled` 明确收尾该占位，再以真实 prompt 作为 `userGoal` 启动正式 Task；不得直接复用空目标 Task，避免 Plan Artifact、日志和恢复状态丢失任务目标。

在同一 TUI 会话内，用户通过 Shift+Tab 选择的 Plan Mode 是跨普通对话保持的输入策略：每次提交普通 prompt 都必须把当前 `phase` 显式传给新 Runtime Task，不能因上一轮 `run.completed` 而静默退回 building。`run.completed` 已结束上一 Core Task 后，用户再按 Shift+Tab 退出时没有活动 Task 可取消；此时 TUI 只把自身已过期的 planning 投影对齐到 Runtime 已有的 building 事实，不伪造 `planning.exited` 或 `task.cancelled` 事件。若仍有 plan review 等活动交互，则不得使用该本地对齐绕过交互取消语义。
