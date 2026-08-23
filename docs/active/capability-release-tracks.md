# Verification、MCP Write 与 Skills Release Track

状态：active
读取时机：修改 capability profile/admission/status、Verification completion、MCP write recovery/route
或 Skill readonly/effectful 分类与 conformance 时。
验证：`bun test tests/release/capability-profile.test.ts tests/release/capability-maturity-gate.test.ts tests/capabilities/status-projection.test.ts
tests/verification tests/mcp/write-*.test.ts tests/skills/effect-classification.test.ts
tests/skills/workflow-contract.test.ts`、`bun run typecheck`。
相关：ADR-0008、ADR-0051、ADR-0064、ADR-0068、ADR-0069、D-10、Phase 5。

当前只要求 Verification、MCP write、Skills readonly/effectful 的本地 profile、status、conformance、
recovery 与 adversarial Gate。旧 internal dogfood、external canary、beta/stable maturity 和 authority
路线已由 ADR-0069 取代，不再形成发布阶段或未来 Task。四条 capability 继续默认 off；只有本机用户可
显式开启，且配置不能扩大 embedded ceiling。unknown/destructive/MCP write/Verification false pass 的
fail-closed 语义不变。

## 通用 Profile 与状态

四个本地 profile（Verification、MCP write、Skills readonly/effectful）固定
`under_development/off`，route/platform allowlist 为空，freshness=0。strict parser 拒绝 unknown 字段、
非 canonical identity、unknown feature flag 和 dependency 重复；任何 enabled profile 必须有明确
platform、非零 freshness，并在 admission 时验证全部 required feature flags、dependency revision、
embedded ceiling、实际 evidence age 与 G3/G4/G5 passed。MCP write 还必须有非空 route allowlist。

状态投影分别展示 Agent final、Runtime terminal、Plan lifecycle、check counts 与 Verification；任何一项
都不能模糊成另一项。Rollback 只关闭新 admission 并保留 Receipt 与已有 required Verification。
Task 5.1/5.2 的本地 Profile、admission 与状态 foundation 已完成。

旧 capability retained-evidence schema、producer/verifier、contract-only adapter 和无 authority workflow
已删除：它们在空 registry 下只能固定产出 `blocked/evidenceEligible=false`，且 ADR-0069 后不再对应产品路线。
当前安全证明由实际 profile/admission/status、Verification、MCP write governance 和 Skill workflow 测试负责。
未来若引入真实发布 authority，必须先确定可信根、route 和证据消费者，再建立新的端到端 evidence contract。

## Verification

`verification=false` 只关闭新 admission；Runtime 中已有 required facts 继续执行和 replay。risk source
只能提高 verification mode；failed/inconclusive、repair pending、budget exhausted 和 compensation 都不
是 passed。只有结构化用户 waiver 可以在预算耗尽后形成独立 waived 状态，模型不能自发 waiver。
Task 5A.1/5A.2 的 completion semantics 与 required lifecycle 本地 conformance 已完成。

## MCP write

MCP write 同时要求 `mcpExecutionRecord` 与 `mcpProviderAction`、精确 binding/schema/revision、
Tool policy/approval、execution boundary、exact endpoint/network admission、qualified route 和 stable Verification dependency。所有 write 保留
intent/receipt；只有带 idempotency 的同 invocation replay 可返回已有 receipt。unknown external effect
只能 reconciliation，不能重放；Provider action 只恢复 control plane。当前 production write route 为空，
formal adversarial/task evidence=`not_observed`，所以轨道 blocked/off。

admission、intent/receipt/idempotency/reconciliation/compensation、route qualification/drift/safety/staleness
现由 production-owned `packages/builtin-runtime/src/mcp/write-governance.ts` 实现，不再由测试 fixture 拥有规则；测试只复用
该模块。`release/mcp-write-routes.json` 是 source-owned strict registry，当前显式为空。实际 MCP
dispatch 尚未获得非空 production route 或 stable Verification evidence，因此任何 write capability 仍
保持 off。旧 production stable milestone 已被取代；5B 本地 conformance、安全 Gate 与默认关闭状态
已经完成。

MCP Manager 已接入可选且在 sealed production 中强制的 durable write dispatch guard。生产配置缺 guard
会在 Provider 调用前拒绝；admission/intent 或 receipt 持久化失败同样拒绝，provider 异常只记录 unknown
而不自动重放。该接线只补齐 actual dispatch 边界，不提供 route/authority，也不改变当前空 registry。

## Skills

只有 effective effects 全部为 `none|read`、所有 dependency effects 已知且同样只读、来源允许且 project
Workspace 已信任时，Skill 才能分类 readonly。任一 write/destructive/unknown dependency 都归
effectful；effectful 必须 required Verification。Workflow contract 继续 strict schema/revision/reference/
symlink/size/output/frame/recovery/budget 边界，malicious instruction 不能扩大 ceiling，也不恢复把
SKILL.md 正文直接注入模型的旧路径。Task 5C.1/5C.2 的分类与 Workflow Contract 本地
conformance 已完成。

duplicate/unauthorized/data violation 或 effect/reference drift 继续使 capability off。旧 rollout 与 stable
milestone 已被取代，不存在待完成的 Phase 5 promotion Task。
