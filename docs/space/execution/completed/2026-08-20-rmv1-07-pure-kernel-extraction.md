# RMV1-07 Pure Kernel extraction 完成记录

状态：completed

日期：2026-08-20

权威来源：accepted Runtime Modularization RFC、ADR-0123/0124/0125、
`2026-08-19-kite-runtime-modularization-v1-implementation.md`

前置证据：`2026-08-20-rmv1-06-host-lifecycle-cancellation-recovery.md`

实施 baseline：`af5a512305207dcaaeb40c334d0b914befbc3598`

## 交付结论

RMV1-07 已把 production transition decision 原子切到私有纯包 `@kite-ai/agent-kernel`：

- `decide` 处理 session/revision admission、事件规范化、digest/idempotency、逐事件 reduce/invariant、envelope 与
  pending-effect selection；`reduce` 和 `selectPendingEffects` 提供相同纯边界；
- `DecisionFacts` 只接受递归 JSON-safe plain values，拒绝 callback/getter、Date、symbol、cycle、非有限数与
  `-0`；clock、allocated/known event ID、workspace、policy/provider、protected-path、network、
  execution-boundary 与 attempt facts 都在包外显式投影；known event IDs 保持原进程内幂等窗口，不扩大持久
  State 25 的 4096 条 bounded tail；
- package import closure 不含 Node/Bun/process/Date/random/timer/network、Store、Host、SPI、App、Provider 或
  Executor authority；
- `@kite-ai/runtime-host` 唯一把 Contract Command 翻译成私有 `KernelInput`，并在 bridge 前验证 command owner、
  session、causation 与 revision identity；
- `AgentKernel.processEvent/processEventBatch` 先消费纯 decision，再通过 App 注入的 Store 4 port 原子提交
  event/snapshot；只有 commit 成功才推进进程内 State；
- Host 只在 applied receipt 后为 exact session、operation、operationId 与 committed revision 签发单次
  `AuthorizedEffect`；`LegacyAuthorizedExecutionAdapter` 对 identity mismatch 与重复消费 fail closed。

没有 try-new-catch-old、异常 fallback、双写、双 handler 或第二 transition owner。

## State 25 domain compatibility 与后续删除边界

State 25 的具体 event normalization、domain reducer、invariant 与 scheduler 仍由
`src/core/runtime/kernel.ts` 作为固定 `KernelDomain` 在 composition 时绑定。这一 binding 只能被纯 Kernel 调用，
不能自行持久化或执行 effect；它对应 owner/delete matrix 中 RMV1-16 的 `state-event-reducer-domains` 物理拆分，
不是提前伪造完成的 domain relocation。

`openLegacyKernelCoordinatorV1` 只保留当前格式的 restore/recovery/Store view 协调，RMV1-16 删除中央文件时一并
收敛。旧 production symbol `RuntimeKernelControl` 与 `createAgentKernel` 已删除，source/delete verifier 证明源码
中不存在这两个定义或调用。

唯一 App adapter 的 dispatch closure 仍进入尚待 RMV1-08 至 RMV1-15 按 operation 迁移的 legacy/builtin 实现。
本阶段没有把具体 Tool/Model/Context/Filesystem/MCP/Sandbox/Verification operation 宣称为已迁移，所以没有保留
同一 operation 的新旧 policy/handler；后续阶段仍必须逐项删除相应旧 branch。

## Replay authority

Pure Kernel public entry 与 implementation 已加入 Required qualification import closure。closure 算法升级为
`typescript-preprocess-workspace-import-closure-v2`，精确解析 `#agent-kernel` 与 `@kite-ai/*` workspace exports：

- entrypoint：PS-03 journey source/test 与 `packages/agent-kernel/src/index.ts`；
- file count：257；
- closure digest：`sha256:3f4e536655a548891448ab31059a53a17366cda80d505a646122ea873dd39aa4`；
- parser 外 manifest authority：
  `sha256:bea56ea289b74ea6f7151c8fd11b69333cec3c5fe2722b82645446c3483d4b71`。

suite revision、case、fixture、cassette、catalog、oracle、risk matrix 与 replay outcome 均未改变。没有录制新
baseline、修改 cassette/oracle、启用 credential/live Provider、fallback 或 production Source cutover。

## Owner、Delete 与 Source 清单

四张人工清单已更新为 `RMV1-07`：

- `kernel-decision-reducer` current/target owner 为 `target-pure-kernel`，production entry 锚定
  `packages/agent-kernel/src/kernel.ts#decide`；
- `RuntimeKernelControl` 与 `createAgentKernel` 标为 `deleted`；State/Event/domain central files 与
  `openLegacyKernelCoordinatorV1` 保持 RMV1-16 compatibility；
- `LegacyAuthorizedExecutionAdapter` 标为 present，并锁定 RMV1-16 删除；
- Agent Kernel 14 个新 public symbol 与 Host translation 6 个 symbol 均有 source migration disposition；
- generated manifests 继续从真实 source/Store/package graph/exports 提取，architecture exception 为 0。

## 格式与范围冻结

Generated facts 与运行测试共同证明：

- Runtime State schema 25、30 个 root field；
- Runtime Event codec 136 个 discriminant；
- Runtime Store schema 4、epoch `kite-runtime-2026-08-18`、8 表、3 index；
- snapshot、event union、codec、reducer terminal 与 replay outcome 保持等价；
- 没有 ProjectIdentity、Composition identity、统一 cryptographic sealing、cross-Host fence、
  DataOrigin/Egress/Credential 重写、State 26、Store 5、新 epoch 或 RAV1 production artifact。

## Gate 证据

| 命令 | 结果 |
| --- | --- |
| `bun test tests/runtime/kernel.test.ts tests/runtime/reducer.test.ts` | 151 pass、0 fail |
| `bun test tests/runtime/runtime-scheduling-policy.test.ts tests/runtime/completion-guard.test.ts` | 25 pass、0 fail |
| `bun run eval:replay:required` | passed；approved suite 在 macOS Seatbelt no-egress isolation 下通过，metadata-only report |
| `bun run check:runtime-packages` | passed；7 workspace、11 edge、1 composition root；Kernel ambient authority negative Gate 闭合 |
| `bun run scripts/check-runtime-modularization-manifests.ts` | passed；5 generated、29 operation、18 responsibility、38 Legacy、292 source、417 consumer、116 export、0 exception；State 25/Store 4/原 epoch |
| `bun test packages/agent-kernel/test packages/runtime-host/test apps/kite/test/legacy-runtime-access.test.ts` | 41 pass、0 fail；包含 canonical facts、process-local idempotency、translation tamper、single-use/mismatch 负例 |
| `bun run typecheck` | passed；root + 7 workspace |
| `bun run check:docs`、`bun run check:docs-impact` | passed |
| `bun run format:check`、`git diff --check` | passed |

## 阶段边界

RMV1-07 completion evidence 已闭合并形成 stop-and-report checkpoint。下一阶段为 RMV1-08 Runtime SPI、
Registry 与 Legacy executor；RMV1 总计划仍为 active，RAV1 继续 blocked。RMV1-08 尚未开始，只有 RMV1-16
completion evidence 闭合后才可解除 RAV1 阻塞。
