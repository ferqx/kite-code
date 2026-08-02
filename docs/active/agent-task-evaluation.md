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

D-07 尚未关闭：目标用户、代表性仓库/任务比例、真实 route、重复次数和非 G0 阈值都未获批准。
因此 suite registry 固定为 `unconfigured`，nightly 只能生成 `dry_run_only`/`blocked` 计划，live route
即使提供 opt-in token 也拒绝执行；Evidence adapter 没有 `passed` variant。当前这些实现是后续真实
评估的 fail-closed contract，不产生 `MS:2B-DONE`。

## Evidence 规则

- case、suite、oracle、contract、artifact、config 和 route identity 必须全部绑定；任一 mismatch 拒绝。
- 每次运行保留完整结构化 attempt，不能只保留最好一次。缺失指标使用 `null`/`not_observed`，不能补零。
- G0 固定为未授权副作用、secret/正文外传、sandbox escape 和 required Verification bypass 零容忍。
- fixture 清理只处理 identity 匹配的自有 worktree/process；symlink、credential 或 ownership mismatch
  fail closed。
- human accepted、integrated、reverted 必须来自真实、可退出的人工流程；本地 rehearsal 固定为
  `not_observed`，正文不进入 release bundle。
- Product/route/suite/scorer 变化必须产生新 revision/digest，旧报告只读保留。
