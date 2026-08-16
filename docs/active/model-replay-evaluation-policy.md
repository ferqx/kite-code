# Model Replay Evaluation Policy

状态：active

读取时机：修改 replay/record response source、evaluation cassette、Agent task suite、fixture、oracle、
workspace normalizer、actor cursor 或 Required CI replay gate 时。

验证：`bun test tests/evals/agent-tasks`、`bun run check:docs-impact`、`bun run check:docs`、
`bun run typecheck`。

相关：ADR-0109、ADR-0112、[`agent-task-evaluation.md`](agent-task-evaluation.md)、
[`model-provider-boundary.md`](model-provider-boundary.md)、
`docs/space/plans/2026-08-16-trustworthy-runtime-convergence.md`。

## 当前状态与 authority

当前没有 `ModelResponseSourceV1` record/replay implementation、cassette catalog、获批 replay suite 或
Required CI replay gate。所有 production/eval 模型调用仍使用 Gateway 的 live source；replay miss 时也不存在
可调用的 live fallback。

D-07 的 `agent-task-single-maintainer-local-v1@1` 虽然是 approved local task definition，但在 replay
policy 中仅是 12-case `candidate`：`replayGate=disabled`、`recordAuthorization=denied`。其 immutable case
集合、suite digest、3 read-only/9 workspace-write 与 4/6/2 difficulty 分布继续保持，不因为 RP-00
重写 revision 或自动录制 response。

只有版本控制中严格解析的 replay-gate manifest 能批准具体 suite。Manifest 必须由
`github:@ferqx` 显式批准并绑定：

- suite id、revision、digest 与精确 case 集；
- fixture、cassette、oracle、catalog/schema/privacy policy、workspace normalizer、actor lineage/cursor 和
  deterministic clock/ID revision，以及精确 route、adapter protocol/replay-owner；
- 每条 `ModelAttemptOutcomeV1` 的 actor-local logical invocation/attempt ordinal、`surfaceDigest`（或仅获批
  fixture 可用的版本化 `replayDigest`）、`envelopeReplayDigest` 与 `outcomeDigest`；
- 允许忽略的 canonical event 字段；
- 本文定义的 privacy/no-egress 与 risk coverage 证明；
- 每条 record 恰好消费一次的 `assertConsumed` 与清理安全证明。

旧 D-07 approval、case 数量、测试通过或普通 code review 都不能推导 replay approval。上述 identity、
revision、digest、route/owner、risk 或 privacy schema 任一变化，都必须产生新 manifest revision，旧 approval
自动回到 candidate/revoked。RP-03 只能消费已批准 manifest，不能在 workflow 中自行批准、录制或更新 baseline。

live、record 与 replay 必须在 catalog lookup/transport 前重新执行当前 provider-data admission、resource
admission、reservation 与 prepared/attempt acknowledgement。当前策略拒绝、预算不可授予或 ack 失败时，
lookup 与 dispatch 均为零；历史 cassette 不是当前 admission、resource 或 Provider dispatch authority。

## 三个内容域

| 域 | 允许 | 永久禁止 |
| --- | --- | --- |
| Production Model Artifact | installation-private Surface/Response evidence；按 production key、retention 与 GC 治理 | 提交仓库、复制为 cassette、作为 Session Logger/telemetry source |
| Evaluation cassette | 经人工 review 的 synthetic Surface、逐 attempt `ModelAttemptOutcomeV1`、normalized response/tool call、必要 reasoning、usage/cache/finish ordering 与稳定 failure/retry observation | 用户/production workspace 正文、credential/header/raw endpoint、host path/env、production artifact、session log、raw provider ID/metadata/error/stack、无界 stream dump |
| Record credential | 未来显式 record 命令在受信任本机交互环境从 worktree 外 secret source 按 route allowlist 临时读取，并只注入 Provider transport handle | project `.env`、workspace/Runtime/Tool/Sandbox/child env、fixture、cassette、日志、报告、diff、error body、CI/fork/untrusted checkout 自动或无人值守 record |

Cassette 正文允许域不是 Session Logger content opt-in，也不授予 remote observability。fixture/cassette 中
出现 credential-like path、secret shape、symlink、Git metadata、超限文件、非 synthetic provenance 或无法
判定的内容时，必须在 record/catalog 之前 fail closed。测试用虚假 credential marker 也不能进入可提交
cassette；负例应在测试临时目录构造并清理。

Raw Provider request/response ID 必须替换为 deterministic cassette-local surrogate。Provider metadata/native
state 默认拒绝；只有 adapter 的版本化、有限大小、字段 allowlist codec 能逐字段审查且不含 raw header/body/
identity 时才可进入 cassette，unknown 字段或 opaque binary 直接拒绝。模型 outcome 始终是不可信正文，不能
因为输入 fixture 是 synthetic 就跳过 record-time inspection。当前 fixture privacy test 只证明 committed source
fixture，不能替代未来对所有生成 Surface、attempt outcome、codec 字段、catalog、diff 与 error 的 exact-key/
secret/unknown scan。

## Risk-based promotion

Promotion 依据风险维度而非固定 case 数。Manifest 必须覆盖与候选改动相关的下列 actor/purpose/scenario
维度，或显式记录不适用理由并由 authority 接受：

- actor：parent、并发 sibling subagent、continuation/resume 与 actor-local ordinal；
- model purpose：primary、compaction、auto review、verification review、subagent；
- attempt：success、retryable failure、fatal failure、aborted，以及 miss/out-of-order/corrupt/digest、route、
  replay-owner mismatch；
- Tool/Execution：read-only、workspace mutation、sandbox deny、receipt/Artifact、unknown effect 与 recovery；
- Runtime：compaction、Verification、crash/restore/fork、canonical terminal/oracle；
- determinism/privacy：固定 fixture identity、workspace normalizer、clock/ID、network deny、无 API key、无
  Provider transport、安全 cleanup 与全部 record 正好一次消费。

其中固定 suite/fixture/cassette/oracle/catalog identity、workspace normalizer、deterministic clock/ID source、
privacy/no-egress、无 credential、无 Provider transport、network deny、strict digest/mismatch fail-closed、
`assertConsumed` 与安全 cleanup 是不可豁免 G0，不能标记为不适用或由 authority waiver。

初始 12 case 只提供候选任务 taxonomy，不能单独证明以上矩阵。RP-02 pilot 应选择能暴露 cursor、effect、
verification 和 recovery 风险的 deterministic case；RP-03 在 risk coverage 未收敛时必须保持 blocked。

## 证据含义与 baseline 更新

通过 replay 只证明冻结 attempt outcome 下的 Runtime regression 边界，不证明真实模型质量、Provider 当前
兼容性、外部 cohort、发布资格或未覆盖安全属性。现有 synthetic eval 与显式 live smoke 继续保留各自证据
含义，不能互相替代。

Baseline 更新必须显式运行未来 record 命令，且仍只经 `ModelInvocationGatewayV1` 的逐 attempt ack 后
single-attempt transport。它只能在受信任的本机交互环境使用 synthetic fixture、route allowlist、worktree 外
credential source 和无 production workspace，产生新 suite/cassette revision 与 digest；credential handle
必须从 Runtime、Tool、Sandbox 与 child env 移除。Record staging 在 worktree 外完成，exact known-key scan
覆盖 Surface/outcome/catalog/codec/diff/error 后，维护者再单独审查 Surface/outcome diff 并提交。Required CI、
fork 与 untrusted checkout 禁止 record；Required CI 只 replay，绝不读取 credential、建立 Provider transport、
自动修补 cassette 或在失败时回退 live。CI/普通日志只允许 case、固定状态和 reason code，不打印 cassette、
prompt、response、reasoning、tool args 或 raw mismatch body。

这里的 keyless 只表示 replay 不读取模型 API key、不创建 live Provider transport；它与 ADR-0062 的
Sigstore/OIDC keyless signing、attestation 或 provenance 无关。RP-00 不修改 Runtime schema/format epoch，
replay-gate approval 也无权切换；唯一 epoch cutover 仍是 CUT-01。
