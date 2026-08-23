# Runtime SPI

Private compile-time boundary for runtime modules. It is not a same-process
security sandbox or a public plugin ABI. It freezes the module lifecycle,
capability/executor/context/normalizer/adapter contracts and the duplicate-safe
registry. Neutral capability, execution, model-context, and module-lifecycle
ports live in `capability.ts`, `execution.ts`, `model.ts`, and `modules.ts`;
filesystem, sandbox, MCP, Subagent, and Tool Pipeline ports remain separate
domain modules. Builtin Runtime projects immutable parser, availability,
effects, traits, descriptions, and revisions from one frozen snapshot without a
second authority. Registration is synchronous and sealed; Host owns bounded
start and reverse-order disposal. Schema and protocol versions remain metadata,
not alternate public surfaces.
