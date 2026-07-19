# 上下文整理与压缩方案 — UI 线 / 模型输入线

创建日期：2026-06-28
重写日期：2026-06-29
状态：archived（M0/M1 已实施，M2 延后；当前行为以 active 规则为准）
优先级：P0

## 结论

原方案把 TUI 展示整理、工具输出折叠、对话摘要压缩都放进 M0/M1/M2 三层压缩模型，容易误导优先级。新的方案拆成两条线：

1. **UI 整理线**：只负责用户看到的 TUI 块如何聚合，不承诺减少模型上下文 token。
2. **模型输入线**：只负责进入 LLM 的消息如何安全缩减，最终目标是长对话不因 context window 耗尽而中断。

这两条线可以共享“探索工具”的概念，但不能共享实现状态判断。UI 聚合成功不代表模型上下文已经压缩。

## 线 A：UI 整理线（Thought 预整合）

### 目标

将同一轮 agent 中连续出现的只读探索工具聚合成 `tool_summary`，匹配类似 “Thought for 5s, read 2 files, searched for 1 pattern” 的体验。

### 作用边界

- 发生位置：TUI reducer/render 层。
- 影响对象：`OutputBlock` 渲染形态。
- 不影响对象：LangGraph checkpoint、`BaseMessage[]`、模型输入 token。

### 探索工具

| 工具 | 归类条件 |
| --- | --- |
| `read_file` | 始终 |
| `search_content` | 始终 |
| `search_files` | 始终 |
| `read_mcp_resource` | 始终 |
| `shell_execute` | `intent=inspect` 且命令为搜索/查找类前缀 |

### 已落地修复

1. `tool_call` 仍建立 `explorationSummaryIds[callId] = blockId` 作为快速索引。
2. `tool_done` 不再只信该 map；若 map 缺失或 stale，会从所有 turns 反向扫描包含该 `callId` 的 `tool_summary`。
3. 更新 `tool_summary` 时按 turn/block 创建新引用链，保证 React/Ink 能看到状态变化。

### 后续约束

- `explorationSummaryIds` 是加速索引，不是唯一事实来源。
- 回放或 session restore 场景必须能只靠 block 内的 `callId` 完成状态恢复。
- `tool_summary` 进入 Static 的条件仍是所有工具状态均非 `running`。

## 线 B：模型输入线（安全压缩）

### 目标

在 `prepareModelContext()` 构建模型输入时减少 token，同时不丢失会影响后续代码判断的事实。

### B1：工具输出折叠（当前主力）

发生位置：`src/core/model/compaction.ts`，由 `src/core/model/context.ts` 调用。

折叠对象：

| 工具 | 折叠策略 |
| --- | --- |
| `read_file` | 旧的重复读取可折叠为一行，但每个路径的关键完整读取必须保留 |
| `search_content` | 可折叠为搜索摘要 |
| `search_files` | 可折叠为文件发现摘要 |
| `read_mcp_resource` | 可折叠为 MCP 资源读取摘要 |
| `shell_execute` | 仅 inspect 搜索类命令可折叠 |

安全规则：

1. 最近 `recentWindowSize` 条消息不折叠。
2. 每个文件路径的首次完整读取保留。
3. 文件发生 `edit_file`、`write_file`、`apply_patch` 后，该路径的下一次 `read_file` 必须重新保留完整内容。
4. 已标记 `_compacted` 或 `_folded` 的消息不二次折叠。
5. `microCompactToolOutputs()` 只折叠工具名和关键参数都相同的连续调用；不同 path/pattern/command 不能因为工具名相同而折叠。

### B2：压缩触发（当前未接入生产路径）

已有函数：

- `estimateTokens(messages)`
- `shouldCompact(estimatedTokens, budget?)`

当前问题：

- `contextBudget` 默认是 `undefined`。
- `ContextBudget.maxTokens` 是可选字段。
- `shouldCompact()` 没有在模型调用前接入生产路径。

因此，文档不能再声称“默认 256K 会触发压缩”。默认预算需要在 provider/model 配置层落地后才成立。

### B3：对话摘要压缩（待实现）

最小可用方案：

1. 在模型调用前估算 token。
2. 若超过软阈值，先执行 B1 工具折叠，再估算。
3. 若仍超过硬阈值，将早期 settled 消息摘要成结构化状态。
4. 保留最近窗口、未完成 tool pair、当前 plan、最近文件变更和用户最新请求。
5. 摘要作为非缓存动态消息注入，避免破坏 cacheable system prompt 前缀。

摘要必须包含：

- 用户目标和已确认约束。
- 已修改文件和关键决策。
- 最近有效的文件观察。
- 未解决问题和下一步。
- 不可省略的错误/失败结论。

## 当前优先级

1. **已完成**：修复 UI 线 `tool_summary` 的 stale map/running 风险。
2. **已完成**：修复模型输入线中 M1 折叠的两个信息正确性风险：
   - 不同参数的连续同名工具不再被 micro compact。
   - 文件修改后的首次读取不再被折叠。
3. **下一步**：为 provider/model 建立默认 `ContextBudget`，并在 `invokeModel()` 前接入 `estimateTokens()`/`shouldCompact()`。
4. **之后**：实现最小 B3 摘要压缩，而不是一次性引入复杂摘要生命周期。

## 文件清单

| 文件 | 角色 | 线 |
| --- | --- | --- |
| `src/app/tui/reducers/consolidateTools.ts` | 探索工具判断与 UI 聚合 | UI |
| `src/app/tui/reducers/handleEvent.ts` | `tool_call`/`tool_done` 更新 `tool_summary` | UI |
| `src/app/tui/components/ToolSummaryBlock.tsx` | Thought 块渲染 | UI |
| `src/app/tui/render/useStaticContent.tsx` | Static/Dynamic 分界 | UI |
| `src/app/tui/types.ts` | `ConsolidatedToolEntry` / `tool_summary` 类型 | UI |
| `src/core/model/compaction.ts` | 工具输出折叠、token 估算、压缩触发判断 | 模型输入 |
| `src/core/model/context.ts` | 构建模型输入并调用折叠流水线 | 模型输入 |
| `src/core/types.ts` | `ContextBudget` 类型 | 模型输入 |
| `tests/tui-reducer.test.ts` | UI 聚合回归测试 | UI |
| `tests/context.test.ts` | 模型输入折叠回归测试 | 模型输入 |

## 验证命令

```bash
bun test tests\tui-reducer.test.ts tests\context.test.ts --timeout 120000
```

---

## Legacy：旧三层方案原文（已废弃，仅保留历史）

创建日期：2026-06-28
状态：archived（旧方案原文；M0/M1 已实现，M2 未纳入当前计划）
优先级：P0
依赖：无

## 概述

对齐 Claude Code 的上下文压缩策略，实现三层渐进式压缩机制，确保长对话不会因 context window 耗尽而中断。

Claude Code 的两机制压缩：
- **M1 工具折叠**（规则驱动）：将旧的只读工具结果折叠为一行摘要
- **M2 对话摘要**（模型驱动）：当 context 耗尽时，用模型生成结构化摘要替代早期消息

我们在 M1 之前额外增加一层 **M0 TUI 预整合**，在事件渲染层将连续探索工具合并为 Thought 块，提供无缝的 UX 体验。

## 三层架构

```
┌─────────────────────────────────────────────────────────┐
│ M0 — TUI 预整合（pre-consolidation）                    │
│ 时机：tool_call / tool_done 事件 → reducer              │
│ 行为：探索工具直接进入 tool_summary，不出现 tool_card   │
│ 效果：实时 merge，Thought 块持续更新                    │
│ 文件：src/app/tui/reducers/consolidateTools.ts          │
│       src/app/tui/reducers/handleEvent.ts               │
│       src/app/tui/components/ToolSummaryBlock.tsx       │
├─────────────────────────────────────────────────────────┤
│ M1 — Core 工具结果折叠（tool output folding）           │
│ 时机：prepareModelContext() 构建模型上下文前             │
│ 行为：折叠旧的只读工具 ToolMessage 为一行摘要           │
│ 效果：减少模型上下文 token 消耗                         │
│ 文件：src/core/model/compaction.ts                      │
│        foldToolOutputs() + microCompactToolOutputs()     │
├─────────────────────────────────────────────────────────┤
│ M2 — 对话摘要压缩（conversation summarization）         │
│ 时机：shouldCompact() 返回 true 时                      │
│ 行为：用模型生成早期消息的结构化摘要                    │
│ 效果：跨 session 恢复时大幅缩减上下文                   │
│ 状态：延后，尚未实现                                    │
└─────────────────────────────────────────────────────────┘
```

## M0 — TUI 预整合

### 设计目标

将同一轮对话中的连续探索工具调用合并为一个 `tool_summary` 块，匹配 Claude Code 的 "Thought for Xs, read N files, searched for M patterns" 模式。

### 探索工具定义

| 工具 | 归类条件 |
|------|---------|
| `read_file` | 始终 |
| `search_content` | 始终 |
| `search_files` | 始终 |
| `read_mcp_resource` | 始终 |
| `shell_execute` | `intent=inspect` + 命令以 `rg `/`grep `/`ag `/`ack `/`git grep `/`find ./`find /` 开头 |

### 事件流

**tool_call（探索工具）**：
1. 检查最后一个 block 是否为未完成的 `tool_summary`
2. 是 → 追加 `ConsolidatedToolEntry` (status='running')
3. 否 → 创建新 `tool_summary`，记录 `explorationSummaryIds[callId] = blockId`

**tool_done（探索工具）**：
1. 通过 `explorationSummaryIds[callId]` 查找 blockId
2. 通过 `findIndex(b.id === blockId)` 定位 summary 块
3. 更新对应 entry 的 status/summary/elapsedMs/totalLines
4. 重新计算 `totalElapsedMs = Date.now() - createdAt`（wall-clock）
5. 重新生成 `summaryLine`

**非探索工具 tool_done**：
1. 触发 `maybeConsolidateLastTurnBlocks` 冲刷残留的探索 tool_card

### tool_summary 数据结构

```typescript
interface ConsolidatedToolEntry {
  callId: string;
  name: string;
  args: Record<string, unknown>;
  ok: boolean;
  summary: string;
  elapsedMs?: number;
  status: 'running' | 'done' | 'error' | 'cancelled';
  totalLines?: number;
}

// OutputBlock variant
{ id: number; kind: 'tool_summary';
  tools: ConsolidatedToolEntry[];
  totalElapsedMs: number;
  createdAt: number;
  summaryLine: string; }
```

### ToolSummaryBlock 渲染

**运行中**：
```
○ Thought for 3s, read 2 files, searched for 1 pattern
  ├─ Read: App.tsx [lines 1-343 / 343]
  ├─ Search: "useEffect" [*.tsx]
  └─ Bash: rg "pattern" src/
  ... 以上 2 步已折叠       ← 超过 MAX_RUNNING_STEPS=5 时显示
  └─ 运行中 (3s)
```

**完成**：
```
● Thought for 5s, read 2 files, searched for 1 pattern
  ├─ Read: App.tsx [lines 1-343 / 343] ✓
  ├─ Search: "useEffect" [*.tsx] ✓
  └─ Bash: rg "pattern" src/ ✓
  └─ 完成
```

**部分失败**：
```
● Thought for 5s, read 2 files, searched for 2 patterns
  ├─ Read: App.tsx ✓
  ├─ Bash: rg "good" → 5 matches ✓
  ├─ Bash: rg "bad" ✗ no matches found
  └─ Bash: rg "other" ✗ permission denied
  └─ 部分失败
```

### 状态 dot 含义

| dot | 含义 |
|-----|------|
| `○` dim (spinner) | 正在运行，spinner 每 80ms 轮换 |
| `●` green | 全部完成 |
| `●` red | 部分失败 |
| `✓` green | 单个工具成功 |
| `✗` red | 单个工具失败 |

### 计时器逻辑

- **事件驱动**：不再使用前端 `setInterval`。`totalElapsedMs` 由 reducer 在每次事件中更新（`tool_done` / `updateCurrentThoughtActivity` / `closeCurrentThought`），计算方式均为 `Date.now() - createdAt`
- **显示**：`formatDuration(ms)`，最小显示 1s
- **totalElapsedMs**：wall-clock 时间（`Date.now() - createdAt`），非 max(elapsedMs)

### Static/Dynamic 分界

- `isSettled(block)`：所有 tools 均为 done/error/cancelled 时进入 Static
- `blockFingerprint`：`${tools.length}:${tools.map(t => t.status[0]).join('')}:${totalElapsedMs}`

### 已知问题

1. **首 Thought 卡 running**：当一轮对话多个 Thought 时，第一个 Thought 的 tool_done 事件未正确到达更新代码路径。`explorationSummaryIds` map 已建立，但 tool_done 处理时可能因状态引用问题未匹配。

2. **shell_execute intent 识别**：模型可能不设置 intent 参数或使用非 inspect 的 intent，导致 shell 搜索命令未被纳入 Thought。

3. **M2 未实现**：对话摘要压缩尚未实现，长对话可能耗尽 context window。

## M1 — Core 工具结果折叠

### 设计目标

在构建模型上下文前（`prepareModelContext()`），将旧的只读工具输出折叠为一行摘要，减少 token 消耗。

### 两个折叠函数

**`microCompactToolOutputs(messages)`**：
- 检测 ≥3 个连续相同工具的 (AIMessage + ToolMessage) 对
- 将中间重复结果的 ToolMessage 折叠为 `_compacted: true` 标记
- 保留 AIMessage（模型依赖其 tool_call 结构）
- 在 `foldToolOutputs` 之前运行

**`foldToolOutputs(messages, budget?)`**：
- 折叠可折叠工具的 ToolMessage 为一行结构化摘要
- 保护规则：
  - 最近 `recentWindowSize`（默认 6）条消息不折叠
  - 每个文件路径首次出现时保留原文
  - 已标记 `_compacted` 或 `_folded` 的消息不二次折叠

### 折叠规则

| 工具 | 折叠结果 |
|------|---------|
| `read_file` | `{"_folded":true, "note":"Read <path> (N lines)"}` |
| `search_content` | `{"_folded":true, "note":"Searched: <pattern>"}` |
| `search_files` | `{"_folded":true, "note":"Found: <pattern>"}` |
| `read_mcp_resource` | `{"_folded":true, "note":"Read MCP <path>"}` |
| `shell_execute` (intent=inspect + search cmd) | `{"_folded":true, "note":"Searched: <cmd>"}` |

### 压缩触发

`shouldCompact(estimatedTokens, budget?)` 判断是否需要 M2 压缩：
- **硬限制**：`estimatedTokens >= maxTokens - reservedOutputTokens`
- **软限制**：`estimatedTokens >= maxTokens * compactionThreshold`（默认 0.75）
- `reservedOutputTokens` = `min(16384, maxTokens * 0.06)`

### ContextBudget 配置

```typescript
interface ContextBudget {
  maxTokens: number;           // 默认 262144 (256K)
  recentWindowSize: number;    // 默认 6
  compactionThreshold: number; // 默认 0.75（M2 预留）
}
```

## M2 — 对话摘要压缩（延后）

### 设计方向

当 `shouldCompact()` 返回 true 时：
1. 将早期消息发送给模型，请求生成结构化摘要
2. 摘要包含：关键决策、文件修改、未解决问题
3. 将摘要注入为 SystemMessage 或 HumanMessage
4. 删除被摘要的原始消息

### 延后原因

- M0 + M1 已覆盖主要场景
- M2 涉及压缩→恢复→合并的完整生命周期，复杂度高
- 需要模型调用，增加延迟和 token 成本
- 当前 256K context window 足够大多数会话

## 文件清单

| 文件 | 角色 | 层 |
|------|------|-----|
| `src/core/model/compaction.ts` | M1 折叠引擎 + token 估算 | core |
| `src/core/types.ts` | ContextBudget 类型 | core |
| `src/core/model/context.ts` | 调用折叠函数 | core |
| `src/app/tui/reducers/consolidateTools.ts` | M0 合并逻辑 + 工具判断 | app |
| `src/app/tui/reducers/handleEvent.ts` | M0 tool_call/tool_done 处理 | app |
| `src/app/tui/components/ToolSummaryBlock.tsx` | Thought 块渲染 | app |
| `src/app/tui/components/BlockRenderer.tsx` | tool_summary case 分发 | app |
| `src/app/tui/components/render-utils.ts` | actionName/SPINNER/toolColor | app |
| `src/app/tui/render/useStaticContent.tsx` | Static/Dynamic 分界 | app |
| `src/app/tui/types.ts` | ConsolidatedToolEntry / tool_summary 类型 | app |
| `src/app/tui/App.tsx` | explorationSummaryIds 初始状态 | app |
| `src/app/tui/reducers/agentReducer.ts` | cancelRunningBlocks 支持 tool_summary | app |
| `tests/context.test.ts` | M1 折叠 + token 估算测试 | test |
| `tests/tui-reducer.test.ts` | M0 预整合测试 | test |
