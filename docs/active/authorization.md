# 授权溯源 / Authorization Traceability

状态：active
读取时机：修改授权逻辑、安全审计、CLI/TUI 授权入口变更时
验证：`bun test tests/policies/authorization-elevation.test.ts tests/policies/approval-policy.test.ts tests/mcp-tool-policy.test.ts tests/runtime/scheduler.test.ts tests/runtime/tool-controller.test.ts`

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

## MCP Tool 策略边界

MCP descriptor 的 `minimumApproval` 不能单独把 unknown/write/destructive effect 变成无审批调用。只有 effective effects 全部为 `none|read` 且 `minimumApproval: none` 时，Approval Policy 才把它当作只读；`minimumApproval: user` 始终要求单次用户批准。远端 annotation 不直接进入该判断，project 配置也不能降低 minimum approval 或 effect 风险。Tool filter 只决定 catalog 可见性，不产生 authorization grant。

## Shell 逐项审批与重叠执行

同一条模型消息产生多个连续的 `shell_execute` 调用时，每个调用独立完成参数解析、策略预检和用户审批。某一调用收到 `approval.granted` 后立即成为 Scheduler 术语（运行时调度器）的下一项，不能等待 sibling 的审批决定共同收敛。Runtime Runner 术语（运行时执行循环）在该调用发出 `tool.started` 后继续处理同组下一个 Shell；因此前一个命令可以一边运行，Footer 一边展示后一个命令的审批，后一个获批后也立即启动。TUI 同一时刻仍只展示一个审批交互；解决后一个审批时只能重置对应等待项或 Subagent 的审批等待计时，不得重置已经运行的 sibling Shell 的 `startedAt` 或累计耗时。

Shell 重叠范围只限同一 `modelMessageId` 和同一任务的连续 sibling；遇到非 Shell 调用、不同模型消息、不同任务、`ask_user` 或方案审核时，Runner 必须等待已启动 Shell 收敛，不能跨过交互和副作用边界。`approval.rejected` 必须携带对应 `toolCallId`。用户显式拒绝或取消任一工具审批时，当前审批目标记为 rejected，其余运行中或 queued sibling 记为 cancelled，Runtime 写入 `turn.aborted(cause=user)` 后立即结束当前 turn；不再请求后续审批、执行其他工具或调用模型，已启动执行通过 AbortSignal 停止。TUI 清除未开始调用的 queued术语（排队中）临时元数据和审批中断，不在消息列表生成取消卡；只有实际收到 `tool.started` 的调用才进入消息列表并按 cancelled 终态收尾。策略拒绝、sandbox 缺失和系统审查失败不是用户取消，不触发该整轮中止。`approve_once`、`same_command` 与 `full_access` 的授权范围和溯源规则保持不变，一个调用的单次授权不会扩散给其他命令。`tool.execution_ready` 仅为旧会话回放兼容事件，新执行不再产生。

## 入口覆盖

| 入口 | source 值 | 位置 |
| ---- | --------- | ---- |
| CLI `--full-access` | `'config'` | `src/app/cli/index.ts:121` |
| TUI `/permissions full` | `'user'` | `src/core/runtime/actions.ts:94` |
| 测试注入 | `'test'` | `tests/policies/authorization-elevation.test.ts` |
| System (禁止) | `'system'` | `src/core/policies/mode-policy.ts:23,26` |

TUI 入口通过 `session-manager.ts` 的 `buildRunAgentParams` → `RunRuntimeAgentInput.authorizationMode` 传递到 `createAgentKernel`；`full` interaction mode 对应 `'full_access'` authorization mode。Kernel 初始化时若恢复的 snapshot 携带旧 `mode` 或 `authorization.mode`，当前请求值覆盖恢复态，确保 `/permissions full` 在新轮次立即生效。

## 测试

```bash
bun test tests/policies/authorization-elevation.test.ts
```

测试覆盖：

- sandbox 缺失时拒绝 full_access
- auto-review system source 拒绝 full_access
- loop-mode system source 拒绝 full_access
- 各 source 值正确传播到 state 和 grant 记录
