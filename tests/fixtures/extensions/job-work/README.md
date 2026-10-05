# Controlled Job integration fixture

This private Extension imports only the public `@kite-ai/agent/extensions` contract. Its build emits a standalone Bun artifact with that public package as an external dependency; the Service tests also load an independently built artifact. There are no application source aliases, paid models, user credentials or user data.

`createJobWork` supplies real external start/end ledgers, controlled admission/start/end barriers and a known stopped cancellation result. Normal Tool and direct Action definitions admit the same Job through public operations. An active Action can cancel its exact OperationRef through the same public interface. The Job declares a process slot and optionally a Workspace serial key; it reports explicit ended supervision before resource disposal. This harmless fixed adapter does not claim native process-group supervision or restart reconciliation.

Output events exercise the actual SQLite prefix budget and coalesced dropped intervals through authenticated Service GETs. Barriers control the experiment; the Store, Worker, HTTP listeners and OS Workspace locks are real and are never mocked.
