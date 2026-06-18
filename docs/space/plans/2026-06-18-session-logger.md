# 会话日志本地记录方案

状态：draft
创建：2026-06-18

## 目标

Agent 运行期间的所有事件（模型产出、工具调用、审批交互、子 Agent 生命周期、异常等）当前只在事件流中 transient 存在，会话结束后无法回溯。本模块在本地文件系统中为每次 `runAgent` 创建 OTel 兼容的 JSONL 日志，包含完整事件内容（正文、参数、摘要），实现：

1. **会话离线回溯**：无需外部平台即可按时间线查看每次 Agent 执行的完整过程
2. **故障诊断**：工具失败时记录 failure_reason 枚举 + 原始 summary，无需重现即可定位根因
3. **评估数据基础**：`summary.json` 提供聚合统计数据（turns / tool calls / subagents / errors），跨会话对比

## 与 OTel 遥测方案的关系

本模块与 [`2026-06-18-opentelemetry-observability.md`](2026-06-18-opentelemetry-observability.md) **互补，非替代**：

| 维度 | OTel 遥测 (`core/telemetry/`) | 会话日志 (`core/session-logger/`) |
|------|-------------------------------|----------------------------------|
| 存储位置 | 第三方平台 (Grafana/Jaeger/…)，OTLP/HTTP 导出 | 本地文件系统 `~/.openpx/sessions/<threadId>/events.jsonl` |
| 记录粒度 | Span 树（层级 + 属性），适合聚合查询 | 全量事件流，每条 AgentEvent → 一条 TraceRecord |
| 内容范围 | 工具失败原因、token 用量、设备信息等结构属性 | **完整内容**：模型文本/推理、工具参数/输出、审批详情 |
| 依赖 | `@opentelemetry/api` | 零外部依赖，自建 OTel 兼容类型 |
| 默认状态 | `enabled: true`，无 endpoint 时 no-op | **始终启用**（纯本地，无网络） |
| 隐私 | 遥测通道需 scrubber 脱敏 | 本地存储，不做脱敏 |

两条通道共用 `classifier.ts` 的 `classifyToolFailure()` 函数（`session-logger/classifier.ts` 与 `telemetry/classifier.ts` 为独立副本，格式一致）。

## 范围

| 层 | 文件 | 操作 |
|---|------|------|
| core | `src/core/session-logger/` | 新增模块，6 个文件 |
| core | `src/core/runner.ts` | `processStream` 中集成 `collector.record(e)` |
| protocol | 无变更 | 消费现有 `AgentEvent` 类型 |
| tests | `tests/session-logger/` | 新增测试 |

## 模块结构

```
src/core/session-logger/
├── types.ts       ← TraceRecord / TraceEvent / RunSummary 类型定义（OTel 兼容）
├── classifier.ts  ← 工具失败原因分类 (classifyToolFailure + ToolFailureReason 枚举)
├── recorder.ts    ← AgentEvent → TraceRecord 映射器（全量记录 + 内容截断）
├── writer.ts      ← 非阻塞 JSONL 写入器 (buffer + setImmediate 异步写盘)
├── collector.ts   ← SessionLogCollector — 伴随 runAgent 生命周期，聚合 summary
└── index.ts       ← 公开导出

tests/session-logger/
└── recorder.test.ts  ← AgentEvent → TraceRecord 映射正确性（18 tests）
```

## 数据模型

### TraceRecord — 单条日志记录（等价 OTel Span）

```typescript
interface TraceRecord {
  traceId: string;        // 32 hex chars，会话级标识
  spanId: string;         // 16 hex chars，本条唯一标识
  parentSpanId: string;   // 父 span ID（关联到 turn/node），空 = root
  name: string;           // Span 名称 (e.g. "text", "tool.read_file", "subagent.start")
  kind: number;           // 1=INTERNAL, 3=CLIENT (node.agent)
  timestamp: string;      // ISO 8601
  attributes: Record<string, OtelValue>;  // 内容 + 元数据
  status: { code: 'OK' | 'ERROR'; message: string };
  events?: TraceEvent[];  // 子事件 (tool.error, model.retry)
}
```

### RunSummary — 会话聚合摘要

```typescript
interface RunSummary {
  threadId: string;
  traceId: string;
  startedAt: string;
  endedAt?: string;
  status: 'completed' | 'aborted' | 'fatal';
  workspace: string;
  frontend: string;
  modelProvider: string;
  modelName: string;
  device: { os; osVersion; arch; bunVersion; terminal? };
  stats: {
    turns: number;
    toolCalls: { total; ok; failed };
    modelRetries: number;
    subAgents: { total; ok; failed };
    errors: number;
  };
}
```

### 输出文件布局

```
~/.openpx/sessions/<frontend>/<threadId>/
├── events.jsonl    ← 每条 AgentEvent 对应一行 JSON (TraceRecord)
└── summary.json    ← RunSummary 对象，会话结束时写入
```

**命名规则**：`frontend` + `threadId` 双级目录。Agent 可通过自身知道的前端标识和 threadId 推导日志路径，实现自定位评估。

示例：
- TUI：`~/.openpx/sessions/tui/tui-lx1234-0/events.jsonl`
- CLI：`~/.openpx/sessions/cli/run-lx1234-0/events.jsonl`

## 各组件职责

### `types.ts` — 类型定义

- `OtelValue = string | number | boolean` — OTel attribute value 类型
- `TraceRecord` — 单条记录，字段对齐 OTel Span（非官方类型，不依赖 `@opentelemetry/api`）
- `TraceEvent` — Span 内嵌子事件
- `RunSummary` — 会话结束时的聚合摘要

### `classifier.ts` — 工具失败分类

从 `tool_done` 事件的 `summary` 字段解析失败原因，返回结构化枚举。匹配顺序重要——先精确匹配具体原因，兜底为通用类别。

覆盖工具：`shell_execute`、`edit_file`、`read_file`、`write_file`、`read_mcp_resource`、`mcp__*`、`task`。

枚举值（与 `telemetry/attributes.ts` 的 `FailureReason` 保持一致）：
`shell_nonzero_exit` | `shell_command_not_found` | `shell_permission_denied` | `shell_timeout` | `shell_rejected_policy` | `edit_no_match` | `edit_multiple_matches` | `edit_empty_old_string` | `read_file_not_found` | `read_not_text` | `read_permission_denied` | `write_permission_denied` | `write_path_is_dir` | `file_system_error` | `mcp_server_unavailable` | `mcp_tool_failed` | `subagent_failed` | `subagent_timeout` | `subagent_aborted` | `unknown`

### `recorder.ts` — 事件映射器

将每个 `AgentEvent` 转为一条 `TraceRecord`。**全量映射，一条都不丢。**

内容截断策略（本地日志用于调试，仅控制文件体积，不做隐私脱敏）：

| 字段 | 阈值 | 说明 |
|------|------|------|
| `TRUNC_CONTENT = 10000` | 10K 字符 | text / reason / final 正文、file_change preview |
| `TRUNC_SUMMARY = 4096` | 4K 字符 | tool_done summary、subagent summary、审批理由/预期效果 |
| `TRUNC_ARGS = 4096` | 4K 字符 | tool_call args、subagent toolArgs（JSON 序列化后） |
| `TRUNC_ERROR = 500` | 500 字符 | error message、retry error |
| `TRUNC_COMMAND = 500` | 500 字符 | 审批命令 |
| `TRUNC_QUESTION = 500` | 500 字符 | 用户提问 |

截断时追加 `…(truncated, N total)` 标记，明确告知数据不完整。

**每条事件记录的内容清单**：

| 事件 | 记录的属性 |
|------|-----------|
| `text` | `openpx.text.length` + `openpx.text.content` (截断) |
| `reason` | `openpx.reason.length` + `openpx.reason.content` (截断) |
| `tool_call` | `openpx.tool.name` + `call_id` + `openpx.tool.args` (JSON 序列化) |
| `tool_done` | `name` + `call_id` + `ok` + `openpx.tool.summary` (截断) + `failure_reason` (失败时) + `total_lines` |
| `need_approval` | `tool` + `risk` + `command` (截断) + `reason` + `expected_effects` + `model_justification` + `objective` |
| `need_input` | `question` (截断) + `options` (JSON) + `context` |
| `state_change` | `workspace_access` + `phase` + `model` + `plan` (JSON) + `authorization_mode` |
| `file_change` | `path` + `kind` + `lines_added` + `lines_removed` + `preview` (截断) |
| `final` | `openpx.final.length` + `openpx.final.content` (截断) |
| `error` | `recoverable` + `message` (截断) |
| `cache_metrics` | `input_tokens` + `output_tokens` + `cache_hit/miss_tokens` |
| `model_retry` | `attempt` + `max_attempts` + `delay_ms` + `error` (截断) |
| `subagent_start` | `id` + `role` + `task` (截断) |
| `subagent_step` | `id` + `tool_name` + `tool_args` (JSON) |
| `subagent_tool_result` | `id` + `tool_name` + `ok` + `summary` (截断，前 200 字符) + `duration_ms` + `failure_reason` |
| `subagent_done` | `id` + `tool_call_count` + `duration_ms` + `summary` (截断) |
| `subagent_error` | `id` + `error` (截断) + `summary` (截断，如有) + `tool_call_count` + `duration_ms` |
| `interrupt` / `update` / `need_approval` / `need_input` | interrupt 路径事件，通过 `processStream` 中的显式 `collector.record()` 记录 |

### Span 层级

`nextTurn()` 创建 turn span，`step_begin` 时生成 node span。事件 parent 选择：有活跃 node span → node，否则 fallback 到 turn span。

```
session.start (root)
├── agent.turn [1]                    ← nextTurn() 创建 (_currentTurnSpanId)
│   ├── openpx.turn.index = 1
│   ├── node.agent                    ← step_begin → 生成 (_currentNodeSpanId)
│   │   ├── text                      ← parent = node span
│   │   ├── tool_call                 ← parent = node span
│   │   └── tool_done                 ← parent = node span
│   ├── node.tools                    ← 同上
│   ├── subagent.start                ← parent = node span (task 工具内)
│   ├── subagent_step                 ← 同上
│   ├── subagent_done                 ← 同上
│   └── ...
├── agent.turn [2]
│   └── ...
└── session.end (root)                ← finalize() 时写入
```

### 单文件策略

一个会话的所有事件（包含子 Agent）写入同一个 `events.jsonl` 文件。**子 Agent 不创建独立日志文件**——子 Agent 事件通过 `subagentEventSink` → `emitAndRecord()` → 父会话的 `collector` 写入。`subagent/runner.ts` 仅 import `classifyToolFailure`，不依赖 `SessionLogCollector` 或 `SessionLogWriter`。

### `writer.ts` — JSONL 写入器

**设计：借鉴 Pino/Winston 的 async flush 模式。**

- `write(record)` → O(1) push 到内存缓冲（纳秒级）
- 缓冲满 50 条或事件循环 tick 结束 → `appendFile` 异步写盘（fire-and-forget）
- `finalizeSync()` → 会话结束时同步写盘，保证剩余数据 100% 落盘
- I/O 失败静默——日志是辅助功能，不能拖垮 Agent

```typescript
class SessionLogWriter {
  write(record: unknown): void;     // 主流程调用，永不阻塞
  finalizeSync(): void;             // 会话结束，同步刷盘
}
```

### `collector.ts` — 会话生命周期管理

`SessionLogCollector` 伴随一次 `runAgent` 的完整生命周期：

```
构造函数
├── genTraceId() — 32 位 hex
├── new SessionLogWriter(threadId)
├── 初始化 RunSummary (设备信息、模型配置)
└── 写入 session.start 记录

record(event)
├── recordEvent() — event → TraceRecord
├── writer.write() — 推入 JSONL 缓冲
└── _updateStats() — 更新 summary 统计

finalize(status)
├── 写入 session.end 记录
├── writeFileSync summary.json
└── writer.finalizeSync()
```

**错误隔离**：所有方法内部 try/catch 静默——日志代码的任何异常不能中断 Agent 主循环。

### `runner.ts` 集成

`runAgent` 中存在**两条事件路径**，必须都覆盖：

| 路径 | 来源 | 事件类型 |
|------|------|---------|
| A — 主 Agent | `processStream` → `chunkToEvents` → `for(e of events)` | text、reason、tool_call/done、approval、error、final 等 |
| B — 子 Agent | `subagentEventSink` → 直接调用（不经过 processStream） | subagent_start、subagent_step、subagent_tool_result、subagent_done、subagent_error、subagent_cache_metrics |

路径 B 在 graph 工具执行期间触发，事件**从不出现**在 LangGraph stream chunk 中，因此 `processStream` 的事件循环无法捕获它们。需要通过 `subagentEventSink` 显式写入日志。

实现模式：

```typescript
// runAgent() 中

// 1. collector 在 sink 之前创建（闭包捕获）
const collector = new SessionLogCollector(threadId, workspace, frontend, model);

// 2. 统一出口：发送到 TUI + 写入会话日志
const emitAndRecord = (event: AgentEvent): void => {
  provider.onEvent(event);
  try { collector.record(event); } catch { /* 静默 */ }
};

// 3. 子 Agent 事件通过 emitAndRecord（覆盖路径 B）
const subagentEventSink = (e) => {
  switch (e.type) {
    case 'start': emitAndRecord({ type: 'subagent_start', data: e.data }); break;
    // ... 共 6 种事件
  }
};

// 4. 主 Agent 事件通过 processStream（覆盖路径 A）
// processStream() 中
for (const e of events) {
  provider.onEvent(e);
  try { collector?.record(e); } catch { /* 静默 */ }
}

// 5. toolResultSink 仅推 TUI，不写日志（processStream 从 chunk 生成更完整数据）
const toolResultSink = (callId, toolName, ok, summary, totalLines) => {
  provider.onEvent({ type: 'tool_done', data: { ... } });  // 无 collector.record
};
```

> **双写防范**：默认 `toolResultSink` 在工具执行中触发，`processStream` 从 chunk 的 `ToolMessage` 再次生成 `tool_done`。前者是截断摘要（200 字符），后者是完整 JSON 解析结果。只有后者写入日志，避免同一条 `tool_done` 被记录两次且保留高质量版本。

// 正常结束
collector.finalize('completed');
// 异常结束
collector.finalize('fatal');
```

## 设计原则

- **零依赖**：不引入 `@opentelemetry/api` 或其他第三方包。类型自建，格式兼容 OTLP JSON 但不绑定
- **始终启用**：本地文件日志无网络、无隐私风险，不做开关
- **主循环零阻塞**：异步写盘 + 内存缓冲，`record()` 调用为纳秒级
- **静默失败**：所有 I/O 异常被捕获，日志故障绝不传播到 Agent
- **全量记录**：每条 AgentEvent 都转为 TraceRecord，不做采样或过滤
- **本地完整**：记录实际内容（文本、参数、摘要），区别于遥测通道的脱敏数据

## 不做什么

- 不提供 OTLP/HTTP 导出——那是 `core/telemetry/` 的职责
- 不做隐私脱敏——本地文件，用户自己控制
- 不做日志轮转/清理——当前量级（每会话 ~50KB-2MB JSONL）无需
- 不引入 `@opentelemetry/api` 依赖——保持零外部依赖

## 验证

```bash
bun run typecheck
bun test tests/session-logger/
```

测试覆盖（`recorder.test.ts` 19 tests + `writer.test.ts` 5 tests）：
- 所有 20 种 AgentEvent 类型的映射正确性
- 内容记录验证（text/reason/tool_call/tool_done/approval/input/final/subagent）
- subagent_tool_result summary 记录（成功/失败）
- 超长内容截断行为
- failure_reason 分类正确性
- spanId 唯一性（100 次无碰撞）
- Writer 写入/async flush/批量写盘/二次 finalize 幂等/数据交错防护

## 与相关文档的关联

- [[2026-06-18-opentelemetry-observability]] — OTel 遥测方案，共用 classifier 逻辑，互补关系
- [[2026-06-18-openpx-telemetry-collection]] — 遥测收集脱敏方案，本地日志无脱敏
- [[layer-boundary-enforcement]] — core 层边界约束，session-logger 位于 core 层
