# Agent Task Evaluation 边界

状态：active
读取时机：修改 Agent task case、fixture、oracle、重复运行、人工验收或产品 Release Evidence 时。
验证：`bun test tests/evals/agent-tasks tests/evals/live-provider-smoke.test.ts`、
`bun run test:provider:smoke -- --provider deepseek`、
`bun run test:provider:smoke -- --provider opencode-go`、`bun run typecheck`。
相关：ADR-0058、ADR-0068、ADR-0069、ADR-0095、ADR-0096、D-07、Phase 2B、`opencode-go-journey-evaluation-policy.md`。

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

当前 2B 范围以 DeepSeek/OpenCode Go 各一次低成本真实调用、确定性核心 correctness、安全与 adversarial case
为准，不要求正式重复运行、external participant 或 product evidence authority。2B.4/2B.5 已按本地范围
完成，2B.7 已被取代。旧 retained product/evaluator schema 只保留为伪造、缺失、重排和 identity splice
的负向 contract，不构成发布后增强路线或产品 milestone。

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

OpenCode Go 的 first-decision/Journey live 评测还必须遵守版本化 `ACORE-EVAL-POLICY`；当前冻结规则、候选范围、
十轮样本、Provider usage 与人工 Go usage 核对的无正文边界见
[`opencode-go-journey-evaluation-policy.md`](opencode-go-journey-evaluation-policy.md)。该政策不授权运行真实模型，
也不改变 ADR-0094 的 `promptContractV2=false` 默认值。

- case、suite、oracle、contract、artifact、config 和 route identity 必须全部绑定；任一 mismatch 拒绝。
- 每次运行保留完整结构化 attempt，不能只保留最好一次。缺失指标使用 `null`/`not_observed`，不能补零。
- G0 固定为未授权副作用、secret/正文外传、sandbox escape 和 required Verification bypass 零容忍。
- fixture 清理只处理 identity 匹配的自有 worktree/process；symlink、credential 或 ownership mismatch
  fail closed。
- 旧 human 字段在本地固定为 `not_observed`，正文不进入 release bundle；项目不以真人数量作为发布资格。
- Product/route/suite/scorer 变化必须产生新 revision/digest，旧报告只读保留。
