# 当前规则：计划状态提醒

状态：active
最后更新：2026-04-27
最后验证：2026-04-27
范围：

- `src/model/context.ts`
- `src/model/runtime-context.ts`
- `tests/context.test.ts`
- `tests/runtime-context.test.ts`

读取时机：

- 修改模型上下文组装。
- 修改运行时上下文格式。
- 修改 plan 模式或 builder 模式的 prompt 投影。
- 修改缓存敏感的消息顺序。

相关：

- `../../understanding/2026-04-26-plan-state-context-projection.md`
- `../completed/2026-04-26-plan-state-reminder.md`
- `../../references/opencode-codex-plan-handling.md`

验证：

- `bun test tests/context.test.ts tests/runtime-context.test.ts`
- `bun run typecheck`

## 规则

`graph.state.plan` 必须作为尾部合成用户侧运行时状态提醒进行投影。

要求的消息顺序：

```text
SystemMessage(static agent contract)
SystemMessage(cacheable runtime context)
...compacted conversation messages
HumanMessage(synthetic graph.state.plan reminder)
```

计划提醒必须：

- 由当前 `graph.state.plan` 生成。
- 出现在压缩后的对话消息之后。
- 使用 `HumanMessage`，不能使用 `SystemMessage`。
- 包含类似 `<runtime-state source="graph.state.plan">` 的标记。
- 明确说明该消息由 harness 生成，不是用户输入。
- 不进入静态 system prompt，也不进入可缓存运行时上下文。

## 不要做

- 不要把计划状态移回静态 system prompt。
- 不要把计划状态放入 `buildCacheableRuntimeContext`。
- 不要依赖 `update_plan` ToolMessage 历史作为当前计划。
- 不要为该动态状态使用尾部 `SystemMessage`，除非某个 provider adapter 已证明它能保持语义和缓存行为。

## 测试期望

`tests/context.test.ts` 应断言计划状态是最后一个合成 `HumanMessage`。

`tests/runtime-context.test.ts` 应断言运行时上下文包含按模式限定的工具策略，但排除计划详情、上下文摘要、用户身份和已配置模型详情。
