# Runtime Host

Private generic runtime mechanism boundary. RMV1-08 makes Host the production
owner of one frozen RuntimeModule registry. Host starts modules before recovery,
selects the exact registered execution adapter without fallback, and closes the
bridge before bounded reverse-order module disposal. Concrete Context, Prompt,
Skill, Model, and Capability semantics remain outside Host.
