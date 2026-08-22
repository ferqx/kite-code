# Runtime SPI

Private compile-time boundary for runtime modules. It is not a same-process
security sandbox or a public plugin ABI. RMV1-08 freezes the module lifecycle,
capability/executor/context/normalizer/adapter contracts and the duplicate-safe
registry. Capability definitions may carry immutable model visibility, tool name,
legacy/v2 descriptions, Builtin-owned parser/canonicalizer observers, typed
availability, per-invocation effect classification, execution traits,
minimum-approval metadata, and a strict descriptor projection. Builtin Runtime projects those
facts from the one frozen snapshot without introducing a second schema,
description, effect, availability, trait, or revision authority. Registration
is synchronous and sealed; Host owns bounded start and reverse-order disposal.
State 25, Store 4, and the current epoch remain unchanged.
