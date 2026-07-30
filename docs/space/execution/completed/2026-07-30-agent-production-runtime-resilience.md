# Agent 生产化 Phase 1C Task 1C.1/1C.2/1C.4 完成记录

状态：completed
日期：2026-07-30
计划：
[`2026-07-29-agent-production-runtime-resilience.md`](../../plans/2026-07-29-agent-production-runtime-resilience.md)
执行者：`github:@ferqx`
实现提交：
`1C.1=4b8eec058df0af545675fc0e1c4135ee855848fd`；
`1C.2/1C.4=1e21055eb8b2579d710eb566728294f2ad8b2621`

## Task 1C.1

- Runtime schema v18 固化 `ResourceBudgetV1` limited/internal preset、累计 usage、共享
  reservation ledger、idempotent transition 和 v17 fail-closed migration。

## Task 1C.2

- Runtime schema v19 新增 durable FIFO waiter、compound tool/shell permit、run/wait deadline
  和 `RuntimeSchedulingPolicyV1` canonical snapshot/digest。
- Runner 在 model、compaction、auto-review、Verification、builtin/MCP/Skill/Sub-agent tool、
  Provider recovery 和 artifact-writing tool 前持久化 reservation/dispatch。
- 工具/capability terminal facts 与 actual reconciliation 同批提交；crash 恢复时 reserved
  release、dispatch_started 转 unknown，均不自动重放。
- Sub-agent 或未知 artifact usage 使用 versioned upper bound 保守结算，不因缺测量而退款。

## Task 1C.4

- 新增稳定 failure/terminal reason code 和 `RunTerminalOutcomeV1`，区分 completed、blocked、
  unknown、budget exhausted、resource/tool/shell saturation。
- 新 terminal event 在持久化前补齐 external effects、safe retry、recovery entry 和 pending
  verification 字段；TUI/CLI 共享 mapper。
- v18→v19 保留 ledger 并补空 queue；既有 v16/v17 migration fixtures 继续通过。

## 验证

- Task matrix 定向测试：
  `tests/runtime/resource-budget-admission.test.ts`、
  `tool-concurrency-budget.test.ts`、`runtime-scheduling-policy.test.ts`、
  `failure-taxonomy.test.ts`、`schema-v17-migration.test.ts`：9 pass；
- 连同 Provider 定向套件：20 pass；
- 完整默认套件：main 2018 pass/6 skip，5 个隔离文件 26 pass；
- `bun run check:docs-impact`、`bun run check:docs`、`bun run check:core-boundary`、
  `bun run typecheck`、Biome 和 `git diff --check`：通过；
- pre-commit golden：10 pass。

## 回滚、风险与未完成项

- `resourceBudgetV1=false` 时 production run fail closed；v17 及更早
  `legacy_unconfigured` snapshot 不允许热补余额。
- `terminalOutcomeV1=false` 只回滚客户端 rollout；production 客户端不得把 unknown/block/
  budget/saturation 显示为完成。
- 默认测试仍出现既有 TUI `MaxListenersExceededWarning`；本记录不把该 warning 当绿色证据，
  root-cause 修复属于 1C.6。
- bounded cancellation/process-tree cleanup、failure-mode conformance、soak/fault evidence 和
  `MS:1C-DONE` 仍分别等待 1C.3、1C.5–1C.8。
