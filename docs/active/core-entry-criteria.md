# Runtime package entry criteria

状态：active
读取时机：新增或重构 Runtime capability、Kernel 状态机、策略、Host 生命周期或 App composition 前。
验证：对应分类所要求的单测、产品恢复测试、ADR、`bun run check:core-boundary` 与 `bun run check:runtime-packages`。

实现前先按 production owner 分类，并把代码放入 `agent-kernel`、`runtime-host`、`runtime-spi`、
`builtin-runtime`、`runtime-contract` 或 `apps/kite` 的唯一正确边界；已删除的 `src/core/` 不能重新成为落点。

| Category | Meaning | Minimum evidence |
|---|---|---|
| Capability | Adds a tool or integration without changing runtime decisions | Unit tests and code review |
| Policy | Changes approval, automation, continuation, or planning decisions | Unit tests, state diagram, architecture review |
| Lifecycle | Changes plan, tool, turn, approval, or input transitions | State diagram, replay/golden test, ADR |
| Engine | Changes model loop, persistence, checkpoint, resume, or streaming | Feature flag, ADR, staged validation |

Existing examples: web/MCP/skills are Capabilities; auto and plan modes are Policy + Lifecycle; the Runtime Kernel is an Engine; loop mode is Policy + Lifecycle + Engine.

Before merge, confirm category, production owner, required tests/docs, feature-flag need, State impact,
lifecycle states, authorization/policy routing, and package-boundary impact. Capability 具体语义属于 Builtin，
纯确定性决策属于 Kernel，通用生命周期属于 Host，具体依赖组合只属于 App。
