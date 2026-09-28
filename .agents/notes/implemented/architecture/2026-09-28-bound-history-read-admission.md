# Agent Note: Bound Session History reads under overload

Status: implemented

## Problem

Many parent and child Session detail loads can arrive through one Runtime connection or several daemon connections at once. An unbounded request backlog, output backlog, or set of abandoned reads can consume memory and delay the currently selected Session and unrelated Runtime control. A fixed number of stored Sessions is not a useful capacity policy because each Session's transcript size and request rate vary.

## Decision

The protocol client admits a bounded number of complete paginated History loads and queues a bounded number of additional callers. The Service JSONL carrier independently reserves per-connection and shared History request counts and input bytes. The shared scheduler rotates among connections and yields between read starts; App auxiliary reads have separate, shared capacity. The parser also yields after a bounded number of frames in one input chunk, and stdout has per-connection and shared frame and byte backlogs so blocked connections cannot multiply output memory without a bound. An exact `history/cancel` notification releases queued work and the execution reservation of an abandoned read on the same connection. Connection close releases its History reservations. A History read that does not settle within the Service deadline returns a fixed retryable error and releases scheduling capacity. App auxiliary calls receive a bounded timeout response, but a running unabortable owner call retains its physical execution reservation until it actually settles. Protocol clients send cancellation only to a server that advertises it, and only for the original RPC id on the current connection generation.

The limits protect in-flight work; they do not limit how many Sessions the Store can retain. Excess requests receive an explicit overload response. A client retry after capacity becomes available is a new read, never a replay of a Runtime mutation.

App Server's root and child History reads run in a fixed pool of two child processes. Each process opens a separate read-only SQLite connection and holds one read transaction while it checks the Session scope, scans, projects, computes the digest, and returns one bounded protocol page. A legacy unpaged request uses the same isolated scan and returns a complete transcript only when it fits one protocol frame. A searched Session list uses the same pool and keyset-scans until its requested result page is filled; it does not retain every candidate Session. The child receives only the Service owner's Store path and a specific read request. Each process admits at most 64 waiting reads, one active read, a 9-second active deadline, a 32 MiB encoded transcript cache budget, and a 32 MiB source/32 MiB projected/50,000-record transcript budget. Canceling an active read terminates and replaces that child while preserving other queued jobs. This isolates synchronous SQLite and projection work from the Runtime event loop and caps its concurrency independently of the carrier's logical request budget.

## Alternatives considered

- One global FIFO queue without per-connection rotation: a noisy connection could keep a newly selected Session behind its older requests.
- Unbounded queued Promises and output writes: memory could continue growing when SQLite reads or stdout stalls.
- Closing a shared connection for every view switch: this would also disrupt unrelated subscriptions and require connection recovery for a local read cancellation.
- Silently dropping excess requests: callers would wait for a timeout without knowing the server rejected the read.
- An in-process asynchronous wrapper for the synchronous Store scan: the scan still occupied the Runtime event loop until the entire projection completed.
- A Bun Worker pool: source, bundle, and compiled smoke checks lost a failure reply after successful pages under Bun 1.4.2, so the process pool uses the same executable's private child mode and JSONL framing instead.

## Consequences

Under saturation, some History loads fail promptly and may be retried after demand falls. Cancellation removes queued pages and terminates an active child read; a replacement process starts for later work. Starting and retaining two processes costs resources, and a page beyond the read budget returns `history_too_large` rather than sending a partial transcript. Non-App Server or injected History clients can still use the carrier's direct transcript fallback, so the process isolation claim applies to Store-backed App Server paged and unpaged transcript reads. Permanently hung App owner calls can exhaust their separate lane; Runtime and History lanes continue. The [Service carrier owner](../../../../apps/kite-service/docs/runtime-server-carrier.md) records the current numeric limits. [Carrier tests](../../../../apps/kite-service/test/isolated/runtime-stdio-carrier.test.ts) cover multi-connection fairness, cancellation, stalled connection cleanup, global input bytes, and output backpressure; the [protocol-chain stress test](../../../../apps/kite-service/test/isolated/history-protocol-100-pairs.test.ts) covers larger synthetic Session populations, the process-backed page path, and overload recovery. These checks do not establish an unlimited concurrency guarantee or a production UI latency SLO.
