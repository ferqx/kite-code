# Agent 事件机制重构方案

状态：archived
创建：2026-06-19
实施：2026-06-19（Phase A + Phase B 完成，见提交 a8b5c3e）
归档：2026-06-19（完成记录见 `execution/completed/2026-06-19-event-mechanism-refactor.md`）

## 目标

当前事件机制存在 4 个结构性问题，导致日志模块需要大量补救逻辑（手动插入 turn span、显式记录用户输入、去重 state_change/final、子 agent 事件走旁路）。重构事件模型，使日志（及未来评估层）可以直接消费结构完整的事件流。

## 问题诊断

### P1：无 conversation turn 边界

事件模型是 graph-node-driven，不是 conversation-turn-driven。

```
当前事件流（一次"你好"交互）：
  step_begin(agent) → reason → text → tool_call → state_change → step_end(agent)
  → step_begin(tools) → tool_done → step_end(tools)
  → step_begin(agent) → reason → text → state_change → step_end(agent)
  → final → cache_metrics

问题：
  - 没有 "turn 开始/结束" 标记
  - collector 被迫通过 nextTurn() 手动插入 agent.turn span
  - final/cache_metrics 归属不明（挂在哪个 node？哪个 turn？）
```

### P1：子 Agent 事件走旁路

```
主 Agent 事件：  graph stream → chunkToEvents → events[] → provider.onEvent + collector.record
子 Agent 事件：  subagent runner → eventSink → provider.onEvent（绕过 chunkToEvents，绕过 collector）

问题：
  - 两条管道，新增消费者（如评估器、遥测导出）必须两处都加
  - collector 靠 emitAndRecord 补救，但根本问题没解决
```

### P2：用户输入无事件类型

AgentEvent 只能表达 Agent 产出。用户端的所有输入（初始任务、中断应答、后续消息）不在事件流中。

```
当前处理：
  - 初始任务：collector 通过 recordUserMessage() 手动写入
  - 中断应答：processStream 中 action.type === 'input' 时手动写入
  - 后续消息：每次新的 runAgent() 调用，collector 重新判断 !input.resume

问题：
  - 用户消息在事件流中不可见，消费者必须知道额外的 API
```

### P2：内部节点 / 全局事件无区分标记

- `cleanup` 节点对用户透明，但 step_begin/step_end 仍然 emit
- `final`、`cache_metrics` 在 node 循环之后 emit，不携带归属信息

## 目标架构

```
会话级
├── session_start              ← 设备、模型、workspace 信息
├── user_message "你好"        ← 用户输入（新增事件类型）
├── turn [1]                   ← turn_begin / turn_end 包围
│   ├── node: agent             ← 不再叫 step_begin/step_end
│   │   ├── reason
│   │   ├── text
│   │   ├── tool_call
│   │   └── cache_metrics       ← 作为 agent span 的属性（非独立事件）
│   ├── node: tools
│   │   ├── tool_done
│   │   └── subagent_start/step/result/done/error  ← 走同一事件管道
│   └── final                   ← 作为 turn 的属性，与最后 text 去重
├── turn [2]
│   └── ...
└── session_end
```

## 变更清单

### 1. AgentEvent 类型变更 (`src/protocol/events.ts`)

**新增 3 种事件**：

```typescript
export type AgentEvent =
  // ... 现有 23 种（不变）...

  // ── 新增：会话/对话边界 ──
  | { type: 'turn_begin'; data: { index: number } }
  | { type: 'turn_end'; data: { index: number } }
  | { type: 'user_message'; data: UserMessagePayload };
```

```typescript
export interface UserMessagePayload {
  text: string;
  kind: 'task' | 'answer' | 'resume_context';
  /** 关联的 interrupt 类型，仅 answer 时有值 */
  interruptType?: 'approval' | 'input';
}
```

**step_begin 增加 `internal` 标记**：

```typescript
// 变更前
| { type: 'step_begin'; data: { node: string } }

// 变更后
| { type: 'step_begin'; data: { node: string; internal?: boolean } }
```

graph.ts 中 cleanup 节点加 `internal: true`。`chunkToEvents` 对 internal 节点仍然生成 step_begin/step_end（保持 TUI 兼容），但消费者可以据此过滤。

### 2. 统一事件管道 (`src/core/runner.ts`)

**当前 3 种 emit 模式 → 统一为 1 种**：

```typescript
// 变更前 — processStream 中
for (const e of events) {
  provider.onEvent(e);          // TUI
  allEvents.push(e);            // yield
  try { collector?.record(e); } catch {}  // log
}

// 变更后 — 单一 EventSink 接口
interface EventSink {
  emit(event: AgentEvent): void;
}

// processStream 中
for (const e of events) {
  sink.emit(e);
  allEvents.push(e);
}
```

`EventSink` 在 `runAgent()` 中组装，注入 `provider.onEvent` (TUI) + `collector.record` (log)：

```typescript
const sink: EventSink = {
  emit(e) {
    provider.onEvent(e);
    try { collector.record(e); } catch {}
  },
};
```

子 agent 的 `subagentEventSink` 改为走同一个 sink：

```typescript
// 变更前
const subagentEventSink = (e) => {
  switch (e.type) {
    case 'start': emitAndRecord({ type: 'subagent_start', data: e.data }); break;
    // ...
  }
};

// 变更后 — 直接调用统一 sink
const subagentEventSink = (e) => {
  switch (e.type) {
    case 'start': sink.emit({ type: 'subagent_start', data: e.data }); break;
    // ...
  }
};
```

**关键**：`sink` 在 `collector` 之前定义，因为 sink 内部引用 collector。但 `subagentEventSink` 需要 sink，所以定义顺序变为：

```
sink → collector → subagentEventSink → graph
```

这需要 sink 内部用可变闭包捕获 collector：

```typescript
let collector: SessionLogCollector; // 前置声明

const sink: EventSink = {
  emit(e) {
    provider.onEvent(e);
    try { collector?.record(e); } catch {}
  },
};

collector = new SessionLogCollector(...);
collector.recordUserMessage = ... // 废弃，改用 sink.emit({ type: 'user_message' })

const subagentEventSink = (e) => { ... }; // 用 sink.emit
```

### 3. 用户输入事件化

**变更前**：`collector.recordUserMessage(text, kind)` + `runAgent` 中 `if (!input.resume)` 判断

**变更后**：产生标准的 `user_message` 事件，走 EventSink

```typescript
// runAgent() — 初始任务
if (!input.resume) {
  sink.emit({ type: 'user_message', data: { text: input.task, kind: 'task' } });
}

// processStream — 中断应答
if (action.type === 'input' && action.text) {
  sink.emit({ type: 'user_message', data: { text: action.text, kind: 'answer', interruptType: 'input' } });
}
```

### 4. turn 边界事件化

**变更前**：`collector.nextTurn()` 手动插入 turn span

**变更后**：`nextTurn()` 改为 emit 标准 `turn_begin`/`turn_end` 事件

```typescript
// runAgent() 中
let turnIndex = 0;
while (true) {
  // ...
  turnIndex++;
  sink.emit({ type: 'turn_begin', data: { index: turnIndex } });
  collector.nextTurn(); // 内部逻辑：重置去重状态等
  const result = await processStream(...);
  sink.emit({ type: 'turn_end', data: { index: turnIndex } });
  // ...
}
```

### 5. final / cache_metrics 归属修正

**final**：在 chunkToEvents 中附加 node 归属信息。

```typescript
// 变更前
if (final) events.push({ type: 'final', data: final });

// 变更后 — 标记来自哪个 node
if (final && lastAgentNode) {
  events.push({ type: 'final', data: { text: final, node: lastAgentNode } });
}
```

但这会改变 `final` 的 data 类型。更简单方案：chunkToEvents 处理顺序不变，但在 node 循环内将 final 和 cache_metrics 提前绑定到 agent node：

```typescript
// 变更后 — final 紧随最后一个 agent node 的 step_end 之前 emit
for (const key of Object.keys(record)) {
  // ...
  if (key === 'agent') {
    // 在 agent node 内 emit final 和 cache_metrics
    const final = findFinal(chunk);
    if (final) events.push({ type: 'final', data: final });
    // ...
  }
  events.push({ type: 'step_end', data: { node: key } });
}
```

**cache_metrics**：同理，作为 agent node 的内部事件，不再在 node 循环之后 emit。

### 6. collector 简化

去掉 collector 中的补救逻辑：

| 功能 | 变更前（collector 负责） | 变更后（事件流负责） |
|------|------------------------|-------------------|
| turn span | `nextTurn()` 手动写入 | `turn_begin`/`turn_end` 事件 |
| 用户输入 | `recordUserMessage()` | `user_message` 事件 |
| state_change 去重 | collector 指纹比较 | 事件层去重或保留（事件流应诚实，去重是消费者的事） |
| final 去重 | collector 比较 text | 事件层保证 final 只在必要时 emit |

**原则**：事件流应**诚实完整**。去重、过滤、聚合是消费者（日志/TUI）的职责。collector 不再做去重，但保留 internal 节点过滤（日志不需要 cleanup）。

### 7. step_begin/step_end 语义修正

当前 `step_begin` 和 `step_end` 是独立事件，span 关系需要 collector 手动建立。改为：

- `step_begin` 带 `spanId`（由 emitter 预生成），标记 node span 的开始
- 后续事件带 `parentSpanId`，引用 node span
- `step_end` 标记 node span 的结束

```typescript
// 变更前
| { type: 'step_begin'; data: { node: string } }
| { type: 'step_end'; data: { node: string } }

// 变更后
| { type: 'step_begin'; data: { node: string; spanId: string; internal?: boolean } }
| { type: 'step_end'; data: { node: string; spanId: string } }
```

spanId 由 `chunkToEvents` 中预生成，保证同 node 的 begin/children/end 共享同一 parent。这消除了 collector 中 `_currentNodeSpanId` 的手动维护。

## 向后兼容

| 变更 | TUI 影响 | 应对 |
|------|---------|------|
| step_begin 加 spanId/internal | reducer 需忽略新字段 | TypeScript 结构解构，多余字段自动忽略 |
| 新增 turn_begin/turn_end | reducer 默认忽略不识别事件 | 现有 switch-case 的 default 已是 no-op |
| 新增 user_message | 同上 | 同上 |
| final 提前到 node 内 emit | reducer 的事件顺序处理不变 | 应当无感知（事件仍在同一 chunk 中） |
| cache_metrics 提前到 node 内 | 同上 | 同上 |

## 涉及文件

| 文件 | 变更 |
|------|------|
| `src/protocol/events.ts` | +turn_begin / turn_end / user_message 事件类型；step_begin/step_end 增加 spanId + internal |
| `src/core/runner.ts` | 引入 EventSink；turn 边界 emit；子 agent sink 走统一通道；用户输入事件化 |
| `src/core/session-logger/collector.ts` | 去掉 recordUserMessage/stateFingerprint/final 去重/turn span 手动写入；消费标准事件 |
| `src/core/session-logger/recorder.ts` | 新增 turn_begin/turn_end/user_message 映射 |
| `src/core/harness/graph.ts` | cleanup 节点标记 `internal: true` |
| `src/app/tui/reducers/*` | step_begin 新字段兼容（确认无 break） |
| `tests/session-logger/recorder.test.ts` | 新事件类型测试 |
| `tests/runner.test.ts` | 验证 turn/user_message 事件 emit |

## 实施步骤

| 步骤 | 内容 | 验证 |
|------|------|------|
| 1 | `events.ts` — 新增事件类型 + step_begin/end 扩展 | `bun run typecheck` |
| 2 | `graph.ts` — cleanup 加 internal | typecheck |
| 3 | `runner.ts` — EventSink + turn/user_message emit | `bun test tests/runner.test.ts` |
| 4 | `recorder.ts` — 新事件映射 | `bun test tests/session-logger/` |
| 5 | `collector.ts` — 去掉手动补救，消费标准事件 | 同上 |
| 6 | TUI reducer 兼容检查 | `bun test tests/tui-reducer.test.ts` |
| 7 | 端到端验证：`bun run tui` 发送 "你好"，检查 session log | 人工 |

## 不做什么

- 不改变子 Agent 的执行模型（仍是 task 工具内同步运行）
- 不引入 OpenTelemetry SDK 依赖（事件仍是纯 protocol 类型）
- 不改变 TUI 的 reducer 事件处理逻辑（只增字段，不改结构）
- state_change 不去重——事件流应诚实，去重是消费者职责
