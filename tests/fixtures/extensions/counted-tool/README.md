# Counted tool fixture

This independent extension is a disposable test capability, never default production assembly. It records actual invocation identities in an append-only file outside the tested profile. Restoring a profile therefore cannot erase evidence that a tool ran.

Its only Kite dependency is the public `@kite-ai/agent/extensions` export. Its own build leaves that SDK external; the test host explicitly loads the built extension. This fixture does not authorize itself or own Command/Run/Execution state.

The P1 process harness uses fixed model responses and harmless temporary files. Source builds provide early extension-boundary evidence; full source-tree-independent host packaging remains a separate acceptance requirement.
