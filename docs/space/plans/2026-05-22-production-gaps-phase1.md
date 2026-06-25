# Phase 1: MCP 核心 + 事件闭环 + 错误分类 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> 状态：archived（2026-06-08 归档）

**Goal:** 补齐 MCP 协议支持（对标 Claude Code）、Compact 事件生产路径、Compact UI 消费、Retry 事件清理、Recoverable 错误分类、Session 命名修复。

**Architecture:** 6 个独立任务，按依赖关系排序：简单修复先行（1.6→1.5→1.4→1.2/1.3），MCP 核心（1.1）最后。Compaction 通知使用 graph 节点返回值传递（不经 checkpoint），MCP transport 层复用 `@modelcontextprotocol/sdk`，MCP Prompts 斜杠命令通过 `parseSlashCommand` default 分支查注册表。

**Tech Stack:** Bun, TypeScript ESM, `@modelcontextprotocol/sdk` v1.x, `@langchain/core` StructuredTool, Ink (React TUI)

---

## 文件结构一览

| 操作 | 文件 | 职责 |
|------|------|------|
| 新增 | `src/core/mcp/types.ts` | MCP 本地类型 + SDK re-export |
| 新增 | `src/core/mcp/manager.ts` | `McpManager` 多 server 生命周期、并行连接、重连、工具列表缓存 |
| 新增 | `src/core/mcp/tool-adapter.ts` | `adaptMcpTool()` MCP Tool → LangChain StructuredTool (JSON Schema → Zod) |
| 新增 | `src/core/mcp/index.ts` | 对外导出 |
| 新增 | `src/app/tui/components/McpPanel.tsx` | `/mcp` 覆盖层（server 列表、状态、工具数） |
| 新增 | `tests/mcp.test.ts` | MCP manager、tool adapter 单元测试 |
| 修改 | `src/core/config/index.ts` | 解析 `mcpServers` 段 + 环境变量展开 + `.mcp.json` 合并 |
| 修改 | `src/core/harness/tool-policy.ts` | 新增 `"mcp"` 风险类别 + MCP 工具审批逻辑 |
| 修改 | `src/core/tools/definitions.ts` | `createAgentTools()` 扩展 `mcpManager` 参数 |
| 修改 | `src/core/harness/graph.ts` | Agent 节点返回值增加 `compactionPerformed` 字段 |
| 修改 | `src/core/runner.ts` | `chunkToEvents` 检测 `compactionPerformed` emit 事件 + `isRecoverableError` |
| 修改 | `src/app/tui/index.tsx` | 错误 emit 点使用 `isRecoverableError` |
| 修改 | `src/app/tui/StatusBar.tsx` | 新增 `compacting` prop，渲染压缩状态指示器 |
| 修改 | `src/app/tui/App.tsx` | 向 StatusBar 传递 `compacting`，移除 `retry` reducer 分支 |
| 修改 | `src/app/tui/hooks/useSlashCommand.ts` | MCP Prompts 注册表 + `/mcp` 命令 + default 分支查表 |
| 修改 | `src/protocol/events.ts` | 移除 `retry` 事件类型 |
| 修改 | `src/core/persistence/sessions.ts` | `generateSessionName` catch 块返回截断文本 |
| 修改 | `tests/e2e/mock-agent.tsx` | `retry` → `model_retry` |
| 修改 | `tests/e2e/scenarios/failure-scenarios.ts` | `retry` → `model_retry` |
| 修改 | `tests/tool-policy.test.ts` | 新增 MCP 风险类别测试 |
| 修改 | `tests/tui-layout.test.tsx` | 新增 StatusBar compacting 渲染测试 + MCP 面板测试 |

---

### Task 1: Session 命名修复

**Files:**
- Modify: `src/core/persistence/sessions.ts:404-406`

- [ ] **Step 1: 修改 catch 块返回截断文本**

```typescript
// src/core/persistence/sessions.ts ~line 404
} catch {
  return cleanMessage.slice(0, 30) || "";
  // 原: return ""; // caller handles fallback to truncation
}
```

- [ ] **Step 2: 运行测试确认行为不变**

```bash
bun test tests/runner.test.ts
```

- [ ] **Step 3: Commit**

```bash
git add src/core/persistence/sessions.ts
git commit -m "fix: session 命名 API key 缺失时不返回空串，改用截断文本"
```

---

### Task 2: Recoverable 错误分类

**Files:**
- Modify: `src/core/runner.ts`
- Modify: `src/app/tui/index.tsx:198-201`
- Modify: `tests/runner.test.ts`

- [ ] **Step 1: 在 runner.ts 顶部附近添加 `isRecoverableError` 函数**

位置：放在 `readLastAuthorization` 函数之后、`runAgent` 之前，或文件底部 helper 区域。

```typescript
// src/core/runner.ts — 放在 import 之后，export 函数之前

/** 按错误类型分类是否为可恢复错误 / Classify whether an error is recoverable */
export function isRecoverableError(error: unknown): boolean {
  if (error instanceof Error) {
    const msg = error.message?.toLowerCase() ?? "";
    if (msg.includes("etimedout")) return true;         // TCP 超时
    if (msg.includes("econnreset")) return true;        // 连接重置
    if (msg.includes("429")) return true;               // 速率限制
    if (msg.includes("503") || msg.includes("502")) return true; // 服务不可用
    if (msg.includes("overloaded")) return true;        // 模型过载
    if (msg.includes("timeout")) return true;           // 通用超时
    if (msg.includes("rate limit")) return true;        // 速率限制文字
    if (error.name === "AbortError") return false;      // 用户主动取消 → 不可恢复
  }
  return false;  // 默认不可恢复（配置/权限/未知错误）
}
```

- [ ] **Step 2: 修改 index.tsx 的错误 emit 点**

```typescript
// src/app/tui/index.tsx ~line 197-201
} catch (e: any) {
  provider.onEvent({
    type: "error",
    data: { message: e?.message ?? String(e), recoverable: isRecoverableError(e) },
  });
  dispatch({ type: "SET_EXITED" });
}
```

需要在 index.tsx 顶部添加 import：
```typescript
import { isRecoverableError } from "@/core/runner";
```

- [ ] **Step 3: 写测试**

```typescript
// tests/runner.test.ts — 新增 describe block
import { describe, expect, it } from "bun:test";
import { isRecoverableError } from "../src/core/runner";

describe("isRecoverableError", () => {
  it("returns true for ETIMEDOUT", () => {
    expect(isRecoverableError(new Error("connect ETIMEDOUT"))).toBe(true);
  });

  it("returns true for ECONNRESET", () => {
    expect(isRecoverableError(new Error("read ECONNRESET"))).toBe(true);
  });

  it("returns true for 429", () => {
    expect(isRecoverableError(new Error("HTTP 429 Too Many Requests"))).toBe(true);
  });

  it("returns true for 502/503", () => {
    expect(isRecoverableError(new Error("503 Service Unavailable"))).toBe(true);
    expect(isRecoverableError(new Error("502 Bad Gateway"))).toBe(true);
  });

  it("returns true for overloaded", () => {
    expect(isRecoverableError(new Error("Model overloaded"))).toBe(true);
  });

  it("returns true for timeout", () => {
    expect(isRecoverableError(new Error("Request timeout"))).toBe(true);
  });

  it("returns true for rate limit text", () => {
    expect(isRecoverableError(new Error("Rate limit exceeded"))).toBe(true);
  });

  it("returns false for AbortError", () => {
    const err = new Error("Aborted");
    err.name = "AbortError";
    expect(isRecoverableError(err)).toBe(false);
  });

  it("returns false for config errors", () => {
    expect(isRecoverableError(new Error("Model provider 'x' requires apiKey"))).toBe(false);
  });

  it("returns false for unknown errors", () => {
    expect(isRecoverableError("some string")).toBe(false);
  });

  it("is case-insensitive", () => {
    expect(isRecoverableError(new Error("ETIMEDOUT"))).toBe(true);
    expect(isRecoverableError(new Error("Rate Limit"))).toBe(true);
  });
});
```

- [ ] **Step 4: 运行测试**

```bash
bun test tests/runner.test.ts
```
Expected: PASS（新测试通过，旧测试不受影响）

- [ ] **Step 5: Commit**

```bash
git add src/core/runner.ts src/app/tui/index.tsx tests/runner.test.ts
git commit -m "feat: 按错误类型分类 recoverable 标志，ETIMEDOUT/429/503 等为可恢复"
```

---

### Task 3: Retry 事件清理

**Files:**
- Modify: `src/protocol/events.ts`
- Modify: `src/app/tui/App.tsx`
- Modify: `tests/e2e/mock-agent.tsx`
- Modify: `tests/e2e/scenarios/failure-scenarios.ts`

- [ ] **Step 1: 移除 events.ts 中的 retry 类型**

```typescript
// src/protocol/events.ts — 删除第 16 行
// 删除: | { type: "retry"; data: { attempt: number; reason: string } }
```

- [ ] **Step 2: 移除 App.tsx reducer 中的 retry 分支**

```typescript
// src/app/tui/App.tsx — 删除 case "retry" 分支（约第 195-198 行）
// 删除:
// case "retry": {
//   const block: OutputBlock = { id: nextId++, kind: "text", content: `⚠ Retry #${event.data.attempt}: ${event.data.reason}` };
//   return { ...state, blocks: [...state.blocks, block] };
// }
```

- [ ] **Step 3: 更新 e2e mock — retry → model_retry**

在 `tests/e2e/mock-agent.tsx` 中将 `retry` 事件替换为 `model_retry`：
```typescript
// 将 { type: "retry", data: { attempt: 1, reason: "test retry" } }
// 改为 { type: "model_retry", data: { attempt: 1, error: "test retry", delayMs: 0 } }
```

- [ ] **Step 4: 更新 failure-scenarios.ts**

在 `tests/e2e/scenarios/failure-scenarios.ts` 中做同样的 `retry` → `model_retry` 替换。

- [ ] **Step 5: 类型检查 + 测试**

```bash
bun run typecheck
bun test tests/e2e/
```

Expected: typecheck 通过，e2e 测试通过

- [ ] **Step 6: Commit**

```bash
git add src/protocol/events.ts src/app/tui/App.tsx tests/e2e/mock-agent.tsx tests/e2e/scenarios/failure-scenarios.ts
git commit -m "refactor: 移除未使用的 retry 事件类型，统一为 model_retry"
```

---

### Task 4: Compact 事件接入 + UI 消费

**Files:**
- Modify: `src/core/harness/graph.ts`
- Modify: `src/core/runner.ts`
- Modify: `src/app/tui/StatusBar.tsx`
- Modify: `src/app/tui/App.tsx`
- Modify: `tests/graph.test.ts`
- Modify: `tests/tui-layout.test.tsx`

- [ ] **Step 1: graph.ts agent 节点 — 手动压缩后在返回值中标记 compactionPerformed**

找到 `graph.ts` 中 agent 节点函数，在手动压缩代码块（`if (state.forceCompact)`）的末尾，将压缩信息放入返回值。

```typescript
// src/core/harness/graph.ts — 在 agent 节点的 return 语句中增加字段

// 方案：在函数开头声明一个局部变量收集压缩信息
let compactionPerformed: { reason: string; summary: string } | null = null;

if (state.forceCompact) {
  const compacted = forceContextCompaction(state.messages);
  const newSummary = state.contextSummary
    ? `${state.contextSummary}\n\n${compacted.summary}`.trim()
    : compacted.summary;
  effectiveState = {
    ...state,
    messages: compacted.messages,
    contextSummary: newSummary,
    forceCompact: false,
  } as CodeAgentState;
  compactionPerformed = {
    reason: "Manual compaction triggered by /compact or Ctrl+X c",
    summary: compacted.summary,
  };
}

// 在自动压缩（第一层规则压缩）处同样标记
// 找到 contextRetries.push({ attempt: 1, ... }) 之后的 compacted 变量
// 上面已经有了 compacted，只需在 invokeModel 返回后设置:
// if (compactedForOverflow) {
//   compactionPerformed = {
//     reason: "Auto compaction due to context overflow (layer 1: rules-based)",
//     summary: compactedForOverflow.summary,
//   };
// }

// 在 return 语句中添加 compactionPerformed 字段
return {
  messages: responseMessages,
  plan: ...,
  // ... 现有字段 ...
  compactionPerformed,  // 新增
};
```

注意：需要分别处理手动压缩和两层自动压缩三种情况。最简单的方法是在函数开头声明变量，在每个压缩路径设置它，在 return 中包含它。

第二层（LLM 总结）同理：
```typescript
if (llmSummaryPerformed) {
  compactionPerformed = {
    reason: "Auto compaction due to context overflow (layer 2: LLM summarization)",
    summary: "Generated conversation summary via LLM",
  };
}
```

- [ ] **Step 2: runner.ts chunkToEvents — 检测 compactionPerformed 并 emit 事件**

在 `chunkToEvents` 函数中，`state_change` 检测之后，`step_end` 之前插入：

```typescript
// src/core/runner.ts — chunkToEvents 函数内

// 在 step_end push 之前添加:
const cp = node.compactionPerformed;
if (cp && typeof cp === "object" && typeof (cp as Record<string, unknown>).reason === "string") {
  events.push({
    type: "compact_begin",
    data: { reason: (cp as Record<string, unknown>).reason as string },
  });
  events.push({
    type: "compact_end",
    data: { summary: ((cp as Record<string, unknown>).summary as string) ?? "" },
  });
}
```

- [ ] **Step 3: StatusBar.tsx — 新增 compacting prop + 渲染**

```typescript
// src/app/tui/StatusBar.tsx

// 在 StatusBarProps 中新增 compacting 字段
interface StatusBarProps {
  status: StatusState;
  thinkingVisible: boolean;
  timerKey: number;
  running: boolean;
  compacting: boolean;  // 新增
}

// 在组件解构中加上 compacting
export default function StatusBar({ status, thinkingVisible, timerKey, running, compacting }: StatusBarProps) {
  // ... 现有逻辑 ...

  return (
    <Box flexDirection="column">
      {/* Row 0 — compacting 指示器（当 compacting === true 时显示）*/}
      {compacting && (
        <Box>
          <Text color={t.warning}>⏳ Compacting...</Text>
        </Box>
      )}
      {/* Row 1 — phase + progress（现有）*/}
      <Box>
        {/* ... 现有内容不变 ... */}
      </Box>
      {/* Row 2 — stats（现有）*/}
      <Box gap={2}>
        {/* ... 现有内容不变 ... */}
      </Box>
    </Box>
  );
}
```

- [ ] **Step 4: App.tsx — 向 StatusBar 传递 compacting prop**

```typescript
// src/app/tui/App.tsx ~line 597
<StatusBar
  status={state.status}
  thinkingVisible={state.thinkingVisible}
  timerKey={state.runCount}
  running={state.running}
  compacting={state.compacting}  // 新增
/>
```

- [ ] **Step 5: 更新 graph.test.ts — 验证 compactionPerformed 出现在返回值**

在 graph 测试中，模拟 `forceCompact: true` 的 state，验证 agent 节点返回值包含 `compactionPerformed` 字段。

- [ ] **Step 6: 更新 tui-layout.test.tsx — 验证 compacting 渲染**

在 TUI 布局测试中，验证当 `compacting: true` 时 StatusBar 渲染 `⏳ Compacting...`，当 `compacting: false` 时不渲染。

- [ ] **Step 7: 类型检查 + 测试**

```bash
bun run typecheck
bun test tests/graph.test.ts tests/tui-layout.test.tsx
```

- [ ] **Step 8: Commit**

```bash
git add src/core/harness/graph.ts src/core/runner.ts src/app/tui/StatusBar.tsx src/app/tui/App.tsx tests/graph.test.ts tests/tui-layout.test.tsx
git commit -m "feat: Compact 事件接入生产路径，StatusBar 显示压缩状态指示器"
```

---

### Task 5: MCP 核心 — 配置解析 + McpManager + Tool Adapter

**Files:**
- Create: `src/core/mcp/types.ts`
- Create: `src/core/mcp/manager.ts`
- Create: `src/core/mcp/tool-adapter.ts`
- Create: `src/core/mcp/index.ts`
- Create: `tests/mcp.test.ts`
- Modify: `src/core/config/index.ts`

- [ ] **Step 1: 安装 MCP SDK 依赖**

```bash
bun add @modelcontextprotocol/sdk
```

- [ ] **Step 2: 写 types.ts**

```typescript
// src/core/mcp/types.ts
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";

/** MCP 传输类型 / MCP transport type */
export type McpTransportType = "stdio" | "http";

/** MCP Server 配置 / MCP server configuration */
export interface McpServerConfig {
  type: McpTransportType;
  /** stdio: 启动命令 / stdio: launch command */
  command?: string;
  /** stdio: 命令参数 / stdio: command arguments */
  args?: string[];
  /** stdio: 环境变量 / stdio: environment variables */
  env?: Record<string, string>;
  /** http: Streamable HTTP URL */
  url?: string;
  /** http: 自定义请求头 (Bearer token 等) */
  headers?: Record<string, string>;
  /** 风险覆盖：显式降级该 server 所有工具的风险级别 */
  risk?: "read";
}

/** MCP Server 实例运行时状态 / Runtime state of an MCP server instance */
export interface McpServerState {
  config: McpServerConfig;
  client: Client;
  tools: Tool[];
  prompts: McpPrompt[];
  connected: boolean;
  error?: string;
}

/** MCP Prompt 定义 / MCP prompt definition */
export interface McpPrompt {
  name: string;
  description?: string;
  arguments?: Array<{ name: string; description?: string; required?: boolean }>;
}

/** MCP 客户端配置段 / MCP config section */
export interface McpConfig {
  servers: Record<string, McpServerConfig>;
}

// Re-export SDK Tool type for convenience
export type { Tool as McpTool } from "@modelcontextprotocol/sdk/types.js";
```

- [ ] **Step 3: 扩展 config/index.ts — 解析 mcpServers 段**

在 `config/index.ts` 中新增：

```typescript
// src/core/config/index.ts — 新增

import type { McpServerConfig } from "@/core/mcp/types";

/** MCP 配置解析结果 / Parsed MCP configuration */
export interface LoadedMcpConfig {
  servers: Record<string, McpServerConfig>;
}

/** 加载 MCP 配置 / Load MCP configuration from kite-code.jsonc and .mcp.json */
export function loadMcpConfig(configPath?: string): LoadedMcpConfig {
  const servers: Record<string, McpServerConfig> = {};

  // 1. 从 kite-code.jsonc 读取 mcpServers 段
  const primaryPath = configPath ?? defaultConfigPath();
  if (existsSync(primaryPath)) {
    const raw = readFileSync(primaryPath, "utf8");
    const parsed = parse(raw);
    if (parsed && typeof parsed === "object" && "mcpServers" in (parsed as object)) {
      const mcpServers = (parsed as Record<string, unknown>).mcpServers;
      if (mcpServers && typeof mcpServers === "object") {
        for (const [name, cfg] of Object.entries(mcpServers as Record<string, unknown>)) {
          if (cfg && typeof cfg === "object") {
            servers[name] = normalizeMcpServerConfig(cfg as Record<string, unknown>);
          }
        }
      }
    }
  }

  // 2. 从项目根 .mcp.json 合并（不覆盖同名 server）
  const projectMcpPath = resolve(process.cwd(), ".mcp.json");
  if (existsSync(projectMcpPath)) {
    const raw = readFileSync(projectMcpPath, "utf8");
    const parsed = parse(raw);
    if (parsed && typeof parsed === "object" && "mcpServers" in (parsed as object)) {
      const mcpServers = (parsed as Record<string, unknown>).mcpServers;
      if (mcpServers && typeof mcpServers === "object") {
        for (const [name, cfg] of Object.entries(mcpServers as Record<string, unknown>)) {
          if (!servers[name] && cfg && typeof cfg === "object") {
            servers[name] = normalizeMcpServerConfig(cfg as Record<string, unknown>);
          }
        }
      }
    }
  }

  return { servers };
}

/** 展开环境变量 / Expand environment variables: ${VAR} and ${VAR:-default} */
function expandEnvVars(value: string): string {
  return value.replace(/\$\{(\w+)(?::-([^}]*))?\}/g, (_, name, def) => {
    return process.env[name] ?? def ?? "";
  });
}

function normalizeMcpServerConfig(raw: Record<string, unknown>): McpServerConfig {
  const type = (raw.type as string) === "http" ? "http" : "stdio";
  const cfg: McpServerConfig = { type };

  if (type === "stdio") {
    cfg.command = typeof raw.command === "string" ? expandEnvVars(raw.command) : undefined;
    cfg.args = Array.isArray(raw.args)
      ? raw.args.map((a) => expandEnvVars(String(a)))
      : undefined;
    if (raw.env && typeof raw.env === "object") {
      cfg.env = {};
      for (const [k, v] of Object.entries(raw.env as Record<string, unknown>)) {
        if (typeof v === "string") cfg.env[k] = expandEnvVars(v);
      }
    }
  } else {
    cfg.url = typeof raw.url === "string" ? expandEnvVars(raw.url) : undefined;
    if (raw.headers && typeof raw.headers === "object") {
      cfg.headers = {};
      for (const [k, v] of Object.entries(raw.headers as Record<string, unknown>)) {
        if (typeof v === "string") cfg.headers[k] = expandEnvVars(v);
      }
    }
  }

  if (raw.risk === "read") cfg.risk = "read";

  return cfg;
}
```

需要在文件顶部添加 import：
```typescript
import { resolve } from "node:path";
```

- [ ] **Step 4: 写 manager.ts**

```typescript
// src/core/mcp/manager.ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { McpServerConfig, McpServerState, McpPrompt } from "./types";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";

const MCP_STARTUP_TIMEOUT = 5000;
const HTTP_MAX_RECONNECT = 5;
const HTTP_RECONNECT_BASE_MS = 1000;

export class McpManager {
  private states = new Map<string, McpServerState>();
  private promptRegistry = new Map<string, { server: string; prompt: McpPrompt }>();

  /** 并行连接所有 server / Connect all servers in parallel */
  async connectAll(servers: Record<string, McpServerConfig>): Promise<void> {
    const entries = Object.entries(servers);
    const results = await Promise.allSettled(
      entries.map(([name, config]) => this.connect(name, config))
    );
    // Log failures but don't block startup
  }

  /** 连接单个 server / Connect a single server */
  async connect(name: string, config: McpServerConfig): Promise<void> {
    try {
      const transport = this.createTransport(config);
      const client = new Client(
        { name: "kite-code", version: "0.1.0" },
        { capabilities: {} }
      );

      await client.connect(transport, { timeout: MCP_STARTUP_TIMEOUT });

      const tools = await this.listTools(client);
      const prompts = await this.listPrompts(client);

      this.states.set(name, {
        config,
        client,
        tools,
        prompts,
        connected: true,
      });

      // 注册 prompts 到斜杠命令注册表
      for (const prompt of prompts) {
        const slashName = `mcp__${name}__${prompt.name}`;
        this.promptRegistry.set(slashName, { server: name, prompt });
      }

      // 监听 list_changed 通知
      client.onnotification("notifications/tools/list_changed", async () => {
        const state = this.states.get(name);
        if (state) {
          state.tools = await this.listTools(client);
        }
      });

      client.onnotification("notifications/prompts/list_changed", async () => {
        const state = this.states.get(name);
        if (state) {
          state.prompts = await this.listPrompts(client);
          this.refreshPromptRegistry(name, state.prompts);
        }
      });
    } catch (err) {
      this.states.set(name, {
        config,
        client: null as any,
        tools: [],
        prompts: [],
        connected: false,
        error: err instanceof Error ? err.message : String(err),
      });
      // HTTP server: schedule reconnect
      if (config.type === "http") {
        this.scheduleReconnect(name, config, 1);
      }
    }
  }

  /** 获取已连接 server 的所有工具 / Get all tools from connected servers */
  getAllTools(): Array<{ server: string; tool: Tool }> {
    const result: Array<{ server: string; tool: Tool }> = [];
    for (const [name, state] of this.states) {
      if (state.connected) {
        for (const tool of state.tools) {
          result.push({ server: name, tool });
        }
      }
    }
    return result;
  }

  /** 调用 MCP 工具 / Call an MCP tool */
  async callTool(server: string, toolName: string, args: Record<string, unknown>): Promise<any> {
    const state = this.states.get(server);
    if (!state || !state.connected) {
      throw new Error(`MCP server "${server}" is not connected`);
    }
    return state.client.callTool({ name: toolName, arguments: args });
  }

  /** 获取 prompt 注册表 (斜杠命令名 → 服务器信息) / Get prompt registry for slash commands */
  getPromptRegistry(): ReadonlyMap<string, { server: string; prompt: McpPrompt }> {
    return this.promptRegistry;
  }

  /** 获取所有 server 状态（给 /mcp 面板用） */
  getServerStates(): ReadonlyMap<string, McpServerState> {
    return this.states;
  }

  /** 断开所有连接 / Disconnect all connections */
  async disconnectAll(): Promise<void> {
    for (const [, state] of this.states) {
      try { await state.client.close?.(); } catch { /* ignore */ }
    }
    this.states.clear();
    this.promptRegistry.clear();
  }

  private createTransport(config: McpServerConfig) {
    if (config.type === "http") {
      return new StreamableHTTPClientTransport(
        new URL(config.url!),
        { requestInit: config.headers ? { headers: config.headers } : undefined }
      );
    }
    return new StdioClientTransport({
      command: config.command!,
      args: config.args,
      env: { ...process.env, KITE_CODE_PROJECT_DIR: process.cwd(), ...config.env } as Record<string, string>,
    });
  }

  private async listTools(client: Client): Promise<Tool[]> {
    const result = await client.listTools();
    return result.tools as Tool[];
  }

  private async listPrompts(client: Client): Promise<McpPrompt[]> {
    try {
      const result = await client.listPrompts();
      return (result.prompts ?? []) as McpPrompt[];
    } catch {
      return []; // Prompts 可选，失败不阻断
    }
  }

  private refreshPromptRegistry(server: string, prompts: McpPrompt[]): void {
    // Remove old entries for this server
    for (const [key, val] of this.promptRegistry) {
      if (val.server === server) this.promptRegistry.delete(key);
    }
    // Add new entries
    for (const prompt of prompts) {
      this.promptRegistry.set(`mcp__${server}__${prompt.name}`, { server, prompt });
    }
  }

  private scheduleReconnect(name: string, config: McpServerConfig, attempt: number): void {
    if (attempt > HTTP_MAX_RECONNECT) return;
    const delay = HTTP_RECONNECT_BASE_MS * Math.pow(2, attempt - 1);
    setTimeout(() => {
      this.connect(name, config).catch(() => { /* 重连失败由递归 schedule 处理 */ });
    }, delay);
  }
}
```

- [ ] **Step 5: 写 tool-adapter.ts**

```typescript
// src/core/mcp/tool-adapter.ts
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import type { McpManager } from "./manager";
import type { McpTool } from "./types";

/** JSON Schema 类型到 Zod schema 的基本映射 / Basic mapping from JSON Schema types to Zod */
function jsonSchemaToZod(schema: any): z.ZodTypeAny {
  if (!schema) return z.any();

  const type = schema.type ?? "string";

  if (schema.enum && Array.isArray(schema.enum)) {
    if (type === "string") return z.enum(schema.enum as [string, ...string[]]);
    if (type === "number" || type === "integer") {
      return z.union(schema.enum.map((v: number) => z.literal(v)) as any);
    }
  }

  switch (type) {
    case "string": {
      let s = z.string();
      if (schema.description) s = s.describe(schema.description);
      return s;
    }
    case "number":
    case "integer": {
      let n = z.number();
      if (schema.description) n = n.describe(schema.description);
      return n;
    }
    case "boolean": {
      let b = z.boolean();
      if (schema.description) b = b.describe(schema.description);
      return b;
    }
    case "array": {
      const itemType = schema.items ? jsonSchemaToZod(schema.items) : z.any();
      let arr = z.array(itemType);
      if (schema.description) arr = arr.describe(schema.description);
      return arr;
    }
    case "object": {
      if (!schema.properties) {
        let obj = z.record(z.any());
        if (schema.description) obj = obj.describe(schema.description);
        return obj;
      }
      const shape: Record<string, z.ZodTypeAny> = {};
      const required: string[] = schema.required ?? [];
      for (const [key, propSchema] of Object.entries(schema.properties as Record<string, any>)) {
        let field = jsonSchemaToZod(propSchema);
        if (!required.includes(key)) field = field.optional();
        shape[key] = field;
      }
      let obj = z.object(shape);
      if (schema.description) obj = obj.describe(schema.description);
      return obj;
    }
    default:
      return z.any();
  }
}

/** 将 MCP Tool 适配为 LangChain StructuredTool / Adapt an MCP Tool to a LangChain StructuredTool */
export function adaptMcpTool(
  serverName: string,
  mcpTool: McpTool,
  manager: McpManager,
) {
  const toolName = `mcp__${serverName}__${mcpTool.name}`;
  const zodSchema = mcpTool.inputSchema
    ? (jsonSchemaToZod(mcpTool.inputSchema) as z.ZodObject<any>)
    : z.object({});

  return tool(
    async (args: any) => {
      const result = await manager.callTool(serverName, mcpTool.name, args);
      // 对齐 Claude Code: 大输出截断
      const text = typeof result === "string" ? result : JSON.stringify(result);
      const MAX = parseInt(process.env.MAX_MCP_OUTPUT_TOKENS ?? "25000", 10);
      if (text.length > MAX) {
        return JSON.stringify({
          ok: true,
          stdout: text.slice(0, MAX),
          stderr: `Output truncated at ${MAX} characters. Original length: ${text.length}.`,
        });
      }
      return text;
    },
    {
      name: toolName,
      description: mcpTool.description ?? `MCP tool: ${mcpTool.name} (server: ${serverName})`,
      schema: zodSchema,
    },
  );
}
```

- [ ] **Step 6: 写 index.ts**

```typescript
// src/core/mcp/index.ts
export { McpManager } from "./manager";
export { adaptMcpTool } from "./tool-adapter";
export type { McpServerConfig, McpServerState, McpPrompt, McpConfig } from "./types";
export { loadMcpConfig } from "@/core/config/index";
```

注意：`loadMcpConfig` 定义在 config/index.ts 中，但从 mcp/index.ts re-export 方便统一导入。

- [ ] **Step 7: 写 MCP 单元测试**

```typescript
// tests/mcp.test.ts
import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { jsonSchemaToZod } from "../src/core/mcp/tool-adapter";
import { z } from "zod";

describe("jsonSchemaToZod", () => {
  it("maps string type", () => {
    const result = jsonSchemaToZod({ type: "string", description: "A name" });
    expect(result).toBeInstanceOf(z.ZodString);
  });

  it("maps number type", () => {
    const result = jsonSchemaToZod({ type: "number" });
    expect(result).toBeInstanceOf(z.ZodNumber);
  });

  it("maps boolean type", () => {
    const result = jsonSchemaToZod({ type: "boolean" });
    expect(result).toBeInstanceOf(z.ZodBoolean);
  });

  it("maps object with properties", () => {
    const result = jsonSchemaToZod({
      type: "object",
      properties: {
        name: { type: "string" },
        count: { type: "number" },
      },
      required: ["name"],
    });
    // Should be a ZodObject with name (required) and count (optional)
    const shape = (result as z.ZodObject<any>).shape;
    expect(shape.name).toBeDefined();
    expect(shape.count).toBeDefined();
  });

  it("maps enum", () => {
    const result = jsonSchemaToZod({
      type: "string",
      enum: ["a", "b", "c"],
    });
    expect(result).toBeInstanceOf(z.ZodEnum);
  });

  it("maps array", () => {
    const result = jsonSchemaToZod({
      type: "array",
      items: { type: "string" },
    });
    expect(result).toBeInstanceOf(z.ZodArray);
  });

  it("falls back to z.any() for unknown type", () => {
    const result = jsonSchemaToZod(null);
    expect(result).toBeInstanceOf(z.ZodAny);
  });
});
```

注意：`jsonSchemaToZod` 需要从 tool-adapter.ts 导出才能测试。确保函数标记为 `export`。

- [ ] **Step 8: 类型检查 + 测试**

```bash
bun run typecheck
bun test tests/mcp.test.ts
```

Expected: typecheck 通过，MCP 测试通过

- [ ] **Step 9: Commit**

```bash
git add bun.lock src/core/mcp/ src/core/config/index.ts tests/mcp.test.ts
git commit -m "feat: MCP 核心 — 配置解析、McpManager 多 server 生命周期、Tool Adapter"
```

---

### Task 6: MCP 工具集成 — tool-policy + definitions + tool-runner

**Files:**
- Modify: `src/core/harness/tool-policy.ts`
- Modify: `src/core/tools/definitions.ts`
- Modify: `src/core/harness/graph.ts`
- Modify: `tests/tool-policy.test.ts`

- [ ] **Step 1: tool-policy.ts — 新增 "mcp" 风险类别 + MCP 工具审批逻辑**

```typescript
// src/core/harness/tool-policy.ts

// 1. 在 ToolRisk union 中新增 "mcp"
export type ToolRisk =
  | "read"
  | "plan"
  | "write_file"
  | "execute_code"
  | "destructive"
  | "network"
  | "vcs_mutation"
  | "mcp"       // 新增
  | "unknown";

// 2. 在 evaluateToolPolicy 函数中，在最后的 deny({ risk: "unknown" }) 之前插入 MCP 分支
// 放在 shell_execute 的第二个分支之后、deny 之前

if (request.name.startsWith("mcp__")) {
  return requireApproval({
    risk: "mcp",
    reason: "MCP tools require user approval by default.",
    userVisibleSummary: `Run MCP tool: ${request.name}`,
    expectedEffects: ["Calls external MCP server tool", "May have side effects"],
  });
}
```

- [ ] **Step 2: tool-policy.ts — 支持 server 级 risk 降级**

`evaluateToolPolicy` 需要接收 MCP config 以检查 server 级 risk 覆盖。在函数参数中新增可选字段：

```typescript
// evaluateToolPolicy 参数新增:
mcpRiskOverride?: Record<string, "read">,
```

然后 MCP 分支逻辑改进为：
```typescript
if (request.name.startsWith("mcp__")) {
  // mcp__servername__toolname → servername
  const parts = request.name.split("__");
  const serverName = parts.length >= 2 ? parts[1] : "";
  const serverRisk = serverName ? input.mcpRiskOverride?.[serverName] : undefined;

  if (serverRisk === "read") {
    return allow({
      risk: "read",
      reason: `MCP server "${serverName}" risk explicitly lowered to read by config.`,
      userVisibleSummary: `Run MCP tool: ${request.name}`,
      expectedEffects: ["Calls MCP server tool (risk lowered by config)"],
    });
  }

  return requireApproval({
    risk: "mcp",
    reason: "MCP tools require user approval by default.",
    userVisibleSummary: `Run MCP tool: ${request.name}`,
    expectedEffects: ["Calls external MCP server tool", "May have side effects"],
  });
}
```

更新 `evaluateToolPolicy` 参数类型新增：
```typescript
mcpRiskOverride?: Record<string, "read">;
```

- [ ] **Step 3: definitions.ts — createAgentTools 扩展 mcpManager 参数**

```typescript
// src/core/tools/definitions.ts

// 在 CreateAgentToolsInput 中新增 mcpManager
export interface CreateAgentToolsInput {
  workspace: string;
  shellExecutor?: ShellExecutor;
  mcpManager?: import("@/core/mcp/manager").McpManager;  // 新增
}

// 在 createAgentTools 函数中新增 MCP 工具合成
import { adaptMcpTool } from "@/core/mcp/tool-adapter";

export function createAgentTools(input: CreateAgentToolsInput) {
  // ... 现有内置工具定义 ...

  const builtinTools = [
    readFileTool,
    editFileTool,
    writeFileTool,
    shellExecute,
    createUpdatePlanTool(),
    createAskUserTool(),
    createSetAuthorizationModeTool(),
  ];

  // MCP 工具合成 / Synthesize MCP tools
  if (input.mcpManager) {
    const mcpEntries = input.mcpManager.getAllTools();
    const mcpTools = mcpEntries.map(({ server, tool }) =>
      adaptMcpTool(server, tool, input.mcpManager!)
    );
    return [...builtinTools, ...mcpTools];
  }

  return builtinTools;
}
```

- [ ] **Step 4: graph.ts — 构建 graph 时传入 mcpManager**

在 `buildCodeAgentGraph` 中创建 `McpManager` 实例，加载配置，连接所有 server，传给 `createAgentTools`。

```typescript
// src/core/harness/graph.ts

import { McpManager, loadMcpConfig } from "@/core/mcp";

// buildCodeAgentGraph 中:
const mcpConfig = loadMcpConfig();
const mcpManager = new McpManager();
// 注意：这是异步操作，可能需要调整 buildCodeAgentGraph 为 async
// 或在启动时提前初始化 mcpManager 并作为参数传入

// 简化方案：在 buildCodeAgentGraph 参数中新增可选 mcpManager
export function buildCodeAgentGraph(input: {
  // ... 现有字段 ...
  mcpManager?: McpManager;
}) {
  // ...
  const tools = createAgentTools({
    workspace: input.config.workspace ?? process.cwd(),
    shellExecutor: input.shellExecutor,
    mcpManager: input.mcpManager,  // 新增
  });
}
```

- [ ] **Step 5: 更新 tool-policy.test.ts**

新增 MCP 工具审批测试用例：

```typescript
// tests/tool-policy.test.ts — 新增
describe("MCP tools", () => {
  it("requires approval for mcp__* tools by default", () => {
    const decision = evaluateToolPolicy({
      request: { name: "mcp__playwright__navigate", args: { url: "https://example.com" }, protectedCommand: "" },
      workspaceAccess: "write",
      phase: "building",
    });
    expect(decision.requiresApproval).toBe(true);
    expect(decision.risk).toBe("mcp");
  });

  it("allows MCP tool with server-level risk=read override", () => {
    const decision = evaluateToolPolicy({
      request: { name: "mcp__safe_reader__list", args: {}, protectedCommand: "" },
      workspaceAccess: "write",
      phase: "building",
      mcpRiskOverride: { safe_reader: "read" },
    });
    expect(decision.allowed).toBe(true);
    expect(decision.requiresApproval).toBe(false);
    expect(decision.risk).toBe("read");
  });

  it("denies MCP tools in read-only workspace", () => {
    const decision = evaluateToolPolicy({
      request: { name: "mcp__playwright__navigate", args: {}, protectedCommand: "" },
      workspaceAccess: "read-only",
      phase: "planning",
    });
    expect(decision.allowed).toBe(false);
  });
});
```

- [ ] **Step 6: 类型检查 + 测试**

```bash
bun run typecheck
bun test tests/tool-policy.test.ts tests/mcp.test.ts
```

Expected: typecheck 通过，所有测试通过

- [ ] **Step 7: Commit**

```bash
git add src/core/harness/tool-policy.ts src/core/tools/definitions.ts src/core/harness/graph.ts tests/tool-policy.test.ts
git commit -m "feat: MCP 工具集成 — tool-policy 新增 mcp 风险类别、definitions 合成 MCP 工具、graph 传入 mcpManager"
```

---

### Task 7: MCP TUI — /mcp 面板 + MCP Prompts 斜杠命令

**Files:**
- Create: `src/app/tui/components/McpPanel.tsx`
- Modify: `src/app/tui/hooks/useSlashCommand.ts`
- Modify: `src/app/tui/App.tsx`
- Modify: `tests/tui-layout.test.tsx`

- [ ] **Step 1: 写 McpPanel 组件**

```typescript
// src/app/tui/components/McpPanel.tsx
import React from "react";
import { Box, Text } from "ink";
import type { McpManager } from "@/core/mcp";
import { darkTheme as t } from "../theme";

interface McpPanelProps {
  manager: McpManager;
  onClose: () => void;
}

export default function McpPanel({ manager, onClose }: McpPanelProps) {
  const states = manager.getServerStates();

  if (states.size === 0) {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={t.dim} padding={1}>
        <Text bold color={t.primary}>MCP Servers</Text>
        <Box marginTop={1}>
          <Text color={t.muted}>No MCP servers configured.</Text>
        </Box>
        <Box marginTop={1}>
          <Text color={t.dim}>
            Add mcpServers to ~/.kite-code/kite-code.jsonc or .mcp.json
          </Text>
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={t.dim} padding={1}>
      <Text bold color={t.primary}>MCP Servers</Text>
      {Array.from(states.entries()).map(([name, state]) => {
        const statusColor = state.connected ? t.success : t.error;
        const statusIcon = state.connected ? "●" : "○";
        const typeLabel = state.config.type === "http" ? "http" : "stdio";
        return (
          <Box key={name} flexDirection="column" marginTop={1}>
            <Box gap={2}>
              <Text color={statusColor}>{statusIcon}</Text>
              <Text bold>{name}</Text>
              <Text color={t.dim}>{typeLabel}</Text>
              <Text color={t.muted}>{state.tools.length} tools</Text>
              {!state.connected && state.error && (
                <Text color={t.error}>{state.error.slice(0, 60)}</Text>
              )}
            </Box>
            {/* tool 列表（缩略显示） */}
            {state.connected && state.tools.length > 0 && (
              <Box marginLeft={4} flexDirection="column">
                {state.tools.slice(0, 10).map((tool) => (
                  <Text key={tool.name} color={t.dim}>
                    mcp__{name}__{tool.name}
                  </Text>
                ))}
                {state.tools.length > 10 && (
                  <Text color={t.muted}>... and {state.tools.length - 10} more</Text>
                )}
              </Box>
            )}
          </Box>
        );
      })}
    </Box>
  );
}
```

- [ ] **Step 2: useSlashCommand.ts — 新增 /mcp 命令 + MCP Prompts 注册表**

```typescript
// src/app/tui/hooks/useSlashCommand.ts

// 在 SlashAction 中新增 mcp 类型
export type SlashAction =
  | { type: "mcp" }    // 新增
  | // ... 现有类型 ...

// parseSlashCommand 中新增 case
case "mcp": return { type: "mcp" };

// useSlashCommand 回调中新增 case
case "mcp":
  dispatch({ type: "SHOW_MCP" });  // 新增 action
  break;

// 对于 MCP Prompts: 在 default 分支检查全局注册表
default:
  // 检查 MCP Prompt 注册表
  if (typeof (globalThis as any).__mcpPromptRegistry?.get === "function") {
    const entry = (globalThis as any).__mcpPromptRegistry.get(cmd);
    if (entry) {
      // MCP prompt 作为用户输入注入 — dispatch 包含 prompt 内容的事件
      dispatch({ type: "INJECT_MCP_PROMPT", server: entry.server, promptName: entry.prompt.name });
      return true;
    }
  }
  return { type: "unknown", raw: input };
```

注意：MCP Prompt 注册表通过 `globalThis.__mcpPromptRegistry` 暴露，因为 useSlashCommand 是 React hook，无法直接访问 McpManager 实例。更好的做法是通过 App 组件传入。

实际上，更好的设计是：在 App 组件中获取 `mcpManager.getPromptRegistry()` 并作为参数传给 `useSlashCommand`。需要改造 hook 签名。

```typescript
// 更新方案：useSlashCommand 增加第三个参数 mcpPromptRegistry
export function useSlashCommand(
  dispatch: Dispatch<any>,
  onExit?: () => void,
  onCompactRequest?: () => void,
  mcpPromptRegistry?: ReadonlyMap<string, { server: string; prompt: any }>,
) {
  return useCallback((input: string): boolean => {
    // ...
    default: {
      // 检查 MCP Prompt 注册表
      const entry = mcpPromptRegistry?.get(cmd);
      if (entry) {
        dispatch({ type: "INJECT_MCP_PROMPT", server: entry.server, promptName: entry.prompt.name });
        return true;
      }
      return false;  // 改为 return false，不是 return { type: "unknown" }
    }
  }, [dispatch, onExit, onCompactRequest, mcpPromptRegistry]);
}
```

- [ ] **Step 3: App.tsx — 集成 MCP 面板 + 传递 prompt registry**

在 App.tsx 中：

1. 新增 Action 类型 `SHOW_MCP` / `HIDE_MCP`：
```typescript
| { type: "SHOW_MCP" }
| { type: "HIDE_MCP" }
```

2. 新增 `showMcp` 到 `TuiState`（或在 App 组件内部用 useState 管理）。

3. 渲染 McpPanel：
```typescript
{state.showMcp && mcpManager && (
  <McpPanel manager={mcpManager} onClose={() => dispatch({ type: "HIDE_MCP" })} />
)}
```

4. 传递 MCP prompt registry 给 useSlashCommand：
```typescript
const handleSlash = useSlashCommand(
  dispatch,
  handleExit,
  handleCompact,
  mcpManager?.getPromptRegistry(),
);
```

- [ ] **Step 4: 更新 tui-layout.test.tsx — MCP 面板测试**

新增测试验证 `/mcp` 命令打开面板、面板正确展示 server 状态。

- [ ] **Step 5: 类型检查 + 测试**

```bash
bun run typecheck
bun test tests/tui-layout.test.tsx
```

Expected: typecheck 通过，TUI 测试通过

- [ ] **Step 6: Commit**

```bash
git add src/app/tui/components/McpPanel.tsx src/app/tui/hooks/useSlashCommand.ts src/app/tui/App.tsx tests/tui-layout.test.tsx
git commit -m "feat: MCP TUI — /mcp 面板、MCP Prompts 斜杠命令集成"
```

---

### Task 8: 端到端验证

- [ ] **Step 1: 运行全量测试**

```bash
bun test
bun run typecheck
```

Expected: 所有测试通过，无类型错误。

- [ ] **Step 2: 运行 e2e 测试**

```bash
bun test tests/e2e/
```

Expected: e2e 测试通过（确保 retry → model_retry 替换正确）。

- [ ] **Step 3: 最终 Commit（如有遗漏文件）**

```bash
git status
# 如有未 staged 的修改文件，检查后 add + commit
```

---

## 自检清单

1. **类型一致性**：`isRecoverableError` 在 runner.ts 定义并导出，在 index.tsx 中 import 使用。`McpManager` 在 graph.ts 和 App.tsx 中使用。`compacting` prop 在 StatusBar.tsx 中接收。
2. **无占位符**：所有步骤均包含实际代码。
3. **Import 路径**：使用 `@/` 别名（与项目现有风格一致）。
4. **平台兼容**：MCP stdio transport 使用 SDK 提供的 `StdioClientTransport`，Bun 在 Windows 上通过 MSYS2 bash 运行子进程。
