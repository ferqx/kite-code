# RMV1-12 Filesystem Read/Write 完成记录

状态：completed

日期：2026-08-20

权威来源：accepted Runtime Modularization RFC、ADR-0123/0124/0125、
`2026-08-19-kite-runtime-modularization-v1-implementation.md`

前置证据：`2026-08-20-rmv1-11-skills-context-mcp-read.md`

实施 baseline：`af5a512305207dcaaeb40c334d0b914befbc3598`

## 交付结论

RMV1-12 已把 Filesystem read/search/write/edit 与 typed Git inspect 物理迁入目标边界：

- `@kite/runtime-spi` 唯一拥有 JSON-safe `WorkspaceFilesystemProviderV1`、operation/observation/grant contract 与
  Git broker contract；根 `src/protocol/` 旧路径只保留 RMV1-16 前的 compatibility re-export；
- `@kite/builtin-runtime` 唯一拥有 Local Workspace Provider、grant/evidence、diff/projection、descriptor-relative
  commit、Git broker/qualification，以及 6 个 concrete executor；Core 旧实现路径只保留 compatibility re-export；
- `builtin:read_file`、`builtin:search_content`、`builtin:search_files`、`builtin:write_file`、
  `builtin:edit_file`、`builtin:git_inspect` 已从 `LegacyRuntimeModule` 原子删除；对应 Core ToolSpec 只保留完全相同的
  model schema、Policy、approval、protected path 与 ExecutionTraits；
- Controller 只构造 exact binding/request，Runner 只在 durable invocation/attempt acknowledgement 后注入当前受治理
  filesystem dispatcher 或 typed Git broker。Host 只做 immutable Registry arbitration、single-use claim 和 receipt
  identity validation；Builtin 无法读取 State、Store、Kernel Event 或扩大授权；
- 每个 operation 只有一个 production owner，不存在 try-new-catch-old、异常 fallback、双 handler、双写或隐式
  adapter。Builtin package root/subpath 的实际导出闭包与 package Gate 已精确一致。

当前三个 Builtin module 合计拥有 15 个 operation，Legacy module 剩 14 个 operation。

## 行为与安全等价

- canonical path、trusted Workspace、external mutation approval 与默认 external read/search 规则未改变；
- read-before-edit 的 same-actor committed freshness、preimage Artifact、mutation-ready durable ack 与 single-use commit
  grant 未改变；
- descriptor-relative/no-follow commit、parent directory identity、atomic replace、file mode、symlink race 与
  protected-path 语义未改变；
- `.gitignore`/glob/search bounds、UTF-8/line/read bounds、projection truncation 与 Git argv/revision/pathspec/hostile
  repository qualification 未改变；
- Provider denial、cancellation、post-ack unknown outcome、receipt Artifact failure 与 recovery disposition 仍 fail closed，
  不会回退到旧 filesystem/Git implementation；
- 未引入 Project/Composition identity、统一 authenticity、cross-Host fence、DataOrigin/Egress/Credential IR、State 26、
  Store 5 或新 epoch。

## Owner、Delete、Source 与 Replay 清单

- owner manifest 的 `filesystem-read-write` group 已锚定
  `packages/builtin-runtime/src/rmv1-12-operations.ts#createRmv112RuntimeModuleV1`；
- Legacy delete manifest 为 90 条，新增规则证明 6 个 Legacy operation、6 个 ToolSpec concrete executor 与 9 个旧
  physical implementation path 不再拥有生产实现；
- Runtime SPI/Builtin Filesystem/Git 的精确 public exports 已登记；生成事实为 527 个 package exports；
- Required replay pilot 显式注入与生产相同的 Host capability execution port，不再依赖 Legacy executor。最终 import
  closure 为 289 个文件，digest
  `sha256:58700ac96848e88540a4b661e0c0c8be10663b00e4d0a58e8a83853f6ef59c3f`；pilot canonical report 为
  `sha256:680a613f03d7bdc8002cf8658c955b201b04d38ca3682002e6724051b67c2d28`；manifest authority 为
  `sha256:baf07d400792fbdcef185dfd8d6b5344a7099917c64676a40fe9e34f5de92460`。fixture、cassette、catalog、oracle 与
  risk matrix digest 未改变，也没有 live Provider transport。

Generated facts 继续证明 Runtime State schema 25、Runtime Store schema 4、epoch
`kite-runtime-2026-08-18`；29 operation、19 responsibility、90 Legacy rule、294 source、420 test consumer、
527 public export 与 2 architecture exception 均闭合。

## Gate 证据

| 命令 | 结果 |
| --- | --- |
| RMV1-12 五组 Required Filesystem 命令 | 60 pass、0 fail；覆盖 Pipeline、Provider、race parity、preimage 与 durable evidence |
| `bun run test:runtime:fault` | 33 pass、0 fail |
| RMV1-12 schema/Controller/Registry/Tool Runner 回归 | 155 pass、0 fail；含 forged input zero mechanism call |
| Git broker 与 Controller parity | 15 pass、0 fail |
| `bun run scripts/run-runtime-workspace-script.ts test` | passed；7 workspace、75 pass、0 fail |
| `bun run eval:replay:required` | passed；approved suite 在 macOS Seatbelt 网络隔离下执行 |
| `bun run scripts/check-runtime-modularization-manifests.ts` | passed；5 generated、29 operation、19 responsibility、90 Legacy、State 25/Store 4/原 epoch |
| `bun run check:runtime-packages`、`bun run check:core-boundary` | passed；7 workspace、12 edge、唯一 composition root，Core boundary closed |
| `bun run typecheck`、`bun run build` | passed；7 workspace |
| `bun run format:check` | passed；仅保留 16 条既有测试 `any` warning，0 error |
| `bun run check:docs-impact`、`bun run check:docs` | passed |
| `git diff --check` | passed |

## 阶段边界

RMV1-12 completion evidence 已闭合，形成可审计 checkpoint。下一阶段为 RMV1-13 Shell/Sandbox；RMV1 总计划仍为
active，RAV1 继续 blocked。RMV1-13 不得改变 State 25、Store 4、epoch，也不得提前引入 RAV1 environment/no-fallback
行为切换。
