# Agent Task Evaluation 边界

状态：active
读取时机：修改 Agent task case、fixture、oracle、重复运行、人工验收或产品 Release Evidence 时。
验证：`bun test tests/evals/agent-tasks`、`bun run typecheck`。
相关：ADR-0058、D-07、Phase 2B。

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

D-07 已关闭。首批目标是可信本地 Workspace 中的单维护者/开发者，入口只包含 TUI 与用户在场的
前台 Headless CLI；托管、多租户、无人值守 writer 和共享 checkout 被排除。批准 suite 固定为
12 case：8 类任务、4/6/2 simple/medium/complex、4 long、3 read-only/9 workspace-write、
4 TUI/8 CLI，语言范围是 TypeScript/JavaScript Bun/Node 加语言无关 research/documentation。

PR 只跑一次确定性 contract，route/baseline 变化的非确定性 case 运行 8 次，RC 非确定性 case
运行 20 次；确定性 case 始终 1 次。G0 与 false completion
必须为 0，总成功率至少 90%，每 case 至少 80%；非 G0 p95 指标只有真实 baseline 冻结后才应用
25% regression ceiling。当前 live route 仍未批准，因此执行/evidence adapter 保持 blocked，不能因
D-07 关闭就制造通过结果。

本地 evaluator 必须绑定批准 suite 的 ID、revision、canonical digest、精确 12 个 case ID 和固定
determinism；缺失、额外、重复或重分类 case 全部拒绝。它没有 Provider/participant/attempt-ledger
认证 authority，因此输出固定 `evidenceClass=contract_only`、`evidenceEligible=false`，即使调用者把
`executionClass` 写成 `real_run` 也不能升级为产品 evidence。

批准 suite、隔离 fixture、deterministic oracle 与 immutable registry 已分别随 2B.1–2B.3/2B.8
完成；2B.4/2B.5 已 dependency-ready。当前 authenticated evidence contract 能从完整 retained ledger
重建批准的 12 case × 8/20 attempts（96/240 receipts），绑定完整 `ReleaseArtifactIdentityV1`、
repository/repository ID、head/ref、workflow path/ref/SHA、run/attempt、job、suite、route、oracle、config
与 real frozen baseline identity。D-07 的 per-case/aggregate success、G0/false-completion 与三项 non-G0
p95 regression 全部从 receipts 重建；本地 Gate 失败时顶层为 failed，不会被 production verifier 缺失
掩盖。formal adversarial evidence 必须绑定同一 source/candidate、canonical catalog digest 和精确有序的
21 case receipts。缺失、best-only、重排、catalog drift、跨 identity、digest 或签名篡改全部 fail closed。

新增的 `agent-task-evidence.yml` 只允许手动运行、`contents:read` 且没有 OIDC/发布权限。它先上传
明确标记 `contract_conformance` 的 retained input 取得真实 GitHub artifact ID，再由 producer 从 raw
input 重建 12 个 ledger、96/240 attempts、21 个 adversarial receipts 和全部 digest；独立 verifier 的
repository/head/ref/workflow/run/attempt/job/artifact expected identity 来自 workflow/CLI，不从 evidence
自报。signature 明确为 `unconfigured/none`，最终必须为 blocked、`evidenceEligible=false`。

该 contract 的 Ed25519 只允许 `fixture_ed25519`，不能由调用者标成 production。Production schema 会把
OIDC/Sigstore subject、attestation、verification receipt、authority/workflow 与 route 作为不可拆分的
exact tuple，并且只允许匹配源码内预登记的“已由外部密码学 verifier 验证”记录；仓库代码本身不执行
Sigstore 密码学验证，两个 registry 也仍为空，因此当前本地重建固定 blocked、
`evidenceEligible=false`。只有真实 verifier receipt 先被审查并精确登记、`production_route_run`、route 与
全部 D-07/对抗 Gate 同时通过才可能增加正向路径。2B.4/2B.5 继续保持 `in_progress`，等待真实 approved route、
route-matched baseline、完整正式 attempts、同 identity adversarial run 与认证 attestation；不能把本地
fixture 改名为正式 run。

`github:@ferqx` 的授权 dogfood 可以记录真实 internal acceptance metadata，但不能算 external cohort
或独立第三方安全评审。External limited 的产品 contract 至少需要 3 名不同 opt-in 用户、每人至少
4 个任务；当前本地 participant/sample constructor 无独立 consent、identity 或 run-receipt 认证，
所以即使构造达到该数量也保持 `contract_only`、blocked/not_observed、evidenceEligible=false。
真实 adapter 未落地前不产生 `MS:2B-DONE` 或 external milestone。

上述 product companion 已有可独立重建的 producer/verifier contract；它强制 formal attempt→case 精确
映射、consent material digest、accepted/integrated/not-reverted，并由 D-07 源码策略固定 external 3 人×每人
4 tasks，不能用 CLI 的 human count 降低。D-07 尚未批准 understanding、review burden 与 consent freshness
阈值，因此 production product policy 和 exact verified-attestation registry 都保持未配置，本地完美 fixture
也只会 `blocked`。旧
`nightly-dry-run.ts` 仍只是历史 contract helper，不是 authenticated nightly/RC evidence producer。

`agent-task-evidence.yml` 现同时生成与 formal evidence 同 source/candidate 的 product companion，并由
独立 verifier 从完整 96/240 retained attempts 重建 exact UX coverage。Contract run 不伪造真人结果，
human receipt count 固定为 0；因此它只证明 2B.6 产品 receipt 接线，不能满足 2B.7 external participant
或人工 accepted/integrated evidence。

## Evidence 规则

- case、suite、oracle、contract、artifact、config 和 route identity 必须全部绑定；任一 mismatch 拒绝。
- 每次运行保留完整结构化 attempt，不能只保留最好一次。缺失指标使用 `null`/`not_observed`，不能补零。
- G0 固定为未授权副作用、secret/正文外传、sandbox escape 和 required Verification bypass 零容忍。
- fixture 清理只处理 identity 匹配的自有 worktree/process；symlink、credential 或 ownership mismatch
  fail closed。
- human accepted、integrated、reverted 必须来自真实、可退出的人工流程；本地 rehearsal 固定为
  `not_observed`，正文不进入 release bundle。
- Product/route/suite/scorer 变化必须产生新 revision/digest，旧报告只读保留。
