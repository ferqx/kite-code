# 会话日志本地记录方案

状态：active
创建：2026-06-18
更新：2026-06-19（事件机制重构同步）

## 目标

Agent 运行期间所有事件（模型产出、工具调用、审批交互、子 Agent 生命周期、异常、用户输入）全量记录到本地 OTel 兼容 JSONL 文件，实现：

1. **会话离线回溯**：无需外部平台即可按时间线查看完整执行过程
2. **故障快速定位**：dev 模式下 `errors.jsonl` 单独记录异常，自动附带入参
3. **评估数据基础**：`summary.json` 聚合统计，跨会话对比

## 与 OTel 遥测方案的关系

本模块与 [`2026-06-18-opentelemetry-observability.md`](2026-06-18-opentelemetry-observability.md) **互补，非替代**：

| 维度 | OTel 遥测 (`core/telemetry/`) | 会话日志 (`core/session-logger/`) |
|------|-------------------------------|----------------------------------|
| 存储位置 | 第三方平台 (Grafana/Jaeger/…)，OTLP/HTTP | 本地 `~/.openpx/sessions/<frontend>/<threadId>/` |
| 记录粒度 | Span 树（层级 + 属性），适合聚合查询 | 全量事件流，26 种 AgentEvent → TraceRecord |
| 内容范围 | 工具失败原因、token 用量等结构属性 | **完整内容**：模型文本/推理、工具参数/输出、审批详情 |
| 依赖 | `@opentelemetry/api` | 零外部依赖，自建 OTel 兼容类型 |
| 默认状态 | `enabled: true`，无 endpoint 时 no-op | **始终启用**（纯本地） |
| 隐私 | 遥测通道需 scrubber 脱敏 | 本地不做脱敏 |

## 模块结构

```
src/core/
├── id-utils.ts              ← genTraceId / genSpanId（共享）
└── session-logger/
    ├── types.ts             ← TraceRecord / TraceEvent / RunSummary
    ├── classifier.ts        ← classifyToolFailure + ToolFailureReason 枚举（19 种）
    ├── recorder.ts          ← AgentEvent → TraceRecord 映射（26 种事件，5 级截断）
    ├── writer.ts            ← 非阻塞 JSONL（buffer + queueMicrotask + 链式串行 flush）
    ├── collector.ts         ← SessionLogCollector — 生命周期 + span 层级 + dev errors
    └── index.ts             ← 公开导出

tests/session-logger/
├── recorder.test.ts         ← 26 事件映射 + spanId + 新类型 (25 tests)
└── writer.test.ts           ← 写入/批量/幂等/交错防护 (5 tests)
```

## 输出文件

```
~/.openpx/sessions/<frontend>/<threadId>/
├── events.jsonl             ← 全量事件（每行一条 TraceRecord JSON）
├── errors.jsonl             ← 仅异常事件（dev 模式，NODE_ENV !== 'production'）
└── summary.json             ← RunSummary 聚合统计
```

## 数据模型

### TraceRecord（等价 OTel Span）

```typescript
interface TraceRecord {
  traceId: string;            // 32 hex，会话级
  spanId: string;             // 16 hex，本条唯一
  parentSpanId: string;       // 父 span ID（turn/node），"" = root
  name: string;               // "text" / "tool.read_file" / "agent.turn.begin" ...
  kind: number;               // 1=INTERNAL, 3=CLIENT (node.agent)
  timestamp: string;          // ISO 8601
  attributes: Record<string, OtelValue>;
  status: { code: 'OK' | 'ERROR'; message: string };
  events?: TraceEvent[];      // 子事件 (tool.error, model.retry)
}
```

### Span 层级

```
session.start               root (parentSpanId="")
  user.task "你好"           root
  agent.turn.begin           root (IS the turn span; spanId 由 runAgent 预生成)
    node.agent               parent = turn span
      reason                 parent = node span
      text                   parent = node span
      tool_call              parent = node span
      state_change           parent = node span
      final                  parent = node span (before step_end)
      cache_metrics          parent = node span (before step_end)
    node.agent.end           parent = node span (独立 spanId)
  agent.turn.end             parent = turn span
session.end                  root
```

### 内容截断阈值

| 阈值 | 值 | 适用字段 |
|------|------|------|
| `TRUNC_CONTENT` | 10,000 | text / reason / final 正文、file_change preview、user_message |
| `TRUNC_SUMMARY` | 4,096 | tool_done summary、subagent summary、审批理由/预期效果/plan |
| `TRUNC_ARGS` | 4,096 | tool_call args、subagent toolArgs (JSON 序列化) |
| `TRUNC_ERROR` | 500 | error message、retry error |
| `TRUNC_COMMAND` | 500 | 审批命令 |
| `TRUNC_QUESTION` | 500 | 用户提问 |

截断时追加 `…(truncated, N total)` 标记。

## 各组件职责

### `id-utils.ts` — 共享 ID 生成

```typescript
genTraceId() → 32 hex chars (16-byte random)
genSpanId()  → 16 hex chars (8-byte random)
```

供 `runner.ts`（chunkToEvents 预生成 node spanId）、`collector.ts`（session/turn span）、`recorder.ts`（自动生成兜底）共用。

### `classifier.ts` — 工具失败分类

从 `tool_done.summary` 文本字段解析失败原因，顺序匹配（先精确后兜底）。覆盖 `shell_execute` / `edit_file` / `read_file` / `write_file` / `read_mcp_resource` / `mcp__*` / `task`。

### `recorder.ts` — 事件映射器

26 种 `AgentEvent` → `TraceRecord`，全量映射。事件类型新增后只需增加 switch case。

特殊处理：
- `step_begin`：使用 `event.data.spanId`（chunkToEvents 预生成）作为 spanId，兼作 node span 记录
- `step_end`：独立 spanId（自动生成），parent 指向 node span
- `turn_begin`：collector 传入 `turnSpanId` 作为 spanId，兼作 turn span
- `user_message`：kind='task' → `user.task`，kind='answer' → `user.answer`

### `writer.ts` — 非阻塞 JSONL 写入器

| 特性 | 实现 |
|------|------|
| 写入 | O(1) push 到内存 buffer + `JSON.stringify` |
| 合批 | `queueMicrotask` 同一 tick 内合并 |
| 满批 | 50 条立即触发异步写盘 |
| 顺序 | 链式 `_pendingFlush` 保证 FIFO |
| 落盘 | `finalize()` 先 await pending 再 `appendFileSync` |
| 自定义文件名 | 构造函数 `basename` 参数（默认 `'events'`） |

### `collector.ts` — 会话生命周期

**公开 API**：

```typescript
class SessionLogCollector {
  constructor(threadId, workspace, frontend, model)  // 写入 session.start
  record(event: AgentEvent): void                     // 全量记录 + 聚合统计
  nextTurn(turnSpanId: string): void                  // 切换 turn
  finalize(status: 'completed'|'aborted'|'fatal'): Promise<void>  // 落盘
}
```

**span 层级维护**：`_currentTurnSpanId`(turn) → `_currentNodeSpanId`(node)，step_end 后清除回退到 turn。

**dev 模式 errors.jsonl**：`NODE_ENV !== 'production'` 时创建第二个 `SessionLogWriter('errors')`。以下事件同时写入：

| 事件 | 条件 |
|------|------|
| `tool_done` | `ok: false` |
| `subagent_tool_result` | `ok: false` |
| `error` | 始终 |
| `subagent_error` | 始终 |
| `model_retry` | 始终 |

错误记录自动附带入参：`_pendingArgs` Map 缓存 `tool_call`/`subagent_step` 的 args，按 `call_id` 或 `subagentId:toolName` 查找。

**聚合统计**：`_updateStats()` 跟踪 tool_calls（total/ok/failed）、modelRetries、subAgents（total/ok/failed）、errors。turns 由 `nextTurn()` 驱动。

## runner.ts 集成

### EventSink 统一管道

```typescript
interface EventSink { emit(event: AgentEvent): void }

// runAgent() 中
let collector: SessionLogCollector;
const sink: EventSink = {
  emit(e) {
    try { provider.onEvent(e); } catch {}  // TUI
    try { collector.record(e); } catch {}  // 日志
  },
};
collector = new SessionLogCollector(...);

// 初始任务 → user_message 事件
if (!input.resume) {
  sink.emit({ type: 'user_message', data: { text: input.task, kind: 'task' } });
}

// 中断应答 → user_message 事件
if (action.type === 'input' && action.text) {
  sink.emit({ type: 'user_message', data: { text: action.text, kind: 'answer', interruptType: 'input' } });
}
```

### Turn 边界

```typescript
while (true) {
  turnIndex++;
  const turnSpanId = genSpanId();
  collector.nextTurn(turnSpanId);
  sink.emit({ type: 'turn_begin', data: { index: turnIndex, spanId: turnSpanId } });
  const result = await processStream(sink, provider, stream, signal, input.workspace);
  sink.emit({ type: 'turn_end', data: { index: turnIndex } });
  // ...
}
```

### 子 Agent 事件

`subagentEventSink` 内部调用 `sink.emit()`，与主 Agent 共用同一管道。事件最终写入父会话的 `events.jsonl`，子 Agent 不创建独立日志。

### 防御纵深

所有 `provider.onEvent()` 调用均包裹 try/catch，TUI 异常不传播到 Agent 主循环。collector 内部同样 try/catch 静默。

## 设计原则

- **零阻塞**：`sink.emit()` 同步执行，writer 异步 I/O fire-and-forget，`finalize()` 仅在会话结束时 await
- **零故障传播**：3 层 try/catch（sink → collector → writer）
- **零外部依赖**：类型自建，不引入 `@opentelemetry/api`
- **始终启用**：纯本地，无网络无隐私风险
- **全量记录**：26 种 AgentEvent 全映射，不做采样

## 不做什么

- 不提供 OTLP/HTTP 导出（`core/telemetry/` 的职责）
- 不做隐私脱敏（本地文件，用户控制）
- 不做日志轮转/清理
- 子 Agent 不创建独立日志文件

## 验证

```bash
bun run typecheck
bun test tests/session-logger/
bun test tests/runner.test.ts
```

## 关联文档

- [[2026-06-19-event-mechanism-refactor]] — 事件机制重构，turn/user_message 事件化 + EventSink 统一管道
- [[2026-06-18-opentelemetry-observability]] — OTel 遥测，共用 classifier 逻辑
- [[2026-06-18-openpx-telemetry-collection]] — 遥测脱敏方案
- [[layer-boundary-enforcement]] — core 层边界约束
