# 授权溯源 / Authorization Traceability

状态：active
读取时机：修改授权逻辑、安全审计、CLI/TUI 授权入口变更时
验证：`bun test packages/agent-kernel/test packages/builtin-runtime/test packages/runtime-host/test tests/runtime tests/policies`

相关：ADR-0118、ADR-0119、ADR-0131、ADR-0132、ADR-0133、ADR-0137、ADR-0138、
`tool-gated-autonomy.md`、`cancel-resume-cleanup.md`、`plan-mode-implementation.md`。

## 概述

Runtime Kernel 的授权系统以 State 27/SAQ epoch 的 live `interactionMode=accept_edits|auto|full`、phase、编译后的
policy facts、sealed sandbox scope 与 durable queue facts 为准。`interactionMode=full` 是唯一 Full authority；旧
`authorization.mode`/Full grant 只作为不可执行历史事实，不得在 restore、fork 或 mode change 中复活。

Builtin catalog 只声明 operation 的 schema、availability、effects、traits 与 minimum approval；它不签发用户
授权。Kernel/Runtime policy 依据 canonical facts 作 governance/admission decision，Host 只验证同一 frozen
registry snapshot 对应的 execution identity，App/Controller 只能把已批准的 grant 注入唯一执行 port。源码 caller/owner
closure 已切到唯一 App/Host/Builtin seams；RM-16 final Gate 与完成证据已经闭合，不能形成第二 schema/effects/grant authority；
dynamic MCP 的 binding/catalogRevision 与 Builtin projection revision 也必须保持独立。

当前 authority trust model 与真实 serialization/process boundary 以 `runtime-authority-boundary.md` 为准。
同进程 typed grant 使用 exact identity、single-use、expiry/revoke 与 structural binding digest；Store/Artifact
使用 strict codec/checksum，child process 使用 OS channel/control frame。内部 Runtime 不使用 secret key/HMAC authenticity。

## Control source（非 grant authority）

Mode changes and approval facts carry a bounded source for audit projection:

```ts
type ControlSource = "user" | "config" | "test" | "system";
```

`user` is the only source that can request a live permissions change or focused approval. `config` selects
the initial `interactionMode`; `test` is test-fixture metadata; `system` may record an auto-review decision but
cannot sign a user grant. Source is not an authorization mode and cannot add a second Full authority.

## 数据结构

`SessionCommandGrant` is the only live session grant record. It is keyed by the complete session command
identity (session/thread, canonical workspace, cwd, exact trimmed command digest, shell/executor identity,
execution environment, sealed sandbox scope, effects, and parser/executor/policy revision). Description,
timeout and subagent id are deliberately not part of the match key. Each released invocation additionally
has its own receipt, generation and attempt identity; an old `ToolGrant`-style workspace/thread/command
record is historical inert data and cannot authorize execution.

### SessionApprovalState — Session 级审批事实

```ts
interface SessionApprovalState {
  interactionMode: "accept_edits" | "auto" | "full";
  interactionModeRevision: number;
  pendingApprovals: Map<string, PendingApproval>;
  activeApprovalId: string | null;
  sessionCommandGrants: Map<string, SessionCommandGrant>;
  approvalReceipts: Map<string, ApprovalReceipt>;
}
```

`PendingApproval` 保存 parent/child/runtime identity、原始 route、binding digest、scope/effects、sequence、generation、createdAt
和状态。ADR-0138 的已知历史 profile 会把旧 grant/review/event 只读投影为 inert history；未知 profile 静默忽略。
当前格式中的未知字段、缺 identity 或 Full grant 仍使该单个会话 fail closed，不能影响其他会话或恢复 live authority。

## 硬规则（Agent Kernel authorization domain）

`packages/agent-kernel/src/core/authorization/` 与 Tool Governance 是唯一生产决策 owner，输入只包含 canonical facts；App、TUI、
Builtin 和 Host 不复制授权 decision。硬规则包括：Full 只从 `interactionMode=full` 派生；Auto reviewer 只能产生
`approve_once|reject|ask_user`；approval grant 只能是 `approve_once|same_command`；hard deny、schema、binding、phase、policy
revision 和 sandbox capability 任何一项失败都 fail closed。

TUI 的 permissions 选择使用同一 interactionMode contract。Full 选项不因 workspace sandbox availability 被降级为审批，也不
写入第二个授权字段；实际 execution backend 若 unsupported 则在 dispatch/admission 处明确 fail closed。Windows
`windows_restricted_token`、macOS/Linux candidate 与 Full UI 选择是独立维度，development Full 不等于 production qualification。

host Shell 只在用户脚本前的 sandbox environment/essential startup capability unavailable，或 Runtime 已持久化
attempt/preparation intent 后得到 typed `backend_unavailable + pre_dispatch + cleanupConfirmed` 时选择。它要求
完整 Runtime invocation identity/lifecycle；已启动、取消、超时或 cleanup unknown 的 native 调用绝不重放。

`/permissions` 无参数打开 selector；确认后持久化用户默认和当前 Session 的 `interaction_mode.changed`。清除 Session grants
使用 canonical `session_grants_cleared(sessionId, sessionRevision, generation)`，不改变 mode。该事件先提升 Session 的
approval generation：仍由 `same_command` 保持 `authorized_queued` 且尚未 dispatch 的调用恢复为原 route 的等待状态，所有仍可交互的
queue record 同步重绑到新 generation 后才重新暴露人工焦点；已 running 或由独立 receipt 授权的调用不被撤销。Kernel 与 TUI 必须从
同一 durable event 得到相同投影，旧 generation 的 Enter/Esc 继续 no-op，不能留下永远无法解决的旧焦点。受限 backend unavailable 时可以
报告 unsupported/fail closed，但不得把 Full 降级为审批 grant；Full 只由 interactionMode 表达。扩 scope 的 exact invocation
按 phase/mode 进入 direct、Auto reviewer 或 user approval；native denial 不切换 host、不 replay。Workspace 内 hidden names 与
`.git` 不触发 basename deny，hard deny 与 Host-control 隔离继续有效。
新配置和新 TUI 会话默认 `interactionMode=auto`，使待审查命令优先进入模型 reviewer。项目配置可提供
尚无个人选择时的初始 mode；用户在 `/permissions` 选择器确认的 mode 同时写入用户级
`~/.kite-code/kite-code.jsonc`，在后续启动中优先于项目默认。配置写入失败不回滚当前会话的 live mode，
但 TUI 必须明确提示未保存。持久化 session mode 与运行中 `/permissions` 选择保持权威；内部调用若遗漏显式 mode 仍 fail-safe 使用
`accept_edits`，不能从产品默认值推导更宽授权。
恢复已有 session 后开始新 turn 前，SessionRuntime 必须比较个人/会话 preference 与已恢复 Kernel State 的
`mode`；两者不一致时先持久化并确认 `interaction_mode.changed(source=user)`，再允许 Tool Governance 或
Subagent dispatch。只更新 TUI Footer 或 `RuntimeSessionCoordinator` identity 不构成 mode 变更，否则会出现
Footer 显示 Auto 而 parent/child 实际按旧 `accept_edits` 请求人工审批的分裂状态。Full 的恢复同步只需
确认 live `interactionMode=full` 与 policy facts；受限 mode 的 dispatch 才依赖 sandbox backend capability。
backend 不可用时受限执行 clean fail closed，不影响 Full mode 的持久化或 Plan lifecycle，也不得绕过 policy invariant。

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

ADR-0160部分替代ADR-0137的未知Shell结论，同时保留其phase、sandbox与durable queue：可证明只读命令按phase baseline
direct；Building中效果已知的Workspace mutation继续按当前mode治理；无法证明只读且无法完整确定effects的命令（包括
`bun test`与任意project script）固定进入exact真人审批，Auto/Full不绕过。命令不因不在列表而hard deny；只有Compiler
明确`allowed=false`的关键系统规则不可覆盖。显式same-command grant只按完整Session identity匹配。

Planning 非 Full 使用 Workspace read-only baseline 直接运行已知可承载的 Shell；已知扩 scope 按 Accept/Auto 路由审批。Planning
Full 直接执行并保持 Plan lifecycle。空命令、关键系统递归删除和针对关键系统 repository 的 destructive Git 继续 hard
deny，任何 mode 都不能覆盖。`isReadOnlyShellCommand`同时拥有可证明只读的免审事实、hardened environment、只读
Subagent role ceiling与scheduler metadata；未命中只能生成`uncertainEffects`真人审批，不能生成destructive deny。
`git_inspect`只保留为internal Runtime capability，所有模型Git/脚本命令统一通过`shell_execute`。

ADR-0161把只读证明收敛到Builtin-owned、冻结的v1 Shell semantics registry；registry digest必须进入
`shell_execute` capability revision，语义升级不能复用旧binding。普通只读program由descriptor声明，参数敏感program
由descriptor选择局部inspector；未注册或未命中只生成低基数本地诊断，不产生allow，也不进入远程telemetry。

RM-12 只迁移该链路的物理 owner，不改变上述授权：五个文件 Builtin catalog entry 与 `git_inspect` 已移除旧的
`execute/projectResult`，唯一 Builtin Runtime executor 只能消费 Tool Pipeline 在 exact invocation 完成 Policy、
approval、protected-path 与 durable attempt acknowledgement 后注入的 filesystem/Git mechanism。缺少 Host
execution port、binding 不一致或 mechanism 缺失均 fail closed，不回到旧 handler；当前使用 State 27/SAQ epoch 的
Runtime State 与 SQLite Store。`kite-runtime-modularization-v1-2026-08-19` 仅是 RM-12 的历史迁移标识，不是当前授权格式。

RM-14 同样只迁移 Plan/Task/Subagent/Verification 的物理 owner，不改变授权结果；以下 owner 说明属于历史迁移背景，
当前 queue/approval contract 以 State 27/SAQ epoch 为准。App 的
`read_plan/update_plan/write_plan/task` adapter 已禁止 concrete executor/result owner，唯一 Builtin executor 只能消费
Tool Pipeline 在 phase、Policy、approval、capability attempt acknowledgement 与现有 Subagent sealed grant 后注入的
Plan/child mechanism。Builtin Subagent role ceiling 可收紧 allowed tool 与 Shell command shape，不能签发用户批准、
提升 phase/workspace access 或绕过 parent authorization。`ask_user` 仍是 Kernel-owned interrupt；Builtin module 的
同名 operation 不形成 execution 旁路。缺少 mechanism、binding 或 grant 均 fail closed，没有旧 handler fallback。

ADR-0131 把同一 identity 规则扩展到 Shell、MCP executable/cwd 与原生 sandbox：canonical Workspace
内 read/write/execute 不得因 `.git`、`.env`、Agent/MCP 配置、credential-looking 名称或 additional deny
二次拒绝。internal typed Git broker与Skill reference仍有独立schema、repository/reference integrity和capability
routing；internal broker不进入模型ToolSet，也不构成Workspace名称级deny。下文的`externalRead`/sealed
`filesystem=full_access` scope 只描述
Shell invocation；Workspace 外 destructive、提权、关键系统删除、credential/persistence 等极高风险进程
操作仍可在审批前 fail closed。

## MCP Tool 策略边界

MCP descriptor 的 `minimumApproval` 不能单独把 unknown/write/destructive effect 变成无审批调用。只有 effective effects 全部为 `none|read` 且 `minimumApproval: none` 时，Approval Policy 才把它当作只读；`minimumApproval: user` 始终要求单次用户批准。远端 annotation 不直接进入该判断，project 配置也不能降低 minimum approval 或 effect 风险。Tool filter 只决定 catalog 可见性，不产生 authorization grant。

## Shell 逐项审批与重叠执行

Shell 文件系统授权也按 invocation 投影。默认 `workspace_only` 继续由 macOS Seatbelt、Linux
bubblewrap 或 Windows restricted-token 执行；Building 阶段可证明只作用于 Workspace 的 direct command 由
Policy 直接放行。工作区外读写和无法静态限定路径的命令必须完成当前模式授权，批准后以与 UI 一致的 sealed scope 投影到
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
命令在未获授权时使用 network-disabled，不因 executable 名称本身触发网络审批；明确网络命令进入scope审批，无法证明
local-only或无法完整确定effects的arbitrary script使用`uncertainEffects`固定请求exact真人审批。该审批在
Accept Edits、Auto与Full中都不由reviewer或mode绕过，并保持编译的sealed sandbox scope；只有明确外部/网络facts才能
请求对应扩scope。exact same-command grant仍按编译策略与完整identity复用。
按ADR-0162，uncertain Shell不提供额外的只读试跑选项，只使用正常的`approve_once`、符合条件的
`same_command`与拒绝；不得把classifier或Sandbox实现差异暴露为新的用户决策。
用户一旦对该 exact invocation 授予 `approve_once`，本次 Shell 只获得该 invocation 的 sealed scope；
静态 effects 只决定审批文案与 filesystem scope，不能在批准后再次把该调用强制改成 network-disabled。
拒绝则命令不启动；不能兑现 governed network 的 sealed production consumer 必须在审批前拒绝。
development prepared consumer 也不得把已批准的 `network=allow_all` 重新解释为 production host allowlist；
它必须在继续核验 exact grant/identity/lifecycle 的同时执行该 unrestricted scope，而 production allowlist
qualification 仍由独立 boundary/evidence gate 决定。
macOS/Linux native sandbox 消费该模式；Windows protocol V6 对已批准的
`filesystem=full_access, network=allow_all` sealed scope 使用当前登录用户 token
运行该 exact command，并保留当前用户 profile 的 Schannel 路径。它不创建本地账户、不请求 UAC，也不依赖
持久 credential state。未获网络授权的 Windows 调用继续使用 restricted token。由于 Schannel 不能在该
restricted primary token 下取得凭据，Windows 已批准联网调用不再声称 restricted-token filesystem ceiling；
Job Object 仍限制进程树。该 development authorization 不构成结构性 network-off evidence，不能提升 Full 或
production qualification。

`curl -w/--write-out` 中的安全 `%{name}` 状态占位符仅是 curl 输出模板，不是 Shell 控制语法；它不应把
本来只访问网络、或写到 `/dev/null` 的健康检查升级为 `uncertainEffects`。模板中其余 Shell
元字符、未知命令组合或实际工作区外读写仍按保守规则要求相应 filesystem scope。

同一条模型消息产生多个连续的 `shell_execute` 调用时，每个调用独立完成参数解析、策略预检和 durable queue admission。某一调用
获批后进入 `authorized_queued`，不等待 sibling 共同收敛，也不跳过 Scheduler concurrency；每个 invocation 有独立 receipt/attempt。
TUI 同一时刻只显示 `activeApprovalId` 对应且可见的人工请求，后台 auto-review 或 off-screen request 不夺取 Footer；解决后一个
审批时不得重置已经运行的 sibling Shell 的 `startedAt` 或累计耗时。
`approval.batch_released` 的 `cancelledReviewIds` 只终止仍未匹配、未运行且未终态的 auto-review record；同一 interaction 已在
`matches` 中获得独立 receipt 时，即使 reviewer id 同时出现在取消列表，Kernel 与 TUI 都必须保留其 `authorized_queued` 结果，不能由
后处理取消覆盖原子 batch 的授权事实。

Subagent 内部工具触发审批时，持久化 interaction 由 parent `task` Tool Call 拥有，child/runtime id 保存在 continuation 与
approval facts 中用于精确恢复。只有同一 model message/turn 中并发的多个 Explore children 在非 Full parent 下派生 Auto；single
Explore、plan/code/review 继承 parent。Enter 必须绑定 exact interactionId+generation；Esc 在 Approval overlay 只 reject focused
request，Ctrl+C 才提交 whole-turn cancel。每个新的 canonical interaction 必须重置审批面板焦点与输入缓冲；TUI 不能依赖 private
deferred slot 或 local acknowledgment。

auto-review 的 Model/Prompt/response parsing 属于 Builtin reviewer；是否接受 reviewer 结果则由
`@kite-ai/agent-kernel#decideAutoReview` 对 JSON-safe facts 纯确定性裁决。reviewer 只接受 operation-bound 的
`approve_once|reject|ask_user`，不得签发 `same_command` 或 Full；技术失败、未知字段、矛盾 failure facts 或缺失 grant
升级真人审批。Kernel 不生成 UUID、时间或事件；Runtime State adapter
只为 Kernel 的 `request_user_approval` 决策补 interaction identity 并投影现有事件，App 不能重写一份升级规则。
Builtin reviewer 的当前响应协议只接受 `decision=approve_once|reject|ask_user`，且结果必须绑定当前
queue generation 与 invocation facts。旧 `decision=approve`、`approved` 布尔、`grant`/`approval` 对象、
`same_command` 或 `full_access` 均直接 `invalid_response` 并升级真人审批；不得用 compatibility alias
或把旧 shape 映射成新的 grant。未知字段、非法 risk assessment 及 identity/binding 不完整同样 fail closed。
Builtin package 的公开 Model API 不暴露可自行注入 Gateway 的 reviewer 函数；production 只能调用 App 注入的
`BuiltinModelEffectCoordinator`。Coordinator 依据已解析 reviewer 配置创建模型并复用其构造时绑定的唯一 Gateway，
App 不创建第二 reviewer model，也不存在 direct helper、第二 Gateway 或 Provider-denial fallback。

审批载荷只有 Protocol `ToolApprovalPayload` 一份 JSON-safe 定义；Policy、Controller、Executor 与 App
直接共用该类型。不得再声明同义 approval DTO，也不得通过类型强转连接分叉字段。
`summary` 只是 App 审批界面的有界展示标签，不属于 Kernel policy fact、approval binding 或 authorization
identity；Shell 的完整命令只保存在载荷的 `command` 字段。命令长度和展示文案变化不得改变 Kernel
授权结论，也不得使 otherwise valid 的治理事实失效。

Shell 重叠范围只限同一 `modelMessageId` 和同一任务的连续 sibling；遇到非 Shell 调用、不同模型消息、不同任务、`ask_user` 或方案审核时，Runner 必须等待已启动 Shell 收敛，不能跨过交互和副作用边界。`approval.rejected` 必须携带对应 `toolCallId`。Approval overlay 的用户 Esc 只将 focused target 记为 rejected 并推进焦点；不相关 sibling 保持排队。Ctrl+C 才将当前 turn 的 queued/awaiting/authorized/running sibling 记为 cancelled，写入 `turn.aborted(cause=user)` 并停止已启动执行。策略拒绝、sandbox 缺失和系统审查失败不是用户取消，但审批目标仍保留对应终态记录。`approve_once` 与 `same_command` 的授权范围和溯源规则保持不变，一个调用的单次授权不会扩散给其他命令。当前事件集合不包含 `tool.execution_ready`；State 26 已知历史 journal 中的未知或旧授权 event 只转为无副作用 `runtime.action_ignored`，current journal 的未知 event 仍只使所属会话恢复失败。

## 入口覆盖

| 入口                    | source 值  | 位置                                             |
| ----------------------- | ---------- | ------------------------------------------------ |
| CLI/start configuration mode | `'config'` | App composition / Session mode                |
| TUI 权限选择器确认 Full | `'user'`   | `apps/kite-service/src/runtime/session/runtime-session.ts` |
| 测试注入                | `'test'`   | `packages/runtime-host/test/policies/authorization-elevation.test.ts` |
| System (禁止签发 grant)  | `'system'` | Auto reviewer / Kernel validation              |

TUI 入口通过 `buildRunAgentParams` → `RuntimeSessionCoordinator` 传递 live `interactionMode`；Full 不再映射为第二个
authorization mode。Kernel 在线初始化/restore 只接受 State 27/SAQ epoch 的 mode、queue、grants 与 revision；已知历史会话
必须先经纯迁移清空 queue/grant/receipt/effect 并把旧 Full 降级，未知 source 不进入 Kernel。production transition decision
由 `@kite-ai/agent-kernel` 拥有，App coordinator 不复制该 decision。

当 Runtime 正在回复时，`/permissions` 的选择同样必须立即生效：`SessionRuntime` 通过 live
Kernel control 持久化 `interaction_mode.changed`。事件只能来自显式用户选择，并带 `source: user` 与
时间戳；Kernel 在持久化前按 interactionMode、policy facts 与可兑现 scope 校验。reducer 在同一状态转换中更新
mode/revision，并清除
当前 Task 的临时 `executionMode` 覆盖；降级会使尚未 dispatch 的 prepared grant stale，已批准计划本身仍保留其历史
展示选择。事件推进 revision，已在旧 mode 下启动但尚未提交的 effect 不能再提交结果，后续调度按新 mode
重新计算。该路径不直接改写 RuntimeState，也不依赖 TUI ref 的下一次渲染。

Subagent 工具面与执行策略以父 Runtime 当前 live `interactionMode` 为输入，不从模型参数或可能过期的 task config 推导。唯一的模式特化是同一模型响应中存在多个结构化 `task(subagent_type=explore)` sibling 时，该批并发 Explore child 在父级 `accept_edits` 下使用 `auto`；单个 Explore 以及 Plan/Code/Review child 继续继承父模式。父级 `auto` 仍为 `auto`，父级 `full` 仍为 `full`，不能降级或扩大。子 Agent 因审批挂起后，恢复时必须用相同的 parent Tool Call、model message 和 sibling 结构重新推导，不能依赖展示组或任务正文；挂起期间的 `/permissions` 变化仍是权威。内部调用若无法证明该结构，只能继承父 live mode，不得猜测为 Auto 或 Full。
Subagent model invocation 产生的 child Tool Call 进入 Session durable approval queue；只有持有该 child identity 的 parent Task
continuation 可以批准、dispatch 和消费它。多个 sibling 同时等待时保持各自 queue record、route、generation、sequence 与
binding facts；不再以 private `subagent.approval_deferred`/single slot 覆盖 canonical request。恢复必须使用原 parent/child/runtime
identity，不能 synthetic child request/grant 或让迟到结果抢占当前 focus。

`/permissions` 只接受无参数形式并打开可用模式选择器，确认某一项后才改变 mode；任何附加参数都不
触发模式切换。`full` 选项由 interactionMode 单独表达，即使受限 backend 不可用也不伪造旧 grant；
实际受限 dispatch 在 capability unsupported 时 clean fail closed。
这不会把模式选择伪装成 production capability admission。production execution-status 只可由 CLI
`--execution-status` 查询；它不是 grant，不能扩大 capability surface。

`/rewind` 从恢复点 fork 新 thread 时不继承源 thread 的授权。Fork 必须清除 source-derived queue、active approval、Session
grants、receipts、generation-sensitive waiters、turn-scoped capability binding/disclosure 与 Provider session waiver；新 Session
的 interactionMode 只能由默认/用户显式选择恢复。历史旧 Full/grant 不得复活为 live authority。

## 测试

```bash
bun run --cwd packages/agent-kernel test
bun test packages/runtime-host/test/policies/authorization-elevation.test.ts packages/agent-kernel/test/shell-policy-matrix.test.ts apps/kite-service/test/runtime/actions.test.ts
```

测试覆盖：

- Full 只由 interactionMode 派生且不要求第二个 authorization field
- auto-review 只接受 approve_once/reject/ask_user，same_command/旧 shape fail closed
- Session grant key 的 workspace/cwd/executor/env/scope/effects/revision 任一变化都会失配
- 各 source 值正确传播到 state 和 grant 记录
> 路径同步：Host state adapter 已使用无版本文件名，Runtime State 仅作为当前持久格式 metadata 名称。
