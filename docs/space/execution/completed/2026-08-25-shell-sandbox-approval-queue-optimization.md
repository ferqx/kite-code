# Shell 沙箱边界与并发审批队列优化完成记录

状态：completed（SAQ-00～SAQ-10、20 个验收场景、本地全量与实现 HEAD `7200f2da` 的 GitHub Actions 全部通过）

日期：2026-08-25

方案：[`2026-08-25-shell-sandbox-approval-queue-optimization.md`](../../plans/2026-08-25-shell-sandbox-approval-queue-optimization.md)

ADR：[`ADR-0137`](../../../adr/0137-shell-sandbox-durable-approval-queue.md)、
[`ADR-0138`](../../../adr/0138-silent-session-format-compatibility.md)

Pull Request：[#63](https://github.com/ferqx/kite-code/pull/63)

## 1. 决策与 clean cutover

后续持久格式兼容决策见 ADR-0138：本记录中的 clean cutover 仍约束当前 writer、queue/grant 和执行权威，但不再表示
已知历史会话必须不可达。State 26/Store 5 会话可在选中后静默导入安全历史投影；未知格式静默忽略，旧授权不复活。

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
| SAQ-01 | `packages/agent-kernel/test/shell-policy-matrix.test.ts`；`packages/builtin-runtime/test/sandbox-scope-contract.test.ts`；`tests/sandbox/platform-backends.test.ts` | 22 tests 中目标矩阵与 protected-name evidence 已具名；三平台 native qualification 已由 Platform run 32794845103 通过 |
| SAQ-02 | `packages/agent-kernel/test/approval-queue.test.ts`；`packages/runtime-storage-sqlite/test/approval-queue-recovery.test.ts`；`tests/runtime/subagent-approval-queue.test.ts` | State 27 queue/generation/sequence/replay contract |
| SAQ-03 | `packages/agent-kernel/test/authorization.test.ts`；`packages/agent-kernel/test/auto-review.test.ts`；`packages/runtime-host/test/approval-batch-recovery.test.ts` | 两 grant、旧 Full/旧 reviewer shape fail closed、完整 identity |
| SAQ-04 | `tests/runtime/subagent-approval-queue.test.ts`；`packages/runtime-host/test/approval-batch-recovery.test.ts`；`packages/runtime-storage-sqlite/test/approval-queue-recovery.test.ts` | batch release、独立 receipt、revision race、reopen/fault contract |
| SAQ-05 | `tests/subagent-runner.test.ts`；`tests/subagent-prepared-dispatch.test.ts`；`tests/subagent-continuation-codec.test.ts` | B 写集冻结；Human/Auto Subagent PTY、关键 continuation/terminal barrier 与 Required Linux TUI shards 全部通过 |
| SAQ-06 | `packages/builtin-runtime/test/prepared-execution-consumer.test.ts`；`tests/runtime/tool-pipeline-prepared.test.ts`；`tests/runtime/concurrent-shell-cancel.test.ts` | pre-GO zero host call、post-GO unknown/no replay、cleanup boundary |
| SAQ-07 | `tests/runtime/approval-interaction-semantics.test.ts`；`tests/session-manager.test.ts`；`tests/tui-system/scenarios/sandbox-mode.test.ts` | interactionMode revision、`/permissions` persistence、Full independent availability |
| SAQ-08 | `tests/tui-reducer.test.ts`；`tests/tui.test.ts tests/tui-replay-blocks.test.ts`（selected 573 pass / 0 fail）；`tests/tui-system/scenarios/approval-escape.test.ts` | queue projection、focused input、generation guards、Enter/Esc/Ctrl+C |
| SAQ-09 | `tests/tui-system/scenarios/subagent-approval.test.ts`；`tests/tui-system/scenarios/interrupt.test.ts`；`tests/sandbox/platform-capability-probe.test.ts` | recovery/PTY/platform contract；Auto Subagent terminal barrier、四个 TUI shards 与 Ubuntu/macOS/Windows native probe 全部通过 |
| SAQ-10 | 本记录、ADR-0137、active docs、`docs/documentation-map.json`、Plans 注册表 | 文档写集、最终本地全量、Required、三平台与其余 PR workflows 全部收敛 |

触达范围定向实测登记（与下表最终 root/full suite 共同构成证据）：agent-kernel 131、runtime-host 137、
builtin-runtime 198、runtime-storage-sqlite 13；核心组合 153；跨平台 Bun 1.3.14 bundle 126 pass（另有 4 项 native skip）、
Seatbelt 32、fault/replay 35、TUI selected 573、TUI reducer 280。Human/Auto Subagent PTY：3/0/26；关键 PTY 文件（approval 2、
cancel-successor 1、interrupt-resume 1、interrupt 4、plan 1、sandbox 1、subagent 3、tool-approve 1）均已具名
回归。B 写集另有 `tests/subagent-runner.test.ts` 34 pass / 158 expects，runner/executor/bootstrap subagent/
suspension 的定向 TypeScript 诊断为零。这些定向证据与下述最终 `test:all`、根 typecheck 和 GitHub checks 共同登记。

仓库未提供可靠的全仓 coverage threshold script；因此本记录不虚构一个全仓覆盖百分比。触达范围的覆盖证据由上表、
下述 20 场景逐项映射、State/Store/Host fault+replay、三平台 contract 以及真实 PTY journey 共同组成，并同时包含
legacy shape、stale generation、跨 turn、late result、rollback、restart、unsupported backend 等负向分支。

## 3. 20 个验收场景具名映射

| 场景 | 具名测试/证据入口 | 断言边界 |
| ---: | --- | --- |
| 1 | `packages/agent-kernel/test/shell-policy-matrix.test.ts`、`tests/shell-exec.test.ts` | Building baseline direct、无命令白名单 |
| 2 | `packages/builtin-runtime/test/sandbox-scope-contract.test.ts`、`tests/sandbox/platform-backends.test.ts` | hidden/.git/.agents scope parity |
| 3 | `tests/runtime/tool-pipeline-ordinary-attempt.test.ts`、`tests/runtime/tool-pipeline-prepared.test.ts`、`packages/runtime-host/test/approval-batch-recovery.test.ts`、`tests/runtime/approval-interaction-semantics.test.ts`、`tests/tui-system/scenarios/tool-lifecycle.test.ts` | exact approval、single dispatch、Host atomicity、拒绝后 exactly-once terminal 且无模型续接 |
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

下表只登记主 Agent 实际运行或通过 `gh` 观察到的最终结果：

| Gate | 状态 | 证据 |
| --- | --- | --- |
| `bun run typecheck` | passed | 根工程与 7 个 Runtime workspace 全部通过 |
| `bun run test:all` | passed | 最终修复后默认套件 3559 pass / 6 skip / 0 fail / 15857 expects；7 个 workspace 全绿；39 个隔离 PTY 场景文件全绿 |
| `bun run test:e2e` | passed | 7 pass / 0 fail / 32 expects |
| `bun run test:runtime:soak` | passed | CI profile 7/7 cases；全部 required terminal evidence、State invariant 与 cleanup 通过，0 orphan / 0 residual；最终本地 Bun 1.3.14 digest `sha256:f1626624df178cfd6f5c9acbc4bf878df6da4352bef2cdad15b18fbad80ad066`，Required Bun 1.3.14 digest `sha256:79a0db167c4b83fb65bf22ad4d5d3e663c776fdd47fb6eb6af12bbc628451d0f` |
| `bun run check:core-boundary` / `check:runtime-packages` | passed | Core boundary 通过；7 packages / 12 edges / 单一 App composition root |
| `bun run check:docs-impact` | passed | Documentation impact checks passed |
| `bun run check:docs` | passed | 文档结构与计划治理通过：83 completed、25 superseded、0 optional |
| `git diff --check` / `bun run format:check` | passed | 无 whitespace error；Biome 0 error（23 warnings / 6 infos 为既有非阻断诊断） |
| GitHub Actions required checks | passed | [PR #63](https://github.com/ferqx/kite-code/pull/63) implementation HEAD `7200f2da`： [Required 32794845123](https://github.com/ferqx/kite-code/actions/runs/32794845123) 的 unit、quality、runtime-e2e、compaction、fault-soak、TUI shard 0/1/2/3 与 aggregate 全绿；[Platform 32794845103](https://github.com/ferqx/kite-code/actions/runs/32794845103) 的 Ubuntu 24.04、macOS 15 ARM64、Windows 2025 x64 全绿；[OSS RC](https://github.com/ferqx/kite-code/actions/runs/32794845109)、[Execution Boundary](https://github.com/ferqx/kite-code/actions/runs/32794845100)、[Session ACL](https://github.com/ferqx/kite-code/actions/runs/32794845169)、[MCP keyring](https://github.com/ferqx/kite-code/actions/runs/32794845198) 全绿 |

## 5. ADR-0138 历史会话兼容后续

State 27/SAQ clean cutover 后续按用户升级兼容要求新增 ADR-0138。current writer 与执行权威仍只接受 State 27；Store 发现
静默忽略未知 schema/epoch，明确的 State 26/Store 5 profile 只在用户选中 exact session 后原子导入。迁移终止旧 active
turn/task，清空旧 Full、approval/grant/receipt、invocation、effect lease、Subagent continuation 与 recovery authority；
State 26 file preimage 也作为旧 effect authority 清空。未知旧 event 只保留为 inert journal fact。单个
snapshot/event/named recovery point 损坏只使该会话打开失败，健康历史和
新会话继续可用，TUI 不再进入全局历史服务不可用状态。

具名验证入口为 `packages/agent-kernel/test/state-migration.test.ts`、
`packages/runtime-host/test/state-compatibility.test.ts`、
`packages/runtime-storage-sqlite/test/compatibility-store.test.ts`、
`apps/kite/test/state-store-compatibility.test.ts`、`apps/kite/test/session-compatibility.test.ts` 与
`tests/tui-system/scenarios/session-legacy-compatibility.test.ts`。真实用户 Store 的只读备份审计覆盖 35 个 State 26 会话：
35/35 完成 lazy import 与 current Host restore；诊断副本随后删除，source Store 未作为 writer 打开。

该审计同时复现了合法的 `WAL present / SHM absent` current target 形态：旧分类器会把它误判为未知 target，导致会话选择后
没有执行导入。当前实现改为复用隔离的 current Store preflight 重建临时 WAL 索引，并增加精确回归；named recovery point
不再被静默丢弃，任一语义/identity 失败都只隔离所选会话。
历史 source 的任意 WAL/SHM sidecar 形态同样只在 no-follow 临时副本中读取，且源 sidecar identity、mtime 与字节不变；
这避免只读 SQLite 连接更新真实 SHM 后被 source fingerprint 自身拒绝。CLI 在创建 Runtime session 前先完成
exact resume preparation，损坏历史不会被同 ID 空会话遮蔽。current-format named snapshot/preimage 还验证 head 上界、
Workspace containment、traversal 与 NUL。

若任一门禁失败，按源码/测试事实修复后重新运行；不得用 `--no-verify`、删除测试、放宽断言或恢复旧授权兼容路径绕过。
