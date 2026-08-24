# 授权溯源 / Authorization Traceability

状态：active
读取时机：修改授权逻辑、安全审计、CLI/TUI 授权入口变更时
验证：`bun test packages/agent-kernel/test packages/builtin-runtime/test packages/runtime-host/test tests/runtime tests/policies`

相关：ADR-0118、ADR-0119、ADR-0131、ADR-0132、ADR-0133。

## 概述

Runtime Kernel 的授权系统支持两种模式（`default` / `full_access`）和精确命令授权（`same_command` grant）。每条授权记录包含 `source` 字段，用于追溯授权来源。

Builtin catalog 只声明 operation 的 schema、availability、effects、traits 与 minimum approval；它不签发用户
授权。Kernel/Runtime policy 依据 canonical facts 作 governance/admission decision，Host 只验证同一 frozen
registry snapshot 对应的 execution identity，App/Controller 只能把已批准的 grant 注入唯一执行 port。源码 caller/owner
closure 已切到唯一 App/Host/Builtin seams；RM-16 final Gate 与完成证据已经闭合，不能形成第二 schema/effects/grant authority；
dynamic MCP 的 binding/catalogRevision 与 Builtin projection revision 也必须保持独立。

当前 authority trust model 与真实 serialization/process boundary 以 `runtime-authority-boundary.md` 为准。
同进程 typed grant 使用 exact identity、single-use、expiry/revoke 与 structural binding digest；Store/Artifact
使用 strict codec/checksum，child process 使用 OS channel/control frame。内部 Runtime 不使用 secret key/HMAC authenticity。

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

> **兼容说明**：`RuntimeState.authorization.commandGrants` 直接使用 `ToolGrant`，当前写入要求 `source` 与 `grantedAt`，并与 `ThreadAuthorizationState` 对齐。历史同 epoch grant 可能缺少这两个字段；恢复只沿既有授权匹配字段读取，不把缺失值补写成伪造事实。所有新 grant 必须同时填充 `source` 与 `grantedAt`。

## 硬规则（Agent Kernel authorization domain）

`packages/agent-kernel/src/authorization.ts` 是 `assertAuthorizationElevation()` 的唯一生产实现，输入只包含
canonical authorization facts；App CLI/Runtime 通过 package barrel 接线，不复制 authorization decision。Agent Kernel 的纯 Tool Governance
也复用同一个 invariant，不得维护第二份 full-access/source 检查。

在 `assertAuthorizationElevation()` 中强制执行：

1. full_access 需要 Full-qualified sandbox — mode === full_access 且 Full capability 不可用时拒绝；
2. auto-review 不能授予 full_access — source === system 且 autoReview 时拒绝；
3. loop-mode 不能自动提升授权 — source === system 且 loopMode 时拒绝。

TUI 的 permissions 选择使用同一不变量：由 sandboxSupportsFullMode() 而不是单纯的
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
普通调用的 `approve_once`、`same_command` 或显式 Full 会为具有 `externalRead`、`externalWrite` 或
`uncertainEffects` 的 Shell invocation 投影单次 `filesystemMode=allow_all`；显式敏感 identity 与无法证明
文件目标的 `uncertainEffects` 另带 `sensitiveExternalAccess`，作为模式路由和 reviewer 的结构化风险事实。Full
直接授权，Auto 交给模型选择批准、拒绝或请求用户审批，其他模式请求真人 exact approval。可用 native backend 仍只在命令
启动前扩大文件系统 scope；若 native Provider 在 dispatch 前 unavailable 且 abandonment/cleanup 已确认，
ADR-0119 允许 App 改用一次 host Shell。命令一旦可能启动就不再切换或 replay。按 ADR-0132，Workspace 外
固定凭据、持久化和关键系统 identity 由 `effects.sensitiveExternalAccess` 分类；按 ADR-0133 使用上述模式感知授权。授权后 Seatbelt、bubblewrap 与 Windows
runner 不得再次安装 protected-path deny。canonical Workspace member 不得因名称被拒绝。production
consumer 仍必须服从 sealed capability admission。
新配置和新 TUI 会话默认 `interactionMode=auto`，使待审查命令优先进入模型 reviewer。项目配置可提供
尚无个人选择时的初始 mode；用户在 `/permissions` 选择器确认的 mode 同时写入用户级
`~/.kite-code/kite-code.jsonc`，在后续启动中优先于项目默认。配置写入失败不回滚当前会话的 live mode，
但 TUI 必须明确提示未保存。持久化 session mode 与运行中 `/permissions` 选择保持权威；内部调用若遗漏显式 mode 仍 fail-safe 使用
`accept_edits`，不能从产品默认值推导更宽授权。
恢复已有 session 后开始新 turn 前，SessionRuntime 必须比较个人/会话 preference 与已恢复 Kernel State 的
`mode`；两者不一致时先持久化并确认 `interaction_mode.changed(source=user)`，再允许 Tool Governance 或
Subagent dispatch。只更新 TUI Footer 或 `RuntimeSessionCoordinator` identity 不构成 mode 变更，否则会出现
Footer 显示 Auto 而 parent/child 实际按旧 `accept_edits` 请求人工审批的分裂状态。Full 的恢复同步必须在
本轮 sandbox backend 已确认支持 Full 之后进行，仍不得绕过 Full admission invariant。

## 受信任 Workspace 边界

ADR-0118 把内建文件工具与进程执行授权分开。普通 Workspace 外读取进入 observe-only `external_read` scope；
按 ADR-0132/ADR-0133，`read_file` 直接访问敏感外部 identity，或任何无法预先证明遍历范围的外部 recursive
search 时必须完成模式感知授权：Full 直接授权、Auto 三态审查、其他模式 exact approval。授权后仍使用 sealed
read scope，Provider 不再按 protected name 二次拒绝。
当前 Workspace 的物理位置不影响信任，文件工具可直接读写其中 `.git`、`.env`、`.ssh`、`.codex`、
`.agents` 等名称。Building 阶段的 `accept_edits` 直接放行 Workspace 内 mutation；Workspace 外
`write_file`/`edit_file` 按 ADR-0135 进入模式路由：Full 直接授权、Auto 三态审查、Accept Edits 请求 exact
invocation approval；批准后形成 `approved_external`，文件名与宿主祖先不得再二次拒绝。canonical/no-follow
identity、read-before-edit、preimage/stale、single-use commit、取消、大小/编码与真实 OS failure 仍由
Provider 执行。

ADR-0136 取消 ADR-0134/ADR-0135 在 raw Shell 授权层建立的固定命令和 Git subcommand 白名单。Building
阶段的每个 `shell_execute` 都产生结构化 `ask`，不再因 `ls`、只读 grammar、Workspace-only target、
`git status --short`、`git log --oneline -10` 或已知 local Git builtin 直接 `allow`。Accept Edits 请求用户批准
exact invocation；Auto 先由模型 reviewer 批准、拒绝或升级用户；Full 对允许 bypass 的 invocation 直接授权。
显式 same-command grant 仍可复用 exact command，但固定 grammar 不再生成授权。未知命令也不会仅因不在列表而
hard deny。

Planning 拒绝全部 Shell；空命令、关键系统递归删除和针对关键系统 repository 的 destructive Git 继续 hard
deny，任何 mode 都不能覆盖。`isReadOnlyShellCommand` 等 classifier 只可用于批准后的 hardened environment、
只读 Subagent role ceiling 或 scheduler metadata，不得改变 Policy decision 或跳过 mode review。typed
`git_inspect` 仍是独立结构化 capability，raw Git token 不产生 hard deny、强制 capability routing或免审资格。

RM-12 只迁移该链路的物理 owner，不改变上述授权：五个文件 Builtin catalog entry 与 `git_inspect` 已移除旧的
`execute/projectResult`，唯一 Builtin Runtime executor 只能消费 Tool Pipeline 在 exact invocation 完成 Policy、
approval、protected-path 与 durable attempt acknowledgement 后注入的 filesystem/Git mechanism。缺少 Host
execution port、binding 不一致或 mechanism 缺失均 fail closed，不回到旧 handler；当前使用 Runtime State、SQLite Store 与 epoch
`kite-runtime-modularization-v1-2026-08-19`。

RM-14 同样只迁移 Plan/Task/Subagent/Verification 的物理 owner，不改变授权结果。App 的
`read_plan/update_plan/write_plan/task` adapter 已禁止 concrete executor/result owner，唯一 Builtin executor 只能消费
Tool Pipeline 在 phase、Policy、approval、capability attempt acknowledgement 与现有 Subagent sealed grant 后注入的
Plan/child mechanism。Builtin Subagent role ceiling 可收紧 allowed tool 与 Shell command shape，不能签发用户批准、
提升 phase/workspace access 或绕过 parent authorization。`ask_user` 仍是 Kernel-owned interrupt；Builtin module 的
同名 operation 不形成 execution 旁路。缺少 mechanism、binding 或 grant 均 fail closed，没有旧 handler fallback。

ADR-0131 把同一 identity 规则扩展到 Shell、MCP executable/cwd 与原生 sandbox：canonical Workspace
内 read/write/execute 不得因 `.git`、`.env`、Agent/MCP 配置、credential-looking 名称或 additional deny
二次拒绝。typed Git 与 Skill reference 仍有独立 schema、repository/reference integrity 和 capability
routing；它们不构成 Workspace 名称级 deny。下文的 `externalRead`/`filesystemMode=allow_all` 只描述
Shell invocation；Workspace 外 destructive、提权、关键系统删除、credential/persistence 等极高风险进程
操作仍可在审批前 fail closed。

## MCP Tool 策略边界

MCP descriptor 的 `minimumApproval` 不能单独把 unknown/write/destructive effect 变成无审批调用。只有 effective effects 全部为 `none|read` 且 `minimumApproval: none` 时，Approval Policy 才把它当作只读；`minimumApproval: user` 始终要求单次用户批准。远端 annotation 不直接进入该判断，project 配置也不能降低 minimum approval 或 effect 风险。Tool filter 只决定 catalog 可见性，不产生 authorization grant。

## Shell 逐项审批与重叠执行

Shell 文件系统授权也按 invocation 投影。默认 `workspace_only` 继续由 macOS Seatbelt、Linux
bubblewrap 或 Windows restricted-token 执行；Building 阶段可证明只作用于 Workspace 的 direct command 由
Policy 直接放行。工作区外读写和无法静态限定路径的命令必须完成当前模式授权，批准后以 `allow_all` 投影到
三个平台各自的 native sandbox 执行一次。临时目录、缓存目录与普通
外部文件属于可批准操作，不得再被 native Workspace ceiling 二次拒绝。Auto 模式先由自动审批模型
判断：安全则自动产生单次 grant，明确不安全则拒绝，意图或授权不足则请求真人审批；模型异常、无效响应或
circuit breaker 同样转真人审批。Workspace 外凭据、Shell/Agent/IDE 配置、Git hook/config、启动项和关键
系统文件使用 `sensitiveExternalAccess` 参与该模式路由：Full 直接授权，Auto 三态审查，其他模式请求 exact
approval；显式敏感 identity 不允许 same-command 静默复用。明确的关键系统递归删除仍硬拒绝；普通外部
目标可在 Full 或审批后执行。未经授权不 dispatch，因此不会出现用户
先批准再收到 Kite protected-path denial。命令本身、宿主 ACL/TCC、磁盘或目标状态仍可正常
返回执行失败；“批准后可执行”不伪造命令成功。

Shell 网络授权按 invocation 投影。精确的 `node|npm|pnpm|yarn|bun --version|-v` 与其他可证明本地
命令在未获授权时使用 network-disabled，不因 executable 名称本身触发网络审批；明确网络命令及无法证明
local-only 的 arbitrary script 使用 `effects.network` 或 `uncertainEffects` 进入现有审批；无法证明文件目标的
arbitrary script 同时投影 `sensitiveExternalAccess`；Full 可直接授权，Auto 由模型三态裁决，其他模式请求
真人审批，exact same-command grant 可按编译策略复用。
用户一旦对该 exact invocation 授予 `approve_once`，本次 Shell 默认产生 development `allow_all`；
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

Subagent 内部工具触发审批时存在两个合法身份：持久化 interaction 由 parent `task` Tool Call 拥有，approval payload 的 `callId` 仍可指向真正被审批的 child Tool Call。TUI 必须以 RuntimeEvent 的 parent `toolCallId` 跟踪和关闭 Footer interrupt，不能拿 child payload `callId` 与 `approval.granted`/`approval.rejected` 的 parent id 比较；child id 继续留在 continuation 中用于精确恢复。持久事件可在并发 sibling 收敛前先到达 Footer；此时批准 Enter 必须按 exact interaction id 暂存，并在 Runtime 建立 action waiter 后立即消费。Esc/Ctrl+C 是整个执行授权屏障的即时取消：即使 waiter 尚未建立，也必须持久化 exact `approval.rejected`、取消所有未完成 sibling、保留已完成 child 终态并写入 `turn.aborted(cause=user)`，不得等待并发 child 先行收敛。每个新的 canonical interaction 必须重置审批面板的选中项与原始输入缓冲，不得继承上一个 deferred sibling 的局部 UI state。`approve_once`、`same_command` 和拒绝/取消都遵循同一身份与关闭规则。

auto-review 的 Model/Prompt/response parsing 属于 Builtin reviewer；是否接受 reviewer 结果则由
`@kite/agent-kernel#decideAutoReview` 对 JSON-safe facts 纯确定性裁决。`approve` 只有在 `ok=true`、
`approved=true` 且 grant 为 operation-bound 的 `approve_once` 或 `same_command` 时才能接受；`reject` 产生终态
auto-review rejection；`ask_user` 产生 `requiresUserApproval` 并升级真人审批。`full_access`、技术失败、未知字段、
矛盾 failure facts 或缺失 grant 也必须请求人工审批。Kernel 不生成 UUID、时间或事件；Runtime State adapter
只为 Kernel 的 `request_user_approval` 决策补 interaction identity 并投影现有事件，App 不能重写一份升级规则。
Builtin reviewer 的当前响应协议使用 `decision=approve|reject|ask_user`。迁移期只兼容旧
`approved: true|false`：`true` 映射 `approve`，`false` 保守映射 `ask_user`，绝不把旧布尔否定解释成终态
`reject`。未知字段、非法 risk assessment，以及 `decision` 与 `approved` 相互矛盾的响应统一作为
`invalid_response` 升级真人审批。
Builtin package 的公开 Model API 不暴露可自行注入 Gateway 的 reviewer 函数；production 只能调用 App 注入的
`BuiltinModelEffectCoordinator`。Coordinator 依据已解析 reviewer 配置创建模型并复用其构造时绑定的唯一 Gateway，
App 不创建第二 reviewer model，也不存在 direct helper、第二 Gateway 或 Provider-denial fallback。

审批载荷只有 Protocol `ToolApprovalPayload` 一份 JSON-safe 定义；Policy、Controller、Executor 与 App
直接共用该类型。不得再声明同义 approval DTO，也不得通过类型强转连接分叉字段。
`summary` 只是 App 审批界面的有界展示标签，不属于 Kernel policy fact、approval binding 或 authorization
identity；Shell 的完整命令只保存在载荷的 `command` 字段。命令长度和展示文案变化不得改变 Kernel
授权结论，也不得使 otherwise valid 的治理事实失效。

Shell 重叠范围只限同一 `modelMessageId` 和同一任务的连续 sibling；遇到非 Shell 调用、不同模型消息、不同任务、`ask_user` 或方案审核时，Runner 必须等待已启动 Shell 收敛，不能跨过交互和副作用边界。`approval.rejected` 必须携带对应 `toolCallId`。用户显式拒绝或取消任一工具审批时，当前审批目标记为 rejected，其余运行中或 queued sibling 记为 cancelled，Runtime 写入 `turn.aborted(cause=user)` 后立即结束当前 turn；不再请求后续审批、执行其他工具或调用模型，已启动执行通过 AbortSignal 停止。TUI 清除未开始 sibling 的 queued术语（排队中）临时元数据和审批中断；审批目标本身即使尚未 `tool.started`，也必须在消息列表物化为带拒绝原因的 error 工具卡，避免用户取消后调用记录消失。其余未开始 sibling 不生成取消卡；只有实际收到 `tool.started` 的 sibling 才进入消息列表并按 cancelled 终态收尾。策略拒绝、sandbox 缺失和系统审查失败不是用户取消，但审批目标仍保留对应终态记录。`approve_once`、`same_command` 与 `full_access` 的授权范围和溯源规则保持不变，一个调用的单次授权不会扩散给其他命令。当前事件集合不包含 `tool.execution_ready`；未知或退役的持久事件在 reducer 前作为 corruption 拒绝。

## 入口覆盖

| 入口                    | source 值  | 位置                                             |
| ----------------------- | ---------- | ------------------------------------------------ |
| CLI `--full-access`     | `'config'` | `apps/kite/src/cli/index.ts:121`                 |
| TUI 权限选择器确认 Full | `'user'`   | `apps/kite/src/runtime/session/runtime-session.ts` |
| 测试注入                | `'test'`   | `tests/policies/authorization-elevation.test.ts` |
| System (禁止)           | `'system'` | `packages/agent-kernel/src/authorization.ts`     |

TUI 入口通过 `apps/kite/src/runtime/session/runtime-session.ts` 的 `buildRunAgentParams` →
`RuntimeSessionCoordinator` 传递 `authorizationMode`；`full` interaction mode 对应 `'full_access'` authorization mode。
Kernel 初始化时若恢复的 Runtime State snapshot 携带 `mode` 或 `authorization.mode`，当前选择器确认值覆盖恢复态，
并在新轮次立即生效。production transition decision 由 `@kite/agent-kernel` 拥有，App coordinator 不复制该 decision。

当 Runtime 正在回复时，`/permissions` 的选择同样必须立即生效：`SessionRuntime` 通过 live
Kernel control 持久化 `interaction_mode.changed`。事件只能来自显式用户选择，并带 `source: user` 与
时间戳；Kernel 在持久化前对 `full` 复用 `assertAuthorizationElevation()`，只有 Full-qualified sandbox
才允许提升。reducer 在同一状态转换中更新 `mode`、对应的 authorization mode 及其 provenance，并清除
当前 Task 的临时 `executionMode` 覆盖；降级会清除 mode-level provenance，已批准计划本身仍保留其历史
展示选择。事件推进 revision，已在旧 mode 下启动但尚未提交的 effect 不能再提交结果，后续调度按新 mode
重新计算。该路径不直接改写 RuntimeState，也不依赖 TUI ref 的下一次渲染。

Subagent 工具面与执行策略以父 Runtime 当前 live `interactionMode` 为输入，不从模型参数或可能过期的 task config 推导。唯一的模式特化是同一模型响应中存在多个结构化 `task(subagent_type=explore)` sibling 时，该批并发 Explore child 在父级 `accept_edits` 下使用 `auto`；单个 Explore 以及 Plan/Code/Review child 继续继承父模式。父级 `auto` 仍为 `auto`，父级 `full` 仍为 `full`，不能降级或扩大。子 Agent 因审批挂起后，恢复时必须用相同的 parent Tool Call、model message 和 sibling 结构重新推导，不能依赖展示组或任务正文；挂起期间的 `/permissions` 变化仍是权威。内部调用若无法证明该结构，只能继承父 live mode，不得猜测为 Auto 或 Full。
Subagent model invocation 产生的 child Tool Call 虽写入共享 durable journal，但不属于 parent Scheduler 的
runnable queue；只有持有该 child identity 的 parent Task continuation 可以批准、dispatch 和消费它。并发 sibling
deferred 时，Scheduler 必须先重新呈现/恢复 parent task，不能因 child `tool.queued` 排在 parent 前面就独立执行，
否则 parent continuation 会在审批后观察到已消费的 child identity 并 fail closed。
一个 resumed child 再次阻塞时，若队列里已有更早的 suspended sibling，新的人工或自动审查请求必须先降为
`subagent.approval_deferred` 并排到旧 sibling 之后；同一长任务不得依靠连续阻塞反复抢占唯一 interaction slot。

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
> 路径同步：Host state adapter 已使用无版本文件名，Runtime State 仅作为当前持久格式 metadata 名称。
