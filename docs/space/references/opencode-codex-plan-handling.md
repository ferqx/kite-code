# 参考：Opencode 与 Codex 的计划处理

日期：2026-04-26
状态：reference
相关本地记录：

- `../understanding/2026-04-26-plan-state-context-projection.md`
- `../../active/plan-state-reminder.md`

## Opencode

观察到的模式：

- 静态 provider/agent 指令被组装为 system 内容。
- 动态 plan-mode 提醒被追加为最新用户消息上的合成文本，而不是尾部 system 内容。
- 工具输出保持为普通 tool/message 状态；没有观察到每轮额外注入 evidence 或 progress heartbeat 提醒的模式。
- 实验性 plan 模式把计划存入计划文件，但对本地更有用的启发是合成消息的位置，而不是文件机制。
- plan/build 切换通过 harness 创建的合成用户消息表达。

相关上游区域：

- `packages/opencode/src/session/llm.ts`
- `packages/opencode/src/session/prompt.ts`
- `packages/opencode/src/tool/plan.ts`
- `packages/opencode/src/agent/agent.ts`

## OpenAI Codex

观察到的模式：

- `update_plan` 是 UI/checklist 工具。
- 真正有用的信息是 harness/client 消费的工具输入。
- 返回给模型的工具结果刻意保持很小，例如 `Plan updated`。
- prompt 指导模型在 `update_plan` 后不要重复完整计划，因为 harness 会展示它。
- 进度更新和验证指导通过指令、工具结果和 client 事件处理，而不是单独注入 evidence/heartbeat prompt block。

相关上游区域：

- `codex-rs/core/prompt.md`
- `codex-rs/core/src/tools/handlers/plan.rs`
- `codex-rs/protocol/src/plan_tool.rs`
- `codex-rs/core/src/compact.rs`

## 本地结论

不要把 Opencode 的计划文件机制复制到这个 LangGraph checkpoint 架构中。应继续把 `graph.state.plan` 作为持久状态，但把它作为尾部 harness-generated conversation item 投影给模型。

默认不要保留单独的 evidence/progress 账本。除非证明存在具体工具边界需求，否则工具结果、权限边界、计划状态和图 recursion limit 已经足够。
