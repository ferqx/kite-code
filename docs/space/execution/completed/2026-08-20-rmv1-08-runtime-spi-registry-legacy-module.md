# RMV1-08 Runtime SPI、Registry 与 LegacyRuntimeModule 完成记录

状态：completed

日期：2026-08-20

权威来源：accepted Runtime Modularization RFC、ADR-0123/0124/0125、
`2026-08-19-kite-runtime-modularization-v1-implementation.md`

前置证据：`2026-08-20-rmv1-07-pure-kernel-extraction.md`

实施 baseline：`af5a512305207dcaaeb40c334d0b914befbc3598`

## 交付结论

RMV1-08 已把 production Runtime module registry 与 lifecycle 原子切到私有 SPI/Host 边界：

- `@kite-ai/runtime-spi` 冻结 `RuntimeModuleV1` manifest/lifecycle、Capability definition/binding/executor、
  Execution request/grant/receipt/context、ContextSource/ContextCompiler port、Receipt normalizer 与受控 execution
  adapter；这些是可信进程内私有契约，不是公开 Plugin ABI 或恶意代码隔离；
- Registry 对 module ID、provider ID、operation owner、Capability ID、Executor、ContextSource、normalizer 与
  adapter 执行 exact duplicate rejection，Executor 必须匹配 Capability provider/revision；不存在 last-wins；
- scoped registration writer 在每个同步 `register()` 返回后封闭；module 按声明顺序启动、反向释放，生命周期
  调用有界；partial startup 释放全部 module 并 fail closed，不形成 degraded fallback；
- `@kite-ai/runtime-host#createRuntimeHost` 对同一 module list 只构造一次 Registry，start 先完成 module lifecycle 再
  hydrate/recover；Host 从固定 ID 取得唯一 execution bridge，已删除独立 `createLegacyAccess` /
  `RuntimeHostExecutionBridgeFactory` 旁路；
- Host dispose 先关闭 bridge，再反向释放 module，最后关闭 Store 4 storage；bridge 或 module cleanup 失败仍会
  尝试其余 cleanup，并以聚合错误 fail closed。

没有 try-new-catch-old、异常 fallback、双写、双 handler、热替换或第二 Registry owner。

## LegacyRuntimeModule 与 operation owner

`apps/kite/src/bootstrap/legacy/LegacyRuntimeModule.ts` 是唯一临时 composition adapter。它包装唯一
`LegacyRuntimeAccess`，通过 Host `modules` 参数注册，并在 manifest 中精确声明 owner manifest 的全部 29 个尚未
迁移 operation。自动测试把两份列表排序后逐项比较，任何增删漂移都会失败。

`createBuiltinRuntimeModules()` 在本阶段返回冻结空列表；这不是缺失 implementation，而是避免在 RMV1-10 之前
为同一 operation 虚构 builtin owner。当前 ToolSpec、Filesystem、Sandbox、Subagent、Model 等具体实现仍由各自
owner manifest 中的单一 legacy production entry 执行。后续 vertical slice 只能从 Legacy list 删除 operation，
同时由一个 concrete builtin module 接管并删除旧 branch。

App 对 SPI 的迁移兼容边只登记两条精确 exception：

- `LegacyRuntimeModule.ts -> @kite-ai/runtime-spi`；
- `LegacyRuntimeModule.ts -> ./LegacyRuntimeAccess`。

两条 exception 都有 owner、理由和 RMV1-16 到期 Task；package checker 实际使用精确 edge，而不是目录 allowlist。

## Owner、Delete 与 Source 清单

四张人工清单已更新为 `RMV1-08`：

- `runtime-module-registry` current/target owner 为 `target-host-mechanism`，production entry 锚定
  `packages/runtime-host/src/index.ts#createRuntimeHost`；
- `LegacyRuntimeModule` 从 planned 改为 present，并锁定 RMV1-16 删除；
- placeholder `RuntimeModuleBoundaryV1`、`defineRuntimeModuleBoundaryV1`、
  `createBuiltinRuntimeBoundaryModuleV1`、`RuntimeHostExecutionBridgeFactory` 与 Host `createLegacyAccess` 旁路标为
  deleted；
- SPI 28 个 public symbol、Host adapter seam 与 `createBuiltinRuntimeModules` 均有 source migration disposition；
- generated source facts 从当前 package graph/export/source/test/State/Event/Store 重新生成，没有手工改写。

## 格式与范围冻结

Generated facts 与 execution 回归共同证明：

- Runtime State schema 25、30 个 root field；
- Runtime Event codec 136 个 discriminant；
- Runtime Store schema 4、epoch `kite-runtime-2026-08-18`、8 表、3 index；
- operation 29、responsibility 18、Legacy rule 43、architecture exception 2；
- 没有 ProjectIdentity、Composition identity、cryptographic authenticity、cross-Host fence、DataOrigin/Egress/
  Credential 重写、State 26、Store 5、新 epoch 或 RAV1 production artifact。

RMV1 SPI 中的 Grant/Receipt/Context 类型只是当前进程内迁移 contract，没有改变 production format 或授权语义。

## Gate 证据

| 命令 | 结果 |
| --- | --- |
| `bun test tests/execution/tool-pipeline-stages.test.ts` | 17 pass、0 fail |
| `bun test tests/execution/workspace-filesystem-provider.test.ts` | 15 pass、0 fail |
| `bun test tests/execution/sandbox-execution-provider.test.ts tests/subagent-provider.test.ts` | 42 pass、0 fail、1 platform skip |
| `bun run check:runtime-packages` | passed；7 workspace、12 edge、1 composition root |
| `bun test packages/runtime-spi/test packages/runtime-host/test packages/builtin-runtime/test apps/kite/test` | 46 pass、0 fail；包含 duplicate owner、freeze、partial startup rollback、bounded dispose、exact adapter 与 lifecycle ordering 负例 |
| `bun test tests/scripts/check-runtime-packages.test.ts tests/scripts/runtime-modularization-manifests.test.ts` | 31 pass、0 fail；包含 package/ambient/cycle/deep-import/exception 负例与 29 operation 等值 Gate |
| `bun run scripts/check-runtime-modularization-manifests.ts` | passed；5 generated、29 operation、18 responsibility、43 Legacy、292 source、417 consumer、142 export、2 exception；State 25/Store 4/原 epoch |
| `bun run typecheck` | passed；root + 7 workspace |
| `bun run lint`、`bun run format:check` | passed；仅保留 `tests/session-manager.test.ts` 既有 16 条 `any` warning |
| `bun run check:core-boundary`、`bun run check:docs`、`bun run check:docs-impact`、`git diff --check` | passed |

## 阶段边界

RMV1-08 completion evidence 已闭合并形成 stop-and-report checkpoint。下一阶段为 RMV1-09 Capability binding 与
ExecutionTraits Scheduler；RMV1 总计划仍为 active，RAV1 继续 blocked。RMV1-09 尚未开始，State 25、Store 4 与
当前 epoch 必须继续保持，只有 RMV1-16 completion evidence 闭合后才可解除 RAV1 阻塞。
