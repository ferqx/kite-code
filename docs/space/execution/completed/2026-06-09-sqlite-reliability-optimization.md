# SQLite 连接管理、查询性能和写入可靠性优化

状态：completed
完成日期：2026-06-09
影响模块：`src/core/persistence/checkpoint.ts`

相关：
- `understanding/2026-06-09-token-stats-persistence-design.md` — token 统计表引入
- `execution/completed/2026-05-17-sessions-command-implementation.md` — checkpoint SQLite 基础设施

## 问题清单

### 1. `session_stats` 表定义位置错误

`sessions_stats` DDL 放在了 `BunSqliteSaver.setup()` 中，但 `session-manager.ts` 独立打开 DB 读写该表。两者打开同一个 DB 文件时，Bun SQLite 的连接级 `busy_timeout` 不同可能导致死锁。

**修复** (`040cb4d`)：将 `session_stats` 表定义保留在 `checkpoint.ts` 的 `setup()` 中（所有 DB 使用者共享同一建表入口），`session-manager.ts` 的 `saveTokenStats`/`loadTokenStats` 只做 CRUD，不再 `CREATE TABLE IF NOT EXISTS`。

### 2. 写入失败静默吞没

`put()` 和 `putWrites()` 在 `isClosed` 时直接 `return`，不报错；SQL 执行没有 try/catch，任何写入失败静默丢失 checkpoint。

**修复** (`06b028f`)：
- `isClosed` → 抛出 `Error("Database is closed")` 而非静默返回
- `put()` 和 `putWrites()` 包裹 try/catch，原错误作为 `cause` 传递
- `saveSessionStats()` 从 checkpoint.ts 移到 session-manager.ts 自治

### 3. WAL 文件无限增长

Bun SQLite 默认 WAL 模式，`-wal` 文件随写入累积增长。应用长时间运行后（多次 `open → write → close` 循环），WAL 文件可能膨胀到数百 MB。

**修复**：`close()` 中添加 WAL checkpoint：

```typescript
close(): void {
  if (this.isClosed) return;
  this.isClosed = true;
  // WAL checkpoint: 将 -wal 文件合并回主 DB，防止无限增长
  try { this.db.run("PRAGMA wal_checkpoint(TRUNCATE)"); } catch { /* best-effort */ }
  this.db.close();
}
```

`TRUNCATE` 模式：合并后清空 WAL 文件（而非 `PASSIVE` 仅合并不清空）。

### 4. 会话列表查询缺索引

`listSessions()` 查询：
```sql
SELECT ... FROM checkpoints WHERE checkpoint_ns='' ORDER BY created_at DESC LIMIT 1
```

每次会话切换都触发此查询，无索引走全表扫描。

**修复** (`040cb4d`)：
```sql
CREATE INDEX IF NOT EXISTS idx_checkpoints_ns_created ON checkpoints(checkpoint_ns, created_at);
```

覆盖 `WHERE checkpoint_ns=''` + `ORDER BY created_at`，会话列表查询从全表扫描变为索引扫描。

## 其他修复 (65f87d1)

清理 code review 发现的 4 个问题：
- 缓存命中日志输出行注释掉（调试时可取消注释启用）(01f7c6b)
- useEffect 保存跳过初始全零状态，避免启动时无意义 DB 写入 (e4fce1f)

## 验证

```bash
bun test tests/checkpoint.test.ts
bun test tests/session-manager.test.ts
```
