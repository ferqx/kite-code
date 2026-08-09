# OpenCode Go Journey 评测政策

状态：active
读取时机：修改 ACORE Journey fixture、scorer、live Provider runner、候选提交或运行正式 Prompt Contract A/B 时。
验证：`bun run check:docs`、`bun run check:docs-impact`；实现后由 ACORE-EVAL-00/01 的确定性 suite 与 policy self-check 覆盖。
相关：ADR-0093、ADR-0094、ADR-0095、ADR-0096、`real-model-test-boundary.md`、`agent-task-evaluation.md`。

## 冻结的 V1 政策

本政策 revision 是 `ACORE-EVAL-POLICY-01-r1`。其 Prompt Contract first-decision 候选为 commit
`300e11a4`（`fix: close prompt contract provider evidence`）；该候选只用于 V3 Provider 计量与 first-decision
A/B，不能作为 CompletionGuard 或完整 Journey 的候选。任何 fixture、scorer、report schema、route、candidate allowlist
或隐私规则修改都必须创建新 revision，并使该 revision 的正式样本从零开始。

- Provider 固定为 OpenCode Go OpenAI-compatible route 与 `deepseek-v4-flash`；运行时只报告稳定 route alias，严禁输出
  endpoint、credential、请求/响应正文或 Provider response ID。
- 正式 first-decision A/B 是每个 case 十个配对样本、AB/BA 交替、无 early stop；在精确候选 commit 和本政策 revision
  都已固定前不得运行。诊断运行不属于正式样本，也不能和正式样本合并。
- 固定 1024 output-token 上限、60 秒单 attempt timeout、5 个百分点不劣界与配对 95% 双侧区间；结果只能是
  `passed`、`failed` 或 `inconclusive`。`diagnosticSampleMet` 不是默认开启资格，Prompt Contract V2 继续默认关闭。
- 每个 arm 必须精确闭合 expected/started/succeeded model attempts、HTTPS dispatch/response/2xx、usage 覆盖、非零
  input/output/total token、唯一 Provider response ID；任何不相等、transport failure、缺 usage 或重复 ID 均为失败。
- OpenCode Go 订阅 usage 证据包括该次无正文 runner usage 汇总，及维护者在运行前后对 Go usage 页面进行的人工核对。
  仅记录 `goUsageChecked=true`、时间窗口和 policy/candidate identity；不记录账户、余额、账单、截图、ID 或正文。Zen credit
  balance 变化不是通过条件。
- deterministic Journey 使用 synthetic workspace、isolated HOME 和 Kite data root；报告不得含 prompt、response、args、
  path、command、stdout/stderr、stack、Provider body、完整 endpoint 或内部 fingerprint。live Journey 同样只能操作 synthetic
  workspace。

正式的完整 Journey 候选必须在 CompletionGuard、ToolOutcome 与 policy revision 都冻结后另行指定 commit；在此之前不得把
first-decision V3 结果表述为 Runtime Journey 质量或 V2 默认迁移资格。
