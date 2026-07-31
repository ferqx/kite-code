# Failure classification

状态：active
读取时机：新增工具或模型失败路径、调整重试/升级策略、修改运行时错误日志时。
验证：`bun test tests/runtime/failures.test.ts tests/runtime/failure-taxonomy.test.ts tests/runtime/failure-mode-conformance.test.ts tests/runtime/agent-deadline.test.ts tests/runtime/resource-budget-admission.test.ts tests/runtime/schema-v17-migration.test.ts`。

Runtime failures use `ClassifiedFailure` from `src/core/runtime/failures.ts`. Its `kind` gives policy a stable semantic category, while retryability, model-fixability, intervention, turn termination, and journal flags centralize handling choices. Model argument parsing, tool execution/policy decisions, approval rejection, and auto-review rejection all retain the classification on their tool call record.

`ClassifiedFailure` also carries an optional `parseFailureCode` (from `ParseFailureCode` in `src/core/tools/registry/registry.ts`), propagated through `InvalidToolRequest` when the Registry rejects a tool call. This preserves the structured origin (`unknown_tool` | `tool_unavailable` | `invalid_arguments`) for diagnostic observability without introducing new `FailureKind` values.

New `tool.failed` producers must emit `failure: classifyFailure(...)`. The legacy `error` field remains accepted only so existing persisted v3 events can replay; reducers and trace logging prefer the structured value.

Choose the narrowest kind. Add a kind only when it has a distinct recovery policy, test its strategy, and update this document.

Runtime schema v19 adds `RunTerminalOutcomeV1`. New `run.completed` and `run.error` events are
normalized before persistence and retain a stable reason code, known/unknown external-effects
state, safe-retry decision, recovery entry, and pending-verification bit. TUI and headless
consumers use `projectTerminalOutcomeV1`; they do not infer terminal meaning from localized error
strings.

Runtime schema v20 preserves that terminal contract and adds durable per-hop network admission facts.
Network denial metadata uses stable boundary codes such as `network_off`,
`host_not_allowlisted`, `private_or_reserved_address`, `endpoint_revision_mismatch`, and
`controller_unavailable`; clients do not infer these outcomes from transport error strings.

Runtime schema v21 additionally persists remote MCP content-egress decisions. Missing/expired/mismatched
or replayed permits are `policy_denied`; inability to persist the decision before dispatch is
`persistence_unavailable`. Stable receipt reasons include `feature_disabled`, `permit_missing`,
`permit_invalid`, `argument_digest_mismatch`, `endpoint_revision_mismatch`,
`tool_revision_mismatch`, `permit_ttl_exceeded`, `permit_expired`, `secret_detected`,
`content_inspection_unknown` and `permit_replayed`; clients do not parse the error message to recover these
facts. A Store nonce uniqueness conflict is not reported as generic persistence loss: Runtime first persists
the redacted `permit_replayed` denial. Other receipt-write failures remain `persistence_unavailable`.

The production reason-code set distinguishes artifact/profile/digest invalid, workspace
untrusted, sandbox/network/worktree unavailable, model retry exhausted, Provider/MCP unavailable,
persistence unavailable, budget exhausted, resource saturation, tool/shell concurrency
saturation, process limit exceeded, cancel incomplete, compaction unqualified/failed,
verification failed/inconclusive, mandatory policy unavailable, blocked, and unknown.
`completed` is the only projection with `complete=true`; `unknown` requires reconciliation and is
never safe to retry automatically.

`resolveFailureModeV1()` 是 RFC failure-mode matrix 的规范 Core policy table。封闭的 mode 集合覆盖
production artifact/Workspace/execution boundary、model/MCP、persistence、budget/concurrency/
process cleanup、compaction/Verification、可选诊断与 rollout。每次解析都显式返回 continue/block/
degrade、新的自动 effectful invocation 数、durable state、external-effects 状态、稳定 reason、
用户文案、safe retry、recovery entry、pending verification 和允许的最窄 fallback。resource
admission 与 run deadline 的生产终态 producer 直接消费该解析结果；conformance suite 将所有
terminal resolution 通过 Core snapshot recovery、Headless CLI 和 TUI 的同一
`RunTerminalOutcomeV1` 投影复测。其他 capability producer 只有在显式接入该 table 或增加等价
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

`terminalOutcomeV1=false` 只关闭 CLI 派生的 `terminalPresentation`；Runtime 仍规范化和持久化
outcome，因此 rollback 客户端仍可直接读取 status/reasonCode，不能把 unknown 当 completed。
