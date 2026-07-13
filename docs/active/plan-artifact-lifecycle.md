# Plan Artifact Lifecycle

状态：active
读取时机：修改 `write_plan`、Plan review、Task 生命周期、Runtime Context、TUI/CLI 审核展示或会话恢复时
验证：`bun test tests/runtime tests/ui-system/scenarios/plan-review.test.ts tests/ui-system/scenarios/plan-mode-policy.test.ts`

当前行为约束：

- Plan 正文写入用户级 `~/.kite-code/plans/{taskId}/{planId}/v{version}.md`；
- `save` 创建不可变版本并只返回 Artifact 元数据；
- `submit` 通过 `planId + version + structuralDigest` 读取并校验 Artifact；
- 审核事件引用 Artifact，UI/CLI 从 Artifact 读取正文；
- 同一 Task 内版本递增，新顶层目标创建新的 Task 和 Plan ID；
- 审核取消保留草稿，Artifact 缺失或 digest 不匹配不得提前清除审核 interaction；
- 旧 inline Plan 状态仍可按状态 schema 迁移；旧 RuntimeStore 格式不自动恢复，首次打开时隔离为 `.legacy`，避免污染新 Runtime。

详细实施方案见 [`2026-07-13-plan-artifact-lifecycle.md`](../space/plans/2026-07-13-plan-artifact-lifecycle.md)。
