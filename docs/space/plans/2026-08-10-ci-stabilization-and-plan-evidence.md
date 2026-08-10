# CI 稳定化与 Plan Evidence 实施计划

状态：draft
创建：2026-08-10
优先级：P0
依赖：`2026-08-09-agent-core-tool-plan-sandbox-optimization.md` 的 `ACORE-PLAN-01`、ADR-0095、当前 PR #46
设计依据：`2026-08-09-agent-core-tool-plan-sandbox-optimization.md` 的“当前执行约束：CI 稳定化与 Plan Evidence tranche”

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. 本仓库禁止生成 `docs/superpowers/`，本计划按仓库规则存放在 `docs/space/plans/`。

**目标：** 先以不弱化 CompletionGuard V1 的方式恢复 PR #46 的 Required CI，再实现 `ACORE-PLAN-02` 的 schema、evidence 与 CompletionGuard V2。

**架构：** CI 稳定化只修正因 CompletionGuard 新语义失配的 fixture、断言与文档索引；每个修正先复现原失败，不能把真实 completion blocker 改回可完成。Plan Evidence 将 PlanDocument 的 schema/revision/digest、执行证据和 verification gate 保持在 protocol/core 单向依赖中，并由 V2 guard 在 scheduler、runner、reducer 三层重用。

**技术栈：** TypeScript、Bun test、Runtime Kernel、Plan Artifact、VerificationSpec V1、GitHub Actions。

## 全局约束

- `src/core/` 不得依赖 `src/app/` 或 TUI 展示类型；protocol 类型位于 `src/protocol/`。
- `promptContractV2=false` 保持默认关闭；本 tranche 不运行真实 Provider 或正式 OpenCode Go A/B。
- CI 全绿只允许继续实现；当前 PR 在 `ACORE-RC-01`、Required CI 与 review 全部收敛前不得合并。
- CompletionGuard V1 的“未完成计划不得产生 `run.completed`”不变量不得因 fixture 修复被弱化。
- Plan evidence 只保存 schema 定义的摘要、命令退出状态、skipped/unresolved 分类和稳定 ID；不保存 prompt、工具正文、路径、命令原文或自由错误。

---

### Task 1：按 CompletionGuard 语义收口当前 CI 回归

**文件：**
- 修改：`docs/space/index.md`、`tests/docs-space.test.ts`
- 修改：`tests/session-manager.test.ts`、`tests/runtime/context-compaction.test.ts`、`tests/runtime/agent.integration.test.ts`
- 修改：`tests/e2e/local/mcp-skills-auth-scopes.test.ts`
- 修改：`tests/tui-system/scenarios/prompt-contract-v2-production.test.ts`、`tests/tui-system/scenarios/session-lifecycle.test.ts`、`tests/tui-system/scenarios/plan-review.test.ts`、`tests/tui-system/scenarios/plan-mode-policy.test.ts`、`tests/tui-system/scenarios/tool-lifecycle.test.ts`
- 参考：`src/core/runtime/completion-guard.ts`、`src/core/runtime/scheduler.ts`、`src/core/runtime/runner.ts`

**接口：**
- 消费：`decideCompletionV1(state): CompletionGuardDecision` 与 `completion.blocked` 的一次 correction 语义。
- 产出：所有 planner/Skill/TUI fixture 在预期完成前均提供已完成 Plan lifecycle，或显式提供一次 correction 后的合法下一事件；`docs/space/index.md` 完整列出新增 active 文档。

- [ ] **Step 1：逐条复现 CI 的五个 unit/E2E 与五个 PTY failure group**

  运行：

  ```bash
  bun test tests/session-manager.test.ts tests/docs-space.test.ts tests/runtime/context-compaction.test.ts tests/runtime/agent.integration.test.ts tests/e2e/local/mcp-skills-auth-scopes.test.ts
  bun run test:tui:system -- tests/tui-system/scenarios/prompt-contract-v2-production.test.ts tests/tui-system/scenarios/session-lifecycle.test.ts tests/tui-system/scenarios/plan-review.test.ts tests/tui-system/scenarios/plan-mode-policy.test.ts tests/tui-system/scenarios/tool-lifecycle.test.ts
  ```

  预期：分别看到 `planning.exited`、`completion_blocked`、第二次 model request 或 fixture response queue exhausted；记录每项的调用序列，不修改生产代码。

- [ ] **Step 2：先把 fixture 的 completion candidate 改为可观察的 V1 blocker**

  在每个受影响 unit/PTY fixture 断言一次 `completion.blocked` 后再继续，而不是只增加无条件模型响应。对于需要成功结束的 fixture，驱动完整状态顺序：

  ```ts
  plan.drafted -> plan.review_requested -> plan.approved
    -> plan.progress_updated -> plan.completed -> run.completed -> turn.completed
  ```

  对 `context-compaction.test.ts` 用真实 `tool.finished` 把 `tools.calls.tool` 置为 terminal，而不是仅清空 queue；对 `session-manager.test.ts` 在发送 `run.completed` 前 materialize `PlanningState.kind === 'completed'`；对 Skill E2E 等待 `skill.frame_closed` 且 Plan lifecycle 已完成。

- [ ] **Step 3：运行定向测试确认 fixture 在新语义下失败转绿**

  运行：

  ```bash
  bun test tests/session-manager.test.ts tests/docs-space.test.ts tests/runtime/context-compaction.test.ts tests/runtime/agent.integration.test.ts tests/e2e/local/mcp-skills-auth-scopes.test.ts
  bun run test:tui:system -- tests/tui-system/scenarios/prompt-contract-v2-production.test.ts tests/tui-system/scenarios/session-lifecycle.test.ts tests/tui-system/scenarios/plan-review.test.ts tests/tui-system/scenarios/plan-mode-policy.test.ts tests/tui-system/scenarios/tool-lifecycle.test.ts
  ```

  预期：0 failure；每个“成功完成”场景仍包含 `run.completed`，每个错误 final 场景保留 `completion.blocked` 证据。

- [ ] **Step 4：修复 active 文档索引闭包并验证**

  在 `docs/space/index.md` 的“当前规则记录”表加入 `completion-guard.md` 与 `opencode-go-journey-evaluation-policy.md`，并保持 `tests/docs-space.test.ts` 的“索引集合等于 active 文件集合”断言不变。运行：

  ```bash
  bun test tests/docs-space.test.ts
  bun run check:docs-impact
  bun run check:docs
  ```

  预期：索引测试和两项文档检查通过，且不通过删除 active 文档或缩弱集合相等断言来规避。

- [ ] **Step 5：提交 CI 稳定化**

  ```bash
  git add docs/space/index.md tests/docs-space.test.ts tests/session-manager.test.ts tests/runtime/context-compaction.test.ts tests/runtime/agent.integration.test.ts tests/e2e/local/mcp-skills-auth-scopes.test.ts tests/tui-system/scenarios
  git commit -m "test: align runtime fixtures with completion guard"
  ```

### Task 2：定义 PlanDocument V2 与最小 completion evidence

**文件：**
- 修改：`src/protocol/events.ts`、`src/core/persistence/plan-artifacts.ts`、`src/core/runtime/plan-facade.ts`
- 修改：`src/core/tools/registry/builtins/write-plan.ts`、`src/core/tools/registry/builtins/update-plan.ts`、`src/core/tools/tool-contracts.ts`
- 测试：`tests/runtime/plan-artifacts.test.ts`、`tests/runtime/plan-state.test.ts`、`tests/runtime/tool-controller.test.ts`
- 文档：`docs/active/plan-artifact-lifecycle.md`、`docs/active/plan-mode-implementation.md`

**接口：**
- 产生：`PlanDocument.planSchemaVersion = 2`，`PlanCompletionEvidenceV1`，以及保存/提交/进度更新共同使用的 `{ plan_id, version, structural_digest }` identity。
- 兼容：Artifact 的 `artifactFormatVersion=1` 保持独立；V1 artifact 只能读取，任何继续执行必须创建 V2 replan/save。

- [ ] **Step 1：写 schema 失败测试**

  在 `plan-artifacts.test.ts` 和 `plan-state.test.ts` 增加 V2 document 夹具，覆盖：body 少于 20、title/step 含换行、超过 12 steps、重复 step ID、缺少 plan identity、重复 update step、stale version/digest、terminal step 回退，以及没有 Runtime receipt 的伪造 evidence。测试 API 形状固定为：

  ```ts
  interface PlanCompletionEvidenceV1 {
    schemaVersion: 1;
    verification: Array<{ verificationId: string; outcome: 'passed' | 'waived' }>;
    execution: Array<{ toolCallId: string; outcome: 'succeeded' }>;
    skipped: Array<{ stepId: string; reasonCode: string }>;
    unresolved: Array<{ kind: 'failure' | 'approval'; referenceId: string }>;
  }
  ```

  运行：

  ```bash
  bun test tests/runtime/plan-artifacts.test.ts tests/runtime/plan-state.test.ts tests/runtime/tool-controller.test.ts
  ```

  预期：新 case 因 schema/evidence 尚未实现而失败，既有 V1 read case 继续通过。

- [ ] **Step 2：实现 V2 schema、Artifact write/read 区分与严格 transition**

  在 `src/protocol/events.ts` 定义 evidence 与 V2 字段；在 `plan-artifacts.ts` 只为 V2 write 序列化 schema version 和 metadata-only evidence，V1 parser 保持 read-only；在 `plan-facade.ts` 使用一个验证函数同时验证 save、submit、executing replan 与 `update_plan` identity。拒绝路径返回固定 code，不把正文或命令写入状态。

- [ ] **Step 3：实现 evidence 的 Runtime provenance 投影**

  在 reducer/plan facade 只从 terminal `tool.finished`、verification completed/waived 与 approved/cancelled event materialize evidence reference；`update_plan` 不接受模型给出的任意 command、path、stdout 或 success self-report。完成 Plan 前必须拥有每个 required verification 的 passed/waived reference；unresolved failure/approval 保持可判定 blocker。

- [ ] **Step 4：验证 V2 与 legacy replay 边界**

  运行：

  ```bash
  bun test tests/runtime/plan-artifacts.test.ts tests/runtime/plan-state.test.ts tests/runtime/tool-controller.test.ts tests/runtime/reducer.test.ts tests/runtime/kernel.test.ts
  bun run typecheck
  bun run check:core-boundary
  ```

  预期：V2 write/transition/evidence case 通过；legacy V1 snapshot/artifact 仍可读取但不会自动产生 V2 completion evidence。

- [ ] **Step 5：更新当前 Plan 文档并提交 schema tranche**

  说明 V2 schema、V1 artifact read-only、identity 与 privacy 边界，随后运行：

  ```bash
  bun run check:docs-impact
  bun run check:docs
  git add src/protocol/events.ts src/core/persistence/plan-artifacts.ts src/core/runtime/plan-facade.ts src/core/tools tests/runtime docs/active
  git commit -m "feat: add plan completion evidence"
  ```

### Task 3：将 CompletionGuard 升级为 V2 verification/evidence gate

**文件：**
- 修改：`src/core/runtime/completion-guard.ts`、`src/core/runtime/events.ts`、`src/core/runtime/scheduler.ts`、`src/core/runtime/runner.ts`、`src/core/runtime/reducer.ts`、`src/core/runtime/state.ts`
- 测试：`tests/runtime/completion-guard.test.ts`、`tests/runtime/task-plan-lifecycle.test.ts`、`tests/runtime/kernel.test.ts`、`tests/evals/runtime-journey-baseline.test.ts`
- 文档：`docs/active/completion-guard.md`、`docs/active/verification-governance.md`、`docs/active/six-concept-runtime-architecture.md`

**接口：**
- 消费：V2 `PlanCompletionEvidenceV1` 与现有 `VerificationRecord`。
- 产生：`COMPLETION_GUARD_V2 = 'completion_guard_v2'`、带 `{ planId, version, structuralDigest }` 的 `completion.blocked` decision identity，以及仅在 accepted V2 decision 后发出的 `run.completed`。

- [ ] **Step 1：写 V2 guard 的失败测试**

  在 `completion-guard.test.ts` 增加三类 case：executing Plan 的全部 step 完成但 required verification 未 passed/waived；verification 完成但 effect receipt 缺失；evidence 完整时 accepted。断言第二次同 identity final 仍产生 `turn.aborted + run.error`，不会发出 `run.completed`。运行：

  ```bash
  bun test tests/runtime/completion-guard.test.ts tests/runtime/task-plan-lifecycle.test.ts
  ```

  预期：V2 cases 因没有 decision version/evidence gate 而失败，V1 legacy replay case 继续通过。

- [ ] **Step 2：实现单调 V2 decision 与事件绑定**

  保留 `decideCompletionV1` 供旧 event/snapshot replay；新增 `decideCompletionV2`，只对 V2 PlanDocument 调用。scheduler、runner、reducer 根据 event 的 guard version 选择相同 decision，事件记录稳定 reason code、next action、plan identity 和 correction attempt。缺 verification 时返回 `verification_required`，缺 execution evidence 时返回 `effect_evidence_required`；不记录内容字段。

- [ ] **Step 3：驱动完整 Journey 证明 Guard 不再接受伪完成**

  扩展 `runtime-journey-baseline.test.ts` 为两条 metadata-only journey：一条在 verification/evidence 缺失时结束为 blocked terminal，另一条在 plan completed + required verification passed + evidence references 后结束为 `run.completed`。报告仍只含 event type/count 与 `contentLogged=false`。

- [ ] **Step 4：运行 Runtime、PTY 与文档验证**

  运行：

  ```bash
  bun test --max-concurrency=1 tests/runtime/completion-guard.test.ts tests/runtime/task-plan-lifecycle.test.ts tests/runtime/plan-artifacts.test.ts tests/runtime/plan-state.test.ts tests/runtime/reducer.test.ts tests/runtime/kernel.test.ts tests/evals/runtime-journey-baseline.test.ts
  bun run typecheck
  bun run check:core-boundary
  bun run check:docs-impact
  bun run check:docs
  ```

  预期：V1 replay、V2 evidence/verification gate 和 metadata privacy assertions 全部通过。

- [ ] **Step 5：提交 Guard V2，并重新执行 PR 级检查**

  ```bash
  git add src/core/runtime src/protocol/events.ts tests/runtime tests/evals docs/active docs/book docs/documentation-map.json
  git commit -m "feat: gate completion on plan evidence"
  bun test
  bun run test:tui:system
  bun run test:runtime:soak
  ```

  预期：本地 Required 等价检查全绿；推送后只观察 CI，不将 PR 标记为 ready 或合并。

## 计划自审

- CI 根因已覆盖：CompletionGuard 触发的额外 correction、非 terminal Tool 状态、Plan lifecycle 未完成、Skill frame、以及 active 文档索引遗漏。
- `ACORE-PLAN-02` 的 schema/identity/evidence 与 V2 guard 被拆为独立可验证提交；ToolOutcome、retry journal、Git broker 与 subagent 并行不在本计划范围。
- 所有新增持久字段均同时包含 legacy read/replay 边界与 metadata-only 隐私约束；没有默认开启 Prompt Contract V2 或真实模型调用的步骤。
