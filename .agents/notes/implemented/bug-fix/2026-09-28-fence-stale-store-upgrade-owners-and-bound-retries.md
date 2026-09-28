# Agent Note: Fence stale Store upgrade owners and bound repeated preparation

Status: implemented

## Problem

An admitted Store 13 source can contain execution authority left `active` or `detached` by a stopped Service. Store 13→14 conversion produced a structurally valid private candidate, but continuity validation rejected that historical owner before publication. Each retry created another complete backup and converted candidate; repeated failures accumulated large private recovery assets without changing the original Store.

The follow-up multi-source audit found two validator conflicts: continuity accepted a non-owning `recovery_required` record with confirmed cleanup while merge rejected it, and authority reads treated a missing historical row as initial idle while merge required a persisted row. A Store with the same Session facts could therefore pass single-source preparation and fail when a historical source was also present.

The packaged regression exposed a separate admission mistake: a Service running with an isolated `HOME` used its own `userInfo().homedir` to infer the default Store of every other Kite process. Bun resolved that value from the observer's temporary `HOME`, so a source Desktop using the real user Store was incorrectly classified as a writer of the isolated Store and startup remained `store_busy` before conversion.

## Decision

After exclusive maintenance and retired-writer admission, Store 13→14 conversion validates each persisted authority record and fences only `active` or `detached` records in the private candidate. It increments controller generation and authority revision, clears the old host/client/lease, and marks `recovery_required` with cleanup unconfirmed. The source remains unchanged. Existing valid `recovery_required` records with confirmed cleanup remain valid and unchanged. Full continuity validation still rejects any `active` or `detached` candidate owner and malformed records; history publication does not grant a new execution lease or claim that external effects were cleaned up.

Before creating another large candidate, the production Service writes a private, durable attempt marker for the exact source main/WAL bytes and verified Service build identity. The same build and unchanged source fail fast on another startup; a changed build or source can retry. A pending publication intent is settled first. Successful publication and known transient cancellation or contention clear the matching marker. No existing backup or candidate is deleted by this rule. Desktop and CLI/TUI use a fixed, non-retryable `store_preparation_retry_blocked` diagnostic when the marker suppresses a duplicate attempt.

Single-source continuity and multi-source merge now use one non-owning authority predicate. It accepts clean idle or recovery-required authority without a host, client or lease; recovery remains required regardless of cleanup confirmation. Merge reads missing historical authority through the same initial idle default as normal runtime reads and does not materialize a new metadata row. The packaged upgrade test pins the current Store schema and epoch, forcing a new fixture when either changes; the historical App Server decoupling test no longer pins an obsolete current epoch.

A generic reconciliation failure is non-retryable for the same build and source because its durable attempt marker will block the next preparation. The fixed diagnostic therefore requests a saved report and an updated version, and Desktop hides its ineffective retry action for this failure and the explicit same-build block. Other startup failures can retain retry after their condition changes.

The macOS process observer now reads each candidate process's own `HOME` from its verified process environment when no explicit Store root is present. Missing or malformed home evidence keeps admission incomplete; it does not borrow the observer's home. Managed binaries remain identifiable by their fixed executable layout or a verified supplied prefix.

## Alternatives considered

- Reject any persisted old owner: retains a simple validator but prevents a safe format upgrade after a stopped Service and leaves a retry loop that copies the Store repeatedly.
- Treat lease expiry or process exit as confirmed cleanup, or reset the owner to idle: would allow effects to resume without the required cleanup proof.
- Reuse or automatically remove every failed recovery candidate: could reduce disk use further but requires an additional verifier and cleanup protocol across publication crash boundaries. The current fix retains those assets.
- Require a persisted authority row for every merged historical Session: conflicts with the established authority reader default and rejects old Sessions that remain readable alone.
- Use the observing Service's `HOME` for another process's default Store: confuses distinct Store owners whenever the Service runs under an isolated home, causing repeated false `store_busy` decisions.

## Consequences

Previously active old executions become visible as recovery-required history after migration and still need the normal recovery checks before a new turn. A crash immediately after the attempt marker is durable can suppress another attempt from the same build even if no candidate was created; a corrected build or changed source is needed to retry. The marker limits repetition for one build and exact source, not total recovery-directory size across many builds or sources, and it does not reclaim assets made before this fix.

An isolated copy of an affected Store 13 recovery backup converted and passed production continuity validation with 48 Sessions, 16,710 events and six recovery-required owners. Synthetic tests cover source preservation, malformed authority refusal, repeat-attempt suppression, interrupted attempts, changed build/source, cancellation and publication resume. This evidence does not assert that the user's original Store was migrated or that any unknown external effect is safe to replay.

Multi-source preparation and merge regressions now cover confirmed recovery and absent authority rows; live owners, divergent facts and prepared effects still fail closed. The schema/epoch pin in the packaged macOS test prevents a later format bump from silently reusing this Store 13→14 release proof.

The packaged regression initially failed before conversion because the isolated Service misclassified a source Desktop using the real user's different Store as a legacy writer. A real macOS process-scoping test reproduces the different-`HOME` case. After the observer fix, the rebuilt, temporarily signed macOS package passed all four isolated Store 13→14 tests, including backup integrity and unchanged second-start bytes. This does not certify official release signing or migration of the user's original Store.
