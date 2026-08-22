# RMV1-03 Runtime Contract 与 App 迁移完成记录

状态：completed

日期：2026-08-20

关联计划：[`2026-08-19-kite-runtime-modularization-v1-implementation.md`](../../plans/2026-08-19-kite-runtime-modularization-v1-implementation.md)

基线 HEAD：`af5a512305207dcaaeb40c334d0b914befbc3598`

## 结论

RMV1-03 已建立私有、同进程的 `RuntimeAccess.command/query/subscribe` Contract，以及 Command、Receipt、
Query、Projection、durable/ephemeral Notification 和 Client presentation DTO。CLI/TUI 不再导入或获得
Agent State、Runtime Event、Runtime Store、Kernel、Executor 或具体 builtin authority；这些约束同时由
package AST Gate 和负向测试固定。

`src/app/cli`、`src/app/tui`、Git、Observability、Release 与 Workspace App 源码已物理迁入
`apps/kite/src/`。release entrypoint 与根 scripts 指向 `@kite/kite/cli`、`@kite/kite/tui`；根
`src/index.ts` 只重导出两个 executable，不再构造 Runtime 或导出 Core Runtime surface。standalone release
compiler 对所有 `@kite/*` public entrypoint 做精确映射，实际编译 CLI 的 POSIX supervisor 测试通过。

## Contract 与单一兼容路径

`apps/kite/src/bootstrap.ts` 是唯一 concrete composition root。所有未迁移的实现都集中在
`apps/kite/src/bootstrap/legacy/`，由 `LegacyRuntimeAccess` 选择一个明确 handler；没有 try-new-catch-old、
异常 fallback、双写或第二 handler。

兼容 Contract 保留当前 Workspace/Session bootstrap identity。Command 以 `commandId` 幂等：包括并发重试在
内都只调用一次 handler，重复成功返回原 revision。订阅有界；`return()` 与 AbortSignal 只关闭 subscriber，
不取消 Runtime work。durable projection 按 revision 重放，gap 先投影 full snapshot；ephemeral model/
reasoning/tool progress 不进入历史、不伪装 durable fact，也不参与重放。

TUI 仍通过 App-local facade 保持既有前台/后台、cancel、compaction、rewind、session switch 与 persistence
行为；具体 legacy authority 不进入 Client import graph。后续 RMV1-04 才迁移 Storage Port，RMV1-05/06 才迁移
Host mailbox/lifecycle，不能把本阶段的兼容层误记为这些 owner 已切换。

## Owner、Delete 与 Source 清单

四张人工清单均更新为 `RMV1-03`：

- `production-bootstrap` 与 `client-runtime-access` 的当前 owner 已切到 `target-app-contract`；Storage、Mailbox、
  Kernel 与各 builtin owner 保持原计划的 Legacy owner；
- Legacy 清单现有 37 条：4 条已删除、31 条仍存在、2 条未来阶段才允许创建；本阶段删除旧 root Runtime
  exports、旧 TUI SessionRuntime、旧 direct-rewind Store 文件与旧 TUI run-agent composition；
- 所有临时 compatibility 文件逐个登记为 RMV1-16 删除目标，root executable shim 也保持已登记；
- source manifest 记录旧 `src/app/**` 到 `apps/kite` 的 RMV1-03 cutover；292 个现存 `src` 文件与 416 个测试
  consumer 均恰好命中一个迁移规则；
- architecture exception 仍为 0。App 到 root legacy 的临时兼容只在 App package 内成立，Client 敏感 import
  仍由 AST Gate 拒绝，因此没有登记宽泛例外。

## 格式冻结与生成事实

State/Event/Store 三个 digest 与 RMV1-01 完全一致：

| 清单 | 事实 | canonical digest |
| --- | --- | --- |
| `runtime-state-shape.generated.json` | State schema 25、原 epoch | `sha256:8153a486de8cc433d50dbf760d07433a2848bb1c6e8cdd4df5cf56d975d9f385` |
| `runtime-event-shape.generated.json` | 136 个 Event shape | `sha256:deabd2670581e453634fe8c912fc140a5da4db8e5156c45b78f0164ba890b2cb` |
| `store-schema.generated.json` | Store 4、8 表、3 index、原 epoch | `sha256:160b70cf16af1d60e0437fc4b98942775be2e41d19e60685543893c87ea671b5` |

App relocation 与 Contract exports 使 package graph digest 更新为
`sha256:12ec98f45afc0f2f3d980cf4f1f6f789adb7a1f78943d8cbf69acb6139a573dc`，57 个 public export 的 digest
更新为 `sha256:95189daa28bf6576e522b7abcfca41c0510879124e5cda1a5e225e57af52c87d`。生成事实仍为根 + 7
workspace、11 条 observed package edge 与唯一 composition root。

Runtime State 继续为 25，Store 继续为 4，epoch 继续为 `kite-runtime-2026-08-18`。没有 ProjectHandle、
ProjectIdentity、统一 sealing、cross-Host fence、State 26、Store 5 或新 epoch。

## Replay qualification

canonical JSON 实现迁入 App release 模块后，原 `scripts/release/canonical-json.ts` 成为 re-export shim。
Required replay qualification 因此精确重算 package/shim digest和传递 import closure；closure 从 254 个文件变为
255 个文件，digest 为 `sha256:6ee23b1c36169ff36fa4926881aa43776022e40b87cff5561f08df80f1def8ec`。
parser 外 manifest authority 同步为
`sha256:4dba46bf5b164c6021fdb1710605df5725a0c7e7162db47445159f2019c3b886`。suite、case、fixture、
cassette、catalog、oracle、risk matrix 与 replay outcome 均未改变。

## Gate 证据

| 命令 | 结果 |
| --- | --- |
| `bun test tests/session-manager.test.ts` | 107 pass、0 fail |
| `bun test tests/cli.test.ts tests/cli/trace.test.ts tests/cli-workspace-trust.test.ts` | 21 pass、0 fail |
| `bun run test:tui:system:core` | 14 个隔离 PTY scenario 文件全部通过 |
| `bun run check:runtime-packages` | passed；7 workspace、11 edge、1 composition root |
| `bun test tests/scripts/check-runtime-packages.test.ts` | 24 pass、0 fail；包含 Client authority、Legacy 绕过、root shim 与 RAV1 format 泄漏负例 |
| `bun run scripts/check-runtime-modularization-manifests.ts` | passed；5 generated、29 operation、17 responsibility、37 Legacy、57 export、0 exception；State 25/Store 4/原 epoch |
| `bun test tests/scripts/runtime-modularization-manifests.test.ts` | 2 pass、0 fail；生成事实逐字节可重复 |
| `bun run build` | passed；7 个 workspace 全部构建 |
| `bun run typecheck` | passed；root + 7 个 workspace 全部检查 |
| `bun run check:core-boundary` | passed |
| `bun run format:check` | passed；1002 files，仅保留既有 `session-manager.test.ts` 16 条 `any` warning |
| `bun run test` | root main 3758 pass/10 skip；6 个隔离文件 57 pass/1 skip；7 个 workspace 13 pass；合计 3828 pass/11 skip/0 fail |
| `bun run eval:replay:required` | passed；approved suite、macOS seatbelt、无 live fallback |
| `bun run check:docs` | passed |
| `bun run check:docs-impact` | passed |
| `git diff --check` | passed |

## 阶段边界

RMV1-03 到此形成可审计检查点。RMV1 总计划仍为 active，下一阶段为 RMV1-04 Storage Port 与 v4 adapter；
RAV1 继续 blocked，只有 RMV1-16 completion evidence 闭合后才可解除。
