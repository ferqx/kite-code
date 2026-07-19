# Plan Mode 当前实现

状态：active

读取时机：修改 Plan Artifact、plan_review、planning/building 阶段、计划工具、计划恢复或 TUI 计划交互时。

验证：`bun test tests/runtime/plan-actions.test.ts tests/runtime/plan-artifacts.test.ts tests/runtime/plan-persistence.test.ts tests/runtime/plan-state.test.ts tests/runtime/plan-tools.test.ts tests/runtime/task-plan-lifecycle.test.ts tests/session-manager.test.ts tests/tui-system/scenarios/plan-review.test.ts tests/tui-system/scenarios/plan-mode-policy.test.ts`、`bun run typecheck`。

相关：ADR-0002、`plan-artifact-lifecycle.md`、`authorization.md`、`tool-gated-autonomy.md`。

## 当前架构

Plan 是 Runtime Kernel 管理的版本化 Artifact，不是模型消息中的临时字段。所有生命周期变化通过 `plan.*` Runtime events 进入 reducer；Scheduler 根据计划和交互状态产生模型调用、审核请求或执行 Effect。

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

Planning 允许读取、搜索、研究、提问、计划维护和只读 Subagent；写文件、非只读 Shell、实现型 Subagent 和权限提升必须被策略拒绝。所有决定由 Runtime Policy 与 Tool Controller 执行，不由 TUI 或工具描述决定。

## 用户交互

`plan_review_decision` 是结构化 UserAction，包含 approve/revise/cancel。批准时明确选择下一 interaction mode；revise 必须携带反馈。Ask-user 与 plan review 以 interaction/toolCall ID 精确关联，不能依赖展示文本匹配。
