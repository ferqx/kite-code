# Runtime 模块准入

状态：active
读取时机：新增或重构 Runtime capability、Kernel 状态机、策略、Host 生命周期或 App composition 前。
验证：对应分类所要求的单测、产品恢复测试、`bun run check:core-boundary` 与 `bun run check:runtime-packages`；有持久影响的重要取舍按根规则记录 Agent Note。

实现前先按 production owner 分类，并把代码放入 `agent-kernel`、`runtime-host`、`runtime-spi`、
`builtin-runtime`、`runtime-contract` 或 `apps/kite-service` 的唯一正确边界；已删除的 `src/core/` 不能重新成为落点。

| Category | Meaning | Minimum evidence |
|---|---|---|
| Capability | Adds a tool or integration without changing runtime decisions | Unit tests and code review |
| Policy | Changes approval, automation, continuation, or planning decisions | Unit tests, state diagram, architecture review |
| Lifecycle | Changes plan, tool, turn, approval, or input transitions | State diagram, replay/golden test; important decisions use Agent Notes |
| Engine | Changes model loop, persistence, checkpoint, resume, or streaming | Applicable feature flag, staged validation; important decisions use Agent Notes |

Existing examples: web/MCP/skills are Capabilities; auto and plan modes are Policy + Lifecycle; the Runtime Kernel is an Engine; loop mode is Policy + Lifecycle + Engine.

Before merge, confirm category, production owner, required tests/docs, feature-flag need, State impact,
lifecycle states, authorization/policy routing, and package-boundary impact. Capability 具体语义属于 Builtin，
纯确定性决策属于 Kernel，通用生命周期属于 Host，具体依赖组合属于 Service App，CLI/Web 只拥有客户端展示与接入。产品预期先核对手册，重要取舍按根规则决定是否新增 Agent Note。

2026-10-26 已按用户要求删除除 `apps/kite-cli` 外的旧架构模块。当前实现由[八 workspace 边界](unified-agent-boundary.md)及各现行 owner 定义；本文指向删除前固定 revision 的源码、旧模块机制和旧测试仅供历史追溯，不再是可运行入口。仍适用的授权、未知结果、恢复、数据保护与发布资格约束继续生效，删除源码不表示这些门禁已经通过。
