# 生产就绪补齐方案

日期：2026-05-22
状态：active（Phase 1 ✅ 已完成，Phase 2 ✅ 已完成，Phase 3 📋 Skills 系统设计已确认、待制定实施计划）
参考：Claude Code MCP 实现、Rewind 模型、交互模式

---

## 目标

补齐上次路线图（2026-05-20-tui-production-roadmap.md）遗留的缺口，将 OpenPX 提升到对标 Claude Code 的生产级水平。

## 背景

路线图上 10 项任务已完成 8 项，剩余 2 项（Undo/Redo、自定义斜杠命令）标记为延后。经过代码审查，发现还有以下缺口：

1. 3 个事件类型生产路径是死代码（`retry`、`compact_begin`、`compact_end`），`compacting` 字段无 UI 消费
2. `error.recoverable` 始终为 `false`，错误分类机制形同虚设
3. Session 命名在 API key 缺失时静默失败
4. MCP 协议支持缺失 — 这是 Claude Code 工具生态的核心护城河
5. Undo/Redo 需重新设计（对齐 Claude Code Rewind 模型）
6. Hooks 系统、自定义斜杠命令尚未启动

---

## Phase 1：MCP 核心 + 事件闭环 + 错误分类

> **优先级**：P0
> **目标**：MCP tools 可用 + 感知闭环完整 + 错误分类生效

### 1.1 MCP 协议支持（主攻方向）

对齐 Claude Code MCP 实现（参考 [`code.claude.com/docs/en/mcp`](https://code.claude.com/docs/en/mcp)）。

#### 配置模型

```jsonc
// ~/.openpx/openpx.jsonc 新增 mcpServers 段
// 同时兼容项目根目录 .mcp.json（与 Claude Code 共享配置格式）
{
  "mcpServers": {
    "playwright": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@playwright/mcp"],
      "env": { "PLAYWRIGHT_BROWSERS_PATH": "/tmp/..." }
    },
    "sentry": {
      "type": "http",                      // streamable HTTP transport
      "url": "https://mcp.sentry.dev/mcp",
      "headers": { "Authorization": "Bearer xxx" }
    }
  }
}
```

- `type`：`"stdio"` 或 `"http"`（streamable HTTP，跳过已废弃的 SSE）
- 环境变量展开：支持 `${VAR}` 和 `${VAR:-default}`
- 配置 lookup 顺序：`openpx.jsonc` → 项目根 `.mcp.json`（合并）

#### 工具命名

```
mcp__playwright__navigate    → server "playwright" 的 "navigate" 工具
mcp__github__list_prs        → server "github" 的 "list_prs" 工具
```

与 Claude Code 完全一致的前缀格式 `mcp__servername__toolname`。与 OpenPX 内置工具名（`read_file`、`edit_file`、`shell_execute` 等）无冲突。

#### Transport 层

**StdioTransport**：
- `child_process.spawn` 启动 server 子进程
- JSON-RPC 2.0 通过 stdin/stdout 通信
- 设置 `CLAUDE_PROJECT_DIR` 等效环境变量（`OPENPX_PROJECT_DIR`）供 server 解析项目路径

**HttpTransport**（streamable HTTP）：
- GET 建立 SSE 长连接（server→client 通知）
- POST 发送 JSON-RPC 请求
- 支持自定义 headers（Bearer token 等）
- 对齐 Claude Code HTTP transport 行为

**连接生命周期**：
- 启动时并行连接所有 server
- 失败不阻断启动，标记为 unavailable（StatusBar 提示）
- HTTP server 断线：指数退避自动重连（最多 5 次，1s/2s/4s/8s/16s）
- stdio server 不做自动重连
- 支持 `list_changed` 通知 → 自动刷新工具列表

#### 模块结构

```
src/core/mcp/
  types.ts                — JSON-RPC 2.0 类型、MCP capability 声明
  client.ts               — MCPClient 类（initialize/capability 协商、tools/list、tools/call）
  transports/stdio.ts     — StdioTransport
  transports/http.ts      — HttpTransport
  manager.ts              — McpManager（多 server 生命周期、并行连接、重连）
  tool-adapter.ts         — MCP Tool schema → LangChain StructuredTool
  index.ts                — 对外导出
```

#### MCP 工具与 LangChain 工具合成

`createAgentTools()` 扩展：
```typescript
// src/core/tools/definitions.ts
export async function createAgentTools(input: CreateAgentToolsInput) {
  const mcpManager = input.mcpManager;
  const mcpTools: StructuredTool[] = [];

  if (mcpManager) {
    for (const [serverName, client] of mcpManager.clients) {
      if (!client.connected) continue;
      const tools = client.listTools();  // 缓存
      for (const tool of tools) {
        mcpTools.push(adaptMcpTool(serverName, tool, client));
      }
    }
  }

  return [readFileTool, editFileTool, writeFileTool, shellExecute, ...mcpTools, ...];
}
```

`adaptMcpTool()` 将 MCP `inputSchema`（JSON Schema）转换为 LangChain `zod` schema，自动处理类型映射。工具名映射为 `mcp__servername__toolname`。

#### 安全策略集成

MCP 工具默认需要审批（风险类别 `mcp`）。在 `tool-policy.ts` 新增：

```typescript
risk: "mcp" → {
  allowed: false,  // 在 default 模式下需要审批
  allowInReadOnly: false,
  allowInPlanPhase: false,
}
```

用户可在 `mcpServers.<name>.risk` 显式声明风险降级：
```jsonc
{ "mcpServers": {
    "safe-reader": {
      "type": "stdio",
      "command": "safe-server",
      "risk": "read"   // 该 server 的所有工具按 read 策略（免审批）
    }
}}
```

审批卡片（ApprovalBlock）针对 MCP 工具增强显示：
- 显示 server 来源（`mcp__playwright`）
- 显示工具名（`navigate`）
- 风险分类标签 `mcp`

#### TUI 集成：`/mcp` 命令

对齐 Claude Code `/mcp` 面板：

- **`/mcp`** — 打开 MCP server 管理覆盖层
- 展示每个 server 的：名称、transport 类型（stdio/http）、连接状态（connected/pending/failed）、工具数量
- 对于 failed server，显示错误原因
- 可选：提供 `retry` 操作手动重连

#### MCP Prompts 作为斜杠命令

MCP server 可暴露 prompts，自动注册为 `/mcp__servername__promptname` 格式的斜杠命令（对齐 Claude Code）。执行 prompt 后，其内容作为上下文注入当前对话。

Prompts 在 tools/list 之后通过 `prompts/list` 拉取，纳入 `useSlashCommand.ts` 命令注册表。

#### 运行时约束

- MCP server 启动超时：5 秒（对齐 Claude Code `MCP_TIMEOUT` 默认值）
- MCP 工具输出截断：超过 10,000 字符显示警告，默认上限 25,000 字符（可通过 `MAX_MCP_OUTPUT_TOKENS` 环境变量调整）
- 大输出落地到磁盘文件并替换为文件引用（对齐 Claude Code 行为）

#### 暂缓项

以下 Claude Code MCP 特性暂不实现，待后续评估：
- **OAuth 2.0 认证**：HTTP server 的动态客户端注册、pre-configured credentials、回调端口。初期仅支持 static headers 和 `OPENPX_MCP_*` 环境变量传递 token
- **`headersHelper`**：动态 header 生成命令
- **`alwaysLoad` / Tool Search**：按需加载 MCP 工具定义的上下文优化（当工具数量 > 50 时再考虑）

### 1.2 Compact 事件闭环

**问题**：`compact_begin` / `compact_end` 事件类型已定义，reducer 分支已实现，但生产路径（runner + graph）从不发出。

**方案**：graph 压缩执行后返回标记，runner 检测后 emit 事件。

**详情**：

1. **`state.ts`** — 新增内部标记字段：
   ```typescript
   _compactionPerformed: Annotation<{ reason: string; summary: string } | null>
   ```
   命名以 `_` 前缀表示内部字段，不参与 checkpoint 持久化。

2. **`graph.ts`** agent 节点 — 压缩后设置标记：
   ```typescript
   if (state.forceCompact) {
     const compacted = forceContextCompaction(state.messages);
     // ... 现有压缩逻辑 ...
     effectiveState._compactionPerformed = {
       reason: "Manual compaction triggered by /compact or Ctrl+X c",
       summary: compacted.summary,
     };
   }
   ```

3. **`runner.ts`** `chunkToEvents()` — 在前端 state_change 之前插入事件：
   ```typescript
   if (state._compactionPerformed) {
     events.push({
       type: "compact_begin",
       data: { reason: state._compactionPerformed.reason },
     });
     events.push({
       type: "compact_end",
       data: { summary: state._compactionPerformed.summary },
     });
   }
   ```

4. **`App.tsx`** — 现有 reducer 分支无需改动。

### 1.3 Compact UI 消费

**问题**：`TuiState.compacting` 字段被 `compact_begin`/`compact_end` 正确写入，但没有任何组件读取展示。

**方案**：`StatusBar.tsx` 中展示压缩状态。

```
⏳ Compacting...
```

当 `compacting === true` 时在状态行显示此指示器，压缩完成时消失。无需新增 props，从现有 `state` 读取。

### 1.4 Retry 事件清理

**问题**：`retry` 事件类型 + reducer 分支是死代码。当前唯一的实际重试路径是 `model_retry`（已被 runner 发出）。

**方案**：移除 `retry` — 不增设 graph 级重试事件。

**清理范围**：
1. `src/protocol/events.ts` — 移除 `retry` 事件类型
2. `src/app/tui/App.tsx` — 移除 `case "retry":` reducer 分支
3. `tests/e2e/mock-agent.tsx` — 移除 `retry` 事件使用，替换为 `model_retry`
4. `tests/e2e/scenarios/failure-scenarios.ts` — 同上

### 1.5 Recoverable 错误分类

**问题**：`error.recoverable` 始终为 `false`，TUI 端 `⟳ Recoverable error` 渲染分支从未激活。

**方案**：`runner.ts` catch 块按错误类型分类。

```typescript
// src/core/runner.ts
function isRecoverableError(error: unknown): boolean {
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

`index.tsx` emit 点使用此函数：
```typescript
emit({
  type: "error",
  data: { message: err.message, recoverable: isRecoverableError(err) },
});
```

### 1.6 Session 命名修复

**问题**：API key 缺失时 `generateSessionName` 返回空字符串 → session 名为空。

**方案**：`sessions.ts:404` catch 块改为返回截断的用户输入：
```typescript
} catch {
  return cleanMessage.slice(0, 30) || "";
  // 原：return ""; // caller handles fallback to truncation
}
```

---

## Phase 2：MCP Resources + Rewind

> **优先级**：P1
> **目标**：MCP resource 集成 + 会话回溯

### 2.1 MCP Resources

复用 Phase 1 的 `MCPClient` 和 JSON-RPC 管道，新增 `resources/list` + `resources/read`。

**不实现**完整的 `@` 提及 UI（TUI 输入框需大幅改造）。替代方案：
- `/mcp` 面板展示可用 resource 列表
- Resource 内容可通过内置工具 `read_mcp_resource` 拉取并注入 agent 上下文

### 2.2 Rewind（会话回溯）

对齐 Claude Code `/rewind` + `Esc Esc` 模型（参考 [`code.claude.com/docs/en/checkpointing`](https://code.claude.com/docs/en/checkpointing)）。

**核心差异 vs 原方案**：
- 原方案：fork + rollback（需 saver 层深度改造）
- 新方案：基于已有 `parent_checkpoint_id` 链的回溯，更轻量

**Saveer 层新增**：
- `listCheckpoints(threadId)` — 枚举线程所有 checkpoint（含 ID 和第一个 user message 摘要）
- `getCheckpointState(checkpointId)` — 加载指定 checkpoint 的完整 state

`BunSqliteSaver` 已有 `parent_checkpoint_id` 链，上述方法复用现有数据。

**Runner 层新增**：
- `resumeFromCheckpoint(threadId, checkpointId)` — fork 新 threadId，从指定 checkpoint 的 state 开始执行
- 不修改原 thread 的 checkpoint 历史

**TUI 层**：
- **`/rewind`** 命令 → 打开 checkpoint 选择覆盖层
- **`Esc Esc`**（输入框为空时双击 Escape）→ 同上，打开 rewind 菜单（对齐 Claude Code）
- 列表展示：序号 + user prompt 文本（截取前 60 字符）+ 时间戳
- 选择后：fork 新会话从该 checkpoint 继续（restore code+conversation）
- **不实现** Claude Code 的 4 种操作粒度（初期仅恢复 code+conversation）
- **不实现** Summarize from/to here（初期仅做恢复，不做压缩）

**不做的**：
- Ctrl+Z/Ctrl+Y 逐次撤销（Claude Code 也没有）
- 文件级 diff 反向追踪
- `Restore code` / `Restore conversation` 分离操作

---

## Phase 3：Skills 系统

> **优先级**：P1
> **目标**：实现 agentskills.io 标准的 Skill 机制，聚焦 code agent 主功能完善
> **设计文档**：[`understanding/2026-05-23-skills-system-design.md`](../understanding/2026-05-23-skills-system-design.md)

### 3.1 Skills 系统

严格遵循 agentskills.io 开放标准。Skill 是按需加载的 Markdown 指令文件，通过 `Skill` 工具和 `/skill-name` 斜杠命令两种方式触发。

**存放路径**（按优先级）：
- 项目 `.openpx/skills/` > `.agents/skills/`
- 用户 `~/.openpx/skills/` > `~/.agents/skills/`

**两种触发方式**：
- **Agent 自激活**：system prompt 中 Available Skills 区段列出所有 skill 的 name + description，Agent 根据任务判断匹配后调用 `Skill` 工具加载完整指令
- **用户显式触发**：`/skill-name` 斜杠命令直接激活，支持 `/skill-name <task>` 组合形式

**容错策略**：所有 Skill 校验异常（格式错误、缺少字段、目录结构异常）静默跳过，不 throw、不 crash、不在 TUI 展示错误。

### 缓后：Hooks + 自定义斜杠命令

原 Phase 3（Hooks + 自定义斜杠命令）目前优先级不高，延后实施。Skills 系统实现后，自定义斜杠命令可复用其加载机制。

---

## 实施汇总

| Phase | 任务 | 模块 | 测试范围 |
|-------|------|------|---------|
| Phase 1 | MCP 核心 | `src/core/mcp/`（新建 6 文件）+ `src/core/tools/definitions.ts` + `src/core/harness/tool-policy.ts` | `tests/mcp.test.ts` + `tests/tool-policy.test.ts` |
| Phase 1 | `/mcp` 面板 + MCP prompts | `src/app/tui/`（MCP 状态覆盖层）+ `useSlashCommand.ts` | `tests/tui-layout.test.tsx` |
| Phase 1 | Compact 事件接入 | `src/core/harness/state.ts` + `graph.ts` + `runner.ts` | `tests/graph.test.ts` |
| Phase 1 | Compact UI 消费 | `src/app/tui/StatusBar.tsx` | `tests/tui-layout.test.tsx` |
| Phase 1 | Retry 事件清理 | `src/protocol/events.ts` + `App.tsx` + e2e mock | e2e 测试同步 |
| Phase 1 | Recoverable 错误分类 | `src/core/runner.ts` + `index.tsx` | `tests/runner.test.ts` |
| Phase 1 | Session 命名修复 | `src/core/persistence/sessions.ts` | 现有测试断言确认 |
| Phase 1 | MCP 安全策略 | `src/core/harness/tool-policy.ts` | `tests/tool-policy.test.ts` |
| Phase 2 | MCP Resources | `src/core/mcp/`（扩展） | `tests/mcp.test.ts` 扩展 |
| Phase 2 | Rewind | `src/core/persistence/checkpoint.ts` + `runner.ts` + `useSlashCommand.ts` + `useGlobalKeys.ts` | `tests/checkpoint.test.ts` + e2e |
| Phase 3 | Skills 系统 | `src/core/skills/`（新建 4 文件）+ `tools/definitions.ts` + `tool-policy.ts` + `context.ts` | `tests/skills/`（新建）+ `tests/tui-reducer.test.ts`（扩展） |
| 缓后 | Hooks 系统 | `src/core/hooks/` | — |
| 缓后 | 自定义斜杠命令 | `useSlashCommand.ts` + `config/index.ts` | — |

## 变更影响面

| Phase | 新增文件 | 修改文件 |
|-------|---------|---------|
| Phase 1 | ~9 | ~12 |
| Phase 2 | ~1 | ~7 |
| Phase 3 (Skills) | ~4 | ~13 |
| 缓后 (Hooks+命令) | ~3 | ~3 |

## 相关文档

- [`2026-05-20-tui-production-roadmap.md`](2026-05-20-tui-production-roadmap.md) — 前置路线图（感知闭环 + 防御纵深 + 功能补齐）
- [`../backlog/tui-issues.md`](../backlog/tui-issues.md) — TUI 待修复项清单
- [`../understanding/2026-05-20-tui-known-issues.md`](../understanding/2026-05-20-tui-known-issues.md) — TUI 深度审查报告
- [Claude Code MCP 文档](https://code.claude.com/docs/en/mcp) — MCP 配置、工具命名、安全策略参考
- [Claude Code Rewind 文档](https://code.claude.com/docs/en/checkpointing) — Rewind 模型参考
- [MCP 协议规范](https://modelcontextprotocol.io/docs/concepts/architecture) — MCP 架构参考
- [Claude Code 权限模型](https://code.claude.com/docs/en/permissions) — 权限规则语法参考
