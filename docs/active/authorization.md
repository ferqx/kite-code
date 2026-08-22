# 授权溯源 / Authorization Traceability

状态：active
读取时机：修改授权逻辑、安全审计、CLI/TUI 授权入口变更时
验证：`bun test packages/agent-kernel/test packages/builtin-runtime/test packages/runtime-host/test tests/runtime tests/policies`

## 概述

Runtime Kernel 的授权系统支持两种模式（`default` / `full_access`）和精确命令授权（`same_command` grant）。每条授权记录包含 `source` 字段，用于追溯授权来源。

Builtin catalog 只声明 operation 的 schema、availability、effects、traits 与 minimum approval；它不签发用户
授权。Kernel/Runtime policy 依据 canonical facts 作 governance/admission decision，Host 只验证同一 frozen
registry snapshot 对应的 execution identity，App/Controller 只能把已批准的 grant 注入唯一执行 port。源码 caller/owner
closure 已切到唯一 App/Host/Builtin seams；RMV1-16 final Gate 与完成证据已经闭合，不能形成第二 schema/effects/grant authority；
dynamic MCP 的 binding/catalogRevision 与 Builtin projection revision 也必须保持独立。

RAV1 的 authority trust model、真实 serialization/process boundary 与 key custody 以
`runtime-authority-boundary.md` 为准。同进程 typed grant 使用 exact identity、single-use、expiry/revoke，不为形式统一
重复加 HMAC；持久或进程外 grant/receipt 才进入后续 authenticity Gate。

## AuthorizationSource

```ts
type AuthorizationSource = "user" | "config" | "test" | "system";
```

| Source   | 含义                                      | 设置场景                                                     |
| -------- | ----------------------------------------- | ------------------------------------------------------------ |
| `user`   | 用户通过 TUI 审批面板主动授权             | ApprovalBlock 审批按钮                                       |
| `config` | 通过 CLI `--full-access` 或配置文件预设   | `bun run agent run --full-access`                            |
| `test`   | 测试代码注入                              | `createInitialRuntimeState({ authorizationSource: 'test' })` |
| `system` | 系统自动授予（如 auto-review、loop-mode） | **当前被硬规则禁止**                                         |

## 数据结构

### ToolGrant — 命令授权记录

```ts
interface ToolGrant {
  workspace: string;
  threadId: string;
  command: string;
  source: AuthorizationSource; // required
  grantedAt: string; // required, ISO 8601
  expiresAt?: string;
}
```

### ThreadAuthorizationState — 线程级授权

```ts
interface ThreadAuthorizationState {
  mode: "default" | "full_access";
  modeSource?: AuthorizationSource; // 谁提升的 full_access
  modeGrantedAt?: string; // 提升时间
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

## 硬规则（Agent Kernel authorization domain）

`packages/agent-kernel/src/authorization.ts` 是 `assertAuthorizationElevation()` 的唯一生产实现，输入只包含
canonical authorization facts；App CLI/Runtime 通过 package barrel 接线，不复制 authorization decision。Agent Kernel 的纯 Tool Governance
也复用同一个 invariant，不得维护第二份 full-access/source 检查。

在 `assertAuthorizationElevation()` 中强制执行：

1. full_access 需要 Full-qualified sandbox — mode === full_access 且 Full capability 不可用时拒绝；
2. auto-review 不能授予 full_access — source === system 且 autoReview 时拒绝；
3. loop-mode 不能自动提升授权 — source === system 且 loopMode 时拒绝。

TUI 的 permissions 选择使用同一不变量：由 sandboxSupportsFullModeV1() 而不是单纯的
backend !== none 决定 Full 是否可选。effective backend 为 none 时必须将 full 建议项置灰，键盘选择
跳过它；已选中的 Windows windows_restricted_token 可进入开发期 Full。direct backend 仍没有 strict
network、动态 protected-glob 或 production qualification；开发期 Full 不能被解释为 production Full。

host Shell 只在用户脚本前的 sandbox environment/essential startup capability unavailable，或 Runtime 已持久化
attempt/preparation intent 后得到 typed `backend_unavailable + pre_dispatch + cleanupConfirmed` 时选择。它要求
完整 Runtime invocation identity/lifecycle；已启动、取消、超时或 cleanup unknown 的 native 调用绝不重放。

`/permissions` 不接受 mode 参数；它只能打开选择器。无可用 Full backend 时选择器禁用 `full`，并在
backend 为 none 时显示“非沙箱环境无法开启full”；已选 Windows direct backend 与 macOS/Linux sandbox
一样提供开发期 Full。Help 不提供手动 mode 参数。`full_access` 描述持久的审批/authorization mode，
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

RMV1-12 只迁移该链路的物理 owner，不改变上述授权：五个文件 Builtin catalog entry 与 `git_inspect` 已移除旧的
`execute/projectResult`，唯一 Builtin Runtime executor 只能消费 Tool Pipeline 在 exact invocation 完成 Policy、
approval、protected-path 与 durable attempt acknowledgement 后注入的 filesystem/Git mechanism。缺少 Host
execution port、binding 不一致或 mechanism 缺失均 fail closed，不回到旧 handler；State 25、Store 4 与 epoch
`kite-runtime-2026-08-18` 保持不变。

RMV1-14 同样只迁移 Plan/Task/Subagent/Verification 的物理 owner，不改变授权结果。App 的
`read_plan/update_plan/write_plan/task` adapter 已禁止 concrete executor/result owner，唯一 Builtin executor 只能消费
Tool Pipeline 在 phase、Policy、approval、capability attempt acknowledgement 与现有 Subagent sealed grant 后注入的
Plan/child mechanism。Builtin Subagent role ceiling 可收紧 allowed tool 与 Shell command shape，不能签发用户批准、
提升 phase/workspace access 或绕过 parent authorization。`ask_user` 仍是 Kernel-owned interrupt；Builtin module 的
同名 operation 不形成 execution 旁路。缺少 mechanism、binding 或 grant 均 fail closed，没有旧 handler fallback。

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
命令在未获授权时使用 network-disabled，不因 executable 名称本身触发网络审批；明确网络命令及无法证明
local-only 的 arbitrary script 使用 `effects.network` 或 `uncertainEffects` 进入现有审批。用户一旦授予
`approve_once`、`same_command` 或 Full，本次 exact Shell invocation 默认产生 development `allow_all`；
静态 effects 只决定审批文案与 filesystem scope，不能在批准后再次把该调用强制改成 network-disabled。
拒绝则命令不启动；不能兑现 governed network 的 sealed production consumer 必须在审批前拒绝。
macOS/Linux native sandbox 消费该模式；Windows protocol V6 对已批准 `allow_all` 使用当前登录用户 token
运行该 exact command，并保留当前用户 profile 的 Schannel 路径。它不创建本地账户、不请求 UAC，也不依赖
持久 credential state。未获网络授权的 Windows 调用继续使用 restricted token。由于 Schannel 不能在该
restricted primary token 下取得凭据，Windows 已批准联网调用不再声称 restricted-token filesystem ceiling；
Job Object 仍限制进程树。该 development authorization 不构成结构性 network-off evidence，不能提升 Full 或
production qualification。

`curl -w/--write-out` 中的安全 `%{name}` 状态占位符仅是 curl 输出模板，不是 Shell 控制语法；它不应把
本来只访问网络、或写到 `/dev/null` 的健康检查升级为 `uncertainEffects/full_access`。模板中其余 Shell
元字符、未知命令组合或实际工作区外读写仍按保守规则要求相应 filesystem scope。

同一条模型消息产生多个连续的 `shell_execute` 调用时，每个调用独立完成参数解析、策略预检和用户审批。某一调用收到 `approval.granted` 后立即成为 Scheduler 术语（运行时调度器）的下一项，不能等待 sibling 的审批决定共同收敛。Runtime Runner 术语（运行时执行循环）在该调用发出 `tool.started` 后继续处理同组下一个 Shell；因此前一个命令可以一边运行，Footer 一边展示后一个命令的审批，后一个获批后也立即启动。TUI 同一时刻仍只展示一个审批交互；解决后一个审批时只能重置对应等待项或 Subagent 的审批等待计时，不得重置已经运行的 sibling Shell 的 `startedAt` 或累计耗时。

Subagent 内部工具触发审批时存在两个合法身份：持久化 interaction 由 parent `task` Tool Call 拥有，approval payload 的 `callId` 仍可指向真正被审批的 child Tool Call。TUI 必须以 RuntimeEvent 的 parent `toolCallId` 跟踪和关闭 Footer interrupt，不能拿 child payload `callId` 与 `approval.granted`/`approval.rejected` 的 parent id 比较；child id 继续留在 continuation 中用于精确恢复。`approve_once`、`same_command` 和拒绝都遵循同一关闭规则。

auto-review 的 Model/Prompt/response parsing 属于 Builtin reviewer；是否接受 reviewer 结果则由
`@kite/agent-kernel#decideAutoReviewV1` 对 JSON-safe facts 纯确定性裁决。只有 `ok=true`、`approved=true` 且 grant
为 operation-bound 的 `approve_once` 或 `same_command` 才能接受；`full_access`、技术失败、拒绝、未知字段、矛盾
failure facts 或缺失 grant 都必须请求人工审批。Kernel 不生成 UUID、时间或事件；State25 adapter 只为 Kernel 的
`request_user_approval` 决策补 interaction identity 并投影现有事件，App 不能重写一份升级规则。
Builtin package 的公开 Model API 不暴露可自行注入 Gateway 的 reviewer 函数；production 只能调用 App 注入的
`BuiltinModelEffectCoordinatorV1`。Coordinator 依据已解析 reviewer 配置创建模型并复用其构造时绑定的唯一 Gateway，
App 不创建第二 reviewer model，也不存在 direct helper、第二 Gateway 或 Provider-denial fallback。

审批载荷只有 Protocol `ToolApprovalPayload` 一份 JSON-safe 定义；Policy、Controller、Executor 与 App
直接共用该类型。不得再声明同义 approval DTO，也不得通过类型强转连接分叉字段。

Shell 重叠范围只限同一 `modelMessageId` 和同一任务的连续 sibling；遇到非 Shell 调用、不同模型消息、不同任务、`ask_user` 或方案审核时，Runner 必须等待已启动 Shell 收敛，不能跨过交互和副作用边界。`approval.rejected` 必须携带对应 `toolCallId`。用户显式拒绝或取消任一工具审批时，当前审批目标记为 rejected，其余运行中或 queued sibling 记为 cancelled，Runtime 写入 `turn.aborted(cause=user)` 后立即结束当前 turn；不再请求后续审批、执行其他工具或调用模型，已启动执行通过 AbortSignal 停止。TUI 清除未开始 sibling 的 queued术语（排队中）临时元数据和审批中断；审批目标本身即使尚未 `tool.started`，也必须在消息列表物化为带拒绝原因的 error 工具卡，避免用户取消后调用记录消失。其余未开始 sibling 不生成取消卡；只有实际收到 `tool.started` 的 sibling 才进入消息列表并按 cancelled 终态收尾。策略拒绝、sandbox 缺失和系统审查失败不是用户取消，但审批目标仍保留对应终态记录。`approve_once`、`same_command` 与 `full_access` 的授权范围和溯源规则保持不变，一个调用的单次授权不会扩散给其他命令。当前事件集合不包含 `tool.execution_ready`；未知或退役的持久事件在 reducer 前作为 corruption 拒绝。

## 入口覆盖

| 入口                    | source 值  | 位置                                             |
| ----------------------- | ---------- | ------------------------------------------------ |
| CLI `--full-access`     | `'config'` | `apps/kite/src/cli/index.ts:121`                 |
| TUI 权限选择器确认 Full | `'user'`   | `apps/kite/src/bootstrap/runtime/SessionManager.ts` |
| 测试注入                | `'test'`   | `tests/policies/authorization-elevation.test.ts` |
| System (禁止)           | `'system'` | `packages/agent-kernel/src/authorization.ts`     |

TUI 入口通过 `apps/kite/src/bootstrap/runtime/SessionManager.ts` 的 `buildRunAgentParams` →
`RuntimeSessionCoordinator` 传递 `authorizationMode`；`full` interaction mode 对应 `'full_access'` authorization mode。
Kernel 初始化时若恢复的 State25 snapshot 携带旧 `mode` 或 `authorization.mode`，当前选择器确认值覆盖恢复态，
并在新轮次立即生效。production transition decision 由 `@kite/agent-kernel` 拥有，App coordinator 不复制该 decision。

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
bun run --cwd packages/agent-kernel test
bun test tests/policies/authorization-elevation.test.ts tests/policies/mode-policy.test.ts tests/runtime/actions.test.ts
```

测试覆盖：

- sandbox 缺失时拒绝 full_access
- auto-review system source 拒绝 full_access
- loop-mode system source 拒绝 full_access
- 各 source 值正确传播到 state 和 grant 记录
