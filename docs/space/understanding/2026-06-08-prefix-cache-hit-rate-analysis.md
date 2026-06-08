# 理解：前缀缓存命中率分析

日期：2026-06-08
状态：understanding

相关：

- `../execution/completed/2026-05-01-prompt-cache-runtime-state-research.md`
- `../execution/active/empirical-research-archive.md`
- `../../src/core/model/context.ts`
- `../../src/core/model/runtime-context.ts`
- `../../src/core/subagent/runner.ts`

## 前缀缓存机制（DeepSeek）

DeepSeek 的 KV cache 前缀缓存按 **token 序列** 匹配，不是按消息级别。

### 缓存前缀落盘时机

- **请求结束位置落盘**：每次请求在用户输入结束位置和模型输出结束位置各产生一个缓存前缀单元。后续请求若完整匹配则命中。
- **公共前缀检测落盘**：系统检测到多次请求间存在公共前缀时，将公共前缀作为独立缓存单元落盘。
- **固定 token 间隔落盘**：长输入/输出中按固定 token 数截取缓存单元，避免长前缀无法缓存。

### 匹配规则

缓存单元 U 被命中当且仅当 U 是当前请求 token 序列的**前缀**（从头连续匹配）。

示例 1：请求 1 = A+B，请求 2 = A+B+C → 请求 2 完整匹配 A+B 缓存单元 → 命中。

示例 2：请求 1 = A+B，请求 2 = A+C → 无法命中（A+C 不匹配 A+B）。系统检测到公共前缀 A 并落盘。请求 3 = A+D → 匹配 A 缓存单元 → 命中 A。

### 缓存过期

DeepSeek KV cache 有 5-10 分钟 TTL。请求间隔过长会导致缓存失效。

## 前缀大小与命中率的关系

### 数学模型

设前缀大小为 P tokens，每轮对话新增 T tokens，共 N 轮请求。

- 请求 1：输入 P，命中 0
- 请求 K（K>1）：输入 P+(K-1)*T，命中 P+(K-2)*T（完整匹配上一轮输入）

累计命中率 = Σhits / Σinputs

### 计算结果

以 T=1500 tokens/轮为例：

| 前缀大小 | 5 轮累计 | 10 轮累计 | 20 轮累计 |
|---------|---------|----------|----------|
| 1100 | 51% | 58% | 65% |
| 5000 | 76% | 83% | 87% |
| 10000 | 85% | 90% | 92% |

### 关键结论

- 每次请求的命中率随对话增长而**升高**（因为前缀占总输入比例增大），不会"稀释"。
- 前缀越大，首次请求 0% 的"拖累"越小，累计命中率越高。
- Claude Code 达到 95%+ 的核心原因：system prompt + CLAUDE.md + 工具定义加起来很可能在 10K+ tokens 级别。
- 当前 OpenPX 的 system prompt 约 1100 tokens，理论累计命中率上限约 65%。

## 当前 OpenPX 前缀构成

```text
位置 0: SystemMessage(buildStaticSystemPrompt)    ≈ 1100 tokens（4552 字符）
位置 1: SystemMessage(buildCacheableRuntimeContext) ≈ 50 tokens
位置 2: HumanMessage(用户首条消息)                 ≈ 50 tokens
────────────────────────────────────────────
前缀合计 ≈ 1200 tokens
```

system-prompt.txt 内容包含：Core Mandate、Working Principles、Execution Loop、Tool Strategy、Code Modification、Verification、Failure Recovery、Response Style。

## 影响命中率的因素

### 高影响

1. **前缀太小**：1100 tokens 的 system prompt 在对话增长后占比迅速下降。
2. **缓存过期**：工具执行耗时、用户思考导致请求间隔超过 5-10 分钟 TTL。
3. **Sub-agent 调用**：每次 sub-agent 是全新请求，首轮命中率 0%，拉低整体均值。

### 中等影响

4. **Checkpoint 反序列化**：resume 时从 SQLite 加载的消息对象可能与原始 LangChain 实例序列化结果不同，破坏前缀。
5. **sanitizeToolCallPairs 修改中间消息**：正常流程是 no-op，但孤儿场景（拒绝审批、异常 resume）会修改中间 AIMessage，破坏该点之后的前缀。

### 零影响（已确认安全）

- `buildStaticSystemPrompt`：每个 session 确定性输出。
- `buildCacheableRuntimeContext`：只含 OS/Shell/Workspace，不含时间戳。
- Plan 追加消息：始终在数组末尾。
- 模型参数（temperature/tool_choice）：全局固定。
- workspaceAccess/phase/userId/threadId：不注入消息数组。

## 优化方向

1. **增大前缀**：把工具契约、项目规则、常见模式等稳定内容移入 system prompt，从 1100 tokens 提升到 3000-5000+ tokens。
2. **减少请求间隔**：优化工具执行速度，减少用户等待时间，避免缓存过期。
3. **Sub-agent 前缀复用**：让同角色 sub-agent 共享更多前缀内容。
