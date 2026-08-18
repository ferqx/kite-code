# ADR-0115：PS-03 使用确定性合成记录完成 Replay 传播资格

状态：accepted

日期：2026-08-18

决策者：github:@ferqx

相关：ADR-0109、ADR-0111、ADR-0112、ADR-0114、
`docs/active/model-replay-evaluation-policy.md`、
`docs/space/plans/2026-08-16-trustworthy-runtime-convergence.md`

## 背景

PS-03 的验收目标是证明 `SubagentProviderV1`、`ChildRuntimeDriverV1`、Tool Pipeline 和
ModelInvocationGateway 之间的 attempt、actor、continuation 与 replay binding 能在
`start → blocked → resume` 中保持一致。这个目标不是为真实模型质量建立 baseline，也不是把
Production Model Artifact 提升为版本控制中的 replay cassette。

此前的执行记录把 PS-03 资格误写成必须先取得 live record authority、模型 API credential 和
持久化/人工审查 cassette。源码、测试与本次用户直接指令均未把它们定义为本计划或 Provider seam
传播资格的前置条件；本 ADR 明确删除这一错误解释。

## 与 ADR-0112 的替代关系

本 ADR 不改写 ADR-0112 的历史文本，而是按用户直接指令 supersede 其在本次收敛计划及其完成定义中
适用的三项一般性前置要求：

1. 不需要独立的 live record authority 才能取得 PS-03 或本计划的 synthetic propagation qualification；
2. 不需要 owner-only credential file 才能取得该资格；
3. 不需要人工或“受审查 cassette”才能取得该资格。

仍保留且不可豁免的是：catalog/fixture/oracle 必须通过机器可执行的
privacy/schema/exact-digest/revision 校验；CI 不得自动 record、修改或安装 baseline。可选 record 工具的
fail-closed 本地安全检查仅是 active operational policy，属于该工具自身运行防护，不是 PS-03、RP-03 或
本计划的 authority/qualification，也不产生人工准入要求。

## 决策

1. PS-03 qualification 使用封闭的确定性 synthetic `ModelResponseSourceV1`。该 Source 在内存中产生严格的
   两条 `ModelAttemptOutcomeV1` record；真实 model handle 的 `doGenerate`/`doStream` 由 observer 包装，资格
   必须机械断言 transport attempt 为零。该 Source 不读取任何外部输入，也不写出 qualification catalog package。
2. qualification 随后在新的 Runtime/Artifact 安装中构造 `StrictModelReplayCatalogV1`，通过真实的
   `executeRuntimeTools`、Tool Pipeline、`LocalSubagentProviderV1`、`ChildRuntimeDriverV1`、
   `ModelInvocationGatewayV1` 和 `ModelArtifactStoreV1` 重新执行 start→blocked→resume。replay
   必须逐条消费记录并调用 `assertConsumed()`；任何 miss、乱序、digest/admission mismatch、
   key/ref/canonical readback failure 或 fallback 都 fail closed。
3. record 与 fresh replay 使用不同的 private Artifact root/key，验证 task、continuation、handle、
   Surface、Response 与 capability receipt 的 exact owner/schema/content/invocation binding；稳定
   child actor identity 依照 ADR-0114 派生，不能依赖 installation-private identity。
4. Required replay workflow 必须实际执行 `tests/evals/agent-tasks/replay-subagent-journey.test.ts`。
   replay-gate manifest 的 qualification-file 列表精确绑定该测试及其 journey source；测试通过不能
   修改 approved RP-03 cassette、suite identity 或 production response source。
5. 该资格只证明 PS-03 seam 的 replay propagation、admission-before-lookup、ack ordering、strict
   digest 和 no-fallback contract；不证明真实模型质量、Provider 可用性、production replay authority、
   release/support qualification，也不改变 Runtime schema v24、`kite-runtime-2026-08-15` format
   epoch 或 CUT-01 的唯一切换权。
6. 若未来把新的 catalog、fixture 或 oracle 写入版本控制，或修改 approved replay suite，必须通过机器可执行的
   schema/privacy/exact-digest/revision gate；不要求人工 review 或独立 record authority。CI 不得自动更新或
   安装 baseline。本 ADR 不把 synthetic qualification 结果升级为 production replay，也不把可选 record 工具的
   安全检查变成资格前置条件。

## 备选方案

- 等待 live record authority、API credential 和人工审查 cassette：拒绝。它们验证的是另一个真实
  模型记录/基线流程，不能增加 PS-03 propagation seam 的必要信息。
- 复用 RP-03 approved cassette 作为 child start/resume 记录：拒绝。它会混淆 suite authority、actor
  lineage 和 PS-03 qualification scope。
- 以 Fake Provider、旧 runner 或未消费 catalog 替代 fresh strict replay：拒绝。它无法证明真实
  Pipeline/Local Provider/Driver 路径，且会降低 admission-before-lookup 或 `assertConsumed()` 语义。

## 后果

- PS-03 可以在当前仓库内以可重复、无凭据、无网络的 synthetic record→fresh strict replay 证据完成，
  不需要制造或提交真实模型 cassette。
- `eval:replay:record` 仍可作为显式 opt-in 的 candidate staging 工具使用，但只由 active operational policy
  约束，不是 PS-03、RP-03 或本计划的 authority/qualification，也不产出 PS-03 catalog 或 preflight。
- PS-03 完成不表示整个四阶段计划完成；PS-02 和 CUT-01 继续按各自依赖与原生证据状态推进。

## 回滚

在 CUT-01 前可以撤销 PS-03 qualification 状态，但必须同时撤销其 completion evidence；不得恢复
“必须 live record 才能证明 propagation”的隐含 blocker，也不得以旧 runner、Fake Provider 或 live
fallback 代替 strict replay。任何实际 catalog/schema 迁移仍需新的 ADR，并通过自动
schema/privacy/exact-digest/revision gate。
