# Agent Note: 同步 Store 请求持有并释放原生 SQL 语句

Status: implemented

## Problem

长期复用的 SQLite Worker 通过 Drizzle prepare 和 Bun query 执行同步具名操作，结果物化后原生 statement 原先等待 Worker GC。原 450 秒九点生命周期在模型完成、取消、重连、删除全部通过时仍触发 RSS 增长。对所选发行引擎读取并校准 `sqlite3_memory_used`/`sqlite3_memory_highwater` 后，原候选的 SQLite 分配峰值约134.6MiB；该计数记录 SQLite 尚未释放的原生分配，不能从较小的 JS heap 推导为零。

## Decision

[SqliteOperations](../../../../packages/agent/src/storage/sqlite/operations.ts)记录同步请求实际返回的 query/prepare statement；[Worker](../../../../packages/agent/src/storage/worker/main.ts)在成功或失败 ACK 前释放，在 strict close 前先释放。具名事务先完成提交或回滚，结果是物化 DTO，没有 statement 越过响应边界。保留 Drizzle schema/query helper、原 SQL/COMMIT timing、请求身份及错误查询规则；finalize 失败不重做原请求或业务效果。

Bun query cache 中已 finalize 的条目在下次使用时重新 prepare，不建立第二份应用 cache。既有[备份关闭决定](../architecture/2026-10-02-offline-profile-backup.md)的 strict close 与锁释放理由继续有效；本决定补充连接仍打开时的请求 owner，并不取代关闭证明。

## Alternatives considered

- 等待 Worker GC：原生语句最终可被回收，但原负载已实测较大的分配峰值和 RSS 失败，响应边界不能据此宣称资源已释放。
- 只释放 uncached prepare：私有完整450秒对照的业务断言通过，RSS仍失败；它还留下被 Bun query cache 淘汰的语句等待GC。采用同一同步请求内的全部 query/prepare owner。
- 移除 Drizzle：当前计划保留 schema/query helper，且本问题已有明确资源边界；不借内存排查替换查询与迁移体系。
- 调整 allocator 环境或 RSS 门槛：已有 purge 环境对照仍失败；没有采用新开关、放宽32MiB门槛、延后原基线或缩短负载。

## Consequences

[真实 Worker 回归](../../../../packages/agent/test/isolated/storage/statement-lifecycle.test.ts)经公开 Store 启动原 Worker，发送响应前检查原生 `isFinalized`；原实现首次ACK仍有三个 live statement，修复后覆盖成功、错误、继续查询、strict close和只读重开。双Worker timing及rollback仍运行原完整文件。

私有同一450秒/九点对照完成2570个生命周期、5140次模型调用，SQLite原生分配峰值约2.8MiB并稳定在约2.48MiB；这是归因证据，不是正式候选资格。RSS仍触发原门槛，完整八轮、全局activeResources/handles及全部owned descendant仍待原验收。实际候选和阶段完整默认结果归[当前进度](../../../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-08sqlite-请求内语句释放与仍失败的-rss)。计数定义参见[SQLite原生分配接口](https://www.sqlite.org/c3ref/memory_highwater.html)。
