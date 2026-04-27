# 完成记录：移除内部账本

日期：2026-04-26
状态：completed
相关 active 规则：`../active/tool-gated-autonomy.md`
相关参考：

- `../../references/opencode-codex-plan-handling.md`

## 变更

移除内部 evidence/progress 账本机制。

实现形态：

- 移除 `src/harness/evidence.ts`。
- 移除 `src/harness/progress.ts`。
- 移除 `state.evidence` 和 `state.progress`。
- 移除 stagnant watchdog 和重复工具 doom-loop guard 逻辑。
- 移除 `AgentEvidence`、`AgentHeartbeat` 和 `AgentProgressLedger` 类型。
- 保留 tool result message 作为模型可见的工具执行记录。
- 保留 approval 和 plan-mode tool gating 作为强制安全边界。

## 理由

移除最终答案 stop-check 后，evidence/progress 账本不再服务清晰的 harness 边界。它们剩余的作用是进度推断，但这会重复模型判断，并偏离 Codex 和 Opencode 使用的工具边界设计。

harness 应在工具边界强制危险操作检查，其余模型行为应由指令、工具结果和图 recursion limit 共同约束。

## 验证

已验证：

```bash
bun test tests/graph.test.ts tests/context.test.ts tests/runtime-context.test.ts
bun run typecheck
```
