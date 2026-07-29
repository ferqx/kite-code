# Agent 生产化 Phase 1C：Runtime 稳定性、资源预算与故障语义计划

状态：draft
创建：2026-07-29
优先级：P0
依赖：
[`Phase 0 治理、决策与 ADR`](2026-07-29-agent-production-governance-decisions.md)
设计依据：RFC §9.1、§15.3、§17

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
- 缺少父 Agent + 全部 Sub-agent 的累计 run budget；
- failure fallback 分散在入口和 provider；
- 基线测试出现 `MaxListenersExceededWarning` 和 Sub-agent Read PTY 30 秒超时；
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

## 实施步骤

### 任务执行矩阵

| Task | dependsOn | 文件/产出 | 定向验证 | 迁移与回滚 |
| --- | --- | --- | --- | --- |
| 1C.1 | `T:0:0.2`、`T:0:0.3`、`D-11:CLOSED` | `src/core/runtime/resource-budget.ts`、budget events/store migration、recovery tests | `bun test tests/runtime/resource-budget.test.ts tests/runtime/resource-budget-recovery.test.ts` | `resourceBudgetV1=false` 时拒绝 production run；不存在描述性 legacy fallback |
| 1C.2 | 1C.1 | invocation admission/reservation/reconcile integration、concurrency tests | `bun test tests/runtime/resource-budget-admission.test.ts` | 同 flag；Store/admission 不可用时副作用前 hard block |
| 1C.3 | 1C.1、1C.2 | Abort propagation/process-tree/recovery tests | `bun test tests/runtime/cancel-resume.test.ts` | `boundedCancellationV1=false` 时 production writer/child capability 关闭 |
| 1C.4 | `T:0:0.3`、1C.1 | failure/events/state/protocol/TUI/CLI golden fixtures | `bun test tests/runtime/failure-taxonomy.test.ts` | `terminalOutcomeV1=false`；production 不允许旧 UI 把 unknown 显示完成 |
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
```

规则：

- 父 Agent 和全部 descendants 共用一个 ledger；
- project/user/CLI 只能降低上限；
- Provider usage 优先，缺失时用版本化保守 estimator；
- `versioned_upper_bound` 和实际 usage 分开；
- 货币预算只有在 currency/pricing version 可验证时才启用；
- budget schema 属于 Release Profile，但 ledger 属于 Runtime 执行事实；
- replay 不重复计费已经持久化的 completed invocation。
- `reservationId` 是 reserve/reconcile/replay 的幂等键；父子 Agent 不建立私有余额；
- ledger 的 projection 可以重建，但 reservation 和 terminal event 必须 durable；
- 旧 snapshot 没有 ledger 时不在恢复中的 production run 热迁移：只允许只读 handoff/导出
  状态，新的受预算 run 从新 artifact 创建。
- 累计 counter 的硬不变量：
  `reconciledUsage + Σ(activeReservation.executableUpperBound) <= ResourceBudgetV1`；
- concurrency gauge 在 reserve transaction 内检查 active + reserved，run duration 由 persisted
  deadline 与 monotonic elapsed 共同限制；
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
6. 达到上限停止新 invocation，写入结构化 `budget_exhausted` event/receipt；
7. Store transaction 或 schema migration 不可用时，在任何副作用前 hard block。

并发场景必须使用原子 reservation，不能让多个 Sub-agent 同时越过最后余额。

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
- cancel incomplete；
- compaction unqualified/failed；
- verification failed/inconclusive；
- mandatory policy unavailable。

要求：

- Runtime 事件保存结构化 kind，不解析 UI 字符串；
- TUI/CLI 使用同一 mapper；
- terminal result 包含 known external effects、safe retry、recovery entry、pending verification；
- `blocked/unknown/budget_exhausted` 不合并为普通结束；
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
- [ ] 所有 invocation admission 覆盖；
- [ ] budget/cancel 终态不会显示完成；
- [ ] descendant 有界清理且残留可诊断；
- [ ] failure matrix 在 TUI/CLI/恢复/Sub-agent 一致；
- [ ] persistence 失败在副作用前 hard block；
- [ ] 完整 PTY suite 无 warning/timeout；
- [ ] soak 无 listener/FD/handle/RSS 持续增长；
- [ ] kill -9/磁盘满/网络抖动 fixture 不损坏 Runtime；
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

- ResourceBudget conformance；
- failure matrix 报告；
- PTY 连续运行结果；
- soak/resource 趋势；
- kill -9、磁盘满、SQLite 和 cancel fixture；
- terminal UX snapshots；
- rollback/replay 兼容报告。
