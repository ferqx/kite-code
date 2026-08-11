# Compaction Release Qualification 边界

状态：active
读取时机：修改 compaction case、事实 matcher、semantic/continuation evaluator、route qualification、
无压缩 handoff 或 compaction release Gate 时。
验证：`bun test tests/evals/compaction tests/runtime/context-compaction-e2e.test.ts tests/runtime/context-compaction-shadow-gate.test.ts tests/release/capability-profile.test.ts`、
`bun run typecheck`。
相关：ADR-0021、ADR-0022、ADR-0024、ADR-0057、ADR-0069、Phase 4。

## 当前本地 contract

`CompactionCaseV1` 只接受 versioned synthetic transcript、1–5 轮增量、分类 critical/important facts、
exact/normalized/semantic matcher、forbidden claim 和可选 continuation。fact ledger 只存在于测试，
不会进入 production checkpoint 或创建第二份正文。

结构 adapter 覆盖 direct/incremental/reset、tool pair、transcript immutability、checkpoint digest/replay/
revision、lease/environment drift、summary rejection 和 system/tool/Plan/Verification/Runtime 权威重注入。
Controller 必须从 source projection 重新计算 checkpoint 的 before/after token estimate，不能信任 compactor
自报的缩减值；RuntimeStore effect lease 保证同一 `thread_id + compaction_id` 跨连接只 dispatch 一次
Provider，snapshot revision CAS 拒绝 stale writer 和删除后的晚到写入。失败保持原状态；invalid checkpoint、
orphan tool result 或状态损坏为 G0。

deterministic matcher 优先 exact/normalized；critical loss、forbidden claim、approval/Verification/Plan
反转都不能被 semantic score 覆盖。原 blind semantic contract 继续把未配置 route/evaluator 的 score
与 uncertainty 固定为 `not_observed`。新增的 formal evidence verifier 只接受固定 opaque 格式的 blind
ID、逐项 case/reference/candidate-content commitment、完整 receipt chain 和确定性重建的 score/uncertainty
aggregate；它绑定完整 `ReleaseArtifactIdentityV1`、repository/repository ID、head/ref、workflow
path/ref/SHA、run/attempt、job/artifact、route/config、suite/scorer、candidate set/fixture 与受信
deterministic safety report+outcome。分组标签、缺失、重复、重排、aggregate/payload/candidate splice 全部
拒绝，critical deterministic failure 始终覆盖 semantic pass。

`compaction-semantic-evaluation.yml` 现提供手动、无发布/OIDC 权限的 contract producer/verifier。
workflow 不读取可变 worktree 输入：它禁用 replacement objects、确认 `GITHUB_SHA` 为 commit，再从该
Git tree 精确解析 normalized repository-relative path，只接受 `100644/100755` blob，并由 `git cat-file`
写入 runner temp 的只读 snapshot。semantic evidence 测试显式断言 workflow 不含
`path: ${{ env.* }}` 这类环境表达式身份替换，producer 输入路径必须来自 Git tree 中的真实文件。
原始 worktree
即使被修改或生成 untracked 文件也不会进入 producer；tracked path、Git blob ID 与 snapshot SHA-256
进入 source identity，上传、producer 和独立 verifier 全部消费同一 snapshot，并使用 upload action 返回的
真实 retained artifact ID；
source 明确为 `github_actions_unsigned_contract`，signature 固定 `unconfigured/none`，不得使用调用者提供的
伪 artifact/attestation identity。verifier 的 repository/head/ref/workflow/run/attempt 与 retained artifact
expected identity 来自 workflow 环境，并重建完整 ledger/digest。Production authentication shape、
payload subject、Sigstore authority/verifier/workflow 与 evaluator-route exact tuple lookup 已实现；它只消费
预先由外部 verifier 认证并在源码中精确登记的 subject/attestation/verification receipt，不执行 Sigstore
密码学验证；source-owned
authority 和 evaluator route registry 仍为空，真实 evaluator receipt 也未发生，因此结构完整的 contract artifact 仍为 blocked、
`evidenceEligible=false`、milestone=null。uncertainty 超限保持
inconclusive/blocked，低于阈值或 deterministic safety 失败为 failed。control/treatment continuation
在阈值、样本和 route 未预注册时同样 blocked，不能用单次 synthetic pass 宣称非劣。continuation 与
route qualification 规则现由 `scripts/evals/contracts/` production-owned 模块拥有；测试文件只保留薄
fixture/re-export。它们使用 domain-separated digest、strict registry 和 drift invalidation，本地 qualified
route set 仍不可变为空。

## Route、handoff 与 Gate

Route identity 绑定 provider/endpoint/model/capability sources、summary/token/narrative limits、prompt/
policy/estimator、Tool/Skill、Provider Data Policy、suite/scorer 和 artifact digest；任一变化撤销旧结果。
当前 qualified route set 为空，自定义 endpoint 无资格。

Slice A 的 deterministic L2 reclaim 使用独立、source-owned 的 route evidence registry；该 registry 当前也为空。
本地 2,000-block/8 MiB evidence producer 与独立 verifier 只证明 frozen fixture 下的 latency、isolated maxRSS
增量、metadata 上限、off payload identity 和 tamper/drift fail-closed，不构成真实 Provider route qualification。
用户配置、模型名、本机 benchmark 或 synthetic receipt 不能写入 registry 或产生 production support；因此
`reclaimMode=live` 仍是显式 development-only 路径。旧 Slice B 的 L3 route/cache qualification runner 与
registry branch 已移除，不能继承 Slice A 的 local evidence；未来资格必须由新路线重新定义。

无资格时 manual/auto 都关闭，禁止 silent compact；handoff contract 要求保留 transcript 并可保存
diff、Plan、checks、pending，超长任务明确 unsupported，`/clear`/新 session 不能冒充成功压缩。
旧 4.9–4.11 adapter 和 `compaction-rollout-evidence.ts` 固定保持
`synthetic`/`nonDistributable`/`evidenceEligible=false`/blocked。它们只作为伪造 authority、source splice、
时间重排和 shadow 意外副作用的负向 contract，不再产生 rollout stage、milestone 或未来 Task。

`manual-compaction-v1.json` 与 `auto-compaction-v1.json` 现与其他 capability profile 一样固定
`under_development/off`、空 route/platform allowlist、freshness=0。Manual 只按当前本地 route/handoff
contract 工作；Auto Compaction 首版不受支持并默认关闭。以后若要支持 Auto 必须重新立项，不能继承
旧 rollout 或 promotion 记录。
