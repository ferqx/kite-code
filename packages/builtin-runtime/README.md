# Builtin Runtime

Private home for Kite-specific runtime semantics. `createBuiltinRuntimeModules()`
is the frozen composition surface for the six RMV1-10 through RMV1-15 modules,
which register the unique Runtime SPI owner and executor for all 29 operations.
The frozen snapshot contains exactly 20 model-visible tools and 9 internal
operations; package tests derive both counts and every schema, description,
effect, capability revision, and executor revision from those registrations.
These package-level facts are not by themselves proof of production cutover:
the App/Host composition must pass its exact frozen snapshot to every caller,
and the RMV1 owner/delete manifests close only after the old callers are gone.

`createBuiltinToolCatalogProjectionV1()` derives the immutable model-visible
catalog and schema-only AI SDK `ToolSet` from that registered SPI snapshot. It
also exposes an exact-operation dispatch method that delegates to the Host's
single `CapabilityExecutionPortV1`; it never selects a fallback or invokes a
second handler. Each entry carries the Builtin-owned strict parser and unknown-
field observer, legacy/v2 contract descriptions, typed availability decision,
dynamic effects classifier, scheduler traits, minimum-approval metadata, and a
strict runtime descriptor. Binding identity, exposed tool name, revision, schema
digest, availability, and the canonical binding digest are checked before any
port call; a missing turn context fails closed for gated tools.

`mcp:dynamic_tool` remains one internal wrapper around the Host-supplied MCP
runtime and never enters the 20-tool model surface. `builtin:ask_user` remains
an interrupt owned by the Runtime/Kernel-to-client user-input terminal; catalog
dispatch rejects it before calling an execution port. The `task` model parser and ToolSet expose
only the public planning-mode schema; its private `taskArtifact` branch is
runtime-only.
