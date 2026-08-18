# 授权溯源 / Authorization Traceability

状态：active
读取时机：修改授权逻辑、安全审计、CLI/TUI 授权入口变更时
验证：`bun test tests/policies/authorization-elevation.test.ts tests/policies/approval-policy.test.ts tests/mcp-tool-policy.test.ts tests/runtime/scheduler.test.ts tests/runtime/tool-controller.test.ts tests/tui-reducer.test.ts tests/tui-replay-blocks.test.ts`

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

在 assertAuthorizationElevation() 中强制执行：

1. full_access 需要 Full-qualified sandbox — mode === full_access 且 Full capability 不可用时拒绝；
2. auto-review 不能授予 full_access — source === system 且 autoReview 时拒绝；
3. loop-mode 不能自动提升授权 — source === system 且 loopMode 时拒绝。

TUI 的 permissions 选择使用同一不变量：由 sandboxSupportsFullModeV1() 而不是单纯的
backend !== none 决定 Full 是否可选。effective backend 为 none、pending qualification，以及
Windows windows_restricted_token 都必须将 full 建议项置灰，键盘选择跳过它。直接 backend 虽然是
一个 development sandbox，也没有 strict network、动态 protected-glob 或 production Full 资格；因此
不能把它当成 Full-qualified sandbox。

host Shell 只在用户脚本前的 sandbox environment/essential startup capability unavailable，或 Runtime 已持久化
attempt/preparation intent 后得到 typed `backend_unavailable + pre_dispatch + cleanupConfirmed` 时选择。它要求
完整 Runtime invocation identity/lifecycle；已启动、取消、超时或 cleanup unknown 的 native 调用绝不重放。

`/permissions` 不接受 mode 参数；它只能打开选择器。无可用 Full backend 时选择器禁用 `full` 并显示
非沙箱环境无法开启full；Help 不提供手动 mode 参数。`full_access` 描述持久的审批/authorization mode，
不是 native sandbox qualification；但在当前 development TUI/foreground CLI 中，用户来源的
`approve_once`、`same_command` 或显式 Full 会为具有 `externalRead`、`externalWrite` 或
`uncertainEffects` 的 Shell invocation 投影单次 `filesystemMode=allow_all`。可用 native backend 仍只在命令
启动前扩大文件系统 scope；若 native Provider 在 dispatch 前 unavailable 且 abandonment/cleanup 已确认，
ADR-0119 允许 App 改用一次 host Shell。命令一旦可能启动就不再切换或 replay。Seatbelt deny、bubblewrap protected mount 与 Windows
restricted-only guard SID 在扩权后继续保护固定凭据/持久化身份；字符串扫描只是前置防御。production
consumer 仍必须服从 sealed capability admission。

## 受信任 Workspace 文件工具边界

ADR-0118 把内建文件工具与进程执行授权分开。`read_file`、`search_content`、`search_files` 对任何有效路径
默认免审；Workspace 外读取进入 observe-only `external_read` scope，不产生 `externalRead` approval grant。
当前 Workspace 的物理位置不影响信任，文件工具可直接读写其中 `.git`、`.env`、`.ssh`、`.codex`、
`.agents` 等名称。Building 阶段的 `accept_edits` 直接放行 Workspace 内 mutation；Workspace 外
`write_file`/`edit_file` 仍要求 exact invocation approval，批准后形成 `approved_external`，文件名与宿主祖先
不得再二次拒绝。canonical/no-follow identity、read-before-edit、preimage/stale、single-use commit、取消、
大小/编码与真实 OS failure 仍由 Provider 执行。

本节不适用于 Shell、MCP executable/cwd、typed Git、Skill reference 或原生 sandbox。下文的
`externalRead`/`filesystemMode=allow_all` 只描述 Shell invocation；destructive、提权、关键系统删除、
credential/persistence 等极高风险进程操作仍可在审批前 fail closed。

## MCP Tool 策略边界

MCP descriptor 的 `minimumApproval` 不能单独把 unknown/write/destructive effect 变成无审批调用。只有 effective effects 全部为 `none|read` 且 `minimumApproval: none` 时，Approval Policy 才把它当作只读；`minimumApproval: user` 始终要求单次用户批准。远端 annotation 不直接进入该判断，project 配置也不能降低 minimum approval 或 effect 风险。Tool filter 只决定 catalog 可见性，不产生 authorization grant。

## Shell 逐项审批与重叠执行

Shell 文件系统授权也按 invocation 投影。默认 `workspace_only` 继续由 macOS Seatbelt、Linux
bubblewrap 或 Windows restricted-token 执行；工作区外读写和无法静态限定路径的命令必须完成当前模式
审批，批准后以 `allow_all` 投影到三个平台各自的 native sandbox 执行一次。临时目录、缓存目录与普通
外部文件属于可批准操作，不得再被 native Workspace ceiling 二次拒绝。Auto 模式先由自动审批模型
判断：安全则自动产生单次 grant；判定有风险或模型异常/不可用才转真人审批。
凭据、Shell/Agent/IDE 配置、Git hook/config、启动项、关键系统文件、提权与关键删除在审批前拒绝，
因此不会出现用户先批准再收到 Kite policy denial。命令本身、宿主 ACL/TCC、磁盘或目标状态仍可正常
返回执行失败；“批准后可执行”不伪造命令成功。

Shell 网络授权按 invocation 投影。精确的 `node|npm|pnpm|yarn|bun --version|-v` 与其他可证明本地
命令使用 network-disabled，不因 executable 名称本身触发网络审批；明确网络命令及无法证明
local-only 的 arbitrary script 使用 `effects.network` 或 `uncertainEffects` 进入现有审批。批准后只为该
调用产生 development `allow_all`，拒绝则命令不启动。交互式 development execution boundary 不得在批准
后再次把该调用强制改成 network-disabled；不能兑现 governed network 的 sealed production consumer 必须
在审批前拒绝。macOS/Linux native sandbox 消费该模式；Windows hybrid backend 的 protocol V6 要求纯
网络批准结果切换到受管 Online 非管理员登录会话；为支持
Schannel direct TLS，该 approved child 使用 ACL lease 而不是 constrained restricted token。账户安装是与 Shell 审批分离的
首次 TUI onboarding/显式 CLI setup；只有该 control-plane 选择可以请求 UAC，普通 invocation 从不提权。
setup 还串行配置 Online identity 的非敏感 profile read roots；read roots 不产生写授权，凭据目录保持排除，
且命令期 ACL lease 不得把 profile 祖先权限扩展为临时写权限。
工具审批被拒绝或 setup readiness 缺失时命令都不得启动。这仍不构成结构性 network-off evidence，不能提升 Full 或
production qualification。

同一条模型消息产生多个连续的 `shell_execute` 调用时，每个调用独立完成参数解析、策略预检和用户审批。某一调用收到 `approval.granted` 后立即成为 Scheduler 术语（运行时调度器）的下一项，不能等待 sibling 的审批决定共同收敛。Runtime Runner 术语（运行时执行循环）在该调用发出 `tool.started` 后继续处理同组下一个 Shell；因此前一个命令可以一边运行，Footer 一边展示后一个命令的审批，后一个获批后也立即启动。TUI 同一时刻仍只展示一个审批交互；解决后一个审批时只能重置对应等待项或 Subagent 的审批等待计时，不得重置已经运行的 sibling Shell 的 `startedAt` 或累计耗时。

Subagent 内部工具触发审批时存在两个合法身份：持久化 interaction 由 parent `task` Tool Call 拥有，approval payload 的 `callId` 仍可指向真正被审批的 child Tool Call。TUI 必须以 RuntimeEvent 的 parent `toolCallId` 跟踪和关闭 Footer interrupt，不能拿 child payload `callId` 与 `approval.granted`/`approval.rejected` 的 parent id 比较；child id 继续留在 continuation 中用于精确恢复。`approve_once`、`same_command` 和拒绝都遵循同一关闭规则。

审批载荷只有 Protocol `ToolApprovalPayload` 一份 JSON-safe 定义；Policy、Controller、Executor 与 App
直接共用该类型。Core 不得再声明同义 approval DTO，也不得通过类型强转连接分叉字段。

Shell 重叠范围只限同一 `modelMessageId` 和同一任务的连续 sibling；遇到非 Shell 调用、不同模型消息、不同任务、`ask_user` 或方案审核时，Runner 必须等待已启动 Shell 收敛，不能跨过交互和副作用边界。`approval.rejected` 必须携带对应 `toolCallId`。用户显式拒绝或取消任一工具审批时，当前审批目标记为 rejected，其余运行中或 queued sibling 记为 cancelled，Runtime 写入 `turn.aborted(cause=user)` 后立即结束当前 turn；不再请求后续审批、执行其他工具或调用模型，已启动执行通过 AbortSignal 停止。TUI 清除未开始 sibling 的 queued术语（排队中）临时元数据和审批中断；审批目标本身即使尚未 `tool.started`，也必须在消息列表物化为带拒绝原因的 error 工具卡，避免用户取消后调用记录消失。其余未开始 sibling 不生成取消卡；只有实际收到 `tool.started` 的 sibling 才进入消息列表并按 cancelled 终态收尾。策略拒绝、sandbox 缺失和系统审查失败不是用户取消，但审批目标仍保留对应终态记录。`approve_once`、`same_command` 与 `full_access` 的授权范围和溯源规则保持不变，一个调用的单次授权不会扩散给其他命令。当前事件集合不包含 `tool.execution_ready`；未知或退役的持久事件在 reducer 前作为 corruption 拒绝。

## 入口覆盖

| 入口 | source 值 | 位置 |
| ---- | --------- | ---- |
| CLI `--full-access` | `'config'` | `src/app/cli/index.ts:121` |
| TUI 权限选择器确认 Full | `'user'` | `src/core/runtime/actions.ts:94` |
| 测试注入 | `'test'` | `tests/policies/authorization-elevation.test.ts` |
| System (禁止) | `'system'` | `src/core/policies/mode-policy.ts:23,26` |

TUI 入口通过 `session-manager.ts` 的 `buildRunAgentParams` → `RunRuntimeAgentInput.authorizationMode` 传递到 `createAgentKernel`；`full` interaction mode 对应 `'full_access'` authorization mode。Kernel 初始化时若恢复的 snapshot 携带旧 `mode` 或 `authorization.mode`，当前选择器确认值覆盖恢复态，并在新轮次立即生效。

当 Runtime 正在回复时，`/permissions` 的选择同样必须立即生效：`SessionRuntime` 通过 live
Kernel control 持久化 `interaction_mode.changed`。事件只能来自显式用户选择，并带 `source: user` 与
时间戳；Kernel 在持久化前对 `full` 复用 `assertAuthorizationElevation()`，只有 Full-qualified sandbox
才允许提升。reducer 在同一状态转换中更新 `mode`、对应的 authorization mode 及其 provenance，并清除
当前 Task 的临时 `executionMode` 覆盖；降级会清除 mode-level provenance，已批准计划本身仍保留其历史
展示选择。事件推进 revision，已在旧 mode 下启动但尚未提交的 effect 不能再提交结果，后续调度按新 mode
重新计算。该路径不直接改写 RuntimeState，也不依赖 TUI ref 的下一次渲染。

Subagent 工具面与执行策略显式继承父 Runtime 当前的 `interactionMode`，不从模型参数或可能过期的 task config 推导。子 Agent 因审批挂起后，恢复时以父 Runtime 的 live mode 为权威：挂起期间的 `/permissions` 降级或提升会用于已批准的阻塞工具和后续 child loop。内部调用若遗漏显式 mode，只能 fail-safe 回退到 `accept_edits`，不得因 config 中的 `full` 而放宽。

`/permissions` 只接受无参数形式并打开可用模式选择器，确认某一项后才改变 mode；任何附加参数都不
触发模式切换。当前 backend 不支持 `full` 时选择器禁用该项。
这不会把模式选择伪装成 production capability admission。production execution-status 只可由 CLI
`--execution-status` 查询；它不是 grant，不能扩大 capability surface。

`/rewind` 从恢复点 fork 新 thread 时不继承源 thread 的授权。Fork 必须把
`authorization.mode` 重置为 `default`，删除 `modeSource` / `modeGrantedAt` 和全部 command
grant，并把 `mode=full` 降为 `accept_edits`；同时清除 turn-scoped capability
binding/disclosure 与 Provider session waiver。用户需要 full access 时必须在新会话中重新显式授予。

## 测试

```bash
bun test tests/policies/authorization-elevation.test.ts
```

测试覆盖：

- sandbox 缺失时拒绝 full_access
- auto-review system source 拒绝 full_access
- loop-mode system source 拒绝 full_access
- 各 source 值正确传播到 state 和 grant 记录
