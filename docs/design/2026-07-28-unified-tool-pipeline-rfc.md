# 统一工具执行管线 RFC

状态：draft
日期：2026-07-28
依赖：ADR-0043（ToolSpec Registry）、ADR-0042（文件工具语义）
关联：`docs/design/2026-07-26-tool-spec-registry-rfc.md`

## 背景

`runApprovedTool`（930 行）包含 13 个逐工具 if-else 分支 + 1 个 generic fallback。每个分支手写：

1. Context 注入（allowExternalPaths、writeTarget、mcpManager、shellExecutor、runTask）
2. Pre-processing（read-state check、preimage capture、external path 判断）
3. Post-processing（read-state record、result enrichment）
4. 结果投影（dual-stream vs single-stream）

新增工具即使已注册到 Registry、出现在模型表面、能被 Schema 解析，仍可能在执行阶段没有对应分支。Generic fallback 缺失 withFailureGuidance、read-state、preimage、mcpManager、shell context。

## 目标

- 消灭 `runApprovedTool` 的逐工具分支，统一为 5 阶段管线
- Spec 声明执行所需 context（requirements）和后处理（postExecute）
- MCP 动态工具和 interrupt 通过同一管线处理
- 新增工具只需在 spec 中声明 requirements，零 runner 改动

## 设计

### 1. Spec 接口扩展

`ExecutableToolSpec` 新增：

```typescript
interface ToolRequirements {
  externalPath?: boolean;    // 需要 allowExternalPaths
  writeTarget?: boolean;     // 需要 writeTarget（read-state check + preimage 输入）
  mcpManager?: boolean;      // 需要 mcpManager 注入
  shellExecutor?: boolean;   // 需要 shellExecutor + shellNetworkMode + onShellProgress
  taskAdapter?: boolean;     // 需要 runTask 子代理适配器
}

interface ExecutableToolSpec<Name, Input, Output> {
  // ... 现有字段 ...
  readonly requirements?: ToolRequirements;
  postExecute?(
    output: Output,
    context: ToolExecutionContext & { invocationInput: Input },
  ): void;
}
```

`ToolExecutionContext` 新增：

```typescript
interface ToolExecutionContext {
  // ... 现有字段 ...
  recordFilePreimage?: (path: string, content: string | null, existed: boolean) => void;
}
```

### 2. 统一管线（5 阶段）

```
Phase 1: Policy 预检
  evaluateToolApproval → modePolicy → claimPermit
  输出: policy, hasExecutionGrant

Phase 2: 路由
  isMcpRequest(request) → MCP 执行策略
  spec.kind === 'interrupt' → Interrupt 策略
  'execute' in spec → Executable 策略
  else → unsupported_tool

Phase 3: Context 解析
  resolveExecutionContext(spec.requirements, request, pipelineInput)
  → ToolExecutionContext

Phase 4: 执行
  Executable: dispatchRegisteredTool(spec, args, ctx)
  Interrupt: createInterrupt(args, ctx) → 中断结果
  MCP: callCapability → normalizeMcpToolResult → serializeMcpResultForModel

Phase 5: Post-hook + 归一化
  spec.postExecute?.(output, ctx)
  normalizeResult(request, dispatched) — 统一双流投影 + withFailureGuidance
```

### 3. Context 解析（`resolveExecutionContext`）

纯函数，接收 requirements + 管线输入，返回完整 ToolExecutionContext：

- `externalPath`: `isExternalPathArg(args.path) ? hasExecutionGrant : undefined`
- `writeTarget`: `readTextContent` → `sessionReadTracker.check` → `{ path, readState, previousContent, existed }`
- `mcpManager`: 透传
- `shellExecutor`: 透传 + `resolveShellNetworkMode(policy, hasExecutionGrant)`
- `taskAdapter`: 构建 `runTask` 闭包（从现有 task 分支提取）

### 4. MCP 动态执行

管线内独立分支，不伪造静态 spec：

- 复用 Phase 1 Policy 预检结果
- `mcpManager.callCapability({ capabilityId, expectedRevision, arguments, signal })`
- `normalizeMcpToolResult(raw, descriptor?.outputSchema)`
- `serializeMcpResultForModel`（128 KB 截断）
- `isMcpProviderError(err)` 仍然 rethrow

### 5. Interrupt 处理

- `spec.kind === 'interrupt'` → `createInterrupt(args, ctx)`
- Mode policy 检查（`shouldAskUser`）
- 正常情况由 controller 的 user_input 节点拦截；到达 runner 是错误路径

### 6. 结果归一化

所有路径统一经过：
- 双流投影（`streams?.stdout ?? (ok ? modelContent : '')`）
- `withFailureGuidance(request, result)` — 包括 generic fallback 和 MCP
- 附加 `tool: request.name`

## 迁移策略

1. 新增 `ToolRequirements` + `postExecute` 到 spec 接口（纯类型，零行为变化）
2. 逐 spec 声明 requirements + postExecute
3. 实现 `resolveExecutionContext`（从现有分支逻辑提取）
4. 实现统一管线（与旧版并存，feature flag `unifiedToolPipelineV1`）
5. 逐工具切换验证
6. 删除旧分支

## 测试策略

- 闭合性测试：每个 executable spec 必须有 requirements 声明
- postExecute 测试：read-state record/preimage 在 dispatch 后被调用
- 管线等价测试：新旧管线对同一输入产出相同 ToolExecutionResult
- MCP 路径测试：identity gating、revision mismatch、provider error rethrow
- Golden tests + TUI system tests 全部通过

## 文件影响

| 文件 | 变更 |
|------|------|
| `src/core/tools/registry/spec.ts` | +ToolRequirements, +postExecute, +recordFilePreimage |
| `src/core/tools/registry/dispatch.ts` | dispatchRegisteredTool 调用 postExecute |
| `src/core/harness/tool-runner.ts` | 重写为 ~200 行管线 |
| `src/core/harness/pipeline.ts`（新增） | resolveExecutionContext, executeMcpDynamic, executeInterrupt, normalizeResult |
| 各 spec 文件 | +requirements, +postExecute |

## 不变的部分

- Policy 预检逻辑（evaluateToolApproval + modePolicy + claimPermit）
- MCP binding/turn/revision/schema 校验
- `dispatchRegisteredTool` 的 preExecute → execute → projectResult 序列
- `PendingToolRequest` 类型与 event store 序列化形状
- ADR-0042 先读后改语义（通过 spec.preExecute 表达）
