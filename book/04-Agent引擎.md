# 第四章 核心层：Agent 引擎

## 4.1 LangGraph 图拓扑

OpenPX 的 Agent 核心是一个 LangGraph `StateGraph`，包含 4 个节点和确定性路由：

```
                    ┌──────────────────┐
                    │      START       │
                    └────────┬─────────┘
                             │
                             ▼
                    ┌──────────────────┐
                    │      agent       │ ← LLM 调用 + 工具选择
                    └────────┬─────────┘
                             │
                    route_after_agent
                    ┌────────┼────────┐
                    │        │        │
                    ▼        ▼        ▼
              ┌──────────┐ ┌──────┐ ┌──────────┐
              │ approval  │ │ END  │ │  tools   │
              │(需审批)   │ │      │ │(执行工具) │
              └────┬─────┘ └──────┘ └────┬─────┘
                   │                      │
                   └──────────┬───────────┘
                              │
                              ▼
                    ┌──────────────────┐
                    │    user_input    │ ← ask_user 工具触发
                    └────────┬─────────┘
                             │
                             └──→ 回到 agent
```

### 节点职责

| 节点 | 职责 | 产出 |
|------|------|------|
| `agent` | 调用 LLM，解析工具调用或最终回复 | AIMessage（含 text 或 tool_calls） |
| `tools` | 执行已批准或直通的工具 | ToolMessage |
| `approval` | 等待用户审批受保护工具 | interrupt → resume → ToolMessage |
| `user_input` | 等待用户回答 ask_user 问题 | interrupt → resume → ToolMessage |

### 路由规则

```typescript
// route_after_agent
if (AIMessage 无 tool_calls) → END
if (tool 是 ask_user) → user_input
if (工具需要审批) → approval
else → tools

// route_after_tools / route_after_approval / route_after_user_input
→ agent（回到 LLM 节点）
```

## 4.2 AgentState 图状态

```typescript
interface CodeAgentState {
  messages: BaseMessage[];          // 完整消息历史
  plan: AgentPlan | null;           // 当前计划
  workspaceAccess: WorkspaceAccess; // "read-only" | "write"
  phase: AgentPhase;                // "planning" | "building"
  authorization: AuthorizationState; // shell 授权状态
}
```

状态通过 LangGraph checkpoint 自动持久化到 SQLite。

## 4.3 Runner：runAgent / resumeCodeAgent

### runAgent：首次运行

```typescript
async function* runAgent(
  provider: UserInputProvider,
  input: RunAgentInput,
): AsyncGenerator<AgentEvent>
```

执行流程：
1. 创建 ChatModel 实例
2. 构建工具集（内置 + MCP + Skills + task）
3. 构建 system prompt（静态 + 运行时上下文）
4. 组装初始消息列表
5. 创建 LangGraph StateGraph
6. `graph.stream(state)` 开始执行
7. 每个 chunk → `chunkToEvents()` 映射为 `AgentEvent[]`
8. 通过 `provider.onEvent(event)` 推送给 UI
9. 检测到 interrupt → `provider.requestAction(payload)` 暂停等待
10. 用户 action → `graph.stream(Command({ resume }))` 恢复

### resumeCodeAgent：恢复运行

```typescript
async function* resumeCodeAgent(
  provider: UserInputProvider,
  input: ResumeCodeAgentInput,
): AsyncGenerator<AgentEvent>
```

从 checkpoint 恢复，用于：
- 会话切换后恢复
- CLI `resume` 命令
- TUI 断点续接

### 事件映射

Runner 内部将 LangGraph stream chunk 映射为协议层事件：

| LangGraph 产出 | 映射为 AgentEvent |
|----------------|-------------------|
| AIMessage 文本 | `text` |
| AIMessage.reasoning_content | `reason` |
| AIMessage.tool_calls | `tool_call` |
| ToolMessage | `tool_done` |
| state.plan/workspaceAccess 变更 | `state_change` |
| tool_approval interrupt | `need_approval` |
| user_input interrupt | `need_input` |
| 上下文压缩触发 | `compact_begin` / `compact_end` |
| 模型重试 | `model_retry` |
| 文件操作 | `file_change` |

## 4.4 上下文管理

### 4.4.1 System Prompt 构建

`buildStaticSystemPrompt()` 组装静态 system prompt：

1. 基础角色指令
2. 工具使用指南（来自 ACI 契约）
3. 当前工作区信息
4. Skills 内容（如有）
5. MCP 提示（如有）

### 4.4.2 运行时上下文投影

`buildCacheableRuntimeContext()` 将动态状态投影为**尾部合成 HumanMessage**：

```
[system prompt]  ← 缓存稳定，不变
[messages...]    ← 对话历史
[运行时状态投影]  ← 动态：plan、workspaceAccess、authorization
```

这种布局保证了 prompt cache 命中率——动态内容只出现在尾部。

### 4.4.3 上下文压缩（Compaction）

两层压缩策略：

```
触发条件：token 数超过模型窗口限制
  │
  ├─ Attempt 1: 规则压缩（forceContextCompaction）
  │   └─ 移除冗余 tool_call/ToolMessage 配对，清理孤儿消息
  │
  └─ Attempt 2: LLM 摘要
      └─ 用模型生成上下文摘要替代旧消息，保留最近 8 条消息
```

用户可通过 `/compact` 命令手动触发压缩。

## 4.5 模型工厂

```typescript
function createChatModel(config: AgentConfig): SupportedChatModel
```

根据配置创建模型实例，支持：
- DeepSeek（`@langchain/deepseek`）
- OpenAI（`@langchain/openai`）
- OpenAI-compatible（自定义 baseURL）
- Ollama（`@langchain/ollama`）

## 4.6 Prompt Cache 优化

OpenPX 针对 DeepSeek 的 prompt cache 机制做了专门优化：

1. **静态 system prompt**：不变部分放在消息开头，最大化缓存命中
2. **工具 schema 稳定**：基集工具顺序固定，MCP 工具追加在末尾
3. **运行时状态尾部注入**：动态内容不破坏前缀缓存
4. **cache_metrics 事件**：实时监控缓存命中率，TUI 状态栏显示
