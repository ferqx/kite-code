# Prompt Cache 优化记录

## 背景

DeepSeek API 上下文硬盘缓存对所有用户默认开启。缓存命中前提是前缀完整匹配已落盘的缓存单元。同一 session 内的连续请求，前缀（system prompt + 历史消息）相同 → 大部分 token 命中缓存；若前缀因任何原因产生差异 → 缓存 miss。

## 发现的三类问题及修复

### 1. 两个连续 SystemMessage 隐式依赖 LangChain 合并行为

**问题**：`prepareModelContext` 生成两个连续 `SystemMessage`（static prompt + cacheable runtime context），LangChain ChatDeepSeek 的 `convertMessagesToCompletionsMessageParams` 会自动合并它们。合并行为是 LangChain 内部实现细节，未来版本可能变化。

**修复**：将两个 SystemMessage 显式合并为一个，消除隐式依赖。

**影响文件**：
- `src/core/model/context.ts` — 主 agent 合并
- `src/core/subagent/runner.ts` — 子 agent 合并（3 个 → 1 个）

### 2. `buildCacheableRuntimeContext` 接收死参数

**问题**：函数签名接受 `RuntimeContextInput`（含 `contextSummary`、`activeSkillInstructions`、`messages` 等），但实际只使用 `workspace`。若未来有人让函数使用这些动态字段，每次变化都会破坏缓存前缀。

**修复**：
- 引入 `CacheableRuntimeContextInput`（仅 `{ workspace: string }`）
- 添加 JSDoc 缓存契约注释
- 不再调用 `getRuntimeSystemInfo`（消除 `new Date()` 副作用）
- 移除全局未使用的 `contextSummary`（从 state、checkpoint、runner、graph 中删除）

**影响文件**：
- `src/core/model/runtime-context.ts`
- `src/core/model/context.ts`
- `src/core/harness/state.ts`
- `src/core/harness/graph.ts`
- `src/core/runner.ts`
- `src/core/persistence/checkpoint.ts`

### 3. `reasoning_content` 注入的 content-based key 碰撞（严重）

**问题**：`PatchedChatDeepSeek.completionWithRetry` 用 `content.slice(0, 200)` 作为 Map key 匹配 AIMessage。多个 tool-call 消息的 content 都是 `""` → **key 碰撞** → 最后一个消息的 reasoning_content 覆盖所有旧消息 → 历史 assistant 消息被注入错误的 rc → API 序列化后的 token 与上一轮不同 → 缓存前缀不匹配 → 命中率从 100% 暴跌到 3%。

**演绎**（单子 agent 内部）：
```
Turn N:   AI₁(rc="think_v1") → API 序列化为 Assistant(rc="think_v1") → 缓存单元 A
Turn N+1: AI₁(rc="think_v1") + AI₂(rc="think_v2")
          content-based Map: { "": "think_v2" } ← AI₂ 覆盖 AI₁
          注入: AI₁ 得到 "think_v2"（应为 "think_v1"）
          API: Assistant(rc="think_v2") ← 与缓存单元 A 不同 → miss!
Turn N+2: AI₁, AI₂ 的 rc 都与 Turn N+1 一致 → hit → 100%
Turn N+3: 新 AI₃(rc="think_v3") → 再次覆盖 → miss → 3%
...交替震荡
```

**修复**：改为位置索引匹配。SystemMessage 合并不影响 assistant 消息数量，位置对应是可靠的。

**影响文件**：`src/core/model/deepseek.ts`

### 4. TUI 缓存命中日志

在主 agent 和子 agent 每次模型调用后追加缓存命中日志：
- 主 agent：`⚡ cache: 12.3k hit / 3.4k miss · 78%`
- 子 agent：`  ⚡ sub cache: 5.2k hit / 1.1k miss · 82%`（缩进 + sub 前缀区分）

**影响文件**：`src/app/tui/reducers/handleEvent.ts`

## 子 Agent 缓存震荡分析

修复 #3 后子 agent 缓存仍有 10~30% miss vs 70~90% hit 的波动，根因是 **每个子 agent task 不同导致 HumanMessage 前缀不同**，但这属于架构必然（详细讨论见下方）。

## 主 Agent 缓存命中分析

主 agent `⚡ cache: 4.7k hit / 10.1k miss · 32%` 的拆解：

```
4.7K hit = SystemMessage(~3.6K) + HumanMessage(~1K)  ← 与上一轮 input 相同，命中
10.1K miss ≈ AIMessage(thinking + task_call, ~2K)     ← 上一轮是 output，本轮是 input，前缀不同
           + ToolMessage(sub_agent_result, ~8K)       ← 子 agent 全新输出，从未出现在 input 前缀中
```

### 对标分析：Claude Code / Codex / OpenCode 子 agent 结果回传机制

| 维度 | Claude Code | Codex (OpenAI) | OpenCode | Kite Code |
|------|------------|----------------|----------|--------|
| 子 agent 上下文 | 完全隔离（sub_messages 丢弃） | 独立上下文 | 每次调用 = 全新 stateless session | 完全隔离（local messages 丢弃） |
| 中间过程 | 留在子 agent，父不可见 | 同 | 同 | 同 |
| 返回值 | 仅最终文本（纯 text block） | 摘要（非原始输出） | 最终结果 | 仅最终文本（`extractText`） |
| 父 agent 收到 | `tool_result` 原文 ≈ 模型输出上限 | consolidated summary | task tool 结果 | `JSON{summary}` ≈ 模型输出上限 |
| 缓存影响 | 同（Anthropic 不暴露此指标） | 设计上保护主 context | 同 | 可见 ~8K miss/turn |

**结论**：主 agent 10K miss 是子 agent **委托模式的固有税**，不是设计缺陷。子 agent 输出多少（受模型 ~8K 输出上限约束），主 agent 就要吃进多少。Claude Code 同样承担此成本，只是不暴露 `prompt_cache_miss_tokens`。

## 验证

- `bun run typecheck` — 零错误
- `bun test` — 760 pass，5 个预存在的 Windows/TUI 平台失败，与本次变更无关
- TUI 手动验证：缓存日志正确显示，主/子 agent 日志有区分
