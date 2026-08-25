# RMV1-02 Workspace、Package 与边界 Gate 完成记录

状态：completed

日期：2026-08-20

关联计划：[`2026-08-19-kite-runtime-modularization-v1-implementation.md`](../../plans/2026-08-19-kite-runtime-modularization-v1-implementation.md)

基线 HEAD：`af5a512305207dcaaeb40c334d0b914befbc3598`

## 结论

RMV1-02 已把仓库转换为 Bun workspace，并建立六个私有 Runtime package 与 `apps/kite`。每个 workspace
都有真实源码、明确 exports、README、独立 tsconfig、build/typecheck/test 和 package-export consumer。
根 `build`、`typecheck`、`test` 依次覆盖全部七个 workspace，旧 deterministic 根测试与 workspace consumer
test 不重复发现。

全套验证还暴露 `posix-supervisor.test.ts` 在共享主进程运行数千用例后会两次精确撞到 5 秒 supervisor
timeout，而该文件在新进程中稳定通过。默认 runner 因此把这个实际编译/启动 release CLI 的文件加入既有
process-isolated 清单；测试没有跳过，仍由根 `test` 强制执行。

本阶段只提供可执行验证的 boundary descriptor、storage port、module registry 和目标 composition sample；
没有移动任何 production operation/responsibility owner，也没有重定向 `agent`、`tui`、`prod:tui` 或 release
入口。`src/core/**` 和 `src/app/**` 仍是生产路径，RMV1-03 尚未开始。

## 物理图与静态门禁

`check:runtime-packages` 从 workspace manifests 和 TypeScript AST 重建事实，当前结果为 7 个目标 workspace、
11 条跨 package observed edge、唯一目标 composition root `apps/kite/src/bootstrap.ts`。固定依赖图为：

```text
runtime-host -> runtime-contract + agent-kernel + runtime-spi
runtime-spi -> runtime-contract
runtime-storage-sqlite -> runtime-host/storage
builtin-runtime -> runtime-spi + runtime-contract
apps/kite/bootstrap -> runtime-contract + runtime-host + runtime-storage-sqlite + builtin-runtime
```

checker 同时验证 package 私有性/文件/scripts/consumer、显式 public exports、目标与 re-export symbol、声明依赖、
direct/transitive forbidden edge、type-only/dynamic/require import、deep import、相对跨包路径、cycle、Contract/
Kernel ambient authority、唯一 composition root 与精确 exception。20 个负向/正向回归用例对这些失败码做
确定性验证；当前 architecture exception 仍为 0。

## Manifest 与格式冻结

RMV1 source facts 已重生成：package graph 从根单包扩展为根 + 7 workspace，public export 从 12 增至 26；
`source-migration.json` 为 14 个新增 export 增加 RMV1-02 disposition。operation owner 仍为 29 个 operation、
17 个 responsibility，Legacy delete 仍为 32 条，生产源码仍为 408 个，architecture exception 仍为 0。

不涉及 package 的三个格式 digest 保持 RMV1-01 值；package graph digest 为
`sha256:2f4dcbaba5d62559c62a28d8caa0dc5ee9adad65c735ccae570f1c60930f42ed`，public exports digest 为
`sha256:68f7d841be4dbbc13a922b6e8fa543c5ca806c7dd454b3e388dd1b07c854ec35`。

Runtime State 继续是 schema 25，Runtime Store 继续是 schema 4，epoch 继续是
`kite-runtime-2026-08-18`。没有 Project identity、统一 sealing、cross-Host fence、State 26、Store 5 或其他
RAV1 产物。

## 文档影响裁决

已更新 package 分层、六概念架构与默认测试发现 active 规则，并扩展 `docs/documentation-map.json`。已复核
`workspace-trust.md` 与现有 CLI/TUI active 规则：本阶段没有更改 trust 判定、production 启动顺序、CLI JSONL
或 TUI 行为，因此不改写这些行为文档。

完整 working-tree impact evaluator 还识别出 `tui-system-governance` 对任意 `package.json` 改动都会误报；该
映射已收窄为实际 TUI runner/fixtures/scenarios/smoke/resource-test 源，避免用无关 TUI 文档修改绕过门禁。

因为 Required replay manifest 把 `package.json` 与 `bun.lock` 作为 qualification file，workspace 安装拓扑使这
两个 digest 按设计失效。本阶段只重算这两个 qualification digest 和 parser 外 manifest authority；254 文件的
PS-03 import closure digest、suite/case/fixture/cassette/catalog/oracle/risk matrix 均保持不变。

## Gate 证据

| 命令 | 结果 |
| --- | --- |
| `bun install --frozen-lockfile` | passed；263 installs / 284 packages，无 lockfile 漂移 |
| `bun run build` | passed；六包与 App 共 7 个 workspace 全部构建 |
| `bun run typecheck` | passed；root + 7 个 workspace 全部检查 |
| `bun run check:core-boundary` | passed |
| `bun run check:runtime-packages` | passed；7 workspace、11 edge、1 composition root |
| `bun test tests/scripts/check-runtime-packages.test.ts` | 20 pass、0 fail；包含正向图与全部边界负例 |
| `bun run format:check` | passed；991 files，仅保留既有 `session-manager.test.ts` 16 条 `any` warning |
| `bun run test` | root main 3754 pass/10 skip；6 个隔离文件 57 pass/1 skip；7 个 workspace consumer 各 1 pass；总计 3818 pass/11 skip/0 fail |
| `bun run scripts/check-runtime-modularization-manifests.ts` | passed；5 generated、29 operation、17 responsibility、32 Legacy、26 export、0 exception；State 25/Store 4/原 epoch |
| `bun test tests/scripts/runtime-modularization-manifests.test.ts` | 2 pass、0 fail；生成事实逐字节可重复 |
| `bun run eval:replay:required` | passed；approved suite、macOS seatbelt、无 live fallback |
| `bun run check:docs` | passed |
| `bun run check:docs-impact` | passed；另以完整 working-tree 文件集直接运行同一 impact evaluator，无遗漏 mapping |
| `git diff --check` | passed |

## 阶段边界

RMV1-02 Gate 到此 stop-and-report。RMV1 总计划仍为 active，下一阶段 RMV1-03 尚未开始；RAV1 继续
blocked，只有 RMV1-16 completion evidence 闭合后才可解除。
