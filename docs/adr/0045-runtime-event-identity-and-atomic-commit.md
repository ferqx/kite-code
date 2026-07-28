# ADR-0045：Runtime Event occurrence identity 与原子提交协议

状态：accepted
日期：2026-07-28
决策人：项目所有者（RFC 转实施确认）

## 背景

当前 Kernel 默认对 event payload JSON 做 SHA-256 并把结果作为 eventId。相同 payload 的合法多次发生会被当作重复事件；State 只保存最近 4096 个 applied ID。RuntimeStore metadata 路径使用 `INSERT OR IGNORE`，未验证实际插入行数，因此唯一冲突可能静默跳过 event，但同事务仍推进 Snapshot。

event occurrence、业务幂等、thread 内顺序和 State revision 是四个不同概念，不能继续由 payload hash、SQLite 全局 row id 或有界内存集合隐式承担。

## 决策

1. `eventId` 标识一次事实发生，使用 UUIDv7/ULID 等 occurrence identity，不从 payload 推导。
2. 业务调用需要幂等时使用独立可选 `idempotencyKey`。
3. Durable event 在 thread 内获得严格连续 `sequence`；ephemeral event 不占 sequence。
4. `revision` 表示 reducer 后的 RuntimeState revision。当前允许与 sequence 1:1，但 schema 不假设永久相等。
5. Store 在单一 SQLite transaction 内：
   - 分配/验证 thread sequence；
   - 使用普通 `INSERT` 写入完整 event batch；
   - 验证 inserted count；
   - 更新 thread counter；
   - 写入与 batch 对应的 Snapshot metadata。
6. `(thread_id, event_id)` 与 `(thread_id, sequence)` 都建立唯一约束。任何冲突回滚整个 transaction。
7. Store 失败时 Kernel 内存 State 不推进，Session 进入明确 recovery-blocked 状态。
8. 旧数据按 thread 内 SQLite row id 顺序回填 sequence，保留历史 eventId，不重新计算或静默删除冲突事件。

## 备选方案

- 保留 payload hash 并增加 timestamp：拒绝。timestamp 不是可靠 occurrence identity，碰撞和重放语义仍混乱。
- 只扩大 appliedEventIds 窗口：拒绝。内存窗口不能替代持久唯一约束。
- 继续 `INSERT OR IGNORE` 后检查 Snapshot：拒绝。静默忽略破坏提交协议，错误发现过晚。
- 使用 SQLite 全局 row id 作为 sequence：拒绝。它不是 thread-local 连续位置。

## 后果

- RuntimeStore schema 升级并需要 expand/verify/contract migration。
- RuntimeEventEnvelope、Kernel、Store、恢复与测试全部更新。
- 合法相同 payload 可以发生任意多次。
- corruption/unique conflict 从“可能静默继续”变为显式 recovery block。

## 回滚

旧 binary 必须识别新版 Store header 并拒绝写入。数据回滚使用迁移前完整备份，不能逐表拼接。迁移程序记录 started/completed marker；未完成迁移只能由兼容版本继续或恢复备份。
