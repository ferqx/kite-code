# Failure classification

状态：active
读取时机：新增工具或模型失败路径、调整重试/升级策略、修改运行时错误日志时。
验证：`bun test tests/runtime/failures.test.ts tests/runtime/failure-taxonomy.test.ts tests/runtime/failure-mode-conformance.test.ts tests/runtime/agent-deadline.test.ts tests/runtime/resource-budget-admission.test.ts tests/runtime/tool-outcome-recovery.test.ts tests/execution/workspace-filesystem-provider.test.ts tests/subagent-continuation-codec.test.ts tests/subagent-runner.test.ts`。

Runtime failures use the Agent-Kernel-owned `ClassifiedFailureV1`; App
`apps/kite/src/bootstrap/runtime/failures.ts` is only the State26 type/projection boundary. Its `kind` gives policy a stable semantic category, while retryability, model-fixability, intervention, turn termination, and journal flags centralize handling choices. Model argument parsing, tool execution/policy decisions, approval rejection, and current-epoch auto-review rejection all retain the classification on their tool call record. Current auto-review risk decisions are not failures: they carry `escalatedToUser` and remain non-terminal until the user approves or rejects; technical reviewer failures follow the same approval escalation without inventing a rejection.

CompletionGuard blocker 是结构化控制状态，不是 `ClassifiedFailure`。Runner 不得仅因为模型 final 被
`planning_empty/plan_draft_pending/interaction_pending/...` 拒绝，就用业务文案构造
`classifyFailure('unknown', ...)`；`unknown` 只保留给确实无法分类且需要 reconciliation 的故障边界。已有 review
feedback 的 `plan_draft_pending` 可以持久化 `completion.blocked + turn.completed`，只结束当前 turn 并保留 active
Task/Plan；不得生成 `run.error`、`run.completed` 或 `task.completed`。没有 review feedback 的新 draft 仍有一次
bounded model correction，纠错后继续保留 draft 也不得误报完成。

`ClassifiedFailure` also carries an optional `parseFailureCode` from
`ToolRequestParseFailureCodeV1` in `packages/builtin-runtime/src/tool-request.ts`. The code is emitted by the Builtin catalog
parser and propagated through `InvalidToolRequest` when the App request projection rejects a tool call. This
preserves the structured origin (`invalid_json` | `unknown_tool` | `tool_unavailable` | `invalid_arguments`) and drives
the canonical family mapping: malformed JSON/arguments are `tool_invalid_args`, while unknown/unavailable capabilities
are `tool_not_found`. Controller、Subagent 与 persisted ToolOutcome 必须使用该映射，不能把 `tool_unavailable` 降成
model-fixable argument correction；App projection 不能成为 schema/parser authority，Kernel 只裁决 governance outcome。

Every `tool.failed` producer must emit `failure: classifyFailure(...)`. The optional error text is diagnostic only; reducers, recovery and trace logging use the structured failure.

Workspace filesystem Provider failure 使用封闭 code：grant/expiry/consumption/cancel、Workspace/path、
not-found/type/binary/bound、`read_required`、`stale_read`、edit mismatch、`stale_preimage`、operation 与
Fake fault。它们是 Provider-neutral failure evidence，ToolOutcome 仍由 Runtime canonicalization 生成；
不得解析 message、路径或 preimage 正文推导恢复。prepare/Artifact/ready ack 失败发生在 commit 前，证明
mutation 未 dispatch，不能回退旧 adapter。commit 已跨越 atomic rename 后抛错则为 commit-unknown：
external effect certainty 必须保守为 unknown、recovery=never，并进入 reconciliation，绝不自动重放。
`read_required`/`stale_read` 只允许模型重新读取后提出新 invocation，不授权原调用 retry。

Current Runtime format uses one Agent-Kernel-owned canonical `ToolOutcomeV1` envelope on every current terminal
event. The classifier, validator, recovery advice, timing normalization and failure-lineage derivation live only in
`@kite/agent-kernel`; the App State26 adapter contains no second algorithm. The
envelope closes status, `FailureKind`/detail code, dispatch and external-effect
certainty, recovery ceiling/lineage, Runtime-boundary timing and low-cardinality unknown-field observation.
Policy/approval and dispatch/effect facts are authoritative; Builtin catalog classifiers may only tighten them.
A missing, throwing, conflicting, unknown-code or structurally invalid classifier/outcome becomes
`status=unknown` with `recovery=never`; no code path parses stderr, command output or provider text to
recover classification. Current reducers, TUI, Session Logger and metrics reject a missing/invalid envelope;
all current producers cross the Kernel canonicalization boundary before persistence or publication.
Events without a valid envelope are rejected before reducer consumption; there is no historical decoder fallback.
Builtin classifier advice 的 detail code 即使属于全局闭集，也必须属于当前 `FailureKind` 的 exhaustive
允许集合；跨 kind advice 是 `classifier_conflict + unknown/never`，且当次 canonical envelope 本身
必须通过严格 validator，不能先写入非法 current event 再靠兼容路径降级。
Subagent 暂停期间，父 `task` 的当前状态会从 `running` 转为 `awaiting_approval`，授权后再转为
`approved`；这不能覆盖它已经 dispatch 的历史事实。恢复终态必须依据持久化的 `startedAt`
或 active ownership 归类为 `dispatchState=started`。恢复中已 dispatch 的 child tool 或后续适配器异常
必须将父 `task` 收敛为 `tool.failed + externalEffects=unknown + recovery=never`，不得保留
`approved` continuation 供下一 turn 盲重放。
Envelope restore 使用 exact-key 与语义矩阵校验：replay safety 必须与 dispatch/effect certainty
相容，`success/cancelled/timed_out/exhausted/unknown` 不得携带可重试 recovery，diagnostic、timing
和 unknown-field count 也必须内部一致。未知字段或矛盾组合按损坏历史 fail closed 为
`unknown/never`，不能扩大调用额度。生产 Shell timeout 只读取 Runtime 写入的
`terminationReason=timed_out`，sandbox fail-closed denial 只读取
`terminationReason=sandbox_denied` 并映射为 `sandbox_error/sandbox_denied`；两者都不从 stderr 文本猜测。
同一矩阵还拒绝 `rejected+retry_once`，以及 failure kind/detail、policy/approval authority 与 recovery
disposition 互相矛盾的组合。deny/timeout/cancel/unknown/next-response exhaustion 仍是 blocking fact；
只有成功 lineage receipt 或显式 skip/replan/user/provider resolution 才能成为 recovered evidence。显式 structural replan 是同 task/turn 的权威 resolution：即使 failure 已因 eligible response 消耗而成为 `exhausted/next_response_elapsed`，`plan.replan_requested` 仍必须把该 bounded lineage 收敛为 `recovered/replanned`；普通模型正文或时间流逝不能这样做。
FailureKind→detailCode 使用编译期 exhaustive `Record` 覆盖全部 kind，不存在“缺键即跳过校验”的
兼容分支。`phase_deferred`/`phase_denied` 是 Runtime-authoritative pre-dispatch rejection：envelope
保留对应 phase detail 与一次 next-response correction 语义；只有 policy/approval authority deny 强制
`recovery=never`，不能把当前 phase rejection 降级成 legacy unknown。
Recovery journal 的质量阻断也保留闭集 cause：普通重复失败达到 ceiling 是 `no_progress`，运行时
终态分类为 `loop_exhausted`；缺失、损坏、canonical ID/lineage/counter 不一致是
`journal_invalid`，才分类为 `persistence_unavailable`。Session metadata、metrics 与 TUI 都从同一
`run.error.failure/outcome` 投影，不得把正常质量 ceiling 报成存储故障。
`journal_invalid` 一旦出现即为吸收态，任何 progress、resolution、terminal success 或新 failure 都不能
把它改写成 `no_progress` 或 unblocked；若结构化校验仍能安全保留 task/turn，它们也只记录损坏来源，
scheduler 与 admission 不得按
当前 scope 过滤，因此 task close、新 task 或下一 turn 仍以 `persistence_unavailable` 全局阻断且零 dispatch。
只有显式新 session/受治理恢复边界可以离开该状态。普通 `no_progress` 仍只约束原 task/turn scope。
自动审查还维护一个 60 秒窗口的稳定治理指纹计数：Shell 使用 command/cwd、写工具使用 path，
其他工具使用规范化完整参数。`auto_review.requested` 先由
reducer 持久化 observation，`doomLoopRepeatThreshold` 命中后把低基数 `doomLoopDetected/count`
注入 reviewer 上下文。该信号只能使审查更保守，不能绕过现有 Policy、人工升级或 Recovery
Journal 的硬上限。
普通 `no_progress` 的重复判定按同一 `recoveryOf` root、同一工具、同 task/turn 与 progress revision
计数；同链参数变化继续累计，没有共同 recovery root 的独立同名调用只增加有界 observation，不以跨失败
总数触发 hard block。单次 failure 的真实修正额度仍为一；额度外提案零 dispatch、写入同一 lineage，直到
该链同工具第六次无进展才 hard block，不能第一次 suppression 就提升整轮。模型修正额度必须在下一
eligible response 中唯一绑定到一个具体 `toolCallId`；`alternative` 还必须匹配 Runtime 受控的
`capabilityIntent`，同响应的其他 sibling 保持普通准入。只有显式解析同一 recovery lineage 中 failure ID
的成功 receipt 或 Runtime-owned resolution 才推进 progress revision 并解除该链；无关工具成功不能重置
其无进展计数。restore 从 failure lineage 重新推导 `no_progress` 时必须同时恢复触发链的 task/turn scope，
不能把 scoped ceiling 扩大为全 session 阻断。
Scheduler 必须在最高优先级 correctness hard-block 区域判定该状态，早于 interaction、legacy recovery、
已排队工具、verification、completion 与 compaction；不能等到普通 call-model fallback 前才检查。
State26 Subagent continuation 中的 `executionJournal/exhaustedFingerprints` 是当前 canonical recovery fact，
不再参与准入、重试计数或终态分类；恢复额度只读取 canonical `ToolRecoveryJournalV1`。Subagent
展示用 failure reason 也只能来自 canonical detail code 或结构化 termination reason，不能解析 stdout、
stderr、Provider message 或命令正文生成恢复分类。

应选择范围最窄的 kind。只有当它具备不同的恢复 policy、已有策略测试并同步更新本文档时，才可新增 kind。

当前 Runtime state 的终态使用 `RunTerminalOutcomeV1`。新的 `run.completed` 和 `run.error`
在持久化前规范化，保留稳定 reason code、已知/未知的 external-effects 状态、safe-retry 决定、
recovery entry 与 pending-verification bit。TUI 和 Headless consumer 使用
`projectTerminalOutcomeV1`，不从本地化错误字符串推断终态含义。

每个网络 hop 的 admission fact 都会持久化。网络拒绝元数据使用稳定 boundary code，例如
`network_off`、`host_not_allowlisted`、`private_or_reserved_address`、
`endpoint_revision_mismatch` 和 `controller_unavailable`；client 不从 transport error string
推断这些结果。

远程 MCP content-egress 决定同样持久化。缺失、过期、不匹配或已重放的 permit 为
`policy_denied`；在 dispatch 前无法持久化决定为 `persistence_unavailable`。稳定 receipt reason
包括 `feature_disabled`、`permit_missing`、`permit_invalid`、`argument_digest_mismatch`、
`endpoint_revision_mismatch`、`tool_revision_mismatch`、`permit_ttl_exceeded`、
`permit_expired`、`secret_detected`、`content_inspection_unknown` 和 `permit_replayed`；client
不解析错误消息来恢复这些事实。Store nonce 唯一性冲突不会报告为通用持久化丢失：Runtime 先持久化
脱敏的 `permit_replayed` 拒绝。其他 receipt-write 失败仍为 `persistence_unavailable`。

The production reason-code set distinguishes artifact/profile/digest invalid, workspace
untrusted, sandbox/network/worktree unavailable, model retry exhausted, Provider/MCP unavailable,
persistence unavailable, budget exhausted, resource saturation, tool/shell concurrency
saturation, process limit exceeded, cancel incomplete, compaction unqualified/failed,
verification failed/inconclusive, mandatory policy unavailable, blocked, and unknown.
`completed` is the only projection with `complete=true`; `unknown` requires reconciliation and is
never safe to retry automatically.

`resolveFailureModeV1()` 是 `@kite/agent-kernel` 中 RFC failure-mode matrix 的规范 policy table。封闭的 mode 集合覆盖
production artifact/Workspace/execution boundary、model/MCP、persistence、budget/concurrency/
process cleanup、compaction/Verification、可选诊断与 rollout。每次解析都显式返回 continue/block/
degrade、新的自动 effectful invocation 数、durable state、external-effects 状态、稳定 reason、
用户文案、safe retry、recovery entry、pending verification 和允许的最窄 fallback。resource
admission 与 run deadline 的生产终态 producer 直接消费该解析结果；conformance suite 将所有
terminal resolution 通过 Host State26 snapshot recovery、Headless CLI 和 TUI 的同一
Kernel-owned `RunTerminalOutcomeV1` 投影复测。其他 capability producer 只有在显式接入该 table 或增加等价
entrypoint contract test 后，才能声明相应 production failure-mode coverage；App 入口不得根据
错误字符串另建降级规则。缺少 run 级 external-effect 证据时 terminal resolution 默认为
`unknown`，已有证据必须做保守合并；任何原本会 continue/degrade 的分支在证据为 `unknown` 时
先进入 reconciliation，不能自动发起新 invocation。只有明确发生在
dispatch 前的 artifact/profile/digest/workspace/worktree/admin-policy 校验可固定为 `none`。model
retry 只有在调用方仍有 bounded retry budget 时才允许恰好一个新 invocation；MCP 只关闭受影响
binding，required step 才升级为 block，required revision drift 非自动 retry；optional
logger/telemetry 失败只关闭诊断通道；rollout unavailable 只能使用 embedded profile 或已验证且
未过期的 disable-only cache。sandbox read-only fallback 同时要求 profile 授权与 conformance
通过。required MCP revision 的 external effect 未知时同样进入 reconciliation。shell process
tree 超限仅在 cleanup 有明确正向证据时以
`status=budget_exhausted`/`reasonCode=process_limit_exceeded` 收敛，未确认时必须升级为
`cancel_incomplete`/unknown。

`recovery_blocked` 不能只生成瞬态字符串。Runtime 必须将不兼容/未知恢复映射为结构化
`unknown`，将损坏的持久化恢复映射为 `persistence_unavailable`，持久化 error-caused
`turn.aborted` 与带 outcome 的 `run.error`，并保留 recovery hard block。`cancel_incomplete`
表示 descendant 退出未确认，external effects 固定为 unknown，不能与普通 cancelled 合并。

TUI 的 unrecoverable error boundary 只显示 Enter/Esc 退出，不能对任意异常统一建议运行 `kite-code setup`。
Runtime/Artifact installation key、Project identity store 与对应 key-loss 终态已经删除；升级前的
`project-identities-v1.json` 与 `.runtime-v5.db` header shim 不属于 State26/Store5 target evidence，也不会阻止 target 初始化。

`terminalOutcomeV1=false` 只关闭 CLI 派生的 `terminalPresentation`；Runtime 仍规范化和持久化
outcome，因此 rollback 客户端仍可直接读取 status/reasonCode，不能把 unknown 当 completed。

父 Runtime 与 Subagent descendant 的 budget admission 使用同一个 terminal adapter。child
tool/shell waiter 超时的 typed reason 分别为 `tool_concurrency_saturated` /
`shell_concurrency_saturated`，累计额度不足为 `budget_exhausted`，已有 unknown invocation 为
`reconciliation_required`；这些错误必须穿透 Subagent runner、Task Tool 和 Tool Controller，
最终形成 canonical `run.error + turn.aborted`，不能被转换成普通 Tool Result 或 Subagent summary。
adapter 会合并整个 run 已知的 external-effect facts，因此存在未确认 dispatch 时仍保守投影为
unknown/reconciliation，而不会为了显示 saturation 丢失外部副作用事实。
