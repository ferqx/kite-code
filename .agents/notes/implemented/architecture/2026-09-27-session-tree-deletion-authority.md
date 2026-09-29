# Agent Note: Root Session deletion owns its internal child tree

Status: implemented

The deletion preconditions and lifecycle ordering recorded below are superseded by [data-only Session and Workspace deletion](2026-09-29-data-only-session-deletion.md). Current deletion sends local cancellation and lets Service track asynchronous cleanup; it does not await cleanup or gate on foreign leases or historical labels. Workspace removal uses one batch transaction without a persistent claim or Desktop finalize dependency. Atomic data scope, receipt/tombstone and retained-reference protections remain. The paragraphs below preserve the earlier reasoning, not the current deletion contract.

The historical-state restrictions below are partially superseded by [live-execution-based deletion](2026-09-29-session-deletion-live-execution.md). Inactive sessions no longer require historical Run/tool/effect uncertainty to be settled before deletion. The tree transaction, receipt/tombstone, cross-tree reference, workspace admission fence and actual live-resource cleanup decisions remain applicable.

## Problem

Store13 gives each delegated child its own Session, execution authority, Run and history. A public root `delete_session` could not remove the parent alone: the child lineage and cross-Session tables have foreign keys, and a still-running child could write after the parent disappeared. Deletion also needs to work when the workspace directory or current Provider configuration is gone, provided the recorded execution is demonstrably settled.

## Decision

The Host retains the single public root command and its receipt. Before its fenced Store mutation, the Service bridge quiesces background resources and checks child terminal cleanup. For settled Sessions, it uses the recorded workspace and recovery identity to dispose live owners without loading current Provider configuration. It releases owned terminal child execution authority only after checking durable terminal, effect and Run facts. An active parent Run remains subject to Host cancellation and lifecycle admission. A child cancellation closes a dispatched model invocation in the same durable batch that records unknown Provider usage; clean terminal seal and import require a closed local event channel, no dispatching model, and no active or unknown Run or effect. A parent unknown Run is deletable only when its sole uncertainty is linked by the exact cancelled child terminal receipt to that child's interrupted model usage.

The Store enumerates the child tree inside the root writer transaction, checks every child authority, effect and Run boundary, and deletes the tree's Session references and rows with foreign keys deferred to commit. It rejects a row whose Session references cross the tree boundary, preserving the external Session and rolling back the whole mutation. The retained root command receipt commits in the same transaction. Public admission still rejects child IDs as direct command targets.

Workspace removal is a Service operation over this root command. A Store writer fence excludes concurrent Session creation for that exact Workspace while the Service cancels active Runs and deletes each tree. The fence records a running claim separately from a completed deletion. Another request cannot replace a live claim, including when it reuses the Desktop's retry token; an owner that has exited can be replaced so a partially completed deletion can resume. The Service marks completion only after the directory is empty, and `finalize` releases only a completed fence with the matching token. The Desktop finalizes before removing its native project registration, leaving a visible retry path when the Service result is lost or finalization fails. The Service closes deleted Session streams and ignores late notifications; it does not require the Provider to acknowledge remote HTTP cancellation. Cancellation must also terminalize a dispatched primary model invocation when resource budgeting is disabled, so local cleanup is no longer held by a stale `dispatching` fact.

The tree deletion transaction collects typed Artifact references from its candidate rows and deletes only candidate bodies proven unreferenced by retained Store rows. Shared references and ambiguous orphans remain; this is not general Artifact GC.

## Alternatives considered

- Deleting only the root would violate the child foreign key and could leave a live child writing into orphaned history.
- Treating an active child authority or a terminal label alone as cleanup proof would erase evidence while a local model dispatch or external effect might still be unresolved.
- Requiring a Provider to confirm remote HTTP cancellation would leave a locally stopped Session undeletable when the Provider offers no such acknowledgement. The local channel and Store authority are fenced instead; Provider usage stays unknown until deletion.
- Rebuilding a full Runtime from the current workspace configuration for every deletion fails when that directory or Provider configuration has been removed; the settled path instead uses durable identities and explicitly checks for outstanding work.
- Sequential child deletes through public commands would expose internal child IDs and could leave half the tree deleted if a later child failed.
- Treating a matching retry token as proof that deletion has finished would let a second request release the admission fence while the first request is still cancelling or deleting Sessions. Completion is a separate durable state, and active claims are exclusive.
- Removing the native project registration before `finalize` would strand a persistent fence after a lost or failed response because the Desktop would no longer list the space for retry. Registration is removed after finalization succeeds.

## Consequences

Deletion of a settled tree is atomic with its retained receipt and includes child history. Cross-tree references, unknown local execution outcomes, unconfirmed cleanup and foreign owners fail closed. A remote model HTTP request may still finish after local cancellation, but callbacks cannot write to the deleted Session. Unknown Provider usage does not block deletion when it is exactly attributed to a locally stopped, cancelled child model request; an unrelated unknown Run or Tool/effect remains blocked. The operation does not infer cancellation from the user's confirmation to delete.

Store tests cover a two-level tree, retained receipt, foreign keys, active child and cross-tree rollback. Service tests cover completed child deletion, terminal child deletion after approval, and deletion after a locally stopped child model attempt with exact parent budget linkage; the proof rejects missing child evidence and unrelated parent aborts. Gateway tests cover no transport call when cancellation wins before dispatch and ignored late stream callbacks. Desktop navigation tests cover deletion after the workspace directory is removed and configuration becomes invalid.

The fence retains a process ID to refuse cross-process takeover while the recorded owner still appears alive. PID reuse can conservatively delay recovery; it does not authorize early release. A new Store owner in the same process may recover after the old database owner has closed. Store tests cover live-claim exclusion, completed-only release, malformed-record refusal and same-process owner replacement.
