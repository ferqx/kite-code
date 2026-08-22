# Runtime SQLite Storage

Private SQLite adapter boundary. The package is the physical Store 4 owner for
the existing State 25 and compatibility epoch. It accepts Host-owned opaque
event/state codecs and checkpoint validation callbacks; it does not import or
interpret Kernel or builtin domain types.

The adapter creates the unchanged eight Store 4 tables and three indexes, and
maps all four Host transaction acknowledgements to one atomic event plus
snapshot transaction. No alternate driver, secondary write path, migration,
Store 5 table, or new epoch is exposed.
