# Kite Code 六概念 Runtime 架构

状态：active

读取时机：修改 Agent loop、Kernel state/event/reducer、Capability、Policy、Execution、Verification、Host lifecycle、Builtin module、SQLite storage 或 App composition 时。

验证：`bun run check:pre-release-architecture`、`bun run check:runtime-packages`、`bun run check:core-boundary`、`bun run typecheck`、`bun test packages/runtime-contract/test packages/runtime-spi/test packages/agent-kernel/test packages/runtime-host/test packages/builtin-runtime/test packages/runtime-storage-sqlite/test`。

相关：[`layer-boundary-enforcement.md`](layer-boundary-enforcement.md)、[`pre-release-architecture.md`](pre-release-architecture.md)、ADR-0128、ADR-0137、ADR-0138。

## 总览

Kite Code 的运行时由 Agent、Runtime Kernel、Capability、Policy、Execution、Verification 六个概念组成。概念不是 workspace 的同义词；workspace 用于强制依赖方向，概念用于定位 authority。

```text
Agent → Capability → Policy → Execution → Verification
  ↑                                           ↓
  └──────────── Runtime Kernel 决定下一步 ────┘
```

| 概念 | 当前 owner | 核心职责 |
| --- | --- | --- |
| Agent | App Session/turn coordinator + Builtin Model Gateway | 从已提交 Runtime 投影构造模型输入，消费模型响应并请求下一步；不直接授权或持久化 |
| Runtime Kernel | `@kite/agent-kernel` | 纯 state transition、静态 reducer、scheduler、completion、recovery 与 invariant |
| Capability | Runtime SPI registry + Builtin domain modules | 定义、发现、披露、绑定、解析与选择唯一 executor |
| Policy | Kernel governance + Builtin effect facts | 基于显式事实决定 allow/deny/approval/admission；不执行副作用 |
| Execution | Runtime Host lifecycle + Builtin concrete mechanisms + App composition | ack 后执行一次，形成 receipt/unknown/terminal，并完成 cleanup |
| Verification | Builtin verifier + Kernel verification domain | 从 Receipt/Artifact/注入 port 形成 evidence，由 Kernel 决定通过、修复、重规划、补偿或 waiver |

## Client Contract 与 SPI

`@kite/runtime-contract` 是 client-facing in-process contract。command、query、notification 与 projection 分别位于独立模块；presentation/capability/observability 只携带中立数据。Contract 不包含 Kernel state、Host lifecycle、Provider handle、SQLite 类型或 TUI block。

`@kite/runtime-spi` 是 provider-neutral compile-time port。capability、execution、model context 与 module lifecycle 分文件定义；filesystem、sandbox、MCP、Subagent、Verification 与 Tool Pipeline 继续使用独立 domain port。SPI 不拥有具体 Builtin schema、Policy decision、Host session 或 App composition。

## Runtime Kernel

Kernel 是唯一 state/event/reducer/scheduler authority：

- 根 `state.ts` 组合 domain state，根 `events.ts` 组合静态 event map；
- reducer 顺序固定，caller 不能注册 reducer 或注入 domain；
- planning、context 与 verification state/event 已进入 `src/domains/`；
- Kernel 不读 clock、random、filesystem、network 或 Provider；Host 必须把 identity、time 与 observed facts 显式投影为 input；
- schema/protocol/format 数字只作为 metadata 值，不作为类型或文件身份。

State 只有一个当前写入 shape。当前 codec 继续读取同一 schema/epoch 内有明确白名单和测试的退休事件字段；ADR-0138 另外允许 exact 已知历史 profile 在选中单个会话后投影为当前 State。迁移只保留安全历史，清空 approval/grant/effect authority；未知格式在发现阶段静默忽略，不猜测、不改写。恢复 Session 时，State 的 Workspace path 与 Project digest 是不可拆分的 retained identity，不能与调用方当前 checkout 路径混合；Coordinator admission 必须先于 Session registry publication。checksum/revision/project/workspace identity 漂移、event tail 非法或 recovery evidence 不完整仍只让所属会话 fail closed。

## Capability、Policy 与 Tool Pipeline

Builtin domain module 在一个冻结的 `RuntimeModuleRegistry` snapshot 中注册 operation、parser、schema、description、availability、effects、traits、policy compiler、provider 与 executor revision。所有 model surface、Tool Pipeline、Host execution port 与 App controller 使用同一 snapshot；不得在 App/Host 重建第二 catalog。

Tool Pipeline 固定经过：

```text
snapshot → resolve → validate → classify → authorize/admit
         → attempt acknowledgement → dispatch → receipt/unknown commit
```

Kernel 拥有 authorization、approval binding、resource admission 与 ToolOutcome decision。Builtin 拥有 parser、effects 与具体机制。Host 拥有 attempt claim、effect lease、generic lifecycle 与 cleanup。App 只组合这些 owner，并将持久阶段映射到 `runtime/tool-persistence/` 的唯一实现。

Filesystem mutation 必须在同一 acknowledged attempt 下提交 intent、mutation-ready、preimage Artifact 与 terminal observation；Subagent suspension 必须提交 parent attempt、private continuation Artifact、blocked Tool identity 与 exact review event。任何 clone、cross-parent、stale revision 或持久失败都在 dispatch/terminal 发布前 fail closed。

## Execution 与 Host lifecycle

Runtime Host 按职责分为 `host/`、`lifecycle/`、`execution/`、`kernel-adapter/`、`format/`、`process/`、`storage/` 与 `observability/`。Host：

- 每 Session 使用 FIFO mailbox、revision conflict 与 scoped idempotency；
- 在 Provider work 前完成 attempt acknowledgement；
- 管理 cancellation、cleanup barrier、effect lease 与 restart recovery；
- 对 durable notification 保留 revision history，对 gap 返回 snapshot；ephemeral stream 使用 monotonic sequence；
- 只翻译 Kernel facts，不解释具体工具结果、Prompt、Skill 或 MCP 业务语义；
- 使用冻结 snapshot 创建一个 capability execution port，不提供 registry-taking alternate factory。

Builtin concrete operation modules位于 `git/model/planning/subagent/verification` 领域目录。Skill、Subagent、Verification 只能从各自 subpath 导入。App Tool router 选择一个 executor；Builtin/MCP/Skill/Subagent executor 不得互相回退。

## Session、Context 与 Model

App Session 代码位于 `apps/kite/src/runtime/session/`：

- `session-registry` 只管理运行时身份；
- `session-lifecycle` 管理列表、加载、删除与命名；
- `rewind-service` 管理 checkpoint preview/fork/restore；
- `planning-mode-service` 只通过 live Kernel control 改变 planning；
- `context-compaction-service` 复用同一 Host control、Model Gateway、effect lease 与 storage ports；
- `session-projection` 形成 Session/TUI 可消费投影。

Context 只有一条 current projection 与 compaction 管线。Manual/auto 使用相同 safe boundary、token estimate、summary validation、checkpoint 与 terminal semantics；不存在旧 estimator、standalone coordinator 或第二 Store writer。Model streaming inactivity timeout 与 structured retry terminal 语义由既有 Gateway 保持，不因模块拆分改变。

Gateway 的 retryable attempt 仍由有界 retry policy 收敛；fatal Provider rejection 不重试。App turn
coordinator 只把 fatal outcome 投影到已有 failure taxonomy，不能将其降级为 `unknown` 或恢复第二套
retry authority。同一 Gateway、同一 route 的并发调用观察到 Provider rate limit 后，后续 retry 必须共享
route-local 退避时隙；不得让 sibling Subagent 以完全相同的指数节奏同时重试并形成惊群。首次调用继续并发，
共享协调只在真实 `provider_rate_limited` observation 后生效，且实际时隙延迟必须写入各 invocation 自己的
`model.retry.delayMs`。

TUI 通过 `apps/kite/src/adapters/tui/session-adapter.ts` 获取 typed client surface。TUI 不接触 Kernel state、Host execution control、Builtin executor 或 SQLite handle。
`runtime-bridge.ts` 将同步的 TUI Session surface 串到异步 Host command authority：每个新建或恢复 Session
先持有自己的 bootstrap readiness promise，后续 turn、compaction、reset、mode、cancel、rewind 与 close
必须等待该 exact Session 的 `create_session` / `resume_session` applied receipt，再读取 committed revision 并
提交命令。空 Session 可以在首个 Runtime event 前没有 transcript，但不能让 follow-up command 抢跑到尚未
建立的 Host authority，也不能因跨 Session 的本地 sequence 排序把命令归给旧 Session。
Ctrl+C 的同步 TUI surface 在返回前先调用真实 SessionRuntime 取消，使 Provider、Shell preparation 与交互 waiter
立即收到本地 AbortSignal；随后仍须通过同一 Host command authority 提交 durable `cancel_turn` 并消费回执。
若 notification 在读取 revision 与 Host admission 之间前移 committed revision，bridge 使用 conflict 回执中的最新
revision 和新 command ID 重试；不可重试的拒绝投影为 `run.error`，不能静默丢弃。该同步适配不创建第二 mailbox、
receipt cache 或 root-controller authority，Host lifecycle 仍只在 applied receipt 后执行自己的 abort。

`RuntimeSessionCoordinator` 的 Workspace、Project、user、recovery identity 与 Artifact evidence 是 retained
Session 的不可变身份，Host recovery 重复 `ensure` 时必须继续严格校验。`interactionMode` 则是可变的、已持久化
Session 状态：TUI replay、Plan approval 或权限选择把最新模式投影到 `SessionRuntime` 后，`SessionManager` 必须先将
该模式对齐到既有 coordinator，再校验其余不可变身份。该对齐只更新 coordinator 的 retained mode 镜像，不写第二份
Runtime State，也不得掩盖 Workspace、Project、recovery key、sandbox 或 Artifact evidence 漂移。

Approval rejection 的 durable settlement 同样只由当前 turn 的事实决定：Runner 在 sibling 收敛后的 `stop` 边界
只检查 `createdAtTurnId` 等于 live `turnId` 的 rejected call、未终结 Tool 与 queue record；`activeTaskId` 不能替代
turn identity，否则同一 Task 的旧 rejection 会错误终止 successor turn。

## SQLite storage

`@kite/runtime-storage-sqlite` 是 Host storage port 的唯一 concrete adapter：

- `adapter.ts` 单独拥有当前数据库创建、连接与关闭；独立 `RuntimeLogQueryPort` reader 只做 current-format、no-follow、query-only durable-log 读取，不能取得写 Store capability；`compatibility.ts` 只拥有历史 source 的 readonly discovery、atomic target import ledger 与 tombstone；
- SessionStore 的会话列表投影通过 `event-store.ts` 有界分批解码，找到第一条 session-name candidate 即停止；它不代替打开具体会话时的 strict Event/Snapshot 恢复校验；
- 命名恢复点按 durable `event_position` 降序投影；秒级 `created_at` 与 snapshot 名称都不承担同秒内的恢复时序；
- `preflight.ts` 在写连接前验证 current metadata；
- event/session/snapshot/artifact/authority/effect 子模块共享同一 database context；
- `transaction.ts` 是 Runtime event+snapshot 原子提交唯一 owner；
- App 只取得 Host 提供的嵌套 `sessions/transactions/effects/checkpoints` ports；
- 不存在平面 bridge、alternate current-writer constructor、format selector、dual write 或 alternate-driver retry；历史 import 不是 execution fallback。

Ack、Receipt、terminal、recovery、sandbox cleanup、MCP/Subagent lifecycle 与 effect lease 仍保持原有事务顺序。拆分不允许复制 transaction、Store、reducer 或 recovery identity owner。

## MCP、Subagent 与 Verification

MCP 默认配置来源只有 project 与 user；explicit 是调用方授权的独立文件。project 必须通过配置摘要审批。没有旧 source、迁移 command 或 ambient-environment auth spelling。Runtime 只获得受限 `McpRuntimeProvider`，不能调用配置 mutation 或 Supervisor control API。

Subagent Provider 使用 private task/handle/continuation Artifact、exact parent attempt、resource admission 与 cleanup receipt。并发 sibling approval 共享 State 27 Session durable queue；每个 child 保留 route、generation、sequence 与 binding facts，只有当前可见 `activeApprovalId` 占据人工焦点，其余记录按 FIFO 保留。清除 Session command grants 时，Kernel 与 TUI 从同一个 canonical event 将被撤销的 `same_command` 调用恢复到原 route，并在重新暴露焦点前把仍可交互的 queue record 重绑到新 generation；batch release 中已匹配并签发 receipt 的 auto-review sibling 不得再被 reviewer-cancellation 列表覆盖。恢复不能重启已挂起 child model；已恢复 child 再次阻塞时必须按 queue sequence 排在既有请求后面，不能由一个长任务连续抢占并造成审批饥饿。

Verification 只消费已提交 Receipt、Artifact 与注入的 Shell/MCP port。Kernel verification state/event map 是唯一 lifecycle authority；App effect 不得自行 waiver、改变 outcome、调用模型复核或制造 evidence。

## 完成与静态门禁

生产命名使用领域职责；旧 alias、双路径、fallback dispatcher、版本 façade 与长期 allowlist 均禁止。当前架构由以下 Gate 共同验证：

- `check:pre-release-architecture`：命名、目录、封闭 compatibility owner、唯一 composition root、Runtime→TUI、current SQLite writer 与 required domain files；
- `check:runtime-packages`：七 workspace、依赖图、exports、deep import、cycle 与 composition authority；
- `check:core-boundary`：Kernel/Host/Builtin/App、filesystem、sandbox、Tool Pipeline 与 Model authority；
- `check:docs-impact` / `check:docs`：实现与当前文档共同收敛。
