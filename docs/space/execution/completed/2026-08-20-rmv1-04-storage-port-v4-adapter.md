# RMV1-04 Storage Port 与 v4 adapter 完成记录

状态：completed

日期：2026-08-20

关联计划：[`2026-08-19-kite-runtime-modularization-v1-implementation.md`](../../plans/2026-08-19-kite-runtime-modularization-v1-implementation.md)

基线 HEAD：`af5a512305207dcaaeb40c334d0b914befbc3598`

## 结论

RMV1-04 已把 Runtime persistence production API 迁到 `@kite/runtime-host/storage` port 与
`@kite/runtime-storage-sqlite` 的唯一 `LegacyV4StorageAdapter`。`apps/kite/src/bootstrap.ts` 是唯一 concrete
storage 创建者，并通过 `createRuntimeHost({ storage, modules })` 注入。CLI、TUI、Kernel、session persistence
helper 与 `apps/kite/src/bootstrap/legacy/` 不再持有 raw SQLite handle，也不再按路径自行创建 Store。

物理实现仍严格是 Store 4。`src/core/runtime/store.ts#openLegacyV4StorageDriver` 只由 App storage policy 注入
adapter，并已登记为 RMV1-16 删除目标；这项阶段性包装由实施计划明确允许，不代表旧驱动已物理迁移完毕。
没有 fallback、双写、双 handler、alternate driver retry 或隐式授权扩大。

## Port 与映射

Host storage exports 包含：

- `SessionStore`、`RuntimeTransactionPort`、`EffectLeasePort`、`CheckpointPort`、`ArtifactPort`；
- decision、attempt-start、receipt/evidence、terminal/recovery 四个显式 transaction method；
- 独立 `SessionMetadataPort`，供 TUI token stats 使用既有 `session_stats` 布局；
- type-erased Artifact namespace registry，但每个 access object 仍由原强类型 store owner 验证。

四个 transaction method 都精确调用一次旧驱动的 `appendEventsAndSnapshot`。session/event/snapshot、effect
lease、named checkpoint、fork/rewind 与 file preimage 语义保持原样。Artifact registry 不转换 ref、不统一
sealing，也不创建新 writer。TUI token stats 的 raw `bun:sqlite` 访问已移入 SQLite package 的显式 metadata
port；SessionManager 只持有 `save/loadAll/close`。

## Fail-before-write 与恢复

App 的 storage opener 接收可选 session id。需要打开具体 Session 时，先执行 session-aware format preflight，
确认 State schema/epoch 与 snapshot 后才建立写连接；列表查询只执行全库 marker/schema 预检。错误或缺失 epoch
继续在任何 schema 写、reducer 或 dispatch 前拒绝，测试同时比较数据库摘要，证明拒绝路径不改写源文件。

真实 adapter conformance 先用旧 Store 4 driver 写入 Session，再关闭并经
`createSqliteRuntimeStorage` 重开；event、snapshot revision、`format_version=4`、
`runtime_format_epoch=kite-runtime-2026-08-18`、8 表与 3 个显式 index 全部精确恢复。

## Owner、Delete 与 Source 清单

四张人工清单均更新为 `RMV1-04`：

- `runtime-storage-api` 当前 owner 切到 `target-storage-v4`，production entry 为
  `packages/runtime-storage-sqlite/src/index.ts#createSqliteRuntimeStorage`；
- `app-direct-sqlite` 与旧 `createRuntimeStore` factory 标记 deleted；
- 当前 v4 物理驱动以独立 Legacy rule 保持 present，删除 Task 为 RMV1-16；
- source/public export manifest 登记 Host/Storage 新增 port、adapter 与 metadata exports；
- 38 条 Legacy rule、292 个 source file、417 个 test consumer、87 个 public export 全部闭合，architecture
  exception 仍为 0。

## 格式冻结证据

`store-schema.generated.json` 改动前后的 canonical `facts` SHA-256 都是
`9c943a5db78a1696a514a2d6b390740881c2a4fe6b1fc005bb3942a6240e747e`。逻辑事实保持：

- Runtime State schema 25；
- Runtime Store schema 4；
- epoch `kite-runtime-2026-08-18`；
- marker 为 `format_version=4` 与原 epoch；
- 8 个表、3 个显式 index，DDL、列与 index shape 不变。

生成 manifest 的 envelope digest 因 generator/source identity 与新增 package exports 变化而重算；当前 Store
envelope digest 为 `sha256:8654a70b7a41062dd572acc7f760c9a17be599ff3c863b31646800ad9211178e`。
这不是 DDL/format digest 变化；可重复生成检查和前述 facts digest 分别固定来源身份与逻辑 shape。

没有 ProjectIdentity、Composition identity、统一 sealing、cross-Host fence、DataOrigin/Egress/Credential
重写、State 26、Store 5 或新 epoch。

## Replay qualification

Store dependency injection 改写了既有 Required replay closure 中的 Runtime source 与三份资格测试文件。
closure 文件数仍为 255，digest 重算为
`sha256:f46dd8d73eaec75a8eb29e81da96b14320e73da4bb230cf434f4ea4e938f83ee`；parser 外 manifest authority
为 `sha256:a16967d495c3da0aa4f6430986e3368edf12075148571e8484422c880efd43a8`。suite、case、fixture、cassette、
catalog、oracle、risk matrix 与 replay outcome 未改变。

## Gate 证据

| 命令 | 结果 |
| --- | --- |
| `bun test tests/runtime/store.test.ts tests/runtime/file-checkpoints.test.ts tests/runtime/storage-adapter.test.ts` | 76 pass、0 fail；包含真实 adapter 重开与 schema/marker 精确断言 |
| `bun test tests/runtime/capability-artifacts.test.ts tests/subagent-artifacts.test.ts` | 15 pass、0 fail |
| `bun run test:runtime:fault` | 33 pass、0 fail；SQLite lock exactly-once 与 `SQLITE_FULL` rollback 通过 |
| `bun test tests/session-manager.test.ts tests/runtime/agent.integration.test.ts tests/session-logger/composition.test.ts` | 136 pass、0 fail |
| `bun run scripts/check-runtime-modularization-manifests.ts` | passed；5 generated、29 operation、17 responsibility、38 Legacy、292 source、417 test consumer、87 export、0 exception；State 25/Store 4/原 epoch |
| `bun run check:runtime-packages` | passed；7 workspace、11 edge、1 composition root |
| `bun run build` | passed；7 workspace 全部构建 |
| `bun run typecheck` | passed；root + 7 workspace 全部检查 |
| `bun run format:check` | passed；1004 files，仅有既有 `session-manager.test.ts` 16 条 `any` warning |
| `bun run test` | root main 3759 pass/10 skip；6 个隔离文件 57 pass/1 skip；7 workspace 18 pass；合计 3834 pass/11 skip/0 fail |
| `bun run eval:replay:required` | passed；approved suite、macOS seatbelt、无 live fallback |
| `bun run check:docs` | passed |
| `bun run check:docs-impact` | passed |
| `git diff --check` | passed |

## 阶段边界

RMV1-04 到此形成自动 stop-and-report 检查点。RMV1 总计划仍为 active，下一阶段为 RMV1-05 Runtime
Host、SessionRegistry 与 Mailbox；RAV1 继续 blocked，只有 RMV1-16 completion evidence 闭合后才可解除。
