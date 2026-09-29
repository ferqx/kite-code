# Agent Note: Session deletion follows live execution rather than historical status

Status: implemented

The deletion preconditions and lifecycle ordering recorded below are superseded by [data-only Session and Workspace deletion](2026-09-29-data-only-session-deletion.md). Current deletion sends local cancellation and lets Service track asynchronous cleanup; it does not await cleanup or gate on foreign leases or historical labels. Workspace removal uses one batch transaction without a persistent claim or Desktop finalize dependency. Atomic data scope, receipt/tombstone and retained-reference protections remain. The paragraphs below preserve the earlier reasoning, not the current deletion contract.

## Problem

Workspace removal could remain blocked after a crashed child or old Shell left running or unknown history. The previous path tried to recover business execution before deleting, then rejected the same historical uncertainty. In xp, an unknown child model outcome and stale Shell records prevented removal even though these labels did not establish live local execution. The user explicitly chose to cancel actual running work before deletion and ignore stale tool status in inactive sessions.

## Decision

Service distinguishes its live coordinator and background resource owners from stored Run, tool and recovery labels. Actual local work is cancelled and awaited before deletion; inactive history is deleted without provider reconstruction or business recovery. Local cleanup is checked again inside the Store tree transaction, and a valid foreign execution lease still blocks removal.

Host retains mailbox and lifecycle serialization. A deletion-only Store scope permits one receipt-bearing root tree deletion; it does not grant ordinary execution authority or rewrite unknown history into success. The tree mutation removes authority and retains tombstones and the command receipt atomically. Existing cross-tree reference rejection remains. Late callbacks and old execution handles cannot recreate removed sessions.

Workspace failures carry a fixed error category and confirmed deleted root count. Unknown transport outcomes are shown as an unknown count. Native workspace registration is removed only after the existing completed-fence finalization succeeds.

This partially supersedes [the earlier tree deletion decision](2026-09-27-session-tree-deletion-authority.md): its receipt, tombstone, cross-tree, workspace admission fence and actual local cleanup protections remain; its requirement to settle historical unknown Run/tool/effect evidence before deleting inactive history is replaced.

## Alternatives considered

- Extending the previous narrow cancelled-child model proof would unblock only a subset of old histories and retain the user-reported problem for stale Shell and other tools.
- Recovering or replaying an inactive session to make its history terminal would perform business work as a side effect of deletion and could fail on missing provider configuration.
- Removing rows without stopping real local execution would let processes continue after history disappears. Cancellation and cleanup remain required for live resources.
- Giving deletion a general execution lease would allow business dispatch and broaden mutation privileges. The dedicated scope only admits the final delete transaction.

## Consequences

Deletion can discard unresolved historical outcomes. It does not attest that an old external operation succeeded or failed, and does not turn a stale status into a process handle. Actual live resources and valid foreign ownership remain protected. Partial workspace removal keeps registration visible and reports confirmed progress; finalization and retries retain their existing durable fence contract.

## Large-history deletion feedback

A subsequent real workspace removal deleted roots at roughly 10–22 seconds each and reached the Service deadline after nine roots. The remaining bottleneck was candidate Artifact collection cleanup: every candidate rescanned all retained text. Deletion now scans retained text once with multiple candidate matching and preserves the original candidate-order reference semantics. Shared and uncertain references remain retained. This keeps cleanup inside the existing atomic delete rather than dropping Artifact cleanup from the contract.

Desktop shows pending removal and disables repeated removal while it waits. The removal RPC has a 150-second client deadline to cover the Service's 120-second processing budget; other requests retain their existing deadlines. Increasing every RPC deadline or displaying unconfirmed deletion counts would hide unrelated failures or fabricate progress, so neither was selected. Client timeout still means an unknown result and does not replay a mutation automatically.
