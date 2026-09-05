# Server Run 与 TUI 展示生命周期基线

状态：frozen baseline（LFC-00）

日期：2026-09-04

相关：ADR-0173、`docs/space/plans/2026-09-04-server-tui-lifecycle-convergence.md`

本记录冻结 LFC 实施前的源码事实、可重复验证入口与目标差异。它不是 current behavior authority；实现与 current authority 仍由
源码、测试、workspace README 和 `docs/active/` 定义。

## Identity trace

| Trace | 当前输入与 committed facts | 当前投影/表现 | 目标变化 | 稳定 reproduction |
| --- | --- | --- | --- | --- |
| normal | applied start receipt；`turn.started(initial)`；`run.completed` + `turn.completed` | Run row 以 initial turnId 创建；Client `run.terminal` 从 event turnId 投影 | terminal 从 committed stable Run row 产生 | `packages/runtime-host/test/state-session.test.ts`、`apps/kite-service/test/runtime-client-event-projector.test.ts` |
| plan draft pending | planning Task + Turn terminal，Plan 保持可继续 | compatibility `activeWork` 可被 Turn terminal 整体完成 | Task/Turn/Run 分别投影 | `apps/kite-service/test/isolated/runtime/task-plan-lifecycle.test.ts`、`tests/tui-system/scenarios/plan-review.test.ts` |
| Provider Action continuation | initial Turn 等待 action；settlement 后 `turn.started(continuation)` | Host Run transition 用 `previousState.turn.turnId` 查 row；continuation 后无法命中 initial Run | 唯一 active Run row 在同事务推进，terminal 保留 initial runId | `apps/kite-service/test/runtime/tool-pipeline-state-persistence.test.ts`、新增 LFC Host golden |
| approval reject | focused target rejected、siblings cancelled、`turn.aborted(user)` | bridge 根据 client event terminalize 整个 `activeWork` | Turn abort 与 stable Run cancel 同事务；Task 不被替代 | `packages/runtime-host/test/approval-batch-recovery.test.ts`、`tests/tui-system/scenarios/approval-escape.test.ts` |
| cancel after receipt | accepted Run 后 `cancel_turn` | Native `cancellationPending`/`agentLoopActive` 与 `activeWork` 混合 | CancelCommand 绑定 receipt runId；只有 Run terminal 改 RunView | `apps/kite-cli/test/service-mode/tui-client.test.ts`、`tests/tui-system/scenarios/cancel-successor-render.test.ts` |
| cancel before receipt | start command await 期间 Ctrl+C | 没有显式 cancel-after-accept identity | sent command 等 accepted receipt 后精确 cancel | 新增 LFC Native-client ordering golden |
| retry/busy successor | `runtime_busy` 或 revision conflict | logical prompt 重试会分配新 commandId，但本地状态仍由 `agentLoopActive` 表示 | stable submissionId + attempt commandIds | `apps/kite-cli/test/service-mode/tui-client.test.ts` queued-successor cases |
| recovery | restart 后 nonterminal Run query | Host read-only映射为`status=unknown` + `reasonCode=recovery_required`；compatibility Work可能缺失 | first-class recovery_required RunView，阻塞 waiter/admission | `packages/runtime-host/test/runtime-host.test.ts`、`packages/runtime-storage-sqlite/test/run-recovery.test.ts` |
| terminal-before-receipt | terminal notification 先于 command await 返回 | Native 暂存 `{runId,revision}` candidate，但仍可由 `activeWork` 缺失 resolve | candidate 与 accepted runId/revisionFloor 精确 join | `apps/kite-cli/test/service-mode/tui-client.test.ts` ordering cases |
| ephemeral gap | text/reasoning stream sequence 不连续 | RuntimeClient 保留 stream fencing，但 TUI 没有 request-level incomplete state | gap 标记 presentation_incomplete，补齐前不 seal | `packages/runtime-client/test` stream tests、`tests/tui-system/scenarios/model-stream-reconnect.test.ts` |
| replay | durable history 经 history adapter 转为 client event | live/history 各有投影路径；raw `run.completed` 名称继续影响领域判断 | 共享 canonical Task completion facts 与 closed client vocabulary | `apps/kite-service/test/runtime-history-client.test.ts`、`apps/kite-cli/test/tui-replay-blocks.test.ts` |
| multi-session | foreground/background 各自订阅 | background buffer 保存 presentation event，Session runtime 仍有 process-local flags | buffer 保存 accepted envelope；每 Session 独立 authority | `apps/kite-service/test/isolated/runtime-server-multi-client.test.ts`、`tests/tui-system/scenarios/session-switch.test.ts` |
| exit | TUI unmount 后 bounded client cleanup | current authority 已禁止 implicit Runtime cancel | Render disposed 与 Server Run 完全分离 | `apps/kite-cli/test/tui-exit-coordinator.test.ts`、`tests/tui-system/scenarios/session-lifecycle.test.ts` |
| Static | OutputBlock kind/flags 经 `isBlockSettledInRun` 判连续 prefix | renderer 仍解释 tool/thought/interaction terminal | projector 先 seal，renderer 只认 sealed+digest | `apps/kite-cli/test/tui-static-promote.test.tsx`、message/tool/Subagent PTY scenarios |

## Current limits

- Runtime Protocol 单 message hard limit：1,048,576 bytes（`packages/runtime-protocol/src/limits.ts`）。
- Runtime Contract 单 client text field hard limit：65,536 UTF-16 code units（`packages/runtime-contract/src/validation.ts`）。
- Service tool-progress presentation frame：16 KiB；TUI background event buffer：1,000 events。
- 当前没有 RequestAssembly 聚合字节或同时未决 request 的 authority。ADR-0173 固定新 projector 的 1 MiB/request、64 pending
  request 上限；超限不改变 durable Run，但 presentation 必须 fail closed 为 incomplete。

## Projection consumer inventory

| Consumer | 当前依赖 | LFC owner |
| --- | --- | --- |
| `CliRuntimeBridge` | `#running/#activeWork` 与 `terminalizeActiveWork` | Task/Run/SessionOperation view 的纯 projector |
| bootstrap stored snapshot | State interaction 只在 waiting 时构造 `activeWork` | State + active Run row 共同恢复 currentRun |
| Host session registry | same-revision activeWork cleanup enrichment | currentRun precise terminal/recovery enrichment |
| Host notification projector | Session projection + ephemeral stream tuple | stable runId/activeTurnId 与完整 envelope |
| Runtime Protocol codec | exact v1 Session/event shape | exact lifecycle schema version |
| RuntimeClient snapshot store | generation/revision/reset 后保存裸 projection/event | accept-before-dispatch envelope |
| Native TUI client | `agentLoopActive`、activeWork absence、Run resource candidate | AcceptedRunIdentity + exact Run query |
| foreground CLI | facade `runTask/waitForRunCompletion` | 与 TUI 相同 Run terminal rule |
| Agent API read adapter | Session activeWork/running/waiting | activeTask/currentRun mapper |
| History adapter | raw durable events分别投影 | State/history normalizer → client projector |
| TUI reducer | raw client event + `running`/current request scalars | accepted Session envelope + per-Session projections |
| OutputArea/Static | OutputBlock flags 与 per-kind terminal 推导 | sealed Timeline prefix + render commit ledger |

Run-resource-enabled production path 是 App Server/Workspace execution 使用 Store 8 的 composition。`supportsRunStorage() === false`
只存在于显式 Store 6/7、legacy/in-process/test composition；它不得伪装拥有 Run row，LFC-04 前从 production/release qualification
排除或迁入 Store 8。

## OutputBlock owner inventory

| OutputBlock kind | 当前 owner | 目标 Timeline/chrome owner |
| --- | --- | --- |
| `user` | durable user.message 或 live pending echo | sealed `user`；pending echo 属 PromptSubmission chrome |
| `text` | model request scalars/stream flags | RequestAssembly → sealed `text` |
| `reason` | legacy history/reason block | sealed `legacy_reason` |
| `tool_card` | per-tool reducer | live/sealed `tool` |
| `tool_summary` | Thought/tool reducer | live/sealed `thought` |
| `file_change` | durable presentation-only block | sealed `file_change` |
| `approval` | interaction reducer | live/sealed `interaction` |
| `question` | input interaction reducer | live/sealed `interaction` |
| `subagent` | child/group reducer | live/sealed `subagent_group` |
| `LOCAL_TEXT`/`LOCAL_COMMAND` actions | local reducer tail | sealed `local_notice` |
| recovery/error notices | local/runtime failure handling | sealed `local_notice` |
| compaction progress | status/message area | live `compaction` 或既有 chrome，不进入 durable timeline |

## Golden evidence schema

后续每个新增 lifecycle regression 保存或断言以下同一逻辑 trace：

```text
server: event type + revision + transaction/checkpoint boundary
domain: TaskView + Turn + stable Run row/currentRun + interaction queue
client: accepted receipt/envelope + exact terminal/query identity
presentation: ordered Timeline kind + sealed payload digest
pty: visible item occurrence count + post-terminal stdout bytes
```

baseline 中尚不具备的字段必须明确标为 missing，不得用 synthetic identity 填充。LFC-01～07 的测试逐层把 missing 收敛为目标事实。
