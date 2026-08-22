# RMV1-13 Shell/Sandbox 完成记录

状态：completed

日期：2026-08-20

权威来源：accepted Runtime Modularization RFC、ADR-0123/0124/0125、
`2026-08-19-kite-runtime-modularization-v1-implementation.md`

前置证据：`2026-08-20-rmv1-12-filesystem-read-write.md`

实施 baseline：`af5a512305207dcaaeb40c334d0b914befbc3598`

## 交付结论

RMV1-13 已把 Shell/Sandbox operation 与 process supervision 物理迁入目标边界：

- `@kite/runtime-spi` 唯一拥有 JSON-safe `SandboxExecutionProviderV1`、prepared plan、cleanup、failure 与 receipt
  contract；根 `src/protocol/sandbox-execution-provider.ts` 只保留 RMV1-16 前的 compatibility re-export；
- `@kite/builtin-runtime` 唯一拥有 `builtin:shell_execute` definition/executor，以及 Sandbox backend、grant、Local
  Provider、protected-path、network、platform preparation 与 no-spawn qualification 领域语义；Core 旧实现路径只保留
  compatibility re-export；
- `@kite/runtime-host` 唯一拥有异步 process spawn primitive、POSIX supervisor、process identity/lock、bounded output
  drain 与 process-tree cleanup；POSIX child、Windows lifecycle adapter 和 host-shell adapter 都只能调用该 primitive；
- `apps/kite/src/sandbox/` 唯一组合 native/host-shell availability；RMV1 迁移期通过待 RMV1-16 删除的 Core
  compatibility exports 访问 concrete Sandbox implementation，未新增第二 concrete package composition root 或
  architecture exception；
- `builtin:shell_execute` 已从 `LegacyRuntimeModule` 原子删除，Core `shell_execute` ToolSpec 只保留完全相同的 model
  schema、Policy、approval 与 ExecutionTraits。Controller 只构造 exact binding/request，Runner 只在 durable
  invocation/attempt acknowledgement 后注入当前 Shell mechanism；
- 每个 operation 和 process spawn 均只有一个 production owner，不存在 try-new-catch-old、异常 fallback、双
  handler、双写或 post-dispatch replay。当前四个 Builtin module 合计拥有 16 个 operation，Legacy module 剩 13 个。

## 行为与安全等价

- approval、network mode、filesystem mode、execution boundary、protected path、resource limit 与 command timeout
  语义未改变；
- 当前 native/host-shell startup availability 与 typed pre-dispatch unavailable + confirmed-cleanup fallback 保持
  不变；cleanup 未确认、dispatch 已开始、cancellation 或 forged identity 时仍 fail closed，不会重放用户命令；
- allocating intent 仍在任何 runtime allocation/backend usability probe 之前 durable ack；ready/dispatch ack 仍在
  user-command spawn 之前；prepared plan 仍 single-use，并精确绑定 approved argv 与 canonical Workspace；
- POSIX process identity/lock、descendant containment、fixed-deadline drain、data/control root cleanup，以及 Windows
  restricted-token protocol V6、Job empty/ACL revoke/runtime cleanup 语义未改变；
- 未执行 ADR-0123 的 approval 前 environment 投影与 no-post-approval-fallback 切换；该行为变化仍属于 RAV1；
- 未引入 Project/Composition identity、统一 authenticity、cross-Host fence、DataOrigin/Egress/Credential IR、State
  26、Store 5 或新 epoch。

## Owner、Delete 与 Source 清单

- owner manifest 的 `shell-sandbox` 与 `builtin-shell` responsibility 已锚定
  `packages/builtin-runtime/src/rmv1-13-operations.ts#createRmv113RuntimeModuleV1`；
- Legacy delete manifest 为 100 条，新增规则证明 Legacy shell operation、Core ToolSpec concrete executor、Core Local
  Provider/grant implementation、Core async spawn owners和旧 App sandbox source 不再拥有生产实现；
- Runtime SPI/Builtin Sandbox/Host process-supervisor 的精确 public exports 已登记；生成事实为 291 个 source、422 个
  test consumer 与 691 个 package public export；
- package graph 保持 7 个 package、12 条 edge 和唯一 `apps/kite/src/bootstrap.ts` concrete composition root；两条
  architecture exception 仍仅为 RMV1-08 的精确 Legacy module 过渡项，没有新增 bypass；
- 静态检索确认 `src/core/execution/sandbox-execution`、`src/core/sandbox`、`src/core/tools/shell.ts`、Builtin Sandbox 与
  App Sandbox 中没有直接 `Bun.spawn(...)` owner；唯一实际绑定为
  `packages/runtime-host/src/process-spawn.ts#spawnRuntimeHostProcessV1`。Builtin 的同步 availability/qualification probe
  不是 user-command dispatch owner。

Generated facts 继续证明 Runtime State schema 25、Runtime Store schema 4、epoch
`kite-runtime-2026-08-18`；29 operation、19 responsibility、100 Legacy rule、291 source、422 test consumer、691
public export 与 2 architecture exception 均闭合。

## Gate 证据

| 命令 | 结果 |
| --- | --- |
| `bun test tests/execution/sandbox-execution-provider.test.ts` | 22 pass、1 platform skip、0 fail |
| `bun test tests/sandbox/execution-boundary.test.ts tests/sandbox/network-boundary.test.ts` | 39 pass、0 fail |
| `bun test tests/runtime/concurrent-shell-cancel.test.ts` | 2 pass、0 fail |
| `bun run test:runtime:fault` | 33 pass、0 fail |
| Shell/App/Windows/Session/Tool/Schema 扩展 parity | 246 pass、3 Windows native E2E platform skip、0 fail |
| Host/Builtin package + compiled POSIX supervisor 并行复验 | 55 pass、1 platform skip、0 fail；compiled CLI handshake 通过 |
| `bun run scripts/run-runtime-workspace-script.ts test` | passed；7 workspace、75 pass、0 fail |
| `bun run scripts/check-runtime-modularization-manifests.ts` | passed；5 generated、29 operation、19 responsibility、100 Legacy、State 25/Store 4/原 epoch |
| `bun run check:runtime-packages`、`bun run check:core-boundary` | passed；7 package、12 edge、唯一 composition root，Core boundary closed |
| `bun run typecheck`、`bun run build` | passed；7 workspace |
| `bun run format:check` | passed；仅保留 16 条既有测试 `any` warning，0 error |
| `bun run check:docs-impact`、`bun run check:docs` | passed |
| `git diff --check` | passed |

## 阶段边界

RMV1-13 completion evidence 已闭合，形成可审计 checkpoint。下一阶段为 RMV1-14 Verification/Subagent；RMV1 总计划
仍为 active，RAV1 继续 blocked。RMV1-14 不得改变 State 25、Store 4、epoch，也不得提前引入 RAV1
authority/identity/fencing/format 语义。
