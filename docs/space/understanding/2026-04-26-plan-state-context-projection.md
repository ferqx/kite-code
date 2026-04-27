# 计划状态上下文投影

日期：2026-04-26
状态：understanding
相关：

- `../execution/active/plan-state-reminder.md`
- `../references/opencode-codex-plan-handling.md`

## 摘要

`graph.state.plan` 是持久运行时状态，不是普通对话历史。模型仍需要在每个相关轮次看到它，但该投影不应被当作静态 system 指令。

## 为什么 ToolMessage 不够

- `update_plan` tool message 是历史证据，不是当前事实来源。
- 对话压缩可能丢弃或截断旧 tool message。
- 多次 `update_plan` 调用会让 transcript 中留下多个历史版本。
- builder 模式必须执行当前持久化计划，而不是从旧工具 JSON 中推断计划。

graph state 才是权威来源。prompt 投影只是为了让模型在当前轮次看到这份状态。

## 缓存与 provider 考量

prefix/KV cache 系统通常更偏好稳定的前置 token。把动态状态放在 prompt 中段会降低其后内容的复用率。

system message 也具有 provider 差异。有些 API 会合并、提升或分离 system 指令，因此动态状态不应依赖尾部 `SystemMessage` 语义。

provider 友好的形态是：

```text
system(static rules)
system(cacheable runtime context)
...compacted conversation messages
human(synthetic graph.state.plan reminder)
```

合成计划提醒必须明确说明它由 harness 生成，不是用户输入。其他工具执行事实应保持为普通 tool message，除非有明确的用户可见理由需要把它们额外投影进模型 prompt。
