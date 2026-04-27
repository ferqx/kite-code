# 当前规则：计划状态提醒

状态：active
最后更新：2026-04-28
最后验证：2026-04-28
范围：

- `src/model/context.ts`
- `src/model/runtime-context.ts`
- `tests/context.test.ts`
- `tests/runtime-context.test.ts`

读取时机：

- 修改模型上下文组装。
- 修改运行时上下文格式。
- 修改 `read-only` / `write` 工作区访问权限的 prompt 投影。
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

静态系统提示可以包含稳定的规划澄清策略，例如何时调用 `ask_user`。具体澄清问题、选项和用户回答不属于可缓存运行时上下文；`ask_user` 的回答应作为对应 tool call 的 ToolMessage 保留在对话链中。

要求的消息顺序：

```text
SystemMessage(static agent contract)
SystemMessage(cacheable runtime context)
...compacted conversation messages
HumanMessage(synthetic graph.state.workspaceAccess reminder, only when read-only access needs projection)
HumanMessage(synthetic graph.state.plan reminder)
```

静态系统提示必须使用单一 `agent` 合约。`buildCacheableRuntimeContext` 也必须跨 `read-only` / `write` 工作区访问权限保持一致；当前访问权限这类会变化的状态应放在尾部合成用户侧提醒中，而不是写入 system prompt 前缀。没有访问权限提醒时表示默认 `write` 访问。

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
- 不要因为 `read-only` / `write` 访问权限变化生成不同的静态 system prompt。
- 不要把当前 `graph.state.workspaceAccess` 写入可缓存运行时上下文；需要投影时使用尾部合成 `HumanMessage`。
- 不要把某次 `ask_user` 的具体问题、选项或回答写入静态 system prompt 或可缓存运行时上下文。
- 不要依赖 `update_plan` ToolMessage 历史作为当前计划。
- 不要为该动态状态使用尾部 `SystemMessage`，除非某个 provider adapter 已证明它能保持语义和缓存行为。

## 测试期望

`tests/context.test.ts` 应断言：

- 单一 `agent` 使用一份静态 system prompt。
- 当前 `read-only` 工作区访问权限使用尾部合成 `HumanMessage` 投影。
- 计划状态是最后一个合成 `HumanMessage`。

`tests/runtime-context.test.ts` 应断言运行时上下文包含跨访问权限稳定的工作区访问策略，且排除当前访问权限、计划详情、上下文摘要、用户身份和已配置模型详情。
