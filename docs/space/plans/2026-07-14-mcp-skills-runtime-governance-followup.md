# MCP 与 Skills Runtime 治理后续计划

状态：active
优先级：P1
依赖：`2026-07-14-mcp-runtime-governance-p0.md`、ADR-0007、ADR-0008
来源：`docs/design/2026-07-14-mcp-skills-runtime-governance-rfc.md`

## 目标

在已完成的 MCP catalog/binding 垂直链路之上，补齐可恢复执行、Skill Workflow Contract、分级验证和大规模能力披露；不重写 Runtime Kernel，也不恢复旧 MCP 或 Prompt Skill 路径。

## RFC 覆盖矩阵

本计划与已完成的 P0 共同构成 RFC 的实施范围追踪。RFC 的现状诊断、外部依据和明确拒绝的替代方案属于设计论证，不作为独立交付项；其余具备实现意义的约束必须在下表中有归属和可验证结果。

| RFC 范围 | 归属 | 可验证结果 |
| --- | --- | --- |
| Capability identity、snapshot、turn binding、原生 schema、MCP 结构化结果、per-tool policy/approval | 已完成 P0 | ADR-0007 与 P0 测试证明未绑定/过期调用 fail closed，结果不降级为字符串。 |
| 动态 MCP invocation 的公共 envelope，以及 Builtin 强类型联合不被动态类型替换 | P0 + Phase 2 | 动态调用携带 invocation、binding 与 task/turn/plan context；Builtin 保持判别联合，仅经 adapter 接入统一 provider 边界。 |
| feature flag 的默认关闭、阶段启用和 fail-closed 回滚 | P0 + 各后续 Phase | 每个新子系统有对应 flag；关闭时不恢复旧路径，也不得绕过已开始的 reconciliation 或安全审批。 |
| MCP health、连接生命周期、退避/熔断/quarantine | Phase 2 | 调用方只消费 health projection，断线、超时与半开熔断均有集成测试。 |
| invocation intent、receipt、evidence、Artifact Store、idempotency 与 reconciliation | Phase 2 | 外部写前持久化 intent；未知写不盲目重放；receipt 可追溯授权、参数、证据和外部引用。 |
| trusted MCP 建立/撤销、provenance 与 per-tool override | Phase 2 | trust 配置格式、管理边界、撤销语义和本地策略优先级受测试覆盖；远端 annotations 不可扩大授权。 |
| 完整 Skill Workflow Contract、严格 YAML compiler、revision/diagnostics、activation/frame | Phase 3 | 只有通过编译的 Skill 可激活；损坏或依赖过期 Skill 可诊断但不可执行。 |
| Skill capability ceiling、`context: fork`、高风险禁止隐式激活、按需读取大引用 | Phase 3 | Skill 不可提升 Session 授权；高风险 workflow 只能显式激活；大文件以 artifact/reference 处理而非截断注入。 |
| 分级 verification、完整 VerificationSpec、原始 evidence reviewer、repair/replan/waive/compensation/budget | Phase 4 | required verification 未通过或未经用户结构化 waive 不得完成；reviewer 使用 receipt/evidence 而非主模型结论。 |
| progressive disclosure、provider/context fallback 与无裸 invoke 后门 | Phase 5 | 搜索仅发现候选，下一轮重新 binding；不支持搜索时 fail closed，不注入旧 MCP 路径。 |
| Runtime 事件不变量、effect 扩展、replay/golden、安全与最终可追溯性验收 | Phase 2–5 | reducer 是唯一持久状态入口；完整链路可回答来源、可见性、授权、执行、证据、验证和恢复理由。 |

## Phase 2：Health、Execution Record 与恢复

当前进度：完成。已完成 health projection、熔断状态，以及受 `mcpExecutionRecordV1` 保护的 intent/terminal/unknown 事件和 receipt 投影；Artifact Store 已将受限 immutable handle 接入 success receipt。trusted provenance、稳定 idempotency key 与受控重试、unknown 的显式 reconciliation/waive 门禁均已实现，并覆盖了 restart/replay 崩溃边界。

1. 将 MCP `connected` 布尔状态升级为 health projection，覆盖 connecting、discovering、ready、degraded、circuit_open 和 quarantined，以及退避/半开熔断。
2. 新增 `capability.invocation_recorded`、started、succeeded、failed、unknown 等 Runtime events；外部写入必须在 provider call 前持久化 intent、稳定 invocation ID、authorization digest 和可选 idempotency key。
3. 从事件生成 ExecutionReceipt projection；对“请求已发出、结果未落盘”的调用标为 unknown，恢复时只允许 reconciliation/read-after-write 或用户决定，禁止盲目重放外部写。
4. 为大结果和敏感 MCP metadata 引入 Artifact Store handle、大小上限和白名单持久化；checkpoint/event 仅保存摘要、digest 和 handle。
5. 定义 trusted MCP 的建立、撤销和 provenance 配置；本地 per-tool override 始终优先于静态规则、可信 annotations 和保守默认值，且 trust 只能收紧风险或重试条件，不能扩大授权。
6. 将动态 MCP request 演进为公共 invocation envelope，保存 invocation ID、binding、原始参数与 thread/turn/task/plan-step context；Builtin 继续保留现有判别联合，仅通过 adapter 对接统一 provider 边界。

退出标准：任意外部写可追溯授权、参数摘要、结果/evidence 与外部引用；崩溃恢复不会重复未知写入；trusted provenance 可审计、可撤销且不能绕过最小审批。

## Phase 3：Skill Workflow Compiler 与 Activation

当前进度：完成。已引入完整 YAML parser 与 `compileSkillWorkflow()`，以严格 manifest 字段、对象根 JSON Schema、路径边界、风险隐式激活和依赖解析生成可诊断的 `skill` capability；revision 覆盖 Skill 目录中的所有文件与当前依赖 revision。catalog 已接入 Runtime 的 revision、activation/frame 事件与持久状态：模型只可请求受 flag 保护的 `activate_skill`，旧 `Skill` 调用被拒绝，CLI/TUI 均改为发送显式 activation 而不拼接正文；同 revision 的 inline contract 才进入模型上下文，catalog drift 会使 frame 失效。active frame 的 capability ceiling 已在每次工具执行前强制检查，inline 与 fork 均须以 `output_schema` 校验的结构化结果关闭 frame。fork contract 在隔离 subagent 中执行，将 ceiling 下推为工具 allowlist；其 MCP binding 在实际调用前重新验证 capability revision、schema digest 与参数，变化或不可用时 fail closed。supporting files 仅披露路径，模型须以受 active frame、revision、声明目录和大小限制约束的 `read_skill_reference` 按需读取，绝不将大型内容截断后注入 prompt。Verifier 的执行语义仍留在 Phase 4。

1. 以标准 YAML parser 和严格版本化 schema 编译 `SKILL.md` Workflow Contract；校验输入/输出 schema、依赖 capability revision、effects、approval、脚本、references/assets/evals，并输出结构化 diagnostics。
2. 将 Skill 注册为 catalog capability，计算覆盖 manifest、正文、脚本和资源的 revision；损坏 Skill 可诊断但不可激活，依赖 revision 变化使旧 activation 失效。
3. 新增 activation/frame Runtime events 和 durable state；显式用户调用或模型工具请求都经 input validation、capability ceiling 与全局 policy；实现 manifest 声明的 `inline`/`fork` context mode。
4. 对发布、部署、费用、外部工单/消息、删除、凭据/权限等高风险 Skill 强制 `allow_implicit: false`；模型只能建议激活，不能代替用户启动。
5. 大型 scripts/references/assets/evals 不得截断后注入上下文，改为按需读取且以受限 artifact/reference 暴露。
6. 删除旧 Prompt Skill loader/`Skill` 正文返回/TUI `pendingSkillsContent + task` 拼接路径；TUI/CLI 只发 activation action 并渲染状态。

退出标准：所有可用 Skill 都是可查询来源/revision/权限上限的 Workflow Contract，仓库 Skill 不能提升 Session 授权。

## Phase 4：Verifier 与分级 Verification

1. 实现 `not_required`、`best_effort`、`required` policy；外部写、高风险 capability、Skill required verifier 和用户明确验证要求只能提升强度。
2. 实现版本化 `VerificationSpec`，覆盖文件断言、命令、schema、MCP read-after-write、外部引用和 reviewer；新增 verification events/effects/state，优先运行确定性本地断言、provider read-after-write、测试/构建，再使用独立 reviewer；reviewer 必须读取原始 receipt/evidence。
3. Scheduler 仅在 required verification pending 时阻止 `emit_final`；实现 repair/replan、用户 waiver、compensation 与重试/repair budget。

退出标准：required verification 未通过或未经用户结构化 waive 时不能标记为已验证完成，普通问答仍可直接结束；模型不能自行豁免。

## Phase 5：Progressive Disclosure

1. 实现 provider-neutral `capability_search`，仅返回候选 metadata，并在下一轮生成有限 binding；禁止裸 capability invoke 后门。
2. 按 provider 能力和 context budget 在全部绑定、搜索和 fail-closed 之间选择；搜索失败或 provider 不支持时不回退旧 MCP 注入路径。
3. 基准测试大 catalog 的上下文占用、搜索召回率和 binding/revision 安全性。

退出标准：大量 MCP/Skill capability 不会无界占用模型上下文，所有实际调用仍经过 Runtime binding 与 policy gateway。

## 共同验证

- Phase 2：崩溃点 replay/golden（intent 前后、provider 请求后未持久化、reconciliation）。
- Phase 2：health 断线/重连/半开熔断、trusted provenance 建立/撤销、per-tool override 优先级，以及 invocation envelope/Builtin 联合回归。
- Phase 3：manifest/compiler/activation、权限上限、`context: fork`、高风险隐式激活拒绝、大引用按需读取、损坏 Skill diagnostics 和 TUI/CLI 集成测试。
- Phase 4：required verification 的 failed→repair→passed、inconclusive→user decision/waive、reviewer 原始 evidence，以及 budget exhaustion。
- Phase 5：大规模 catalog、搜索后 rebinding、过期 binding/approval 和 prompt-injection 安全回归。
- 每个 Phase 的 flag 默认关闭；flag 关闭、配置/CLI 覆盖与回滚均验证 fail-closed，且不恢复被替代的旧路径。
- 最终验收：针对任意治理能力调用，能够追溯发现来源、revision、turn 可见性、参数、effect、审批、执行确定性、evidence、验证状态和恢复决策。
- 每阶段运行目标 Bun 测试、`bun run typecheck`、`bun run check:core-boundary` 与 `bun run check:docs`。
