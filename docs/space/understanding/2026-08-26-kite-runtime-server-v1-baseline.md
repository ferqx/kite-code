# Kite Runtime Server V1 基线清单

日期：2026-08-26

用途：KRSV1-00 的实现前事实快照；它记录源码、测试与 current authority 的观察，不替代 workspace README 或
`docs/active/` current authority。

相关：ADR-0142、KRSV1 计划、ADR-0053、ADR-0129、ADR-0137、ADR-0138。

## 已核对的 Runtime surface

### command

`@kite-ai/runtime-contract` 的 `RuntimeCommand` 当前含十个 discriminant：

| Command | 当前 bridge/consumer 观察 | Protocol V1 前的结论 |
| --- | --- | --- |
| `create_session` | TUI bridge 发送；CLI bridge 支持 | Workspace 现由 client DTO 提供，wire 必须改为 App admission 注入 |
| `resume_session` | TUI bridge 与 CLI bridge 支持 | 恢复前仍需 exact-session compatibility/admission |
| `start_turn` | TUI/CLI 支持，Host schedule execution | command ID/retry 需跨进程唯一 allocator |
| `cancel_turn` | TUI/CLI 支持 | local abort + durable command 语义必须保留 |
| `respond_interaction` | Contract 有类型预留；现有 TUI/CLI production bridge 未完整处理 | P0 gap；需 safe identity/generation/grant matrix |
| `set_interaction_mode` | TUI bridge 发送；CLI bridge 当前未完整处理 | 明确 client/role/admission 与 State 27 语义 |
| `compact_session` | TUI/CLI bridge 支持 | 保留 recovery/receipt/execution 语义 |
| `rewind_session` | TUI bridge 发送；CLI bridge 当前未完整处理 | 需显式 route/codec/admission 测试 |
| `fork_session` | Contract 有类型预留；现有 TUI/CLI production bridge 未完整处理 | 需显式 route/codec/admission 测试 |
| `close_session` | TUI/CLI bridge 支持 | 需绑定 receipt retention/delete policy |

当前 `isRuntimeCommand()` 只做 schema、command ID、discriminant 和 `create_session.workspace` 的浅层检查，不能作为
wire validator。Host 的 command identity 为 `runtimeCommandSessionId(command) + NUL + commandId`；同 scope/key 的
不同 serialized body 返回 `invalid_command`。receipt、pending receipt 与 signature 目前只在 Host 内存中。

### query、subscription 与 event

| Surface | 当前事实 | KRSV1 boundary |
| --- | --- | --- |
| Query | `list_sessions`、`get_session_projection`、`get_context_status`、`list_checkpoints`、`get_rewind_preview` | Protocol V1 单独逐项 allowlist/strict codec；不能因 Contract 新成员自动扩大 |
| `RuntimeAccess` | `command/query/subscribe` 三个方法 | Server 唯一 runtime backend seam；不暴露 Host concrete type |
| Subscription | 仅 `sessionId`、可选 `afterRevision`、本地 `AbortSignal` | wire 只使用 JSON-safe spec；增加 sessions index scope 需 reset begin/end/atomic replace |
| Durable notification | projection snapshot/session/work/turn/interaction/evidence；Host history 上限 256 | 只能短断线 replay；gap 用 snapshot/reset，不是完整历史 |
| Ephemeral stream | `model_delta`、`reasoning_delta`、`tool_progress` | best effort；不能持久化或以它补全日志 |
| Notification event | `Readonly<{ type: string } & Record<string, unknown>>`；TUI presentation 另以 `& any` 扩张 | 不是封闭或可安全 wire 的 vocabulary，KRSV1-01 必须替换 |
| Projection | Session 可含 raw `workspace`；interaction 只有 id/kind/title/summary | Web DTO 不能透传 workspace；interaction 不足以安全断线 settlement |

Host durable history 与 subscriber queue 均为 256。队列满时先移除 ephemeral；若 durable 无法容纳则关闭该
subscriber。close/unsubscribe 释放 subscriber，不取消 Runtime work。当前没有 Session index publisher 或
`indexRevision`。

## TUI/CLI journeys 与测试事实

TUI 只通过 `apps/kite/src/adapters/tui/session-adapter.ts` 取得 typed surface；其 runtime bridge 目前仍直接使用
Host command/query/subscribe seam。其已观察的 production journey 涵盖 create/resume、start turn、cancel、
compact、rewind、mode、close、session switch/persistence、approval/input、Plan、streaming、interrupt/restart。
`respond_interaction` 的完整 bridge 支持不能由此推定。

owner-local PTY scenarios 当前包括 startup/input/multi-turn、interrupt/interrupt-resume、approval-escape、
ask-user-esc、tool-approve、subagent-approval、plan-review/plan-mode-policy、session-lifecycle/switch/persistence/
format-compatibility、compaction、file-rewind、model streaming/reconnect、workspace trust 和 error recovery。
系统测试按文件隔离 PTY、Workspace、HOME 与 process tree；默认 `bun run test` 不运行 PTY scenario。

CLI bridge 当前完整支持 create/resume/start/cancel/close 与 list/get projection；其他 command 会回 `unsupported`。
这与 Contract union 不等价，KRSV1-01 的 support matrix 必须逐项覆盖 Contract DTO → Host router/bridge → TUI →
CLI → protocol codec → admission role → receipt/retry。

## 当前格式、持久化与历史读取

当前源码常量是 State 27、Store 5、epoch `kite-runtime-saq-v1-2026-08-25`。SQLite current preflight 期望 7 tables/
2 indexes；`transaction.ts` 是 Runtime event + snapshot 原子提交 owner。新 Session 使用 epoch-derived current target；
current Store 只接受该 exact marker/epoch，且当前 Store 没有 persistent command-receipt table。

ADR-0138 当前的已知历史 profile 是 State 26 / Store 5 /
`kite-runtime-modularization-v1-2026-08-19`，以 readonly/no-follow source、session-scoped migration 和 atomic target
import 处理。未知 source 在发现阶段静默忽略，坏 session 隔离；不允许旧 writer、dual write、alternate driver 或
execution fallback。

ADR-0142 已接受的后续目标是 State 27 不变、Store 6/new epoch 为 current target，Store 5 为 explicit
current-source compatibility profile，并把 scoped receipt 与 Runtime transaction 原子提交。该目标尚未实现，不能将
现有 Store 5 writer 或 State 26 source profile 写成 Store 6 compatibility 已完成。

完整 durable history 的现有 authority 是 SQLite Runtime Log Query：`RuntimeLogQueryPort` + readonly SQLite reader +
App `RuntimeLogPresentationProjector`。它不返回 raw event JSON，不扫描 Session Logger/JSONL/trace，也不提供
transaction/effect/checkpoint/delete/Artifact reader。

## LOGWEB 完成边界与产品拓扑

| 范围 | 当前状态 | KRSV1 关系 |
| --- | --- | --- |
| LOGWEB-00～04 | 已完成：ADR、Contract DTO、Host query port、SQLite readonly reader、App safe projector | 保持 query-only authority，不被 RPC 接管 |
| LOGWEB-05～09 | 未实施：listener/auth、HTTP/SSE、Web UI、concurrency/recovery qualification、docs/release | 由 KRSV1 接管并串行实施 |
| HTTP/SSE/Web/CLI listener | 当前无 production entrypoint | KRSV1-08 前不得创建；WebSocket 仅 test/development evidence |
| Runtime Server/Protocol/Client packages | 当前不存在 | KRSV1 后续新增，不能以计划文字当作已有实现 |

ADR-0053 保持：有限生产仅是单本地 OS 用户、单 trusted Workspace、local TUI 与同一用户在场 foreground
headless CLI；Web、remote/hosted、多租户与跨设备控制是 No-Go。V1 的 one-instance/one-trusted-Workspace admission
收窄 transport authority，不能提升 Web support。

## 当前 Runtime package graph

当前 `check:runtime-packages` 固定 7 个 workspace、12 条允许内部依赖边，唯一 concrete composition root 为
`apps/kite/src/bootstrap.ts`：

```text
runtime-contract → ∅
agent-kernel     → ∅
runtime-spi      → runtime-contract
runtime-host     → agent-kernel, runtime-contract, runtime-spi
runtime-storage  → runtime-host
builtin-runtime  → runtime-contract, runtime-spi
apps/kite        → builtin-runtime, runtime-contract, runtime-host, runtime-spi, runtime-storage
```

KRSV1 会将 graph 扩为 10 workspace。目标边为 `runtime-protocol → runtime-contract`、
`runtime-client → runtime-contract + runtime-protocol`、`runtime-server → runtime-contract + runtime-protocol`，并由
`apps/kite` 直接组合 client/server 与既有 concrete owners。Agent Kernel 不得取得任何新 workspace、I/O runtime 或
TUI dependency。

## 事实差异与实施前约束

1. KRSV1 plan 的早期 Store wording 与现在源码不同：真实 current writer 仍是 Store 5，而 accepted ADR target 是
   Store 6/new epoch；实现前必须更新 current authority、format gate、tests 和 DDL，不能静默跳过。
2. 当前 compatibility source 实现明确列出的是 State 26/Store 5 historical profile；Store 5 as current-source
   compatibility 是 ADR-0142 的 future slice，不是已验证的代码路径。
3. LOGWEB plan 本身已标 `superseded`，并明确保留 00～04、移交 05～09；不得重新启动旧计划的独立 listener owner。
4. Contract 的 `respond_interaction`、`fork_session` 及若干 client journey 的 union/bridge 差异是真实 gap；不得
   以 generic wire DTO 或 temporary Server waiter 掩盖。
