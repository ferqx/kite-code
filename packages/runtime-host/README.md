# Runtime Host

Private generic runtime mechanism boundary and production owner of one frozen
RuntimeModule registry. Host starts modules before recovery,
selects the exact registered execution adapter without fallback, and closes the
bridge before bounded reverse-order module disposal. Concrete Context, Prompt,
Skill, Model, and Capability semantics remain outside Host.

Host code is grouped by `host`, `lifecycle`, `execution`, `kernel-adapter`,
`format`, `process`, `storage`, and `observability`. The root package exports
stable Host lifecycle/composition ports; Kernel fact translation is available
only through `@kite/runtime-host/kernel-adapter`. Persisted bytes remain in
`format`, and process supervision remains in `process`.
