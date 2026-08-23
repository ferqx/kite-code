# Kite Code 六概念 Runtime 架构

状态：active

读取时机：修改 Agent loop、Kernel state/event/reducer、Capability、Policy、Execution、Verification、Host lifecycle、Builtin module、SQLite storage 或 App composition 时。

验证：`bun run check:pre-release-architecture`、`bun run check:runtime-packages`、`bun run check:core-boundary`、`bun run typecheck`、`bun test packages/runtime-contract/test packages/runtime-spi/test packages/agent-kernel/test packages/runtime-host/test packages/builtin-runtime/test packages/runtime-storage-sqlite/test`。

相关：[`layer-boundary-enforcement.md`](layer-boundary-enforcement.md)、[`pre-release-architecture.md`](pre-release-architecture.md)、ADR-0128。

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

State 只有一个当前 persisted shape。格式不匹配、checksum/revision/project/workspace identity 漂移、event tail 非法或 recovery evidence 不完整均 fail closed；不迁移旧格式。

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
retry authority。

TUI 通过 `apps/kite/src/adapters/tui/session-adapter.ts` 获取 typed client surface。TUI 不接触 Kernel state、Host execution control、Builtin executor 或 SQLite handle。

## SQLite storage

`@kite/runtime-storage-sqlite` 是 Host storage port 的唯一 concrete adapter：

- `adapter.ts` 单独拥有数据库创建、连接与关闭；
- `preflight.ts` 在写连接前验证 current metadata；
- event/session/snapshot/artifact/authority/effect 子模块共享同一 database context；
- `transaction.ts` 是 Runtime event+snapshot 原子提交唯一 owner；
- App 只取得 Host 提供的嵌套 `sessions/transactions/effects/checkpoints` ports；
- 不存在平面 bridge、alternate constructor、format selector、dual write、migration 或 alternate-driver retry。

Ack、Receipt、terminal、recovery、sandbox cleanup、MCP/Subagent lifecycle 与 effect lease 仍保持原有事务顺序。拆分不允许复制 transaction、Store、reducer 或 recovery identity owner。

## MCP、Subagent 与 Verification

MCP 默认配置来源只有 project 与 user；explicit 是调用方授权的独立文件。project 必须通过配置摘要审批。没有旧 source、迁移 command 或 ambient-environment auth spelling。Runtime 只获得受限 `McpRuntimeProvider`，不能调用配置 mutation 或 Supervisor control API。

Subagent Provider 使用 private task/handle/continuation Artifact、exact parent attempt、resource admission 与 cleanup receipt。并发 sibling approval 只允许一个占据 interaction slot，其余以 durable deferred fact 保留；恢复不能重启已挂起 child model。

Verification 只消费已提交 Receipt、Artifact 与注入的 Shell/MCP/reviewer port。Kernel verification state/event map 是唯一 lifecycle authority；App effect 不得自行 waiver、改变 outcome 或制造 evidence。

## 完成与静态门禁

生产命名使用领域职责；旧 alias、双路径、fallback dispatcher、版本 façade 与长期 allowlist 均禁止。当前架构由以下 Gate 共同验证：

- `check:pre-release-architecture`：命名、目录、旧 compatibility symbol、唯一 composition root、Runtime→TUI、SQLite 格式选择与 required domain files；
- `check:runtime-packages`：七 workspace、依赖图、exports、deep import、cycle 与 composition authority；
- `check:core-boundary`：Kernel/Host/Builtin/App、filesystem、sandbox、Tool Pipeline 与 Model authority；
- `check:docs-impact` / `check:docs`：实现与当前文档共同收敛。
