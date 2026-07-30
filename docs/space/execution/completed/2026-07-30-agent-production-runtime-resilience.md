# Agent 生产化 Phase 1C Task 1C.1/1C.2/1C.3/1C.4 完成记录

状态：completed
日期：2026-07-30
计划：
[`2026-07-29-agent-production-runtime-resilience.md`](../../plans/2026-07-29-agent-production-runtime-resilience.md)
执行者：`github:@ferqx`
实现提交：
`1C.1=4b8eec058df0af545675fc0e1c4135ee855848fd`；
`1C.2/1C.4=1e21055eb8b2579d710eb566728294f2ad8b2621`；
`1C.2-hardening/1C.3=d0bd571e6a937aac55850bcc09df6f41bf95ac99`

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
- 主模型按实际 projection 预留 input，并把 Provider max output clamp 到剩余预算。
- Sub-agent parent 只持有 lifecycle/concurrency；每个 child 模型、工具、Shell/MCP 和 artifact
  调用建立独立链接 reservation，resume 使用新的 parent attempt。dispatch 后错误转 unknown，
  不因缺测量或 parent 粗粒度结算而退款。

## Task 1C.3

- `boundedCancellationV1` 固化 run deadline 与统一 AbortSignal；ResourceBudget 启用但该 flag
  关闭时 writer、Shell 和 child capability 同时从模型面与 Controller fail closed。
- 取消事务原子 release 未 dispatch reservation、标记 dispatched unknown、取消 durable
  waiter 并写 error-caused turn abort；恢复保留 reconciliation hard block。
- POSIX process group 先 SIGTERM/500ms，再 SIGKILL/2s 确认；Windows 使用 Job Object 或
  `taskkill /T /F`，结果记录 cleanup confirmation 与未确认 descendant 数。
- deadline 能唤醒 permit 和交互等待；若 approval pending 时仍有后台 Shell，Runner 先排空
  bounded cleanup 与 cancellation diagnostic，再形成唯一 terminal。
- `run.completed` 与 `turn.completed` 在暴露给慢消费者前原子持久化；late terminal 不复活
  cancelled tool/turn。

## Task 1C.4

- 新增稳定 failure/terminal reason code 和 `RunTerminalOutcomeV1`，区分 completed、blocked、
  unknown、budget exhausted、resource/tool/shell saturation。
- 新 terminal event 在持久化前补齐 external effects、safe retry、recovery entry 和 pending
  verification 字段；TUI/CLI 共享 mapper。
- v18→v19 保留 ledger 并补空 queue；既有 v16/v17 migration fixtures 继续通过。

## 验证

- 独立只读复核：1C.3 PASS、无残余 P0/P1；联合定向回归 125 pass/0 fail；
- 标准默认套件：2059 pass/6 skip/0 fail；
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
- 既有 MCP authentication PTY 请求计数失败已在基线提交独立复现；failure-mode conformance、
  PTY/listener root cause、soak/fault evidence 和 `MS:1C-DONE` 仍等待 1C.5–1C.8。
- Phase 2 Release Profile/Gate 尚未组合，本记录不生成 production artifact 或 production-ready
  结论。
