# Runtime SQLite Storage

## 定位

`@kite-ai/runtime-storage-sqlite` 是 Host storage port 的唯一 SQLite concrete adapter 和物理 Runtime Store owner。

## 拥有职责

- 管理 Store 6 current database lifecycle、8 张表、2 个索引、schema、event、session、snapshot、artifact、effect lease、command receipt 与 transaction。
- 以显式 `workspaceBinding` opt-in 打开 Store 7 target：State 27、Workspace/Worker header binding、Session ownership、receipt
  ownership 与 `session_workspace_tombstone`；未提供 binding 时仍保持 Store 6 current authority，避免在 cutover 前改变旧 Service。
- 提供 owner-only generation layout 的 active-layout pointer、manifest、migration journal/fence 与窄回退状态机；离线
  `migrateSqliteRuntimeStoreToWorkspaceLayout` 只从 Service 已停止且 source-bound fence 保护的 Store 6 只读快照复制到
  Store 7，不改写 source、不在线迁移、不双写，也不启动 Worker。迁移不定义或复制 Coordinator Catalog DDL；调用方必须注入
  `catalogBuilder`，由 Coordinator/Service owner 用 exact target `catalogPath` 和 path-free Session routing metadata 建立唯一
  Catalog，返回的 digest 由 migration 在 pointer switch 前复核。
- Store 7 暴露 `workspaceAuthority` durable facade：Controller operation receipt/idempotency、Controller generation/lease、
  hash-only resume/DetachedRecovery rotation、detached/recovery state、effect prepare/inspect/terminal 与 resource
  attempt evidence。capability secret 只在调用者内存中出现，Store 仅保留 SHA-256 hash；resource surface 只记录外部
  OS-user lease 证据，不在 Workspace SQLite 内重新 acquire 共享文件资源。
- `apps/kite-service/src/workspace-worker/production.ts` 是当前 Store 7 的 concrete Worker consumer：Coordinator 先完成
  materialize/admit 与 active-generation 校验，Worker 再以已打开的唯一 Store owner 组合 Host/Application。默认 Service 仍是
  Store 6；Store 7 不会因 Web query、legacy reader 或 open failure 被隐式启用。
- 执行只读 format preflight、current log query 和已知历史 source 的隔离导入。
- 通过 `transaction.ts` 原子提交 Runtime event 与 snapshot。

## 不拥有职责

- 不导入或解释 Kernel/Builtin domain 类型。
- 不提供 alternate driver、dual write 或 execution fallback；Store 7 只能通过显式 Workspace binding 进入 target path，不能
  作为 current Store 的 silent format fallback。
- 历史 source reader 不进入 current execution port。

## 允许依赖

只允许依赖 `@kite-ai/runtime-host`，生产源码只使用其 `/storage` port。

## 公开入口

只导出 package 根入口 `@kite-ai/runtime-storage-sqlite`。

## 关键不变量

- `adapter.ts` 是唯一 current database lifecycle owner。
- current writer 精确为 State 27 / Store 6 / `kite-runtime-server-v1-2026-08-26`；`adapter.ts` 是唯一 current database lifecycle owner。
- Store 7 target 精确为 State 27 / Store 7 / `kite-coordinator-workspace-worker-web-v1-2026-08-28`；必须携带显式
  `layoutGeneration`、`workerScopeId`、`workspaceIdentityDigest` binding，header/session/receipt/tombstone 任一 ownership
  drift 都在 reopen/preflight 时 fail closed。
- 已发布 generation 的 Store 7 reopen 必须带 active-layout、manifest、migration journal/fence 证据并使用 canonical
  Workspace Store path；纯 reopen 不会标记 generation 已写，首个真实 mutation 在同一 storage write seam 前永久写入
  `targetWriteState=written`，之后 rollback helper 必须拒绝回源。新 target 只能由显式 migration/admission 流程发布；
  `admitNewWorkspaceStore` 只在已 committed 的 active generation 中登记已 materialize 且 header 已由 Store owner 验证的
  canonical file，并先将 generation 标记为 written，绝不自动推断 Workspace ownership。
- Store 6 到 Store 7 的 copy-and-switch 必须由调用方提供已验证的 persisted Workspace ownership resolver；缺失/冲突归属、
  orphan retained receipt、损坏或未知 source fact 会整体 blocked，source 保持只读且 active-layout 不切换。迁移逐 Session
  校验 event count/sequence、snapshot checksum/position、receipt digest、recovery evidence 与 content digest，完成所有
  Worker Store、metadata-only Catalog、immutable manifest 和 journal 后才原子切换 pointer。
- `runtime_command_receipts` 的主键精确为 `(scope_session_id, command_id)`；applied receipt 与 event/snapshot 同一 `BEGIN IMMEDIATE` 原子提交。不会建立额外 receipt 索引、TTL 或裁剪。
- command fork 在同一 `BEGIN IMMEDIATE` 中精确验证 source checkpoint、克隆/rebind target 并写 scoped applied receipt；普通 fork 不写 receipt。
- State 26/Store 5 与 State 27/Store 5 (`kite-runtime-saq-v1-2026-08-25`) 都只读、no-follow、隔离复制并单向导入到 Store 6；Store 5 永远只是 source，不会被写回、checkpoint、rename 或作为 execution fallback。source 不改写，导入目标的 receipt 为空。
- 删除/close 保留 receipt，fork 不复制 receipt；只有删除整个 Store 才会移除它们。
- Host-owned `delete_session` transaction 在同一个 `BEGIN IMMEDIATE` 中删除该 Session 的 event、snapshot、
  named snapshot、Workspace file preimage、recovery identity 与 lease facts并写入 scoped applied receipt；receipt
  row 不随 Session facts 删除，因此 response 丢失后的 retry 不会重删或重建。

## 测试

`bun test packages/runtime-storage-sqlite/test`

## 文档影响

模块局部变化更新本 README；格式、恢复或日志查询变化同时更新 [Runtime Authority](../../docs/active/runtime-authority-boundary.md) 和 [日志查询](../../docs/active/sqlite-runtime-log-query.md)。
