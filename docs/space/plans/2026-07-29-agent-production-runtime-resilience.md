# Agent 生产化 Phase 1C：Runtime 稳定性、资源预算与故障语义计划

状态：active
创建：2026-07-29
优先级：P0
依赖：
[`Phase 0 治理、决策与 ADR`](2026-07-29-agent-production-governance-decisions.md)
设计依据：RFC §9.1、§15.3、§17

Task 1C.1 已由 `4b8eec058df0af545675fc0e1c4135ee855848fd` 完成；Task 1C.2 与
1C.4 已由 `1e21055eb8b2579d710eb566728294f2ad8b2621` 完成；Task 1C.3 已由
`d0bd571e6a937aac55850bcc09df6f41bf95ac99` 完成。Task 1C.6 已具备 `ready`
binding；其余 Task 继续按依赖保持未绑定。规范记录见
[decision register](2026-07-29-agent-production-decision-register.md)。

## 目标

让一次 Agent run 在模型、工具、MCP、磁盘、取消或资源压力下有界结束、状态不损坏，并让
TUI、Headless CLI、恢复和 Sub-agent 使用同一失败与降级语义。

## 非目标

- 不建立 Release Manifest/Gate；
- 不决定业务 SLO 百分比；
- 不修复所有能力的产品质量；
- 不以无限重试提高表面成功率；
- 不把 `maxEffects=10_000` 当作完整资源预算；
- 不允许预算耗尽显示为完成。

## 当前基线

- Runtime 已有 `FailureKind`、`budget_exceeded` 和 effect 上限；
- shell 有单命令 timeout 和部分 ulimit；
- 取消使用 AbortSignal 与 process-tree guard；
- 当前 scheduler 对 effect-safe read batch 使用代码常量 `MAX_PARALLEL_READ_TOOLS=4`，
  runner 允许 shell sibling 与后续审批重叠；两者尚未接入 production profile 并发硬预算；
- 当前持久化 Runtime schema 为 v18；v17 的 turn lifecycle
  `active/completed/aborted` 保持不变，v18 新增 fail-closed resource budget ledger；
- 缺少父 Agent + 全部 Sub-agent 的累计 run budget；
- failure fallback 分散在入口和 provider；
- 初始基线出现 `MaxListenersExceededWarning` 和 Sub-agent Read PTY 30 秒超时；2026-07-30
  新基线完整 TUI suite 单次通过、未复现 timeout，但 listener warning 仍存在且没有 soak
  证据；
- session logger、SQLite、磁盘满和 cancel incomplete 没有统一 terminal projection。

## 主要改动范围

- `src/core/runtime/`
- `src/core/subagent/`
- `src/core/controllers/`
- `src/core/tools/process-tree.ts`
- `src/core/runtime/failures.ts`
- TUI/CLI 终态投影
- `tests/runtime/stability.test.ts`
- Sub-agent、PTY、故障注入和 soak tests

## 共享 schema ownership

本计划是 `ResourceBudgetV1`、`RuntimeSchedulingPolicyV1` 和 terminal/failure reason 的
首个实现计划，Runtime 是规范 owner。2A 只能消费实际 Runtime 导出的 canonical scheduling snapshot；
1B 只拥有 process-tree 平台 enforcement 投影，不得复制预算默认值、scheduler barrier 或终态。

## 实施步骤

### 任务执行矩阵

| Task | dependsOn | 文件/产出 | 定向验证 | 迁移与回滚 |
| --- | --- | --- | --- | --- |
| 1C.1 | `T:0:0.2`、`T:0:0.3`、`D-11:CLOSED` | `src/core/runtime/resource-budget.ts`、budget events/store、v17→v18 migration/recovery tests；消费 2A.1 注入的 effective limits，不改写 `ReleaseProfileV1` | `bun test tests/runtime/resource-budget.test.ts tests/runtime/resource-budget-recovery.test.ts` | `resourceBudgetV1=false` 时拒绝 production run；不存在描述性 legacy fallback |
| 1C.2 | 1C.1 | `scheduler.ts`/`runner.ts`/executor admission、`runtime-scheduling-policy.ts`、batch/tool/shell permit 与 saturation tests | `bun test tests/runtime/resource-budget-admission.test.ts tests/runtime/tool-concurrency-budget.test.ts tests/runtime/runtime-scheduling-policy.test.ts` | 同 flag；Store/admission/policy snapshot 不可用时副作用前 hard block |
| 1C.3 | 1C.1、1C.2 | Abort propagation/process-tree cleanup/approval-overlap/recovery tests | `bun test tests/runtime/cancel-resume.test.ts tests/runtime/concurrent-shell-cancel.test.ts` | `boundedCancellationV1=false` 时 production writer/child capability 关闭 |
| 1C.4 | `T:0:0.3`、1C.1 | failure/events/state/protocol/TUI/CLI golden、v16→v17→v18→next fixtures | `bun test tests/runtime/failure-taxonomy.test.ts tests/runtime/schema-v17-migration.test.ts` | `terminalOutcomeV1=false`；production 不允许旧 UI 把 unknown 显示完成 |
| 1C.5 | 1C.2–1C.4、`T:1A:1A.1`、`T:1B:1B.1` | table-driven failure-mode conformance | `bun test tests/runtime/failure-mode-conformance.test.ts` | fixture 失败阻断相关 capability，不放宽 fallback |
| 1C.6 | 1C.3、1C.4 | TUI listener/PTY root-cause fix、stability tests | `bun run test:tui:system` 连续运行；`bun test tests/runtime/stability.test.ts` | 不以延长 timeout 回滚；失败关闭相关 Sub-agent flow |
| 1C.7 | 1C.2–1C.6 | soak/fault runner、resource trend/evidence adapter | `bun test tests/runtime/fault-injection.test.ts`；bounded soak runner | 超阈值停止扩面；保留诊断与 pending intent |
| 1C.8 | 1C.1–1C.7 | active/book/map/ADR/migration/完成记录；唯一产生 `MS:1C-DONE` | `bun run check:docs-impact`、`bun run check:docs` | schema 已持久化后只允许兼容 artifact rollback |

### Task 1C.1：定义 `ResourceBudgetV1`

最低字段：

```typescript
interface ResourceBudgetV1 {
  maxRunDurationMs: number;
  maxTurns: number;
  maxModelRequests: number;
  maxToolInvocations: number;
  maxRunInputTokens: number;
  maxRunOutputTokens: number;
  maxConcurrentSubagents: number;
  maxConcurrentWriters: number;
  maxConcurrentToolInvocations: number;
  maxConcurrentShellInvocations: number;
  maxConcurrencyWaitMs: number;
  maxArtifactBytes: number;
}

interface ResourceUsageV1 {
  counters: {
    turns: number;
    modelRequests: number;
    toolInvocations: number;
    inputTokens: number;
    outputTokens: number;
    artifactBytes: number;
  };
  gauges: {
    elapsedRunMs: number;
    activeSubagents: number;
    activeWriters: number;
    activeToolInvocations: number;
    activeShellInvocations: number;
  };
  source: 'actual' | 'versioned_upper_bound';
  estimatorVersion?: string;
}

type BudgetReservationState = 'reserved' | 'dispatch_started' | 'reconciled' | 'released' | 'unknown';

interface BudgetReservationV1 {
  version: 1;
  reservationId: string;
  runId: string;
  invocationId: string;
  parentReservationId?: string;
  resourceKind: 'model' | 'tool' | 'mcp' | 'skill' | 'subagent' | 'verification' | 'compaction' | 'artifact';
  executableUpperBound: ResourceUsageV1;
  actual?: ResourceUsageV1;
  state: BudgetReservationState;
}

interface ConcurrencyWaiterV1 {
  version: 1;
  runId: string;
  invocationId: string;
  requiredPermits: ['tool'] | ['tool', 'shell_invocation'];
  sequence: number;
  enqueuedAt: string;
  deadlineAt: string;
  state: 'waiting' | 'promoted' | 'cancelled' | 'timed_out';
}
```

规则：

- 父 Agent 和全部 descendants 共用一个 ledger；
- project/user/CLI 只能降低上限；
- Provider usage 优先，缺失时用版本化保守 estimator；
- `versioned_upper_bound` 和实际 usage 分开；
- 货币预算只有在 currency/pricing version 可验证时才启用；
- `ResourceBudgetV1` 是 Runtime 对 2A effective Release Profile 中累计预算和 invocation
  permit 字段的执行投影，ledger 属于 Runtime 执行事实；process-tree limit 不进入该投影，
  而是由 1B 的 `ExecutionBoundaryV1` 消费和执行；
- replay 不重复计费已经持久化的 completed invocation。
- `reservationId` 是 reserve/reconcile/replay 的幂等键；父子 Agent 不建立私有余额；
- ledger 的 projection 可以重建，但 reservation 和 terminal event 必须 durable；
- 旧 snapshot 没有 ledger 时不在恢复中的 production run 热迁移：只允许只读 handoff/导出
  状态，新的受预算 run 从新 artifact 创建。
- 累计 counter 的硬不变量：
  `reconciledUsage + Σ(activeReservation.executableUpperBound) <= ResourceBudgetV1`；
- concurrency gauge 在 reserve transaction 内检查 active + reserved，run duration 由 persisted
  deadline 与 monotonic elapsed 共同限制；
- scheduler 的 read batch 代码上限 `4` 只是实现 ceiling；有效 tool 并发上限取代码
  ceiling、Release Profile、管理策略和用户收紧值的最小值。shell overlap 同时受
  `maxConcurrentToolInvocations` 与 `maxConcurrentShellInvocations` 约束；
- `run_tools` 的每个成员分别 reserve/reconcile，batch 不能作为一个 invocation 计数。
  admission 必须按剩余 permit 缩小或拆分 batch，不能让 sibling 同时越过最后余额；
- 非 shell 工具只申请 `['tool']`；shell 以一个 waiter 申请
  `['tool', 'shell_invocation']`，同一 sequence 加入两个资源队列，只有同时位于两个队首且
  两类额度均可用时才在一个 Store transaction 中全量 reserve。禁止部分占用后等待另一
  permit，取消/超时也必须从全部所需队列原子移除；
- shell sibling 在后续 sibling 等待 approval 时仍占用 tool/shell permit；只有 terminal
  event 与 reservation reconcile 同事务提交后才释放；
- shell permit 的计量单位是顶层 `shell_execute` invocation，不是 OS process。shell、
  pipeline 和 descendants 的完整 process tree 由 1B 选定的平台 backend 以
  `ExecutionBoundaryV1.maxProcessTreeSizePerShellInvocation` 强制限制；backend 不能执行时
  production shell unavailable。process tree 超限记录 `process_limit_exceeded` 并终止
  完整 tree；
- model request dispatch 前精确计量 input，设置不高于剩余预算的 `maxOutputTokens`；不能接受
  该上限或无法提供保守 output 上界的 route 不进入 production；
- artifact/file/tool output 在写入前已知大小时精确 reserve，streaming 时使用会在上界处中止
  的 bounded sink；不能先无界写完再 reconcile。

建议落点：

- 新增 `src/core/runtime/resource-budget.ts`
- 扩展 Runtime effect lease/context
- 新增 `tests/runtime/resource-budget.test.ts`

### Task 1C.2：在所有 invocation 前执行预算 admission

覆盖：

- model request；
- builtin tool；
- MCP call/recovery；
- Skill activation/fork；
- Sub-agent 创建；
- Verification/repair；
- compaction summary；
- artifact 写入。

流程：

1. 在同一个 RuntimeStore transaction 中校验余额，并持久化 reservation；需要 invocation
   intent 的外部副作用同时持久化 intent；
2. transaction 成功后持久化 `dispatch_started`，再调用 Provider/tool/MCP/child；
3. 完成时在一个 transaction 中原子提交 invocation terminal event/receipt、actual usage 和
   reservation reconcile；
4. 明确未 dispatch 的本地失败才释放 reservation；
5. crash/recovery 遇到 `dispatch_started` 且终态未知时标记 `unknown`，外部调用不退款、不
   自动重放；
6. 累计预算耗尽时停止新 invocation，写入结构化 `budget_exhausted` event/receipt；
7. Store transaction 或 schema migration 不可用时，在任何副作用前 hard block。

并发场景必须使用原子 reservation，不能让多个 Sub-agent、read batch 成员、MCP
inventory/resource call 或重叠 shell 同时越过最后余额。先按可用 permit 缩小/拆分 batch，
剩余调用进入持久化的按资源 FIFO wait queue；不能先 dispatch 后补记账。

并发 admission 语义：

- 等待期限是 `min(enqueuedAt + maxConcurrencyWaitMs, persistedRunDeadline)`，等待可由 run/
  turn/user cancellation 中断；
- waiter 只有在全部 required permits 的队列中均为队首且额度同时可用时，才原子转为
  reservation，再写 `dispatch_started`；不得持有部分 permit；
- `maxConcurrencyWaitMs` 先到时，等待中的调用产生零副作用，稳定 reason code 为
  `tool_concurrency_saturated` 或 `shell_concurrency_saturated`；Runtime 有界取消运行中
  sibling 并以 `resource_saturated` 结束本轮；
- run deadline 先到仍为 `budget_exhausted`；任何 running sibling/process tree 无法确认退出
  时升级为 `cancel_incomplete`；
- queue/recovery 保持 FIFO sequence 与 invocation identity；crash 后不能插队、重复占 permit
  或自动 dispatch 已终止 turn 的 waiter。

1C 导出唯一 `RuntimeSchedulingPolicyV1` canonical snapshot，内容至少覆盖 parallel-read
allowlist/ceiling/barrier、shell overlap scope/approval/rejection、按资源 FIFO + compound
atomic admission 字段和 late-event policy。snapshot 必须从 Runtime 实际配置生成；2A
release script 只能消费和 hash，不能维护平行常量。

恢复状态矩阵：

| Durable 状态 | 恢复动作 |
| --- | --- |
| `reserved` 且无 `dispatch_started` | 证明未 dispatch 后原子 `released` |
| `dispatch_started` 且无 terminal | 标记 `unknown`，保守占用 executable upper bound；外部 effect 不自动 replay |
| terminal event/receipt | 必须已在同一 transaction 成为 `reconciled`，否则 snapshot/schema invalid 并 hard block |
| `reconciled` | 按 reservation/invocation ID 幂等 replay，不重复计费 |
| `released` | 不计入使用量，重复 release 为 no-op |
| `unknown` | 只有结构化 reconciliation 证明 actual/未执行后才能转 terminal；不能直接退款 |

`resourceBudgetV1=false`、ledger migration 不可读或 atomic transaction 不可用时，production
profile 拒绝创建 run；开发 profile 可以显式测试旧路径，但不能生成 release evidence。

### Task 1C.3：有界取消与 descendant 清理

改动：

- run deadline 触发统一 AbortSignal；
- model stream、tool、MCP reconnect、Sub-agent 和 Verification 继承；
- process tree 先 graceful、再 bounded terminate；
- 记录未能确认退出的 descendant；
- 取消不能产生新的 model/tool invocation；
- sibling 正在运行而后续 approval 被拒绝/取消时，停止所有尚未 dispatch 的 sibling，对
  已运行 shell 执行有界清理，并保持 intent/receipt 可 reconciliation；
- stale lease、已终止 turn 或已释放 reservation 的 late terminal event 只能记入诊断/
  reconciliation，不能恢复 permit、启动后继调用或改写 durable terminal；
- `cancel_incomplete` 与普通 `cancelled` 分开；
- 恢复时处理 pending intent、lease 和 unknown external terminal。

涉及文件：

- `src/core/runtime/agent.ts`
- `src/core/runtime/runner.ts`
- `src/core/runtime/executor.ts`
- `src/core/subagent/runner.ts`
- `src/core/tools/process-tree.ts`
- cancel/resume/golden tests

### Task 1C.4：统一 failure/terminal taxonomy

在现有 `FailureKind` 上收敛稳定 reason code：

- artifact/profile/digest invalid；
- workspace untrusted；
- sandbox/network/worktree unavailable；
- model retry exhausted；
- provider/MCP unavailable；
- persistence unavailable；
- budget exhausted；
- resource saturated；
- shell process limit exceeded（稳定 reason code：`process_limit_exceeded`）；
- cancel incomplete；
- compaction unqualified/failed；
- verification failed/inconclusive；
- mandatory policy unavailable。

迁移以 schema v18 为当前稳定输入，保留 v17 作为前一稳定输入；至少提供
v16→v17→v18 和 v18→next fixtures；验证
`active/completed/aborted` turn、pending interaction、tool call/result 顺序以及
ADR-0049/ADR-0050 的调度/客户端投影在 upgrade、feature disable 和 artifact rollback 后
继续收敛。

要求：

- Runtime 事件保存结构化 kind，不解析 UI 字符串；
- TUI/CLI 使用同一 mapper；
- terminal result 包含 known external effects、safe retry、recovery entry、pending verification；
- `blocked/unknown/budget_exhausted/resource_saturated` 不合并为普通结束；
- logger/telemetry failure 不能改写 Runtime terminal。

涉及文件：

- `src/core/runtime/failures.ts`
- `src/core/runtime/events.ts`
- `src/core/runtime/state.ts`
- protocol/TUI/CLI projection
- golden fixtures

### Task 1C.5：实现 RFC failure-mode conformance

建立 table-driven suite，覆盖：

- sandbox unavailable；
- network controller unavailable；
- worktree failure；
- model timeout/rate limit/server error；
- MCP discovery/auth/revision/transport；
- disk full、read-only、SQLite busy/corrupt；
- budget exhausted；
- tool/shell permit wait timeout 与 process-tree limit；
- cancel timeout；
- compaction failed；
- Verification failed/inconclusive；
- logger/optional telemetry failure；
- mandatory admin policy unavailable；
- optional rollout unavailable。

每个 fixture 断言：

- 是否继续、阻断或降级；
- 新 invocation 数；
- durable state；
- external side effect；
- terminal reason；
- 用户文案；
- 是否允许安全 retry。

### Task 1C.6：修复 Listener warning 与 PTY timeout

先确定根因，不直接延长超时：

- 对 `useTerminalFocus` 和 stdin/ReadStream listener 建立基线；
- 记录 mount/unmount、session switch、Sub-agent approval/return 的 listener 生命周期；
- 定位 `Sub-agent Read File Flow` 在完整 suite 和孤立执行的差异；
- 清理重复 listener、未 close promise、残留 timer/process；
- timeout 只作为最终保护，不作为修复。

涉及文件按调查结果决定，重点：

- `src/app/tui/`
- `tests/tui-system/harness/`
- `tests/tui-system/scenarios/subagent-approval.test.ts`
- `tests/runtime/stability.test.ts`

验收：

- 完整 `bun run test:tui:system` 连续多次无 warning/timeout；
- listener、FD、handle、RSS 没有持续正斜率；
- 孤立与完整 suite 结果一致。

2026-07-30 增量复核的单次完整 suite 已通过，说明原 Sub-agent timeout 不再是当前单次
必现故障；但 `MaxListenersExceededWarning` 仍存在，且尚未完成连续运行和资源斜率验证，
因此本 Task 仍是 P0，不能提前关闭。

### Task 1C.7：soak 与故障注入

新增可重复 runner：

- 长会话、多 turn、多次 tool/approval/compaction；
- Sub-agent create/read/write/approval/cancel/recovery；
- model partial stream/reconnect/rate limit；
- MCP reconnect/stdio exit/catalog drift；
- kill -9 后 store/intent/Plan/Verification 恢复；
- disk full、日志失败、SQLite busy；
- repeated session switch 和 TUI mount/unmount。

报告：

- RSS/listener/FD/handle slope；
- p50/p95/p99；
- budget usage；
- terminal taxonomy；
- orphan process/worktree；
- state invariant。

### Task 1C.8：active 文档和迁移

更新：

- `docs/active/cancel-resume-cleanup.md`
- `docs/active/failure-classification.md`
- `docs/active/six-concept-runtime-architecture.md`
- `docs/active/tool-gated-autonomy.md`
- `docs/book/04-Agent引擎.md`
- `docs/book/06-多Agent协作.md`
- `docs/book/10-持久化与会话管理.md`
- `docs/documentation-map.json`
- 对应 ADR。

实现、故障矩阵、soak、迁移和文档门禁全部收敛后，本任务唯一产生 `MS:1C-DONE`。

## 验收条件

- [ ] 父/子 Agent 共享累计预算；
- [ ] tool invocation/shell invocation 并发硬上限在 batch、approval overlap 和 Sub-agent
  间原子生效；
- [ ] shell invocation cap 与 process-tree cap 在类型/投影中分离，1C 不用顶层计数替代 1B
  平台 enforcement；
- [ ] permit 的按资源 FIFO、compound atomic acquire、等待期限/recovery 和
  `resource_saturated` 终态一致；
- [ ] `RuntimeSchedulingPolicyV1` 从实际 Runtime 导出并通过 canonical golden；
- [ ] 所有 invocation admission 覆盖；
- [ ] budget/cancel 终态不会显示完成；
- [ ] descendant 有界清理且残留可诊断；
- [ ] failure matrix 在 TUI/CLI/恢复/Sub-agent 一致；
- [ ] persistence 失败在副作用前 hard block；
- [ ] 完整 PTY suite 无 warning/timeout；
- [ ] soak 无 listener/FD/handle/RSS 持续增长；
- [ ] kill -9/磁盘满/网络抖动 fixture 不损坏 Runtime；
- [ ] schema v16→v17→v18→next 与 rollback fixture 不重开 aborted/completed turn；
- [ ] active/book/ADR/map 收敛。

## 回滚

- 可以把预算调低或关闭高风险能力；
- 可以禁用 background/Sub-agent writer；
- 可以退回更严格的单并发；
- 不能移除已有 required verification；
- 不能把预算耗尽改为完成；
- 不能为消除失败回滚为无限 retry；
- 新 terminal schema 若已持久化，artifact rollback 必须先证明可读兼容。

## 风险

| 风险 | 控制 |
| --- | --- |
| 预算计数与实际 Provider usage 不一致 | actual/estimated 分离、保守 admission、reconcile |
| 并发 reservation 超卖 | RuntimeStore/ledger 原子操作 |
| cancel 中断 intent 持久化 | intent-first，副作用前硬门禁 |
| 为修 PTY 只扩大 timeout | listener/process 生命周期指标作为根因证据 |
| failure kind 数量失控 | 有限枚举、diagnostic code 与用户文案分离 |
| soak 不可重复 | 固定 fixture、seed、预算和环境版本 |

## 完成证据

目标路径：`docs/space/execution/completed/2026-07-30-agent-production-runtime-resilience.md`。
记录内按 Task ID 分节并逐项包含文档影响、实际 commit/artifact、命令结果与偏差。

- ResourceBudget conformance；
- scheduling policy snapshot/digest conformance；
- concurrency saturation 报告，并引用 1B 的 process-tree limit evidence；
- failure matrix 报告；
- PTY 连续运行结果；
- soak/resource 趋势；
- kill -9、磁盘满、SQLite 和 cancel fixture；
- terminal UX snapshots；
- rollback/replay 兼容报告。
