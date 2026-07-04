# 审批层、执行层与沙箱渐进式开发方案

状态：partially-implemented（阶段四、五已实现，阶段一~三待实现）
创建：2026-06-30
优先级：P0
实施记录：
  - `docs/space/execution/completed/2026-07-02-interaction-mode-slash-command.md`（阶段四）
  - `docs/space/execution/completed/2026-07-02-execution-reliability.md`（阶段五）

> 阶段四（交互模式切换）和阶段五（执行可靠性）已于 2026-07-02 完成。
> 阶段一~三待实施。
依赖：无

## 目标

让 kite-code 支持长时间、无人值守的开发任务，同时保持较低的用户心智负担。本次改造围绕三个核心领域，**基于现有实现做增量演进，而非从零替换**：

1. **审批层** — 将审批决策从现有的 `approvalHash` 校验升级为结构化 Execution Permit
2. **执行层** — 将 `runApprovedTool()` 重构为 Tool Registry 模式，子 Agent 纳入统一入口
3. **沙箱层** — 补全现有 `src/core/sandbox/` 的缺口（文件工具接入、网络策略、Windows 评估）

最终系统应满足：

- 用户只需要定义任务目标和权限边界
- Agent 在授权范围内自主规划和执行
- 自动审批模式下不需要用户持续确认
- 主 Agent、子 Agent、Skill、MCP 不得绕过统一执行链路
- 审批结果必须由执行层强制验证
- 自动审批上线前必须具备明确的执行边界
- 任务不因运行时间、模型调用次数、Token 消耗或修改文件数量而被终止
- 同一问题连续失败后停止当前失败路径（上限按工具类型差异化）
- Agent 能够重新规划、跳过非关键步骤或安全收尾
- 任务执行过程可观察、可取消、可审计
- 高自由度模式仍然允许用户主动选择

## 范围

### 本次改造范围

| 领域 | 内容 |
|------|------|
| 审批层 | 扩展现有 `ToolApprovalPayload` → Execution Permit 生命周期、消费标记、自动审核 |
| 执行层 | `runApprovedTool()` 重构为 Tool Registry + `ToolExecutionRequest` 标准化输入、子 Agent 接入 |
| 沙箱层 | 文件工具接入现有沙箱、网络策略、Permit Constraints、Windows 平台评估（不做） |
| 可靠性 | Execution Journal（轻量）、连续失败检测（按错误类型差异化上限）、mutation 串行化 |

### 明确不做

- 长期记忆
- Agent 规划算法重构
- 模型上下文压缩（已有独立方案）
- Token 或费用预算
- 最大修改文件数量 / 最长任务运行时间
- 云端任务调度 / 多机器执行 / 分布式 Worker
- 完整 Git 快照和回滚系统
- 生产部署编排
- MCP 协议本身的重构
- UI 整体重做

---

## 现有实现盘点

在开始改造前，必须明确当前代码库中**已有**的能力，避免重复建设或错误替换。

### 已有能力（不可退化）

| 能力 | 位置 | 说明 |
|------|------|------|
| 统一工具执行入口 | `src/core/harness/tool-runner.ts` — `runApprovedTool()` | 所有已审批工具的 430 行集中式执行函数，含防御性 policy 二次检查 + approval 验证 |
| 工具安全策略 | `src/core/harness/tool-policy.ts` — `evaluateToolPolicy()` | 返回 `allowed` / `requiresApproval` / `risk`(8 类) / `reason`；Shell 命令有 6 层分类 |
| 审批 Hash 绑定 | `tool-policy.ts` — `hashToolApprovalRequest()` + `validateApprovalHash()` | SHA-256 绑定 tool+args+workspace+threadId，resume 时校验 |
| 三种授权模式 | `tool-policy.ts` — `default` / `full_access` + `same_command` grant | `approvedBatch` map 管理批量审批状态 |
| 审批节点 | `src/core/harness/graph.ts` — `approval` 节点 | LangGraph `interrupt()` 挂起 + `approvedBatch` 积累 + full_access 自动批准 |
| 防御性双重检查 | `tool-runner.ts` 第 91-111 行 | 执行前重新评估 policy + 检查 `approvedGrant !== 'none'` |
| 沙箱系统 | `src/core/sandbox/` — 8 个文件 | macOS Seatbelt + Linux bwrap 双后端、资源限制、环境硬化、危险路径检测 |
| 流式 Shell 输出 | `tool-runner.ts` — `onShellProgress` 回调 | 实时 stdout/stderr，已对接 TUI tail-follow |
| 孤儿 tool_call 清理 | `graph.ts` — `cleanup` 节点 | 取消恢复后注入 cancelled ToolMessage |
| 会话日志 | `src/core/session-logger/` | AgentEvent 全量 → JSONL |
| 撤销/恢复 | Rewind（Revert+Fork） | 通过 checkpoint 实现 |

### 真实缺口（方案需解决）

| 缺口 | 影响 |
|------|------|
| **子 Agent 绕过 `runApprovedTool()`** — `subagent/runner.ts` 通过 LangChain tool binding 直接执行 | 子 Agent 写文件/Shell 不经统一审批+执行路径 |
| **`runApprovedTool()` 是巨型 switch** — 430 行，工具直接 import，无注册机制 | 新增工具需修改多处，无法按来源区分执行 |
| **执行时无参数一致性校验** — `approvalHash` 只在 resume 时校验，未传到执行层 | 审批后参数被篡改无法检测 |
| **无 Permit 原子领取** — `approvedBatch` 是普通 JS object | 理论上的竞态窗口（当前单线程无实际影响） |
| **文件工具不经过沙箱** — `readFile`/`writeFile`/`editFile` 只做 `resolvePath` | 文件工具无 OS 级隔离 |
| **沙箱无网络策略** — `SandboxOptions` 无网络字段 | 无法限制沙箱内进程的网络访问 |
| **Windows 无沙箱后端** — Seatbelt/Bubblewrap 都是 Unix 特有 | Windows 只能 `local_unsafe` |
| **无自动审核** — 无模型驱动的自动审批 | 无人值守不可行 |
| **无跨 turn 失败追踪** — 失败只在单次 tool call 内处理 | 长时间任务无法检测卡死循环 |
| **MCP 工具元数据不足** — 仅 server 级 `risk: 'read'` 覆盖 | 无法按工具粒度审批 |
| **无统一脱敏层** | Token/密钥可能泄露到日志 |

---

## 核心架构约束

以下规则在整个改造期间不可破坏。标注 `[已实现]` 的条目当前代码已满足，改造中不可退化。

### 已迁移来源只能通过统一执行入口

一旦某个调用来源完成迁移，就不允许保留新旧两条活跃执行路径。不得在同一来源中同时存在"部分工具走 Execution Gateway、部分工具直接 tool.invoke"。

### [已实现] Executor 不信任模型声明的授权

`runApprovedTool()` 第 91-111 行已实现：不看模型输出的 `approved: true`，只看 `evaluateToolPolicy()` 返回值 + `approvedGrant`。改造期间此行为不可退化。

### 审批参数与执行参数必须一致（部分实现）

现有 `hashToolApprovalRequest()` 已对审批参数做 Hash，但未传递到 `runApprovedTool()` 做执行时比对。需补全：规范化 → 冻结 → Hash → 审批时记录 → 执行时校验。

### Permit 必须原子领取（当前单线程模型下无竞态）

未来若引入多线程/多进程执行，基于 SQLite 事务实现原子 `issued → claimed`。当前阶段：在 `approvedBatch` 中增加消费标记即可。

### [已实现] 被拒绝的请求不能到达工具实现

`evaluateToolPolicy()` 返回 `allowed: false` 时，`runApprovedTool()` 第 92-98 行直接返回错误，不调用底层工具。

### 不能签发无法强制执行的约束

如果执行层和沙箱还不能限制某类操作（如域名级网络白名单），审批层就不能签发相应约束。审批系统只能签发执行层能够真正落实的约束。

### 自动审批异常时不得默认放行

自动审核超时、模型不可用、Rate Limit、输出为空、Schema 非法、置信度不足时，默认拒绝或回退到用户审批，不得默认批准。

### 临时授权不能跨生命周期意外继承

Fork 不继承 Permit、Rewind 不恢复已消费 Permit、Run 结束后未使用 Permit 作废、应用重启后 `claimed` Permit 不自动重新执行。

---

## 统一术语（与现有代码对齐）

### Execution Gateway

系统内唯一的工具执行入口 — **即当前 `runApprovedTool()` 的重构版本**。重构后：
- 从 switch 语句变为 Tool Registry 模式（注册 → 查找 → 执行）
- 统一接收 `ToolExecutionRequest`（标准化输入结构）
- 所有调用来源（主 Agent、子 Agent、Skill、MCP）均通过此入口

### Execution Environment

```typescript
type ExecutionEnvironment =
  | "local_unsafe"      // 保持当前高自由度行为，仍经过审批 + Permit + Gateway
  | "workspace_sandbox"; // 文件 + Shell 均受沙箱隔离（基于现有 src/core/sandbox/）
```

> **与方案原版的差异**：去掉 `workspace_guard` 独立概念。文件工具接入沙箱后，`workspace_sandbox` 环境同时覆盖文件工具和 Shell。不需要一个"只能限制文件但不能限制 Shell"的中间状态，这会误导用户。

### Interaction Mode

```typescript
type InteractionMode =
  | "interactive"  // 无法自动批准时询问用户（当前行为）
  | "auto_review"  // 优先使用自动审核，不确定时询问用户
  | "unattended";  // 整个任务不等待用户
```

### Tool Risk（延用现有）

```typescript
// 已存在于 src/core/harness/tool-policy.ts，不引入新的 ToolSideEffect 枚举
type ToolRisk =
  | "read" | "plan" | "write_file" | "execute_code"
  | "destructive" | "network" | "vcs_mutation" | "mcp" | "unknown";
```

---

## 最终目标链路

```
Agent Tool Call
      ↓
Tool Request Normalizer（参数规范化 + 冻结 + Hash）
      ↓
Approval Engine（扩展现有 evaluateToolPolicy + approval 节点）
      ↓
Execution Permit（扩展现有 approvalHash → 签发 → 原子领取 → 消费）
      ↓
Execution Gateway（runApprovedTool 重构为 Tool Registry 模式）
      ↓
Execution Environment（local_unsafe / workspace_sandbox）
      ↓
Tool Implementation
      ↓
Tool Result / Execution Events
```

---

## 渐进式开发顺序（5 阶段，压缩自原 8 阶段）

```
阶段一：Execution Gateway 重构 + 子 Agent 接入
        ↓
阶段二：Execution Permit（扩展现有 approvalHash）
        ↓
阶段三：执行边界补全（补全现有沙箱缺口，非新建）
        ↓
阶段四：无人值守自动审核
        ↓
阶段五：执行可靠性与连续失败处理
```

> **变更说明**：
> - 原阶段一+二合并（Gateway + 子 Agent 本就该一起做，否则 Gateway 设计不考虑子 Agent 会导致返工）
> - 原阶段四+五合并（沙箱已有 80% 能力，不是新建而是补全）
> - 原阶段八（MCP 迁移）合并到各阶段渐进完成，不单独成阶段
> - 顺序不变的核心约束：**Permit → 执行边界 → 自动审核**，自动审批不早于可用边界

---

## 阶段一：Execution Gateway 重构 + 子 Agent 接入

### 现有基础

- `runApprovedTool()` 已是集中式执行函数，含 policy 二次检查 + approval 验证
- `evaluateToolPolicy()` 已有完整的 `ToolRisk` 分类和审批决策
- `graph.ts` 的 tools 节点已通过 `executeOneTool` → `runApprovedTool` 执行
- `approvedBatch` map 管理批量审批状态

### 实际缺口

- `runApprovedTool()` 是 430 行 switch 语句，工具直接 import，无注册机制
- 没有 `ToolDescriptor` 抽象 — 工具元数据（risk、supportsStreaming、supportsCancellation）分散
- 没有 `ToolExecutionRequest` 标准化输入 — 参数散落在函数参数中
- **子 Agent 的 tool call 通过 LangChain tool binding 直接执行，不经过 `runApprovedTool()`**
- 参数未做 Schema 校验 + 默认值补全 + 冻结

### 分支名称

```text
refactor/unified-tool-executor
```

### 调用链变化

```
现有：Graph → tools 节点 → executeOneTool → runApprovedTool (switch) → 工具实现
                                          → task tool → subagent (独立执行，不经 runApprovedTool)

改造：Graph → tools 节点 → Execution Gateway (Tool Registry)
                ↓
         ToolDescriptor lookup → normalizeToolArgs → 执行
                ↓
         子 Agent 的 tool call → 同一 Gateway（不再通过 LangChain tool binding 直接执行）
```

### Tool Execution Request

```typescript
// 标准化输入结构，替代当前散落的函数参数
// 阶段一只需 source = "main_agent" | "code_subagent"
interface ToolExecutionRequest {
  toolCallId: string;
  toolName: string;
  rawArgs: Record<string, unknown>;
  normalizedArgs: Readonly<Record<string, unknown>>;
  argsHash: string;
  source: "main_agent" | "code_subagent";
  signal: AbortSignal;
}
```

> **与方案原版的差异**：去掉 `executionId`（当前单线程模型无用）、`runId`/`threadId`（由 `ToolExecutionContext` 携带）、`ToolExecutionSource` 的 7 种枚举（阶段一只用 2 种，后续渐进扩展）。

> **`ToolExecutionResult` 扩展**：在现有 `ToolExecutionResult`（`tool-result.ts`）中增加可选 `status` 字段（`'success' | 'error' | 'rejected' | 'exhausted'`）。Gateway 根据执行结果设置——审批拒绝 → `'rejected'`，耗尽 → `'exhausted'`。tools 节点和子 Agent 循环将此值直接传给 `ToolMessage.status`，不做硬编码。

### Tool Registry

```typescript
// 扩展现有 ToolRisk，不引入新的 ToolSideEffect 枚举
interface ToolDescriptor {
  name: string;
  risk: ToolRisk;                    // 延用 tool-policy.ts 的 ToolRisk
  schema: z.ZodTypeAny;               // 工具的 Zod schema（z.object({...}) 的返回值），用于参数规范化中的 Schema 校验
  supportsStreaming: boolean;
  supportsCancellation: boolean;
  execute: (ctx: ToolExecutionContext, request: ToolExecutionRequest) => Promise<ToolExecutionResult>;
}

// Gateway 持有的共享依赖，根据工具类型注入所需字段
// 不是所有工具都需要全部字段——Gateway 负责按需传递
interface ToolExecutionContext {
  workspace: string;
  threadId: string;
  shellExecutor?: ShellExecutor;
  mcpManager?: McpManager;
  skillManifests?: SkillManifest[];
  skillOptions?: SkillScanOptions;
  onShellProgress?: (chunk: string, stream: 'stdout' | 'stderr') => void;
  toolResultSink?: (callId: string, toolName: string, ok: boolean, summary: string, totalLines?: number) => void;
  bypassApproval?: boolean;          // 子 Agent 调用时为 true——审批在上层已完成
}
```

> **关键设计**：
> - `ToolDescriptor.risk` 由系统定义（硬编码），不由模型声明。
> - `supportsStreaming`：Gateway 据此决定是否启用 `onShellProgress` 回调传递给工具（当前仅 `shell_execute` 为 true）
> - `supportsCancellation`：Gateway 据此决定是否将 `AbortSignal` 传递给工具（文件工具为 true，`task` 子 Agent 为 true，其余为 false）
> - `ToolExecutionContext` 携带共享依赖——Gateway 持有这些依赖，调用时按工具类型注入。不需要每个工具都接收全部字段。

### 参数规范化

在现有 `stableStringify()`（`tool-policy.ts` 第 625-636 行）基础上扩展：

```typescript
function normalizeToolArgs(descriptor: ToolDescriptor, rawArgs: Record<string, unknown>): {
  normalized: Readonly<Record<string, unknown>>;
  hash: string;
} {
  // 1. Schema 校验（使用 descriptor.schema — Zod parse）
  // 2. 默认值补全（Zod 的 .default() 值）
  // 3. 移除 undefined 字段
  // 4. 有序 JSON 序列化（延用 stableStringify）
  // 5. SHA-256 Hash
  // 6. Object.freeze 冻结
}
```

> **注意**：`normalizeToolArgs` 返回的 hash 是纯参数 Hash（用于 `ToolExecutionRequest.argsHash`）。Permit 的 `argsHash` 使用的是 `hashToolApprovalRequest()`，它额外绑定了 workspace + threadId。两者用途不同——前者用于参数快照，后者用于审批绑定。

### 子 Agent 接入方案

**当前问题**：`subagent/runner.ts` 创建自己的 tools → LangChain bindTools → 模型直接调用 tool。子 Agent 的 tool call 走的是 LangChain 内置的 tool invocation，完全绕过 `runApprovedTool()` + `evaluateToolPolicy()`。

**决策**：子 Agent 保留现有轻量循环（不引入 `buildCodeAgentGraph`），但工具执行步骤改为显式处理 tool_calls 并调用 Execution Gateway。

**选择理由**：
- 子 Agent 不应有独立的审批流 — 审批在上层（主 Agent 的 `approval` 节点）已完成
- 如果子 Agent 使用 `buildCodeAgentGraph`，会引入嵌套的 `interrupt()`，在 unattended 模式下形成嵌套自动审核
- 保留轻量循环维持子 Agent 的简洁性，只替换工具执行环节

**具体机制**（放弃 LangChain 内置 tool executor，改为显式循环）：

```
现有子 Agent 循环（使用 LangChain 自动执行工具）：
  while (未完成) {
    response = await bindTools(model, tools).invoke(messages)
    // LangChain 内部自动执行 tool_calls — 无法拦截
    messages.push(response)  // response 已包含 ToolMessage
  }

改造后（显式处理 tool_calls，调用 Gateway）：
  while (未完成) {
    response = await bindTools(model, tools).invoke(messages)
    messages.push(response)
    if (response.tool_calls.length > 0) {
      for (const tc of response.tool_calls) {
        const request = buildToolExecutionRequest(tc)
        const result = await gateway.execute(ctx, request)  // ← 走统一入口
        messages.push(new ToolMessage({
          content: JSON.stringify(result),
          tool_call_id: tc.id,
          name: tc.name,
          status: result.ok === false ? (result.status ?? 'error') : 'success',
          // 保留 Gateway 返回的 status（如 'rejected' / 'exhausted'），不硬编码 'error'
        }))
      }
    } else {
      break  // 无 tool_calls → 子 Agent 完成
    }
  }
```

> **关键变更**：子 Agent 不再依赖 LangChain 的 `bindTools` 自动执行工具。改为显式检查 `response.tool_calls`，逐个调用 Gateway，手动构建 ToolMessage。Gateway 内部的 `evaluateToolPolicy` + Permit 校验对子 Agent 透明生效。

> **bypassApproval 机制**：子 Agent 调用 Gateway 时 `ctx.bypassApproval = true`——审批在上层（主 Agent 的 approval 节点）已完成，子 Agent 不重复审批。Gateway 检测到此标志后跳过 `evaluateToolPolicy` 调用，但仍执行 Permit 校验和 `consumed` 标记。`toolResultSink` 确保子 Agent 的工具执行进度在主 TUI 中可见。

### 特殊工具依赖注入

部分工具有超出 `ToolExecutionContext` 的特殊依赖，通过闭包在注册时捕获：

| 工具 | 额外依赖 | 注入方式 |
|------|---------|---------|
| `task` | `config`、`model`、`subagentEventSink` | 注册时闭包捕获，`execute` 内使用 |
| `Skill` | `skillManifests`、`skillOptions` | 已由 `ToolExecutionContext` 携带 |
| `mcp__*` | `mcpManager` | 已由 `ToolExecutionContext` 携带 |
| `shell_execute` | `shellExecutor`、`onShellProgress` | 已由 `ToolExecutionContext` 携带 |

`task` 工具的注册示例：

```typescript
// 在 buildCodeAgentGraph 中，创建 task 工具的 descriptor 时闭包捕获依赖
registry.register({
  name: 'task',
  risk: 'plan',
  supportsStreaming: false,
  supportsCancellation: true,
  execute: async (ctx, request) => {
    // config / model / subagentEventSink 在闭包中，无需通过 ToolExecutionContext 传递
    const taskTool = createTaskTool({ config, model, workspace: ctx.workspace, ... });
    const output = await taskTool.invoke(request.normalizedArgs);
    return { ok: true, command: 'task', exitCode: 0, stdout: output, stderr: '' };
  },
});
```

### 完成标准

- `runApprovedTool()` switch 替换为 Tool Registry（注册 → 查找 → 执行）
- 所有主 Agent 工具通过 Registry 执行
- 子 Agent 的 tool call 进入同一 Execution Gateway
- Tool Request 参数已规范化并冻结
- 原有审批行为不变（仍走 `evaluateToolPolicy` + approval 节点）
- Shell 流式输出保留
- AbortSignal 正常传递
- 原有测试继续通过

### 本阶段不做

Permit 生命周期、自动审批、沙箱改动、Execution Journal、MCP 迁移。

---

## 阶段二：Execution Permit（扩展现有 approvalHash）

### 现有基础

- `hashToolApprovalRequest()` + `stableStringify()` 已生成审批 Hash（SHA-256，绑定 tool+args+workspace+threadId）
- `validateApprovalHash()` 在 approval 节点校验 resume 时的参数一致性
- `approvedBatch` map（`Record<string, ShellApprovalGrant>`）管理批量审批状态
- `buildToolApproval()` 生成 `ToolApprovalPayload`
- `applyApprovalGrant()` / `hasSameCommandGrant()` 管理授权状态

### 实际缺口

- `approvalHash` 只在 resume 时校验，**未传递到 `runApprovedTool()` 做执行时二次比对**
- 没有 "Permit 已消费" 标记 — `approvedBatch` 的值是 grant 类型（`approve_once`/`same_command`/`full_access`），不是消费状态
- 三种授权策略下，`full_access` 和 `same_command` 的每次执行都生成新的隐含"Permit"，但没有显式追踪
- Fork/Rewind 场景下 Permit 继承行为未定义

### 分支名称

```text
feat/execution-permit
```

### 阶段目标

在现有 `approvalHash` + `approvedBatch` 基础上增加：
1. 执行时参数一致性校验（Hash 比对）
2. Permit 消费标记（防止重复执行）
3. Permit 生命周期与 Run/Fork/Rewind 的关联

不引入新的审批策略，不加入自动审核。

### Execution Permit（扩展现有结构）

```typescript
// 在现有 approvedBatch 基础上扩展，不另建独立存储
// approvedBatch 从 Record<callId, ShellApprovalGrant>
// 变为 Record<callId, PermitEntry>

interface PermitEntry {
  grant: ShellApprovalGrant;   // 延用现有枚举
  argsHash: string;            // = hashToolApprovalRequest() 的输出，审批时计算
  consumed: boolean;           // 新增：执行后标记为 true
}
```

> **关键设计 — Hash 一致性**：`PermitEntry.argsHash` 由审批时调用 `hashToolApprovalRequest()` 生成（SHA-256，绑定 tool+args+workspace+threadId）。执行时 Gateway 用相同参数重新调用 `hashToolApprovalRequest()`，与 `permit.argsHash` 比对。**审批和执行的 Hash 算法必须是同一个函数**，否则校验永远失败。

> **与方案原版的差异**：
> - 去掉独立的 `ExecutionPermit` 接口（`permitId`/`issuedAt`/`claimedAt`/`revokedAt`）— 当前单线程模型下 `approvedBatch` 扩展即可
> - 去掉 `nonce` 字段 — checkpoint ID 已足够防止重放
> - 去掉 `revoked` 状态 — 无外部撤销触发源
> - 去掉 `claimed` 中间状态 — `issued → consumed` 在同一个同步执行流程中完成

### 执行时校验

在 Execution Gateway 中增加（使用与审批相同的 Hash 函数）：

```typescript
// 执行时重新计算 hashToolApprovalRequest，与 permit.argsHash 比对
// 必须使用与审批节点完全相同的参数（tool + normalizedArgs + workspace + threadId）
const recomputedHash = hashToolApprovalRequest({
  workspace: ctx.workspace,
  threadId: ctx.threadId,
  request: { name: request.toolName, args: request.normalizedArgs, ... },
});
const permit = approvedBatch[request.toolCallId];
if (!permit || permit.consumed) {
  return { ok: false, stderr: "No valid permit for this tool call" };
}
if (permit.argsHash !== recomputedHash) {
  return { ok: false, stderr: "Tool arguments changed after approval" };
}
permit.consumed = true;  // 标记已消费
// 继续执行...
```

### Permit 生命周期

延用现有规则（`approvedBatch` 已在 state 中随 checkpoint 持久化）：

- Run 结束后 `approvedBatch` 随 state 自然失效（新 run 从空 state 开始）
- Fork 不继承 — 新线程的 `approvedBatch` 初始为空
- Rewind 恢复 checkpoint 时恢复 `approvedBatch` 快照，但 `consumed: true` 的 Permit 不可复用。同时清理所有 `grant === 'full_access'` 的未消费条目（标记 `consumed: true`）——Rewind 意味着用户主动回到历史状态，不应继承旧的 `full_access` 授权
- 应用重启后 checkpoint 恢复，`consumed: true` 的 Permit 不可重新执行
- 工具参数变化 → `argsHash` 不匹配 → 必须重新审批

**`full_access` 下的 Permit 处理**：

`full_access` 不等同于"跳过 Permit"。每个通过 `full_access` 授权的工具仍然生成 `PermitEntry`：

```typescript
// approval 节点中 full_access 分支（改造后）
if (grant === 'full_access') {
  for (const r of allPending) {
    if (r.id) {
      batch[r.id] = {
        grant: 'full_access',
        argsHash: hashToolApprovalRequest({ workspace, threadId, request: r }),
        consumed: false,  // ← 关键：初始为 false，执行后标记为 true
      };
    }
  }
}
```

这样 Rewind 后 `consumed: true` 的 `full_access` Permit 不会被重新消费，满足"临时授权不能跨生命周期意外继承"的不变量。

### 代码结构变更：抽取 `issuePermit()` 扩展点

Phase 2 将 approval 节点中"审批决策 → 签发 Permit"的逻辑抽取为独立函数，为 Phase 4 自动审核预留插入点：

```typescript
// 从 approval 节点的 152 行匿名函数中抽取
function issuePermit(
  batch: Record<string, PermitEntry>,
  request: PendingToolRequest,
  decision: { grant: ShellApprovalGrant; argsHash: string },
): Record<string, PermitEntry> {
  return {
    ...batch,
    [request.id!]: {
      grant: decision.grant,
      argsHash: decision.argsHash,
      consumed: false,
    },
  };
}
```

Phase 4 在 `issuePermit()` 前后插入自动审核逻辑，不需修改 approval 节点的整体结构。

### 类型变更影响范围

`approvedBatch` 从 `Record<string, ShellApprovalGrant>` 变为 `Record<string, PermitEntry>` 影响以下位置：

| 文件 | 位置 | 变更 |
|------|------|------|
| `graph.ts` — approval 节点 | 行 175-198 | `batch[id] = grant` → `batch[id] = { grant, argsHash, consumed: false }` |
| `graph.ts` — approval 节点 | 行 213-216 | `batch[request.id] = 'approve_once'` → `batch[request.id] = { grant: 'approve_once', argsHash, consumed: false }` |
| `graph.ts` — tools 节点 | 行 593-595 | `batch[req.id]` 取值 → `batch[req.id]?.grant` |
| `routes.ts` — routeAfterApproval | 行 88-92 | `Object.values(batch).some(g => g === 'full_access')` → `Object.values(batch).some(p => !p.consumed && p.grant === 'full_access')` |
| `graph.ts` — full_access 分支 | 行 193-197, 312-317 | 同上，批量设置需改为 PermitEntry 结构；**必须同时检查 `!p.consumed`** |

所有引用 `approvedBatch` 值的代码需从读 grant 字符串改为读 `permit.grant`。

### 完成标准

- 执行时验证 `argsHash` 一致性
- 每个 Permit 只能执行一次（`consumed` 标记）
- Fork 不继承已消费 Permit
- Rewind 不恢复已消费 Permit
- 现有三种授权策略行为不变
- `approvedBatch` 类型变更的所有引用点已更新
- 原有测试继续通过

---

## 阶段三：执行边界补全（补全现有沙箱缺口）

### 现有基础

- **沙箱系统**：`src/core/sandbox/` — 8 个文件，macOS Seatbelt + Linux bwrap 双后端
- **资源限制**：`ResourceLimits`（cpuTime/fileSize/fileDescriptors/processes），ulimit 已应用
- **环境硬化**：`buildHardenedEnv()` + `buildEnvStripSnippet()`
- **危险路径检测**：`checkDangerousPaths()`
- **Shell 执行器可替换**：`createSandboxExecutor()` 返回 `ShellExecutor`
- **CLI 控制**：`--no-sandbox` 标志，沙箱默认启用
- **文件工具**：已有基本 `resolvePath` 路径解析

### 实际缺口

| 缺口 | 说明 |
|------|------|
| 文件工具不经过沙箱 | `readFile`/`writeFile`/`editFile` 只做 `resolvePath`（拼接 workspace + 相对路径 + `../` 检测），无 OS 级隔离、无符号链接检测 |
| 无网络策略 | `SandboxOptions` 无网络字段，沙箱内进程可自由访问网络 |
| Windows 无沙箱后端 | 当前只有 macOS/Linux 后端 |
| 沙箱不可用时静默回退 | 只 warn + 回退到 `shellTool`，不阻止 unattended 模式 |
| 无 Permit Constraints | Permit 无法携带路径/环境/网络约束 |

### 分支名称

```text
feat/execution-boundary
```

### 阶段目标

1. 文件工具接入现有沙箱的路径校验逻辑
2. 增加网络策略（disabled / allow_all）
3. Permit Constraints 基础结构
4. Windows 平台评估（本阶段只评估不做实现）

### 文件工具路径校验

在现有 `resolvePath` 基础上增加，不重写：

```typescript
function validateWorkspacePath(workspace: string, targetPath: string): string | Error {
  // 1. 拒绝绝对路径
  // 2. 拒绝 ~ 开头
  // 3. resolve 后检查是否在 workspace 内（处理 ../ 和符号链接）
  // 4. 对不存在的路径：逐级向上找最近存在的父目录 → realpath → 校验
  // 5. 构造完整目标路径 → 确认在 workspace 内
  // 延用现有 resolvePath 的路径拼接逻辑，增加符号链接检测
}
```

> **关键**：文件工具已有基本路径处理，本阶段是**增强**而非重写。

### 网络策略

```typescript
// 扩展 SandboxOptions
interface SandboxOptions {
  // ... 现有字段
  network?: {
    mode: "disabled" | "allow_all";
    // allow_hosts 延后：当前平台无法落实域名级限制时暂不提供
  };
}
```

网络禁用通过沙箱机制实现：
- macOS Seatbelt：profile 中增加 `(deny network*)` 规则
- Linux bwrap：`--unshare-net` 标志

同时收窄 macOS Seatbelt 的 `file-write*` 权限——当前全局 `(allow file-write* (subpath "/"))` 允许 Shell 命令通过 `curl -o`、`git clone`、`cp`、`mv` 写入文件系统任意位置。本阶段改为仅允许 workspace 子路径 + 临时目录：

```
(allow file-write* (subpath "${workspace}"))
(allow file-write* (subpath "/tmp"))
(allow file-write* (subpath "/private/tmp"))
```

> **注意**：`file-write*` 收窄后可能影响依赖全局写入路径的合法开发操作（如 `npm install -g`、`pip install` 到系统路径）。这些操作应通过 `local_unsafe` 环境执行。

### Permit Constraints

```typescript
// 只有执行层能实际强制执行的约束才能写入 Permit
// 不提供无法落实的字段——如果无法限制，就不写
interface PermitConstraints {
  network: "disabled" | "allow_all";  // 网络策略：disabled 通过沙箱机制落实
}
```

> **设计决策 — 不提供 `writablePaths` 和 `environment`**：
> - `writablePaths`：Phase 3 的文件工具路径校验已将写入范围限定为 workspace。workspace 内的子路径细分（如"只能写 src/ 不能写 tests/"）需要 per-path 权限表，当前尚无此基础设施。不提供虚假约束。
> - `environment`：沙箱的 `buildHardenedEnv()` 已固定环境策略。在 Permit 中再区分 "hardened" vs "inherited" 没有对应的执行机制——要么硬化（沙箱开启）要么继承（`local_unsafe`）。两个值映射到 `ExecutionEnvironment` 的选择，不需要在 Permit 中重复。

### Windows 平台评估

| 方案 | 可行性 | 复杂度 |
|------|--------|--------|
| Job Objects | 进程组管理，无文件系统隔离 | 低 |
| Hyper-V / WSL | 完整隔离，但需要额外依赖 | 高 |
| 仅支持 `local_unsafe` | 零工作量，但 unattended 风险高 | 零 |

本阶段输出：Windows 平台选型文档，不实现。

### `executionEnvironment` 初始化

`executionEnvironment` 由系统在 run 启动时根据沙箱可用性自动判定（非用户配置）：

```typescript
// 在 runner.ts 的 runAgent() 入口
const executionEnvironment: ExecutionEnvironment =
  detectSandboxBackend() !== 'none' && !config.disableSandbox
    ? 'workspace_sandbox'
    : 'local_unsafe';
```

此值写入 graph state，后续在 system prompt 注入（Phase 4）和 Permit Constraints 校验中使用。

### 完成标准

- 文件工具无法通过 `../` 逃逸
- 文件工具拒绝绝对路径
- 符号链接逃逸被检测并阻止
- 新文件路径校验正确（逐级父目录检查）
- 网络禁用实际生效（macOS Seatbelt + Linux bwrap）
- 沙箱不可用时阻止 unattended 模式启动（而非静默回退）
- Permit Constraints 可携带网络约束且被沙箱落实
- `local_unsafe` 保持兼容
- 沙箱现有测试继续通过
- Windows 沙箱选型文档交付（本阶段不要求实现）

---

## 阶段四：无人值守自动审核

### 现有基础

- 无。这是完全的绿地。

### 前置条件（硬依赖）

- 阶段一完成：主 Agent + 子 Agent 均通过 Execution Gateway
- 阶段二完成：Permit 强制执行
- 阶段三完成：执行边界可用（至少 `workspace_sandbox` 可正常工作）

### 分支名称

```text
feat/unattended-auto-review
```

### 阶段目标

在现有审批节点（`graph.ts` — `approval` 节点）内插入自动审核模型调用，对代码编写过程中的频繁工具审批进行自动化，为用户节约时间。自动审核只能提出建议，最终 Permit 由 Approval Engine 签发。

### 自动审核范围（硬边界）

自动审核**只作用于 `approval` 节点**。当前代码有三条独立的中断通道，自动审核不得跨越边界：

```
路由优先级（routes.ts — resolveToolRoute）:

  Priority 1: ask_user     → user_input 节点   【自动审核不处理】
      理由：人机交互，Agent 向用户提问澄清需求。自动审核不能替用户回答问题。

  Priority 2: update_plan  → plan_review 节点   【自动审核不处理】
      理由：方案审批是战略性决策——任务名称、步骤、状态变更——应由用户确认。
      自动审核不能替用户做"这个方案行不行"的判断。

  Priority 3: write_file    → approval 节点     ← 自动审核作用范围
              edit_file
              shell_execute
              mcp__*
      理由：代码编写过程中的频繁工具审批。这些是战术性决策——
      "这个文件该不该写"、"这个命令该不该跑"——可以用模型辅助判断。

  Priority 4: read_file     → tools 节点         【无需审批，直通】
              search_*
              纯进度 update_plan
```

> **原则**：自动审核处理的是"**战术性、重复性**"的工具执行审批——Agent 在编写代码时频繁调用的写文件、跑命令等操作。它不处理"**战略性**"决策——方案审批（`update_plan`）和用户交互（`ask_user`）始终需要用户参与。

### unattended 模式下的 `ask_user` 防护

`ask_user` 在 unattended 模式下会导致永久挂起——Agent 不知道自己在无人值守模式中，调用 `ask_user` → 路由到 `user_input` 节点 → `interrupt()` → 永远等待。需要双层防护：

**1. System Prompt 注入（预防）**：unattended 模式下，Agent 的 system prompt 追加：

> "你处于无人值守模式。不能调用 ask_user 工具。如有不确定的需求，做出最佳假设并继续，在最终输出中标注假设内容。"

实现方式：在 `prepareModelContext()` 中根据 `state.interactionMode` 动态注入。

**2. 路由层拦截（兜底）**：即使 Agent 仍然调用了 `ask_user`，系统不应挂起。在 `routes.ts` 的 `resolveToolRoute` 中增加判断：

```typescript
// Priority 1 修改：unattended 下 ask_user 不进入 user_input 节点
if (request.name === 'ask_user') {
  if (state.interactionMode === 'unattended') {
    // 不挂起，直接生成 ToolMessage 告知 Agent 不能提问
    continue; // 走 tools 节点 → Gateway 生成拒绝 ToolMessage
  }
  return 'user_input';
}
```

Gateway 中对 unattended 下的 `ask_user` 返回：
```json
{ "ok": false, "rejected": true, "replan": { "reasonCode": "UNATTENDED_NO_USER_INTERACTION", "reason": "无人值守模式下不能向用户提问。请做出最佳假设并继续。" } }
```

### 运行模式

| 模式 | 行为 |
|------|------|
| `interactive` | 无法自动批准时询问用户（当前行为，保持不变） |
| `auto_review` | 优先使用自动审核，不确定或不可用时询问用户 |
| `unattended` | 整个任务不等待用户，拒绝并重新规划或收尾 |

**初始化路径**：

```
CLI 参数（优先级最高）
  --interactive / --auto-review / --unattended
    ↓ 未指定则取
配置文件（~/.kite-code/kite-code.jsonc 或 .kite-code/kite-code.jsonc）
  interactionMode: "interactive" | "auto_review" | "unattended"
    ↓ 未指定则默认
"interactive"（当前行为，向后兼容）
```

Interaction Mode 通过 graph state 字段 `interactionMode` 传递到 approval 节点。**同时必须注入到 Agent 的 system prompt**，使 Agent 知道当前模式的约束：

```typescript
// prepareModelContext() 中根据 interactionMode 追加 system prompt 指令
if (state.interactionMode === 'unattended') {
  systemPrompt += '\n你处于无人值守模式。不能调用 ask_user 工具。如有不确定的需求，做出最佳假设并继续，在最终输出中标注假设内容。';
}
if (state.executionEnvironment === 'workspace_sandbox') {
  systemPrompt += '\n你的 Shell 和文件操作受到沙箱限制——无法访问 workspace 外的文件，网络可能受限。';
}
```

config schema 增加：

```typescript
// src/core/config/index.ts — configSchema 扩展
interactionMode: z.enum(['interactive', 'auto_review', 'unattended']).optional()
```

### 与 LangGraph interrupt 的集成

自动审核**仅在 `approval` 节点内**运行，在 `interrupt()` 之前。`plan_review` 和 `user_input` 节点不受影响——它们始终走用户交互路径：

```
resolveToolRoute() 分流:
  ask_user     ──→ user_input 节点  → interrupt() 等待用户  (不经过自动审核)
  update_plan  ──→ plan_review 节点 → interrupt() 等待用户  (不经过自动审核)
  写/Shell/MCP ──→ approval 节点:

approval 节点内部流程:
  1. 获取待审批工具
  2. evaluateToolPolicy() → 判断是否需要审批
  3. 如需审批 + 模式为 auto_review/unattended：
     a. 调用自动审核模型
     b. 若自动审核批准 → 签发 Permit → 跳过 interrupt()
     c. 若自动审核拒绝 → unattended 下生成 ReplanInstruction → 跳过 interrupt()
     d. 若自动审核不确定 → auto_review 下 fallback 到 interrupt()
  4. 如需审批 + 模式为 interactive：
     现有流程：interrupt() 等待用户
```

> **关键约束**：自动审核不能直接签发 Permit，只能返回建议。Permit 签发始终由系统（Approval Engine）完成。

### deny_and_replan 的 Agent 反馈机制

自动审核拒绝时，跳过了 `interrupt()`，但 Agent 仍需通过 ToolMessage 获知拒绝信息。关键区分：

| 反馈类型 | ToolMessage status | ToolMessage content | Agent 应如何响应 |
|---------|-------------------|---------------------|----------------|
| 工具执行失败 | `'error'` | `{ ok: false, ... }` | 修复错误后重试 |
| 审批拒绝（deny_and_replan） | `'rejected'` | `{ ok: false, rejected: true, replan: ReplanInstruction }` | 换方案，不要重试同一操作 |
| 审批拒绝（deny_and_abort） | `'rejected'` | `{ ok: false, rejected: true, replan: { reasonCode: "ABORT" } }` | 安全收尾 |
| 耗尽信号（连续失败达上限） | `'exhausted'` | `{ ok: false, failure: { ..., exhausted: true } }` | 停止当前路径 |

> **关键设计**：使用 `status: 'rejected'` 和 `status: 'exhausted'` 而非复用 `status: 'error'`。Agent 模型看到 `status: 'error'` 的默认行为是"错了就重试"——这与审批拒绝要求的"换方案"矛盾。独立的 status 值让 Agent 能区分"执行失败（可重试）"和"审批拒绝（不可重试）"。

```typescript
interface ReplanInstruction {
  reasonCode: string;                    // 拒绝原因码，见下表
  reason: string;                        // 人类可读的拒绝原因
  blockedCapability?: string;            // 被阻止的能力（如 "shell_execute"）
  suggestedAlternatives?: string[];      // 建议的替代方案（如 "使用 read_file 代替 cat"）
}
```

**`reasonCode` 枚举**：

| reasonCode | 含义 | Agent 应如何响应 |
|-----------|------|-----------------|
| `UNTRUSTED_COMMAND` | 自动审核判定命令不可信 | 换工具或换写法 |
| `PATH_OUTSIDE_WORKSPACE` | 目标路径在 workspace 外 | 换到 workspace 内的路径 |
| `REVIEWER_UNAVAILABLE` | 自动审核暂不可用（超时/模型不可用/Rate Limit） | 等待后重试同一操作，或改用只读工具继续其他任务 |
| `ABORT` | 任务不可继续，需安全收尾 | 停止当前任务，输出已完成的工作 |

> **关键区分**：`REVIEWER_UNAVAILABLE` 和 `UNTRUSTED_COMMAND` 对 Agent 的行为引导截然不同——前者告诉 Agent "操作本身没问题，审核器暂时不在"，Agent 不应修改操作参数重试；后者告诉 Agent "这个操作不被信任，换方案"。

在 approval 节点中，`deny_and_replan` 生成如下 ToolMessage：

```typescript
// 审批拒绝 → 生成带 replan 指令的 ToolMessage，使用 status: 'rejected' 而非 'error'
new ToolMessage({
  content: JSON.stringify({
    ok: false,
    rejected: true,
    replan: {
      reasonCode: "UNTRUSTED_COMMAND",
      reason: "自动审核判定此命令在当前上下文中不可信。",
      blockedCapability: "shell_execute",
      suggestedAlternatives: ["使用 search_content 查找相关信息", "使用 read_file 读取文件"]
    }
  }),
  tool_call_id: request.id,
  name: request.name,
  status: 'rejected',  // ← 非 'error'，Agent 据此区分"执行失败"与"审批拒绝"
})
```

Agent 看到 `rejected: true` + `replan` 字段，就知道不应重试同一操作，而应根据 `suggestedAlternatives` 调整方案。

`deny_and_abort` 同样生成 ToolMessage，但 `replan.reasonCode = "ABORT"` 且 `suggestedAlternatives` 为空，表示此操作无替代方案：

```typescript
// deny_and_abort → Agent 应安全收尾，不再继续尝试
{
  ok: false,
  rejected: true,
  replan: {
    reasonCode: "ABORT",
    reason: "自动审核判定此操作在当前执行环境下不可接受，无替代方案。",
    blockedCapability: "shell_execute"
    // suggestedAlternatives 为空 → 没有替代方案
  }
}
```

### 审批决策

```typescript
type ApprovalDecision =
  | "allow"
  | "allow_with_constraints"   // 仅在阶段三完成后可用
  | "require_user"              // unattended 下不得产生
  | "deny_and_replan"
  | "deny_and_abort";
```

### 自动审核模型

自动审核使用独立的轻量模型调用（非主 Agent 模型），避免与主 Agent 竞争 context window：

- **模型选择**：使用配置中指定的 cheap/fast 模型（如 `deepseek-v4-flash`），与主 Agent 模型（可能是 `deepseek-v4-pro`）分离
- **上下文隔离**：自动审核有独立的 system prompt + 工具信息，不共享主 Agent 的对话历史
- **超时**：自动审核调用设置 5 秒超时，超时视为"不可用"→ 按模式回退
- **缓存**：缓存 key = `toolName + argsHash`（规范化参数的 SHA-256，含参数内容不含 workspace/threadId）。同一个 run 内，相同 key 的审核结果直接复用，不调用模型。TTL = 当前 run 内有效（run 结束后缓存清空）。安全性：参数任何变化导致 argsHash 不同 → cache miss → 重新审核。参数完全相同 → cache hit → 无需重复审核

### 自动审核输入

> **注意**：以下输入项均为结构化数据，**不依赖另一个模型调用来生成摘要**。"最近执行结果摘要"由 Gateway 在执行每个工具后以固定格式写入 graph state，approval 节点直接读取。

- 用户原始目标（来自 graph state 的 `plan.description`）
- 当前任务步骤（来自 `plan.steps`）
- Tool Name + 规范化参数
- `ToolRisk`（来自 Tool Registry，非模型自己声明）
- 当前 `ExecutionEnvironment` + `InteractionMode`
- 最近执行结果摘要：由 Gateway 在每次工具执行后写入 state，固定格式为 `{ toolName, ok, errorCode, stderrHead: 前80字符 }` × 最近 3 条。不另调模型生成
- 最近审批拒绝记录：`{ toolName, reasonCode }` × 最近 3 条，同样由 approval 节点自动写入 state

### 自动审核输出

```typescript
interface AutoReviewResult {
  decision: "allow" | "allow_with_constraints" | "deny_and_replan" | "deny_and_abort";
  risk: "low" | "medium" | "high" | "critical";
  reasonCode: string;
  reason: string;
  suggestedConstraints?: PermitConstraints;
  suggestedAlternatives?: string[];
}
```

> **与方案原版的差异**：去掉 `confidence: number` — LLM 的数值置信度不可靠，以 `risk` 等级 + `reason` 文本替代。

### 回退规则

自动审核不可用时（超时/模型不可用/Rate Limit/Schema 非法）：

| 模式 | 回退 |
|------|------|
| Interactive | 用户审批（`interrupt()`） |
| Auto Review | 用户审批（`interrupt()`） |
| Unattended | Deny And Replan（reasonCode=`REVIEWER_UNAVAILABLE`，Agent 应等待后重试而非修改操作） |

**不得默认批准。**

### 完成标准

- Unattended 模式不等待用户
- 自动审核不能直接签发 Permit
- 自动审核不能执行工具
- 自动审核异常时不会默认放行
- `allow_with_constraints` 能被沙箱真正落实
- Deny And Replan 生成结构化 `ReplanInstruction`
- Interactive 模式与现有行为兼容
- `update_plan` 始终经 `plan_review` 节点由用户审批，自动审核不介入
- `ask_user` 始终经 `user_input` 节点等待用户回答，自动审核不介入

---

## 阶段五：执行可靠性与连续失败处理

### 现有基础

- `cleanup` 节点：已处理孤儿 tool_calls（取消恢复场景）
- `AbortSignal`：已透传到 shell 执行和子 agent
- `session-logger`：已记录 AgentEvent 全量
- `withFailureGuidance()`：已生成单次工具失败反馈
- `truncateToolOutput()`：已有输出截断

### 实际缺口

- 无跨 turn 失败追踪 — 无法检测"同一错误反复出现"
- 无执行状态追踪 — 不知道某个工具是 running/applied/failed
- 写操作无条件并行 — `Promise.all` 对所有工具一视同仁
- 大输出无明显控制 — 超过 4000 字符才截断，中间无流式释放

### 分支名称

```text
feat/execution-reliability
```

### 阶段目标

1. 轻量 Execution Journal（仅记录状态变迁，不做完整审计）
2. 按错误类型差异化的连续失败检测
3. mutation 操作串行化
4. 输出流式释放（大输出不在内存中累积）

### Execution Journal（轻量版）

```typescript
// 在 graph state 中追加，不另建独立存储
interface ExecutionJournalEntry {
  toolCallId: string;
  toolName: string;
  status: "running" | "applied" | "failed" | "cancelled";
  startedAt: number;
  finishedAt?: number;
  errorCode?: string;   // 标准化错误码，用于失败指纹
}
```

> **与方案原版的差异**：去掉 `prepared`/`result_recorded`/`unknown` 状态 — 除 `unknown` 外都是冗余细分。去掉独立 Journal 存储 — 直接嵌入 graph state，随 checkpoint 持久化。

> **Checkpoint 膨胀控制**：Journal 条目数硬上限 50 条。超过上限时删除最旧条目，仅保留计数 `_prunedCount`。每次 checkpoint 序列化包含最多 50 条 journal entry（每条约 200 字节），总增量 ≤10KB，不影响 checkpoint 读写性能。

### 连续失败检测（精简版）

失败指纹仅包含 3 个维度（原方案 7 个维度过度设计）：

```typescript
interface FailureFingerprint {
  toolName: string;
  errorCode: string;     // 标准化错误码（如 "ENOENT" / "EXIT_NONZERO" / "POLICY_DENIED"）
  affectedPath?: string;  // 涉及的文件路径（如有）
}
```

**差异化上限**（非一刀切的 10 次）：

| 错误类型 | 上限 | 理由 |
|---------|------|------|
| 文件不存在（ENOENT） | 3 | 路径错误重试一次就该换方案 |
| Shell 非零退出 | 5 | 可能修复了部分问题但未完全解决 |
| 语法/格式错误 | 3 | 模型生成的命令有语法问题，重试大概率重复 |
| 审批拒绝 | 5 | 独立计数，不混入执行失败 |
| 网络/超时 | 10 | 可能因外部波动，可重试更多 |

达到上限后的动作：
1. 将 Fingerprint 标记为 exhausted
2. 在**真实的失败 ToolMessage 中附加耗尽信号**（不创建新的独立消息）：

```typescript
// 扩展现有 withFailureGuidance() 的 failure 对象
// 不引入新的 _exhausted 顶层字段——Agent 的注意力路径是 failure → guidance
interface ExhaustionSignal {
  exhausted: true;                 // 布尔标记，在 failure 对象中
  fingerprint: string;
  consecutiveFailures: number;
  maxFailures: number;
  suggestion: "replan" | "skip_step" | "finalize";  // 建议（非指令），Agent 结合上下文判断
  reason: string;
  suggestedAlternatives?: string[];
}
```

> **为什么不放顶层 `_exhausted`**：Agent 解析失败时的注意力路径是 `ok → failure.reason → failure.guidance`。`_exhausted` 放在顶层且带下划线前缀（通常表示"内部字段"），模型大概率忽略。放入 `failure.exhausted` 确保模型在处理失败时自然发现。

> **为什么不额外插入 ToolMessage**：每个 ToolMessage 必须有对应的 `tool_call_id`。连续失败场景中工具真实执行并返回了结果——不存在额外的 tool_call 挂载新消息。

ToolMessage 内容示例（第 5 次失败，status=`'exhausted'`）：

```json
{
  "ok": false,
  "command": "shell_execute",
  "exitCode": 1,
  "stderr": "3 tests failed: ...",
  "failure": {
    "message": "Tool execution failed.",
    "tool": "shell_execute",
    "reason": "3 tests failed: ...",
    "guidance": "此测试已连续失败 5 次且错误无实质变化。请跳过当前步骤，继续其他独立任务。如没有其他步骤，安全收尾。",
    "exhausted": {
      "fingerprint": "shell_execute:EXIT_NONZERO:tests/foo.test.ts",
      "consecutiveFailures": 5,
      "maxFailures": 5,
      "suggestion": "skip_step",
      "reason": "连续 5 次相同错误的测试失败，文件无变化",
      "suggestedAlternatives": ["继续下一个独立步骤", "如没有其他步骤，安全收尾"]
    }
  }
}
```

3. Agent 看到 `failure.exhausted` 信号（且 `status: 'exhausted'`）→ 不应继续重试同一操作
4. **系统层兜底**：Gateway 入口维护 `exhaustedFingerprints: Set<string>`（在 graph state 中）。如果即将执行的 tool call 的 Fingerprint 已标记为 exhausted，Gateway 直接拒绝执行并返回 `status: 'exhausted'` 的 ToolMessage——不依赖 Agent 自觉遵守
5. 存在独立步骤 → 继续其他步骤
6. 核心目标无替代方案 → 安全收尾

### 进展检测（何时重置计数）

并非所有失败的重复都算"无进展"。以下情况视为有进展，重置对应 Fingerprint 的计数：

| 检测方式 | 判定为"有进展"的条件 | 实现 |
|---------|-------------------|------|
| 文件内容变化 | `affectedPath` 指向的文件在本次工具执行前后内容不同（SHA-256 比对） | Gateway 在执行前后对 `affectedPath` 做 hash 快照 |
| 错误特征变化 | 同一 `toolName + affectedPath` 的 `errorCode` 发生变化（如 "ENOENT" → "EXIT_NONZERO"） | 比对 Execution Journal 中最近两次同 Fingerprint 的 `errorCode` |
| 测试输出变化 | `shell_execute` 的 stderr 前 200 字符与上次不同 | 比对 Execution Journal 中的 `stderr` 摘要 |

**实现方式**：在 Execution Journal 中追加 `affectedPathHash?: string` 和 `stderrDigest?: string` 字段。Gateway 在执行前后做快照，Phase 5 的连续失败检测器比对相邻两次 journal 条目，判定进展。

> **为什么不做全量文件变更追踪**：方案明确不做"完整 Git 快照和回滚系统"。轻量的受影响路径 hash 快照足以判断"文件是否被修改"，不需要整个 workspace 的 diff。

### 跨轮重置（Per-Turn Reset）

连续失败计数**仅在一轮对话内有效**。用户每发送一条新消息 → `cleanup` 节点执行 → `executionJournal` 和 `exhaustedFingerprints` 重置为空。用户显式要求重试的操作不会被上一轮的失败计数阻断。

```typescript
// cleanup 节点返回空 journal，每轮对话重新开始
return { executionJournal: [], exhaustedFingerprints: {} };
```

> **设计理由**：如果用户看到 Agent 因连续失败被阻断后，仍然输入相同指令，不应由系统替用户做"这个操作不该重试"的判断。跨轮重置确保每轮对话是独立的决策空间。

### 执行调度

```typescript
// 同一 Workspace 内：mutation 串行，read 可并行
function scheduleExecution(requests: ToolExecutionRequest[]): ToolExecutionRequest[][] {
  const reads = requests.filter(r => isReadTool(r.toolName));
  const mutations = requests.filter(r => !isReadTool(r.toolName));
  // reads 并行执行（一组 Promise.all），mutations 逐个执行
  return [reads, ...mutations.map(m => [m])];
}
```

> **与方案原版的差异**：去掉"process 默认串行"分类 — Shell 的 read/mutation 分类已由 `evaluateToolPolicy` 的风险级别覆盖。不引入路径级锁（延后）。

> **与批量 Permit 的交互**：Phase 2 中 `approvedBatch` 一次性为整批工具签发 Permit，Phase 5 将 mutation 串行化执行。Permit 的签发（批量）和消费（串行）是分离的——每个 mutation 工具逐个消费自己的 Permit，不影响同一批中其他工具的 Permit 有效性。

> **局限性 — 依赖顺序不是串行化能解决的**：Agent 可能在同一批中发起 `write_file A.ts` 和 `shell_execute test A.ts`——前者应该先于后者。但 mutex 只能保证它们不并发，不能保证执行顺序。正确的做法是 Agent 分两轮发起（先写后测），而非依赖执行层推断依赖。本阶段仅保证"不会同时改同一个文件产生竞态"，不保证语义正确的执行顺序。

### 输出流式释放

当前 `truncateToolOutput()` 已经做了一件事：超长输出保留头部 + 尾部 + 省略行数标注。这是对的——Agent 仍然能看到输出的结构和关键信息。本节补充的是**内存维度的控制**，而非截断 Agent 视野。

**原则：Agent 是输出的消费者，不能让它失明。**

| 场景 | 方案 | 理由 |
|------|------|------|
| `readFile` 超大文件（>500KB） | 拒绝读取，返回错误提示 Agent 改用 `shell_execute` 的 `grep`/`tail`/`head` 提取相关部分 | Agent 不需要读完 10MB 日志——它需要的是"错误发生在哪一行"。Shell 工具更适合这个任务 |
| `shell_execute` 超长输出（>64KB） | 延用现有 `truncateToolOutput` 的 head+tail 模式，不额外引入 Artifact 概念 | 头部有命令输出开头（通常含关键信息），尾部有最终结果（exit code 等），中间省略行数标注——Agent 不失明 |
| 长时间运行的消息历史积累 | 已有 M1 折叠（`foldToolOutputs` / `microCompactToolOutputs`）负责将旧工具输出折叠为摘要 | 不重复造轮子——`context.ts` 的 compaction pipeline 已经解决了这个问题 |
| Execution Journal 大小 | 保留最近 50 条，旧条目仅保留计数 | Journal 是 graph state 的一部分，每次 checkpoint 都会序列化。50 条硬上限防止 checkpoint 无限膨胀 |

> **修正说明**：去掉了"写入临时 Artifact 文件"和"上下文只保留 400 字符"的设计——前者引入了不存在于代码库中的概念，后者会让 Agent 在关键决策时刻失明。

### 完成标准

- 超大文件读取被拒绝并给出替代方案（而非静默截断）
- 超长 Shell 输出延用 head+tail 截断，Agent 视野不受损
- 消息历史中的旧输出由 M1 折叠处理（不重复造轮子）
- 同一 Workspace 写操作串行化
- 取消后没有残留子进程（已有 `cleanup` 节点）
- 审批拒绝与执行失败分别统计
- 同 Fingerprint 达到上限后停止该路径
- 有实际进展时失败计数重置（文件被修改 / 测试结果变化）
- 任务可以安全收尾

---

## 阶段性 MCP 迁移（不单独成阶段）

MCP 工具的迁移分散在各阶段中渐进完成：

| 阶段 | MCP 相关工作 |
|------|------------|
| 阶段一 | `mcp__*` 工具通过 Tool Registry 注册，走 Execution Gateway |
| 阶段二 | MCP 工具执行同样需要 Permit |
| 阶段三 | MCP 工具声明 `network` risk → 受网络策略约束 |
| 阶段五 | MCP 工具元数据补全（side effect / idempotency / cancellation） |

每个 MCP 工具独立声明：risk 等级（延用 `ToolRisk`）、是否访问网络、是否修改外部状态、是否支持取消。不能只按 MCP Server 整体授权（当前已有 `mcpRiskOverride: 'read'` 机制，需扩展为 per-tool 粒度）。

---

## 横向基础能力

### 各阶段新增的 Graph State 字段

| 阶段 | 新增字段 | 类型 | 用途 |
|------|---------|------|------|
| 阶段一 | — | — | 无新增 state 字段（仅重构执行路径） |
| 阶段二 | `approvedBatch` 类型变更 | `Record<string, string>` → `Record<string, PermitEntry>` | Permit 消费标记 |
| 阶段三 | `executionEnvironment` | `ExecutionEnvironment` | 沙箱/非沙箱环境标记，Phase 4 注入 system prompt |
| 阶段四 | `interactionMode` | `InteractionMode` | 审批模式，控制 approval 节点行为 |
| 阶段五 | `executionJournal` | `ExecutionJournalEntry[]` | 工具执行状态追踪 |
| 阶段五 | `exhaustedFingerprints` | `Set<string>` | 已耗尽 Fingerprint 的 blocklist，Gateway 入口兜底拦截 |

### Schema 版本与 Checkpoint 兼容

新增 state 字段时：
- 定义 Schema Version（如 `state.schemaVersion = 2`）
- 旧 checkpoint 恢复时，缺失字段使用安全默认值：
  - `interactionMode = "interactive"`
  - `executionEnvironment = "local_unsafe"`
  - `permitEnforcement = false`（仅旧 checkpoint 兼容）
- 旧 `approvedBatch` 的值是字符串（`"approve_once"` / `"full_access"` 等），新格式是 `PermitEntry` 对象。反序列化后旧值无法通过 `.grant` 访问 → 需要在 cleanup 节点或 state 初始化处增加显式迁移：

```typescript
// cleanup 节点中追加：将旧格式 approvedBatch 迁移为新格式
const raw = state.approvedBatch ?? {};
const migrated: Record<string, PermitEntry> = {};
for (const [id, value] of Object.entries(raw)) {
  if (typeof value === 'string') {
    // 旧 checkpoint：value 是 grant 字符串，不含 argsHash 和 consumed
    // 按安全规则：旧审批请求失效 → 丢弃，不迁移
    continue;
  }
  migrated[id] = value as PermitEntry;
}
```

> **关键安全规则**：旧 Pending Approval 不直接恢复执行。旧审批请求失效 → 重新进入审批流程。`typeof value === 'string'` 的旧条目被丢弃，Agent 若仍需执行对应工具则必须重新申请审批。

### 敏感信息脱敏

统一脱敏层覆盖：Tool Args、Tool Result、Shell 输出、自动审核输入、错误日志、Execution Journal。

```typescript
// src/core/sanitize.ts — 统一脱敏函数，所有输出通道强制调用
export function redact(text: string): string {
  return text
    .replace(/(?:api[_-]?key|token|secret|password|auth)\s*[:=]\s*\S+/gi, '[REDACTED]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(/-----BEGIN.*?PRIVATE KEY-----[\s\S]*?-----END.*?PRIVATE KEY-----/g, '[REDACTED KEY]');
}
```

**强制执行点**：

| 通道 | 调用位置 | 时机 |
|------|---------|------|
| Shell 流式输出 | `onShellProgress` 回调中 | **实时**：每个 chunk 经过 `redact()` 后再发送到 TUI 和存入内存 buffer |
| ToolResult → ToolMessage | Gateway `execute()` 返回结果前 | ToolMessage 写入 messages 前 |
| Execution Journal | Journal entry 写入 graph state 前 | checkpoint 持久化前 |
| 自动审核输入 | approval 节点构造 Reviewer prompt 前 | 模型调用前 |
| Session Logger JSONL | 写出前 | 磁盘写入前 |

> **关键**：流式输出必须**内联实时脱敏**——Shell 输出通过 `onShellProgress` 实时流向 TUI 终端，不能在终端已显示密钥后才去脱敏日志。每个 chunk 在回调中即时经过 `redact()`。同时在 Shell 命令执行前通过 `buildEnvStripSnippet` 剥离环境变量，从源头减少密钥进入命令上下文的机会。

### 功能开关

| 开关 | 用途 | 移除时机 |
|------|------|---------|
| `executionGatewayEnabled` | Gateway vs 旧 `runApprovedTool` | 阶段一完成后删除旧路径 |
| `permitEnforcementEnabled` | Permit 强制 vs 宽松模式 | 阶段二完成后删除 |
| `sandboxNetworkPolicy` | 网络策略（可能影响 npm install 等工作流） | 稳定后删除开关 |
| `autoReviewerEnabled` | 自动审核启用 | 稳定后删除开关 |

**功能开关不能长期成为两套架构并存的理由。**

### 迁移状态表

| 调用来源 | 阶段一后 | 阶段二后 | 阶段三后 | 阶段四后 | 阶段五后 |
|---------|---------|---------|---------|---------|---------|
| Main Agent | Gateway | Gateway + Permit | + 边界 | + 自动审核 | + Journal |
| Code Subagent | Gateway | + Permit | + 边界 | + 自动审核 | + Journal |
| Explore Subagent | Legacy* | Legacy* | + 边界 | + 自动审核 | + Journal |
| Skill | Gateway | + Permit | — | — | — |
| MCP | Gateway | + Permit | + 网络约束 | — | + 元数据 |
| Recovery | Legacy | — | — | — | + Journal |

> \* Explore Subagent 只读，不涉及 Permit/边界升级风险，可延后至阶段五。但其"只读"保证在 Legacy 期间依赖 `allowedTools` 配置约定，非系统强制。Gateway 在 Phase 1 即可拦截 Explore Subagent 的 tool call——一旦接入 Gateway，`ToolRisk` 检查在 Gateway 层强制执行，不再依赖配置约定。

---

## 每个阶段的合并原则

1. 可以独立运行 — 不依赖未完成阶段
2. 已迁移来源不存在双执行路径
3. 原有模式仍然可用（`interactive` + `local_unsafe` = 当前行为）
4. 新增接口具有自动化测试
5. 文档明确当前已实现 vs 尚未实现的能力
6. Checkpoint 兼容策略已验证
7. 功能开关具备明确移除计划
8. 不使用后续阶段才能落实的虚假约束

---

## 推荐测试矩阵

### 阶段一：Execution Gateway

- 工具注册 + 查找 + 执行
- 参数 Schema 校验 + 规范化 + 冻结
- 参数 Hash 稳定性（`{"a":1,"b":2}` vs `{"b":2,"a":1}`）
- 成功/失败结果
- Shell 流式输出保留
- AbortSignal 传递
- 子 Agent tool call 经 Gateway 执行
- 子 Agent 无法直接调用工具实现
- 原有审批行为不变

### 阶段二：Permit

- 无 Permit 拒绝
- Tool Name 不一致拒绝
- Args Hash 不一致拒绝
- Permit 消费标记
- 重复消费被阻止
- Fork 不继承
- Rewind 不恢复已消费
- 现有授权策略行为不变

### 阶段三：执行边界

- `../` 逃逸 + 绝对路径 + `~` 拒绝
- 符号链接逃逸检测
- 新文件路径逐级父目录校验
- 网络禁用生效（macOS + Linux 各自验证）
- 沙箱不可用 → unattended 启动被阻止
- Permit Constraints 携带网络约束且实际生效

### 阶段四：自动审核

- 低风险操作自动允许
- 高风险操作正确回退
- 自动审核超时/不可用/Schema 非法 → 按模式回退
- Unattended 不产生 `require_user`
- Deny And Replan 生成结构化指令
- Constraints 被沙箱落实（阶段三已提供）
- `update_plan` 始终走 `plan_review`，自动审核不拦截
- `ask_user` 始终走 `user_input`，自动审核不拦截

### 阶段五：可靠性

- 同 Fingerprint 累加 / 不同 Fingerprint 切换
- 文件有效变化后重置
- 审批拒绝独立统计
- 达到上限后触发 replan/skip/finalize
- 写操作串行化（同 Workspace 内）
- 超大文件读取拒绝 + 引导使用 Shell 工具
- 超长输出 head+tail 截断保留关键信息

---

## 推荐提交顺序

### 阶段一

```text
refactor: add ToolDescriptor registry and ToolExecutionRequest types
refactor: extract tool implementations into registry entries
refactor: replace runApprovedTool switch with registry dispatch
refactor: normalize tool args with schema validation and canonical hash
refactor: route subagent tool calls through execution gateway
test: execution gateway compatibility and subagent path
```

### 阶段二

```text
feat: extend approvedBatch with argsHash and consumed flag
feat: validate argsHash at execution time
feat: enforce single-consumption permit semantics
test: permit lifecycle, fork/rewind inheritance
```

### 阶段三

```text
feat: add workspace path boundary checks to file tools
feat: add symlink escape detection for file operations
feat: add network policy to sandbox options
feat: block unattended mode when sandbox is unavailable
test: path escape, symlink, network policy, sandbox fallback
```

### 阶段四

```text
feat: add auto review model integration in approval node
feat: add interaction mode routing (interactive / auto_review / unattended)
feat: add replan instruction generation on deny
test: auto review decisions, fallback behavior, unattended constraints
```

### 阶段五

```text
feat: add lightweight execution journal to graph state
feat: add failure fingerprint and per-category retry limits
feat: serialize mutation tool execution in same workspace
feat: reject oversized file reads with shell tool guidance
test: failure accumulation, mutation ordering, large output handling
```

---

## 文件清单（预估）

| 文件 | 角色 | 阶段 |
|------|------|------|
| `src/core/execution/registry.ts`（新建） | Tool Registry + ToolDescriptor | 一 |
| `src/core/execution/request.ts`（新建） | ToolExecutionRequest + 参数规范化 | 一 |
| `src/core/harness/tool-runner.ts` | 重构：switch → registry dispatch | 一 |
| `src/core/harness/graph.ts` | 子 Agent 接入 Gateway | 一 |
| `src/core/subagent/runner.ts` | 子 Agent 走统一执行入口 | 一 |
| `src/core/harness/tool-policy.ts` | 扩展 approvedBatch → Permit entry | 二 |
| `src/core/execution/permit.ts`（新建） | Permit 消费 + argsHash 校验 | 二 |
| `src/core/sandbox/` | 扩展：文件工具接入 + 网络策略 | 三 |
| `src/core/tools/file.ts` | 增加路径边界校验 | 三 |
| `src/core/execution/reviewer.ts`（新建） | 自动审核模型调用 | 四 |
| `src/core/execution/journal.ts`（新建） | Execution Journal + FailureFingerprint | 五 |
| `src/core/model/context.ts` | 自动审核上下文构建 | 四 |
| `tests/execution/`（新建） | 各阶段测试 | 全 |

---

## 验证命令

```bash
# 阶段一
bun test tests/execution/gateway.test.ts tests/subagent.test.ts

# 阶段二
bun test tests/execution/permit.test.ts

# 阶段三
bun test tests/execution/boundary.test.ts tests/sandbox.test.ts

# 阶段四
bun test tests/execution/reviewer.test.ts

# 阶段五
bun test tests/execution/reliability.test.ts

# 全量回归
bun test && bun run typecheck
```
