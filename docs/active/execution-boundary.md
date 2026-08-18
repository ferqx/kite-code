# Agent Task Evaluation 边界

状态：active
读取时机：修改 Agent task case、fixture、oracle、批准 suite 或本地任务质量评测时。
验证：`/usr/bin/env -u BUN_OPTIONS -u NODE_OPTIONS bun --no-env-file run eval:replay:required`、
`bun test tests/evals/agent-tasks tests/evals/live-provider-smoke.test.ts tests/evals/runtime-journey-baseline.test.ts tests/model-invocation-gateway.test.ts`、
`bun run test:provider:smoke -- --provider deepseek`、
`bun run test:provider:smoke -- --provider opencode-go`、`bun run typecheck`。
相关：ADR-0058、ADR-0068、ADR-0069、ADR-0095、ADR-0096、ADR-0112、ADR-0115、D-07、Phase 2B、
[`model-replay-evaluation-policy.md`](model-replay-evaluation-policy.md)、`opencode-go-journey-evaluation-policy.md`。

## 当前状态

仓库保留严格的 `AgentTaskCaseV1`、隔离 fixture、确定性 oracle、adversarial contract、Plan/恢复 UX mapper、
immutable suite registry 与批准 suite。它们只使用 synthetic fixture，不访问真实 Provider，不收集用户正文，
用于验证本地任务正确性、安全边界和测试污染控制，不能成为产品 Gate 的通过证据。

当前 2B 范围以 DeepSeek/OpenCode Go 各一次低成本真实调用、确定性核心 correctness、安全与 adversarial case
为准，不要求正式重复运行、external participant 或 product evidence authority。2B.4/2B.5 已按本地范围
完成，2B.7 已被取代。已关闭的 repeated-run、human/dogfood、retained product evidence、authenticated
promotion producer/verifier 和只会产出 blocked artifact 的 workflow 已删除；若未来需要正式产品证据，必须
基于当时的真实 route、authority 和产品目标重新立项，不能恢复旧 fixture 充当证据。

D-07 已关闭。首批目标是可信本地 Workspace 中的单维护者/开发者，入口只包含 TUI 与用户在场的
前台 Headless CLI；托管、多租户、无人值守 writer 和共享 checkout 被排除。批准 suite 固定为
12 case：8 类任务、4/6/2 simple/medium/complex、4 long、3 read-only/9 workspace-write、
4 TUI/8 CLI，语言范围是 TypeScript/JavaScript Bun/Node 加语言无关 research/documentation。

RP-00 只把这 12 case 的精确 suite identity 登记为 replay `candidate`；D-07 的任务定义 approval 不授予
record、cassette 或 Required CI replay authority。当前 `replayGate=disabled`、
`recordAuthorization=denied`、`cassette=absent`、risk coverage 尚未证明。内容域、manifest authority 与
risk-based promotion 以 `model-replay-evaluation-policy.md` 为准。RP-01 已提供严格
`ModelAttemptOutcomeV1` Source/catalog contract 与 keyless replay mechanism；RP-02 已从 TypeScript bug-fix case
建立独立、candidate-only 的 6-record deterministic pilot，覆盖 parent/并发 sibling cursor、workspace effect、
Verification/recovery、canonical equality 与 no-egress/cleanup。该 pilot 不改变本 12-case registry 的
`cassette=absent`。RP-03 另行批准 `model-replay-required-suite-v1@1`：它只取用该 TypeScript pilot
与五条 purpose/attempt/continuation risk contract，再绑定负例、Tool recovery 和 crash/restore/fork
qualification files；不会把 D-07 其余 11 个 case 或整个 12-case registry 提升为 replay gate。
Required CI 每次提交运行 `/usr/bin/env -u BUN_OPTIONS -u NODE_OPTIONS bun --no-env-file run eval:replay:required`，
失败不会回退 live。

PS-03 的 propagation qualification 是独立的 deterministic synthetic contract：封闭的内存 Source 经过真实
Gateway/Tool Pipeline/Local Provider/ChildRuntimeDriver/Artifact 后，由 fresh strict catalog 逐条消费并
`assertConsumed()`；真实 model handle 由 transport observer 包装并机械断言 attempt 为零，qualification 不产出 package。
Required isolated runner 实际执行对应测试，manifest 以 source/test qualification digest 和完整 repository-local
import closure 精确绑定；隔离命令投影 Linux namespace 路径时必须使用 Linux/POSIX 分隔符，而不是运行该纯
projection 的宿主路径分隔符。任何 closure 或 qualification wrapper drift 都必须同一改动重算 manifest digest
及 parser 外 authority anchor；其中也包括 sandbox runtime cleanup 的 canonicalization/idempotence、Windows
executor 对该 exact cleanup routine 的绑定等被
qualification import closure 覆盖的实现变更。它只证明
Provider/actor/replay propagation，不改变 D-07 candidate、RP-03 approved suite 或 production replay authority。

本地 evaluator 必须绑定批准 suite 的 ID、revision、canonical digest、精确 case 集和 determinism；
缺失、额外、重复、重分类、隐藏 oracle 泄漏或 behavior identity drift 全部拒绝。fixture 清理只能处理
identity 匹配的自有 worktree/process，symlink、credential 或 ownership mismatch 必须 fail closed。

## Evidence 规则

OpenCode Go 的 first-decision/Journey live 评测还必须遵守版本化 `ACORE-EVAL-POLICY`；当前冻结规则、候选范围、
十轮样本、Provider usage 与人工 Go usage 核对的无正文边界见
[`opencode-go-journey-evaluation-policy.md`](opencode-go-journey-evaluation-policy.md)。该政策不授权运行真实模型，
也不单独决定 Prompt Contract 默认值；该迁移由 ADR-0098 的真实 A/B、effect probe 与 Runtime journey 共同授权。

`ACORE-EVAL-00-v1` 是在上述 live 政策之前建立的完整 Runtime Journey 基线：它用 synthetic workspace 驱动
Kernel 的 `model → tool → model → run.completed → turn.completed` 闭环，只断言 canonical event 类型与计数，
并固定 `contentLogged=false`。该基线不触发 Provider，也不记录 prompt、工具正文或路径；它仅验证后续 live
证据需要经过的运行时路径仍可达。Journey fixture 中直接进入 current reducer 的 Tool 终态必须携带 canonical `ToolOutcomeV1`；不存在绕过当前 envelope validator 的 historical decoder 测试入口。

TP-03 后，production Controller journey 必须同时提供 Model Gateway 与 private Capability Artifact writer，
并观察每次 adapter 前的 invocation/attempt acknowledgement 以及 capability receipt 与 Tool terminal 原子
闭合。synthetic writer 只返回 metadata-only keyed opaque ref，不把正文、locator 或 invocation identity 写入
eval report；缺少 writer/ack 时用例应零 dispatch 并失败，不能退回旧 adapter。`ACORE-EVAL-01` 的
no-retry、safe-read retry、sandbox denial、timeout unknown 与 recovery lineage 继续由真实 Runtime loop 判定。

真实 Provider smoke、Prompt Contract A/B 与 prompt-cache transition 通过显式
`ModelInvocationEvalSessionV1` 使用 production `ModelInvocationGatewayV1` evidence ordering；脚本不能直接
import AI SDK dispatch 或底层 transport。每次 eval request 同样写 Surface/Response Artifact、在每个 attempt
前 durable ack，并在 completion receipt ack 后才消费 response。eval 临时 Runtime Store 由 session 自有并安全
清理；installation-private Model Artifact 不由 eval teardown 删除，后续只能按 production reachability/GC
契约处理。输出 allowlist 仍禁止正文、artifact
locator、invocation identity、key、endpoint 与 Provider response id。该接线不把 live eval 变成 replay，也不
创建或更新 approved replay catalog/manifest authority；RP-03 的独立 manifest/gate 只消费已批准
evaluation catalog。显式 `eval:replay:record` 是可选、非 qualification/authority 的 live candidate staging 流程；
候选必须通过自动 Surface/outcome schema/privacy/exact-digest/revision gate。

`ACORE-PLAN-03-v1` 在同一 synthetic、无 Provider 边界内增加三条 CompletionGuard V2 Journey：required
Verification 已完成但 Plan 缺少匹配 reference 时稳定返回 `verification_required`；副作用 Tool 已成功但 Plan
尚未投影 execution evidence 时稳定返回 `effect_evidence_required`；Verification、Tool receipt 与 Plan evidence
全部由真实 Runtime event/tool lifecycle 归约后才允许 `run.completed + turn.completed`。三条报告只保存 event
计数、稳定 reason code、纠正次数和严格 Plan identity，继续固定 `contentLogged=false`，并显式断言不包含
prompt、Plan 正文、工具正文、路径、命令或 stdout。

- case、suite、oracle、fixture 与 behavior identity 必须绑定；任一 mismatch 拒绝。
- G0 固定为未授权副作用、secret/正文外传、sandbox escape 和 required Verification bypass 零容忍。
- fixture 清理只处理 identity 匹配的自有 worktree/process；symlink、credential 或 ownership mismatch
  fail closed。
- suite/oracle/scorer 或 fixture 行为变化必须产生新 revision/digest；不得把 synthetic 结果表述为真人、真实模型或正式发布证据。
