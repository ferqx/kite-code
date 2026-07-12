# Core entry criteria

状态：active
读取时机：新增或重构 `src/core/` 功能、状态机、策略或执行引擎前。
验证：对应分类所要求的单测、golden/replay 测试、ADR 与 `bun run check:core-boundary`。

Classify every feature entering `src/core/` before implementation.

| Category | Meaning | Minimum evidence |
|---|---|---|
| Capability | Adds a tool or integration without changing runtime decisions | Unit tests and code review |
| Policy | Changes approval, automation, continuation, or planning decisions | Unit tests, state diagram, architecture review |
| Lifecycle | Changes plan, tool, turn, approval, or input transitions | State diagram, replay/golden test, ADR |
| Engine | Changes model loop, persistence, checkpoint, resume, or streaming | Feature flag, ADR, staged validation |

Existing examples: web/MCP/skills are Capabilities; auto and plan modes are Policy + Lifecycle; the Runtime Kernel is an Engine; loop mode is Policy + Lifecycle + Engine.

Before merge, confirm category, required tests/docs, feature-flag need, InteractionState impact, lifecycle states, authorization/policy routing, and layer-boundary impact.
