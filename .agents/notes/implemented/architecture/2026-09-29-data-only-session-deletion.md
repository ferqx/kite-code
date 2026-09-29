# Agent Note: Session and Workspace deletion are data operations

Status: implemented

## Problem

Workspace removal reused the complete single-Session lifecycle for each root. It repeatedly read history, waited for cleanup, scanned retained references and committed before advancing to the next root. A separate persistent deletion claim and Desktop finalize request could keep registration visible after history deletion. Real deletion remained slow even after the per-candidate Artifact scan was optimized.

The user explicitly requires both Session and Workspace deletion to be data operations: cancel a corresponding live Session, let the server own subsequent cleanup, and avoid historical state or cleanup prerequisites.

## Decision

Service sends cancellation to actual local executions and tracks their asynchronous cleanup. Data deletion does not await cleanup confirmation or reconstruct business state. Host closes scheduling and publication for deleted identities; Store removes authority and retains tombstones so late writes cannot recreate them.

Store provides one trusted owner entry for a root tree and one for a whole Workspace. Workspace deletion collects all roots and children from metadata and deletes them in one transaction with one Artifact reference scan. Single-Session deletion retains its command receipt, bound to the current metadata revision in that transaction. Historical Run/tool/effect labels, recovery state and execution leases do not gate deletion. Target identity and database reference consistency still delimit the data being removed.

Desktop sends a single remove request, then removes native registration and local views on success. It does not enumerate Sessions before/after removal or request a second finalization. The existing finalize wire shape is acknowledged for compatibility; the target's obsolete deletion marker is removed by the data transaction.

## Alternatives considered

- Keeping the per-root loop retains repeated scans and allows one cleanup delay to hold every later root.
- Raising timeouts and displaying a spinner improve feedback but cannot fix the repeated work or lifecycle preconditions.
- Launching all existing per-root deletes concurrently does not parallelize SQLite writes or eliminate repeated scans.
- Dropping tombstones would allow late execution callbacks to recreate deleted data. They remain data consistency protection, not a pre-deletion business check.

## Verification contract

- Inactive or malformed historical business state deletes without recovery/model requests.
- Live cancellation is issued before deletion; a held cleanup continuation does not delay the response, and late writes fail.
- A whole Workspace is deleted with one data transaction and one Artifact scan, while other Workspaces and shared references remain.
- Single delete is receipt-idempotent without a full projection read or an active-Run rejection.
- Desktop no longer requires enumeration/finalize and closes the removed view after success.

## Consequences

Cancelled resources may be cleaning up after data is gone. Service must retain and handle cleanup promises through shutdown; deleted-state write failures must not become unhandled rejections. Deletion discards historical uncertainty without asserting successful external completion. A failed data transaction must roll back, including its receipt and tombstones.

## Verification

Focused Store tests cover batch deletion with malformed history, stale metadata, foreign execution labels, late-write rejection, transaction rollback and retained references. A 100-root fixture with 100 candidate Artifacts and 8 MB of retained text validates the batch path. Real Service tests cover 24 Sessions with a corrupt snapshot and a separate retained Workspace, plus live Shell cancellation while cleanup remains held. Host tests cover metadata revision receipts and replay; Desktop tests cover one remove RPC without enumeration or finalize.
