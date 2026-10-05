# Session log metadata

[`session-logs.ts`](session-logs.ts) captures and reads finite diagnostic metadata on the existing Store connection. It does not reconstruct business history from the current projection, authorize commands, acquire ownership, read Artifact bytes, create adapters or change requirements. Ordinary extensions require no new Core log schema or business classification.

## Persistence and existing events

`SqliteOperations.event()` captures the actual append-time `Date.now()` and the already-updated owner transaction row. It stores a private version-1 `kite.session-log` envelope in the existing `change_event.payload_json`, together with the original payload. No DDL, migration checksum, format-major, backup format, Store identity or cursor behavior changes. Existing baseline assets remain exact-schema readable; backup/restore copies these bytes using its existing database path.

`getChanges()` continues returning the original public payload, including the existing command digest and Model Source facts. Legacy raw payload is returned unchanged. A reserved wrapper of an unknown/malformed version returns its original `payload` or null, never the wrapper, safe snapshot or private binding digest. Supported event producers have no historical reserved-format payload; extensions cannot call the private SQL append owner. This diagnostic envelope is not a second event/recovery authority.

The snapshot stores only generic record category, bounded original IDs, actual closed status, execution kind/definition/version/attempt and optional Model navigation. It never derives a status from an event suffix, copies raw payload or copies input, output, config, env, secrets, paths, exceptions, extension values, owner or generation. Dynamic extension record keys cannot become public `objectId`; non-ID objects use `unavailable`. Summary is generated from safe type/status, not user text. Unknown/future/unsafe metadata is locally unavailable: null time/status/navigation and empty details. Legacy events likewise have unavailable metadata; current Execution status cannot fill them in.

## Public read contract

`Store.getSessionLogs({expectedStoreId,sessionId,subjectId,afterCursor,upperCursor?,limit?})` is an observer. The host supplies actual subject identity; the public query must not choose it. It reuses the original root-creator Session scope proof and checks current Store identity inside one BEGIN read snapshot. Parent and child Sessions are read independently, without root aggregation.

All cursors are canonical Decimal64 strings (0 through 9223372036854775807). `afterCursor` is required and exclusive. The first page without upper freezes actual global last-change cursor; following pages must supply that exact upper. Later appends advance `snapshotCursor`, never the chosen upper. `limit` defaults to 200 and must be 1–200. Results contain at most 200 entries and 512 KiB; no truncation is called complete. `nextAfterCursor` is the final returned entry cursor when more scoped entries exist, otherwise null, with `complete:true`. There is no accumulated Session history quota.

`after < replayFloor` always rejects `cursor_expired`, including `after=0` when floor>0. `after > upper` and `upper > snapshotCursor` reject `cursor_ahead`. Lost prefixes are never silently skipped or marked partial-ready. Scope filtering and upper bounds precede ordering/LIMIT, including Decimal64 values beyond Number's exact range. These reads perform no business write or transaction CAS mutation.

The public page is `SessionLogPage` in [`types.ts`](../types.ts): current store/session IDs, fixed upper, next-after/null, replay floor, read snapshot cursor, entries and complete. Each entry has cursor, actual Session, safe object ID/type, original event revision, occurredAt number/null, category, recordedStatus string/null, fixed summary, closed `SessionLogDetails`, modelExecutionId string/null. Details allow only kind, definitionId/version, commandId/runId/executionId/interactionId and positive attempt. Public type/definition text is bounded and control-free; private reference/hash metadata is excluded.

## Model navigation and read cancellation

Navigation is captured only for an actual `kind:model` row with recorded input metadata and exact original Model/Run/Command/root-work/subject associations. Inline request and metadata use existing pure validators. Sealed descriptors reuse immutable registered ref/hash/size/media/owner checks; this does not read full bytes or claim physical Artifact availability. A private digest binds the original input/metadata, original Store and all execution associations. The reader rechecks that exact binding; drift removes navigation while preserving historical recorded status. Typed Model input reads remain responsible for complete immutable-byte validation and public disclosure.

Restored current Store B may still read original A provenance through the existing typed read contract. Logs do not rename origins, turn local hashes into authority, or permit execution in B. The focused Store-ID drift probe is explicitly fault injection; actual physical restore/body qualification belongs to the existing restored-media tests.

[`readSessionLogs`](../session-logs.ts) checks observation AbortSignal before and after the finite Store read. Abort never cancels a Run, changes unknown facts or interrupts SQLite business work; Signal is not cloned into the Worker. Existing Worker queue and read-only profile discipline remain in force.

## Evidence

[`session-logs.test.ts`](../../../test/isolated/storage/session-logs.test.ts) covers >200 actual appended events, fixed upper across new writes, exact Session filtering, current-status drift, cold read-only metadata identity, old/future/malformed wrapper handling and original payload preservation, secret sentinels, >2^53 cursor precision, floor loss, invalid bounds/Store/subject, append-trigger rollback, actual Model versus Tool navigation, immutable binding drift and observer cancellation. A real fixed-Model Runtime with a sealed >64KiB request proves cold navigation without new Model/permission/source I/O. Read tests do not prove HTTP/SDK/Web behavior; those consumers are separate owners.
