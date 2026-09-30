# Agent Note: Bound Session History reads under overload

Status: implemented

## Problem

Many parent and child Session detail loads can arrive through one Runtime connection or several daemon connections at once. An unbounded request backlog, output backlog, or set of abandoned reads can consume memory and delay the currently selected Session and unrelated Runtime control. A fixed number of stored Sessions is not a useful capacity policy because each Session's transcript size and request rate vary.

## Decision

协议客户端并发组装最多 4 份完整 History，其余 FIFO 等待，不按累计条数或字节拒绝。Service carrier 将合法排队读取的原请求帧暂存于私有磁盘文件，只保留轻量身份与调度 metadata；取消、开始执行、超时及连接关闭回收文件。共享 scheduler 按连接轮转，History 总实际并发为 8，App 辅助读取独立为 16；排队与执行分别限 10 秒。输入持续解析并定期让出事件循环，因此排队期间准确的 `history/cancel` 和 Runtime 控制请求仍可前进。不会因为队列数量或累计输入字节超过旧阈值直接 `overloaded`。无法取消的 App owner 实际调用直到结束才释放执行位，不能以返回超时响应伪装为已停止。

输出保留在途驻留阈值并使用等待背压；达到阈值的生产者等待容量，等待中的帧暂存磁盘，5 秒内不能 drain 才关闭连接。关闭中止 drain 等待、清理监听器并跳过后续实际写入，不能让每个残留帧各自再等待一次超时。安全的协议单帧校验继续生效，驻留阈值不作为累计输出额度。客户端安全只读重试仍是新读取，不能重放 Runtime mutation。

该等待语义同时覆盖 Runtime Server 可靠响应／durable 通知和 carrier stdout。Service 为 stdio、Native／development WebSocket 及 InProcess connection 注入私有磁盘 spool，Server core 只持有中立 port；不能只放开底层队列而让上层仍因暂时积压拒绝可靠帧。从可靠帧入队到 send 完成共用 drain 时限，连接关闭回收驻留 reservation、等待者与文件。ephemeral 展示通知继续允许丢弃，不成为 Runtime 持久事实。

App Server 根／子 History 使用固定两个子进程，每个一次执行一个读取，其余排队；排队和实际读取各自限 9 秒，不再按 64 个队列项拒绝。子进程在独立 SQLite 只读事务中核对范围、水位、投影和摘要，生产分页复用[私有磁盘页](../bug-fix/2026-09-30-history-page-snapshots.md)。搜索按 keyset 扫描至结果页满即停止；旧无分页读取只有完整响应装入单个协议帧才返回。取消执行中读取会终止并重建该子进程，其他排队请求保留；父 owner 确认退出后回收目录。原累计源、投影和记录额度已移除，单页解析边界、时限与实际并发独立生效。

## Alternatives considered

- One global FIFO queue without per-connection rotation: a noisy connection could keep a newly selected Session behind its older requests.
- Unbounded queued Promises and output writes: memory could continue growing when SQLite reads or stdout stalls.
- Closing a shared connection for every view switch: this would also disrupt unrelated subscriptions and require connection recovery for a local read cancellation.
- Silently dropping excess requests: callers would wait for a timeout without knowing the server rejected the read.
- An in-process asynchronous wrapper for the synchronous Store scan: the scan still occupied the Runtime event loop until the entire projection completed.
- A Bun Worker pool: source, bundle, and compiled smoke checks lost a failure reply after successful pages under Bun 1.4.2, so the process pool uses the same executable's private child mode and JSONL framing instead.
- 直接移除排队／输出数量门槛后无限保留大对象：拒绝。拥塞时内存仍随 backlog 增长；原请求与等待输出落私有磁盘，驻留输出通过背压推进。
- 队满时暂停整个 stdin：拒绝。同连接排在后面的取消和控制帧会一起堵住，直到读取期限到达。

## Consequences

容量暂满时读取或输出等待，不直接拒绝合法 backlog；实际等待／执行／drain 超时仍明确失败。排队文件带来真实 I/O 成本，不用旧版提前拒绝后的耗时对照完整工作。两个进程的启动和保留有资源代价，旧无分页 transcript 超过单帧仍返回 `history_too_large`，正式分页不按累计大小拒绝。非 App Server 或注入的 History client 可使用直接读取 fallback，不享有进程隔离。永久挂起的 App owner 可占满自身执行位，Runtime 与 History 容量独立。当前行为见 [Service carrier](../../../../apps/kite-service/docs/runtime-server-carrier.md)，回归覆盖跨连接公平、超过旧 pending 数量的排队／取消、慢输出恢复、drain 超时清理和控制请求前进；不据此声明无限并发、固定总内存或 UI 延迟承诺。

The cumulative transcript admission portion of this decision is superseded by [the complete History reading decision](2026-09-30-run-cumulative-limits-removed.md). The process pool, cancellation, active deadlines, per-page frame checks, and cache eviction continue to apply.
