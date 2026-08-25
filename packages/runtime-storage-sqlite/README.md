# Runtime SQLite Storage

## 定位

`@kite-ai/runtime-storage-sqlite` 是 Host storage port 的唯一 SQLite concrete adapter 和物理 Runtime Store owner。

## 拥有职责

- 管理 current database lifecycle、schema、event、session、snapshot、artifact、effect lease 与 transaction。
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
- current writer 只接受 State 27/SAQ epoch。
- State 26/Store 5 source 只读、no-follow、隔离复制并单向导入；source 不改写。

## 测试

`bun test packages/runtime-storage-sqlite/test`

## 文档影响

模块局部变化更新本 README；格式、恢复或日志查询变化同时更新 [Runtime Authority](../../docs/active/runtime-authority-boundary.md) 和 [日志查询](../../docs/active/sqlite-runtime-log-query.md)。
