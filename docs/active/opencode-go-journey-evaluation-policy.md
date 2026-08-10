# OpenCode Go Journey 评测政策

状态：active
读取时机：修改 ACORE Journey fixture、scorer、live Provider runner、候选提交或运行正式 Prompt Contract A/B 时。
验证：`bun test tests/evals/runtime-journey-baseline.test.ts tests/evals/tool-journey-v1.test.ts tests/evals/first-decision-eval.test.ts tests/evals/prompt-contract-ab.test.ts`、`bun run check:docs`、`bun run check:docs-impact`。
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

## ACORE-EVAL-01 本地证据边界

`ToolJourneyEvalV1` 当前固定十条 deterministic case ID：`search_read`、`read_edit_verify`、`invalid_args_correct_once`、`enoent_locate_success`、`rg_no_match_stop`、`approval_policy_rejection_no_retry`、`safe_pre_dispatch_transient`、`timeout_unknown_no_replay`、`sandbox_permission_no_escalation`、`repeated_failure_replan_finalize`。scripted model 只能生成 `model.responded`、`tool.queued` 和 verification request；terminal、approval/policy decision、durable retry、tool execution、CompletionGuard block 与 atomic abort/error batch 必须由 production Controller/executor/Kernel 生成，测试会拒绝直接伪造 terminal/retry/rejection/run.error。

`safe_pre_dispatch_transient` 在真实 MCP readiness 边界、任何 capability dispatch 之前记录首次 `provider_unavailable`，其 canonical authority 固定为 `not_started/none/pre_dispatch`；只有 RuntimeStore durable `tool.retry_recorded` ack 后才执行第二次 readiness attempt 与唯一一次 capability dispatch，并同时报告失败 authority/timing/resolution 与成功 `recoveryOf`。`sandbox_permission_no_escalation` 经过 production `createSandboxExecutor(... unavailableFallback=fail)` 与 `shell_execute` 边界，固定产生 `sandbox_error/sandbox_denied`；同一个 factory 注入可触发、调用即写 synthetic marker 的受控 bare-shell sentinel，case 必须观测一次 sandbox boundary、零 sentinel/底层命令调用、零 authorization-widening Runtime event 和零 replay。不可观测的“权限提升尝试数”不得硬编码进报告，也不得用 approval rejection 或 phase rejection 冒充。`repeated_failure_replan_finalize` 在同 lineage 完成两次真实 read/search failure 后，通过 production `write_plan` structural replan、plan review、`update_plan` finalize 收敛，两个历史 failure 只能由显式 `replanned` resolution 消除。`timeout_unknown_no_replay` 保留 V2 CompletionGuard 两次 stable block 与同批 `turn.aborted + run.error` 证据。

报告只对外保留 case ID、真实 Runtime/boundary/provider dispatch 计数、sandbox sentinel 是否触发、authorization-widening event 计数、typed terminal/correction/retry 计数，以及 canonical outcome 的 status、FailureKind/detail、dispatch/effect/replay safety/recovery、`recoveryAttempt=0|1`、lineage 是否存在、稳定 resolution 和可信 timing source；不得保留 lineage ID。本地 report validator 对 report/case/outcome/block 执行递归 exact-key allowlist，FailureKind、detail、resolution 与 CompletionGuard code 复用 production 闭集，全部计数必须是有限非负整数；闭集字段必须先验证 `typeof string`，数组、对象或自定义 `toString` 不能通过，允许键的值也不能夹带 path/prompt/stdout。`metadataOnly` 必须由该 schema 校验结果产生，不能硬编码通过。每条 Journey 使用 synthetic workspace 与独立临时 `HOME`/`KITE_CODE_HOME`，在最外层 `try/finally` 恢复进程环境并清理目录；环境恢复测试调用 uncached suite seam，不能以已完成的缓存 Promise 自证。每条 Kernel 同样保证关闭，关闭计数也是报告结构的一部分。

报告 schema、case 集合、scorer 或 privacy 字段发生变化时，必须按本政策的 revision 规则处理；不得输出 prompt/response、args、path、command、stdout/stderr、内部 identity/fingerprint/recoveryOf。该 deterministic suite 证明本地 Runtime 回归，不创建 live 候选、HTTP dispatch、usage、Provider response ID 或 Go usage 证据。
