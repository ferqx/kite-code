# 授权溯源 / Authorization Traceability

状态：active
读取时机：修改授权逻辑、安全审计、CLI/TUI 授权入口变更时
验证：`bun test tests/policies/authorization-elevation.test.ts tests/policies/approval-policy.test.ts tests/mcp-tool-policy.test.ts`

## 概述

Runtime Kernel 的授权系统支持两种模式（`default` / `full_access`）和精确命令授权（`same_command` grant）。每条授权记录包含 `source` 字段，用于追溯授权来源。

## AuthorizationSource

```ts
type AuthorizationSource = 'user' | 'config' | 'test' | 'system';
```

| Source | 含义 | 设置场景 |
| ------ | ---- | -------- |
| `user` | 用户通过 TUI 审批面板主动授权 | ApprovalBlock 审批按钮 |
| `config` | 通过 CLI `--full-access` 或配置文件预设 | `bun run agent run --full-access` |
| `test` | 测试代码注入 | `createInitialRuntimeState({ authorizationSource: 'test' })` |
| `system` | 系统自动授予（如 auto-review、loop-mode） | **当前被硬规则禁止** |

## 数据结构

### ToolGrant — 命令授权记录

```ts
interface ToolGrant {
  workspace: string;
  threadId: string;
  command: string;
  source: AuthorizationSource;  // required
  grantedAt: string;             // required, ISO 8601
  expiresAt?: string;
}
```

### ThreadAuthorizationState — 线程级授权

```ts
interface ThreadAuthorizationState {
  mode: 'default' | 'full_access';
  modeSource?: AuthorizationSource;   // 谁提升的 full_access
  modeGrantedAt?: string;             // 提升时间
  commandGrants: Record<string, ToolGrant>;
}
```

### RuntimeState.authorization — 运行时内联类型

```ts
authorization: {
  mode: AuthorizationMode;
  modeSource?: AuthorizationSource;
  modeGrantedAt?: string;
  commandGrants: Record<string, ToolGrant>;
};
```

> **兼容说明**：`RuntimeState.authorization.commandGrants` 直接使用 `ToolGrant`（`source` / `grantedAt` 必需），与 `ThreadAuthorizationState` 对齐。历史持久化数据中的 grant 对象可能缺少这两个字段——当前代码不读取旧 grant 的 `source`/`grantedAt`（`hasSameCommandGrant` 仅校验 `workspace`/`threadId`/`command`），因此反序列化不会出错，但 TypeScript 不对此提供警告。新代码创建 grant 时必须同时填充 `source` 和 `grantedAt`。

## 硬规则（mode-policy.ts）

在 `assertAuthorizationElevation()` 中强制执行：

1. **`full_access` 需要沙箱可用** — `mode === 'full_access' && !sandboxAvailable` → 拒绝
2. **auto-review 不能授予 `full_access`** — `source === 'system' && autoReview` → 拒绝
3. **loop-mode 不能自动提升授权** — `source === 'system' && loopMode` → 拒绝

Windows 的 `Unsandboxed Bash` 不满足 `sandboxAvailable`，因此不能进入 `full` /
`full_access`。它也不产生 authorization grant；`accept_edits` 与 `auto` 仍逐次经过既有
Tool Policy 和 Approval Policy。无真实 sandbox 时，`auto` 不调用 auto-review 扩大准入，
只保留 `accept_edits` 的保守直通 allowlist。

## MCP Tool 策略边界

MCP descriptor 的 `minimumApproval` 不能单独把 unknown/write/destructive effect 变成无审批调用。只有 effective effects 全部为 `none|read` 且 `minimumApproval: none` 时，Approval Policy 才把它当作只读；`minimumApproval: user` 始终要求单次用户批准。远端 annotation 不直接进入该判断，project 配置也不能降低 minimum approval 或 effect 风险。Tool filter 只决定 catalog 可见性，不产生 authorization grant。

## 入口覆盖

| 入口 | source 值 | 位置 |
| ---- | --------- | ---- |
| CLI `--full-access` | `'config'` | `src/app/cli/index.ts:121` |
| TUI `/permissions full` | `'user'` | `src/core/runtime/actions.ts:94` |
| 测试注入 | `'test'` | `tests/policies/authorization-elevation.test.ts` |
| System (禁止) | `'system'` | `src/core/policies/mode-policy.ts:23,26` |

TUI 入口通过 `session-manager.ts` 的 `buildRunAgentParams` → `RunRuntimeAgentInput.authorizationMode` 传递到 `createAgentKernel`；存在真实 sandbox 时，`full` interaction mode 对应 `'full_access'` authorization mode。Kernel 初始化时若恢复的 snapshot 携带旧 `mode` 或 `authorization.mode`，当前请求值覆盖恢复态，确保已通过准入的 `/permissions full` 在新轮次立即生效。Windows `Unsandboxed Bash` 与其他无 sandbox 环境在 App 和 Kernel 两层拒绝该提升。

## 测试

```bash
bun test tests/policies/authorization-elevation.test.ts
```

测试覆盖：

- sandbox 缺失时拒绝 full_access
- auto-review system source 拒绝 full_access
- loop-mode system source 拒绝 full_access
- 各 source 值正确传播到 state 和 grant 记录
- Windows 非沙箱 Bash 不能提升为 `full_access`
