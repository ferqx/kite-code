# Compaction Release Qualification 边界

状态：active
读取时机：修改 compaction case、事实 matcher、semantic/continuation evaluator、route qualification、
无压缩 handoff 或 compaction release Gate 时。
验证：`bun test tests/evals/compaction tests/runtime/context-compaction-e2e.test.ts`、
`bun run typecheck`。
相关：ADR-0021、ADR-0022、ADR-0024、ADR-0057、Phase 4。

## 当前本地 contract

`CompactionCaseV1` 只接受 versioned synthetic transcript、1–5 轮增量、分类 critical/important facts、
exact/normalized/semantic matcher、forbidden claim 和可选 continuation。fact ledger 只存在于测试，
不会进入 production checkpoint 或创建第二份正文。

结构 adapter 覆盖 direct/incremental/reset、tool pair、transcript immutability、checkpoint digest/replay/
revision、lease/environment drift、summary rejection 和 system/tool/Plan/Verification/Runtime 权威重注入。
失败保持原状态；invalid checkpoint、orphan tool result 或状态损坏为 G0。

deterministic matcher 优先 exact/normalized；critical loss、forbidden claim、approval/Verification/Plan
反转都不能被 semantic score 覆盖。原 blind semantic contract 继续把未配置 route/evaluator 的 score
与 uncertainty 固定为 `not_observed`。新增的 formal evidence verifier 只接受固定 opaque 格式的 blind
ID、逐项 case/reference/candidate-content commitment、完整 receipt chain 和确定性重建的 score/uncertainty
aggregate；它绑定完整 `ReleaseArtifactIdentityV1`、repository/repository ID、head/ref、workflow
path/ref/SHA、run/attempt、job/artifact、route/config、suite/scorer、candidate set/fixture 与受信
deterministic safety report+outcome。分组标签、缺失、重复、重排、aggregate/payload/candidate splice 全部
拒绝，critical deterministic failure 始终覆盖 semantic pass。

GitHub OIDC/attestation verifier 当前未配置，formal workflow 与真实 evaluator receipt 也未执行，因此
结构完整的本地 fixture 仍为 blocked、`evidenceEligible=false`、milestone=null。uncertainty 超限保持
inconclusive/blocked，低于阈值或 deterministic safety 失败为 failed。control/treatment continuation
在阈值、样本和 route 未预注册时同样 blocked，不能用单次 synthetic pass 宣称非劣。

## Route、handoff 与 Gate

Route identity 绑定 provider/endpoint/model/capability sources、summary/token/narrative limits、prompt/
policy/estimator、Tool/Skill、Provider Data Policy、suite/scorer 和 artifact digest；任一变化撤销旧结果。
当前 qualified route set 为空，自定义 endpoint 无资格。

无资格时 manual/auto 都关闭，禁止 silent compact；handoff contract 要求保留 transcript 并可保存
diff、Plan、checks、pending，超长任务明确 unsupported，`/clear`/新 session 不能冒充成功压缩。
4.9 adapter 固定 `synthetic`/`nonDistributable`/`evidenceEligible=false`/blocked，effective stage=off、
cohort=0、milestone=null，不产生 `MS:4-INTERNAL-AUTO-FRESH`。

真实 live Provider matrix、预注册 continuation、CLI/TUI handoff、internal rollout freshness、external
manual canary 和 maturity 都必须等待实际 run/evidence；本地 contract 不替代它们。
