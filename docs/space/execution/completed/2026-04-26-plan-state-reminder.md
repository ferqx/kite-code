# 完成记录：计划状态提醒投影

日期：2026-04-26
状态：completed
相关 active 规则：`../active/plan-state-reminder.md`
相关理解记录：

- `../../understanding/2026-04-26-plan-state-context-projection.md`
- `../../references/opencode-codex-plan-handling.md`

## 变更

将 `graph.state.plan` 从运行时上下文中移出，改为尾部合成用户侧运行时状态提醒。

实现形态：

- `src/model/context.ts` 在压缩后的对话消息之后追加 `HumanMessage(formatPlanStateReminder(plan))`。
- `src/model/runtime-context.ts` 将提醒格式化为 `<runtime-state source="graph.state.plan">`。
- evidence/progress 账本后续已移除；现在 tool result 和 graph state 是持久运行时记录。
- `tests/context.test.ts` 固定尾部合成用户侧消息形态。
- `tests/runtime-context.test.ts` 固定动态计划状态不得进入运行时上下文。

## 理由

这样可以保持 provider-agnostic prompt 语义：

- 静态规则仍保留在 system message 中。
- 动态计划状态不依赖 provider-specific system message 处理。
- 计划状态出现在稳定上下文之后，减少对 prefix/KV cache 的干扰。
- `graph.state.plan` 仍是事实来源。

## 验证

已验证：

```bash
bun test tests/context.test.ts tests/runtime-context.test.ts
bun run typecheck
```
