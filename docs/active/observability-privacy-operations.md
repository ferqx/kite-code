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

生产 metric 由版本化 allowlist 构造，只接受有限 metric/attribute 枚举和有限数值；单样本 canonical
JSON 上限 1024 bytes。prompt、正文、路径、命令、自由错误、secret 和任意 user/project identity 都不在
schema 中。route/capability 使用受控 alias，超出 cardinality budget 合并到固定 overflow alias。

Reporter 使用有界内存 queue，无磁盘 spool；满时丢弃最旧低优先级样本并记录本地 drop。export、flush、
shutdown 或序列化失败不传播到 Runtime。consent 撤回立即清空 queue 并停止新样本。mandatory enterprise
audit 与普通 telemetry 分离；mandatory audit 不可用时受管 session 拒绝。

CLI `--telemetry-status` 与 TUI `/telemetry` 只显示 artifact/flag/consent/endpoint policy/exporter 的
脱敏状态，不显示 endpoint secret。普通开发入口固定显示 `artifact_disabled`。

## 运营与证据边界

Dashboard 覆盖 run/model/tool/MCP/Skill/Plan/Verification/compaction/Runtime/resource/artifact/task
指标；无数据固定 `blocked`，不能显示绿色。当前 SLO 是 `baseline_unconfigured`，最小样本、观察窗口、
error budget 和非 G0 阈值均为 `null`，因此不会产生 SLO pass。

Alert Owner 为 `github:@ferqx`，backup 为 `none (single-maintainer)`。控制动作只能关闭 capability、
cohort 归零或回滚完整 artifact identity，并保留 metadata evidence；没有 remote automatic kill switch。
Owner 不可联系时 cohort=0 且恢复批准 blocked。external release 前仍需要不同真人、绑定 candidate 的第三方
安全评审。

本地 incident rehearsal 固定为 `synthetic_contract_only`，其 G4 adapter 为 `not_run`，不能代替真实
detection/containment/credential rotation 演练。Limited SLO qualifier 现已具备 retained evidence
独立重建 contract：digest-chained admissions 与 terminal receipts 必须逐项一一对应，orphan、duplicate、
drop、重排或篡改全部 fail closed；sample count、denominator、G0/G1、error-budget burn 和所有 rate 都从
terminal receipts 重建，不信任汇总自报值。

Verifier 绑定 `MS:LIM-APPROVED` policy、完整 `ReleaseArtifactIdentityV1`、route/cohort、canonical
repository 与 repository ID、head/ref、workflow path/ref/SHA、run/attempt、job/artifact、GitHub OIDC
issuer 和 attestation subject。Outer observation、retained ledger 与 expected identity 必须逐字段一致，
report/verifier digest 不能跨 candidate 拼接；admission 与 terminal 两条 ledger 的时间分别非递减。
当前 production producer/attestation trust registry 仍硬编码为空，也没有真实 observation window，因而
所有本地 fixture 固定 blocked、`evidenceEligible=false`、`milestone=null`。只有真实 retained ledger、
approved policy 和独立认证 verifier 共同通过后，才允许产生 `MS:LIMITED-SLO`。
