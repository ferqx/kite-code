# Shell 沙箱边界与并发审批队列优化完成记录

状态：completed（实现、文档与本地全量门禁完成；GitHub Actions 远程门禁待确认）

日期：2026-08-25

方案：[`2026-08-25-shell-sandbox-approval-queue-optimization.md`](../../plans/2026-08-25-shell-sandbox-approval-queue-optimization.md)

ADR：[`ADR-0137`](../../../adr/0137-shell-sandbox-durable-approval-queue.md)

## 1. 决策与 clean cutover

方案一已完成 State 27/SAQ epoch 的 clean cutover：

- `phase=planning|building` 与 `interactionMode=accept_edits|auto|full` 正交；Planning 非 Full 使用 Workspace read-only
  baseline，Planning/Building Full 直接执行 Full scope 并保留 Plan lifecycle。
- Shell 不使用程序名、Git subcommand 或 read-only grammar allowlist；Workspace 内隐藏目录、`.git`、`.env`、`.agents` 不按
  basename 拒绝，hard deny 仍不可覆盖。
- approval contract 只保留 `approve_once|same_command|reject`；Auto reviewer 只产生
  `approve_once|reject|ask_user`；Full 只由 `interactionMode=full` 表达，旧 Full grant 只作 inert historical fact。
- `pendingApprovals`、`activeApprovalId`、generation、queue sequence、Session grants、independent receipts 和
  `approval.batch_released` 成为 Kernel/Store durable authority；same-command 绑定完整 Session/workspace/cwd/executor/env/
  scope/effects/parser-executor revision identity，并以一个事务完成 grant-first atomic batch。
- 多 Subagent 共用 queue；只有同一轮并发 Explore children 派生 Auto。Continuation 保存 route/generation/sequence/binding 与
  parent/child/runtime identity；TUI 只投影 canonical events。Enter 是 exact once，Approval Esc 是 focused reject，Ctrl+C 是
  whole-turn cancel；`/permissions` 的 Session grant clear 由 canonical event 驱动。
- grant/review/continuation/capability recovery 遵循 grant-first、ack barrier、exactly-once attempt、late generation no-op 和
  no replay；三平台 scope projection 与 backend evidence 不一致时 unsupported/fail closed。

## 2. SAQ-00～SAQ-10 证据矩阵

| Task | 具名产出/验证入口 | 当前登记 |
| --- | --- | --- |
| SAQ-00 | `docs/adr/0137-shell-sandbox-durable-approval-queue.md`；`packages/agent-kernel/test/authorization.test.ts`；`packages/builtin-runtime/test/model-effect-coordinator.test.ts` | contract clean cutover；legacy shape fail closed 已纳入定向回归 |
| SAQ-01 | `packages/agent-kernel/test/shell-policy-matrix.test.ts`；`packages/builtin-runtime/test/sandbox-scope-contract.test.ts`；`tests/sandbox/platform-backends.test.ts` | 22 tests 中目标矩阵与 protected-name evidence 已具名；三平台 native qualification 仍以 Actions evidence 为准 |
| SAQ-02 | `packages/agent-kernel/test/approval-queue.test.ts`；`packages/runtime-storage-sqlite/test/approval-queue-recovery.test.ts`；`tests/runtime/subagent-approval-queue.test.ts` | State 27 queue/generation/sequence/replay contract |
| SAQ-03 | `packages/agent-kernel/test/authorization.test.ts`；`packages/agent-kernel/test/auto-review.test.ts`；`packages/runtime-host/test/approval-batch-recovery.test.ts` | 两 grant、旧 Full/旧 reviewer shape fail closed、完整 identity |
| SAQ-04 | `tests/runtime/subagent-approval-queue.test.ts`；`packages/runtime-host/test/approval-batch-recovery.test.ts`；`packages/runtime-storage-sqlite/test/approval-queue-recovery.test.ts` | batch release、独立 receipt、revision race、reopen/fault contract |
| SAQ-05 | `tests/subagent-runner.test.ts`；`tests/subagent-prepared-dispatch.test.ts`；`tests/subagent-continuation-codec.test.ts` | B 写集冻结；Human/Auto Subagent PTY 已通过，关键 continuation 与 terminal barrier 已具名覆盖 |
| SAQ-06 | `packages/builtin-runtime/test/prepared-execution-consumer.test.ts`；`tests/runtime/tool-pipeline-prepared.test.ts`；`tests/runtime/concurrent-shell-cancel.test.ts` | pre-GO zero host call、post-GO unknown/no replay、cleanup boundary |
| SAQ-07 | `tests/runtime/approval-interaction-semantics.test.ts`；`tests/session-manager.test.ts`；`tests/tui-system/scenarios/sandbox-mode.test.ts` | interactionMode revision、`/permissions` persistence、Full independent availability |
| SAQ-08 | `tests/tui-reducer.test.ts`；`tests/tui.test.ts tests/tui-replay-blocks.test.ts`（selected 574 pass / 0 fail）；`tests/tui-system/scenarios/approval-escape.test.ts` | queue projection、focused input、generation guards、Enter/Esc/Ctrl+C |
| SAQ-09 | `tests/tui-system/scenarios/subagent-approval.test.ts`；`tests/tui-system/scenarios/interrupt.test.ts`；`tests/sandbox/platform-capability-probe.test.ts` | recovery/PTY/platform contract；Auto Subagent terminal barrier 已由具名 PTY 回归覆盖，platform remote evidence 仍待最终门禁 |
| SAQ-10 | 本记录、ADR-0137、active docs、`docs/documentation-map.json`、Plans 注册表 | 文档写集完成；最终全量与 GitHub required checks 不在本记录预先宣称 |

本轮阶段性实测登记（均为具名定向证据，不替代最终 root/full suite）：agent-kernel 131、runtime-host 137、
builtin-runtime 198、runtime-storage-sqlite 13；核心组合 153；platform 102（另有 3 项 native skip）、Seatbelt 32、
fault/replay 35、TUI selected 574、session 134。Human/Auto Subagent PTY：3/0/26；关键 PTY 文件（approval 2、
cancel-successor 1、interrupt-resume 1、interrupt 4、plan 1、sandbox 1、subagent 3、tool-approve 1）均已具名
回归。B 写集另有 `tests/subagent-runner.test.ts` 34 pass / 158 expects，runner/executor/bootstrap subagent/
suspension 的定向 TypeScript 诊断为零。上述数字仍不替代最终 `test:all`、根 typecheck 或 GitHub required checks。

## 3. 20 个验收场景具名映射

| 场景 | 具名测试/证据入口 | 断言边界 |
| ---: | --- | --- |
| 1 | `packages/agent-kernel/test/shell-policy-matrix.test.ts`、`tests/shell-exec.test.ts` | Building baseline direct、无命令白名单 |
| 2 | `packages/builtin-runtime/test/sandbox-scope-contract.test.ts`、`tests/sandbox/platform-backends.test.ts` | hidden/.git/.agents scope parity |
| 3 | `tests/runtime/tool-pipeline-ordinary-attempt.test.ts`、`tests/runtime/tool-pipeline-prepared.test.ts`、`packages/runtime-host/test/approval-batch-recovery.test.ts` | exact approval、single dispatch、Host atomicity |
| 4 | `packages/agent-kernel/test/auto-review.test.ts`、`tests/runtime/model-controller-failures.test.ts`、`tests/runtime/approval-interaction-semantics.test.ts` | Auto approve/reject/ask_user |
| 5 | `tests/tui-system/scenarios/plan-mode-policy.test.ts`、`tests/tui-system/scenarios/sandbox-mode.test.ts` | Building/Planning Full direct，Plan lifecycle |
| 6 | `packages/agent-kernel/test/shell-policy-matrix.test.ts`、`tests/runtime/tool-controller.test.ts` | Planning read-only baseline、写能力不静默扩展 |
| 7 | `packages/agent-kernel/test/approval-queue.test.ts`、`tests/runtime/subagent-approval-queue.test.ts` | approve_once 单 invocation |
| 8 | `tests/runtime/subagent-approval-queue.test.ts`、`packages/runtime-host/test/approval-batch-recovery.test.ts` | same-command atomic batch、独立 receipts |
| 9 | `packages/agent-kernel/test/approval-queue.test.ts`、`packages/runtime-storage-sqlite/test/approval-queue-recovery.test.ts` | Session grant、new Session isolation |
| 10 | `packages/agent-kernel/test/approval-queue.test.ts`、`tests/runtime/scheduler.test.ts` | authorized_queued/concurrency |
| 11 | `tests/runtime/subagent-approval-queue.test.ts`、`packages/runtime-host/test/approval-batch-recovery.test.ts` | cancel matching review、late no-op |
| 12 | `packages/agent-kernel/test/approval-queue.test.ts`、`tests/runtime/concurrent-shell-cancel.test.ts` | terminal/cancelled 不复活 |
| 13 | `tests/runtime/subagent-approval-queue.test.ts`、`tests/subagent-prepared-dispatch.test.ts` | concurrent children、single focus |
| 14 | `tests/subagent-runner.test.ts`、`tests/tui-system/scenarios/subagent-approval.test.ts` | child tree 与 queue projection |
| 15 | `tests/runtime/approval-interaction-semantics.test.ts`、`tests/tui-system/scenarios/approval-escape.test.ts`、`tests/tui-system/scenarios/interrupt.test.ts` | Enter/Esc/Ctrl+C exact semantics |
| 16 | `packages/runtime-host/test/state-recovery.test.ts`、`packages/runtime-host/test/state-restore.test.ts`、`packages/runtime-storage-sqlite/test/approval-queue-recovery.test.ts` | restart queue/grant/attempt recovery |
| 17 | `tests/session-manager.test.ts`、`tests/tui-system/scenarios/sandbox-mode.test.ts`、`tests/tui-reducer.test.ts` | `/permissions` mode/session persistence |
| 18 | `tests/runtime/approval-interaction-semantics.test.ts`、`packages/agent-kernel/test/authorization.test.ts` | mode switch、无 Full grant |
| 19 | `tests/subagent-continuation-codec.test.ts`、`tests/subagent-prepared-dispatch.test.ts`、`tests/runtime/approval-interaction-semantics.test.ts` | identity revision/route resume |
| 20 | `tests/sandbox/platform-backends.test.ts`、`tests/sandbox/windows-restricted-token.test.ts`、`tests/sandbox-bwrap-executor.test.ts`、`tests/tui-system/scenarios/sandbox-mode.test.ts` | 三平台 projection、unsupported fail closed |

## 4. 最终门禁登记

本记录不虚构尚未观察到的最终结果。主 Agent 必须在实现/文档共同收敛后实际运行并填写：

| Gate | 状态 | 证据 |
| --- | --- | --- |
| `bun run typecheck` | passed | 根工程与 7 个 Runtime workspace 全部通过 |
| `bun run test:all` | passed | 默认套件 3544 pass / 6 skip / 0 fail / 15812 expects；7 个 workspace 全绿；39 个隔离 PTY 场景文件全绿 |
| `bun run test:e2e` | passed | 7 pass / 0 fail / 32 expects |
| `bun run test:runtime:soak` | passed | CI profile 7/7 cases；全部 required terminal evidence、State invariant 与 cleanup 通过，0 orphan |
| `bun run check:docs-impact` | passed | Documentation impact checks passed |
| `bun run check:docs` | passed | 文档结构与计划治理通过：83 completed、25 superseded、0 optional |
| `git diff --check` | passed | 最终实现、测试与文档 diff 无 whitespace error |
| GitHub Actions required checks | waiting_ci | 待提交/推送当前新任务分支后由主 Agent 观察；本记录不预填链接 |

若任一门禁失败，按源码/测试事实修复后重新运行；不得用 `--no-verify`、删除测试、放宽断言或恢复旧授权兼容路径绕过。
