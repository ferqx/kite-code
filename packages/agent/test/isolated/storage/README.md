# Session 管理测试

[statement-lifecycle.test.ts](statement-lifecycle.test.ts)经公开 SQLite Store 启动真实 Worker；夹具只观察 Operations 创建的原生语句，并在实际响应发送前读取 `isFinalized`，覆盖 Drizzle prepare、Bun cached query 的重复使用、错误响应后继续读取、strict close 与只读重开。原实现首次 ACK 时实际有三个 live 语句，明确失败；修复后各响应语句已释放，cursor 与原 Store 身份保持。它不以 JS heap、短执行或 FD 数代替原 450 秒 RSS 门槛；双 Worker timing、事务 rollback 和完整默认仍分别验证。

[store.test.ts](store.test.ts) 用独立真实 SQLite 连接持有 `BEGIN IMMEDIATE`，300ms 后释放时核原 Command 只登记一次、同 ID 返回原回执且 cursor 不增长；持续持锁时核有限 `SQLITE_BUSY`、原意图与事件缺席、释放后的准确受理。旧 100ms 写连接已实际复现正例失败，当前写连接 1000ms 与 readonly/preflight 100ms 的边界归 [Store owner](../../../src/storage/README.md#写锁的有界等待)。rollback、双 Worker timing 与 preflight 仍沿原完整文件独立执行。

[session-management.test.ts](session-management.test.ts) 使用真实双 Worker/root creator、固定 Model 与 Tool/Job 监督，验证控制修订 CAS、原 ID 快照重试、主体/Store/child 边界、trigger rollback 和 INT64 overflow；删除只提交 tombstone/停止意图，迟到创建/派发零效果，unknown 保留、其他 Session 继续、readonly 查询零 Model。

[preflight.test.ts](preflight.test.ts) 使用独立临时 profile 与真实 SQLite，验证公开 startup preflight 的 absent/uninitialized/compatible、原 StoreId、core.db/profile.json/live WAL 原字节与原 Core 表不变；未来格式、未知/破坏 schema、迁移 checksum、坏库、rollback/restore journal、链接和权限拒绝。真实第二进程证明 shared 共存、维护 exclusive 有限 busy、其他 profile 可用与错误后释放；源码树外 `@kite-ai/agent/sqlite` 实际制品调用读取包内 SQL，移除资产后明确失败而无源码 fallback。不访问用户数据或启动 Model。

`session-logs.test.ts` 验证元数据日志固定 upper、>200 项分页、实际 append 状态与旧/未来 metadata不可用、原 public payload 解包、Decimal64与裁剪、原Store/subject/Session、事务回滚、sealed Model导航及冷只读零业务I/O。原格式/恢复/Model输入/维护邻接仍独立执行；HTTP/SDK/Web展示由对应owner验证。实现说明见 [Session logs owner](../../../src/storage/sqlite/session-logs.README.md)。
