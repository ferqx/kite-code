# Authorization Mode Switch — Design Spec

> Status: pending review
> Created: 2026-05-10

## Motivation

提升 `ThreadAuthorizationState.mode`（`default` | `full_access`）为一等公民的会话级授权模式，支持三种场景切换：

1. **对话开始前**：run 启动时预设模式
2. **Agent 执行中**：TUI 快捷键实时切换，下次工具策略检查即时生效
3. **用户提示词触发**：用户告诉 agent「不需要确认」，模型通过工具调用切换

## Design

### Core Type

```typescript
// src/shared/types.ts

/** 授权模式 / Authorization mode */
export type AuthorizationMode = "default" | "full_access";

/** 内存级授权覆盖，优先级高于 state.authorization */
export interface AuthorizationOverride {
  current: AuthorizationMode;
}
```

- `AuthorizationOverride` 在 runner 层创建，由 caller（TUI/CLI）持有引用
- `current` 初始值来自 `state.authorization.mode`（checkpoint 恢复）或初始参数
- 当 `current` 非空时，覆盖 `state.authorization.mode` 用于所有 `evaluateToolPolicy` 调用

### Data Flow

```
  启动 (--authorization-mode)          执行中 (TUI hotkey)          提示词 (set_auth_mode)
  ──────────────────────────          ──────────────────          ─────────────────────────
  runner 创建 override                 TUI 修改 override.current   模型调用 set_authorization_mode
  override.current = mode              立即生效                    工具执行 → 更新 override + state
         │                                  │                            │
         └──────────────────────────────────┼────────────────────────────┘
                                            │
                               ┌────────────▼────────────┐
                               │  evaluateToolPolicy()    │
                               │  effectiveMode =         │
                               │    override?.current      │
                               │    ?? auth.mode           │
                               └────────────┬────────────┘
                                            │
                               ┌────────────▼────────────┐
                               │  路由 / 审批 / 执行       │
                               │  使用 effectiveMode      │
                               └─────────────────────────┘
                                            │
                                   (agent node 返回时)
                               ┌────────────▼────────────┐
                               │  authorization: {         │
                               │    ...auth,               │
                               │    mode: override.current  │  ← 持久化到 checkpoint
                               │  }                         │
                               └──────────────────────────┘
```

### Files Changed

#### 1. `src/shared/types.ts`

- Add `AuthorizationMode` type
- Add `AuthorizationOverride` interface

#### 1b. `src/harness/tool-result.ts`

- `ToolExecutionResult` 新增可选字段 `authorization?: ThreadAuthorizationState`
- 当 `set_authorization_mode` 工具执行时，通过此字段返回更新的授权状态，tools node 将其写入 state（沿用已有 `workspaceAccess` 和 `plan` 的模式）

#### 2. `src/harness/tool-policy.ts`

- `evaluateToolPolicy` 新增可选参数 `override?: AuthorizationOverride`
- `effectiveMode = override?.current ?? normalizeAuthorizationState(input.authorization).mode`
- 新增 `set_authorization_mode` 工具 policy：`allow(risk: "plan")`

```typescript
if (request.name === "set_authorization_mode") {
  return allow({
    risk: "plan",
    reason: "Authorization mode changes do not mutate workspace files.",
    ...
  });
}
```

- 导出 `normalizeAuthorizationState`（已导出）

#### 3. `src/harness/routes.ts`

- `routeAfterAgent` 新增 `override?: AuthorizationOverride` 参数
- 传递给 `evaluateToolPolicy`

#### 4. `src/harness/tool-requests.ts`

- `PendingToolRequest` 联合类型新增 `set_authorization_mode` 成员
- `toolRequestFromMessage` 新增解析分支

#### 5. `src/harness/tool-runner.ts`

- `runApprovedTool` 新增 `override?: AuthorizationOverride` 参数
- 传递给 `evaluateToolPolicy`
- 新增 `set_authorization_mode` 执行分支：
  ```typescript
  if (request.name === "set_authorization_mode") {
    if (override) override.current = request.args.mode;
    return withFailureGuidance(request, {
      ok: true,
      command: "set_authorization_mode",
      exitCode: 0,
      stdout: "",
      stderr: "",
      authorization: { mode: request.args.mode, commandGrants: {} },
    });
  }
  ```
- tools node 中通过 `"authorization" in result` 检测并 spread 到 state return（与 `"plan" in result` 模式一致）

#### 6. `src/harness/graph.ts`

- `BuildCodeAgentGraphInput` 新增 `authorizationOverride?: AuthorizationOverride`
- 闭包捕获 override，传入所有 `evaluateToolPolicy` / `routeAfterAgent` / `runApprovedTool` 调用
- `routeAfterAgent` 通过闭包包装传入 override
- agent 节点返回时同步 override 到 `authorization`（见下方 helper）
- tools 节点：扩展 `"authorization" in result` 检测（与已有 `"plan" in result` 模式一致）

```typescript
// helper to sync override -> state
function authorizationForState(
  state: CodeAgentState,
  override?: AuthorizationOverride,
): ThreadAuthorizationState {
  const base = normalizeAuthorizationState(state.authorization);
  if (override && override.current !== base.mode) {
    return { ...base, mode: override.current };
  }
  return base;
}

// agent node return
const syncedAuth = authorizationForState(state, override);
return { ...result, authorization: syncedAuth };
```

#### 7. `src/tools/definitions.ts`

- `createAgentTools` 新增 `set_authorization_mode` 工具

```typescript
const setAuthMode = tool(
  async ({ mode }) => JSON.stringify({ ok: true, mode }),
  {
    name: "set_authorization_mode",
    description: SET_AUTHORIZATION_MODE_CONTRACT.description,
    schema: z.object({
      mode: z.enum(["default", "full_access"])
        .describe("Target authorization mode"),
    }),
  }
);
```

#### 8. `src/tools/tool-contracts.ts`

- 新增 `SET_AUTHORIZATION_MODE_CONTRACT`

```
name: "set_authorization_mode"
whenToUse: Switch between default (require confirmation) and full_access
  (auto-execute) authorization modes. Call only when the user explicitly
  requests a mode change.
commonMistakes: Calling without user request; calling excessively.
outputFormat: JSON with ok: true and the new mode value.
failureHandling: Always succeeds. Mode value is validated against enum.
```

#### 9. `src/app/runner.ts`

- `StreamCodeAgentInput` 新增 `authorizationOverride?: AuthorizationOverride`
- `streamCodeAgent` 传递 override 到 graph 构建

#### 10. `src/app/cli.ts`

- 新增 `--authorization-mode <default|full-access>` 参数
- `parseArgs` 解析该参数
- 对于 run：创建 override 传入 `streamCodeAgent`
- 对于 resume：在审批中断 resume 时，支持通过 `authorizationMode` 字段切换模式
- `--mode full-access` 作为快捷别名：同时设置 `workspaceAccess = "write"` 和 `authorizationMode = "full_access"`

### Override Lifecycle

| 时机 | override.current | state.authorization.mode |
|---|---|---|
| run 启动 | 来自 `--authorization-mode` 或默认 `"default"` | 初始化为 override.current |
| resume（无中断）| 从 checkpoint state.authorization.mode 恢复 | 上次持久化值 |
| resume（中断中）| 从 resume payload 的 `authorizationMode` 更新 | 同 override |
| TUI 快捷键 | 立即更新为新值 | 下次 agent node 或 set_auth_mode 工具返回时同步 |
| set_authorization_mode 工具 | 立即更新为新值 | 工具执行后立即通过 result.authorization 持久化 |
| agent node 返回 | 不变 | 同步为 override.current（兜底，对齐异步变更） |

### Backward Compatibility

- `AuthorizationOverride` 为可选参数，不传则行为不变（CLI 旧用法完全兼容）
- 现有 checkpoint 中的 `authorization.mode` 不受影响
- 现有 `--full-access` flag 在 resume 时的行为不变
- 现有 `applyApprovalGrant` 的 `full_access` 逻辑不变

### Scenarios Coverage

| # | 场景 | 实现方式 |
|---|---|---|
| 1 | 对话开始前切换 | `--authorization-mode full-access` 在 run 时设置 |
| 2 | Agent 执行中实时切换 | TUI 修改 `authorizationOverride.current`，下次 policy check 生效 |
| 3 | 用户提示词触发 | 模型调用 `set_authorization_mode` 工具，更新 override |
