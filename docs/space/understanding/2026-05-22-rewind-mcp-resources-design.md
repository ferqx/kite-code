# Rewind + MCP Resources 设计

日期：2026-05-22
状态：approved（已确认，待执行）
参考：`plans/2026-05-22-production-gaps-closure.md` Phase 2

---

## 目标

实现会话回溯（Rewind）和 MCP Resources 集成，补齐 Phase 2 两个缺口。

---

## Section 1: Rewind（Revert + Fork）

### 概念模型

对齐 git 操作心智模型：

| 操作 | 类比 | 行为 |
|------|------|------|
| **Revert** | `git reset --soft` | 当前 thread 恢复到指定 checkpoint，继续对话。新消息追加到同一 thread checkpoint 链。 |
| **Fork** | `git checkout -b` | 新 threadId，从指定 checkpoint 的 state 开始全新对话。原 thread 不受影响。 |

触发方式：`/rewind` 命令打开 checkpoint 选择覆盖层。不做 `Esc Esc` 快捷方式。

### 交互流程

```
用户输入 /rewind
  → 打开 CheckpointSelector 覆盖层
    → 展示当前 thread 的 checkpoint 列表（序号 + 用户首条摘要 + 时间戳，最近 20 条）
    → 用户选中某个 checkpoint
      → 底部操作选项：[R]evert  [F]ork  [Esc] cancel
      → Revert: dispatch REVERT_TO_CHECKPOINT → runner 恢复
      → Fork: dispatch FORK_FROM_CHECKPOINT → runner fork
      → 操作完成后关闭覆盖层、清空输出、加载新会话
```

### Saver 层新增（`checkpoint.ts`）

#### `listCheckpoints(threadId)`

枚举线程最近的 checkpoint（最多 20 条），提取首条 HumanMessage 作为摘要。

```typescript
interface CheckpointEntry {
  checkpointId: string;
  parentCheckpointId: string | null;
  createdAt: string;
  firstUserMessage: string; // 截取前 60 字符
}

async listCheckpoints(threadId: string, limit?: number): Promise<CheckpointEntry[]>
```

实现：复用现有 `list()` 方法，按 `checkpoint_id desc` 排序取最近 N 条。对每条读取 `channel_values.messages`，取第一个 `HumanMessage` 的 content 截取 60 字符。

#### `getCheckpointState(threadId, checkpointId)`

加载指定 checkpoint 的完整 state，返回可用于初始化或恢复的 `CodeAgentState`。

```typescript
async getCheckpointState(
  threadId: string,
  checkpointId: string,
): Promise<CodeAgentState | null>
```

实现：通过 `getTuple({ configurable: { thread_id, checkpoint_id } })` 加载，从 `channel_values` 中提取 messages、workspaceAccess、phase、plan、authorization、contextSummary 等字段，构造 `CodeAgentState`。

### Runner 层新增（`runner.ts`）

#### `revertToCheckpoint(threadId, checkpointId)`

当前 thread 恢复到 checkpoint 状态继续执行。

实现：
1. 调用 `getCheckpointState(threadId, checkpointId)` 获取 state
2. 构造 `Command({ update: state })` (实际上 graph 会自动使用指定 checkpoint_id 的 state)
3. 更简单的实现：直接调用 `graph.stream(null, { configurable: { thread_id, checkpoint_id } })` — LangGraph 会自动以指定 checkpoint 的状态恢复，新 checkpoint 追加到原链上。

实际上是复用 LangGraph 的 checkpoint 恢复：`graph.stream(new Command({ resume: null }), { configurable: { thread_id: threadId, checkpoint_id: checkpointId } })`。不需要额外的 runner 逻辑 — graph 的 checkpoint 机制已原生支持。

但 TUI 层需要感知 rever/fork 操作，因为：
- Revert 需要重新加载 blocks（清空输出 + 加载 checkpoint 消息）
- Fork 需要切换 threadId

因此 runner 层提供命名包装：
```typescript
async function* revertToCheckpoint(
  input: ResumeCodeAgentInput & { checkpointId: string },
): AsyncGenerator<AgentEvent>
```

内部调用 `graph.stream(Command, { configurable: { thread_id, checkpoint_id } })`。

#### `forkFromCheckpoint(oldThreadId, checkpointId, newThreadId)`

从旧 checkpoint fork 新会话。

实现：
1. 调用 `getCheckpointState(oldThreadId, checkpointId)` 获取 state
2. 构造新 `initialState`（使用新 `threadId`，其余字段从 checkpoint state 复制）
3. 调用 `graph.stream(initialState, { configurable: { thread_id: newThreadId } })`

```typescript
async function* forkFromCheckpoint(
  oldThreadId: string,
  checkpointId: string,
  newThreadId: string,
  config: AgentConfig,
  checkpointPath: string,
  shellExecutor?: ShellExecutor,
  signal?: AbortSignal,
): AsyncGenerator<AgentEvent>
```

复用现有 `runAgent` 的核心逻辑，但初始 state 来自旧 checkpoint 而非新 `HumanMessage`。

### TUI 层

#### `CheckpointSelector.tsx`

新建覆盖层组件，展示 checkpoint 列表。

Props:
```typescript
interface CheckpointSelectorProps {
  checkpoints: CheckpointEntry[];
  onSelect: (checkpointId: string, action: "revert" | "fork") => void;
  onClose: () => void;
}
```

渲染：
- 列表项：序号 + "→" + 首条 user msg 摘要（截取 60 字符）+ 时间戳
- 选中项高亮（键盘 ↑↓ 导航）
- 底部操作栏：`[R]evert  [F]ork  [Esc] cancel`
- 按 R/F 后调用 `onSelect(checkpointId, action)`

#### App.tsx 新增 Actions

```
SHOW_REWIND         → state.showRewind = true, 异步加载 checkpoint 列表
HIDE_REWIND         → state.showRewind = false
REVERT_TO_CHECKPOINT(checkpointId)  → 触发 revert
FORK_FROM_CHECKPOINT(checkpointId)  → 触发 fork
```

Revert 流程：dispatch REVERT → 清空 blocks + 加载旧 checkpoint messages 为 initial blocks → 从 checkpoint 恢复 runner → 新事件追加到 blocks。

Fork 流程：dispatch FORK → 生成新 threadId → 新 session → 加载旧 checkpoint messages → 新 runner → 新事件。

#### useSlashCommand.ts

新增 `/rewind` 命令：
```typescript
case "rewind": return { type: "rewind" };
// handler:
case "rewind":
  dispatch({ type: "SHOW_REWIND" });
  break;
```

---

## Section 2: MCP Resources

### McpManager 扩展（`manager.ts`）

新增两个方法，复用 Phase 1 的 JSON-RPC 管道和 `Client` 实例。

#### `listResources(serverName)`

调用 `client.listResources()`，返回 resource 列表。

```typescript
interface McpResource {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

async listResources(serverName: string): Promise<McpResource[]>
```

在 `connect()` 时随 `listTools`/`listPrompts` 一起拉取，缓存到 `McpServerState.resources`。`resources/list` 失败不阻断连接（resources 在 MCP 协议中是可选的）。

#### `readResource(serverName, uri)`

调用 `client.readResource({ uri })`，返回 resource 内容。

```typescript
interface McpResourceContent {
  uri: string;
  mimeType?: string;
  text?: string;
  blob?: string;
}

async readResource(serverName: string, uri: string): Promise<McpResourceContent>
```

### 新增内置工具 `read_mcp_resource`（`definitions.ts`）

在 `createAgentTools` 中新增内置工具：

```typescript
const readMcpResource = tool(
  async ({ server, uri }) => {
    const content = await mcpManager.readResource(server, uri);
    return JSON.stringify({ ok: true, content });
  },
  {
    name: "read_mcp_resource",
    description: "Read a resource from an MCP server. Use this to fetch documentation, API specs, or other content exposed by MCP servers.",
    schema: z.object({
      server: z.string().describe("MCP server name"),
      uri: z.string().describe("Resource URI to read"),
    }),
  },
);
```

安全策略：`risk: "read"`（免审批），在 `evaluateToolPolicy` 中添加 case，类似 `read_file`。

### TUI 面板扩展（`McpPanel.tsx`）

在现有 MCP server 面板中，每个 server 的 tools 列表下方增加 Resources 区段：

```
● server-name (stdio) — 3 tools
  mcp__server__tool1
  mcp__server__tool2
  mcp__server__tool3
  Resources:
    📄 docs/api.md (file:///docs/api.md)
    📄 config-schema (config:///schema.json)
```

Resource 列表最多展示 10 条，超出显示 `…and N more`。

### MCP 协议补充说明

- `resources/list` 在 `initialize` 后的 `tools/list` 阶段拉取
- `resources/list_changed` 通知支持（与 tools list_changed 相同模式）
- Resource 内容通过 `read_mcp_resource` 工具注入 agent 上下文，不实现 `@` 提及 UI

---

## 文件变更汇总

| 操作 | 文件 | 职责 |
|------|------|------|
| 新增 | `src/app/tui/components/CheckpointSelector.tsx` | Rewind checkpoint 选择覆盖层 |
| 新增 | `tests/checkpoint.test.ts`（扩展） | `listCheckpoints`/`getCheckpointState` 测试 |
| 新增 | `tests/rewind.test.ts` | Revert/Fork 端到端测试 |
| 修改 | `src/core/persistence/checkpoint.ts` | 新增 `listCheckpoints`/`getCheckpointState` |
| 修改 | `src/core/runner.ts` | 新增 `revertToCheckpoint`/`forkFromCheckpoint` |
| 修改 | `src/core/mcp/manager.ts` | 新增 `listResources`/`readResource`，connect 时缓存 |
| 修改 | `src/core/mcp/types.ts` | 新增 `McpResource`/`McpResourceContent` 类型 |
| 修改 | `src/core/tools/definitions.ts` | 新增 `read_mcp_resource` 内置工具 |
| 修改 | `src/core/harness/tool-policy.ts` | 新增 `read_mcp_resource` 为 risk: read |
| 修改 | `src/app/tui/components/McpPanel.tsx` | 展示 Resources 区段 |
| 修改 | `src/app/tui/hooks/useSlashCommand.ts` | 新增 `/rewind` 命令 |
| 修改 | `src/app/tui/App.tsx` | 新增 Rewind 相关 actions + 渲染 CheckpointSelector |
| 修改 | `src/app/tui/index.tsx` | Revert/Fork 的 runner 调用编排 |
| 修改 | `src/app/tui/types.ts` | 新增 `showRewind` + `checkpoints` 状态字段 |

---

## 依赖

- Phase 1 MCP 核心（已完成）— McpManager、Client、Transport 已就绪
- Phase 1 事件闭环（已完成）— runner 事件流已稳定
- 无外部新依赖

## 相关文档

- [`2026-05-22-production-gaps-closure.md`](../plans/2026-05-22-production-gaps-closure.md) — 总体方案
- [`2026-05-22-production-gaps-phase1.md`](../plans/2026-05-22-production-gaps-phase1.md) — Phase 1 实施计划
- [Claude Code Rewind 文档](https://code.claude.com/docs/en/checkpointing) — Rewind 模型参考
- [MCP 协议规范](https://modelcontextprotocol.io/docs/concepts/architecture) — MCP 架构参考
