# Agent OpenTelemetry 可观测性方案

状态：superseded
创建：2026-06-18
替代者：
[`2026-07-29-agent-production-observability-operations.md`](2026-07-29-agent-production-observability-operations.md)

> 本计划允许导出 Workspace、文件、命令和错误正文，不符合已批准的生产隐私边界，不再作为
> 实施依据。新实现必须从结构化元数据通过 allowlist mapper 构造，不能复用本计划的全量
> Span → exporter 路径。

## 目标

Agent 运行期间存在工具异常、子 Agent 异常、模型连接错误等。当前这些错误只在事件流中 transient 存在，会话结束后无法回溯分析。

基于 OpenTelemetry 协议，将 Agent 执行过程建模为 Trace + Span 树，通过 OTLP/HTTP 导出到第三方可观测平台（Grafana Tempo / Jaeger / SigNoz / Honeycomb 等），实现：

1. **工具失败排查闭环**：Span 上携带 `kite_code.tool.failure_reason`（结构化枚举），聚合查询即可定位最高频失败原因 → 驱动提示词/工具契约优化
2. **Agent 评估数据基础**：Span 层级天然表达执行树，属性携带质量维度（ok/fail、duration、retry），后续评估层直接消费

## 范围

| 层 | 文件 | 操作 |
|---|------|------|
| protocol | 无变更 | 现有 AgentEvent 已包含所有需要的信息 |
| core | `src/core/telemetry/` | 新增模块，9 个文件 |
| core | `src/core/runner.ts` | 集成 RunTracer |
| core | `src/core/subagent/runner.ts` | 集成 subagent span |
| app | `src/app/tui/index.tsx` | 启动 initTelemetry() |
| app | `src/app/cli/index.ts` | 启动 initTelemetry() |
| deps | `package.json` | +`@opentelemetry/api` |

## 涉及文件

```
src/core/telemetry/
├── attributes.ts           ← 属性 key 常量 + FailureReason 枚举
├── classifier.ts           ← AgentEvent + tool_done summary → failure_reason
├── config.ts               ← TelemetryConfig + 环境变量读取
├── span.ts                 ← KiteCodeSpan implements Span (OTel API)
├── tracer.ts               ← KiteCodeTracer implements Tracer
├── provider.ts             ← KiteCodeTracerProvider implements TracerProvider
├── exporter.ts             ← OTLPHttpExporter (Span[] → OTLP JSON → fetch)
├── run-tracer.ts           ← RunTracer 便捷类（面向 runner.ts 的高层 API）
└── index.ts                ← initTelemetry() + shutdownTelemetry() 公开入口

src/core/
└── runner.ts               ← runAgent / streamCodeAgent / revert / fork 集成

src/core/subagent/
└── runner.ts               ← runSubAgent 集成

src/app/tui/
└── index.tsx               ← initTelemetry() 调用

src/app/cli/
└── index.ts                ← initTelemetry() 调用

tests/telemetry/
├── span.test.ts            ← Span 创建/属性/序列化
├── classifier.test.ts      ← 事件 → failure_reason
├── run-tracer.test.ts      ← RunTracer 集成
└── exporter.test.ts        ← OTLP JSON 格式 + fetch mock
```

## 设计原则

- **只兼容 OTel API 接口，不引入 SDK 全家桶**：`@opentelemetry/api` 定义 `Tracer`/`Span`/`TracerProvider` 等标准接口，我们实现这些接口，Span 结束时序列化为 OTLP JSON 通过 `fetch` 发送
- **core 层 instrumentation，app 层初始化**：Span 创建在 `runner.ts` 内部闭环，各端（TUI/CLI/Desktop）只负责调用 `initTelemetry()` 一次
- **零侵入工具/图节点**：所有信息从现有 `AgentEvent` 流提取，不修改 `graph.ts`、`tool-runner.ts`
- **未配置 endpoint → 全 no-op**：无 OTLP endpoint 时 `initTelemetry()` 不注册 provider，`trace.getTracer()` 返回 no-op tracer（零开销）
- **环境变量 + 配置文件双层控制**：`kite-code.jsonc` 中的 `telemetry` 节为主配置，环境变量 `KITE_CODE_TELEMETRY_ENABLED` / `OTEL_EXPORTER_OTLP_ENDPOINT` 为覆盖层；不提供 CLI flag

## 不做什么

- 不自己存数据（无本地 JSONL/SQLite 存储）——数据全部 OTLP/HTTP 导出
- 不引入 OTel SDK 全家桶——只依赖 `@opentelemetry/api` 接口包（~30KB）
- 不绑定特定平台——任何支持 OTLP 协议的后端均可接入
- 不在 core 层做展示格式化

## Span 层级模型

```
Trace: agent-run-<threadId>-<runIndex>
│
├── Span "agent.turn" [1]                         ← while(true) 的每次迭代
│   ├── attr: kite_code.turn.index = 1
│   │
│   ├── Span "node.cleanup"
│   ├── Span "node.agent"                         ← 模型调用
│   │   ├── attr: gen_ai.system = "deepseek"
│   │   ├── attr: gen_ai.request.model = "deepseek-v4-flash"
│   │   ├── attr: gen_ai.usage.input_tokens = 12000
│   │   ├── attr: gen_ai.usage.output_tokens = 500
│   │   ├── attr: kite_code.cache.hit_tokens = 10000
│   │   ├── attr: kite_code.cache.miss_tokens = 2000
│   │   ├── event: "model.retry" (per retry)
│   │   └── status: ERROR (if all retries exhausted)
│   │
│   ├── Span "node.approval"
│   │   ├── attr: kite_code.approval.tool = "shell_execute"
│   │   ├── attr: kite_code.approval.risk = "execute_code"
│   │   └── attr: kite_code.approval.decision = "approve_once" | "reject"
│   │
│   ├── Span "node.tools"
│   │   ├── Span "tool.shell_execute"
│   │   │   ├── attr: kite_code.tool.ok = false
│   │   │   ├── attr: kite_code.tool.exit_code = 1
│   │   │   ├── attr: kite_code.tool.failure_reason = "shell_nonzero_exit"
│   │   │   ├── attr: kite_code.tool.duration_ms = 3200
│   │   │   ├── event: "tool.error" { stderr_preview, intent }
│   │   │   └── status: ERROR
│   │   │
│   │   ├── Span "tool.edit_file"
│   │   │   ├── attr: kite_code.tool.failure_reason = "edit_no_match"
│   │   │   └── event: "tool.error" { old_string_preview, reason }
│   │   │
│   │   └── Span "tool.task"                     ← 子 Agent
│   │       └── Span "subagent.run"
│   │           ├── Span "subagent.tool.read_file"
│   │           ├── Span "subagent.tool.shell_execute"
│   │           └── status: OK / ERROR
│   │
│   └── Span "node.user_input"
│
├── Span "agent.turn" [2]
│   └── ...
│
└── root status: OK / ERROR
```

## OTel 属性约定

### 标准 `gen_ai.*`（挂 agent span）

| 属性 | 值 |
|------|----|
| `gen_ai.operation.name` | `"chat"` |
| `gen_ai.system` | `"deepseek"` / `"openai"` / `"ollama"` |
| `gen_ai.request.model` | `"deepseek-v4-flash"` |
| `gen_ai.usage.input_tokens` | number |
| `gen_ai.usage.output_tokens` | number |

### 自定义 `kite_code.*`

| 属性 | 类型 | 位置 |
|------|------|------|
| `kite_code.thread_id` | string | root |
| `kite_code.frontend` | `"tui"` / `"cli"` | root |
| `kite_code.workspace` | string | root |
| `kite_code.turn.index` | int | turn |
| `kite_code.tool.name` | string | tool |
| `kite_code.tool.call_id` | string | tool |
| `kite_code.tool.ok` | bool | tool |
| `kite_code.tool.exit_code` | int | tool |
| `kite_code.tool.failure_reason` | string | tool |
| `kite_code.tool.file` | string | tool |
| `kite_code.tool.command` | string | shell |
| `kite_code.tool.duration_ms` | int | tool |
| `kite_code.cache.hit_tokens` | int | agent |
| `kite_code.cache.miss_tokens` | int | agent |
| `kite_code.retry.attempt` | int | retry event |
| `kite_code.subagent.role` | `"explore"` / `"code"` / `"review"` | subagent |
| `kite_code.subagent.id` | string | subagent |
| `kite_code.error.category` | string | error span |
| `kite_code.error.recoverable` | bool | error span |

### `kite_code.tool.failure_reason` 枚举

```typescript
const FailureReason = {
  // shell_execute
  SHELL_NONZERO_EXIT:       'shell_nonzero_exit',
  SHELL_COMMAND_NOT_FOUND:  'shell_command_not_found',
  SHELL_PERMISSION_DENIED:  'shell_permission_denied',
  SHELL_TIMEOUT:            'shell_timeout',
  SHELL_REJECTED_POLICY:    'shell_rejected_policy',
  // edit_file
  EDIT_NO_MATCH:            'edit_no_match',
  EDIT_MULTIPLE_MATCHES:    'edit_multiple_matches',
  EDIT_EMPTY_OLD_STRING:    'edit_empty_old_string',
  // read_file
  READ_FILE_NOT_FOUND:      'read_file_not_found',
  READ_NOT_TEXT:            'read_not_text',
  READ_PERMISSION_DENIED:   'read_permission_denied',
  // write_file (extends to apply_patch when added)
  WRITE_PERMISSION_DENIED:  'write_permission_denied',
  WRITE_PATH_IS_DIR:        'write_path_is_dir',
  FILE_SYSTEM_ERROR:        'file_system_error',    // ENOSPC, EIO, etc.
  // MCP
  MCP_SERVER_UNAVAILABLE:   'mcp_server_unavailable',
  MCP_TOOL_FAILED:          'mcp_tool_failed',
  // task
  SUBAGENT_FAILED:          'subagent_failed',
  SUBAGENT_TIMEOUT:         'subagent_timeout',
  SUBAGENT_ABORTED:         'subagent_aborted',     // 用户取消 / AbortError
  // model
  MODEL_NETWORK:            'model_network',
  MODEL_RATE_LIMIT:         'model_rate_limit',
  MODEL_SERVER_ERROR:       'model_server_error',
  UNKNOWN:                  'unknown',
} as const;
```

**分类逻辑**：`classifier.ts` 从 `tool_done` 事件的 `summary` 字段（ToolMessage content 前 200 字符）中解析错误原因。匹配顺序重要——先精确匹配 `shell_command_not_found` 等具体原因，`shell_nonzero_exit` 作为 shell 工具的兜底。

**可扩展性**：新增工具（如 `apply_patch`）时只需在 `FailureReason` 中增加对应枚举值，无需修改其他模块。

## 核心实现：Span → 批量 OTLP JSON → fetch

### 硬约束：遥测绝不能崩溃 Agent

**所有遥测操作必须被静默保护。** Exporter 层捕获所有异常（`fetch` 失败、序列化错误、endpoint 不可达）。`processStream` 中的 span 操作用 try/catch 包裹，失败时 `console.warn` 一次后不再警告。原则：Agent 主循环永远不因遥测代码抛出而中断。

### 批量导出策略

所有 Span 在 Trace 结束时（`runTracer.end()` → `rootSpan.end()`）批量发送，一次 Trace 一次 HTTP POST，而非每个 Span 单独 `fetch`。

```
RunTracer.end()
  │
  ├── rootSpan.end()
  │   ├── 递归 end 所有未关闭的子 Span
  │   └── 收集整棵 Span 树 → spans[]
  │
  └── exporter.export(spans)
      │
      ├── 构造完整 OTLP JSON payload（含 ResourceSpans / ScopeSpans 信封）
      │
      └── fetch(otlpEndpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          }).catch(() => {})   ← 静默失败，不抛给 Agent
```

进程退出前 `shutdownTelemetry()` 也 flush 所有未发送的 Trace。

### OTLP JSON 序列化（完整信封结构）

符合 [opentelemetry-proto](https://github.com/open-telemetry/opentelemetry-proto) `ExportTraceServiceRequest` 定义，**必须**包含三层信封：

```typescript
// POST /v1/traces 的完整 body
interface ExportTraceServiceRequest {
  resourceSpans: ResourceSpans[];
}

interface ResourceSpans {
  resource: {
    attributes: Attribute[];     // service.name, service.version
    droppedAttributesCount: 0;
  };
  scopeSpans: ScopeSpans[];
}

interface ScopeSpans {
  scope: {
    name: "kite-code";              // instrumentation scope
    version: "0.0.1";
  };
  spans: OTLPSpan[];
}

interface OTLPSpan {
  traceId: string;              // 32 hex chars (16 bytes)
  spanId: string;               // 16 hex chars (8 bytes)
  parentSpanId: string;         // "" for root span
  name: string;
  kind: number;                 // 1=INTERNAL（工具/节点）, 3=CLIENT（模型调用）
  startTimeUnixNano: string;    // uint64 as decimal string
  endTimeUnixNano: string;      // uint64 as decimal string
  attributes: Attribute[];
  events: SpanEvent[];
  status: { code: number; message: string };
  droppedAttributesCount: 0;
  droppedEventsCount: 0;
}

interface Attribute {
  key: string;
  value: { stringValue?: string; intValue?: number; boolValue?: boolean };
}

interface SpanEvent {
  name: string;
  timeUnixNano: string;
  attributes: Attribute[];
  droppedAttributesCount: 0;
}
```

**traceId/spanId**：`crypto.getRandomValues(new Uint8Array(16))` → hex string。不是 `crypto.randomUUID()`——UUID 格式不符 OTLP 长度要求（32 hex / 16 hex）。

**时间戳**：`BigInt(performance.timeOrigin * 1e6) + BigInt(Math.round(performance.now() * 1e6))` → 十进制 string。用 `BigInt` 避免 JS Number 精度损失（纳秒时间戳约 1.7e18，超 2^53）。

**SpanKind**：INTERNAL(1) = agent.turn / node.* / tool.* / subagent.*；CLIENT(3) = node.agent（模型 API 调用）。

**Status**：UNSET(0) = 完成无错误；OK(1) = 工具 ok=true；ERROR(2) = 工具/模型/子 Agent 失败。

## 配置

配置文件为主，环境变量为覆盖——和现有 `deepseek_api_key` 等模式一致。

```jsonc
// ~/.kite-code/kite-code.jsonc
{
  "telemetry": {
    "enabled": true,                            // 默认 true，false → 全链路 no-op
    "otlpEndpoint": "http://localhost:4318/v1/traces"  // 不配置 → otlp 不发送
  }
}
```

优先级：**环境变量 > 配置文件**

| 变量 | 覆盖字段 |
|------|---------|
| `KITE_CODE_TELEMETRY_ENABLED=0` | 禁用所有遥测（覆盖配置文件的 `enabled: true`） |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | 覆盖 `telemetry.otlpEndpoint` |
| `OTEL_SERVICE_NAME` | 服务名，默认 `"kite-code"` |

## 入口 API

```typescript
// src/core/telemetry/index.ts

/** 初始化 Telemetry。幂等。未配置 endpoint 或 KITE_CODE_TELEMETRY_ENABLED=0 → no-op。 */
export function initTelemetry(cfg?: TelemetryConfig): void;

/** 进程退出前调用，flush 所有未发送 span。 */
export async function shutdownTelemetry(): Promise<void>;
```

```typescript
// src/core/telemetry/run-tracer.ts

export interface RunTracer {
  readonly rootSpan: Span;
  readonly traceId: string;
  startTurn(index: number): Span;
  startNode(name: string, parent?: Span): Span;
  recordToolCall(parentSpan: Span, event: ToolDoneEvent): void;
  recordModelRetry(parentSpan: Span, retry: ModelRetryEvent): void;
  end(status: SpanStatusCode, extraAttrs?: Attributes): void;
}

export function createRunTracer(opts: {
  threadId: string;
  workspace: string;
  frontend: string;
  model: { provider: string; name: string };
}): RunTracer;
```

## runner.ts 集成

`processStream` 中通过 `step_begin`/`step_end` 事件自动创建 node span，`tool_done` 触发 tool span。所有遥测调用在 try/catch 内——遥测失败只 `console.warn` 一次，不中断主循环。

```typescript
// src/core/runner.ts

export async function* runAgent(provider, input) {
  // ... 现有 setup ...

  const runTracer = createRunTracer({
    threadId: input.threadId,
    workspace: input.workspace,
    frontend: input.frontend ?? 'unknown',
    model: { provider: input.config.providerName, name: input.config.modelName },
  });

  try {
    let turnIndex = 0;
    while (true) {
      const turnSpan = runTracer.startTurn(turnIndex++);
      const result = await processStream(provider, stream, signal,
        input.workspace, runTracer, turnSpan);
      turnSpan.end();
      yield* result.events;
      if (result.kind === 'done') break;
      resumeValue = mapActionToResumeValue(result.action);
    }
    runTracer.end(SpanStatusCode.OK);
  } catch (e) {
    runTracer.end(SpanStatusCode.ERROR);
    throw e;
  }
}
```

`processStream` 内遍历 events 时提取遥测：

```typescript
// processStream 内部
let currentNodeSpan: Span | null = null;

for (const e of events) {
  try {
    if (e.type === 'step_begin') {
      currentNodeSpan = runTracer.startNode(e.data.node, turnSpan);
    }
    if (e.type === 'tool_done') {
      runTracer.recordToolCall(currentNodeSpan ?? turnSpan, e.data);
    }
    if (e.type === 'model_retry') {
      runTracer.recordModelRetry(currentNodeSpan ?? turnSpan, e.data);
    }
    if (e.type === 'step_end') {
      currentNodeSpan?.end();
      currentNodeSpan = null;
    }
  } catch { /* 遥测失败不影响 Agent */ }
}
```

四个入口函数 `runAgent`、`streamCodeAgent`、`revertToCheckpoint`、`forkFromCheckpoint` 统一走 `processStream`，不改各自逻辑。

## 子 Agent 集成 + 上下文传播

主 Agent 的 trace 上下文通过 `SubAgentRunnerInput` 传播到 `runSubAgent`：

```typescript
// src/core/subagent/runner.ts

export async function runSubAgent(input: SubAgentRunnerInput): Promise<SubAgentResult> {
  const tracer = trace.getTracer('kite-code');

  // 父 trace 上下文（由 task-tool.ts 在调用时传入）
  const span = tracer.startSpan('subagent.run', {
    attributes: {
      'kite_code.subagent.id': id,
      'kite_code.subagent.role': input.role.role,
      ...(input.traceParent ? { 'kite_code.parent_trace_id': input.traceParent.traceId } : {}),
    },
  }, input.traceParent ? trace.setSpanContext(ROOT_CONTEXT, input.traceParent) : undefined);

  try {
    for (const tc of response.tool_calls) {
      const toolSpan = tracer.startSpan(`subagent.tool.${tc.name}`);
      toolSpan.setAttribute('kite_code.tool.ok', ok);
      toolSpan.end();
    }
    span.setStatus({ code: SpanStatusCode.OK });
  } catch (e) {
    span.setStatus({
      code: SpanStatusCode.ERROR,
      message: e instanceof Error && e.name === 'AbortError'
        ? 'Cancelled' : (e?.message ?? String(e)),
    });
  } finally {
    span.end();
  }
}
```

`SubAgentRunnerInput` 新增可选字段：

```typescript
interface SubAgentRunnerInput {
  // ... 现有字段 ...
  traceParent?: { traceId: string; spanId: string };
}
```

## app 层初始化

TUI / CLI 各调用一次 `initTelemetry()`。退出时用 `process.on('beforeExit')`（不是 `'exit'`——后者不支持 async）。

```typescript
// src/app/tui/index.tsx
import { initTelemetry, shutdownTelemetry } from '@/core/telemetry';

initTelemetry();
process.on('beforeExit', async () => {
  await shutdownTelemetry();
});

// src/app/cli/index.ts — 同理
import { initTelemetry, shutdownTelemetry } from '@/core/telemetry';

initTelemetry();
// ... runAgent ...
await shutdownTelemetry();
```

## 实施步骤

### 步骤 1：安装依赖

```bash
bun add @opentelemetry/api
```

涉及文件：`package.json`

验证：`bun run typecheck`

### 步骤 2：创建 `src/core/telemetry/` 模块骨架

创建所有新增文件，按依赖顺序：

1. `attributes.ts` — 属性常量 + FailureReason 枚举（零依赖）
2. `config.ts` — TelemetryConfig + env 读取（依赖 attributes）
3. `span.ts` — KiteCodeSpan（依赖 @opentelemetry/api + attributes）
4. `tracer.ts` — KiteCodeTracer（依赖 span）
5. `exporter.ts` — OTLPHttpExporter（依赖 span）
6. `provider.ts` — KiteCodeTracerProvider（依赖 tracer + exporter + config）
7. `index.ts` — initTelemetry() / shutdownTelemetry()（依赖 provider + config）
8. `classifier.ts` — AgentEvent → failure_reason（依赖 attributes）
9. `run-tracer.ts` — RunTracer 便捷类（依赖 index + classifier）

验证：`bun run typecheck`

### 步骤 3：集成 runner.ts

在 `runAgent`、`streamCodeAgent`、`revertToCheckpoint`、`forkFromCheckpoint` 中：

- 调用 `createRunTracer()` 创建 RunTracer
- `processStream` 中遍历 events 时调用 `recordToolCall()` / `recordModelRetry()`
- try/catch 中调用 `runTracer.end()`

验证：`bun test tests/runner.test.ts`

### 步骤 4：集成 subagent/runner.ts

在 `runSubAgent` 中创建 subagent span + 工具 span。

验证：现有 subagent 相关测试仍通过。

### 步骤 5：app 层初始化

TUI：`src/app/tui/index.tsx` 启动时 `initTelemetry()`，退出时 `shutdownTelemetry()`
CLI：`src/app/cli/index.ts` 同上。

验证：`bun run typecheck`

### 步骤 6：编写测试

| 测试文件 | 覆盖 |
|---------|------|
| `tests/telemetry/span.test.ts` | KiteCodeSpan 创建/属性/事件/序列化 |
| `tests/telemetry/classifier.test.ts` | AgentEvent → failure_reason 分类正确性 |
| `tests/telemetry/run-tracer.test.ts` | RunTracer 生命周期 + Span 层级 |
| `tests/telemetry/exporter.test.ts` | OTLP JSON 格式 + fetch mock |

验证：`bun test tests/telemetry/`

### 步骤 7：端到端验证

```bash
# 禁用验证（零开销）
KITE_CODE_TELEMETRY_ENABLED=0 bun run tui

# 集成测试（需本地 OTel Collector）
docker run --rm -p 4318:4318 otel/opentelemetry-collector-contrib
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318/v1/traces bun run tui
```

## 禁用 / 未配置时的开销

```
initTelemetry()
  ├─ KITE_CODE_TELEMETRY_ENABLED=0  → return（TracerProvider 不注册）
  ├─ OTLP endpoint 未配置        → return（TracerProvider 不注册）
  └─ 正常配置                   → 注册 KiteCodeTracerProvider

createRunTracer()
  └─ trace.getTracer('kite-code')  ← 无 provider → OTel API 返回 NoopTracer
     └─ .startSpan() → NoopSpan ← 所有方法空操作，仅一次 trivial 对象分配
```

`runner.ts` 中始终调用 `createRunTracer()`，无需 `if (enabled)` 分支——OTel API 的 NoopTracer 机制保证了这一点。禁用时每次 runAgent 调用产生 ~10 次 NoopSpan 分配（约 400 bytes），无 I/O、无网络、无计时开销。

## 风险

| 风险 | 严重度 | 缓解 |
|------|--------|------|
| 遥测代码异常导致 Agent 崩溃 | 高 | `processStream` 中所有遥测调用 try/catch 包裹；exporter 静默捕获 fetch 异常；仅首次失败 `console.warn` |
| OTLP endpoint 不可用导致数据丢失 | 中 | 静默 catch + 首次警告。后续可加健康检查 |
| 子 Agent trace 上下文丢失（未传 traceParent） | 中 | `SubAgentRunnerInput.traceParent` 显式传递；task-tool 调用时填入当前 active span |
| 进程退出时未 flush Span | 中 | `beforeExit`（非 `exit`）事件 + `shutdownTelemetry()` async flush |
| `@opentelemetry/api` 在 Bun ESM 下 singleton 不一致 | 低 | API 包纯 JS 零原生依赖；实施前编写隔离测试验证 `trace.getTracer()` 返回同一实例 |
| OTel API 接口版本 breaking change（1.x → 2.x） | 低 | `package.json` 固定 `^1.x`；API 1.x 已长期稳定 |
| `performance.now()` 精度在 Bun 中的表现 | 低 | 用 `BigInt` 计算避免 JS Number 精度损失；纳秒级偏差对 Trace 分析无影响 |
