# Runtime SQLite Storage

Private SQLite adapter boundary and physical Runtime Store owner. It accepts
Host-owned opaque event/state codecs and checkpoint validation callbacks; it
does not import or interpret Kernel or Builtin domain types.

`preflight.ts` performs read-only format admission and `adapter.ts` owns the
database lifecycle. The adapter creates the current tables and indexes and maps
Host transaction acknowledgements to one atomic event-plus-snapshot
transaction. No alternate driver, secondary write path, format selector, or
migration path is exposed.
