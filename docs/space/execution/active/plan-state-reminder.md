# 当前规则：计划状态提醒

状态：active
最后更新：2026-05-01
最后验证：2026-05-01
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

动态运行时状态必须作为尾部合成 `HumanMessage` 提醒进行投影；当前包括 `graph.state.workspaceAccess` 和 `graph.state.plan`。

静态系统提示可以包含稳定的规划澄清策略，例如何时调用 `ask_user`。具体澄清问题、选项和用户回答不属于可缓存运行时上下文；`ask_user` 的回答应作为对应 tool call 的 ToolMessage 保留在对话链中。

要求的消息顺序：

```text
SystemMessage(static agent contract)
SystemMessage(cacheable runtime context)
...compacted conversation messages
HumanMessage(synthetic graph.state.workspaceAccess reminder, only when read-only access needs projection)
HumanMessage(synthetic graph.state.plan reminder)
```

静态系统提示必须使用单一 `agent` 合约。`buildCacheableRuntimeContext` 也必须跨 `read-only` / `write` 工作区访问权限保持一致；当前访问权限这类可能变化的状态应放在尾部合成 `HumanMessage` 中，而不是写入可缓存 system prompt 前缀。没有访问权限提醒时表示默认 `write` 访问。

合成运行时状态必须放在压缩后的对话消息之后。原因是 DeepSeek 的上下文缓存依赖后续请求复用已有请求前缀；`system`、可缓存运行时上下文和真实 `HumanMessage` / `AIMessage` / `ToolMessage` 会话历史是 token 大头，应保持在动态 `runtime-state` 之前。任何动态状态只要放在真实会话前面，都可能在状态变化时破坏其后的缓存。

计划提醒必须：

- 由当前 `graph.state.plan` 生成。
- 出现在压缩后的对话消息之后。
- 使用独立尾部 `HumanMessage`，不能并入用户的真实 `HumanMessage`。
- 包含类似 `<runtime-state source="graph.state.plan">` 的标记。
- 明确说明该消息由 harness 生成，不是用户输入。
- 不进入静态 system prompt，也不进入可缓存运行时上下文。

2026-05-01 真实 DeepSeek 读-only 大上下文实验中，仅有 read-only 尾部 `SystemMessage` 时，第二轮不读取新文件的 follow-up 请求达到 `27392 / 27490 = 99.64%` prompt cache 命中率。随后真实 plan + read-only 多轮实验显示，若高频变化的 `graph.state.plan` 也使用尾部 `SystemMessage`，plan 更新后命中率会掉到 `1024 / 31373 = 3.26%`，下一轮 follow-up 也只有 `2816 / 31372 = 8.98%`。改为 read-only `SystemMessage` + plan `HumanMessage` 的混合方案后，第二轮不读取新文件达到 `31360 / 31701 = 98.92%`，第三轮 `update_plan` 后最终调用达到 `32384 / 32623 = 99.27%`。由于 `read-only` / `write` 在某些 thread 中也可能频繁切换，当前规则进一步统一为所有合成 runtime-state 都使用独立尾部 `HumanMessage`；真实访问权限切换实验中，从 read-only 大上下文切到 write 后达到 `29184 / 30148 = 96.80%`，再切回 read-only 达到 `30080 / 30640 = 98.17%`，未出现动态 `SystemMessage` 的 provider 重排断崖。

工具调用链必须保留原始 `AIMessage.tool_calls[]` + `ToolMessage` 结构。不要为了缓存命中率把 `ToolMessage` 改写成 `HumanMessage`；这会混淆 LangGraph/LangChain 的工具协议事实。

## 不要做

- 不要把计划状态移回静态 system prompt。
- 不要把计划状态放入 `buildCacheableRuntimeContext`。
- 不要把动态 runtime-state 投影为 `SystemMessage`。
- 不要因为 `read-only` / `write` 访问权限变化生成不同的静态 system prompt。
- 不要把当前 `graph.state.workspaceAccess` 写入可缓存运行时上下文；需要投影时使用尾部合成 `HumanMessage`。
- 不要把某次 `ask_user` 的具体问题、选项或回答写入静态 system prompt 或可缓存运行时上下文。
- 不要依赖 `update_plan` ToolMessage 历史作为当前计划。
- 不要把已完成工具结果放入 `buildCacheableRuntimeContext`；它们属于对话事实，不是跨任务稳定上下文。
- 不要把已完成的 `AIMessage.tool_calls[]` + `ToolMessage` 原始链改写成用户消息。

## 测试期望

`tests/context.test.ts` 应断言：

- 单一 `agent` 使用一份静态 system prompt。
- 当前 `read-only` 工作区访问权限使用尾部合成 `HumanMessage` 投影。
- 计划状态使用尾部合成 `HumanMessage` 出现在对话消息之后。
- 当 `read-only` 与 plan 同时存在时，read-only `HumanMessage` 在 plan `HumanMessage` 之前。
- 已完成工具调用链保持 `AIMessage` + `ToolMessage` 原样。

`tests/runtime-context.test.ts` 应断言运行时上下文包含跨访问权限稳定的工作区访问策略，且排除当前访问权限、计划详情、上下文摘要、用户身份和已配置模型详情。
