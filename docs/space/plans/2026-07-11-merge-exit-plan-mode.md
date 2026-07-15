# 合并 `exit_plan_mode` 到 `write_plan`

状态：archived（已实施；当前规则见 `docs/active/plan-mode-implementation.md`）
范围：`src/core/`、`src/app/tui/`、`tests/`
读取时机：修改 plan 工具定义、tool-controller、actions、tool-contracts 时必读。

> 设计讨论：[[plan-mode-implementation]] — Plan Mode 功能实现文档

---

## 动机

当前 Plan Mode v2 使用两个独立工具来表达「保存草稿」和「提交审核」：

```
write_plan      → 保存草稿（可多次迭代）
exit_plan_mode  → 提交审核（需传入 plan_id/version/digest）
```

这导致了以下问题：

1. **无意义的参数转发**：`exit_plan_mode` 的三个参数（`plan_id`、`expected_version`、`expected_digest`）全部来自 `write_plan` 返回值，模型只是原封不动搬运，中间任何环节出错（planId 不一致、版本过期）都会导致 `Plan mismatch` 错误。

2. **Bug 风险**：`write_plan` 的 `plan.drafted` 事件和 reducer 独立生成 `planId`，导致 `exit_plan_mode` 校验时 `planId` 不匹配。（已修复，但本质原因是两段式设计）

3. **E2E 测试不可行**：mock model 无法预测 `write_plan` 动态生成的 `planId`，导致 `exit_plan_mode` 完整链路无法用 mock 测试。

4. **多一轮模型调用**：`write_plan` → 模型读结果 → `exit_plan_mode` 增加了不必要的往返。

## 方案

将 `write_plan` 和 `exit_plan_mode` 合并为单一工具 `write_plan`，通过 `action` 字段区分语义：

```ts
write_plan({
  title:            string;
  body_markdown:    string;
  steps:            Array<{ id: string; title: string }>;
  expected_version?: number;   // CAS，可选
  action:           'save' | 'submit';
});
```

### 行为对照

| `action` | 保存 Plan | 触发审核 | 模型可继续规划 | 对应事件 |
|----------|----------|---------|:---:|---------|
| `save` | 是 | 否 | 是 | `plan.drafted` → `tool.finished` |
| `submit` | 是 | 是 | 否，等待用户决策 | `plan.drafted` → `plan.review_requested`（无 `tool.finished`） |

### `submit` 的 ToolMessage 生命周期

`submit` 的 ToolMessage 不能立即完成——需要等到用户决策后，将审批结果作为该工具调用的最终结果返回模型：

```
批准:   tool.finished(write_plan, stdout={ decision: "approved", ... })
修订:   tool.finished(write_plan, stdout={ decision: "revise", feedback: "..." })
取消:   tool.finished(write_plan, stdout={ decision: "cancelled", reason: "..." })
```

这与当前 `exit_plan_mode` 在 `actions.ts` 中的处理方式完全一致，只需将 `name: 'exit_plan_mode'` 改为 `name: 'write_plan'`。

### 删除的内容

- `exit_plan_mode` 工具定义（`definitions.ts`）
- `exit_plan_mode` PendingToolRequest 分支（`tool-requests.ts`）
- `exit_plan_mode` handler（`tool-controller.ts:161-231`）
- `exit_plan_mode` 审批策略（`approval-policy.ts`）
- `exit_plan_mode` tool contract（`tool-contracts.ts`）
- 运行时上下文中的 `exit_plan_mode_allowed` 策略提示

### 版本号规则

`submit` 只增加一次版本：

```
write_plan(action=submit)
  → PlanDocument(version = oldVersion + 1)
  → plan.drafted(document v3)
  → plan.review_requested(reference v3, 不产生新版本)
```

用户要求修订时版本不增加：

```
awaiting_review v3 → revision_requested → planning_draft v3
```

下一次 `write_plan`（save 或 submit）才变为 v4。

### Interaction Barrier

`write_plan(action='submit')` 创建 interaction 后，Scheduler 停止处理同一模型消息中的后续 tool calls，取消 sibling calls。这与当前 `exit_plan_mode` 的 barrier 行为一致。

### E2E 测试恢复

合并后，E2E 测试不再需要预测动态 `planId`。mock model 可以直接调用 `write_plan(action='submit')` 来触发完整的 plan_review 流程，恢复 plan-review.test.ts 中的所有测试场景（approve/manual/revise/cancel/Esc）。

---

## 文件变更清单

| 文件 | 变更类型 | 说明 |
|------|---------|------|
| `src/core/tools/definitions.ts` | 修改+删除 | `write_plan` schema 新增 `action`；删除 `createExitPlanModeTool` |
| `src/core/tools/tool-contracts.ts` | 修改+删除 | 更新 `write_plan` 契约，删除 `exit_plan_mode` 契约 |
| `src/core/harness/tool-requests.ts` | 修改+删除 | `write_plan` args 新增 `action`；删除 `exit_plan_mode` 分支 |
| `src/core/controllers/tool-controller.ts` | 修改+删除 | `write_plan` handler 新增 `submit` 分支；删除 `exit_plan_mode` handler |
| `src/core/policies/approval-policy.ts` | 删除 | 删除 `exit_plan_mode` 审批策略条目 |
| `src/core/runtime/actions.ts` | 修改 | `exit_plan_mode` → `write_plan` |
| `src/core/runtime/events.ts` | 不变 | `plan.review_requested` 等事件保持不变 |
| `src/core/runtime/reducer.ts` | 不变 | 事件处理保持不变 |
| `src/core/runtime/scheduler.ts` | 不变 | barrier 由 interaction 状态驱动，不依赖工具名 |
| `src/core/model/runtime-context.ts` | 修改 | `exit_plan_mode_allowed` → `write_plan_submit_allowed` |
| `src/app/tui/render-utils.ts` | 删除 | 删除 `exit_plan_mode` 渲染条目 |
| `src/app/tui/run-status.ts` | 删除 | 删除 `exit_plan_mode` verb |
| `src/app/tui/reducers/handleEvent.ts` | 修改 | `exit_plan_mode` → `write_plan` |
| `src/app/tui/reducers/agentReducer.ts` | 修改 | `exit_plan_mode` → `write_plan` |
| `src/app/tui/components/ToolCardBlock.tsx` | 修改 | `exit_plan_mode` 相关逻辑简化 |
| `tests/tool-definitions.test.ts` | 修改 | 删除 `exit_plan_mode` schema 测试，更新 `write_plan` 测试 |
| `tests/runtime/tool-controller.test.ts` | 修改 | 删除 `exit_plan_mode` 测试，新增 `submit` 测试 |
| `tests/runtime/plan-actions.test.ts` | 修改 | `exit_plan_mode` → `write_plan` |
| `tests/runtime/plan-state.test.ts` | 修改 | 更新测试描述 |
| `tests/runtime/plan-tools.test.ts` | 修改 | 删除 `exit_plan_mode` 相关测试 |
| `tests/runtime/plan-transcript.test.ts` | 修改 | `exit_plan_mode` → `write_plan` |
| `tests/runtime/tool-barrier.test.ts` | 修改 | 更新 barrier 测试 |
| `tests/runtime/agent.integration.test.ts` | 修改 | 更新集成测试 |
| `tests/tui-system/scenarios/plan-review.test.ts` | 重写 | 恢复完整 approve/manual/revise/cancel 测试 |
| `tests/tui-system/scenarios/tool-lifecycle.test.ts` | 修改 | 恢复 plan_review 完整生命周期测试 |
| `tests/runtime-context.test.ts` | 修改 | `exit_plan_mode_allowed` → `write_plan_submit_allowed` |

---

## 实施步骤

### Phase 1: 核心逻辑

1. 更新 `write_plan` tool schema（`definitions.ts`）：新增 `action` 字段
2. 更新 `write_plan` tool contract（`tool-contracts.ts`）
3. 更新 `tool-requests.ts`：`write_plan` args 新增 `action`
4. 更新 `tool-controller.ts`：`write_plan` handler 新增 `submit` 分支；删除 `exit_plan_mode` handler
5. 更新 `approval-policy.ts`：删除 `exit_plan_mode` 条目
6. 更新 `actions.ts`：`exit_plan_mode` → `write_plan`
7. 更新 `runtime-context.ts`：策略提示文字

### Phase 2: 清理 v1 残余

8. 删除 `exit_plan_mode` 工具定义、contract、tool-request 分支
9. 清理 TUI 渲染器中的 `exit_plan_mode` 引用

### Phase 3: 测试

10. 更新所有单元测试
11. 恢复 E2E plan_review 完整测试

### Phase 4: 验证

12. `bun run typecheck`
13. `bun run test`
14. `bun run test:e2e`
