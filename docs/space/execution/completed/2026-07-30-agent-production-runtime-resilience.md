# Agent 生产化 Phase 1C Task 1C.1–1C.6 完成记录

状态：completed
日期：2026-07-30
更新：2026-08-01（补充 Task 1C.5）
计划：
[`2026-07-29-agent-production-runtime-resilience.md`](../../plans/2026-07-29-agent-production-runtime-resilience.md)
执行者：`github:@ferqx`
实现提交：
`1C.1=4b8eec058df0af545675fc0e1c4135ee855848fd`；
`1C.2/1C.4=1e21055eb8b2579d710eb566728294f2ad8b2621`；
`1C.2-hardening/1C.3=d0bd571e6a937aac55850bcc09df6f41bf95ac99`；
`1C.6=2e1a2721b1c7e3c17a483a3d33bcd503a6a777ee`；
`1C.5=aa66e872f3206df9718493adbfef7445fb582a4f`；
`1C.5 qualification=dfd8f209f89b4980b9c3905d3e73c166b33bea2b`

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

## Task 1C.5

- 新增 31 个 mode 的封闭 `resolveFailureModeV1()` Core policy table，精确固化 continue、block、
  degrade、invocation、durable state、external effects、terminal reason、用户投影与 safe retry。
- 未提供 `knownExternalEffects` 时，所有动态继续/降级路径 fail closed 为 unknown；只有明确
  `none`/`known` 才可继续或降级，不允许从 UI 文案或入口类型推断副作用。
- run deadline 与 resource budget admission 两类 production producer 直接消费同一解析结果；
  process-tree limit 已覆盖 table semantics 与 terminal projection，但尚未声明 production
  producer 直接接线。snapshot recovery、TUI 与 CLI 均使用规范 terminal mapper。
- exact table、真实 producer、entrypoint 与恢复 conformance 共同守护，不把尚未接线的 RFC mode
  宣传为 production coverage。

## Task 1C.6

- `TerminalFocusStore` 把全部 React subscriber 复用为单一 stdin listener，首订阅开启
  DEC 1004，末退订移除 listener 并关闭 focus reporting。
- Kernel batch 在包含 `run.completed` 时创建命名 rewind snapshot；工具失败后的
  `provider.action_required` 与 terminal event 保持批内顺序；TUI `SET_EXITED` 保留已提交给
  Ink Static 的 streamed paragraph。
- PTY runner 每个 scenario 后采集协调进程 RSS、active resource 与 FD，并对持续正斜率
  fail closed；workspace trust 使用新增输出握手确认输入 handler 已就绪，并及时回收重启进程。

## 验证

- [Required run 30676359548](https://github.com/ferqx/kite-code/actions/runs/30676359548)：
  quality、unit、runtime-e2e、compaction-contract、tui-system 五个 job 全部通过；同一
  `dfd8f209f89b4980b9c3905d3e73c166b33bea2b` head 的 Session Log ACL、Platform Capability
  Probe、MCP native keyring 三个 workflow 全部通过；
- failure-mode 与 producer 定向回归：41 pass、0 fail、202 assertions；标准默认套件：
  2228 pass、6 skip、0 fail；
- TUI qualification：本地完整 suite 通过 5 个 harness 文件与 37 个 scenario 文件，资源趋势
  RSS 30→31 MiB、active 0→0、FD 5→5；slash command 提交统一等待 semantic receipt，
  direct Enter 与未清理 suggestion 输入由 AST contract 阻断；
- Task 1C.5 独立复核最终 GO，P0/P1/P2 均为 0；
- 独立只读复核：1C.6 GO、无 P0/P1；联合定向回归 333 pass/0 fail；
- 同一冻结快照连续两次完整 `bun run test:tui:system` 均 36/36，无 warning/timeout；两次趋势
  均为 RSS 30→31 MiB、active 0→0、FD 5→5；
- workspace trust 孤立连续 3 次均 4/4；本地 `--rerun-each 5` 为 20/20；
- 标准默认套件：2067 pass/6 skip/0 fail；
- `bun run check:docs-impact`、`bun run check:docs`、`bun run check:core-boundary`、
  `bun run typecheck`、Biome 和 `git diff --check`：通过；
- pre-commit golden：10 pass。

## 回滚、风险与未完成项

- `resourceBudgetV1=false` 时 production run fail closed；v17 及更早
  `legacy_unconfigured` snapshot 不允许热补余额。
- `terminalOutcomeV1=false` 只回滚客户端 rollout；production 客户端不得把 unknown/block/
  budget/saturation 显示为完成。
- soak/fault evidence 和 `MS:1C-DONE` 仍等待 1C.7 与 1C.8。
- Phase 2 Release Profile/Gate 尚未组合，本记录不生成 production artifact 或 production-ready
  结论。
