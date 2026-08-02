# Verification、MCP Write 与 Skills Release Track

状态：active
读取时机：修改 capability profile/admission/status、Verification completion、MCP write recovery/route
或 Skill readonly/effectful 分类与 conformance 时。
验证：`bun test tests/release/capability-profile.test.ts tests/release/capability-maturity-gate.test.ts tests/capabilities/status-projection.test.ts
tests/verification tests/mcp/write-*.test.ts tests/skills/effect-classification.test.ts
tests/skills/workflow-contract.test.ts tests/evals/capabilities`、`bun run typecheck`。
相关：ADR-0008、ADR-0051、ADR-0064、D-10、Phase 5。

## 通用 Profile 与状态

四个本地 profile（Verification、MCP write、Skills readonly/effectful）固定
`under_development/off`，route/platform allowlist 为空，freshness=0。strict parser 拒绝 unknown 字段、
非 canonical identity、unknown feature flag 和 dependency 重复；任何 enabled profile 必须有明确
platform、非零 freshness，并在 admission 时验证全部 required feature flags、dependency revision、
embedded ceiling、实际 evidence age 与 G3/G4/G5 passed。MCP write 还必须有非空 route allowlist。

状态投影分别展示 Agent final、Runtime terminal、Plan lifecycle、check counts 与 Verification；任何一项
都不能模糊成另一项。Rollback 只关闭新 admission/cohort=0，并保留 Receipt 与已有 required
Verification。Task 5.1/5.2 的本地 Profile、admission 与状态 foundation 已完成；当前 profile/Gate
仍不产生 internal/canary/maturity evidence。

`scripts/evals/contracts/capability-evaluation-evidence.ts` 是四条轨道共用的 production-owned retained
evidence schema/verifier。它逐项绑定 Release artifact、route、profile、evaluator、repository/head/ref、
workflow ref/SHA、run/attempt/job 与 retained artifact ID，重建 digest-chained receipt ledger，并针对
Verification false pass/fabrication/bypass、MCP duplicate/unauthorized/data violation，以及 Skill
malicious instruction/shadowing/dependency/reference/effect violation 执行 capability-specific G0。
production OIDC/keyless Sigstore authority registry 当前固定为空，所以即使本地 ledger 全部通过也只能
`blocked/evidenceEligible=false`；本地失败则为 `failed`，不能被 authority 缺失掩盖。

`scripts/release/capability-maturity-gate.ts` 预构建统一 canary → beta → stable Gate：每阶段使用不同
decision/window ID，绑定相同 payload/profile/route/platform/contract/evaluator identity，并验证预注册
时间窗、样本、error budget、G3–G5、真人 approval、用户理解度、回滚和 freshness。production
authentication verifier 明确未实现；受信 evidence authority、已验证前序 maturity decision 与已验证真人
approval 三个 registry 也分别固定为空。任何单一 registry 或 shape-valid fixture 都不能补齐另外三类
认证事实并触发 promotion。该预构建不绑定新 Task，不产生 internal/canary/stable milestone。

## Verification

`verificationV1=false` 只关闭新 admission；Runtime 中已有 required facts 继续执行和 replay。risk source
只能提高 verification mode；failed/inconclusive、repair pending、budget exhausted 和 compensation 都不
是 passed。只有结构化用户 waiver 可以在预算耗尽后形成独立 waived 状态，模型不能自发 waiver。
Task 5A.1/5A.2 的 completion semantics 与 required lifecycle 本地 conformance 已完成。

## MCP write

MCP write 同时要求 `mcpExecutionRecordV1` 与 `mcpProviderActionV1`、精确 binding/schema/revision、
Provider Data/egress/network policy、qualified route 和 stable Verification dependency。所有 write 保留
intent/receipt；只有带 idempotency 的同 invocation replay 可返回已有 receipt。unknown external effect
只能 reconciliation，不能重放；Provider action 只恢复 control plane。当前 production write route 为空，
formal adversarial/task evidence=`not_observed`，所以轨道 blocked/off。

## Skills

只有 effective effects 全部为 `none|read`、所有 dependency effects 已知且同样只读、来源允许且 project
Workspace 已信任时，Skill 才能分类 readonly。任一 write/destructive/unknown dependency 都归
effectful；effectful 必须 required Verification。Workflow contract 继续 strict schema/revision/reference/
symlink/size/output/frame/recovery/budget 边界，malicious instruction 不能扩大 ceiling，也不恢复把
SKILL.md 正文直接注入模型的旧路径。Task 5C.1/5C.2 的分类与 Workflow Contract 本地
conformance 已完成。

本地 5.3B/5.3C adapter 固定 `local_contract_only`/blocked；duplicate/unauthorized/data violation 或
effect/reference drift 使 capability off。真实 route、formal task evidence、internal/canary 运行和
maturity producer 未发生，所有 Phase 5 stable milestone 均未产生。
