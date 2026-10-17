# Agent Note: Bound SQLite writer lock waiting under peer Worker contention

Status: implemented

## Problem

The original complete default regression failed in the real two-Worker continuous workload: an original Run ended with `SQLITE_BUSY`, and the qualification report correctly became failed. The initial 100ms connection wait can expire during legitimate short peer-writer contention, including when a lock holder loses CPU. The failure log identifies contention but does not measure the lock-holder scheduling interval. A real independent connection held `BEGIN IMMEDIATE` for 300ms and reproduced the same failure through the public Store command path before the change.

## Decision

普通已打开 Worker 的请求竞争等待已由[正常 Loop 检查点决定](2026-10-17-normal-loop-checkpoints.md)部分取代：首个事务尚未开始时在同一队列继续等待，不再因累计等待超过1秒失败。本记录继续保留启动/初始化原生等待、真实原红和禁止重放已开始或提交未知事务的理由；当前实现与验证以[Store owner](../../../../packages/agent/src/storage/README.md#写锁竞争的正常等待)为准。

The existing SQLite connection owner sets native `busy_timeout=1000` for writable connections. Readonly connections and startup format preflight retain 100ms. SQLite's native handler waits within the current statement; no Worker request, transaction callback, Command or external effect is resubmitted. The existing immediate transaction, rollback, original-ID receipt and unknown-commit query boundaries remain.

This value is an accumulated SQLite busy-handler sleep budget, not a one-second HTTP wall-time guarantee. The bounded startup path still returns the original `SQLITE_BUSY` on exhaustion. Current implementation and validation belong to the [Store owner](../../../../packages/agent/src/storage/README.md#写锁竞争的正常等待); the formal load and recovery boundaries belong to the [resilience owner](../../../../docs/active/runtime-resilience-qualification.md).

## Alternatives considered

- Retain 100ms and rerun the failing workload: the real held-lock reproduction remains, so a later green run would not resolve the evidenced short-contention failure.
- Retry whole Worker operations or transaction callbacks: a commit response can be unknown, and repeating the callback is broader than waiting for the current lock. Original identity and query-back rules cannot be replaced by blind replay.
- Serialize the workload onto one Store/Service: this would remove the real shared-WAL peer behavior that the fixture must exercise.
- Raise readonly and startup inspection waits as well: the failure occurred on ordinary writes; those independent paths retain their existing bounds.

## Consequences

A writable DbWorker can wait longer on its current SQL statement when a peer owns the lock. It still has a finite native wait, preserves queue scheduling and returns contention if the lock remains. The fix does not add a transaction replay policy or qualify all T095 crash/unknown-commit cases, background Shell, or formal continuous load.

The complete original Store file adds two meaningful cases: release after 300ms admits one original Command and an exact same-ID retry adds no event; retained locking returns bounded `SQLITE_BUSY`, leaves the original intent absent, then allows its explicit request after release. The old implementation actually failed the positive case. The current Store/rollback/timing/preflight files pass 21 tests and 110 assertions. Original complete regression and current Linux Native candidate verification are recorded with their actual results in the [progress log](../../../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-07linux-native-安装生命周期).
