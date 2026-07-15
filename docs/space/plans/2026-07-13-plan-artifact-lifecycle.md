# Plan Artifact 文件化、版本化审核与 Task 隔离实施方案

状态：archived（已实施；当前规则见 `docs/active/plan-artifact-lifecycle.md`）
创建日期：2026-07-13

## 目标

参考 Claude Code 的方案生命周期，将 Plan 正文保存为用户级不可变 Artifact，再通过 Artifact 引用发起审核。解决以下问题：

- `save` 返回完整正文导致模型上下文重复膨胀；
- 保存草稿后模型重复生成 Plan；
- 同一方案 v1/v2/v3/v4 与新功能方案 v1 混用；
- 审核展示内容与实际持久化方案不一致；
- 重启后无法恢复准确的方案文件、版本和审核状态。

## 生命周期

```text
write_plan(save, full document)
  -> ~/.kite-code/plans/{taskId}/{planId}/v{version}.md
  -> return artifact metadata only

write_plan(submit, planId/version/digest)
  -> read and validate Artifact
  -> plan.review_requested
  -> UI/CLI reads Artifact and waits for approval
```

`save` 创建版本，`submit` 不创建版本。审核批准、修改请求和取消审核都关闭原始 submit 工具调用，但取消审核保留当前草稿。

同一个 Task 内版本递增：

```text
Task A / Plan P1: v1 -> v2 -> v3 -> v4
Task B / Plan P2: v1
```

新的顶层用户目标创建新的 Task 和 Plan ID，不继承旧 Task 的 Plan、executionMode、sideEffectsStarted 或 pending review。

## Artifact 约束

Artifact 路径：

```text
~/.kite-code/plans/{taskId}/{planId}/v{version}.md
```

- 使用现有 `KITE_CODE_HOME` 路径解析；
- 文件名只使用 Runtime 生成的 ID 和版本号；
- 文件不可覆盖，使用临时文件加原子 rename；
- Runtime 事件保存 `artifactId`、相对路径、版本、digest 和大小，不重复保存正文；
- 缺失文件或 digest 不匹配时拒绝 submit，不能创建审核交互；
- 旧快照和旧事件继续支持 inline plan，迁移时尽可能物化为 Artifact。

## 工具结果

`save` 返回：

```json
{
  "ok": true,
  "status": "draft_saved",
  "task_id": "task-uuid",
  "plan_id": "plan-uuid",
  "version": 1,
  "artifact": {
    "artifact_id": "plan-uuid:v1",
    "file_name": "v1.md",
    "path": "~/.kite-code/plans/task-uuid/plan-uuid/v1.md",
    "structural_digest": "sha256...",
    "byte_length": 8421
  },
  "next_action": "submit"
}
```

`submit` 只接受 Artifact 引用：

```json
{
  "action": "submit",
  "plan_id": "plan-uuid",
  "version": 1,
  "structural_digest": "sha256..."
}
```

用户审核后的 `tool.finished` 统一返回 `approved`、`revision_requested` 或 `review_cancelled`，不返回完整正文。

## 上下文策略

- save 的工具结果不回显完整正文；
- UI/CLI 审核时由 Artifact Store 读取正文；
- Plan 修订时通过受控的 `read_plan(planId, version)` 或 Runtime Context 按需读取；
- 执行阶段只注入 active Task 当前批准版本；
- 历史 Task 和已替代版本只保留元数据，不注入模型执行上下文。

## 实施顺序

1. Artifact Store、用户路径和原子写入；
2. Artifact 引用、版本元数据和 Runtime migration；
3. `write_plan(save|submit)` 两阶段协议和幂等校验；
4. Runtime review payload、TUI/CLI 文件读取和失败恢复；
5. Task 上下文隔离、Prompt 和 `read_plan`；
6. 回归测试、旧快照迁移测试和完整验证。

## 验收标准

- save v1 只产生一个文件且不返回正文；
- submit v1 读取同一文件，不产生 v2；
- revise 后产生 v2，v1 保留；
- Plan A 完成后新模块从 Plan B v1 开始；
- 重启后恢复相同 taskId、planId、version、digest 和 interactionId；
- Artifact 缺失、路径越界和 digest 冲突不会清除审核状态；
- Kernel、TUI、CLI 展示同一个 Artifact 内容。
