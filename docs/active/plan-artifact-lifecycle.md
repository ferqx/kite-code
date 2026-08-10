# Plan Artifact Lifecycle

状态：active
读取时机：修改 `write_plan`、Plan review、Task 生命周期、Runtime Context、TUI/CLI 审核展示或会话恢复时
验证：`bun test tests/runtime tests/tui-system/scenarios/plan-review.test.ts tests/tui-system/scenarios/plan-mode-policy.test.ts`

当前行为约束：

- Plan 正文写入用户级 `~/.kite-code/plans/{taskId}/{planId}/v{version}.md`；
- 新写入的 Plan 使用 `PlanDocument.planSchemaVersion=2`，而 Artifact 容器格式仍独立保持
  `artifactFormatVersion=1`；两者不得互相推导或同步递增；
- `save` 创建不可变版本并只返回 Artifact 元数据；
- 首次 `save` 由 Runtime 创建 identity；后续 `save`、`submit`、executing replan 和
  `update_plan` 都必须携带并精确匹配 `{ plan_id, version, structural_digest }`；缺失与过期
  identity 分别稳定拒绝为 `plan_identity_required` 和 `plan_identity_mismatch`；
- 审核事件引用 Artifact，UI/CLI 从 Artifact 读取正文；
- Artifact write/read 边界会在运行时验证 step ID/title 为字符串、status 属于固定枚举、note 缺失或为
  字符串，并重新计算 structural digest；不能依赖 TypeScript 静态类型接受未知 JSON；
- 同一 Task 内版本递增，新顶层目标创建新的 Task 和 Plan ID；
- 审核取消保留草稿，Artifact 缺失或 digest 不匹配不得提前清除审核 interaction；
- V2 Artifact metadata 可保存 `PlanCompletionEvidenceV1`，但只允许 verification ID/outcome、
  terminal tool-call ID/outcome、skipped step ID/reason code 和 unresolved kind/reference ID；不得保存
  prompt/tool body、路径、命令、stdout 或任意错误正文；
- 缺少 `planSchemaVersion` 的 V1 Artifact/inline snapshot 只允许读取与 replay，不自动生成 V2
  evidence，也不能直接 `update_plan`；继续执行必须用当前 V1 identity 创建新的 V2 replan/save；
- 旧 RuntimeStore 格式不自动恢复，首次打开时隔离为 `.legacy`，避免污染新 Runtime。

详细实施方案见 [`2026-07-13-plan-artifact-lifecycle.md`](../space/plans/2026-07-13-plan-artifact-lifecycle.md)。
