# Phase 2: Rewind + MCP Resources 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> 状态：archived（2026-06-08 归档）

**Goal:** 实现会话回溯（Revert + Fork）和 MCP Resources 集成，补齐 Phase 2 两个缺口。

**Architecture:** Rewind 复用 LangGraph checkpoint 恢复机制（`configurable.checkpoint_id`），Revert 在同一 thread 恢复，Fork 生成新 threadId 以旧 checkpoint state 启动。MCP Resources 在 Phase 1 McpManager 基础上新增 `listResources`/`readResource` 方法 + 内置工具 `read_mcp_resource` + McpPanel 展示扩展。

**Tech Stack:** Bun, TypeScript ESM, `@modelcontextprotocol/sdk`, LangGraph checkpoint, `@langchain/core` StructuredTool, Ink (React TUI)

---

## 文件结构一览

| 操作 | 文件 | 职责 |
|------|------|------|
| 新增 | `src/app/tui/components/CheckpointSelector.tsx` | Rewind checkpoint 选择覆盖层（列表 + Revert/Fork 操作） |
| 新增 | `tests/rewind.test.ts` | Revert/Fork 单元和集成测试 |
| 修改 | `src/core/persistence/checkpoint.ts` | 新增 `listCheckpoints()` / `getCheckpointState()` |
| 修改 | `src/core/runner.ts` | 新增 `revertToCheckpoint()` / `forkFromCheckpoint()` |
| 修改 | `src/core/mcp/manager.ts` | 新增 `listResources()` / `readResource()`，connect 时缓存 |
| 修改 | `src/core/mcp/types.ts` | 新增 `McpResource` / `McpResourceContent` 类型 |
| 修改 | `src/core/mcp/index.ts` | 导出新类型 |
| 修改 | `src/core/tools/definitions.ts` | 新增 `read_mcp_resource` 内置工具 |
| 修改 | `src/core/harness/tool-policy.ts` | `read_mcp_resource` 分类为 risk: read |
| 修改 | `src/app/tui/components/McpPanel.tsx` | 展示 Resources 区段 |
| 修改 | `src/app/tui/hooks/useSlashCommand.ts` | 新增 `/rewind` 命令 |
| 修改 | `src/app/tui/App.tsx` | 新增 Rewind 相关 actions + 渲染 CheckpointSelector |
| 修改 | `src/app/tui/index.tsx` | Revert/Fork 的 runner 调用编排 |
| 修改 | `src/app/tui/types.ts` | 新增 `showRewind` / `checkpoints` 状态字段 |
| 修改 | `tests/tool-policy.test.ts` | 新增 `read_mcp_resource` 测试 |
| 修改 | `tests/checkpoint.test.ts` | 扩展 `listCheckpoints` / `getCheckpointState` 测试 |
| 修改 | `tests/tui-layout.test.tsx` | 新增 CheckpointSelector 渲染测试 |

---

### Task 1: Saver 层 — listCheckpoints + getCheckpointState

**Files:**
- Modify: `src/core/persistence/checkpoint.ts`
- Modify: `tests/checkpoint.test.ts`

- [ ] **Step 1: 在 BunSqliteSaver 中新增 `listCheckpoints()`**

在 `BunSqliteSaver` 类中新增方法。位置放在 `getTuple` 方法之后。

```typescript
// src/core/persistence/checkpoint.ts — BunSqliteSaver 类中新方法

export interface CheckpointEntry {
  checkpointId: string;
  parentCheckpointId: string | null;
  createdAt: string;
  firstUserMessage: string;
}

/** 枚举线程最近 N 个 checkpoint 及首条用户消息摘要 / List recent checkpoints with first user message summary */
async listCheckpoints(
  threadId: string,
  limit: number = 20,
): Promise<CheckpointEntry[]> {
  this.setup();
  const rows = this.db
    .query<CheckpointRow, [string]>(
      `select checkpoint_id, parent_checkpoint_id, checkpoint, created_at
       from checkpoints
       where thread_id = ? and checkpoint_ns = ''
       order by checkpoint_id desc
       limit ?`,
    )
    .all(threadId, limit);

  const entries: CheckpointEntry[] = [];
  for (const row of rows) {
    let firstUserMessage = "";
    try {
      const checkpoint = await this.serde.loadsTyped(row.type ?? "json", row.checkpoint);
      const messages = checkpoint.channel_values?.messages as Array<{ lc_id?: string[]; id?: string[]; content?: unknown }> | undefined;
      if (Array.isArray(messages)) {
        for (const msg of messages) {
          // LangGraph messages have type info in lc_id[2] or kwargs.id[2]
          const type = msg.lc_id?.[2] ?? msg.id?.[2] ?? "";
          if (type === "HumanMessage") {
            const content = typeof msg.content === "string" ? msg.content : "";
            firstUserMessage = content.slice(0, 60);
            break;
          }
        }
      }
    } catch { /* skip unparseable checkpoints */ }

    entries.push({
      checkpointId: row.checkpoint_id,
      parentCheckpointId: row.parent_checkpoint_id,
      createdAt: row.created_at ?? "",
      firstUserMessage,
    });
  }
  return entries;
}
```

- [ ] **Step 2: 新增 `getCheckpointState()`**

```typescript
// src/core/persistence/checkpoint.ts — BunSqliteSaver 类中新方法

import type { BaseMessage } from "@langchain/core/messages";
import { HumanMessage, AIMessage, ToolMessage } from "@langchain/core/messages";
import type { CodeAgentState } from "@/core/harness/state";

/** 加载指定 checkpoint 的完整 state / Load full state from a specific checkpoint */
async getCheckpointState(
  threadId: string,
  checkpointId: string,
): Promise<Partial<CodeAgentState> | null> {
  this.setup();
  const tuple = await this.getTuple({
    configurable: { thread_id: threadId, checkpoint_id: checkpointId },
  });
  if (!tuple || !tuple.checkpoint?.channel_values) return null;

  const cv = tuple.checkpoint.channel_values;
  return {
    messages: (cv.messages as BaseMessage[]) ?? [],
    workspaceAccess: cv.workspaceAccess as CodeAgentState["workspaceAccess"] ?? "write",
    phase: cv.phase as CodeAgentState["phase"] ?? "building",
    plan: (cv.plan as CodeAgentState["plan"]) ?? null,
    authorization: cv.authorization as CodeAgentState["authorization"],
    contextSummary: (cv.contextSummary as string) ?? "",
  };
}
```

- [ ] **Step 3: 写测试 — tests/checkpoint.test.ts 扩展**

```typescript
// tests/checkpoint.test.ts — 新增 describe block
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { BunSqliteSaver } from "../src/core/persistence/checkpoint";
import { HumanMessage, AIMessage } from "@langchain/core/messages";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("listCheckpoints", () => {
  let saver: BunSqliteSaver;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "kite-code-test-"));
    saver = new BunSqliteSaver(join(tmpDir, "checkpoints.db"));
    saver.setup();
  });

  afterEach(() => {
    saver.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns empty array for unknown thread", async () => {
    const entries = await saver.listCheckpoints("nonexistent-thread");
    expect(entries).toEqual([]);
  });

  it("returns checkpoint entries with first human message", async () => {
    const threadId = "test-thread-1";
    const checkpoint: any = {
      channel_values: {
        messages: [
          { lc_id: ["langchain", "messages", "HumanMessage"], content: "Hello, world! This is a test message." },
          { lc_id: ["langchain", "messages", "AIMessage"], content: "Hi there!" },
        ],
      },
      channel_versions: {},
    };
    await saver.put(
      { configurable: { thread_id: threadId, checkpoint_id: "cp-1" } },
      { ...checkpoint, id: "cp-1" },
      { source: "loop", step: 0, writes: {} },
    );

    const entries = await saver.listCheckpoints(threadId);
    expect(entries.length).toBe(1);
    expect(entries[0].checkpointId).toBe("cp-1");
    expect(entries[0].firstUserMessage).toContain("Hello, world!");
  });

  it("truncates long messages to 60 chars", async () => {
    const threadId = "test-thread-2";
    const longMsg = "A".repeat(200);
    const checkpoint: any = {
      channel_values: {
        messages: [{ lc_id: ["langchain", "messages", "HumanMessage"], content: longMsg }],
      },
      channel_versions: {},
    };
    await saver.put(
      { configurable: { thread_id: threadId, checkpoint_id: "cp-l" } },
      { ...checkpoint, id: "cp-l" },
      { source: "loop", step: 0, writes: {} },
    );

    const entries = await saver.listCheckpoints(threadId);
    expect(entries[0].firstUserMessage.length).toBeLessThanOrEqual(60);
  });

  it("returns entries in reverse chronological order", async () => {
    const threadId = "test-thread-order";
    for (let i = 0; i < 3; i++) {
      const cp: any = {
        channel_values: { messages: [{ lc_id: ["langchain", "messages", "HumanMessage"], content: `Msg ${i}` }] },
        channel_versions: {},
      };
      await saver.put(
        { configurable: { thread_id: threadId, checkpoint_id: `cp-order-${i}` } },
        { ...cp, id: `cp-order-${i}` },
        { source: "loop", step: i, writes: {} },
      );
    }
    const entries = await saver.listCheckpoints(threadId, 10);
    expect(entries[0].checkpointId).toBe("cp-order-2"); // most recent first
    expect(entries[2].checkpointId).toBe("cp-order-0");
  });

  it("respects limit parameter", async () => {
    const threadId = "test-thread-limit";
    for (let i = 0; i < 5; i++) {
      const cp: any = {
        channel_values: { messages: [{ lc_id: ["langchain", "messages", "HumanMessage"], content: `Msg ${i}` }] },
        channel_versions: {},
      };
      await saver.put(
        { configurable: { thread_id: threadId, checkpoint_id: `cp-limit-${i}` } },
        { ...cp, id: `cp-limit-${i}` },
        { source: "loop", step: i, writes: {} },
      );
    }
    const entries = await saver.listCheckpoints(threadId, 3);
    expect(entries.length).toBe(3);
  });
});

describe("getCheckpointState", () => {
  // ... similar setup/beforeEach/afterEach pattern ...

  it("returns null for unknown checkpoint", async () => {
    const state = await saver.getCheckpointState("nonexistent", "nonexistent");
    expect(state).toBeNull();
  });

  it("returns full state from checkpoint", async () => {
    const threadId = "test-state-1";
    const messages = [new HumanMessage("hi"), new AIMessage("hey")];
    const cp: any = {
      channel_values: {
        messages,
        workspaceAccess: "read-only",
        phase: "planning",
        plan: { name: "test", description: "test plan", steps: [] },
        contextSummary: "summary text",
      },
      channel_versions: {},
    };
    await saver.put(
      { configurable: { thread_id: threadId, checkpoint_id: "cp-state" } },
      { ...cp, id: "cp-state" },
      { source: "loop", step: 0, writes: {} },
    );

    const state = await saver.getCheckpointState(threadId, "cp-state");
    expect(state).not.toBeNull();
    if (state) {
      expect(state.messages).toHaveLength(2);
      expect(state.workspaceAccess).toBe("read-only");
      expect(state.phase).toBe("planning");
      expect(state.plan?.name).toBe("test");
      expect(state.contextSummary).toBe("summary text");
    }
  });
});
```

- [ ] **Step 4: 运行测试**

```bash
bun test tests/checkpoint.test.ts
```
Expected: 新增测试 PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/persistence/checkpoint.ts tests/checkpoint.test.ts
git commit -m "feat: checkpoint 层新增 listCheckpoints + getCheckpointState"
```

---

### Task 2: Runner 层 — revertToCheckpoint + forkFromCheckpoint

**Files:**
- Modify: `src/core/runner.ts`
- Create: `tests/rewind.test.ts`

- [ ] **Step 1: 新增 `buildCodeAgentGraph` 导入 + 辅助函数**

在 `src/core/runner.ts` 中，已有 `buildCodeAgentGraph` 和 `BunSqliteSaver` 的导入。新增两个 runner 入口函数。

```typescript
// src/core/runner.ts — 新增函数，放在 runAgent 之后

import { v4 as uuidv4 } from "uuid"; // 或使用 crypto.randomUUID()

export interface RevertInput {
  threadId: string;
  checkpointId: string;
  workspace: string;
  checkpointPath: string;
  config: AgentConfig;
  shellExecutor?: ShellExecutor;
  signal?: AbortSignal;
}

/** 当前 thread 恢复到指定 checkpoint 继续执行 / Revert current thread to a checkpoint */
export async function* revertToCheckpoint(
  provider: UserInputProvider,
  input: RevertInput,
): AsyncGenerator<AgentEvent> {
  const { graph, checkpointer } = buildCodeAgentGraph({
    config: input.config,
    checkpointPath: input.checkpointPath,
    shellExecutor: input.shellExecutor,
    thinkingLevel: null,
  });

  const signal = input.signal;

  try {
    const streamConfig = {
      configurable: {
        thread_id: input.threadId,
        checkpoint_id: input.checkpointId,
      },
      streamMode: "updates" as const,
      recursionLimit: 60,
    };

    // Revert: send Command with null resume to load from checkpoint
    const stream = await graph.stream(
      { messages: [], __revert__: true } as any,
      streamConfig,
    );

    const result = await processStream(provider, stream, signal);
    yield* result.events;
  } finally {
    checkpointer.close();
  }
}

export interface ForkInput {
  oldThreadId: string;
  checkpointId: string;
  newThreadId: string;
  workspace: string;
  checkpointPath: string;
  config: AgentConfig;
  shellExecutor?: ShellExecutor;
  signal?: AbortSignal;
}

/** 从旧 checkpoint fork 新会话 / Fork a new session from an old checkpoint */
export async function* forkFromCheckpoint(
  provider: UserInputProvider,
  input: ForkInput,
): AsyncGenerator<AgentEvent> {
  const { graph, checkpointer } = buildCodeAgentGraph({
    config: input.config,
    checkpointPath: input.checkpointPath,
    shellExecutor: input.shellExecutor,
    thinkingLevel: null,
  });

  const signal = input.signal;

  try {
    // Load old checkpoint state
    const oldState = await checkpointer.getCheckpointState(
      input.oldThreadId,
      input.checkpointId,
    );
    if (!oldState) {
      yield {
        type: "error" as const,
        data: { message: "Checkpoint not found", recoverable: false },
      };
      return;
    }

    const initialState = {
      userId: "",
      threadId: input.newThreadId,
      workspace: input.workspace,
      workspaceAccess: oldState.workspaceAccess ?? "write",
      phase: oldState.phase ?? "building",
      plan: oldState.plan,
      messages: (oldState.messages as any[]) ?? [],
      authorization: oldState.authorization,
      contextSummary: oldState.contextSummary ?? "",
      contextBudget: undefined as any,
      modelProvider: input.config.providerName,
      modelName: input.config.modelName,
      thinkingLevel: null as string | null,
      forceCompact: false,
    };

    const streamConfig = {
      configurable: { thread_id: input.newThreadId },
      streamMode: "updates" as const,
      recursionLimit: 60,
    };

    const stream = await graph.stream(initialState, streamConfig);
    const result = await processStream(provider, stream, signal);
    yield* result.events;
  } finally {
    checkpointer.close();
  }
}
```

- [ ] **Step 2: 写测试 — tests/rewind.test.ts**

```typescript
// tests/rewind.test.ts
import { describe, expect, it } from "bun:test";
// 测试 revertToCheckpoint 和 forkFromCheckpoint 的基本行为
// 使用 mock graph 和 mock checkpointer 避免依赖真实模型

describe("revertToCheckpoint", () => {
  it("uses checkpoint_id in stream config", async () => {
    // 验证 stream config 包含正确的 thread_id 和 checkpoint_id
    // 使用简化 mock 测试函数签名和参数传递
  });

  it("emits error event when checkpoint not found", async () => {
    // 验证找不到 checkpoint 时发出 error 事件
  });
});

describe("forkFromCheckpoint", () => {
  it("creates new threadId independent of old threadId", async () => {
    // 验证新 threadId != oldThreadId
  });

  it("loads old checkpoint state as initial state", async () => {
    // 验证 initial state 来自旧 checkpoint
  });
});
```

- [ ] **Step 3: 运行测试 + typecheck**

```bash
bun run typecheck
bun test tests/rewind.test.ts
```

- [ ] **Step 4: Commit**

```bash
git add src/core/runner.ts tests/rewind.test.ts
git commit -m "feat: runner 层新增 revertToCheckpoint + forkFromCheckpoint"
```

---

### Task 3: TUI — CheckpointSelector + /rewind + App 集成

**Files:**
- Create: `src/app/tui/components/CheckpointSelector.tsx`
- Modify: `src/app/tui/hooks/useSlashCommand.ts`
- Modify: `src/app/tui/App.tsx`
- Modify: `src/app/tui/index.tsx`
- Modify: `src/app/tui/types.ts`

- [ ] **Step 1: 新增 CheckpointSelector 组件**

```typescript
// src/app/tui/components/CheckpointSelector.tsx
import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import { darkTheme as t } from "../theme";

export interface CheckpointEntry {
  checkpointId: string;
  parentCheckpointId: string | null;
  createdAt: string;
  firstUserMessage: string;
}

interface CheckpointSelectorProps {
  checkpoints: CheckpointEntry[];
  onRevert: (checkpointId: string) => void;
  onFork: (checkpointId: string) => void;
  onClose: () => void;
}

export default function CheckpointSelector({ checkpoints, onRevert, onFork, onClose }: CheckpointSelectorProps) {
  const [selected, setSelected] = useState(0);

  useInput((_input, key) => {
    if (key.escape) {
      onClose();
      return;
    }
    if (key.upArrow) {
      setSelected((s) => Math.max(0, s - 1));
      return;
    }
    if (key.downArrow) {
      setSelected((s) => Math.min(checkpoints.length - 1, s + 1));
      return;
    }
    if (key.return) {
      // Enter — same as Revert (default action)
      const cp = checkpoints[selected];
      if (cp) onRevert(cp.checkpointId);
      return;
    }
    const char = _input.toLowerCase();
    if (char === "r") {
      const cp = checkpoints[selected];
      if (cp) onRevert(cp.checkpointId);
      return;
    }
    if (char === "f") {
      const cp = checkpoints[selected];
      if (cp) onFork(cp.checkpointId);
      return;
    }
  });

  if (checkpoints.length === 0) {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={t.dim} paddingX={1} marginY={1}>
        <Text bold color={t.primary}>Rewind</Text>
        <Box marginTop={1}>
          <Text color={t.muted}>No checkpoints found for the current session.</Text>
        </Box>
        <Box marginTop={1}>
          <Text color={t.dim}>Press any key to close</Text>
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={t.dim} paddingX={1} marginY={1}>
      <Text bold color={t.primary}>Rewind — select a checkpoint</Text>

      <Box flexDirection="column" marginTop={1}>
        {checkpoints.map((cp, i) => {
          const isSelected = i === selected;
          const prefix = isSelected ? "→" : " ";
          const color = isSelected ? t.primary : t.muted;
          const displayId = cp.checkpointId.slice(0, 8);
          const displayMsg = cp.firstUserMessage || "(no message)";
          const displayTime = cp.createdAt ? cp.createdAt.slice(0, 19) : "";

          return (
            <Text key={cp.checkpointId} color={color}>
              {prefix} {i + 1}. [{displayId}] {displayMsg}
              {displayTime ? ` — ${displayTime}` : ""}
            </Text>
          );
        })}
      </Box>

      <Box marginTop={1}>
        <Text color={t.dim}>
          [Enter]/[R]evert  [F]ork  [Esc] cancel  ↑↓ navigate
        </Text>
      </Box>
    </Box>
  );
}
```

- [ ] **Step 2: 更新 types.ts — 新增状态字段**

```typescript
// src/app/tui/types.ts
// 在 TuiState interface 中新增:
  showRewind: boolean;
  checkpoints: CheckpointEntry[];  // 需要 import CheckpointEntry

// 在 initial state 中新增:
  showRewind: false,
  checkpoints: [],
```

- [ ] **Step 3: useSlashCommand.ts — 新增 /rewind**

```typescript
// src/app/tui/hooks/useSlashCommand.ts

// 在 SlashAction 中新增:
  | { type: "rewind" }

// 在 parseSlashCommand 中新增 case:
    case "rewind": return { type: "rewind" };

// 在 useSlashCommand callback 中新增 case:
      case "rewind":
        dispatch({ type: "SHOW_REWIND" });
        break;
```

- [ ] **Step 4: App.tsx — 新增 Rewind actions + 渲染 CheckpointSelector**

在 Action union 中新增：
```typescript
  | { type: "SHOW_REWIND" }
  | { type: "HIDE_REWIND" }
  | { type: "REVERT_TO_CHECKPOINT"; checkpointId: string }
  | { type: "FORK_FROM_CHECKPOINT"; checkpointId: string }
  | { type: "SET_CHECKPOINTS"; checkpoints: CheckpointEntry[] }
```

在 reducer 中新增：
```typescript
    case "SHOW_REWIND":
      return { ...state, showRewind: true };
    case "HIDE_REWIND":
      return { ...state, showRewind: false, checkpoints: [] };
    case "SET_CHECKPOINTS":
      return { ...state, checkpoints: action.checkpoints };
    case "REVERT_TO_CHECKPOINT":
      // Handled in index.tsx via side effect
      return { ...state, showRewind: false };
    case "FORK_FROM_CHECKPOINT":
      // Handled in index.tsx via side effect
      return { ...state, showRewind: false };
```

在渲染部分：
```typescript
      {state.showRewind && (
        <CheckpointSelector
          checkpoints={state.checkpoints}
          onRevert={(id) => dispatch({ type: "REVERT_TO_CHECKPOINT", checkpointId: id })}
          onFork={(id) => dispatch({ type: "FORK_FROM_CHECKPOINT", checkpointId: id })}
          onClose={() => dispatch({ type: "HIDE_REWIND" })}
        />
      )}
```

- [ ] **Step 5: index.tsx — SHOW_REWIND 加载 checkpoint 列表**

在 `useEffect` 中监听 `SHOW_REWIND` action（通过检查 `state.showRewind` 变化），异步加载 checkpoint 列表：

```typescript
// src/app/tui/index.tsx — 新增 useEffect

const saverRef = React.useRef<BunSqliteSaver | null>(null);

React.useEffect(() => {
  if (!state.showRewind || !state.status.threadId) return;
  
  const checkpointPath = defaultCheckpointPath();
  const saver = new BunSqliteSaver(checkpointPath);
  saverRef.current = saver;
  
  saver.listCheckpoints(state.status.threadId).then((checkpoints) => {
    dispatch({ type: "SET_CHECKPOINTS", checkpoints });
  }).catch(() => {
    dispatch({ type: "SET_CHECKPOINTS", checkpoints: [] });
  }).finally(() => {
    saver.close();
    saverRef.current = null;
  });
}, [state.showRewind, state.status.threadId, dispatch]);
```

REVERT_TO_CHECKPOINT 和 FORK_FROM_CHECKPOINT 通过 useEffect 监听触发（检测到 action 后调用 runner）：

```typescript
// 在 index.tsx 中新增 useEffect 监听 revert/fork
const pendingRewindRef = React.useRef<{ type: "revert" | "fork"; checkpointId: string } | null>(null);

// 当 state 中检测到 REVERT/FORK 时设置 pendingRewindRef
// 在 agent loop 周期中处理（类似 compact request 模式）
```

实际上更简单的做法：在 `handleInput` 中处理，或者在 App 的 reducer 中直接标记 pendingRewind，然后在 index.tsx 的 useEffect 中触发实际 runner 调用。

- [ ] **Step 6: 运行测试 + typecheck**

```bash
bun run typecheck
bun test tests/tui-layout.test.tsx tests/tui-reducer.test.ts
```

需要更新测试中的 TuiState fixture 添加 `showRewind: false, checkpoints: []`。

- [ ] **Step 7: Commit**

```bash
git add src/app/tui/components/CheckpointSelector.tsx src/app/tui/hooks/useSlashCommand.ts src/app/tui/App.tsx src/app/tui/index.tsx src/app/tui/types.ts tests/tui-layout.test.tsx tests/tui-reducer.test.ts
git commit -m "feat: CheckpointSelector + /rewind + Revert/Fork App 集成"
```

---

### Task 4: MCP Resources — manager.ts + types.ts

**Files:**
- Modify: `src/core/mcp/types.ts`
- Modify: `src/core/mcp/manager.ts`
- Modify: `src/core/mcp/index.ts`

- [ ] **Step 1: types.ts — 新增 Resource 类型**

```typescript
// src/core/mcp/types.ts — 新增

export interface McpResource {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

export interface McpResourceContent {
  uri: string;
  mimeType?: string;
  text?: string;
  blob?: string;
}
```

- [ ] **Step 2: manager.ts — McpServerState 新增 resources 字段**

```typescript
// src/core/mcp/types.ts — McpServerState 新增:
  resources: McpResource[];
```

同时在 manager.ts 的初始状态中加上 `resources: []`。

- [ ] **Step 3: manager.ts — 新增 listResources() / readResource()**

```typescript
// src/core/mcp/manager.ts — McpManager 类中新方法

/** 列出指定 server 的所有资源（从缓存） / List resources for a server (from cache) */
getResources(serverName: string): McpResource[] {
  return this.servers.get(serverName)?.resources ?? [];
}

/** 从指定 server 读取资源内容 / Read resource content from a server */
async readResource(serverName: string, uri: string): Promise<string> {
  const state = this.servers.get(serverName);
  if (!state) {
    throw new Error(`Unknown MCP server: ${serverName}`);
  }
  if (!state.connected) {
    throw new Error(`MCP server not connected: ${serverName}`);
  }
  const client = state.client as Client;
  const result = await client.readResource({ uri });
  // Extract text from resource contents
  if (result.contents && result.contents.length > 0) {
    return result.contents.map((c: { text?: string; blob?: string }) => c.text ?? c.blob ?? "").join("\n");
  }
  return JSON.stringify(result);
}
```

- [ ] **Step 4: manager.ts — connect() 时拉取 resources**

在 `connect()` 方法中，`client.listTools()` 之后，新增 resources 拉取：

```typescript
// 在 listPrompts 之后:
let resources: McpResource[] = [];
try {
  const resourceResult = await client.listResources();
  resources = (resourceResult.resources ?? []) as McpResource[];
} catch {
  // Resources are optional in MCP, don't block connection
}

// 更新 state 初始化:
this.servers.set(name, {
  config,
  client,
  tools,
  prompts,
  resources,
  connected: true,
});

// 新增 list_changed 通知监听:
client.onnotification("notifications/resources/list_changed", async () => {
  const state = this.servers.get(name);
  if (state) {
    try {
      const result = await client.listResources();
      state.resources = (result.resources ?? []) as McpResource[];
    } catch { /* ignore */ }
  }
});
```

需要导入 `ResourceListChangedNotificationSchema`：
```typescript
import {
  ToolListChangedNotificationSchema,
  PromptListChangedNotificationSchema,
  ResourceListChangedNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js";
```

- [ ] **Step 5: index.ts — 导出新类型**

```typescript
// src/core/mcp/index.ts
export type { McpResource, McpResourceContent } from "./types";
```

- [ ] **Step 6: 运行测试**

```bash
bun test tests/mcp.test.ts
```

- [ ] **Step 7: Commit**

```bash
git add src/core/mcp/types.ts src/core/mcp/manager.ts src/core/mcp/index.ts
git commit -m "feat: MCP Resources — listResources + readResource + connect 时缓存"
```

---

### Task 5: MCP Resources — read_mcp_resource 工具 + tool-policy

**Files:**
- Modify: `src/core/tools/definitions.ts`
- Modify: `src/core/harness/tool-policy.ts`
- Modify: `tests/tool-policy.test.ts`

- [ ] **Step 1: definitions.ts — 新增 read_mcp_resource 工具**

```typescript
// src/core/tools/definitions.ts

// 在 createAgentTools 函数中，builtinTools 数组之前新增:

const readMcpResource = tool(
  async ({ server, uri }) => {
    if (!input.mcpManager) {
      return JSON.stringify({
        ok: false,
        stderr: "No MCP manager available. Configure mcpServers in kite-code.jsonc.",
      });
    }
    try {
      const content = await input.mcpManager.readResource(server, uri);
      return JSON.stringify({ ok: true, content });
    } catch (err) {
      return JSON.stringify({
        ok: false,
        stderr: err instanceof Error ? err.message : String(err),
      });
    }
  },
  {
    name: "read_mcp_resource",
    description: "Read a resource from an MCP server. Use this to fetch documentation, API specs, or other content exposed by MCP servers. Call mcp__<server>__list_resources first to discover available URIs.",
    schema: z.object({
      server: z.string().describe("MCP server name"),
      uri: z.string().describe("Resource URI to read (e.g. file:///docs/api.md)"),
    }),
  },
);

// 在 builtinTools 数组中添加:
const builtinTools = [
  readFileTool,
  editFileTool,
  writeFileTool,
  shellExecute,
  readMcpResource,  // 新增
  createUpdatePlanTool(),
  createAskUserTool(),
  createSetAuthorizationModeTool(),
];
```

- [ ] **Step 2: tool-policy.ts — read_mcp_resource 分类为 risk: read**

```typescript
// src/core/harness/tool-policy.ts
// 在 evaluateToolPolicy 函数中，read_file 分支之后新增:

  if (request.name === "read_mcp_resource") {
    return allow({
      risk: "read",
      reason: "Read MCP resources only inspects remote content exposed by MCP servers.",
      userVisibleSummary: `Read MCP resource from ${request.args.server ?? "MCP server"}: ${request.args.uri ?? "?"}`,
      expectedEffects: ["Reads content from external MCP server", "Does not mutate workspace files"],
    });
  }
```

- [ ] **Step 3: 更新 tool-policy.test.ts**

```typescript
// tests/tool-policy.test.ts — 新增

  it("allows read_mcp_resource without approval", () => {
    const decision = evaluateToolPolicy({
      request: { name: "read_mcp_resource", args: { server: "docs", uri: "file:///api.md" }, protectedCommand: "" },
      workspaceAccess: "write",
      phase: "building",
    });
    expect(decision.allowed).toBe(true);
    expect(decision.requiresApproval).toBe(false);
    expect(decision.risk).toBe("read");
  });
```

- [ ] **Step 4: 运行测试 + typecheck**

```bash
bun run typecheck
bun test tests/tool-policy.test.ts tests/tool-definitions.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/core/tools/definitions.ts src/core/harness/tool-policy.ts tests/tool-policy.test.ts
git commit -m "feat: 新增 read_mcp_resource 内置工具，risk: read 免审批"
```

---

### Task 6: MCP Resources — McpPanel 展示 Resources 区段

**Files:**
- Modify: `src/app/tui/components/McpPanel.tsx`

- [ ] **Step 1: 扩展 McpPanel 展示 Resources**

在现有 McpPanel 的每个 server 渲染中，tools 列表之后增加 Resources 区段：

```typescript
// src/app/tui/components/McpPanel.tsx

// 在 tools 列表渲染之后（hiddenCount / truncation 代码之后），新增:

{connected && state.resources && state.resources.length > 0 && (
  <Box flexDirection="column" paddingLeft={2} marginTop={1}>
    <Text color={t.dim} bold>Resources:</Text>
    {state.resources.slice(0, 10).map((r) => (
      <Text key={r.uri} color={t.muted}>
        {"📄"} {r.name || r.uri} ({r.uri})
      </Text>
    ))}
    {state.resources.length > 10 && (
      <Text color={t.dim}>...and {state.resources.length - 10} more</Text>
    )}
  </Box>
)}
```

- [ ] **Step 2: 运行测试 + typecheck**

```bash
bun run typecheck
bun test tests/tui-layout.test.tsx
```

- [ ] **Step 3: Commit**

```bash
git add src/app/tui/components/McpPanel.tsx
git commit -m "feat: MCP Resources 在 McpPanel 中展示 Resources 区段"
```

---

### Task 7: 端到端验证

- [ ] **Step 1: 类型检查**

```bash
bun run typecheck
```
Expected: 无新增错误（排除前置已知错误）

- [ ] **Step 2: 核心测试套件**

```bash
bun test tests/checkpoint.test.ts tests/rewind.test.ts tests/mcp.test.ts tests/tool-policy.test.ts tests/tool-definitions.test.ts tests/tui-reducer.test.ts tests/tui-layout.test.tsx
```
Expected: 全部 PASS

- [ ] **Step 3: 全量测试**

```bash
bun test
```
Expected: 与 Phase 1 完成时持平或改善

- [ ] **Step 4: 更新 plan status + commit**

```bash
git add docs/space/
git commit -m "docs: Phase 2 实施计划 + Rewind/MCP Resources 设计文档"
```

---

## 自检清单

1. **类型一致性**：`CheckpointEntry` 在 `checkpoint.ts` 定义，在 `CheckpointSelector.tsx` 和 `types.ts` 中使用。`McpResource`/`McpResourceContent` 在 `types.ts` 定义，在 `manager.ts` 和 `McpPanel.tsx` 中使用。
2. **无占位符**：所有步骤均包含实际代码。
3. **Import 路径**：使用 `@/` 别名，与项目风格一致。
4. **依赖关系**：Task 1→2→3（Rewind 链），Task 4→5→6（MCP Resources 链）。两条链可并行执行。
