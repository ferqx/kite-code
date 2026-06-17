# 后台子 Agent

> Status: draft
>
> 关联：`understanding/2026-05-30-multi-agent-design.md` — 多 Agent 架构设计
>
> 背景：模型调用 `task` 工具时只能同步阻塞等待结果。对于可并行的探索类任务（如同时搜索多个模块），同步模式浪费等待时间，模型需要后台执行能力。

## 目标

给 `task` 工具加 `background: true` 参数。模型自主判断何时用后台，框架负责生命周期管理、结果注入和中止传播。

| 模式 | 行为 | 适用场景 |
|------|------|----------|
| 同步（默认） | task 调用阻塞，等待子 agent 完成，结果直接注入对话 | 模型需要结果才能继续 |
| 后台（新） | task 立即返回 placeholder，子 agent 异步运行，完成后结果注入对话 | 并行派发搜索、预加载信息、不阻塞主流程 |

## 范围

| 模块 | 涉及子系统 |
|------|-----------|
| session 基础设施 | `core/session/context.ts`（新建）— `SessionContext`：per-session 基础设施容器 |
| 后台任务管理 | `core/subagent/background.ts`（新建）— `BackgroundTaskManager`：launch/peekUndelivered/markDelivered/commit |
| task 工具 | `core/subagent/task-tool.ts` — schema 加 `background` 参数，分支逻辑 |
| graph 注入 | `core/harness/graph.ts` — agent 节点 peekUndelivered + markDelivered；tools 节点传 BTM |
| runner 编排 | `core/runner.ts` — `RunAgentInput` 加 `backgroundTasks`；while 底部 commit |
| TUI 适配 | `session-manager.ts` — `SessionRuntime` 持有 `SessionContext`；重构 abort/runTask |
| TUI 渲染 | `SubAgentBlock.tsx` + `handleEvent.ts` — 后台标签 + 样式区分 |

明确不做：
- 后台结果持久化（不引入僵尸任务恢复）
- 后台 code agent 自动降级为同步（模型自主决策）
- 独立后台面板（第一版复用内联 SubAgentBlock）

---

## 2. 架构

### 2.1 类职责

```
┌── src/core/session/ ──────────────────────────────────────────┐
│                                                                │
│  SessionContext（新）                                           │
│  ├─ 生命周期 = session 生命周期                                 │
│  ├─ BackgroundTaskManager → 后台子 agent 池                    │
│  ├─ AbortController → 主 agent loop 中止信号                   │
│  └─ conversationHistory → 跨 run 共享的 shell 上下文            │
│                                                                │
│  定位：core 层 per-session 基础设施容器。纯数据逻辑，无 UI 依赖。 │
│  未来 Desktop/Web 前端可直接复用。                               │
│                                                                │
└────────────────────────────────────────────────────────────────┘
                    ▲
                    │ 持有
                    │
┌── src/app/tui/ ───────────────────────────────────────────────┐
│                                                                │
│  SessionRuntime（重构）                                         │
│  ├─ ctx: SessionContext                                        │
│  ├─ 事件缓冲、前后台模式、中断代理                               │
│  └─ abort() → ctx.abort() + TUI 清理                          │
│                                                                │
│  定位：TUI 层会话适配。管事件路由和中断交互，不碰基础设施。       │
│                                                                │
└────────────────────────────────────────────────────────────────┘
                    ▲
                    │ 管理
                    │
┌── src/app/tui/ ───────────────────────────────────────────────┐
│                                                                │
│  SessionManager（微调）                                         │
│  ├─ 创建/切换/删除 session                                     │
│  └─ removeRuntime() 时 SessionContext 随 SessionRuntime 被 GC   │
│                                                                │
└────────────────────────────────────────────────────────────────┘
```

### 2.2 数据流

```
用户发消息
  │
  ▼
SessionRuntime.runTask(task)
  │
  ├─ 重建 AbortController（上一轮已触发，新轮需新 signal）
  │    ctx.abortController = new AbortController()
  │
  └─ runAgent(provider, {
       signal: ctx.abortController.signal,
       backgroundTasks: ctx.backgroundTasks,   // ← 同一个实例跨 run 存活
       ...
     })
       │
       ├─ buildCodeAgentGraph({ backgroundTasks })
       │    │
       │    ├─ agent 节点: peekUndelivered → 注入 messages → 调模型 → markDelivered
       │    │
       │    └─ tools 节点: task(background=true) → mgr.launch()
       │         ├─ 同步返回 placeholder ToolMessage
       │         └─ runSubAgent() 在后台异步执行
       │              └─ 完成 → 结果进 completed 队列
       │
       └─ while 循环每轮 stream 结束后: mgr.commit()
```

### 2.3 LangGraph 拓扑

```
                        ┌───────────────────────────────────────────────┐
                        │           buildCodeAgentGraph()               │
                        │                                               │
  graph.stream() ──────►│  START                                       │
                        │    │                                         │
                        │    ▼                                         │
                        │  cleanup                                     │
                        │    │                                         │
                        │    ▼                                         │
                        │  ┌──────────────────────────────────────┐    │
                        │  │        agent 节点 ★                  │    │
                        │  │                                      │    │
                        │  │  ① peekUndelivered()                │    │
                        │  │  ② 注入已完成结果到 messages         │    │
                        │  │  ③ 调模型                           │    │
                        │  │  ④ markDelivered(ids)              │    │
                        │  │                                      │    │
                        │  └──────────────────────────────────────┘    │
                        │               │                              │
                        │               ▼                              │
                        │         routeAfterAgent                      │
                        │      ┌─────────┼─────────┐                   │
                        │      │         │         │                   │
                        │      ▼         ▼         ▼                   │
                        │  approval   tools ★  user_input              │
                        │      │         │         │                   │
                        │      │         │         │                   │
                        │      └────┬────┘         │                   │
                        │           │              │                   │
                        │           ▼              │                   │
                        │         agent ◄──────────┘                   │
                        │           │                                  │
                        │           │ final                            │
                        │           ▼                                  │
                        │         DONE                                 │
                        └──────────────────────────────────────────────┘
```

---

## 3. 数据模型

### 3.1 SessionContext（`src/core/session/context.ts` — 新建）

```typescript
export class SessionContext {
  readonly threadId: string;
  readonly workspace: string;

  /** 主 agent loop 中止控制器。每次 runAgent 调用前由 SessionRuntime 重建 */
  abortController: AbortController;

  /** 后台子 agent 任务池。跨 run 存活，SessionContext 创建时构造 */
  readonly backgroundTasks: BackgroundTaskManager;

  /** 跨 run 共享的 shell 对话历史 */
  conversationHistory: string[] = [];

  constructor(threadId: string, workspace: string) {
    this.threadId = threadId;
    this.workspace = workspace;
    this.abortController = new AbortController();
    this.backgroundTasks = new BackgroundTaskManager();
  }

  /** 中止主 agent loop + 所有后台子 agent */
  abort(): void {
    this.backgroundTasks.abortAll();
    this.abortController.abort();
  }
}
```

### 3.2 BackgroundTaskManager（`src/core/subagent/background.ts` — 新建）

```typescript
export interface BackgroundTaskHandle {
  id: string;
  role: SubAgentRole;
  task: string;
  startedAt: number;
  signal: AbortController;
}

export interface BackgroundTaskCompleted {
  id: string;
  role: SubAgentRole;
  task: string;
  result: SubAgentResult;
  completedAt: number;
}

export class BackgroundTaskManager {
  private pending = new Map<string, BackgroundTaskHandle>();
  private completed: BackgroundTaskCompleted[] = [];
  private delivered = new Set<string>();

  /** 启动后台子 agent，返回 handle id，不等待结果 */
  launch(input: SubAgentRunnerInput): { id: string; handle: BackgroundTaskHandle } { ... }

  /** idempotent 查看已完成但未注入的结果 */
  peekUndelivered(): BackgroundTaskCompleted[] { ... }

  /** 标记已注入。commit() 后真正移除 */
  markDelivered(ids: string[]): void { ... }

  /** 清理已 delivered 的结果 */
  commit(): void { ... }

  /** 取消全部（SessionContext.abort 调用） */
  abortAll(): void { ... }

  /** 取消单个 */
  cancel(id: string): boolean { ... }

  get pendingCount(): number { ... }
}
```

### 3.3 task 工具 schema

```typescript
schema: z.object({
  subagent_type: z.enum(["explore", "code", "review"]),
  task: z.string().min(1),
  background: z.boolean().optional().default(false)
    .describe("If true, run in background and return immediately. "
      + "Results arrive as follow-up messages when the sub-agent completes. "
      + "explore/review are always safe for background (read-only). "
      + "code IS allowed but be aware: if the user sends new messages "
      + "while the sub-agent runs, file conflicts are possible."),
})
```

### 3.4 消息格式

**同步（不变）**：
```json
{"ok": true, "summary": "...", "toolCallCount": 5, "durationMs": 2300, "steps": [...]}
```

**后台 placeholder**：
```json
{"ok": true, "backgroundTaskId": "sub-lx8k2-1", "status": "started",
 "message": "Started background explore agent: ..."}
```

**后台结果注入（AIMessage）**：
```
[Background task sub-lx8k2-1 (explore) completed in 2.3s, 5 tool calls]
Summary: 找到 8 处 UserService 引用...
```

---

## 4. 变更清单

| 文件 | 变更 |
|------|------|
| `src/core/session/context.ts` | **新建** — `SessionContext`：per-session 基础设施容器 |
| `src/core/subagent/background.ts` | **新建** — `BackgroundTaskManager` |
| `src/core/subagent/types.ts` | 新增 `BackgroundTaskHandle`、`BackgroundTaskCompleted` |
| `src/core/subagent/task-tool.ts` | schema 加 `background`；`createTaskTool` 接受 `BackgroundTaskManager` |
| `src/core/harness/graph.ts` | `buildCodeAgentGraph` 接受 `BackgroundTaskManager`；agent 节点注入；tools 节点传递 |
| `src/core/runner.ts` | `RunAgentInput` 加 `backgroundTasks?: BackgroundTaskManager` |
| `src/app/tui/session-manager.ts` | `SessionRuntime` 持有 `SessionContext`；abort → `ctx.abort()`；runTask 传入 signal + BTM |
| `src/app/tui/types.ts` | `OutputBlock.subagent` 加 `background?: boolean` |
| `src/app/tui/reducers/handleEvent.ts` | 后台 subagent block 样式 |
| `src/app/tui/components/SubAgentBlock.tsx` | "Background" 标签 |
| `src/core/prompts/system-prompt.txt` | 后台使用指导 |

---

## 5. 跨 Run 并发模型

### 5.1 场景

```
Run 1: 模型派发 3 个后台 explore agent → 模型回复 "正在搜索..." → stream 结束
       [后台 agent A、B 仍在运行]

       → 用户发送新消息："登录接口的认证逻辑在哪？"

Run 2: 启动。此时：
       - agent A、C 已完成（completed 队列中）
       - agent B 仍在运行
```

### 5.2 设计决策：继承，不取消

**新用户消息不取消旧 run 的后台 agent**。理由：

- 后台 agent 是用户要求的工作的一部分，取消等于扔掉已完成的计算
- 只有显式中止（Esc/Ctrl+C）才取消全部

### 5.3 Run 2 启动处理

```
1. peekUndelivered() → [A, C]（idempotent）
2. 注入 AIMessage：
   [Background task A (explore) completed — 8 处引用...]
   [Background task C (review) completed — 2 个问题...]
3. 调模型
4. 模型看到 user message + 2 条完成通知
   → B 的 placeholder ToolMessage 无对应完成消息 → 推断 B 仍在运行
5. 模型成功 → markDelivered([A, C])
6. stream 结束 → commit()
```

### 5.4 注入时机（核心矛盾）

LangGraph stream 单向：模型生成 → 事件流出。不存在"打断正在进行的模型调用"的机制。

```
情况 A: tools 执行期间完成                           ✅ 同一轮融合
  agent → tools(派发后台) → [完成] → agent(peek → 注入 → 调模型)

情况 B: 模型流式生成期间完成                         ⚠️ 下轮注入
  agent(流式...) → [完成] → ... → final
  模型自己选了 background=true — 它认为不需要等

情况 C: stream 结束后完成                            ✅ 下轮注入
  stream 结束 → [完成] → 新消息 → 新 stream 首帧注入
```

### 5.5 agent 节点实现

不提前 return。注入后正常调模型：

```typescript
const agent = async (state: CodeAgentState) => {
  let effectiveMessages = sanitizeToolCallPairs(state.messages);
  let bgDelivered: string[] = [];

  if (input.backgroundTasks) {
    const undelivered = input.backgroundTasks.peekUndelivered();
    if (undelivered.length > 0) {
      effectiveMessages = [...effectiveMessages, ...undelivered.map(c =>
        new AIMessage(
          `[Background task ${c.id} (${c.role}) completed in ${formatMs(c.result.durationMs)}, ` +
          `${c.result.toolCallCount} tool calls]\nSummary: ${c.result.summary}`
        )
      )];
      bgDelivered = undelivered.map(c => c.id);
    }
  }

  const effectiveState = effectiveMessages !== state.messages
    ? { ...state, messages: effectiveMessages }
    : state;

  const { state: result } = await invokeModel({ model, state: effectiveState, tools, ... });

  if (bgDelivered.length > 0) {
    input.backgroundTasks.markDelivered(bgDelivered);
  }

  return { ...result, ... };
};
```

### 5.6 peekUndelivered / markDelivered / commit 三步协议

```
1. peekUndelivered()  — 只读，不消费
2. 调模型
3. 成功 → markDelivered(ids)
   失败 → 不调用 → 下次 peek 返回同一结果
4. stream 成功 → commit()（真正移除 delivered 结果）
```

### 5.7 文件写入冲突

| 层 | 机制 |
|----|------|
| Role 约束 | System prompt 引导优先用 explore/review 做后台 |
| 模型自治 | 对话历史中的 placeholder 推断运行中 code agent，自决等待或取消 |
| 文件层 | edit_file 精确字符串匹配；并发写入概率低，后果可控 |
| Esc 中止 | 用户 Esc → `ctx.abort()` → 全部停止 |

不做文件锁、事务、乐观锁。

### 5.8 审批

子 agent 在 `runSubAgent()` 内直接执行工具，不走主 graph 的 `interrupt()`。auth 边界在 dispatch 时冻结。后台 agent 不引入新审批问题。

### 5.9 模型感知运行状态

- 已完成：`[Background task X completed]` → 可用
- 运行中：placeholder ToolMessage 无对应完成消息 → 模型推断
- 不显式注入 "still running"（重复噪音）

### 5.10 生命周期

| 事件 | 行为 |
|------|------|
| 主 agent 正常结束 stream | `commit()`；pending 后台继续跑 |
| 用户新消息（新 run） | peekUndelivered → 注入；后台继续 |
| 用户 Esc/Ctrl+C | `SessionRuntime.abort()` → `ctx.abort()` → `backgroundTasks.abortAll()` + `abortController.abort()` |
| 子 agent 超时 | 30min → error → completed 队列 |
| 会话删除 | `SessionManager.removeRuntime()` → SessionRuntime GC → SessionContext GC → BTM GC |
| 进程退出 | `SessionManager.abortAll()` → 每个 `SessionRuntime.abort()` |

### 5.11 中止路径

```
SessionRuntime.abort()
  │
  ├─ ctx.abort()
  │    ├─ backgroundTasks.abortAll()
  │    │    └─ 逐个 handle.signal.abort()
  │    │         └─ runSubAgent() 检测 abort → AbortError
  │    └─ abortController.abort()
  │         └─ runAgent() 检测 abort → break
  │
  ├─ resolveInterrupt({ type: "cancel" })
  └─ agentLoopActive = false
```

---

## 6. 边界问题全量分析

### 6.1 routeAfterAgent → END ✅

不提前 return。注入后正常调模型。

### 6.2 模型失败 → 结果丢失 ✅

三步协议：peek（不消费）→ markDelivered（成功标记）→ commit（真正移除）。

### 6.3 "still running" 重复注入 ✅

不注入。模型从对话历史自行推断。

### 6.4 资源泄漏 ✅

`SessionContext.abort()` 直调 `mgr.abortAll()`。不依赖 signal 传播链。

### 6.5 SessionRuntime.abort 传播 ✅

`ctx.abort()` 两步合一：abortAll + abortController。

### 6.6 会话切换 TUI 事件路由 ✅

现有 `_proxyProvider` + 缓冲-回放机制覆盖。

### 6.7 后台完成时 TUI 不在对应会话 ✅

缓冲-回放覆盖。

### 6.8 审批 ✅

子 agent 不走主 graph interrupt。auth 在 dispatch 时确定。

### 6.9 Promise.all 另一工具失败 ✅

后台 task 继续。BTM 独立于 graph state 回滚。

### 6.10 Checkpoint 僵尸 placeholder ✅

接受。模型自行推断结果丢失，自主决定重新派发。

### 6.11 同 stream 重复注入 ✅

delivered set 防止。

### 6.12 并发上限

后台 agent 独立上限 20（BTM 内部常量）。不计入同步 task 的 MAX_CONCURRENT = 10。

---

## 7. 实现顺序

| Phase | 内容 | 验证 |
|-------|------|------|
| **1** | `BackgroundTaskManager` + types | 单元测试 |
| **2** | `SessionContext`（持有 BTM + AbortController） | 单元测试 |
| **3** | `task-tool.ts` schema + background 分支 | 单元测试 |
| **4** | `graph.ts` agent 节点注入 | 集成测试 |
| **5** | `runner.ts`：`RunAgentInput` 加 `backgroundTasks` | 集成测试 |
| **6** | `session-manager.ts`：`SessionRuntime` 持有 `SessionContext`；重构 abort/runTask | 单元测试 |
| **7** | TUI 渲染：background 标记 | 手动验证 |
| **8** | System prompt | 真实模型验证 |

---

## 8. 放弃的路径

- **后台结果持久化**：不引入僵尸任务恢复
- **后台 code 自动降级同步**：模型自主决策
- **独立后台面板**：第一版复用内联 SubAgentBlock

---

## 9. 关联文档

- [`2026-05-30-multi-agent-design.md`](2026-05-30-multi-agent-design.md) — 多 Agent 架构设计
- [`PRODUCT.md`](../../PRODUCT.md) — 产品定义
- [`ROADMAP.md`](../../ROADMAP.md) — 路线图
