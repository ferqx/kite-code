# Runtime SQLite Storage

Private SQLite adapter boundary and physical Runtime Store owner. It accepts
Host-owned opaque event/state codecs and checkpoint validation callbacks; it
does not import or interpret Kernel or Builtin domain types.

`preflight.ts` performs read-only format admission and `adapter.ts` alone owns
the database lifecycle. Event, session, snapshot, artifact, authority-ledger,
effect-lease, and schema responsibilities use dedicated modules over the same
database context. `transaction.ts` is the single Runtime atomic
event-plus-snapshot commit owner. No alternate driver, secondary write path,
format selector, or migration path is exposed.
