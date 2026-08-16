# ADR-0112：Keyless 模型 Replay 评测治理

状态：accepted

日期：2026-08-16

决策者：github:@ferqx

相关：ADR-0056、ADR-0058、ADR-0062、ADR-0063、ADR-0068、ADR-0069、ADR-0096、ADR-0105、ADR-0109、
`docs/space/plans/2026-08-16-trustworthy-runtime-convergence.md`

## 背景

ADR-0109 已决定所有模型调用通过同一 Gateway，并允许未来以严格匹配的 attempt outcome 做 keyless
replay。Replay cassette 为了重建模型决策必须保存受控的 synthetic prompt、response、reasoning 或 tool-call
正文；这与 Production Model Artifact、metadata-first Session Logger 和无正文 observability 是不同的数据域。

仓库现有 12-case `agent-task-single-maintainer-local-v1` 已按 D-07 批准为本地 synthetic 任务定义，但其
`executionEvidence` 仍是 `definition_only`。该 “approved” 不能自动变成 replay recording、cassette 或
每提交 gate 的授权。否则一个旧 suite 标签就能绕过内容审查、风险覆盖和 no-egress 证明。

## 决策

1. Replay 评测严格分为三个互不替代的数据域：
   - Production Model Artifact 是 installation-private 的真实运行证据，永不提交到仓库，也不是 cassette
     或 Session Logger 的来源；
   - Evaluation cassette 只允许保存人工审查过、可提交的 synthetic fixture 正文和重放所必需的
     Surface/outcome/tool-call 数据；
   - Record credential 只由未来的显式 record 命令从受信任、本机交互环境的 worktree 外 secret source
     读取，并只作为 Provider transport handle 注入。它必须从 Runtime、Tool、Sandbox 与 child process
     environment 移除，永不进入 workspace、fixture、cassette、日志、报告、diff 或原始错误。CI、fork、
     untrusted checkout 和无人值守环境禁止 record；record staging 与人工 review/提交必须分离。
2. Cassette 的最小记录单元是逐 attempt `ModelAttemptOutcomeV1`，封闭为 `success`、
   `retryable_failure`、`fatal_failure` 或 `aborted`。允许内容限于绑定版本和 digest 的 synthetic Surface、normalized success response、
   稳定 tool call、必要的 future-context reasoning、usage/cache/finish 顺序、稳定 failure classification 与
   retry observation。Raw Provider request/response ID、header/body、provider metadata 和
   native replay state 默认拒绝；必要 identity 使用 deterministic cassette-local surrogate，adapter-native
   字段只有经过版本化 codec allowlist 逐字段审查后才能保存。模型 outcome 始终是不可信正文，不能因输入
   fixture 是 synthetic 就自动准入。禁止真实用户或 production workspace 内容、API key/token/header/
   credential、原始 endpoint、主机绝对路径、环境快照、production artifact、Session Logger 输出、原始
   Provider error/stack 和未界定的 stream dump。
3. D-07 的 12-case suite 只登记为 replay `candidate`；当前 `replayGate=disabled`、
   `recordAuthorization=denied`。RP-00 不批准任何 cassette、response source 或 Required CI gate。
4. 具体 suite 只有在后续提交一个严格版本化的 replay-gate manifest 后才能获得 `approved`。Manifest 必须绑定
   suite id/revision/digest、精确 case 集、fixture/cassette/oracle digest、catalog/schema/privacy-policy
   revision、精确 route 与 adapter replay-owner、actor lineage、workspace normalizer、deterministic clock/ID、
   允许忽略字段、risk coverage、privacy review、no-egress 和 `assertConsumed` 证据。单维护者
   `github:@ferqx` 可在同一 PR 中复核并批准；任一绑定内容变化都必须生成新 revision 并使旧 approval
   失效为 candidate/revoked。缺字段、未知状态、旧 D-07 approval 或普通 code review 均不能推导授权。
5. 每条未来的 attempt record 必须绑定 actor-local logical invocation/attempt ordinal、route/adapter owner、
   `surfaceDigest`（仅获批 fixture 可另带版本化 `replayDigest`）、`envelopeReplayDigest` 与 `outcomeDigest`。
   live/record/replay 都必须先在当前 Runtime 重跑 provider-data 与 resource admission；拒绝、reservation/ack 失败
   必须发生在 catalog lookup 或 transport 前，cassette 不能把历史 admission 变成当前授权。
6. Promotion 不使用固定 case 数量代替风险覆盖。获批 suite 必须按相关改动覆盖：parent 与并发/续跑 child
   actor-local cursor；primary、compaction、review/verification/subagent purpose；read-only 与 workspace
   mutation Tool effect；verification；success/retryable/fatal/aborted attempt；miss、乱序、digest/route/owner
   mismatch、corruption、crash unknown 与 recovery。actor/purpose/scenario 可显式说明不适用；固定
   suite/fixture/cassette/oracle/catalog identity、workspace normalizer、deterministic clock/ID source、
   privacy/no-egress、无 credential、无 Provider transport、network deny、strict digest/mismatch fail-closed、
   `assertConsumed` 和安全 cleanup 是不可豁免 G0，不能以总 case 数或 authority waiver 掩盖。
7. Replay gate 只证明：在冻结的受审查 `ModelAttemptOutcomeV1` 下，当前 Runtime、Tool Pipeline、Sandbox 和
   Verification 没有发生未解释回归。这里的 promotion 只指 replay-gate admission；它不证明当前真实模型
   质量、Provider 可用性、capability/release maturity、外部用户效果或未覆盖的安全属性，也不改变
   ADR-0068/ADR-0069 的首发 Gate。
8. Baseline 只能由显式 record 流程更新，且真实调用仍只能经 `ModelInvocationGatewayV1` 在每次 attempt ack
   后进入 single-attempt transport。流程创建新的 suite/cassette revision 与 digest，并审查 Surface/outcome
   diff。staging 时必须用 exact known-key scan 检查 Surface、outcome、catalog、provider codec 字段、diff 和
   error output；unknown/secret 一律拒绝。CI 永不自动 record、修补或批准 cassette。任何 miss/corruption/
   mismatch 都 fail closed，不回退 live；CI 与普通日志只允许 case、固定状态/reason code，不能输出 cassette、
   prompt、response、reasoning、tool args 或 raw mismatch body。
9. RP-01 才能实现 `ModelAttemptOutcomeV1` source 与 strict catalog parser；RP-02 才能生成 deterministic
   pilot cassette；RP-03 只有在 manifest 获批后才能建立每提交 keyless replay gate。本 ADR 的 keyless 只指
   不读取模型 API key且不创建 live Provider transport，与 ADR-0062 的 Sigstore/OIDC keyless signing 无关。
   RP-00 与 replay-gate approval 都不改变 Runtime schema/format epoch；唯一切换点仍是 CUT-01。

## 备选方案

- 直接把现有 D-07 approved suite 接入 Required CI：拒绝。任务定义 approval 没有证明 cassette privacy、
  actor determinism 或风险覆盖。
- 让 cassette 完全无正文：拒绝。模型输出不保留正文就无法重建 tool call 和未来上下文，测试会退化成
  event-log replay。
- 复用 Production Model Artifact 或 Session Logger 作为 cassette：拒绝。前者可能含真实运行正文，后者的
  allowlist 和 retention 目的不同。
- replay miss 时临时使用真实 Provider：拒绝。它破坏 keyless、确定性与外发边界。

## 后果

- 版本控制中的 cassette 可以包含明确允许的 synthetic 正文，因此必须逐 revision review，且不能被普通
  metadata logger/observability 规则错误地描述为“无正文”。
- 当前 12-case suite 保持不变，但在 replay 语义中仍是候选，不产生 gate 通过声明。
- 后续实现需要 strict manifest/catalog parser、fixture privacy validation、no-egress 和 deterministic
  consumption evidence；这些控制缺一即 blocked。

## 回滚

RP-03 前可删除未获批的 candidate cassette 或撤销 replay 实现，但不能把它们追认为通过。RP-03 后可把
manifest 状态改为 revoked 并关闭 gate；不得回退为 live Provider、CI 自动 record、跨域复制 production
artifact，或用旧 D-07 标签恢复授权。
