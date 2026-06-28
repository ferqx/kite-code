# Thought 预整合设计 — M0 探索工具合并

创建日期：2026-06-28
状态：understanding

## 设计背景

对标 Claude Code 的 "Thought for Xs, read N files, searched for M patterns" 模式，将同一轮 agent 对话中的连续探索工具（read_file、search_content、search_files 等）合并为一个 `tool_summary` 块。用户无需看到每个工具的独立卡片，只用关注 Thought 块的整体进度。

## 核心概念

### 探索工具 vs 写入工具

**探索工具**（进入 tool_summary）：只读、无副作用、无需审批
- `read_file`、`search_content`、`search_files`、`read_mcp_resource`
- `shell_execute`（仅 `intent=inspect` + 搜索命令前缀）

**写入工具**（保留为 tool_card）：有副作用、可能需要审批
- `write_file`、`edit_file`、`shell_execute`（非 inspect）
- `ask_user`、`update_plan`、`task`

### 合并时机

同一轮 agent 内，连续出现的探索工具追加到**同一个** `tool_summary`。遇到以下任一情况时 flush（创建新的 tool_summary）：
- 非探索工具出现（写入工具、text、reason、approval 等）
- 前一个 tool_summary 已全部完成（allSettled）

### 数据结构

```typescript
// 工具条目 — 追踪单个探索工具的完整生命周期
interface ConsolidatedToolEntry {
  callId: string;
  name: string;
  args: Record<string, unknown>;
  ok: boolean;           // tool_call 时为 false，tool_done 时更新
  summary: string;       // tool_call 时为 ""，tool_done 时更新
  elapsedMs?: number;    // tool_done 时设置
  status: 'running' | 'done' | 'error' | 'cancelled';
  totalLines?: number;   // read_file 时设置
}

// OutputBlock 变体
{
  kind: 'tool_summary';
  tools: ConsolidatedToolEntry[];  // 工具列表
  totalElapsedMs: number;          // wall-clock: Date.now() - createdAt
  createdAt: number;               // 第一个工具加入的时间戳
  summaryLine: string;             // "read 2 files, searched for 1 pattern"
}
```

## 事件处理流程

### handleEvent.ts 中的关键路径

**tool_call 事件**（探索工具分支）：
```
isExplorationToolEvent(data)?
├─ Yes → 找最后一个 block
│   ├─ 是未完成的 tool_summary → 追加 entry，更新 summaryLine
│   └─ 否则 → 创建新 tool_summary block
│   记录 explorationSummaryIds[callId] = blockId
└─ No → 创建标准 tool_card
```

**tool_done 事件**（探索工具分支）：
```
isExplorationToolByName(data.name)?
├─ Yes → explorationSummaryIds[callId] 查 blockId
│   ├─ blockId != null → findIndex(b.id === blockId) 定位 summary
│   │   ├─ 找到 → .map() 更新 entry → 新建 turns 引用链
│   │   └─ 未找到 → fall through 到 tool_card 更新
│   └─ blockId == null → fall through
└─ No → 标准 tool_card 更新
  └─ 触发 maybeConsolidateLastTurnBlocks 冲刷
```

### explorationSummaryIds 映射

在 `tool_call` 创建 tool_summary 时建立 callId → blockId 映射，存于 `TuiState.explorationSummaryIds`。

**设计意图**：tool_done 时精确定位 summary 块，替代 `findLastIndex(b => b.tools.some(t => t.callId === ...))` 搜索。

**初始化**：`App.tsx` 中 `explorationSummaryIds: {}`

**生命周期**：每次 tool_call 时通过 spread 操作符创建新 map。tool_done 不清理条目（callId 在一次 run 内唯一且只用一次）。

## 渲染细节

### ToolSummaryBlock 三态

| 状态 | 触发条件 | dot | 计时器 | 工具状态 |
|------|---------|-----|--------|---------|
| 运行中 | `tools.some(t.status === 'running')` | spinner `○` | 每 200ms 更新 | `├─`/`└─` |
| 完成 | 所有工具 done | `●` green | 快照冻结 | `✓` |
| 部分失败 | 有 error | `●` red | 快照冻结 | `✗` |

### 工具列表渲染

**运行中**：tail-follow 最近 5 条（`MAX_RUNNING_STEPS = 5`），超出部分显示 "... 以上 N 步已折叠"
**完成**：显示所有工具，最后一条用 `└─`，其余用 `├─`

### 工具名映射

通过 `ACTION_NAMES` 映射为友好名称：

| 内部名 | 显示名 |
|--------|--------|
| `read_file` | Read |
| `edit_file` | Update |
| `write_file` | Create |
| `search_content` | Search |
| `search_files` | Find |
| `shell_execute` | Bash |
| `read_mcp_resource` | MCP |
| `update_plan` | Plan |
| `ask_user` | Ask |
| `task` | Task |

### 计时器

- 最小显示 1s（`Math.max(1, sec)`）
- 格式：`Xs` / `Xm Ys`
- Running 时 `setInterval` 每 200ms 更新
- Spinner `setInterval` 每 80ms 轮换 `SPINNER` 数组

## Static/Dynamic 边界

### isSettled 规则

```typescript
case 'tool_summary':
  return block.tools.every(
    t => t.status === 'done' || t.status === 'error' || t.status === 'cancelled'
  );
```

所有工具状态都不是 `running` 时才进入 Static。

### blockFingerprint

```
:${tools.length}:${tools.map(t => t.status[0]).join('')}:${totalElapsedMs}
```

例如：`:3:rrd:5000`（3 个工具，状态 running/running/done，耗时 5000ms）

## 与 SubAgentBlock 的对齐

Thought 块视觉结构对齐 SubAgentBlock：

| 元素 | SubAgentBlock | ToolSummaryBlock |
|------|--------------|-----------------|
| 运行 dot | `○` spinner | `○` spinner |
| 完成 dot | `●` green/red | `●` green/red |
| 步骤前缀 | `├─`/`└─` | `├─`/`└─` |
| 成功标记 | `✓` | `✓` |
| 失败标记 | `✗` | `✗` |
| 底部总结 | `└─ 完成` / `└─ 部分失败` | `└─ 完成` / `└─ 部分失败` |
| 运行中 footer | `└─ 运行中 (Xs)` | `└─ 运行中 (Xs)` |

## 已知缺陷

1. **多 Thought 首块 stuck running**：一轮对话中若有两个或多个 Thought，第一个的 tool_done 事件未触发更新代码路径。`explorationSummaryIds` map 已建立但仍未定位到 summary 块。根因疑在 reducer 状态引用替换 --- `.map()` 创建的新 turns 引用可能导致后续 tool_done 的 `handleEventAction` 参数 `state` 是旧引用。

2. **shell_execute 未设 intent**：模型可能不设置 `intent=inspect`，导致 shell 搜索命令未被纳入 Thought，而是保留为独立 tool_card。当前通过命令前缀（rg/grep/ag/find）做 fallback 检测。

3. **回放块合并**：`consolidateAllRuns` 使用 `Date.now()` 而非实际的工具执行时间戳来计算 `createdAt`，回放时计时器不准确。

## 涉及文件

| 文件 | 角色 |
|------|------|
| `src/app/tui/types.ts` | ConsolidatedToolEntry / tool_summary 类型 |
| `src/app/tui/reducers/consolidateTools.ts` | 工具判断 + 合并函数 |
| `src/app/tui/reducers/handleEvent.ts` | tool_call/tool_done 事件 → reducer |
| `src/app/tui/components/ToolSummaryBlock.tsx` | Thought 块渲染 |
| `src/app/tui/components/BlockRenderer.tsx` | tool_summary case 分发 |
| `src/app/tui/components/render-utils.ts` | ACTION_NAMES / SPINNER / toolColor |
| `src/app/tui/render/useStaticContent.tsx` | isSettled / blockFingerprint |
| `src/app/tui/App.tsx` | explorationSummaryIds 初始状态 |
| `src/app/tui/reducers/agentReducer.ts` | cancelRunningBlocks 处理 tool_summary |
