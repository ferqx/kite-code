# 无正文 Observability、Consent 与运营边界

状态：active
读取时机：修改 production metrics、telemetry consent/export、dashboard/SLO、alert、kill switch、
incident runbook 或运营 Gate 时。
验证：`bun test tests/observability`、`bun run scripts/operations/rehearse-agent-incident.ts`、
`bun run typecheck`、`bun run check:core-boundary`。
相关：ADR-0056、ADR-0060、ADR-0063、D-03、Phase 3。

## 数据与启用边界

`observabilityMetricsV1=false`，普通 CLI/TUI 入口也没有 artifact telemetry authority。启用远程 exporter
必须同时满足 release artifact 允许、release-controlled flag、用户 consent 和真实 exporter 四项；任一
缺失都注入 no-op reporter。project 配置只能关闭，不能开启、提供 endpoint secret 或代替用户 consent；
admin 可以强制关闭。canary 还要求独立 opt-in。

D-03 已关闭：`composeExternalCanaryObservabilityV1()` 固定 consent 的 `releaseChannel=canary`，且
只从 active production release composition 读取 canary channel、单一 canary capability rollout 与
artifact telemetry ceiling；调用者布尔值不能签发 authority。它再检查用户 telemetry consent、独立
canary opt-in 与真实 exporter。任一缺失都
返回 blocked cohort 和 no-op reporter；mandatory audit 不可用时也必须拒绝 cohort，普通项目配置不能
开启或代替 consent。该 contract 不代表
当前已有 exporter、真实 cohort 或 SLO 数据。

生产 metric 在创建和 reporter/export 边界都会由严格 schema 重建，拒绝未知 top-level 字段与伪造
definition；consent category 通过穷举 category-to-metric registry 变成 exporter allowlist，未授权类别
即使构造成功也会丢弃。版本化 allowlist 只接受有限 metric/attribute 枚举和有限数值；单样本 canonical
JSON 上限 1024 bytes。prompt、正文、路径、命令、自由错误、secret 和任意 user/project identity 都不在
schema 中。reporter 最终出口只保留 release-owned route/capability alias，未知值折叠为
`custom/unknown`；每个 metric 按完整 attribute series 实际执行 `cardinalityLimit`，达到预算后的新 series
直接丢弃并计入本地 drop，而不是仅依赖 producer 自律。

Reporter 使用有界内存 queue，无磁盘 spool；满时丢弃最旧低优先级样本并记录本地 drop。export、flush、
shutdown 或序列化失败不传播到 Runtime。consent 撤回立即清空 queue 并停止新样本。mandatory enterprise
audit 与普通 telemetry 分离；`managedSessionAdmission=denied` 直接使 composition 注入 no-op reporter，
mandatory audit 不可用时不能出现“cohort blocked 但 exporter 仍启用”的分裂状态。

真实 exporter 的代码边界已经落地，但没有默认网络 authority：它只接受 release 批准的 endpoint alias
和由应用组合根注入的 `GovernedMetricTransportV1`，发送 canonical、bounded、metadata-only envelope；
不能自行调用全局 `fetch`、读取任意 URL 或绕过受治理 transport。CLI/TUI 当前只把实际经过其公共事件
入口的结构化 Runtime event 送入同一 bounded reporter；bridge 对 execution receipt、model 与 resource
metadata 的 mapper 仅有 contract test，尚未接入生产 caller。mapper/exporter 异常不改变 Runtime outcome，
CLI 退出执行有界 shutdown；TUI 的 `/exit`、双 Ctrl+C、SIGINT、SIGTERM 与 fatal ErrorBoundary 共用幂等 exit coordinator，
在 unmount/process exit 前等待两个各最多 250ms 的 flush/exporter-shutdown 阶段（整体最多约 500ms），
manager replacement 也会 dispose。
当前开发 composition 没有
artifact authority 与 transport，因而该链路实际仍是 no-op。

CLI `--telemetry-status` 与 TUI `/telemetry` 只显示 artifact/flag/consent/endpoint policy/exporter 的
脱敏状态，不显示 endpoint secret。普通开发入口固定显示 `artifact_disabled`。

## 运营与证据边界

Dashboard 覆盖 run/model/tool/MCP/Skill/Plan/Verification/compaction/Runtime/resource/artifact/task
指标；无数据固定 `blocked`，不能显示绿色。当前 SLO 是 `baseline_unconfigured`，最小样本、观察窗口、
error budget 和非 G0 阈值均为 `null`，因此不会产生 SLO pass。

Baseline control plane 已有 production-shaped retained ledger、producer 和 independent verifier：它绑定
Release artifact、route、Provider policy、预注册 baseline policy 与完整 GitHub workflow/run/job/artifact/
OIDC/attestation source identity，并从 digest-chained metadata receipts 重建七项产品指标及 G0/G1。无样本
或无 denominator 的指标保持 `unknown`；aggregate、receipt、source、route 或 policy splice 均拒绝。
source-owned lookup 只匹配预先外部验证并精确登记的 source identity/subject/attestation receipt 与实际
ledger/rebuild/report digest；它不是 Sigstore 密码学 verifier，registry 为空，所以当前报告仍 blocked，不能
把该 contract 改写为已冻结的真实 baseline。

Alert Owner 为 `github:@ferqx`，backup 为 `none (single-maintainer)`。控制动作只能关闭 capability、
cohort 归零或回滚完整 artifact identity，并保留 metadata evidence；没有 remote automatic kill switch。
Owner 不可联系时 cohort=0 且恢复批准 blocked。external release 使用 ADR-0067 的 candidate-bound
single-maintainer security review；第三方评审为可选增强，不再是 cohort 或 milestone 的硬依赖。

本地 incident rehearsal 固定为 `synthetic_contract_only`，其 G4 adapter 为 `not_run`，不能代替真实
detection/containment/credential rotation 演练。Limited SLO qualifier 现已具备 retained evidence
独立重建 contract：digest-chained admissions 与 terminal receipts 必须逐项一一对应，orphan、duplicate、
drop、重排或篡改全部 fail closed；sample count、denominator、G0/G1、error-budget burn 和所有 rate 都从
terminal receipts 重建，不信任汇总自报值。

Verifier 绑定 `MS:LIM-APPROVED` policy、完整 `ReleaseArtifactIdentityV1`、route/cohort、canonical
repository 与 repository ID、head/ref、workflow path/ref/SHA、run/attempt、job/artifact、GitHub OIDC
issuer 和 attestation subject。Outer observation、retained ledger 与 expected identity 必须逐字段一致，
report/verifier digest 不能跨 candidate 拼接；admission 与 terminal 两条 ledger 的时间分别非递减。
production schema 的 exact verified-statement 同时绑定 source、ledger、rebuild 与 report digest；密码学
verifier 未实现且源码 registry 仍为空，
也没有真实 observation window，因而所有当前 fixture 固定 blocked、`evidenceEligible=false`、
`milestone=null`。只有真实 retained ledger、approved policy、候选/Workflow identity、全部阈值和独立认证
verifier 共同通过后，Gate 才会以 production evidence 唯一产生 `MS:LIMITED-SLO`。

事故演练另有 production-shaped retained ledger：它绑定 GitHub source、artifact、route/cohort，并要求
八个预注册 scenario 的有序 digest chain、action receipt、零正文与 fresh terminal state。缺失、重排、
source splice、failed action 或 stale state 均失败；production rehearsal authority registry 当前为空，
所以该 ledger 只补齐本地 producer/verifier contract，不替代真实 incident 演练或 G4 evidence。
