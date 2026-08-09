# ADR-0091：RuntimeStore 压缩所有权与 revision CAS

状态：accepted

日期：2026-08-09

## 背景

ADR-0090 要求同一 session 的手动压缩完整串行，并明确指出 SQLite busy timeout 不能保证多个内存 Kernel 的 revision 一致。仅在 `SessionRuntime` 内使用 Promise barrier 仍允许多个 Manager、进程、普通 prompt、reset 或删除与 standalone compaction 竞争，造成重复 Provider 调用、stale snapshot 覆盖或删除会话复活。

## 决策

1. RuntimeStore 为每个 `thread_id + compaction_id` 提供带 owner、过期时间和心跳的 effect lease。只有 lease owner 可以 dispatch summary Provider；崩溃后的 lease 可在过期后恢复。
2. Kernel 的 metadata-bearing `appendEventsAndSnapshot` 在同一 SQLite 事务内比较当前 snapshot revision 与首事件的前置 revision；不匹配或 snapshot 已删除时抛出 `RuntimeRevisionConflictError`，不得追加事件、覆盖 snapshot 或重新创建 session。
3. App 的 Promise barrier 继续负责同一 `SessionRuntime` 内 `/compact`、prompt 和 reset 的用户交互顺序。它不是 durable lease 的替代品。
4. standalone compaction 拥有 AbortSignal 和 completion barrier。删除 session 前先取消并等待 writer；live run 取消时，尚未收敛的 manual pending 写入 `summary_aborted` terminal。
5. session 切换清除 inline progress；命令所属 session 不在前台时，terminal 进入该 Runtime 的 buffer，切回后重放。

## 后果

- 同一 compaction id 在多个连接间最多产生一次 Provider dispatch。
- stale Kernel、reset 竞态和删除后的晚到 writer 无法覆盖新状态。
- 崩溃恢复最多等待 bounded lease TTL；正常执行用心跳续租并在 finally 释放。
- 所有使用 metadata 写 snapshot 的 Kernel 都获得 revision CAS 保护，冲突必须重新加载状态，不能静默 last-writer-wins。

## 备选方案

- 长时间持有 SQLite write transaction：会在 Provider 网络等待期间阻塞无关写入，拒绝。
- 只禁用 TUI 输入：无法覆盖多个 Manager、进程或崩溃恢复，拒绝。
- 只比较内存 revision：每个 Kernel 都可能认为自己的 lease 当前，拒绝。
