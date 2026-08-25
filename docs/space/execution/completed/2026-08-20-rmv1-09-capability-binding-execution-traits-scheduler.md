# RMV1-09 Capability Binding 与 ExecutionTraits Scheduler 完成记录

状态：completed

日期：2026-08-20

权威来源：accepted Runtime Modularization RFC、ADR-0123/0124/0125、
`2026-08-19-kite-runtime-modularization-v1-implementation.md`

前置证据：`2026-08-20-rmv1-08-runtime-spi-registry-legacy-module.md`

实施 baseline：`af5a512305207dcaaeb40c334d0b914befbc3598`

## 交付结论

RMV1-09 已把 Capability binding provider 与 name-free scheduling authority 原子切到目标边界：

- `@kite-ai/runtime-spi` 冻结 Capability definition、disclosure、binding、proposal、intent 与 authorized effect 的进程内
  contract，并提供 immutable Registry snapshot 与纯 arbitration；arbitration 只校验精确 capability/revision/schema/binding
  identity，返回 typed failure，不执行 Policy、grant、Provider 或 operation；
- `@kite-ai/builtin-runtime#createCapabilityBindingV1` 是唯一 production binding provider，继续产生与 State 25 完全相同的
  `CapabilityBindingV1` shape 与 canonical SHA-256；旧 Catalog 方法只保留为调用该 provider 的 compatibility wrapper，
  不存在第二套 digest 或 binding owner；
- `@kite-ai/agent-kernel` 新增纯 `ExecutionTraitsV1`、`ResourceScopeV1` 与 batch selector，只基于 access、resource
  scope、conflict key、isolation、causal/concurrency group、interaction barrier 与 lease requirement 作确定性裁决；
- ToolSpec 静态声明 execution traits，Core 在调度前以已冻结 ToolSpec、State 25 已持久化 call classification 与 causal
  identity 做投影，不向 State/Event 增加字段；
- Scheduler/Runner 已删除 `PARALLEL_READ_TOOL_NAMES`、`task` 与 `shell_execute` 的具体 tool-name branch。只读
  workspace/network/process/subagent 可按 traits 并行；workspace-writing sibling 即使处于 full access 也因 exclusive
  workspace/conflict traits 串行。

没有 try-new-catch-old、异常 fallback、双 handler、双写或扩大授权；现有 Policy、approval、barrier、budget、lease
与 completion 行为保持不变。

## Owner、Delete 与 Source 清单

四张人工清单已更新为 `RMV1-09` 并由生成事实闭包验证：

- `capability-binding-provider` current/target owner 为 `target-builtin-operation`，production entry 锚定
  `packages/builtin-runtime/src/capability-binding.ts#createCapabilityBindingV1`；
- `execution-traits-scheduler` current/target owner 为 `target-pure-kernel`，production entry 锚定
  `packages/agent-kernel/src/execution-traits.ts#selectSchedulableEffectBatchV1`；
- Scheduler read-name allowlist、task-name branch 与 Runner shell-name branch 均标为 deleted，并有源码禁词测试；
- agent-kernel ExecutionTraits、SPI lifecycle/arbitration 与 Builtin binding 的 public exports 均已进入 source migration
  manifest；generated facts 从当前 package graph、exports、source/test consumer 与 State/Event/Store 重新生成。

29 个尚未迁移的 concrete operation 继续由唯一 `LegacyRuntimeModule` owner 承接；RMV1-10 才迁移
`tool_search` vertical slice。本阶段没有提前增加 Builtin concrete operation module。

## Replay qualification 与格式冻结

ExecutionTraits 与 Builtin binding 已加入 Required replay qualification closure。当前 closure 为 265 个文件，摘要为
`sha256:0066b3b79d430e4445efca0ec0ebe648e2d3ceb8a34020c5e12a6b62c314ffbf`；parser 外 manifest authority 为
`sha256:aaa4dfd94cee83949f5078590b3dfe982722e27ff7ef1c8ed3c528b8ce92c6a1`。Required replay 在 macOS
seatbelt 网络隔离下通过，证据仍为 metadata-only。

Generated facts 与回归共同证明：

- Runtime State schema 25、30 个 root field；
- Runtime Event codec 136 个 discriminant；
- Runtime Store schema 4、epoch `kite-runtime-2026-08-18`、8 表、3 index；
- operation 29、responsibility 18、Legacy rule 43、architecture exception 2；
- 没有 ProjectIdentity、Composition identity、统一 cryptographic authenticity、cross-Host fence、
  DataOrigin/Egress/Credential 重写、State 26、Store 5、新 epoch 或 RAV1 production artifact。

## Gate 证据

| 命令 | 结果 |
| --- | --- |
| `bun test tests/runtime/scheduler.test.ts tests/runtime/tool-concurrency-budget.test.ts` | 41 pass、0 fail |
| `bun test tests/runtime/tool-barrier.test.ts tests/subagent-approval.test.ts` | 34 pass、0 fail |
| `bun run eval:replay:required` | passed；approved suite 在 macOS seatbelt 网络隔离下执行 |
| `bun test tests/evals/agent-tasks/replay-gate.test.ts` | 8 pass、0 fail |
| `bun test packages/agent-kernel/test packages/runtime-spi/test packages/builtin-runtime/test tests/runtime/runtime-scheduling-policy.test.ts tests/execution/tool-pipeline-stages.test.ts tests/scripts/runtime-modularization-manifests.test.ts tests/scripts/check-runtime-packages.test.ts tests/evals/agent-tasks/replay-gate.test.ts` | 73 pass、0 fail |
| `bun run scripts/check-runtime-modularization-manifests.ts` | passed；5 generated、29 operation、18 responsibility、43 Legacy、294 source、417 consumer、159 export、2 exception；State 25/Store 4/原 epoch |
| `bun run check:runtime-packages` | passed；7 workspace、12 edge、1 composition root |
| `bun run typecheck` | passed；root + 7 workspace |
| `bun run check:docs-impact`、`bun run check:docs` | passed |
| `bun run format:check` | passed；仅保留 `tests/session-manager.test.ts` 既有 16 条 `any` warning |
| Scheduler/Runner concrete tool-name `rg` scan | 0 match |

## 阶段边界

RMV1-09 completion evidence 已闭合并形成 stop-and-report checkpoint。下一阶段为 RMV1-10 `tool_search` pilot
slice；RMV1 总计划仍为 active，RAV1 继续 blocked。RMV1-10 尚未开始，State 25、Store 4 与当前 epoch 必须继续
保持，只有 RMV1-16 completion evidence 闭合后才可解除 RAV1 阻塞。
