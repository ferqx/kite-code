# Runtime SQLite Storage

## 定位

`@kite-ai/runtime-storage-sqlite` 是 Host storage port 的唯一 SQLite concrete adapter 和物理 Runtime Store owner。

## 拥有职责

- 管理 Store 6 current database lifecycle、8 张表、2 个索引、schema、event、session、snapshot、artifact、effect lease、command receipt 与 transaction。
- 执行只读 format preflight、current log query 和已知历史 source 的隔离导入。
- 通过 `transaction.ts` 原子提交 Runtime event 与 snapshot。

## 不拥有职责

- 不导入或解释 Kernel/Builtin domain 类型。
- 不提供 alternate driver、dual write、格式选择或 execution fallback。
- 历史 source reader 不进入 current execution port。

## 允许依赖

只允许依赖 `@kite-ai/runtime-host`，生产源码只使用其 `/storage` port。

## 公开入口

只导出 package 根入口 `@kite-ai/runtime-storage-sqlite`。

## 关键不变量

- `adapter.ts` 是唯一 current database lifecycle owner。
- current writer 精确为 State 27 / Store 6 / `kite-runtime-server-v1-2026-08-26`；`adapter.ts` 是唯一 current database lifecycle owner。
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
