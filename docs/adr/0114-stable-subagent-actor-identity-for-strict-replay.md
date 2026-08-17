# ADR-0114：Strict Replay 的稳定 Subagent Child Actor Identity

状态：accepted

日期：2026-08-18

决策者：github:@ferqx

相关：ADR-0102、ADR-0103、ADR-0104、ADR-0109、ADR-0110、ADR-0111、ADR-0112、
`docs/space/plans/2026-08-16-trustworthy-runtime-convergence.md`

## 背景

Subagent 的模型 attempt 需要在 live、record 和 fresh strict replay 之间保留同一 actor
lineage，才能让 `ModelAttemptOutcomeV1` 的 actor-local cursor、continuation 和严格 catalog
digest 继续匹配。Capability invocation identity、task/continuation 的 private Artifact ref
以及 installation integrity key 都属于一次 Runtime 安装或一次 capability dispatch 的私有域；
record 与 replay 使用不同的 private Artifact root/key 时，这些值必然可以不同。

若把 capability invocation 或 Artifact 身份用于 child actor ID，跨 installation replay 会把
同一个 parent model attempt 编译成不同的 child actor，随后在 catalog lookup 时发生 strict miss。
反过来，若为了稳定 actor 而放宽 grant 的 capability binding，则会失去 ack、attempt、
capability authority 与 Provider dispatch 的边界。两种身份必须分离。

## 决策

1. `SubagentGrantAuthorityV1` 生成 child actor ID 时，只接受以下四个、与 task 正文和安装私有
   状态无关的 canonical 输入：稳定的 parent Model invocation identity
   (`parentModelInvocationId`)、parent task tool call ID、outer Task/capability attempt
   (`parentAttempt`) 与 subagent role。该 `parentAttempt` 来自
   `deps.subagentInvocationIdentity.attempt`，与 sealed grant 绑定的 capability attempt 是同一
   exact 值。实现使用 domain-separated canonical digest；该派生不读取
   task 内容、task digest、capability invocation ID、Capability Artifact ref、Artifact integrity
   key、transport handle、随机 installation state 或模型凭据。
2. Task Tool 必须从 Gateway 注入的 `modelInvocationParentId` 与
   `modelInvocationParentToolCallId` 调用该派生 authority；不得以
   `subagentInvocationIdentity.invocationId` 替代 parent Model invocation identity。相同四元组
   必须得到相同 actor ID；不同的 parent task tool call、outer Task/capability attempt 或 role 必须得到不同的
   actor lineage。actor ID 只用于稳定 lineage，不是 capability authorization。
3. Start/resume grant 仍然密封并精确绑定 capability `parentInvocationId`、capability attempt、
   parent tool call、capability revision、admission/effect digests、task/continuation Artifact
   ref 与对应的 model replay authority。grant 的 verify/consume、attempt ack、Provider prepare、
   handle activation 和 child Gateway dispatch 继续以这些 exact capability identity 为准；child
   actor ID 的跨 installation 稳定性不得削弱任何 grant admission 或 single-use 约束。
4. 已持久化的 suspended continuation 直接复用其 snapshot 中既有的 child actor ID 与
   continuation identity。resume 可以拥有新的 capability invocation 与 resume attempt，但不得
   因新的 capability identity、Artifact ref 或 installation key 重新生成 child actor；旧 identity
   的缺失、篡改或与 sealed continuation 不匹配必须在 Provider、reviewer、Gateway 或 child tool
   I/O 前 fail closed。
5. 该决策不改变 Runtime state schema v24、`kite-runtime-2026-08-15` format epoch、既有
   subagent Artifact schema 或 `ModelAttemptOutcomeV1` schema。它只明确既有 actor 字段的派生
   authority；唯一可切换 Runtime format epoch 的 CUT-01 仍不变。
6. 任何派生输入缺失、grant/attempt/Artifact binding 不匹配、strict catalog miss 或
   `assertConsumed()` 失败都必须保持 zero dispatch/fail closed。不得回退到 capability-ID-derived
   actor、旧 runner、Fake Provider、live Model Source 或其他运行时 fallback。

## 备选方案

- 将 capability invocation ID、Capability Artifact ref 或 installation integrity key 纳入
  child actor ID：拒绝。它们是 keyed/private dispatch 身份，会随 record/replay 安装变化，并使
  同一 actor lineage 产生不可解释的 strict catalog miss。
- 使用随机、进程或 installation-local child ID：拒绝。它不能重放 actor-local cursor，也不能
  证明 sibling/continuation 的确定性。
- 以 task 正文或 task Artifact digest 派生 child actor：拒绝。正文既不是模型 invocation 的稳定
  identity，也会把隐私内容和可变任务数据带入 replay actor identity。
- 为保持 actor 稳定而删除或放宽 capability invocation/attempt grant binding：拒绝。actor
  identity 不是授权来源；这会绕过 ack-before-dispatch、single-use grant 与 capability admission。
- resume 时按新的 capability grant 重新生成 child actor：拒绝。它会断开已保存 suspended
  continuation 的 lineage，并允许同一 blocked child 产生第二个 actor。

## 后果

- record 与 fresh replay 可以使用不同的 worktree 外 installation-private Model Artifact root
  与 integrity key，同时复用同一 parent Model invocation identity，匹配同一 child actor 和
  `ModelAttemptOutcomeV1` actor cursor；private task/continuation/handle Artifact 仍必须由各自
  installation key 严格读取，不能跨域复制或冒充。
- capability invocation identity 与 actor identity 明确分成两条不替代的证明链：前者证明这次
  dispatch 获得了当前 Runtime 的 exact grant，后者证明模型 replay 的 actor lineage。任一链路
  失败都不能通过另一条链路补救。
- 同一 parent Model invocation、task tool call、outer Task/capability attempt、role 的重复 issuance 继续
  表示同一 actor；并发 sibling 必须使用不同的稳定 parent task tool call 或其他已定义 lineage
  输入。缺少稳定 parent Model invocation identity 时，调用不得进入 Provider 或 Model Gateway。

## 回滚

CUT-01 前可以撤销尚未合并的 PS-03 迁移，但必须整体撤销该迁移并保持唯一 runtime boundary；不得
同时保留 capability-ID-derived 与 model-ID-derived 两条生产路径，也不得用旧 identity 作为运行时
fallback。已保存 continuation 的读取仍按其 sealed identity 处理；任何兼容迁移需要新的 ADR、
schema/epoch 评估和严格 replay 证据。
