# Compaction Release Qualification 边界

状态：active
读取时机：修改 compaction case、事实 matcher、semantic/continuation evaluator、route qualification、
无压缩 handoff 或 compaction release Gate 时。
验证：`bun test tests/evals/compaction tests/evals/qualification/auto-compaction-failure-contract.test.ts tests/evals/qualification/github-actions-auto-compaction.test.ts tests/evals/qualification/github-actions-agent-diagnostic-aggregate.test.ts tests/evals/qualification/live-auto-compaction-runner.test.ts tests/evals/qualification/auto-compaction-live-evidence.test.ts tests/runtime/context-compaction-e2e.test.ts tests/runtime/context-compaction-shadow-gate.test.ts tests/release/capability-profile.test.ts`、
`bun run typecheck`。
相关：ADR-0021、ADR-0022、ADR-0024、ADR-0057、ADR-0069、ADR-0070、Phase 4。

## 当前本地 contract

`CompactionCaseV1` 只接受 versioned synthetic transcript、1–5 轮增量、分类 critical/important facts、
exact/normalized/semantic matcher、forbidden claim 和可选 continuation。fact ledger 只存在于测试，
不会进入 production checkpoint 或创建第二份正文。

结构 adapter 覆盖 direct/incremental/reset、tool pair、transcript immutability、checkpoint digest/replay/
revision、lease/environment drift、summary rejection 和 system/tool/Plan/Verification/Runtime 权威重注入。
失败保持原状态；invalid checkpoint、orphan tool result 或状态损坏为 G0。

AQ-9A 另有一条 source-owned 的本地 L1 自动压缩失败 contract。它只用无 route、credential、endpoint 或网络路径的
scripted transport，经真实 `AgentKernel → ModelController → Runtime executor/scheduler → runner` 运行三种确定性
fault injection：`summary_failure`、`provider_failure` 与 `provider_network_failure`。每一种仍收敛到既有
`context.compaction_failed(summary_model_failed)`；产品 error schema、默认 flag 与 `contextWindowTokens` 均未改变。
它已在 ADR-0072 AQ-8 independent review 后完成 ordered re-validation，只是 public-safe AQ-9B 的 deterministic
前置，不解除 ADR-0071 formal L3 的 safe-disabled 状态。
fixture 通过当前 projection/token estimator 构造 9–12K 的安全 synthetic context，并且只在内存中使用 8,192 的
自动压缩阈值。它断言失败当前 turn 停止、没有普通 primary model dispatch，late completion 不能建立 checkpoint
或复活该 turn，而下一条实际 user message 开启的新 turn 才重新 preflight/retry。

该 contract 只产生 metadata-only `L1AutoCompactionFailureReceiptV1`；每份 receipt 与 source binding、Matrix、
suite/corpus/oracle/evaluator/verifier/runner、candidate/execution、governance/retention 及 report digest 重新闭合，
并固定 `authority='diagnostic'`、`evidenceEligible=false`。它不是 route qualification、真实模型结果或发布准入，
不输入现有 Gate/G0/G1，也不改变 DeepSeek 或 Qwen `qwen3.6-flash` 的 G1 smoke。

AQ-9B 的 L3 auto-compaction runner 与 AQ-9A、AQ-8 和 G1 分离，但当前 public
`test:model:auto-compaction:live:success` / `:cancel` wrapper 都由 checked-in persistent-supervisor activation literal
安全停用。它们在 fixed source-byte check 后、读取 caller environment/ledger 或创建 resolver、credential lease、reservation、
scratch/child 之前返回 `blocked/governance_reservation_unavailable`；独立 opt-in、credential、ledger root 或 forged health
record 都不能开启真实 dispatch。health parser 只验证 future no-secret wire shape/freshness，绝不是 authorization、durable
deletion witness 或 supervisor identity。

ADR-0072 的 GitHub Actions AQ-9B case 是另一个、较低保证且 public-safe 的 runner，不是上段 formal AQ-9B 的 activation。
`GitHubActionsAutoCompactionDiagnosticReportV1` 只接收由 AQ-10 同一 job 一次取得的 opaque、one-shot fixed-case
model lease binding；它不接收 raw model、key、base URL 或 generic fetch。只有 lease 中 captured Provider fetch 已实际被调用并
返回 operation 的 ordinal acknowledgement，才可把 success/cancel 写为 `provider_fetch_entered`；本地 contract binding 只能
`blocked/transport_proof_unavailable`。runner 本身不读取 credential、parent config、workspace/project/session overlay 或 formal L3
resolver。case 在临时 HOME/config/data/state/cwd、memory store 与空的 read-only synthetic root 内运行产品
`AgentKernel → ModelController → Runtime executor/scheduler → compactor`，tool surface 全关，因而没有 Shell、MCP、Skill、
Subagent、stdio child、workspace I/O 或 session-content logging。固定 9–10K safe context 只在内存中以 8,192 threshold
触发 automatic compaction；不读取、设置或推断 `contextWindowTokens`，不改变产品 flag/default。

success 固定一次 summary 和一次 post-checkpoint primary，两个 phase 分别受 summary `7,800/600` 和 primary `3,229/600`
input/output cap、zero SDK retry 与 60 秒 deadline 约束。cancel 只在 bound model 的 captured Provider fetch acknowledgement
确认 summary transport entry 后由 harness client-abort；
它必须产生 `summary_aborted`、停止 current turn、零 primary dispatch，并让 next user turn 到达 retry preflight。该 preflight
会观察到第二个 automatic request，但 runner 在其 summary dispatch 前停止，所以 cancel 的真实 Provider 调用仍精确为一次。
它不是 remote-cancel confirmation。成功必须有 usage；usage 缺失或任一 cap drift 为 blocked。唯一例外是这种已证明的 abort：其
未返回 usage 以保守 phase reservation 计入 `conservative_abort_charge`，绝不冒充 observed usage。输出只有 digest、有限 count/
bucket/reason code；不记录 key、endpoint、prompt、response、reasoning、safe corpus 或路径，并由独立 verifier 拒绝 formal
qualification、`LiveCompatibilityObservationV1` 和 release evidence shape。AQ-10 已在同一 manual protected-main job
内 fresh-verify AQ-8、AQ-9B success 与 AQ-9B cancel 的固定顺序和 `2 + 2 + 1` Provider cap；没有实际 GitHub job run 时，
所有本地 AQ-9B test 仍只是 zero-network contract，不是已发生的真实 Provider 成功或取消。

AQ-9B 依赖的 ADR-0071 installation/native-boundary contract 仅固定 future Linux systemd/manifest/native-helper 的
source-owned metadata interface；native helper frame 是 `not_public` / `authorization_not_representable` 的 root-supervisor
internal descriptor，不是 caller request admission。它不安装或启动服务，不能证明 native isolation、nonce/index atomicity、实际
reaping/scrub/deletion 或 owner-only projection。因此它既不改变 AQ-9B 的 safe-disabled 状态，也不把任何 synthetic result 升格为 L3 receipt。

因此当前 AQ-9B product-chain coverage 只由 `runSyntheticAutoCompactionContractV1` 的 test-only、zero-credential driver
提供。它经真实 `AgentKernel → ModelController → Runtime executor/scheduler → runner` 运行固定 success/cancel synthetic
scenario；它不接收 environment、ledger、resolver、model lease、caller model function 或 real provider boundary，且不产生
reservation、semantic receipt、observation、report 或 evidence。cancel contract 只验证当前 synthetic turn 停止、同一 runner
以 scheduler preflight 验证下一 user turn；AQ-9A 的 injected summary/provider/network failure 仍只属于 L1 failure contract。

AQ-9B runner 只在内存中设置 8,192 automatic threshold 与 source-owned 9–10K safe synthetic projection，**不会读取、设置或
推断**产品 `contextWindowTokens`（source registry 固定 `unknown/not_declared`），也不改变默认 flag。未来在 ADR-0071 已接受的 implementation/proof branch、
maintainer authorization 和 persistent-supervisor control plane 启用的 two-phase path 才必须通过独立 policy、route、sealed
root、allowlist environment、JIT phase cap 与 owner-only reservation；它还必须有 root-private signed atomic nonce-consumption
index（恰一个 nonce consumption/一个 allocation）、直接续接的 commitment journal sequence、
`committedAt < allocatedAt < attestation.expiresAt`，以及从 worker exit 起一秒内 reaping/scrub/delete 的 signed lifecycle
receipt。binding 还固定 ADR-0070 `ephemeral_local` governance/retention/storage/audit/authorizer 与 quota/retention-witness
digest，receipt 再绑定 owner-only projection digest；可变 ID 仅为 L3 UUIDv4 opaque token，attestation 仅接受 canonical
Ed25519 SPKI public key。index 只能在受保护 verifier 内读取，receipt 只绑定其 digest。summary input/output 加 post-checkpoint primary
input/output 总计 12,229。届时 drift、未知 terminal、cleanup failure 或未广告 model tool-call/non-allowed effect 仍必须在
Tool/Skill/MCP/Subagent child executor 前 `blocked` 并 full-charge。任何未来独立
`LiveAutoCompactionSemanticReceiptV1` 加 outer `LiveCompatibilityObservationV1` 仍固定 `authority='diagnostic'` /
`evidenceEligible=false`，不进入 current release Gate、G0/G1 或 production content admission；当前也绝不能被写成真实
provider compatibility。当前没有 L3 runner、semantic receipt 或 observation 消费该 schema，activation 仍为 false。

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
写入 runner temp 的只读 snapshot。原始 worktree
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

无资格时 manual/auto 都关闭，禁止 silent compact；handoff contract 要求保留 transcript 并可保存
diff、Plan、checks、pending，超长任务明确 unsupported，`/clear`/新 session 不能冒充成功压缩。
旧 4.9–4.11 adapter 和 `compaction-rollout-evidence.ts` 固定保持
`synthetic`/`nonDistributable`/`evidenceEligible=false`/blocked。它们只作为伪造 authority、source splice、
时间重排和 shadow 意外副作用的负向 contract，不再产生 rollout stage、milestone 或未来 Task。

`manual-compaction-v1.json` 与 `auto-compaction-v1.json` 现与其他 capability profile 一样固定
`under_development/off`、空 route/platform allowlist、freshness=0。Manual 只按当前本地 route/handoff
contract 工作；Auto Compaction 首版不受支持并默认关闭。以后若要支持 Auto 必须重新立项，不能继承
旧 rollout 或 promotion 记录。
