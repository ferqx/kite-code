# LangChain 依赖脱离

状态：**completed**（2026-07-12 完成 @langchain/core 移除）  
创建日期：2026-07-10  
依赖：[Runtime Kernel 切换追踪](2026-07-10-runtime-kernel-cutover-status.md)（LangGraph 移除已完成）
前置条件：`ai@7.0.19`、`@ai-sdk/openai-compatible@3.0.7`、`@ai-sdk/mcp@2.0.10` 已安装

> 父方案删除了 LangGraph（12 个 npm 包）。本文档处理剩余的 `@langchain/*` 运行时依赖，
> 目标是将 provider 层从 LangChain 中脱离，消除所有 `@langchain/*` 依赖。

> 2026-07-11：Runtime Kernel 切换已完成。Provider 包（openai/deepseek/ollama）已移除。
> 
> 2026-07-12：`@langchain/core` 已完全移除。消息类型替换为 `src/core/messages.ts` 中的
> 内部实现（plain object + 工厂函数 + 类型守卫），`tool()` 替换为 AI SDK 的 `tool()`。

---

## 动机

LangChain 在当前项目中已降级为一层薄 HTTP client wrapper——仅用于构造 API 请求和解析响应。
项目的模型调用、工具审批、执行 pipeline、中断处理全部由 Runtime Kernel 控制，
不依赖 LangChain 的 agent 框架。

替换的实际收益：

| 方面 | 说明 |
|------|------|
| 减少依赖 | 3 个 provider `@langchain/*` 包 + 1 个 MCP SDK → 0（`@langchain/core` 保留消息类型） |
| 消除 subclass hack | `_generate` / `completionWithRetry` override → 标准 middleware |
| Provider 统一 | 三个独立 provider 包 → 一个 `@ai-sdk/openai-compatible` |
| MCP 简化 | `@modelcontextprotocol/sdk` + 手写适配 → `@ai-sdk/mcp` |

---

## 迁移范围

| 包 | 当前用途 | 替换目标 |
|---|---|---|
| `@langchain/openai` | OpenAI/openai-compatible HTTP client | `@ai-sdk/openai-compatible` + `doGenerate()` |
| `@langchain/deepseek` | DeepSeek HTTP client + reasoning passback | 同上 |
| `@langchain/ollama` | Ollama HTTP client | 同上 |
| `@langchain/core` | `BaseMessage` 等消息类型 + `tool()` 定义 | `src/core/messages.ts`（内部实现）+ `ai` SDK 的 `tool()` |
| `@modelcontextprotocol/sdk` | MCP client / transport | `@ai-sdk/mcp` |

---

## 架构定位

```
┌─────────────────────────────────────────────────┐
│  Runtime Kernel（不变）                           │
│  ┌───────────────┐   ┌─────────────────────────┐ │
│  │ model-ctrl    │──→│ tool-ctrl               │ │
│  │ (构建上下文)   │   │ (审批 → 执行 → 事件)     │ │
│  └───────┬───────┘   └─────────────────────────┘ │
│          │                                       │
│          ▼                                       │
│  ┌──────────────────────────────────────────┐    │
│  │  invokeBoundModel()                      │    │
│  │  ┌──────────────────────────────────┐    │    │
│  │  │ BaseMessage[] → ModelMessage[]    │    │    │ ← 调用点做一次转换
│  │  │ wrappedModel.doGenerate({ ... })  │    │    │ ← 单次 HTTP 请求
│  │  │ result.toolCalls → 返回 Kernel     │    │    │
│  │  └──────────────────────────────────┘    │    │
│  └──────────────────────────────────────────┘    │
└─────────────────────────────────────────────────┘
```

**原则**：`@ai-sdk/openai-compatible` 仅作为一个有类型定义的 HTTP client 使用。
Kernel 保持对所有流程（循环、中断、审批、事件）的完全控制。

---

## 目标 1：Provider 替换

### 受影响文件

```
src/core/model/
  factory.ts      — ChatOpenAI + ChatDeepSeek + ChatOllama → createOpenAICompatible()
                     RetryingChatOpenAI / RetryingChatOllama / PatchedChatDeepSeek 全部删除
  deepseek.ts      — withTransientModelRetry → middleware
                     isTransientModelConnectionError 保留
  invoke.ts        — invokeBoundModel(): bindTools + invoke → wrappedModel.doGenerate()
                     消息在调用点从 BaseMessage[] 转为 ModelMessage[]（仅此处转换）
controllers/
  model-controller.ts — retry listener 注入方式调整（setRetryListener → factory 参数）
tools/
  definitions.ts   — tool() from '@langchain/core/tools' → tool() from 'ai'
                     createAgentTools() 返回 ToolSet 替代 StructuredTool[]
  skill-tool.ts    — 同上
subagent/
  task-tool.ts     — 同上
```

### Step 1: 重写 factory.ts

```ts
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { wrapLanguageModel, type LanguageModelV4 } from 'ai';

// 返回包装对象：model 用于调用，setRetryListener 用于注入 per-invocation 回调
export function createChatModel(config: AgentConfig): {
  model: LanguageModelV4;
  setRetryListener: (listener: ModelRetryListener | null) => void;
} {
  const provider = createOpenAICompatible({
    name: config.providerType,
    apiKey: config.apiKey,
    baseURL: config.baseURL,
  });

  let retryListener: ModelRetryListener | null = null;

  const model = wrapLanguageModel({
    model: provider(config.modelName),
    middleware: [
      transientRetryMiddleware({
        get onRetry() { return retryListener ?? undefined; },
      }),
      deepseekReasoningPassbackMiddleware(),
    ],
  });

  return { model, setRetryListener: (fn) => { retryListener = fn; } };
}

export type SupportedChatModel = ReturnType<typeof createChatModel>;
```

- `RetryingChatOpenAI`、`RetryingChatOllama`、`PatchedChatDeepSeek` 三个类全部删除
- `CallbackManagerForLLMRun`、`ChatResult` import 删除

### Step 2: Transient retry → middleware

```ts
import type { LanguageModelV4Middleware } from 'ai';

function transientRetryMiddleware(options: {
  onRetry?: (attempt: number, maxAttempts: number, error: unknown, delayMs: number) => void;
}): LanguageModelV4Middleware {
  return {
    specificationVersion: 'v4',
    wrapGenerate: async ({ doGenerate }) => {
      return withTransientModelRetry(() => doGenerate(), {
        onRetry: options.onRetry,
      });
    },
  };
}
```

`withTransientModelRetry` 和 `isTransientModelConnectionError` 逻辑不变，只是从 subclass override 移到 middleware 中。

### Step 3: DeepSeek reasoning_content passback → middleware

```ts
function deepseekReasoningPassbackMiddleware(): LanguageModelV4Middleware {
  return {
    specificationVersion: 'v4',
    transformParams: async ({ params }) => {
      // 在发送前遍历 messages，按 HumanMessage 边界划分 turn，
      // 注入 reasoning_content 字段。逻辑不变，操作对象从
      // BaseMessage[] 改为 ModelMessage[]
      return params;
    },
  };
}
```

### Step 4: 重写 invokeBoundModel()

```ts
// 前：LangChain
// const bound = model.bindTools(tools, { tool_choice: 'auto' });
// return await bound.invoke(messages, { signal });

// 后：ai-sdk doGenerate（消息在调用点转换）
export async function invokeBoundModel(params: {
  model: SupportedChatModel;   // { model: LanguageModelV4; setRetryListener }
  tools: ToolSet;
  messages: BaseMessage[];
  signal?: AbortSignal;
}): Promise<AIMessage> {
  const modelMessages = toModelMessages(params.messages);
  const result = await params.model.model.doGenerate({
    inputFormat: 'messages',
    prompt: modelMessages,
    tools: params.tools,
    toolChoice: { type: 'auto' },
    abortSignal: params.signal,
  });

  return toAIMessage(result);
}
```

**消息在 `invoke.ts` 内部做一次转换**，不向外暴露 `ModelMessage` 类型。其他文件的
`BaseMessage` import 保持不变。

注意：`createAgentTools()` 当前返回 `any[]`（LangChain StructuredTool 数组），
但 `doGenerate` 接受 `ToolSet`（`Record<string, Tool>`）。需要在 `invokeBoundModel`
内部做 `array → ToolSet` 转换，或直接修改 `createAgentTools()` 返回 `ToolSet`：
- `BaseMessage` → `ModelMessage` 转换集中在一处
- `doGenerate` 结果 → `AIMessage` 也集中在一处
- 待后续有动力时再考虑全局类型替换

### Step 5: `tool()` → `ai` SDK

`definitions.ts`、`skill-tool.ts`、`task-tool.ts` 中的 `tool()` 从 `@langchain/core/tools` 切换到 `ai`：

```ts
// 前（LangChain）：
import { tool } from '@langchain/core/tools';
const readFileTool = tool(
  async ({ path }) => JSON.stringify(readFile({ ... })),
  { name: 'read_file', description: '...', schema: z.object({ path: z.string() }) },
);

// 后（ai-sdk）：
import { tool } from 'ai';
const readFileTool = tool({
  description: '...',
  inputSchema: z.object({ path: z.string() }),
  execute: async ({ path }) => JSON.stringify(readFile({ ... })),
});
```

- `createAgentTools()` 返回类型从 `any[]` → `ToolSet`
- MCP 工具分支（目标 2 完成后）直接合并 `client.tools()` 返回的 `ToolSet`
- `invokeBoundModel()` 的 `tools` 参数对应改为 `ToolSet`

### Step 6: 移除 provider 依赖

```bash
bun remove @langchain/openai @langchain/deepseek @langchain/ollama
```

---

## 目标 2：MCP → `@ai-sdk/mcp`

### 当前现状

`McpManager` 手写 transport/client 管理 + `tool-adapter.ts` 将 MCP SDK Tool 包装为
LangChain `StructuredTool`。`@ai-sdk/mcp` 的 `createMCPClient` 内置 transport，
`client.tools()` 直接返回 ai-sdk tool 对象。

### 关键约束

> `@ai-sdk/mcp@2.0.10` 文档："It currently does not support accepting notifications from an MCP server."

`toolListChanged` 通知监听无法用 `@ai-sdk/mcp` 实现。

### 受影响文件

```
src/core/mcp/
  manager.ts       — 手写 transport/client → createMCPClient()
  tool-adapter.ts  — 整体废除
  index.ts         — 更新导出
src/core/tools/
  definitions.ts   — MCP 工具合成分支简化
```

### 实施步骤

#### Step 1: 替换 MCP client

```ts
import { createMCPClient } from '@ai-sdk/mcp';
import { Experimental_StdioMCPTransport } from '@ai-sdk/mcp/mcp-stdio';
```

#### Step 2: 通知监听方案

| 方案 | 做法 |
|------|------|
| **A** | 保留 `@modelcontextprotocol/sdk` 轻量层仅用于通知 |
| **B** | 降级——工具列表仅 connect 时获取一次 |
| **C** | 轮询——定期 `mcpClient.tools()` 刷新 |

#### Step 3: 废除 tool-adapter.ts + 简化 definitions.ts

`client.tools()` 直接返回 ToolSet，`adaptMcpTool()` / `jsonSchemaToZod()` 不再需要。

---

## 消息类型转换（invoke.ts 内部）

```ts
// BaseMessage → ModelMessage（仅此一处）
function toModelMessages(messages: BaseMessage[]): ModelMessage[] {
  return messages.map(msg => {
    if (HumanMessage.isInstance(msg))    return { role: 'user', content: msg.content as string };
    if (SystemMessage.isInstance(msg))  return { role: 'system', content: msg.content as string };
    if (AIMessage.isInstance(msg))      return toAssistant(msg);
    if (ToolMessage.isInstance(msg))    return toTool(msg);
    throw new Error(`Unknown message type`);
  });
}

// doGenerateResult → AIMessage（仅此一处）
function toAIMessage(result: LanguageModelV4GenerateResult): AIMessage {
  return new AIMessage({
    content: result.text,
    tool_calls: result.toolCalls?.map(tc => ({
      id: tc.toolCallId, name: tc.toolName, args: tc.input, type: 'tool_call',
    })),
    response_metadata: {
      usage: result.usage,
      finishReason: result.finishReason,
    },
    additional_kwargs: {
      reasoning_content: result.reasonings?.map(r => r.text).join(''),
    },
  });
}
```

> 保持 `AIMessage` 返回值是为了不破坏 `model-controller.ts` → `executeRuntimeTools` 的
> 现有接口。等后续有动力时可以全局替换，但当前边际收益为零。

---

## 迁移后状态

| 依赖 | 状态 |
|------|------|
| `@langchain/openai` | 移除 |
| `@langchain/deepseek` | 移除 |
| `@langchain/ollama` | 移除 |
| `@langchain/core` | **已移除**（消息类型替换为 `src/core/messages.ts`，`tool()` 替换为 AI SDK） |
| `@modelcontextprotocol/sdk` | 移除或降级为仅通知层 |

> `@langchain/core` 移除方案：创建 `src/core/messages.ts`，定义与 LangChain 兼容的
> 消息接口 + 工厂函数（`aiMessage()`/`humanMessage()`/`systemMessage()`/`toolMessage()`）+
> 类型守卫（`isAIMessage()` 等）。19 个源文件 + 6 个测试文件的导入路径和调用点全部替换。
> `tool()` 从 `@langchain/core/tools` 切换到 `ai`。
> 本文档即为该迁移的实施记录。

---

## 验证清单

### 迁移正确性

- [x] `bun run typecheck` — 零错误
- [x] `bun test` — 1202/1207 通过（5 个预存定时/路径问题，无关迁移）
- [ ] `bun run test:e2e` — PTY 系统测试通过
- [ ] `bun run test:real` — 真实模型端到端测试通过（DeepSeek + OpenAI + Ollama 三个 provider）
- [x] `grep -r "@langchain/openai\|@langchain/deepseek\|@langchain/ollama" src/` 零匹配
- [x] `grep -r "@langchain/core" src/ tests/` 零匹配（仅 `messages.ts` 注释中引用）
- [ ] `grep -r "@modelcontextprotocol/sdk" src/` 零匹配（方案 A 则不要求）

### 遥测

> `@ai-sdk/otel` / `@ai-sdk/devtools` 的 telemetry 钩子挂载在 `generateText`/`streamText`
> 生命周期上，`doGenerate` 不触发。所有遥测仍由手动 OTEL 方案
> （[OTel 遥测方案](2026-06-18-opentelemetry-observability.md)）从 `RuntimeEvent` 流采集。

---

## 追踪关系

```
2026-07-08-agent-kernel-incremental-evolution  （父方案：Kernel 基础设施）
  └─ 2026-07-10-runtime-kernel-cutover-status  （Graph 移除 + Kernel 切换状态）
       └─ 2026-07-10-langchain-to-ai-sdk-migration  （本文档：LangChain 依赖脱离）
```
