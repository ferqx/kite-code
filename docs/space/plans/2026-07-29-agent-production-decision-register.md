# Agent 生产化决策登记

状态：active
创建：2026-07-30
适用范围：Agent 生产就绪 Phase 0–6
规范来源：
[`Agent 生产就绪 RFC §24`](../../design/2026-07-29-agent-production-readiness-rfc.md)、
[`Phase 0 治理计划`](2026-07-29-agent-production-governance-decisions.md)

## 使用规则

- 本文是 `D-01`–`D-14`、责任角色和 execution binding 的规范登记入口。
- `open` 决策在 `dueMilestone` 前采用 `default`，且不能越过 `blockingPhase`。
- `closed` 必须同时有非空 `decision`、可复核 `evidence` 和 `approvedAt`；修改已关闭决定时新增
  revision/ADR，不覆盖旧结论。
- 仓库 identity 只使用可从提交或 ADR 追溯的公开标识。私人联系方式保留在维护者控制的非仓库
  系统。
- 项目按 ADR-0060 使用 `single-maintainer` 模式：所有 owner 为 `github:@ferqx`，没有真实
  backup 时显式登记 `none (single-maintainer)`，不得虚构第二身份。
- `MS:M0` 只能由 Task 0.5 的角色逐项评审记录产生。本文不存在 `MS:M0` producer。
- `MS:LIM-APPROVED` 前必须取得由不同真人完成、绑定 candidate identity 的第三方安全评审；
  维护者不能自批 G0 例外。

## Owner 与升级路径

| 角色 | Primary | Backup | 仓库内职责入口 | 当前限制 |
| --- | --- | --- | --- | --- |
| Capability Owner | `github:@ferqx` | `none (single-maintainer)` | capability plan、ADR 和 PR review | 维护者不可用时 capability 晋级 fail closed |
| Release Owner | `github:@ferqx` | `none (single-maintainer)` | release plan、Gate record 和 PR review | external 前必须补独立第三方安全评审 |
| Security & Privacy Owner | `github:@ferqx` | `none (single-maintainer)` | security/privacy ADR、G0 record 和 PR review | 不能自批 G0 例外 |
| Platform Owner | `github:@ferqx` | `none (single-maintainer)` | platform matrix、sandbox evidence 和 PR review | 非空 production execution support 尚未批准 |
| Evaluation/Product Owner | `github:@ferqx` | `none (single-maintainer)` | evaluation plan、threshold record 和 PR review | 用户样本与 benchmark 尚未预注册 |
| Incident Commander | `github:@ferqx` | `none (single-maintainer)` | incident record、runbook revision 和 PR review | 维护者不可联系时 cohort=0，恢复批准 blocked |

升级顺序为 `Owner → Incident Commander → external third-party security reviewer`。维护者不可
联系或第三方评审缺失时，严格默认值是停止发布/扩 cohort、cohort=0、禁止高风险 capability
晋级。limited cohort 的直接联系入口保留在维护者控制的非仓库系统；仓库只保存
`github:@ferqx` 和安全的 review record URI/digest。

## 决策字段

每条记录都使用以下字段：

`id/status/owner/backup/dueMilestone/blockingPhase/default/decision/evidence/approvedAt`

### D-01

- status: `open`
- owner: `github:@ferqx`（Capability + Evaluation/Product）
- backup: `none (single-maintainer)`
- dueMilestone: `MS:LIMITED-SLO`
- blockingPhase: `Phase 4`
- default: `limited-production` 中 manual compaction 为 `off`，不提供实验 opt-in；auto 为 `off`
- decision: 尚未决定是否允许 external manual canary
- evidence: [Phase 4 计划](2026-07-29-agent-production-compaction-qualification.md)；
  [ADR-0057](../../adr/0057-compaction-release-qualification.md)
- approvedAt: `null`

### D-02

- status: `closed`
- owner: `github:@ferqx`（Security & Privacy + Release）
- backup: `none (single-maintainer)`
- dueMilestone: `MS:M0`
- blockingPhase: `Phase 1A`
- default: metadata-only、7 天、总量 256 MiB、单 session 16 MiB；权限或 retention enforcement
  不可验证时 logging=`off`
- decision: production session logging 默认 metadata-only；保留 7 天，总量上限 256 MiB，
  单 session 上限 16 MiB。权限、ACL、rotation 或 retention enforcement 不可验证时
  logging=`off`；project/user 只能关闭或收紧
- evidence: [Phase 1A 计划](2026-07-29-agent-production-local-data-privacy.md)；
  [ADR-0056](../../adr/0056-metadata-first-data-boundaries.md)
- approvedAt: `2026-07-30`

### D-03

- status: `closed`
- owner: `github:@ferqx`（Security & Privacy + Release）
- backup: `none (single-maintainer)`
- dueMilestone: `MS:3-OPS-READY`
- blockingPhase: `Phase 3`
- default: remote telemetry=`off`；没有预注册且可观测的 SLO 数据时 external canary 保持 blocked
- decision: external canary 强制使用与普通 telemetry consent 分离的显式 opt-in；只允许版本化、
  低基数、匿名且无 prompt/response/file/path/command/error 正文的结构化 telemetry。artifact authority、
  release flag、用户 consent、canary opt-in 与真实 exporter 任一缺失时 cohort admission blocked；无数据
  保持 unknown/blocked，不能显示绿色。普通安装的 remote telemetry 继续默认关闭
- evidence: [Phase 3 计划](2026-07-29-agent-production-observability-operations.md)；
  [ADR-0056](../../adr/0056-metadata-first-data-boundaries.md)；
  [ADR-0063](../../adr/0063-no-content-observability-and-single-maintainer-operations.md)；
  `src/app/observability/external-canary.ts`；用户于 2026-08-02 批准显式 opt-in、匿名无正文方案。
  当前 exporter/baseline/真实 observation 仍未配置
- approvedAt: `2026-08-02`

### D-04

- status: `closed`
- owner: `github:@ferqx`（Platform + Evaluation/Product）
- backup: `none (single-maintainer)`
- dueMilestone: `MS:2A-F`
- blockingPhase: `Phase 2A`
- default: supported platform/backend/entry/provider route 集合为空，不生成 production artifact
- decision: 接受 macOS 15/Seatbelt、Ubuntu 24.04/bubblewrap、Windows Server 2025/none
  三个候选均为 `excluded` 的原生探针结论；首批 platform/backend/entry/provider route 支持集
  固定为空，不生成 production artifact。未来加入任何非空支持项必须新增 ADR、原生证据和
  append-only decision revision
- evidence: [Phase 1B 计划](2026-07-29-agent-production-execution-isolation.md)；
  [Phase 2A 计划](2026-07-29-agent-production-release-control.md)；
  [ADR-0053](../../adr/0053-local-single-user-first-topology.md)；
  [ADR-0061](../../adr/0061-production-platform-capability-admission.md)；
  [原生证据 run 30579701659](https://github.com/ferqx/kite-code/actions/runs/30579701659)
- approvedAt: `2026-07-31`

Revision D-04.1（2026-08-02）：澄清 Windows、Linux、macOS 是 Bun 本地 TUI/CLI 的发行目标，
发行可运行性与 effectful execution capability 分开准入。三平台原生候选验证优先使用
GitHub-hosted `macos-15`、`ubuntu-24.04`、`windows-2025`；不要求维护者为常规发行维护
self-hosted Ubuntu。Docker/WSL2 仅作开发预检。该修订不改变空 production execution support set，
也不开放任何 Shell/writer/Skill/MCP 能力；后者仍按精确 capability surface、原生 evidence 与独立
release gate fail closed。依据：[ADR-0065](../../adr/0065-cross-platform-distribution-and-capability-admission.md)
及用户于 2026-08-02 的范围澄清。

### D-05

- status: `open`
- owner: `github:@ferqx`（Evaluation/Product + Release）
- backup: `none (single-maintainer)`
- dueMilestone: `MS:4-MANUAL-STABLE`
- blockingPhase: `Phase 6`
- default: `full` 保持 experimental 且 rollout=`off`，不进入 GA selection
- decision: 尚未决定首个 GA 是否包含 `full`
- evidence: [Phase 6 计划](2026-07-29-agent-production-ga.md)；
  [ADR-0051](../../adr/0051-release-profile-monotonic-composition.md)
- approvedAt: `null`

### D-06

- status: `closed`
- owner: `github:@ferqx`（Release + Security & Privacy）
- backup: `none (single-maintainer)`
- dueMilestone: `MS:2A-F`
- blockingPhase: `Phase 2A`
- default: 未验证 signature/provenance/托管 identity 时不分发 artifact；rollout signing 不阻塞首个
  limited，但未实现时 rollout 服务保持 disabled
- decision: 开源发布使用 GitHub Actions OIDC 与 keyless Sigstore/Cosign 对 canonical
  `ReleaseManifestV1` bytes 生成 detached bundle；GitHub artifact attestation 绑定 payload、
  manifest、SBOM 和构建 provenance，GitHub Releases 托管可分发 bundle。Verifier 固定 canonical
  repository `ferqx/kite-code`、repository ID `R_kgDOSKbi8g`、release workflow path、OIDC issuer、
  protected tag/ref、commit、workflow SHA、run ID/attempt 与 artifact digest。PR、fork、普通 branch
  与本机不得签名或发布；仓库公开前只允许 `nonDistributable` synthetic trust root，真实 signing/
  attestation/release workflow disabled。远程 rollout signing 暂不启用；平台原生签名、正式
  qualification 和第三方安全评审仍是独立硬门禁
- evidence: [Phase 2A 计划](2026-07-29-agent-production-release-control.md)；
  [ADR-0052](../../adr/0052-release-evidence-and-behavior-identity.md)；
  [ADR-0059](../../adr/0059-optional-disable-only-signed-rollout.md)；
  [ADR-0062](../../adr/0062-keyless-release-signing-and-github-hosting.md)；用户于 2026-08-02
  批准推荐方案
- approvedAt: `2026-08-02`

### D-07

- status: `closed`
- owner: `github:@ferqx`（Evaluation/Product + Release）
- backup: `none (single-maintainer)`
- dueMilestone: `MS:2A-F`
- blockingPhase: `Phase 2B`
- default: 未预注册人群、任务、重复次数和阈值时所有产品 Gate 为 unknown/blocked
- decision: 首批目标是单一维护者或本地开发者在可信 Workspace 中使用 TUI 或用户在场的前台
  Headless CLI；托管、多租户、无人值守 CI writer 与共享 checkout 不在首批范围。正式 suite 固定
  12 个 case，覆盖全部 8 类任务，并精确包含 4 simple/6 medium/2 complex、4 long context、
  3 read-only/9 workspace-write、4 TUI/8 Headless CLI；语言范围是 TypeScript/JavaScript 的
  Bun/Node repository 加语言无关 research/documentation。MCP write 与 effectful Skills 不进入首批
  正向 suite。PR 只跑确定性 contract 一次；route/baseline 变化每个非确定性 case 运行 8 次；RC
  的非确定性 case 运行 20 次，确定性 case 仍为 1 次。G0 与 false completion 必须为 0，
  总成功率至少 90%，每个 case 至少 80%。维护者
  `github:@ferqx` 的真实 dogfood 只算 internal；external limited 至少 3 名不同的 opt-in 用户且每人
  至少 4 个任务，缺失时保持 `not_observed`。非 G0 p95 latency/token/user-correction 只有在真实
  baseline 冻结后才使用，回归上限为 25%
- evidence: [Phase 2B 计划](2026-07-29-agent-production-evaluation.md)；
  [ADR-0058](../../adr/0058-agent-task-product-acceptance.md)；用户于 2026-08-02 批准单维护者优先
  推荐方案；live/external/formal adversarial evidence 仍为 `not_observed`
- approvedAt: `2026-08-02`

### D-08

- status: `closed`
- owner: `github:@ferqx`（Security & Privacy + Platform）
- backup: `none (single-maintainer)`
- dueMilestone: `MS:M0`
- blockingPhase: `Phase 1B`
- default: filesystem=`workspace_write`、network=`off`、protected paths=`deny`；sandbox enforcement
  不可用时禁用 shell/writer/Skill child/local stdio MCP，只允许已通过 conformance 的进程内只读 run
- decision: limited filesystem=`workspace_write`、network=`off`、protected paths=`deny`；
  protected paths 至少包含 `.git`、Agent/MCP 配置、shell profile、credential/secret 和
  Workspace 外路径。sandbox enforcement 不可用时禁用 shell/writer/Skill child/local stdio
  MCP，只允许通过 conformance 的 Workspace-bound 进程内只读工具；后续 network allowlist
  只能按新 decision revision 收紧加入
- evidence: [Phase 1B 计划](2026-07-29-agent-production-execution-isolation.md)；
  [ADR-0054](../../adr/0054-production-execution-isolation.md)
- approvedAt: `2026-07-30`

### D-09

- status: `closed`
- owner: `github:@ferqx`（Platform + Evaluation/Product）
- backup: `none (single-maintainer)`
- dueMilestone: `MS:M0`
- blockingPhase: `Phase 1B`
- default: 前台 Headless CLI 只读；写入保持关闭。后台、定时、无人值守、并发或委派 writer
  必须独立 worktree/branch，不得共享 checkout
- decision: limited 前台 Headless CLI 保持只读。任何后台、定时、无人值守、并发或委派 writer
  必须使用独立 worktree/branch；共享 checkout 只允许只读 worker。未来放开前台 Headless
  writer 必须新增 decision revision，并先具备实时 diff、逐文件 review、停止和可恢复 handoff
- evidence: [Phase 1B 计划](2026-07-29-agent-production-execution-isolation.md)；
  [ADR-0054](../../adr/0054-production-execution-isolation.md)
- approvedAt: `2026-07-30`

### D-10

- status: `closed`
- owner: `github:@ferqx`（Capability + Security & Privacy）
- backup: `none (single-maintainer)`
- dueMilestone: `MS:LIMITED-SLO`
- blockingPhase: `Phase 5`
- default: `skills_readonly` 和 `skills_effectful` 均为 `off`；未知 effect/provenance 一律归
  effectful 且不得执行
- decision: 只有自身和全部 dependency 的 effective effects 均明确为 `none|read`，且来源满足
  builtin/admin allowlist 或受信任 Workspace 的 project provenance 时才归 `skills_readonly`。
  write、destructive、unknown、解析失败、dependency/revision drift 一律归
  `skills_effectful` 并保持 off；manifest/allowed-tools 只表达 ceiling，不构成预批准。
  effectful Skill 必须 required Verification。Capability admission 还必须同时验证全部 feature
  flags、dependency revision、route/platform、实际 evidence freshness 与 G3/G4/G5；任一缺失、
  unknown、stale 或 failed 均 blocked
- evidence: [Phase 5 计划](2026-07-29-agent-production-capability-rollout.md)；
  [ADR-0064](../../adr/0064-conservative-skill-effects-and-capability-profile-admission.md)；
  `tests/skills/effect-classification.test.ts`、`tests/release/capability-profile.test.ts`
- approvedAt: `2026-08-02`

### D-11

- status: `closed`
- owner: `github:@ferqx`（Platform + Release）
- backup: `none (single-maintainer)`
- dueMilestone: `MS:M0`
- blockingPhase: `Phase 1C`
- default: 未有已批准且可强制的完整预算 snapshot 时拒绝 production run；不得回退
  `maxEffects=10_000`
- decision: `ResourceBudgetV1` 使用父子累计 ledger、atomic tool/shell permit、FIFO bounded
  wait 和统一 terminal。limited 上限为 30 分钟、30 turns、60 model requests、250 tool
  invocations、1,000,000 input tokens、250,000 output tokens、2 concurrent subagents、
  1 writer、4 tool invocations、1 shell invocation、15 秒 concurrency wait、256 MiB
  artifacts、每 shell process tree 32。internal 上限为 60 分钟、50 turns、100 model
  requests、500 tool invocations、2,000,000 input tokens、500,000 output tokens、
  4 concurrent subagents、2 writers、8 tool invocations、2 shell invocations、30 秒
  concurrency wait、512 MiB artifacts、每 shell process tree 64。project/user/CLI 只能收紧
- evidence: [Phase 1C 计划](2026-07-29-agent-production-runtime-resilience.md)；
  [ADR-0055](../../adr/0055-cumulative-runtime-resource-governance.md)
- approvedAt: `2026-07-30`

### D-12

- status: `closed`
- owner: `github:@ferqx`（Release + Platform）
- backup: `none (single-maintainer)`
- dueMilestone: `MS:M0`
- blockingPhase: `Phase 2A`
- default: canonicalizer/schema/input identity 任一未知或 mismatch 时 evidence 失效且 Gate=blocked
- decision: manifest、profile、policy 和 scheduling snapshot 使用 RFC 8785 canonical JSON
  UTF-8 bytes；不额外 Unicode normalize。canonical input 来自 build 时实际 resolved
  Runtime/profile/policy/tool/system/default-runner snapshot，manifest 位于 payload 外且
  `payloadSha256` 不包含 manifest/signature。schema/canonicalizer/input identity 或任一行为
  字段变化使旧 evidence 失效；unknown/mismatch 为 Gate blocked
- evidence: [Phase 2A 计划](2026-07-29-agent-production-release-control.md)；
  [ADR-0052](../../adr/0052-release-evidence-and-behavior-identity.md)
- approvedAt: `2026-07-30`

### D-13

- status: `closed`
- owner: `github:@ferqx`（Release + Security & Privacy）
- backup: `none (single-maintainer)`
- dueMilestone: `MS:M0`
- blockingPhase: `Phase 0`
- default: 维护者不可联系时停止发布/恢复批准并将 external cohort 置 0；缺少有效第三方安全评审
  时不得产生 `MS:LIM-APPROVED`
- decision: 采用 ADR-0060 single-maintainer 模式；六类角色由 `github:@ferqx` 承担，backup
  显式为 none。limited 用户使用维护者控制的非仓库直接联系入口；Phase 3 按预注册 table-top
  流程演练检测、cohort=0/能力关闭、证据保全、通知、credential rotation、恢复和复盘。
  external release 前由不同真人完成第三方安全评审
- evidence: 本文 Owner 表；[ADR-0060](../../adr/0060-single-maintainer-release-governance.md)；
  [Phase 3 计划](2026-07-29-agent-production-observability-operations.md)
- approvedAt: `2026-07-30`

### D-14

- status: `closed`
- owner: `github:@ferqx`（Security & Privacy + Evaluation/Product）
- backup: `none (single-maintainer)`
- dueMilestone: `MS:M0`
- blockingPhase: `Phase 1A`
- default: production-qualified model/MCP route 集合为空；缺 policy、consent、region/retention/training
  或接收方 identity 时 fail closed
- decision: `ProviderDataPolicyV1` ownership 与最小字段按 Phase 1A/ADR-0056 冻结；M0 的
  production-qualified model/MCP route 集合为空。任何首批 route 必须通过新的 append-only
  decision revision 记录 operator/endpoint/region、数据分类、retention/training、DPA/consent、
  最小化与失效条件，不能因 model name 相同继承资格
- evidence: [Phase 1A 计划](2026-07-29-agent-production-local-data-privacy.md)；
  [ADR-0056](../../adr/0056-metadata-first-data-boundaries.md)
- approvedAt: `2026-07-30`

Revision D-14.1（2026-08-02）：记录首个 model route 候选为 DeepSeek 官方 API、
`deepseek-v4-flash`，canonical endpoint origin 为 `https://api.deepseek.com`，实际 OpenAI-compatible
base URL 保持 `https://api.deepseek.com/v1`；region 明确为 `unknown`。公开政策没有提供可登记的
API 正文固定 retention、已验证 training opt-out、DPA 和产品下游披露实现，因此候选固定
`productionContentAllowed=false`，`approved-v1.json` 继续为空。候选只进入
`release/provider-data-policies/candidates-v1.json`，production admission 不读取它。用户批准候选选择，
但没有把未知政策事实批准为通过。

Revision D-14.2（2026-08-02）：复核 DeepSeek 2026-02-10 官方隐私政策和 2026-04-22 Open
Platform Terms。政策明确个人数据直接在中华人民共和国处理/存储、可能用于训练并提供个人数据训练
opt-out 权利；同时明确开发者下游系统最终用户的数据处理不在该隐私政策覆盖范围内，开发者仍是控制者
并负责披露。route deployment region 仍未公布，API 正文固定 retention、API 级 opt-out 落地、DPA
和产品披露仍未验证。因此仅更新 candidate assessment，不改变 route identity digest、空 approved bundle
或 `productionContentAllowed=false`。证据：
https://cdn.deepseek.com/policies/en-US/deepseek-privacy-policy.html；
https://cdn.deepseek.com/policies/en-US/deepseek-open-platform-terms-of-service.html。

Revision D-14.3（2026-08-02）：single owner `github:@ferqx` 明确接受 DeepSeek 官方 API 对该首发
Route 的已披露数据风险：中国处理/存储、可能用于训练、未承诺固定 API 正文 retention、无 DPA，且
deployment region 记为 `unspecified`；这些事实不再作为 admission blocker。批准项只绑定
`providerType=deepseek`、`modelName=deepseek-v4-flash`、`https://api.deepseek.com[/v1]` 与 canonical
operator/deployment identity，换模型、换 endpoint、URL credentials/query/fragment、policy 过期或
digest 漂移均 fail closed。下游披露当前固定在 README/active/book release 文档，不要求 pre-release
per-run acknowledgement；secret/protected credential 拦截、独立 remote MCP egress、
`allowProductionContentEvaluation=false` 和真实 live evidence 要求保持不变。该风险接受不构成 2B.4
真实评估通过，也不替代 external release 前真人第三方安全评审。架构记录：[ADR-0066](../../adr/0066-deepseek-owner-accepted-provider-data-policy.md)。

## Execution bindings

Phase 0 artifact 基线为 `4be8735b29ec0fe3951bf7a0876f7b5e722c846a`。该提交是路线图复核
基线 `a316a2df63e511f839d08aa72a20275afa8e3366` 的后继；增量只修改 RFC、计划、ADR、
治理门禁与索引文档，没有生产源码、Runtime schema、system/tool contract 或测试 runner
变化。旧 live evidence 仍按路线图降为历史结果。

| taskId | executor | baselineCommit | branch | status | blockedReason | completionRecordPath | activatedAt |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 0.1 | `github:@ferqx` | `9a94379afec288394abcf8f36a076789102b1066` | `codex/agent-production-readiness-docs` | `completed` | — | `docs/space/execution/completed/2026-07-30-agent-production-governance.md` | `2026-07-30` |
| 0.2 | `github:@ferqx` | `9a94379afec288394abcf8f36a076789102b1066` | `codex/agent-production-readiness-docs` | `completed` | — | `docs/space/execution/completed/2026-07-30-agent-production-governance.md` | `2026-07-30` |
| 0.3 | `github:@ferqx` | `9a94379afec288394abcf8f36a076789102b1066` | `codex/agent-production-readiness-docs` | `completed` | — | `docs/space/execution/completed/2026-07-30-agent-production-governance.md` | `2026-07-30` |
| 0.4 | `github:@ferqx` | `9a94379afec288394abcf8f36a076789102b1066` | `codex/agent-production-readiness-docs` | `completed` | — | `docs/space/execution/completed/2026-07-30-agent-production-governance.md` | `2026-07-30` |
| 0.5 | `github:@ferqx` | `4be8735b29ec0fe3951bf7a0876f7b5e722c846a` | `codex/agent-production-readiness-docs` | `completed` | — | `docs/space/execution/completed/2026-07-30-agent-production-governance.md` | `2026-07-30` |
| 1A.1 | `github:@ferqx` | `4be8735b29ec0fe3951bf7a0876f7b5e722c846a` | `codex/agent-production-readiness-docs` | `completed` | — | `docs/space/execution/completed/2026-07-30-agent-production-local-data-privacy.md` | `2026-07-30` |
| 1A.5 | `github:@ferqx` | `4b8eec058df0af545675fc0e1c4135ee855848fd` | `codex/agent-production-readiness-docs` | `completed` | — | `docs/space/execution/completed/2026-07-30-agent-production-local-data-privacy.md` | `2026-07-30` |
| 1A.2 | `github:@ferqx` | `1e21055eb8b2579d710eb566728294f2ad8b2621` | `codex/agent-production-readiness-docs` | `completed` | — | `docs/space/execution/completed/2026-07-30-agent-production-local-data-privacy.md` | `2026-07-30` |
| 1A.3 | `github:@ferqx` | `2e1a2721b1c7e3c17a483a3d33bcd503a6a777ee` | `codex/agent-production-readiness-docs` | `completed` | — | `docs/space/execution/completed/2026-07-30-agent-production-local-data-privacy.md` | `2026-07-31` |
| 1A.4 | `github:@ferqx` | `2e1a2721b1c7e3c17a483a3d33bcd503a6a777ee` | `codex/agent-production-readiness-docs` | `completed` | — | `docs/space/execution/completed/2026-07-30-agent-production-local-data-privacy.md` | `2026-07-31` |
| 1A.6 | `github:@ferqx` | `9bc626a1996261545c94e1e5950274029152bf1e` | `codex/agent-production-readiness-docs` | `completed` | — | `docs/space/execution/completed/2026-07-30-agent-production-local-data-privacy.md` | `2026-08-01` |
| 1A.7 | `github:@ferqx` | `545161a7103365038989c6a935a216c5bd5fc7e8` | `codex/agent-production-readiness-docs` | `completed` | — | `docs/space/execution/completed/2026-07-30-agent-production-local-data-privacy.md` | `2026-08-01` |
| 1B.0 | `github:@ferqx` | `2e1a2721b1c7e3c17a483a3d33bcd503a6a777ee` | `codex/agent-production-readiness-docs` | `completed` | — | `docs/space/execution/completed/2026-07-31-agent-production-execution-isolation-spike.md` | `2026-07-31` |
| 1B.1 | `github:@ferqx` | `1063e879933f3e1b0cf8c0958363c999bb2696ab` | `codex/agent-production-readiness-docs` | `completed` | — | `docs/space/execution/completed/2026-07-31-agent-production-execution-boundary.md` | `2026-07-31` |
| 1B.2 | `github:@ferqx` | `3ada4246b149444ce27ed713cd5425090367c1fc` | `codex/agent-production-readiness-docs` | `completed` | — | `docs/space/execution/completed/2026-08-01-agent-production-platform-exclusions.md` | `2026-07-31` |
| 1B.3 | `github:@ferqx` | `3ada4246b149444ce27ed713cd5425090367c1fc` | `codex/agent-production-readiness-docs` | `completed` | — | `docs/space/execution/completed/2026-08-01-agent-production-platform-exclusions.md` | `2026-07-31` |
| 1B.4 | `github:@ferqx` | `3ada4246b149444ce27ed713cd5425090367c1fc` | `codex/agent-production-readiness-docs` | `completed` | — | `docs/space/execution/completed/2026-08-01-agent-production-network-boundary.md` | `2026-07-31` |
| 1B.5 | `github:@ferqx` | `c9e0dccdaad4cc6a6db57b54d80e0074e3bf8aa4` | `codex/agent-production-readiness-docs` | `completed` | — | `docs/space/execution/completed/2026-08-01-agent-production-protected-path.md` | `2026-08-01` |
| 1B.6 | `github:@ferqx` | `dc64d25d67c9e40330676668b5f039872d04269a` | `main` | `completed` | — | `docs/space/execution/completed/2026-08-02-agent-production-phase-1b.md` | `2026-08-02` |
| 1B.7 | `github:@ferqx` | `dc64d25d67c9e40330676668b5f039872d04269a` | `main` | `completed` | — | `docs/space/execution/completed/2026-08-02-agent-production-phase-1b.md` | `2026-08-02` |
| 1B.8 | `github:@ferqx` | `dc64d25d67c9e40330676668b5f039872d04269a` | `main` | `completed` | — | `docs/space/execution/completed/2026-08-02-agent-production-phase-1b.md` | `2026-08-02` |
| 1B.9 | `github:@ferqx` | `dc64d25d67c9e40330676668b5f039872d04269a` | `main` | `completed` | — | `docs/space/execution/completed/2026-08-02-agent-production-phase-1b.md` | `2026-08-02` |
| 1C.1 | `github:@ferqx` | `4be8735b29ec0fe3951bf7a0876f7b5e722c846a` | `codex/agent-production-readiness-docs` | `completed` | — | `docs/space/execution/completed/2026-07-30-agent-production-runtime-resilience.md` | `2026-07-30` |
| 1C.2 | `github:@ferqx` | `4b8eec058df0af545675fc0e1c4135ee855848fd` | `codex/agent-production-readiness-docs` | `completed` | — | `docs/space/execution/completed/2026-07-30-agent-production-runtime-resilience.md` | `2026-07-30` |
| 1C.4 | `github:@ferqx` | `4b8eec058df0af545675fc0e1c4135ee855848fd` | `codex/agent-production-readiness-docs` | `completed` | — | `docs/space/execution/completed/2026-07-30-agent-production-runtime-resilience.md` | `2026-07-30` |
| 1C.3 | `github:@ferqx` | `1e21055eb8b2579d710eb566728294f2ad8b2621` | `codex/agent-production-readiness-docs` | `completed` | — | `docs/space/execution/completed/2026-07-30-agent-production-runtime-resilience.md` | `2026-07-30` |
| 1C.5 | `github:@ferqx` | `4a64837855b76c8c71e956b19d04ad67d77b18c9` | `codex/agent-production-readiness-docs` | `completed` | — | `docs/space/execution/completed/2026-07-30-agent-production-runtime-resilience.md` | `2026-08-01` |
| 1C.6 | `github:@ferqx` | `2e1a2721b1c7e3c17a483a3d33bcd503a6a777ee` | `codex/agent-production-readiness-docs` | `completed` | — | `docs/space/execution/completed/2026-07-30-agent-production-runtime-resilience.md` | `2026-07-31` |
| 1C.7 | `github:@ferqx` | `dfd8f209f89b4980b9c3905d3e73c166b33bea2b` | `codex/agent-production-readiness-docs` | `completed` | — | `docs/space/execution/completed/2026-07-30-agent-production-runtime-resilience.md` | `2026-08-01` |
| 1C.8 | `github:@ferqx` | `e23b81b1087a7cdea5f4d9c5d419f5d040b67702` | `codex/agent-production-readiness-docs` | `completed` | — | `docs/space/execution/completed/2026-07-30-agent-production-runtime-resilience.md` | `2026-08-02` |
| 2A.0 | `github:@ferqx` | `d07d6d01f822e7afa95f1c98bd90f8780c6ca1d0` | `codex/agent-production-readiness-docs` | `completed` | — | `docs/space/execution/completed/2026-07-30-agent-production-release-control.md` | `2026-08-02` |
| 2A.1 | `github:@ferqx` | `d07d6d01f822e7afa95f1c98bd90f8780c6ca1d0` | `codex/agent-production-readiness-docs` | `completed` | — | `docs/space/execution/completed/2026-07-30-agent-production-release-control.md` | `2026-08-02` |
| 2A.2 | `github:@ferqx` | `d07d6d01f822e7afa95f1c98bd90f8780c6ca1d0` | `codex/agent-production-readiness-docs` | `completed` | — | `docs/space/execution/completed/2026-07-30-agent-production-release-control.md` | `2026-08-02` |
| 2A.3 | `github:@ferqx` | `d07d6d01f822e7afa95f1c98bd90f8780c6ca1d0` | `codex/agent-production-readiness-docs` | `completed` | — | `docs/space/execution/completed/2026-07-30-agent-production-release-control.md` | `2026-08-02` |
| 2A.4 | `github:@ferqx` | `d07d6d01f822e7afa95f1c98bd90f8780c6ca1d0` | `codex/agent-production-readiness-docs` | `completed` | — | `docs/space/execution/completed/2026-07-30-agent-production-release-control.md` | `2026-08-02` |
| 2A.5 | `github:@ferqx` | `d07d6d01f822e7afa95f1c98bd90f8780c6ca1d0` | `codex/agent-production-readiness-docs` | `completed` | — | `docs/space/execution/completed/2026-07-30-agent-production-release-control.md` | `2026-08-02` |
| 2A.6 | `github:@ferqx` | `d07d6d01f822e7afa95f1c98bd90f8780c6ca1d0` | `codex/agent-production-readiness-docs` | `completed` | — | `docs/space/execution/completed/2026-07-30-agent-production-release-control.md` | `2026-08-02` |
| 2A.7 | `github:@ferqx` | `d07d6d01f822e7afa95f1c98bd90f8780c6ca1d0` | `codex/agent-production-readiness-docs` | `completed` | — | `docs/space/execution/completed/2026-07-30-agent-production-release-control.md` | `2026-08-02` |
| 2A.8 | `github:@ferqx` | `2e98681c800a2f1f745bc18e41ac682d9c09e84b` | `codex/agent-production-readiness-docs` | `in_progress` | 本地 supply-chain/platform verifier 已绑定 immutable input snapshot、OS-protected pinned toolchain、canonical USTAR、archive/native launcher、macOS 完整 app bundle seal/notarization、manifest、五 subject attestation、平台发布者身份与 G5 真人签名 evidence；等待真实 build/audit、签名/notarization、provenance/attestation、actual artifact smoke 与三平台 run，D-04 空集合只阻止 effectful execution | — | `2026-08-02` |
| 2A.9 | `github:@ferqx` | `f38d819226aeceaa549e2466c35ed26fe642a6c9` | `codex/production-admission` | `in_progress` | D-03/D-06/D-13 与 2A.7 已满足；本地 disable-only loader/cache 和 release-owned canary admission 已 fail closed，但真实 rollout signing/service、authenticated artifact authority、exporter 与 observation 均缺失 | — | `2026-08-02` |
| 2B.1 | `github:@ferqx` | `dc64d25d67c9e40330676668b5f039872d04269a` | `main` | `completed` | — | `docs/space/execution/completed/2026-08-02-agent-production-evaluation-foundation.md` | `2026-08-02` |
| 2B.2 | `github:@ferqx` | `dc64d25d67c9e40330676668b5f039872d04269a` | `main` | `completed` | — | `docs/space/execution/completed/2026-08-02-agent-production-evaluation-foundation.md` | `2026-08-02` |
| 2B.3 | `github:@ferqx` | `dc64d25d67c9e40330676668b5f039872d04269a` | `main` | `completed` | — | `docs/space/execution/completed/2026-08-02-agent-production-evaluation-foundation.md` | `2026-08-02` |
| 2B.4 | `github:@ferqx` | `dc64d25d67c9e40330676668b5f039872d04269a` | `main` | `in_progress` | 本地完整 12 case × 8/20（96/240）retained receipts 已重建 D-07 success/G0/p95 与共享 artifact/frozen baseline identity；production Sigstore/route registry 为空，等待 authenticated live route 与真实 ledger | — | `2026-08-02` |
| 2B.5 | `github:@ferqx` | `dc64d25d67c9e40330676668b5f039872d04269a` | `main` | `in_progress` | 本地 adversarial catalog/concurrency 与精确有序 21-case same source/candidate contract 已通过；等待同一 artifact/route 的真实 authenticated formal G0 adversarial run evidence | — | `2026-08-02` |
| 2B.8 | `github:@ferqx` | `dc64d25d67c9e40330676668b5f039872d04269a` | `main` | `completed` | — | `docs/space/execution/completed/2026-08-02-agent-production-evaluation-foundation.md` | `2026-08-02` |
| 4.1 | `github:@ferqx` | `dc64d25d67c9e40330676668b5f039872d04269a` | `main` | `completed` | — | `docs/space/execution/completed/2026-08-02-agent-production-compaction-foundation.md` | `2026-08-02` |
| 4.2 | `github:@ferqx` | `dc64d25d67c9e40330676668b5f039872d04269a` | `main` | `completed` | — | `docs/space/execution/completed/2026-08-02-agent-production-compaction-foundation.md` | `2026-08-02` |
| 4.3 | `github:@ferqx` | `dc64d25d67c9e40330676668b5f039872d04269a` | `main` | `completed` | — | `docs/space/execution/completed/2026-08-02-agent-production-compaction-foundation.md` | `2026-08-02` |
| 4.4 | `github:@ferqx` | `dc64d25d67c9e40330676668b5f039872d04269a` | `main` | `in_progress` | 本地 opaque blind item/candidate commitment/receipt/aggregate/identity verifier 已通过，输入绑定 GITHUB_SHA tracked blob snapshot，且受信 deterministic safety 不可被 semantic 覆盖；authenticated scoring authority、production evaluator attestation 与真实分数缺失时保持 blocked | — | `2026-08-02` |
| 4.6 | `github:@ferqx` | `dc64d25d67c9e40330676668b5f039872d04269a` | `main` | `completed` | — | `docs/space/execution/completed/2026-08-02-agent-production-compaction-foundation.md` | `2026-08-02` |
| 4.8 | `github:@ferqx` | `dc64d25d67c9e40330676668b5f039872d04269a` | `main` | `completed` | — | `docs/space/execution/completed/2026-08-02-agent-production-compaction-foundation.md` | `2026-08-02` |
| 5.1 | `github:@ferqx` | `dc64d25d67c9e40330676668b5f039872d04269a` | `main` | `completed` | — | `docs/space/execution/completed/2026-08-02-agent-production-capability-foundation.md` | `2026-08-02` |
| 5.2 | `github:@ferqx` | `dc64d25d67c9e40330676668b5f039872d04269a` | `main` | `completed` | — | `docs/space/execution/completed/2026-08-02-agent-production-capability-foundation.md` | `2026-08-02` |
| 5A.1 | `github:@ferqx` | `dc64d25d67c9e40330676668b5f039872d04269a` | `main` | `completed` | — | `docs/space/execution/completed/2026-08-02-agent-production-capability-foundation.md` | `2026-08-02` |
| 5A.2 | `github:@ferqx` | `dc64d25d67c9e40330676668b5f039872d04269a` | `main` | `completed` | — | `docs/space/execution/completed/2026-08-02-agent-production-capability-foundation.md` | `2026-08-02` |
| 5C.1 | `github:@ferqx` | `dc64d25d67c9e40330676668b5f039872d04269a` | `main` | `completed` | — | `docs/space/execution/completed/2026-08-02-agent-production-capability-foundation.md` | `2026-08-02` |
| 5C.2 | `github:@ferqx` | `dc64d25d67c9e40330676668b5f039872d04269a` | `main` | `completed` | — | `docs/space/execution/completed/2026-08-02-agent-production-capability-foundation.md` | `2026-08-02` |
| 5.4 | `github:@ferqx` | `dc64d25d67c9e40330676668b5f039872d04269a` | `main` | `completed` | — | `docs/space/execution/completed/2026-08-02-agent-production-capability-foundation.md` | `2026-08-02` |

除已完成的 1A.1–1A.7、1B.0–1B.9、1C.1–1C.8、2A.0–2A.7、2B.1–2B.3、2B.8、
4.1–4.3、4.6、4.8、5.1、5.2、5A.1、5A.2、5C.1、5C.2、5.4 与已绑定 `in_progress` 的
2A.8、2A.9、2B.4、2B.5、4.4 外，
其他非 Phase 0 Task 尚未创建 execution binding。

## Revision history

| Revision | Date | Change | Evidence |
| --- | --- | --- | --- |
| 1 | 2026-07-30 | 建立 14 项决策、Owner/backup、严格默认值和首批 Phase 0 binding | RFC §16/§24、当前 Git identity 与基线增量复核 |
| 2 | 2026-07-30 | 采用 single-maintainer 治理；D-13 关闭，external 前增加第三方安全评审硬门禁 | 用户直接决策、ADR-0060 |
| 3 | 2026-07-30 | 按批准包关闭 D-02/D-08/D-09/D-11/D-12/D-14，并接受 ADR-0051–0059 | 用户直接批准的 Phase 0 决策包 |
| 4 | 2026-07-30 | Task 0.5 产生 `MS:M0`；完成 Phase 0 并激活 1A.1/1C.1 binding | [Phase 0 完成记录](../execution/completed/2026-07-30-agent-production-governance.md)、`4be8735b29ec0fe3951bf7a0876f7b5e722c846a` |
| 5 | 2026-07-30 | 完成 1A.1/1C.1；激活 1A.5/1C.2/1C.4 | `4b8eec058df0af545675fc0e1c4135ee855848fd`、默认测试 2005 pass/6 skip、定向测试 17 pass |
| 6 | 2026-07-30 | 完成 1A.5/1C.2/1C.4；激活 1A.2/1C.3 | `1e21055eb8b2579d710eb566728294f2ad8b2621`、默认测试 2018 pass/6 skip、定向测试 20 pass |
| 7 | 2026-07-30 | 完成 1A.2/1C.3；加固 1A.5/1C.2；激活 1A.3/1C.6 | `d0bd571e6a937aac55850bcc09df6f41bf95ac99`、默认测试 2059 pass/6 skip、独立复核定向测试 125 pass/0 fail |
| 8 | 2026-07-31 | 完成 1A.3/1C.6；激活 1A.4/1B.0 | `2e1a2721b1c7e3c17a483a3d33bcd503a6a777ee`、默认测试 2067 pass/6 skip、冻结快照连续两次 PTY 36/36、独立复核定向测试 333 pass/0 fail |
| 9 | 2026-07-31 | 1A.4 secure storage/retention 与 1B.0 bounded probe 本地收敛；保持 in progress 等待原生 evidence | 默认测试 2103 pass/6 skip、独立复核无本地 P0/P1、本机 ACL smoke 通过、本机 platform outcome=`excluded` 且 `productionSupported=false` |
| 10 | 2026-07-31 | 完成 1A.4/1B.0；接受 ADR-0061，以空支持集关闭 D-04；激活 1B.1 | ACL run 30580337754、platform run 30579701659、独立复核无剩余 P0/P1；三平台 ACL verified，三平台 capability 均 `excluded`/`productionSupported=false` |
| 11 | 2026-07-31 | 完成 1B.1 fail-closed execution boundary；激活 1B.2/1B.3/1B.4 | `3ada4246b149444ce27ed713cd5425090367c1fc`、[完成记录](../execution/completed/2026-07-31-agent-production-execution-boundary.md)、独立复核最终 GO 且无剩余 P0/P1/P2 |
| 12 | 2026-08-01 | 完成 1B.4 fail-closed network boundary；激活 1A.6 remote MCP egress | `bc03f77a3dac2962cd3158d3413f292b8388a0d8`、[完成记录](../execution/completed/2026-08-01-agent-production-network-boundary.md)、独立复核最终 GO 且无剩余 P0/P1/P2 |
| 13 | 2026-08-01 | 完成 1A.6 remote MCP 独立内容外发门禁；激活 1A.7 文档与迁移收敛 | `545161a7103365038989c6a935a216c5bd5fc7e8`、[完成记录](../execution/completed/2026-07-30-agent-production-local-data-privacy.md)、独立复核第五轮最终 GO 且无剩余 P0/P1/P2 |
| 14 | 2026-08-01 | 完成 1A.7 文档与迁移总收敛；唯一产生 `MS:1A-DONE` | `389a0cc45c36e59d961c659ab4df4015a722f7de`、[Required run 30670346726](https://github.com/ferqx/kite-code/actions/runs/30670346726)、[完成记录](../execution/completed/2026-07-30-agent-production-local-data-privacy.md)、独立复核最终 GO 且无 P0/P1/P2 |
| 15 | 2026-08-01 | 以 Phase 1A 收口后的全绿基线激活 1C.5 failure-mode conformance | `4a64837855b76c8c71e956b19d04ad67d77b18c9`、[Required run 30671609567](https://github.com/ferqx/kite-code/actions/runs/30671609567) 五个 job 全部通过；同 head 三个原生 workflow 全部通过 |
| 16 | 2026-08-01 | 完成 1C.5 failure-mode conformance 并激活 1C.7 soak/fault evidence；保持 1C.8 pending，不产生 `MS:1C-DONE` | `aa66e872f3206df9718493adbfef7445fb582a4f`、qualification/1C.7 baseline `dfd8f209f89b4980b9c3905d3e73c166b33bea2b`、[Required run 30676359548](https://github.com/ferqx/kite-code/actions/runs/30676359548) 五个 job 全部通过、同 head 三个原生 workflow 全部通过、独立复核 GO 且 P0/P1/P2 均为 0 |
| 17 | 2026-08-01 | 以三平台明确排除负向完成 1B.2/1B.3，并激活 1B.5；保持 D-04 空支持集且不产生 `MS:1B-DONE` | `c9e0dccdaad4cc6a6db57b54d80e0074e3bf8aa4`、[Platform Capability Probe run 30693651821](https://github.com/ferqx/kite-code/actions/runs/30693651821)、[Required run 30693651834](https://github.com/ferqx/kite-code/actions/runs/30693651834) 六个 job 全部通过、[完成记录](../execution/completed/2026-08-01-agent-production-platform-exclusions.md)、两路独立复核最终 GO 且无剩余 P0/P1/P2 |
| 18 | 2026-08-01 | 完成 1B.5 shared protected-path policy；1B.6/1B.8 变为 ready 但保持未绑定；D-04 空支持集不变且不产生 `MS:1B-DONE` | `138fee19d7ce9f9622f1e32ea1d7cfdd2076bf8c`、`512e2c3582bdd2bea2e7f670213f7616f545084c`、qualification head `e6e0ffb51115c3380a1dcc340dd1627b3bdd0970`、[Required run 30705493952](https://github.com/ferqx/kite-code/actions/runs/30705493952) 六个 job 全部通过、[Platform Capability Probe run 30705493919](https://github.com/ferqx/kite-code/actions/runs/30705493919) 三平台全绿、[完成记录](../execution/completed/2026-08-01-agent-production-protected-path.md)、两路独立复核最终 GO 且无剩余 P0/P1/P2 |
| 19 | 2026-08-02 | 完成 1C.7 正式 Ubuntu qualification 与 1C.8 文档/迁移收口；唯一产生 `MS:1C-DONE`，不生成 production artifact | qualification head `e23b81b1087a7cdea5f4d9c5d419f5d040b67702`、[run 30710906064](https://github.com/ferqx/kite-code/actions/runs/30710906064) attempt 1、artifact `runtime-resilience-qualification-30710906064`（ID `8822010140`）、canonical digest `sha256:5b6146bd7fe0aff44595791c83307aa09fb15e40a09ca2fcdef7f8c7e3b34694`、7 case/56 probe/72 actual Runtime ledger receipts、独立 verifier 通过、[完成记录](../execution/completed/2026-07-30-agent-production-runtime-resilience.md) |
| 20 | 2026-08-02 | 激活 1B.6–1B.8 并完成本地实现/定向验证；按统一 Review 策略保持 `in_progress`，不产生 `MS:1B-DONE` | baseline `e23b81b1087a7cdea5f4d9c5d419f5d040b67702`；worktree controller 14 pass、MCP/边界组合 84 pass、status/config/CLI 22 pass、TUI sandbox-mode 2 pass；D-09 foreground Headless CLI writer 保持只读，local stdio 与无 App receipt controller 的 production TUI 保持关闭 |
| 21 | 2026-08-02 | 用户批准 D-06：开源发布采用 GitHub OIDC/keyless Sigstore、artifact attestation 与 GitHub Releases；private 阶段仅 synthetic，正式 signing/release disabled | 用户直接批准、ADR-0062；canonical repository `ferqx/kite-code` / ID `R_kgDOSKbi8g`；D-04 空支持集与 ADR-0060 第三方安全评审门禁保持不变 |
| 22 | 2026-08-02 | 激活 2A.0–2A.7 与 1B.9；本地 Release Contract Foundation、synthetic Gate replay 和 negative artifact conformance 收敛，等待恢复点/最终整体 Review/default-branch artifact 的各自 ratchet | baseline `d07d6d01f822e7afa95f1c98bd90f8780c6ca1d0`；release tests 53 pass、boundary/adversarial 90 pass、TUI `/release` 3 pass；foundation decision `approved_foundation` 仅 G0/G1，G2–G5=`not_applicable`；D-04 空支持集、真实 signing disabled、`MS:1B-DONE`/正式 `MS:2A-F` 均未产生 |
| 23 | 2026-08-02 | 完成 2A.0–2A.7 Release Contract Foundation；Task 2A.7 唯一产生 `MS:2A-F`，解锁 2B/3 本地实施 | `2e98681c800a2f1f745bc18e41ac682d9c09e84b`、[完成记录](../execution/completed/2026-07-30-agent-production-release-control.md)；53 release tests、synthetic build/verify/bootstrap、foundation Gate replay 全绿；G2–G5 N/A、真实 signing/release disabled、D-04 空支持集与第三方安全评审硬门禁不变 |
| 24 | 2026-08-02 | 完成本批 2A.8/2A.9、2B.1–2B.9、3.1–3.8/3.10 本地 fail-closed contract；仅依赖就绪的 2A.8 绑定 `in_progress`，不产生后续 milestone | supply-chain 12 pass、rollout 16 pass、Agent evaluation 34 pass、observability/operations 71 pass、TUI `/telemetry` 4 pass；D-03/D-07 open、`MS:1B-DONE` 缺失、D-04 空支持集；formal platform/adversarial/human/incident/SLO/signing evidence 均未伪造 |
| 25 | 2026-08-02 | 关闭 D-10 并锁定 unknown/effect/dependency drift 的保守分类；完成 Phase 4/5/6 本地 fail-closed contract，只有 dependency-ready 的 5.1 绑定 `in_progress` | ADR-0064；compaction 41 pass、Phase 5 profile/Verification 27 pass、MCP write/Skills 38 pass、GA/auto/compatibility 9 pass；所有 profile/route/cohort 保持 off/empty/0，formal task/live/canary/maturity/GA/第三方评审 evidence 均未产生 |
| 26 | 2026-08-02 | 用户批准并关闭 D-07 的 single-maintainer-first 产品评估范围；激活 2B.1，external/live evidence 保持等待 | 12-case 精确分层、非确定性 PR=禁止/route-change=8/RC=20、确定性=1、G0/false-completion=0、aggregate≥90%/per-case≥80%；维护者 dogfood 仅 internal，external 至少 3 人×4 tasks，第三方安全评审边界不变 |
| 27 | 2026-08-02 | 首轮整体 Review 为 NO-GO（A: P1=5；B: P1=4/P2=2），进入统一安全修复且不提升 Task/milestone | 第三方评审 Gate、production/internal admission、Limited SLO、D-07、GA/Auto、worktree handoff/Git 环境、immutable workflow Actions 均改为 fail-closed；最终复核追加发现的 common-dir attributes/filter、pre-status clean filter、replacement/graft identity 与 provisioning recovery 旁路已通过 pre-worktree-command 检查、no-checkout blob materialization、最小 Git 环境、显式拒绝和 active-only recovery 关闭；所有 shape-valid synthetic/contract fixture 继续 evidenceEligible=false，等待两路最终 GO |
| 28 | 2026-08-02 | 两路最终整体 Review 均为 GO（P0/P1/P2=`0/0/0`）；完成 1B.6–1B.9，Task 1B.9 唯一产生 `MS:1B-DONE` | [PR #21](https://github.com/ferqx/kite-code/pull/21) 合并 head `dc64d25d67c9e40330676668b5f039872d04269a`；默认分支 [run 30739946155](https://github.com/ferqx/kite-code/actions/runs/30739946155) attempt 1 三个平台 job 全绿，artifact ID `8830927216`/`8830930305`/`8830937470`；3 个 excluded target、8 个 excluded_not_admitted case、canonical/report digest 与 actual synthetic bundle 经独立 verifier 重建一致；D-04 保持空支持集、productionSupported=false、distributable=false、真实 signing 和第三方安全评审仍未发生；[完成记录](../execution/completed/2026-08-02-agent-production-phase-1b.md) |
| 29 | 2026-08-02 | 依赖解锁后批量完成 2B/4/5 的本地 foundation；仅把真实 evidence 缺口保留为 `in_progress`，不产生新 release/maturity milestone | 2B.1–2B.3/2B.8 completed，2B.4/2B.5 等待 authenticated live/attempt/adversarial evidence，[63-test 评估基础记录](../execution/completed/2026-08-02-agent-production-evaluation-foundation.md)；4.1–4.3/4.6/4.8 completed，4.4 等待 authenticated semantic evaluator，[36-test Compaction Foundation 记录](../execution/completed/2026-08-02-agent-production-compaction-foundation.md)；5.1/5.2/5A.1/5A.2/5C.1/5C.2/5.4 completed，[29-test Capability Foundation 记录](../execution/completed/2026-08-02-agent-production-capability-foundation.md)；所有 route/profile/cohort 仍 off/empty/0，`MS:2B-DONE`/`MS:4-INTERNAL-AUTO-FRESH`/所有 `MS:5*-STABLE` 均未产生 |
| 30 | 2026-08-02 | 加固 2B.4/2B.5、3.10、4.4 的本地 retained evidence 与独立重建边界；修复整体 Review 的全部 P1/P2，保持 Task 状态和 milestone 不变 | Agent/Observability/Compaction 155 pass；2B 精确 96/240 receipts+D-07 Gate+21 adversarial、Limited SLO shared artifact/exactly-one terminal/time/splice、Compaction opaque blind item/candidate/deterministic precedence/repository cross-binding 均 fail closed；两路最终 agent Review GO、P0/P1/P2=`0/0/0`，不替代真人第三方评审；production OIDC/Sigstore/attestation trust/route 为空，未伪造真实 run 或 evidence |
| 31 | 2026-08-02 | 关闭 D-03；追加 D-04.1 跨平台发行/能力准入正交澄清与 D-14.1 DeepSeek blocked candidate；撤回未提交的 Ubuntu self-hosted 常规发行要求 | 用户直接决策；ADR-0065；GitHub-hosted 三平台 probe contract；external canary 60-test 定向批次中的 consent/admission contract；DeepSeek candidate policy 保持 productionContentAllowed=false、approved route bundle 为空 |
| 32 | 2026-08-02 | 绑定 2A.9 `in_progress`；把三平台 distribution identity 与空 execution support registry 独立建模；加固 platform artifact、telemetry、DeepSeek candidate 与 external canary authority；补齐 2A.8/2B.4–2B.5/4.4 的本地正式 producer/verifier 骨架 | baseline `f38d819226aeceaa549e2466c35ed26fe642a6c9`；定向 platform/release/telemetry/provider/evaluation tests 与 typecheck；新增 workflow 均 manual/no-publish 或不可达，unsigned/unconfigured 结果固定 blocked；所有 production capability 仍 off、production assembly/signing/route/exporter 仍 disabled，不产生 milestone 或真实 evidence |
| 33 | 2026-08-02 | 修复整体 Review 的 telemetry、supply-chain 与输入身份 P1/P2，不提升 Task 或 milestone | reporter release-owned alias/cardinality 与 audit no-op；2A.8 isolated verifier VM/protected verifier commit、immutable input snapshot、OS-protected pinned toolchain、canonical USTAR、archive launcher、macOS 完整 app bundle、manifest、G5 独立真人签名、timeout、macOS/Windows signer identity；platform workflow/ref exact binding；4.4 tracked Git blob snapshot；DeepSeek purpose-specific official origin；production authority 与所有真实 evidence 继续 disabled/waiting |
| 34 | 2026-08-02 | 追加 D-14.3：single owner 接受官方 DeepSeek 精确 Route 的中国处理/存储、可能训练、无固定 retention 与无 DPA；不把这些政策事实作为阻塞 | ADR-0066；approved policy 仅绑定 `deepseek-v4-flash` + `api.deepseek.com[/v1]`，透明披露与 secret denial 保留；2B.4 仍等待真实 credential/live retained evidence，Task/milestone 不提升 |
| 35 | 2026-08-02 | 预构建 Phase 4/5 的 production-owned retained evidence、Compaction rollout/shadow 与统一 capability maturity Gate；不提前绑定下游 Task | 61-test 定向批次；所有 authority registry 为空、manual/auto compaction 与四条 Phase 5 profile 均 `under_development/off`，完整 fixture 仍 blocked/evidenceEligible=false；Task 状态和 milestone 不变 |
| 36 | 2026-08-02 | 修复本批整体 Review 的 secret inspection、maturity 认证、rollout 时间/consent/dependency 绑定与旧 adapter 回归；完成一次 DeepSeek V4 真实 compaction compatibility smoke，不提升 Task 或 milestone | Provider admission 复用 Runtime inspector 且 unknown fail closed；maturity authentication verifier/authority/previous decision/human approval 四门独立关闭；rollout 绑定三项 dependency digest、严格 stage window 与不可伪造 consent authority；DeepSeek direct/incremental smoke 通过但不具备正式 artifact/ledger/attestation，2B.4/2B.5/4.4 与所有 rollout/maturity milestone 保持等待 |
| 37 | 2026-08-03 | 在 Runtime qualification harness 加固后重新认证 Phase 1C 当前代码；替换当前证据指针，不重复产生 `MS:1C-DONE` | hardening `05312896bb689b1da9d9c0861cddd32e50ce0bf0`、qualification head `7def7b15b998d0f5d4eb141bec78506f6ed21df6`、[run 30816605986](https://github.com/ferqx/kite-code/actions/runs/30816605986) attempt 1、artifact `runtime-resilience-qualification-30816605986`（ID `8857539694`）、ZIP digest `sha256:15f1cd93022aa8619313dc711ba7f79d5ea00b5e584d618411b747fbef694380`、canonical digest `sha256:cd1b96bbc40ce1f94300835a7c817c667562b927ed5537cdb1914aa7397fba6b`、7 case/56 probe/72 actual Runtime ledger receipts、零 orphan/residual、独立 verifier 通过；先前失败 artifact 仅作诊断 |
