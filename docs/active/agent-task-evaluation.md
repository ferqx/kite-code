# Agent Task Evaluation 边界

状态：active
读取时机：修改 Agent task case、fixture、oracle、重复运行、人工验收或产品 Release Evidence 时。
验证：`bun test tests/evals/agent-tasks tests/evals/live-provider-smoke.test.ts tests/evals/qualification/github-actions-agent-diagnostic-model-lease.test.ts tests/evals/qualification/github-actions-agent-evaluation.test.ts tests/evals/qualification/github-actions-auto-compaction.test.ts tests/evals/qualification/github-actions-agent-diagnostic-aggregate.test.ts tests/evals/qualification/github-actions-agent-evaluation-workflow.test.ts`、
`bun run test:provider:smoke -- --provider deepseek`、
`bun run test:provider:smoke -- --provider qwen`、`bun run typecheck`。
相关：ADR-0058、ADR-0068、ADR-0069、D-07、Phase 2B。

## 当前状态

仓库已经具备严格的 `AgentTaskCaseV1`、隔离 fixture、确定性 oracle、append-only repeated-run
ledger、统计重建、adversarial contract、Plan/恢复 UX mapper、人工验收 schema、immutable suite
registry、nightly dry-run 与 Release Evidence adapter。本地资产只使用 synthetic fixture，不访问真实
Provider，不收集用户正文，也不能成为产品 Gate 的通过证据。

产品验收现在另有 `AgentTaskProductEvidenceV1` companion ledger。它把 Tool Search 的 expected/
selected/outcome/latency、MCP/Skill 非预期触发、`ask_user` 结果与问题 digest、Plan/恢复/Verification/
review handoff/correction/approval，以及人工 accepted/integrated/reverted/understanding/burden 收据，逐项
绑定到同一个 source、candidate、case 和 attempt identity。人工收据只保存显式 opt-in、可退出状态、
匿名 participant/reviewer digest 与无正文 outcome；raw prompt、response、diff 或 reviewer 评语不进入
bundle。exact attempt coverage、receipt chain、canonical digest 或 identity 任一不一致均 fail closed。

当前 2B 范围以 DeepSeek/千问各一次低成本真实调用、确定性核心 correctness、安全与 adversarial case
为准，不要求正式重复运行、external participant 或 product evidence authority。2B.4/2B.5 已按本地范围
完成，2B.7 已被取代。旧 retained product/evaluator schema 只保留为伪造、缺失、重排和 identity splice
的负向 contract，不构成发布后增强路线或产品 milestone。

GitHub-hosted `Required` workflow 继续只执行无密钥的确定性验证：`unit` 覆盖 Agent task/qualification case，
`runtime-e2e`、`runtime-fault-soak` 与 `tui-system` 覆盖实际 Agent runtime、恢复与交互链路。它们只用 checked-in
synthetic fixture 与 mock/scripted model，不读取 Provider credential、不运行 `test:model:*`，也不发生 formal L3
dispatch，更不会发布、保留或上传 AQ-8 observation、release admission 或生产 Provider 兼容结论。

已接受的 ADR-0072 另设手动的 `agent-live-evaluation.yml`。无密钥 preflight 可以输出脱敏的 context-blocked report；只有
canonical `ferqx/kite-code` protected `main`、外部 `agent-live-eval` Environment 审核和 step-level secret 均成立时，live job 才会一次取得
opaque lease，并按固定顺序运行真实 `runRuntimeAgent` synthetic `read_file`、automatic-compaction success 与
after-Provider-fetch client-abort 三个 case。AQ-10 只聚合同一次 workflow 中 fresh-verified 的 public-safe child report：
固定 `diagnostic` / `evidenceEligible=false`，无 artifact、ledger 或跨 run 保留，且不能被 formal qualification、
`LiveCompatibilityObservationV1`、release evidence、G0/G1 或 release gate 解析。未实际运行 live job 时，不得将 preflight
或本地 mock 说成真实 Provider 评估。

D-07 已关闭。首批目标是可信本地 Workspace 中的单维护者/开发者，入口只包含 TUI 与用户在场的
前台 Headless CLI；托管、多租户、无人值守 writer 和共享 checkout 被排除。批准 suite 固定为
12 case：8 类任务、4/6/2 simple/medium/complex、4 long、3 read-only/9 workspace-write、
4 TUI/8 CLI，语言范围是 TypeScript/JavaScript Bun/Node 加语言无关 research/documentation。

本地 evaluator 必须绑定批准 suite 的 ID、revision、canonical digest、精确 case 集和 determinism；
缺失、额外、重复、重分类或只保留最好一次全部拒绝。本地 Gate 失败时顶层保持 failed，不得被 authority
缺失掩盖。`agent-task-evidence.yml` 仍是 `contents:read`、无 OIDC/发布权限的 contract workflow，输出固定
`contract_only`/`evidenceEligible=false`。调用者不能通过改名、shape-valid authentication 或伪造真人数量
升级为产品证据。ADR-0069 后该 workflow 不再对应待完成 Task。

## Evidence 规则

- case、suite、oracle、contract、artifact、config 和 route identity 必须全部绑定；任一 mismatch 拒绝。
- 每次运行保留完整结构化 attempt，不能只保留最好一次。缺失指标使用 `null`/`not_observed`，不能补零。
- G0 固定为未授权副作用、secret/正文外传、sandbox escape 和 required Verification bypass 零容忍。
- fixture 清理只处理 identity 匹配的自有 worktree/process；symlink、credential 或 ownership mismatch
  fail closed。
- 旧 human 字段在本地固定为 `not_observed`，正文不进入 release bundle；项目不以真人数量作为发布资格。
- Product/route/suite/scorer 变化必须产生新 revision/digest，旧报告只读保留。

## Agent Qualification Matrix V1（diagnostic inventory）

ADR-0070 的 AQ-1 已增加 `AgentFeatureQualificationSpecV1` 和由 source owner 生成的
`AgentFeatureQualificationMatrixV1`。它是诊断性 inventory，不是 `ReleaseEvidenceV1` 的扩展、输入或替身；
当前 G0/G1、现有 DeepSeek 和 Qwen `qwen3.6-flash` G1 smoke 的语义及唯一发布权威均不改变。

- generator 位于 `release/qualification/source-owned-surface-v1.ts`，只投影真实 Builtin Tool registry、
  Feature Flag 定义、递归 `configSchema` **input-side** JSON pointer、CLI command/option 声明、TUI data-only command surface、
  Release Profile/capability/target，以及 owning module 相邻 `@qualification-surface-v1` JSDoc 声明的公开
  operation。collector 只发现、校验并投影这些声明，不维护第二份 operation map；annotation 必须紧邻真实 AST
  declaration，source fragment 也必须解析到 AST declaration。对于会把 on-disk config 规范化为 runtime output 的
  source-owned Zod codec，Matrix 只快照同一 codec 的 input side，不使用 `unrepresentable: 'any'`、输出侧或平行 schema；
  因而 compact model route 与 legacy object form 都保持可审计的输入约束。公共文档不使用 qualification-side 路径清单：
  root `README.md` 加全部 `docs/active/**/*.md` 和 `docs/book/**/*.md` 都由固定的公开文档发现契约生成通用
  disclosure surface；缺文件、symlink 或仓库外路径均 fail closed。source owner 的增删、默认值、schema、实际
  profile ceiling、public declaration、公共文档或 suite identity 漂移都会改变 digest。
- CLI 的 command/option/help 声明在 `src/app/cli/public-surface.ts` 由 parser 与 help renderer 共用；
  parser 在读取已声明 flag value 前拒绝其跨 command 使用。Feature Flag 的默认值、config override schema 与
  CLI override parser 共用 `FEATURE_FLAG_DEFINITIONS_V1`，包括每项的 `cliOverridePolicy`；这仍不改变任何
  G0/G1 或 release-controlled ceiling。
- 每项 feature 都显式绑定 owner、risk/rationale、sourceRefs、applicability、support state、declared exposure、
  required evidence、结构化 condition 和 assertion。默认开启 feature 必须有 required evidence，并明确排除尚未
  经 ADR 启用的 `manual_usability`。`entry_rejection` 只绑定真实的拒绝入口，绝不表示 flag 的兼容回退。
  每个已实现且默认关闭的 flag 都必须在每个实际 consumer declaration/symbol（包含从 feature carrier 解构的
  alias）以相邻 `@qualification-default-off-guard-v1` 注解绑定；只覆盖同一文件中的另一个 consumer 仍会
  fail closed。`safe_disable` 必须有 AST 可验证的直接 `flag=false` 闭合返回；`identity` 还必须显式绑定并返回
  同一函数参数，`!flag && extra` 或任意 fallback 都不能通过。所有 consumer 都是 `safe_disable` 时，才投影为
  `experimental_default_off` 和独立的 `default_off_safe_disable` condition；任一 `legacy_fallback` 都投影为
  `unsupported/default_off_legacy_fallback`，不能伪装成实验性 runtime surface。无产品 consumer 的注册占位必须
  显式为 `declared_only`，仅投影为 `unsupported/source_not_supported`。默认关闭 flag 的 entrypoint 由实际 guard
  binding 派生；其他 registry surface 使用其 source-owned configuration entrypoints。`not_observed` 只可在后续
  diagnostic report 中作为 `blocked` 的 reason code，不能成为通过状态。
- suite assertion 从 structural evaluator 对 source surface 和已验证 condition 的正向投影生成；collector 的
  `requiredEvidence` 不能反向把任意 assertion 加入 suite。不存在、flag/entrypoint 不匹配或未验证 condition 的
  assertion 都会被拒绝。
- 初始 `source-owned-surface-contract-v1` suite 只验证 inventory/source binding 的完整性，不声明产品行为
  已资格化。AQ-3 的 `qualification-l0-contract-v1` 只由同一 AST declaration 上的闭合
  `l0Binding: { adapterId, assertionId }` 接入，Feature ID 仍从原 declaration 派生。当前 source owner 为
  `evaluateToolApproval`、`requiresVerification`、`createBinding` 与 `executionBoundaryV1Schema` 的四个精确
  pair；AQ-4 另以 `l1Bindings` 与 `l1ProjectionBindings` 把七个 Runtime behavioral pair 和四个 CLI/TUI
  projection pair 绑定到实际 owning symbol。任一缺 pair、重复 pair、stale assertion，或把 binding 放在另一个
  symbol 都使 catalog generation fail closed。所有 L0/L1 requirement 都与 structural requirement 并存，后者不能
  被 behavioral receipt 替代。
- 输出只包含安全 metadata 和 domain-separated digest；不写入 source 正文、workspace 内容、Provider endpoint、
  credential、prompt、response 或 reasoning。

验证：`bun test tests/evals/qualification/feature-matrix.test.ts`、`bun run typecheck`。

## Agent Qualification Evidence V1（diagnostic receipt）

AQ-2 增加了彼此独立且 exact-key 的 `AgentQualificationEvidenceV1` 与
`LiveCompatibilityObservationV1`。两者的 `authority` 固定为 `diagnostic`，
`evidenceEligible` 固定为 `false`；它们不是 `ReleaseEvidenceV1`，没有 release bundle、release evaluator
或 Gate 输入位置。`scripts/release/evidence-identity-primitives.ts` 仅抽出并保持原样 re-export
`ReleaseArtifactIdentityV1`、`ReleaseEvidenceExecutionIdentityV1`；qualification contract 只使用这两个
identity 原语及 canonical digest primitive，绝不解释 artifact 中继承的 `gatePolicyDigest`。

- `DiagnosticCandidateArtifactClosureV1` 逐项携带完整 artifact identity，按 `platformIdentity` 稳定排序且唯一。
  所有项必须同源于相同 repository、repository ID、commit、behavior/profile/policy digest；本平台的
  `payloadSha256` 与 `canonicalManifestDigest` 可以不同。现有 build 会把 target 和 payload 写入各平台 manifest，
  因此要求 manifest digest 跨平台相等反而是错误的。每个 attempt 同时携带 platform 和该 closure 项的完整 artifact；
  platform/artifact swap、代表项、dangling execution、candidate splice 或 profile mismatch 都拒绝。
- 每条 execution 有独立 ID、platform、canonical identity 和 execution digest；时间倒置、repo/commit drift、
  unsafe metadata（绝对路径、URL/query/fragment、控制字符或 workspace-like value）都拒绝。AQ-2 schema 接受
  source-owned registry 中的 `local_synthetic` fixture/runner，或仅为 AQ-7 专用路径保留的安全 GitHub Actions
  identity shape；generic verifier 仍一律拒绝 GitHub execution。只有 AQ-7 的 source-owned receipt verifier 在
  重建 target、Matrix、receipt、治理和受保护 workflow provenance 后才可处理该窄形态；external、maintainer-review
  与任意自签 digest 都不能变成可信 execution。
- `EvidenceGovernanceProfileV1` 是 ADR-0070 冻结的闭合集合：allowed/prohibited data category、retention/deletion、
  ACL/encryption/audit、run/day/month 的 attempt/token/time/cost quota、concurrency、Issue default-deny 和 required
  authorizer 都参与 canonical profile digest。evidence binding 必须精确匹配 profile，并同时引用 day/month quota ledger
  和 retention witness；两 ledger 必须有同一 `reservationId`、同一 route-policy digest 且与所有 attempt scope 一致，
  UTC `createdAt` 必须精确落入 day 的 `YYYY-MM-DD` 与 month 的 `YYYY-MM-01` bucket。未 reconcile、超额、计数与
  attempt 数不符、expiry/profile/storage/deletion drift 或 private-reserve 选择均为 `blocked`。AQ-2 只定义和验证
  metadata-only record，不实施 dispatch、上传、Issue handoff 或实际 live ledger。
- aggregate attempt 同时绑定 Feature/assertion/layer、candidate/execution、platform/profile/entrypoint、可选的
  metadata-only route/model/prompt/tool-catalog identity、test policy，以及 Matrix/suite/oracle/corpus/evaluator/
  verifier/runner digest。`not_applicable` 只能使用已注册 N/A reason；`not_observed` 只能导出 `blocked`。
  record/report/closure/execution/attempt digest 任一篡改均拒绝。
- 当前 `source-owned-surface-contract-v1` 在闭合 role registry 中只能是 `structural_inventory`。即使 receipt 全绿，
  verifier 也必须导出 `blocked/behavioral_evidence_not_registered`；AQ-3 注册独立 behavioral evaluator 之前，不存在
  `qualified` 或 `verified_disabled` 的正向路径。`failed` 与已注册的 unsupported/N/A 仍保持各自的 diagnostic
  派生状态，绝不隐式变成 pass。
- `LiveCompatibilityObservationV1` 必须携带仅用于 sealed diagnostic identity 的
  `DiagnosticCandidateArtifactClosureV1`，而不是 candidate aggregate 或 Feature/assertion required-evidence 输入；其
  execution platform/commit、scope profile 与 runner digest 必须与 closure 的对应 artifact 精确一致。它只接受带
  day/month ledger 与 retention witness binding 的 metadata-only route scope，以及真实 `success`/受控 `cancelled`
  outcome。专用 verifier 将 candidate、execution、scope、identity、governance witness 与 UTC quota bucket 一起闭合，
  且只会输出 `observed` 或 `blocked`；把 observation 传给 aggregate verifier 或 release evidence parser 都会 fail
  closed。它未来即使使用当前 DeepSeek/Qwen G1 route，也只是独立 observation，不形成 production content admission，
  也不改变当前 G1 smoke。

验证：`bun test tests/evals/qualification/evidence.test.ts`、
`bun test tests/release/evidence.test.ts`、`bun run typecheck`。

## ADR-0072 GitHub Actions real-Agent diagnostic report（public-safe only）

`.github/workflows/agent-live-evaluation.yml` 是 manual-only、无 inputs、`contents: read` 的独立 workflow；它固定
canonical `ferqx/kite-code` repository、`refs/heads/main` 和 `github.sha`，不接受 PR、tag、fork、caller-selected ref/SHA、fixture、route 或
command。preflight 不读取 secret；live job 还要求 `github.ref_protected=true` 与专用 Environment。Actions 日志只是
public-safe transport，不能被当作 ADR-0070 的 ACL、retention、deletion 或 quota-ledger witness，workflow 也不会上传
artifact、写 Issue/PR comment 或接入 release bundle。

`scripts/evals/qualification/github-actions-agent-evaluation-v1.ts` 以固定、只读 synthetic fixture 和 sealed in-process
catalog 运行实际 `runRuntimeAgent`，模型可见工具严格只有 `read_file`。它使用临时 HOME/config/data/state/cwd、内存
Runtime store 和关闭的 session content logging；普通 config loader、workspace/project/session overlay、Shell、stdio child、
MCP、Skill、Subagent、write/network tool 均无可用入口。credential 只用于 direct model binding，随后从环境移除；sealed
surface 不向通用 Tool/Skill/Subagent controller 传递 `taskModel`。路径越界、usage 缺失、token overage、deadline、非注册工具
或不可确认 terminal 均 fail closed；每个 concrete `doGenerate` 同时接收 AbortSignal 并 race 60 秒 deadline，late Promise 不能
恢复 Runtime 或触发后续工具/model dispatch。报告仅含固定 identity/digest、受限 bucket 与 reason code，不含 credential、endpoint、
prompt/response/reasoning、fixture/workspace 内容或路径；其 verifier 同时拒绝 formal qualification、L3 observation 和 release
evidence shape。它是低保证真实 Agent 诊断，不是 formal L3 activation，也不改变现有 G1 DeepSeek/Qwen smoke。

AQ-9B 的 `github-actions-auto-compaction-v1.ts` 是同一 ADR-0072 之下、与上述 read-file case 分离的
`GitHubActionsAutoCompactionDiagnosticReportV1`。它只接受已绑定模型，不读取 credential 或普通配置；在临时
HOME/config/data/state/cwd、空的只读 synthetic root 和 memory Runtime store 内，通过产品 Kernel/ModelController/
compactor/scheduler 运行 source-owned 9–10K safe context。工具、Shell、stdio child、MCP、Skill、Subagent、network tool
和 content session logging 都没有入口。它以 8,192 in-memory threshold 验证真实 success（summary + primary）或
harness client-abort after transport entry（仅 summary）；后者必须证明 current turn 停止、primary 零 dispatch，next user
turn 的 retry preflight 会产生第二个 automatic request，但在任何第二次 summary dispatch 前停止。它不读取、设置或推断
产品 `contextWindowTokens`，不会改变产品默认值。usage 缺失和超额仍 blocked；只有该已证明的 summary client-abort 可用
`conservative_abort_charge` 表示保守 charge，不能写成 Provider 已确认取消。此 report 与 formal/release schema 互斥，不能进入
G0/G1/release gate；AQ-10 已在同一 protected workflow 中 fresh-verify 三个 fixed child report，但未实际 manual live dispatch 时，
本地 mock 只验证 contract，不表示真实 Provider 已运行。

## ADR-0071 formal AQ-8 L3 Live Compatibility（diagnostic only）

AQ-8 的 `LiveSuiteSourceOwnedIdentityV1` 由同一 source-owned qualification registry 投影 route、fixture、
safe corpus、oracle、evaluator、verifier、runner、Matrix 与 suite identity。**当前 L3 capability 不可用。** 固定
source-byte binding 后，checked-in `liveScratchSupervisorActivationIsImplementedV1() === false` 在读取 caller
environment/ledger、创建 resolver/reservation/credential lease、sealed root 或 child 前返回
`blocked/governance_reservation_unavailable`。所以任何 opt-in、key/base URL、owner-only ledger 或 health JSON 都不能产生
L3 dispatch、observation、receipt、report 或 evidence。`hasFreshLiveScratchSupervisorHealthV1` 只校验将来 service 的有界
no-secret health wire shape/freshness；它不是 maintainer authorization、protected control-plane proof、durable deletion
witness 或 actual supervisor identity，且 literal 为 false 时不读取该文件。

仓库已定义纯 schema 的 `L3ProtectedScratchSupervisorManifestV1`、短时 nonce-digest-bound、Ed25519
`LiveScratchSupervisorAttestationV1`、root-private `LiveScratchSupervisorNonceConsumptionV1` 及其完整 nonce-scope
`LiveScratchSupervisorNonceConsumptionIndexV1`、pre-allocation `LiveScratchAllocationCommitmentV1` 与 signed
`LiveScratchLifecycleReceiptV1`。nonce index 只作为 verifier 的 root-private 输入：必须签名地声明恰有一个消费和一个
allocation；receipt 只回绑其 digest，绝不携带 index 正文。binding 的 governance object 精确固定 ADR-0070 的
`ephemeral_local` profile ID/digest、retention class/86,400 秒/process-exit、local-owner ACL/encryption/audit、Issue
default-deny/local-owner authorizer、day/month quota ledger digest、retention witness digest 与 owner-only projection-policy digest；
terminal receipt 另绑定实际 owner-only projection digest。所有形态只携带 candidate/execution、Matrix/suite/oracle/corpus/
evaluator/verifier/runner、governance/policy、worker/service epoch、reservation/lease/journal/scratch-handle digest 与时间；所有
可变 ID 仅接受固定 service ID 或 service/ledger 生成的 L3 UUIDv4 opaque token，因而没有 path、PID、UID、credential、endpoint、
正文或 child output 字段。verifier 要求 manifest pin 的 canonical Ed25519 SPKI public-key digest（私钥 PEM 拒绝）、nonce、epoch、
binding、attestation、atomic nonce consumption、commitment 与 receipt 的签名链；commitment journal sequence 必须直接续接
nonce consumption，且 `committedAt < allocatedAt < attestation.expiresAt`。normal exit 的 reaping 与 deletion 都从
`workerExitedAt` 起固定一秒上限，crash recovery 固定 86,400 秒上限。它仍不能自行发现 root-protected manifest/key、验证
Linux mount/worker containment、原子 index 或独立证明实际删除，故当前 observation/verifier 也不接受它作为成功证据。只有
future protected service 的 native proof 与 owner-only receipt projection 完成后，才可将它作为 L3 的 required binding。

仓库内的 `l3-protected-scratch-supervisor-installation-contract-v1` 仅将 future Linux `systemd`、root-only manifest/
bundle/key fingerprint、固定 `/run` roots 与 native helper 的 create/scrub/recover 交接语义做 source-owned、canonical-digest
contract 化。它只描述 root-supervisor private one-shot channel 内部 frame 的 opaque allocation/journal/epoch/lease/scratch
digest 类别，明确 `not_public` / `authorization_not_representable`，没有 caller-visible request parser 或 admission；它也不含可启用
unit、shell、installer、host API、key 或调用方可选 path/command/FD/ref/SHA/fixture/route/credential。
该 contract 只能降低 future implementation 的歧义，不能证明 unit 已安装、`/run` 为 tmpfs、peer credential/cgroup/mount
隔离、fsync recovery index、实际 reaping/scrub/deletion 或 owner-only projection，故不减少 AQ-8 的 blocker 集合。

ADR-0071 已接受的 persistent-supervisor branch 完成 service identity、native isolation 和 retention proof 后，runner 才必须在
dispatch 前精确校验 canonical digest、policy digest、route scope、governance profile、retention binding 与 reservation；
runner 自身的 source-byte digest drift 也必须拒绝执行。sealed root 只读且不暴露路径，ledger 只可保存 append-only
metadata reservation/terminal event，以 profile-wide attempt/token/time/cost/concurrency 上限预留并对账；超额、并发、
ledger/policy/source drift 或安全 sentinel 都是零网络 `blocked`。L3 runner 只导入 `live-observation-schema-v1`、专用
source-owned registry 与 `live-observation-verifier-v1`；后者重建并固定 L3 policy、route、Matrix/suite、candidate、
fixture/corpus/oracle/evaluator/verifier/runner 和 ledger binding，而不接受 caller 的 generic verifier equality 作为 authority。
Bun metafile contract 拒绝 generic evidence verifier/schema、source-owned surface、产品 config/MCP/Tool/Skill/Subagent/
session logger/runtime agent 以及 release evidence/bundle/gate 的任何传递输入。

未来 transport 只允许一次真实 dispatch，并只将实际 `success` 或受控 `cancelled` 归约为脱敏 observation；provider/network
failure、未 opt-in 或任一 preflight 缺失不伪造 observation，而是 `blocked/not_observed`。reservation 后 dispatcher、cleanup
或任何未受信 terminal 抛错时，才按整次 policy request 的 attempt/token/time/cost 最大值保守结算并报告
`providerDispatchCount='unknown'`；不得把未知状态写成零 dispatch。记录与报告仍须闭合 diagnostic candidate closure、
execution、scope profile、Matrix、suite、oracle、corpus、evaluator、verifier、runner、governance、retention、record/report
digest；candidate 的 local-synthetic sentinel 不是 repository revision 或 candidate aggregate。该 L3 route 没有 release
aggregate、release evidence parser、release bundle 或 Gate evaluator 接入点；同一路由的 G1 smoke 保持独立，不能相互补足，
也绝不产生 production content admission。验证：`bun test tests/evals/qualification/live-compatibility-runner.test.ts tests/evals/qualification/live-observation-verifier.test.ts tests/evals/qualification/live-route-resolver.test.ts tests/evals/qualification/live-scratch-supervisor-health.test.ts tests/evals/qualification/live-isolated-transport.test.ts tests/evals/qualification/live-model-transport.test.ts tests/evals/qualification/live-governance-ledger.test.ts`。

## AQ-3 L0 contract、receipt 与 Sentinel journey（diagnostic only）

`qualification-l0-contract-v1` 以闭合的 source-owner pair 执行四个 in-memory deterministic adapter；它不读取
Provider credential、不发网络，也不记录 source body、workspace path、prompt、response、reasoning、child output 或
完整命令。`L0EvaluatorIdentityV1` 的 canonical composition root 逐项覆盖 Good/Bad corpus、mutation corpus、
oracle、verifier、adapter dependency 与 runner dependency digest。corpus 仅保存 case ID、registered pair 与
expected outcome；required negative case 被接受、Good case false reject、删弱 assertion、forged success、stale
binding、unknown effect、duplicate result、缺 verification receipt、candidate/suite identity drift 任一都会让
evaluator report `blocked`。

现有 `AgentTaskCaseV1` parser、synthetic compaction continuation contract 与 runtime fault-soak case catalog 只作为
L0 evaluator 的 self-contract dependency：它们的 exact source fact 也进入 adapter dependency digest，并以安全
synthetic input 在 runner 内检查。它们没有被手工映射成任一产品 Feature/assertion；旧 adversarial/release-linked
evidence 仍不进入 L0 import graph。

每次 L0 receipt 是独立的 `L0ContractReceiptV1`，固定 `authority='diagnostic'` 与
`evidenceEligible=false`，并精确绑定 source surface/Feature/assertion、source binding、Matrix/suite、evaluator
identity/report digest 与 adapter outcome。它再以 opaque `{ receiptId, receiptDigest }` 与同一 candidate/execution/
scope/governance/retention 的 `AgentQualificationEvidenceV1` attempt 绑定。已有 ephemeral-local profile 的 per-run
attempt quota 为 3，因此 L0 verifier 每份 record 只验证一个 source-owned Feature；候选级汇总必须在后续报告层对
同一 candidate 与 scope 的多份 record 做 exact join，不能以少量 receipt 声称全局 completion。

通用 `verifyAgentQualificationEvidenceV1` 对 behavioral context 一律返回
`blocked/behavioral_context_untrusted`。只有 `verifyL0ContractEvidenceV1` 会重建当前 source-owned catalog、Matrix、
L0 suite、evaluator identity，并自行重跑完整 sealed corpus 生成 evaluator report、product adapter result 与 receipt，
再将可信 candidate/execution/governance context 传入内部 verifier；它不接收 caller-provided evaluator report。任一
source/suite/corpus/oracle/evaluator/verifier/runner/receipt splice 或缺 scope 均 fail closed。receipt、attempt、
assertion、source surface、Sentinel identifier 与 governance profile/reservation/actor metadata 都经过共享 metadata guard，
拒绝完整或 normalized endpoint、absolute path、`..`、query/fragment 或 control character。
该路径可导出 scope-local diagnostic `qualified`，绝不改变 G0/G1、Release Evidence、release bundle/gate 输入、
DeepSeek/Qwen `qwen3.6-flash` G1 smoke 或 production content admission。

`SentinelJourneyMapV1` 固定 RFC 的十条 critical journey。生产 builder 自行重建 source-owned Matrix/L0 suite；
持久 map 必须与该结果 exact-match，raw source binding、condition、receipt、projection 或 Matrix/suite digest 不能
自行变成 observed authority。每行都保留 plural `featureIds`、`assertionIds`、`receiptIds` 与独立 CLI/TUI projection
assertion/receipt 链，且 journey/CLI/TUI 各自必须有 structured `requiredWhen` 或 `notApplicableRationale`。缺 link、
unobserved、重复、projection 与 source receipt splice 或复用 base assertion/receipt 都导出 `blocked`；明确 N/A 也不
计入 coverage。AQ-3 只交付 source-owned map generator 和 fail-closed rows，尚未把 AQ-4–AQ-6 的 L1 receipts 标为
observed，因此当前十行均为 `blocked`。V1 的单一 L0 suite identity 不能借给后续多个 L1 suite：AQ-4 必须以独立、
versioned `SentinelJourneyMapV2` 为每个 behavioral/projection receipt 记录自身 `suiteId`/`suiteDigest`，并逐条重建
验证；V1 保持可解析的 blocked snapshot，绝不被静默宽化为 observed L1 coverage。

验证：`bun test tests/evals/qualification/contract-adapter.test.ts`
`tests/evals/qualification/evaluator.test.ts` `tests/evals/qualification/l0-evidence.test.ts`
`tests/evals/qualification/sentinel-journey-map.test.ts`、`bun run typecheck`。

## AQ-4 L1 Tool、审批、Verification 与 Sentinel V2（diagnostic only）

`qualification-l1-tool-verification-v1` 以真实 `AgentKernel`、既有 Runtime scheduler、Tool Controller 和
Verification executor 运行封闭的 Scripted Model fixture；MCP provider、reviewer、Shell 均为进程内 synthetic
adapter。每个 run 使用新建且结束即删除的 synthetic root，固定时钟在串行 harness 内安装并恢复；它不读取
Provider credential、不发网络、不启动 child/stdio transport，也不读取项目/workspace/session 内容。L1 的七个
closed assertion 分别覆盖 Tool approval→execution→required Verification、非法参数后修正、用户拒绝中止当前
turn、已批准 sibling 并发、`unknown → 持久化重启 → 拒绝 late terminal → reconciliation`、required Verification
阻止 false completion，以及有界 cleanup 保留 `unknown`。这些断言调用当前 product Runtime，失败只导出
diagnostic `failed`/`blocked`，不会修改 Controller、reducer、Scheduler、Verification 或产品默认值。

每项 L1 观察先生成独立、metadata-only 的 `L1ToolVerificationReceiptV1`；receipt 固定
`authority='diagnostic'` 与 `evidenceEligible=false`，并直接绑定实际 source binding、Feature/assertion、Matrix、suite、
evaluator report 与 adapter outcome。专用 verifier 重新发现 source-owned binding、重建 corpus/oracle/evaluator/
verifier/runner，并把 receipt 与 caller 的 `AgentQualificationEvidenceV1` attempt 精确闭合到 candidate、execution、
scope、governance 与 retention；通用 aggregate verifier 仍拒绝 behavioral context。伪造 report、receipt、scope 或
candidate closure 都是 `blocked`。

`qualification-l1-public-projection-v1` 单独调用真实 CLI `projectCliRuntimeEventV1` 和 TUI
`handleRuntimeEventAction`，以短暂 synthetic runtime event 验证 journey 1–2 的独立 CLI/TUI receipt：CLI terminal
presentation、TUI invalid-arguments error projection 与 approval interrupt 均不保留 input/output 内容。它的 suite、
source binding 和 receipt 与 behavioral suite 不同，不能复用 behavioral assertion/receipt。CLI projection 实现在
`src/app/cli/runtime-event-projection.ts`：CLI 主入口继续 re-export 同一 public function，但该纯 projection 模块不导入
CLI bootstrap、项目 config 或 release composition，使 L1 adapter 只能调用实际 projection 而不触达 release/config 边界。

`SentinelJourneyMapV2` 保持与 V1 独立的 versioned shape。资格化 diagnostic 路径只能使用
`buildSourceOwnedSentinelJourneyMapV2`/`verifySourceOwnedSentinelJourneyMapV2`：它从三个 candidate-bound specialized
verifier input 重新构建 source ownership、Matrix、两套 suite、behavioral receipt、CLI receipt、TUI receipt 与
applicability；三份 candidate closure 不完全一致、任一 receipt 未 qualified、projection 复用 behavioral binding，或
persisted map 与 fresh reconstruction 不同，journey 1–2 均为 `blocked`。输入完整且三链一致时，只有这两条 journey
可标记 `observed`；其余八条仍为 `blocked`。通用 V2 模块只公开 schema/digest，不接受 callback、raw snapshot 或
persisted map 来生成或验证 `observed`。`SentinelJourneyMapV1` 永远保持 AQ-3 的全 `blocked` L0 snapshot，
不承载 V2 或 L1 结论。无论 V2 的 diagnostic state 如何，均不输入 Release Evidence、release bundle/gate、G0/G1、
DeepSeek/Qwen G1 smoke 或 production content admission。

验证：`bun test tests/evals/qualification/runtime-tool-verification.test.ts`
`tests/evals/qualification/public-projection-adapter.test.ts`
`tests/evals/qualification/l1-evidence.test.ts`
`tests/evals/qualification/sentinel-journey-map-v2.test.ts`
`tests/evals/qualification/source-owned-sentinel-journey-map-v2.test.ts`、`bun run typecheck`。

## AQ-5 L1 Skill/MCP 纵向切片与 Sentinel V2 分支（diagnostic only）

`qualification-l1-skill-mcp-v1` 是独立、封闭的 deterministic diagnostic suite；corpus 只保留
case ID、source-owned adapter/assertion pair 与 outcome token。它不复用 `ReleaseEvidenceV1`、release
bundle、Gate evaluator 或 G0–G5 vocabulary。下列六个 pair 必须由相邻 product declaration 发现，任一
缺失、重复、source surface/Feature/assertion mismatch、fixture/runner/evaluator/corpus/oracle/verifier
digest 漂移均 fail closed：

| Source owner | Closed pair | 诊断断言 |
| --- | --- | --- |
| `executeRuntimeTools` | `mcp-auth-invalid-provider-action-v1` | invalid auth 终结原 Tool，并只产生受治理的 Provider Action。 |
| `DefaultMcpSupervisor` | `mcp-project-approval-catalog-churn-v1` | pending project approval/catalog churn 不会变成可调用 Provider。 |
| `classifyMcpWriteRecoveryV1` | `mcp-unknown-write-reconciliation-v1` | unknown write 只能进入 reconciliation，不能重放或成功化。 |
| `eventsForRuntimeAction` | `runtime-provider-action-new-turn-v1` | Provider Action 完成后只启动 fresh turn。 |
| `activateSkillLifecycle` | `skill-discovery-activation-output-v1` | scan、activation 与结构化 output 仍受 Skill contract 闭合。 |
| `compileSkillWorkflow` | `skill-mcp-dependency-revision-drift-v1` | Skill→MCP dependency revision drift 在 Provider call 前 fail closed。 |

runner 为每次运行新建并最终删除 sealed synthetic root，显式传入四项 `SkillScanOptions`，并只使用
in-memory MCP repository/control plane/auth coordination 与 fake Provider。它不读取 caller cwd、workspace/
project/session overlay、HOME 或环境 credential，不使用默认 config loader、网络、HTTP/stdio transport、child
process 或 native credential/keyring。receipt 和 report 仅保存安全 metadata/digest；fixture、endpoint、key、授权
URL、arguments、prompt/response/reasoning、source body 与 workspace 内容均不记录。

`L1SkillMcpReceiptV1` 固定 `authority='diagnostic'` / `evidenceEligible=false`，精确绑定 source binding、
Matrix/suite、evaluator report、adapter outcome 及 candidate/execution/scope/governance/retention attempt。
`verifyL1SkillMcpEvidenceV1` 自行重新发现 binding，重建 catalog、Matrix、suite、corpus、evaluator、fixture/
runner 与 receipt；通用 aggregate verifier 仍拒绝 behavioral context。因而伪造 report/receipt、交换 source
record、candidate closure 或 execution，均只能导出 `blocked`。

`SentinelJourneyMapV1` 仍是 AQ-3 的十行全 `blocked` L0 snapshot，绝不接收 AQ-5 receipt。
`SourceOwnedSentinelJourneyMapV2InputV1` 仍可重建 AQ-4 的 journey 1–2；AQ-5 使用独立的
`SourceOwnedSentinelJourneyMapV2InputV2`，把六份 opaque、candidate-bound verifier input 固定键控到六个
source surface。fresh reconstruction 仅可将 journey 3–6 分别闭合到上述 Skill activation、revision drift、
project-approval + unknown-write、auth-invalid + fresh-turn pair；所有 record 的 candidate closure 也必须与
AQ-4 behavioral/CLI/TUI records 完全一致，否则对应 journey 保持 `blocked`。

当前 public projection catalog 没有覆盖任一**完整** journey 3–6 的 CLI/TUI 端到端 receipt。因此 source-owned
V2 对其 CLI/TUI 都生成结构化 `entrypoint_not_exposed` N/A，而不是从 Runtime receipt 派生 projection。
`tui-provider-action-projection-v1` 仍是一个独立、有效的实际 `provider.action_required` UI 投影 receipt；它只
覆盖 action-required prompt，不能证明 login completion 或 fresh new turn，故特意不链接到完整 J6。缺少完整
public receipt 不能被局部 UI receipt 补绿。

无论 L1 Skill/MCP 或 Sentinel V2 的 diagnostic state 如何，它们都不输入 Release Evidence、release
bundle/parser、Gate evaluator、G0/G1、既有 DeepSeek/Qwen `qwen3.6-flash` smoke 或 production content admission。

验证：`bun test tests/evals/qualification/runtime-skill-mcp.test.ts`
`tests/evals/qualification/l1-evidence.test.ts`
`tests/evals/qualification/public-projection-adapter.test.ts`
`tests/evals/qualification/source-owned-sentinel-journey-map-v2.test.ts`、`bun run typecheck`。

## AQ-6 L1 Subagent/Runtime 恢复（diagnostic only，已完成）

AQ-6 的 `qualification-l1-subagent-recovery-v1` 是独立、sealed 的 deterministic diagnostic
suite。它只把下列 source-owned pair 作为 closed implementation provenance，不能在 qualification
层手工建立 Feature 清单，不能借 AQ-4/AQ-5 receipt、fault-soak 输出或局部 callback 宣称恢复成功：

| Source owner | Closed pair | 本地 Runtime 不变量 |
| --- | --- | --- |
| `runSubAgent` | `subagent-parent-child-reservation-v1` | parent/child reservation、ceiling 与 child ledger link 不能漂移。 |
| `executeRuntimeTools` | `subagent-approval-resume-claim-v1` | approval continuation 在 child dispatch 前必须取得并复读精确的 durable resume claim。 |
| `reduceRuntimeState` | `runtime-subagent-terminal-consumption-v1` | terminal task call 不接受 duplicate/late terminal，同一 tool call 只进入一个 canonical ToolMessage。 |
| `createAgentKernel` | `runtime-subagent-restart-unknown-v1` | 已 dispatch/已 claim 而无 terminal 的恢复保持 unknown/recovery-unavailable，绝不自动 replay。 |
| `applyEffectEvent` | `runtime-late-terminal-convergence-v1` | late terminal 不得改写 terminal/unknown state；resource-only reconciliation 不能复活调度。 |
| `eventsForRunCancellation` | `runtime-parallel-cancel-convergence-v1` | 并行 Tool/Subagent 的 active、queued、waiter 与 reservation 一起保守收敛。 |
| `forkSession` | `runtime-rewind-fork-tightening-v1` | fork 清除 elevation、grant、交互、suspended continuation 和 resume claim。 |

`L1SubagentRecoveryReceiptV1` 固定 `authority='diagnostic'` 与 `evidenceEligible=false`。它只保存
safe identifier/digest、source binding、Matrix/suite、evaluator/report 和 adapter outcome；不得保存
continuation/task/tool result、workspace、prompt、source body、credential 或 child output。专用 verifier
必须 fresh reconstruct source owner、Matrix、corpus、oracle、evaluator、runner、fault-injection、receipt
与 outer `AgentQualificationEvidenceV1` 的 candidate/execution/scope/governance/retention closure；任一
splice、缺失或 drift 保持 `blocked`。

六个 crash cut point 只按真实 durable boundary 解释：P1 parent reservation 已写入但尚未 dispatch；P2
parent `dispatch_started` 无 terminal；P3 child model `dispatch_started` 无 response；P4 child tool
`dispatch_started` 无 terminal；P5 suspended approval/单次 resume claim；P6 task terminal 或 late event。
P1 可释放可证明未 dispatch 的 reservation；P2–P4 进入 unknown/reconciliation；P5 的已 claim 恢复和
无法证明 claim 的旧 snapshot 都 fail closed；P6 只允许本地单次 terminal consumption 与受限 resource
reconciliation。这不是 Provider、Tool 或任何外部系统的 distributed exactly-once 保证。

`SentinelJourneyMapV1` 继续是 AQ-3 的全 `blocked` L0 snapshot。已完成的
`SourceOwnedSentinelJourneyMapV2InputV3` 保留并 fresh reconstruct input v1/v2，逐项闭合 AQ-4/AQ-5/AQ-6
record 的 candidate closure，并以七个固定 AQ-6 source-owned record 诊断性收敛 J7–J10。J7–J9 的 CLI/TUI
适用性只能由 public-surface collector 给出 source-owned `not_applicable` / `entrypoint_not_exposed`；没有为
它们伪造 projection receipt，也不把该 N/A 扩展到 J10。

J10 的 CLI 同样只有 source-owned collector 证明无入口时才是 `entrypoint_not_exposed`，但 TUI `/rewind` 是
`required` 的实际公开 surface。独立的 `qualification-l1-tui-rewind-fork-projection-v1` receipt 经专用 verifier
重建真实 `/rewind` 解析 → `useSlashCommand` → `dispatchTuiRewindRequest` → `useRunRewind` → `forkSession` 路径，
并验证 fork 清除 elevation、grant、binding/disclosure、interaction、provider waiver、suspended continuation 与
resume claim；它不是 AQ-4 通用 projection receipt 或局部 reducer/UI state 的替代品。

J7–J10 的 `observed` 仅是 candidate-bound、source-owned diagnostic state。它们不输入 Release Evidence、release
bundle/parser、Gate evaluator、G0/G1、现有 DeepSeek/Qwen `qwen3.6-flash` smoke 或 production content admission。

验证：`bun test tests/evals/qualification/runtime-subagent-recovery.test.ts`
`tests/evals/qualification/tui-rewind-projection.test.ts`
`tests/evals/qualification/l1-evidence.test.ts`
`tests/evals/qualification/sentinel-journey-map-v2.test.ts`
`tests/evals/qualification/source-owned-sentinel-journey-map-v2.test.ts`
`tests/tui-rewind-path.test.tsx`、`bun run typecheck`。

## AQ-7 L2 Native Conformance（diagnostic only；当前 transport blocked）

`qualification-l2-native-conformance-v1` 从 source-owned
`PRODUCTION_DISTRIBUTION_TARGETS_V1`、D-04 support declaration、公开 CLI/TUI surface 与 standalone candidate
contract 生成固定的 `candidate × distribution target × capability` corpus。当前 corpus 是 macOS 15 arm64、
Ubuntu 24.04 x64、Windows 2025 x64 各五项（archive integrity、CLI smoke、TUI smoke、native platform、
standalone keyring unavailable），共十五项；target、OS/arch、runner class、source surface、Feature、assertion、
Matrix/suite/oracle/corpus/evaluator/verifier/runner digest 任一漂移均 fail closed。D-04 的 accepted empty support set
不会被 smoke、platform observation 或其他 OS 的结果改写：contract fixture 中的完整 observation 至多导出对应
`unsupported` 或 `verified_disabled`，绝不导出 production support 或全局 PASS。

standalone keyring Feature 本身保持 `supported/default_on/runtime`。它的 source fact 同时绑定 candidate resolver、
unavailable module、`KNOWN_LIMITATIONS` 和 `RELEASE_NOTES`；collector 重新检查公开 CLI command/option 与 TUI
slash registry。只有确认不存在 credential/keyring-specific public entrypoint 时，CLI 与 TUI 各自以 source-fact
digest 记录 scoped `entrypoint_not_exposed`，不能把整个 runtime Feature 改写为 unsupported。future-only archive
adapter 只接受同一受保护调用方内存中的已验证 candidate result，精确闭合 archive/manifest/commit/target 与
`bin/kite`、`bin/kite-tui` 的 marker bytes，返回的仅是 payload-bound marker digest；archive path、manifest、binary
或 output 不会进入 receipt。所有 unavailable credential API 仍必须 fail closed 且不回显输入。

`.github/workflows/native-conformance-qualification.yml` 是没有 credential 的独立 diagnostic workflow：只允许 canonical
repository 的 `main` push 或无输入的 manual dispatch，固定三项 source-owned runner、只读 `contents`、pinned action、
serial execution 和十分钟上限。它目前唯一可执行的分支是 sealed governance preflight：无可审计的 atomic quota ledger、
maintainer authorization、retention witness 与 protected-ref witness 时，在 candidate/archive/build/projection/install/PTY
smoke 或 child dispatch 之前写出一个 metadata-only blocked worker transport。该 transport 只有 requested protected-CI
profile reference，不是 retention assertion、candidate/execution observation、receipt、`AgentQualificationEvidenceV1`、
platform evidence 或 release artifact；worker artifact 只保留十四天且不能成为 Issue、release bundle 或 Gate input。

L2 的 GitHub execution wrapper 与 AQ-2 generic execution shape 分离。generic
`verifyAgentQualificationEvidenceV1` 仍拒绝 GitHub execution；专用
`verifyL2NativeConformanceReceiptV1` 即使重建 source binding、Matrix、candidate/execution、report、governance 和
receipt 后，在当前没有 non-forgeable protected control plane 的实现中也稳定返回
`blocked/retention_unavailable`。它不生成 aggregate qualification evidence。future local
`L2NativeIndependentPlatformProjectionV1` 固定 `authority='diagnostic'` / `evidenceEligible=false`，以 exact GitHub
source/execution closure 和 opaque projection digest 生成 L2 probe binding；它不输入、extend 或模拟既有
`PlatformCapabilityEvidenceV1`、其 parser/verifier 或当前平台发布证据路径。current preflight runner 不调用该
future adapter，也不调用 archive marker adapter。

因此 AQ-7 不改变 G0/G1、现有 DeepSeek/Qwen `qwen3.6-flash` G1 smoke、ADR-0068/ADR-0069、D-04 production
support、release candidate workflow、Release Evidence/parser/bundle、Gate evaluator 或 production content admission。
删除或关闭该 diagnostic workflow 只撤回 L2 transport，不改变现有发布体系。

验证：`bun test tests/evals/qualification/native-conformance.test.ts`
`tests/evals/qualification/l2-evidence.test.ts` `tests/evals/qualification/l2-worker-record.test.ts`
`tests/evals/qualification/l2-receipt-verifier.test.ts`
`tests/evals/qualification/l2-verified-platform-probe-adapter.test.ts`
`tests/evals/qualification/l2-keyring-archive-marker.test.ts`
`tests/evals/qualification/l2-native-runner.test.ts`
`tests/evals/qualification/native-conformance-workflow.test.ts`
`tests/evals/qualification/feature-matrix.test.ts`
`tests/release/standalone-keyring-unavailable.test.ts`
`tests/sandbox/platform-capability-probe.test.ts`、`bun run typecheck`。

## AQ-9A L1 自动压缩失败 contract（diagnostic only）

`qualification-l1-auto-compaction-failure-v1` 由 `invokeRuntimeModel` 相邻的 source-owned declaration 发现，
不建立人工 Feature 平行清单。它用真实 AgentKernel、ModelController、Runtime executor/scheduler/runner 和仅会
抛出不透明本地错误的 scripted transport，覆盖 `summary_failure`、`provider_failure`、`provider_network_failure` 三个
closed pair。所有三种 injected fault 都必须保留产品既有
`context.compaction_failed(summary_model_failed)` terminal 语义；同一 turn 只有 compaction preflight/request/failure
并停止，不能发普通 model dispatch；late completion 不得复活该 turn，下一条 user message 的新 turn 才重试。

fixture 由 production projection/token estimator 生成 9–12K 安全 context，测试仅在内存中设置 8,192 threshold；
不改默认 flag、`contextWindowTokens`、Provider 配置或网络边界。每条结果先形成独立、metadata-only 的
`L1AutoCompactionFailureReceiptV1`，固定 `authority='diagnostic'`、`evidenceEligible=false`，且没有 prompt、response、
error body、route、credential、endpoint、source body 或 workspace 内容的字段。专用 verifier fresh reconstruct
source binding、Matrix、suite/corpus/oracle/evaluator/verifier/runner、receipt 与 outer candidate/execution/scope/
governance/retention closure；任何 pair/source/receipt/identity drift 为 `blocked`。该 receipt 不进入
`ReleaseEvidenceV1`、release parser/bundle、Gate evaluator、G0/G1、DeepSeek/Qwen `qwen3.6-flash` smoke 或
production content admission。该 L1 contract 已在 ADR-0072 AQ-8 独立复审关闭后按顺序重新验收；这只解锁
ADR-0072 public-safe AQ-9B，实现不改变 ADR-0071 formal L3 的 `activation=false`。

验证：`bun test tests/evals/qualification/auto-compaction-failure-contract.test.ts`、
`bun test tests/runtime/context-compaction-auto.test.ts`、`bun run typecheck`。

## AQ-9B L3 自动压缩 success/cancel contract（diagnostic only）

`qualification-l3-live-auto-compaction-v1` 只预留 AQ-8 future sealed resolver/ledger/environment primitive；它有独立
policy、route binding、source-owned 9–10K fixture/corpus、oracle、phase caps、semantic receipt、source registry 与
specialized verifier，不输入或模拟 AQ-8 observation、generic qualification evidence、ReleaseEvidence、release bundle/
Gate 或 G0–G5 vocabulary。当前 public success/cancel wrapper 受 checked-in activation literal 安全停用；source-byte
binding 后会在读取 parent environment/ledger、创建 resolver/reservation/model lease、scratch 或 child 前 `blocked`。opt-in、
credential、ledger root 或 health JSON 都不能改变这个结果，因而当前不会产生 L3 receipt、observation、retained/observed
report 或 evidence；public wrapper 只返回脱敏、有界的 `blocked` run report。

当前 success/cancel product-chain contract 仅由 `runSyntheticAutoCompactionContractV1` 的 zero-credential test driver
覆盖。它没有 environment、ledger、resolver、lease、caller model function 或 real provider/model boundary；只使用固定
synthetic scenario 或固定 `operation='test'` child mode，且永不输出 reservation、semantic receipt、observation、report 或
evidence。它仍经真实 AgentKernel/ModelController/executor/scheduler 验证 success 与取消：当前 synthetic turn 停止，
scheduler 在下一 user turn 做 preflight/retry。AQ-9A 的 injected summary/provider/network failure 不可作为 AQ-9B 结果。

AQ-9B 只在内存中采用 8,192 absolute threshold 与合计 12,229 phase cap，**不得读取、设置或推断**产品
`contextWindowTokens`（source registry 固定 `unknown/not_declared`），也不改产品 flag 或普通 provider config。未来获
persistent-supervisor 授权的 success 只可接受 summary + same-turn checkpoint primary；cancel 只可接受 summary transport
已进入后的 operator `SIGINT`。届时所有 other terminal（未广告 tool-call、non-allowed scheduler effect、output/cap/identity
drift、cleanup failure 或 unknown dispatch）仍须在 Tool/Skill/MCP/Subagent child executor 前 full-request reconcile、
`blocked`，无 observation/receipt。任何未来 report 只保留 schema-closed semantic labels、digest、stable reason code 和
coarse duration bucket；不得含 raw duration、credential、endpoint、prompt/response/reasoning、source/workspace body 或 child
output，更不能改变 G0/G1、DeepSeek/Qwen `qwen3.6-flash` smoke、release control 或 production content admission。

验证：`bun test tests/evals/qualification/live-auto-compaction-runner.test.ts tests/evals/qualification/auto-compaction-live-evidence.test.ts tests/test-discovery.test.ts`、`bun run typecheck`。当前只可报告该本地 synthetic contract，绝不报告 L3/G1/release compatibility。
