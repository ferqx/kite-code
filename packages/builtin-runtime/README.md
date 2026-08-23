# Builtin Runtime

Private home for Kite-specific runtime semantics. `createBuiltinRuntimeModules()`
is the frozen composition surface for the domain modules, which register the
unique Runtime SPI owner and executor for every Builtin operation.
The frozen snapshot contains exactly 20 model-visible tools and 9 internal
operations; package tests derive both counts and every schema, description,
effect, capability revision, and executor revision from those registrations.
These package-level facts are not by themselves proof of production cutover:
the App/Host composition must pass its exact frozen snapshot to every caller,
and the architecture manifests close only after every production caller uses
the same frozen snapshot.

`createBuiltinToolCatalogProjection()` derives the immutable model-visible
catalog and schema-only AI SDK `ToolSet` from that registered SPI snapshot. It
also exposes an exact-operation dispatch method that delegates to the Host's
single `CapabilityExecutionPort`; it never selects a second handler. Each entry
carries one current description, the Builtin-owned strict parser and unknown-
field observer, typed availability, dynamic effects, scheduler traits,
minimum-approval metadata, and a strict runtime descriptor.

Domain runtime modules live under `git`, `model`, `planning`, `subagent`, and
`verification`. Skill, Subagent, and Verification APIs are available only from
their package subpaths; the root barrel is reserved for module composition and
cross-domain capability surfaces.

`mcp:dynamic_tool` remains one internal wrapper around the Host-supplied MCP
runtime and never enters the 20-tool model surface. `builtin:ask_user` remains
an interrupt owned by the Runtime/Kernel-to-client user-input terminal; catalog
dispatch rejects it before calling an execution port. The `task` model parser and ToolSet expose
only the public planning-mode schema; its private `taskArtifact` branch is
runtime-only.
