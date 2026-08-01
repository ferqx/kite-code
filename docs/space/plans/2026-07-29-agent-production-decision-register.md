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
| Platform Owner | `github:@ferqx` | `none (single-maintainer)` | platform matrix、sandbox evidence 和 PR review | native 支持矩阵尚未关闭 |
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

- status: `open`
- owner: `github:@ferqx`（Security & Privacy + Release）
- backup: `none (single-maintainer)`
- dueMilestone: `MS:3-OPS-READY`
- blockingPhase: `Phase 3`
- default: remote telemetry=`off`；没有预注册且可观测的 SLO 数据时 external canary 保持 blocked
- decision: 尚未决定 external canary 是否强制匿名结构化 telemetry
- evidence: [Phase 3 计划](2026-07-29-agent-production-observability-operations.md)；
  [ADR-0056](../../adr/0056-metadata-first-data-boundaries.md)
- approvedAt: `null`

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

- status: `open`
- owner: `github:@ferqx`（Release + Security & Privacy）
- backup: `none (single-maintainer)`
- dueMilestone: `MS:2A-F`
- blockingPhase: `Phase 2A`
- default: 未验证 signature/provenance/托管 identity 时不分发 artifact；rollout signing 不阻塞首个
  limited，但未实现时 rollout 服务保持 disabled
- decision: artifact/evidence 的具体签名、provenance 与托管后端待定
- evidence: [Phase 2A 计划](2026-07-29-agent-production-release-control.md)；
  [ADR-0052](../../adr/0052-release-evidence-and-behavior-identity.md)；
  [ADR-0059](../../adr/0059-optional-disable-only-signed-rollout.md)
- approvedAt: `null`

### D-07

- status: `open`
- owner: `github:@ferqx`（Evaluation/Product + Release）
- backup: `none (single-maintainer)`
- dueMilestone: `MS:2A-F`
- blockingPhase: `Phase 2B`
- default: 未预注册人群、任务、重复次数和阈值时所有产品 Gate 为 unknown/blocked
- decision: benchmark 人群、任务集、重复次数与成功阈值待 baseline
- evidence: [Phase 2B 计划](2026-07-29-agent-production-evaluation.md)；
  [ADR-0058](../../adr/0058-agent-task-product-acceptance.md)
- approvedAt: `null`

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

- status: `open`
- owner: `github:@ferqx`（Capability + Security & Privacy）
- backup: `none (single-maintainer)`
- dueMilestone: `MS:LIMITED-SLO`
- blockingPhase: `Phase 5`
- default: `skills_readonly` 和 `skills_effectful` 均为 `off`；未知 effect/provenance 一律归
  effectful 且不得执行
- decision: 精确 effects/provenance classifier 待 Phase 5 conformance
- evidence: [Phase 5 计划](2026-07-29-agent-production-capability-rollout.md)
- approvedAt: `null`

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
| 1B.6 | `github:@ferqx` | `e23b81b1087a7cdea5f4d9c5d419f5d040b67702` | `codex/agent-production-readiness-docs` | `in_progress` | 最终整体 Review 与恢复点 commit 待后续本地方案共同收敛 | — | `2026-08-02` |
| 1B.7 | `github:@ferqx` | `e23b81b1087a7cdea5f4d9c5d419f5d040b67702` | `codex/agent-production-readiness-docs` | `in_progress` | 最终整体 Review 与恢复点 commit 待后续本地方案共同收敛 | — | `2026-08-02` |
| 1B.8 | `github:@ferqx` | `e23b81b1087a7cdea5f4d9c5d419f5d040b67702` | `codex/agent-production-readiness-docs` | `in_progress` | 最终整体 Review 与恢复点 commit 待后续本地方案共同收敛 | — | `2026-08-02` |
| 1C.1 | `github:@ferqx` | `4be8735b29ec0fe3951bf7a0876f7b5e722c846a` | `codex/agent-production-readiness-docs` | `completed` | — | `docs/space/execution/completed/2026-07-30-agent-production-runtime-resilience.md` | `2026-07-30` |
| 1C.2 | `github:@ferqx` | `4b8eec058df0af545675fc0e1c4135ee855848fd` | `codex/agent-production-readiness-docs` | `completed` | — | `docs/space/execution/completed/2026-07-30-agent-production-runtime-resilience.md` | `2026-07-30` |
| 1C.4 | `github:@ferqx` | `4b8eec058df0af545675fc0e1c4135ee855848fd` | `codex/agent-production-readiness-docs` | `completed` | — | `docs/space/execution/completed/2026-07-30-agent-production-runtime-resilience.md` | `2026-07-30` |
| 1C.3 | `github:@ferqx` | `1e21055eb8b2579d710eb566728294f2ad8b2621` | `codex/agent-production-readiness-docs` | `completed` | — | `docs/space/execution/completed/2026-07-30-agent-production-runtime-resilience.md` | `2026-07-30` |
| 1C.5 | `github:@ferqx` | `4a64837855b76c8c71e956b19d04ad67d77b18c9` | `codex/agent-production-readiness-docs` | `completed` | — | `docs/space/execution/completed/2026-07-30-agent-production-runtime-resilience.md` | `2026-08-01` |
| 1C.6 | `github:@ferqx` | `2e1a2721b1c7e3c17a483a3d33bcd503a6a777ee` | `codex/agent-production-readiness-docs` | `completed` | — | `docs/space/execution/completed/2026-07-30-agent-production-runtime-resilience.md` | `2026-07-31` |
| 1C.7 | `github:@ferqx` | `dfd8f209f89b4980b9c3905d3e73c166b33bea2b` | `codex/agent-production-readiness-docs` | `completed` | — | `docs/space/execution/completed/2026-07-30-agent-production-runtime-resilience.md` | `2026-08-01` |
| 1C.8 | `github:@ferqx` | `e23b81b1087a7cdea5f4d9c5d419f5d040b67702` | `codex/agent-production-readiness-docs` | `completed` | — | `docs/space/execution/completed/2026-07-30-agent-production-runtime-resilience.md` | `2026-08-02` |

除已完成的 1A.1–1A.7、1B.0–1B.5、1C.1–1C.8 与已绑定 `in_progress` 的 1B.6–1B.8 外，
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
