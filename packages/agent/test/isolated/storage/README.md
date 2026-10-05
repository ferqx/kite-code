# Session 管理测试

[session-management.test.ts](session-management.test.ts) 使用真实双 Worker/root creator、固定 Model 与 Tool/Job 监督，验证控制修订 CAS、原 ID 快照重试、主体/Store/child 边界、trigger rollback 和 INT64 overflow；删除只提交 tombstone/停止意图，迟到创建/派发零效果，unknown 保留、其他 Session 继续、readonly 查询零 Model。

[preflight.test.ts](preflight.test.ts) 使用独立临时 profile 与真实 SQLite，验证公开 startup preflight 的 absent/uninitialized/compatible、原 StoreId、core.db/profile.json/live WAL 原字节与原 Core 表不变；未来格式、未知/破坏 schema、迁移 checksum、坏库、rollback/restore journal、链接和权限拒绝。真实第二进程证明 shared 共存、维护 exclusive 有限 busy、其他 profile 可用与错误后释放；源码树外 `@kite-ai/agent/sqlite` 实际制品调用读取包内 SQL，移除资产后明确失败而无源码 fallback。不访问用户数据或启动 Model。

`session-logs.test.ts` 验证元数据日志固定 upper、>200 项分页、实际 append 状态与旧/未来 metadata不可用、原 public payload 解包、Decimal64与裁剪、原Store/subject/Session、事务回滚、sealed Model导航及冷只读零业务I/O。原格式/恢复/Model输入/维护邻接仍独立执行；HTTP/SDK/Web展示由对应owner验证。实现说明见 [Session logs owner](../../../src/storage/sqlite/session-logs.README.md)。
