# Model Replay Evaluation Policy

状态：active

读取时机：修改 replay/record response source、evaluation cassette、Agent task suite、fixture、oracle、
workspace normalizer、actor cursor 或 Required CI replay gate 时。

验证：`/usr/bin/env -u BUN_OPTIONS -u NODE_OPTIONS bun --no-env-file run eval:replay:required`、
`bun test tests/model-response-source.test.ts tests/model-invocation-gateway.test.ts tests/evals/agent-tasks`、
`bun run check:core-boundary`、`bun run check:docs-impact`、`bun run check:docs`、`bun run typecheck`。

相关：ADR-0109、ADR-0112、ADR-0114、ADR-0115、[`agent-task-evaluation.md`](agent-task-evaluation.md)、
[`model-provider-boundary.md`](model-provider-boundary.md)、
`docs/space/plans/2026-08-16-trustworthy-runtime-convergence.md`。

## 当前状态与 authority

RP-01 已实现 `ModelResponseSourceV1` 的 `live | record | replay` 单 attempt source 与 strict catalog parser。
RP-02 建立了显式 evaluation-only deterministic pilot。RP-03 现以
`scripts/evals/manifests/model-replay-gate-v1.json` 批准 `model-replay-required-suite-v1@1`，
`/usr/bin/env -u BUN_OPTIONS -u NODE_OPTIONS bun --no-env-file run eval:replay:required` 作为
`.github/workflows/required.yml` 的每提交 keyless gate。production 与
既有 live eval composition 仍只构造 live Source；Required gate 无模型、API key、Provider transport 或
live fallback，也不能被 production composition 选择。

Gateway 是唯一重试、backoff、attempt budget 与下一次 attempt ack 权威。三种 source 每次只返回一个
`ModelAttemptOutcomeV1`；record source 必须显式注入通过 schema/privacy gate 的 catalog encoder 与 recorder，且 append 失败
在已发生 transport 后以 `attempted` fail closed，不会重试或切换 source。Replay catalog 只接受 canonical
UTF-8、exact-key、privacy-screened 的 V1 schema，并严格绑定 suite/fixture、actor-local invocation/attempt
ordinal、route/replay-owner、`surfaceDigest`、`envelopeReplayDigest` 与 `outcomeDigest`；duplicate、miss、
out-of-order、corruption 或 route/owner mismatch 分别返回固定 typed error，不输出 catalog 正文。

RP-03 V1 manifest 只批准 `replayDigest=null` 的 catalog，继续按完整
`surfaceDigest + envelopeReplayDigest` 精确匹配；workspace normalizer 只用于 evidence 投影，调用方
不能自行声明 tokenization。未来非空 `replayDigest` 需要新 manifest/schema revision 和完整负例。Catalog 的
native replay state 默认拒绝，Provider response/tool-call identity 只能使用 `cassette-response-*` /
`cassette-tool-call-*` 本地 surrogate，raw metadata 与未知字段拒绝。`assertConsumed()` 要求全部 record
恰好消费一次。

D-07 的 `agent-task-single-maintainer-local-v1@1` 虽然是 approved local task definition，但在 replay
policy 中仅是 12-case `candidate`：`replayGate=disabled`、`recordAuthorization=denied`。其 immutable case
集合、suite digest、3 read-only/9 workspace-write 与 4/6/2 difficulty 分布继续保持，不因为 RP-00
重写 revision 或自动录制 response。RP-02 从其中的 `approved.03-typescript-bug-fix.v1` 建立独立
`deterministic_pilot` identity 与 digest-bound catalog；它不修改 12-case candidate 的 `cassette=absent`，也不把
D-07 task-definition approval 提升为 replay-gate approval。

RP-03 批准的是独立六 case replay suite，不是把 D-07 全部 12 case 提升。它精确绑定
`approved.03-typescript-bug-fix.v1` 的 RP-02 pilot 与五条 risk contract：primary retry→success、
compaction fatal、auto-review aborted、verification-review success 和 continuation subagent success。pilot 本身的
`evidenceEligible=false/replayGate=disabled` 仍防止单独运行就声称 gate；只有获批 manifest 绑定的整体
gate report 具有 replay regression 证据语义。

RP-02 pilot 固定 fixture/cassette/oracle/catalog digest、6 条逐 attempt record、版本化 workspace normalizer、
deterministic `RuntimeIdSourceV1`/clock 与精确忽略字段。parent 以四个 actor-local logical invocation 经过
Gateway，两个 sibling child 在反转并发调度顺序下各自消费 ordinal 1；Runtime 闭环覆盖 missing read failure、
workspace write receipt、Verification passed、`run.completed + turn.completed` 与 Agent-task oracle。两次
replay 的 canonical terminal/关键 receipt/report digest 完全相同，并证明零 key、零 Provider transport、零
network/shell boundary、`assertConsumed()`、无残留 process/worktree 及 owner-checked cleanup。workspace
normalizer 当前只用于 pilot evidence 投影；catalog 仍全部 `replayDigest=null`，不得提前充当 RP-03 tokenization
authority。cassette 使用 `deterministic-pilot-v1.jsonl` 的单记录、单 LF canonical framing；通用 JSON
formatter 不得展开或改写其受 digest 保护的精确字节。

该 pilot 关闭自动 filesystem mutation reviewer，但仍在成功 write 后提交并执行一条显式 `required` schema
verification；因此它不需要、也不能推导一条未录制的 verification-review attempt。获批 risk matrix 另以
`risk.verification-success.v1` 覆盖 `verification_review` purpose。PS-01 后 pilot 必须显式注入与 Capability
Artifact reader 相同 composition 的 Workspace filesystem Provider，缺失 Provider 不得被接受为新的 oracle
baseline。Local Provider 的成功 mutation receipt 保留并严格验证完整 result/evidence/Artifact digest；pilot
canonical report 只把其中绑定 host inode/mtime 的三个派生 digest 投影为版本化
`workspace_filesystem_semantic_v1`，并比较稳定的 invocation、actor identity、lexical-target 与 post-content
digest；host-root-bound canonical-target 与 inode/mtime-bound target-identity digest 也不进入该投影。所有精确
省略字段逐项登记在 authority 的 ignored fields；不得扩展到 lexical target、失败 receipt、模型 Artifact 或
普通 Capability receipt。

文件工具的 provider-facing schema、governance revision 或语义投影变化时，pilot canonical report 与 Required
qualification import closure 必须在同一改动中重新计算并由 manifest authority 精确绑定；这类重算不等于修改
cassette、fixture、catalog 或 oracle。本次 ADR-0118 文件访问契约迁移只更新上述 report/qualification 摘要，
pilot oracle 仍为原批准的 passing digest，Required 仍须通过 strict catalog 与 `assertConsumed()`。
ADR-0119 新增的 structured sandbox pre-dispatch failure authority 改变了 PS-03 journey 的传递 import closure；
本次只重算 closure/manifest authority，pilot report、cassette、fixture、catalog 与 oracle 均未改变。

只有版本控制中严格解析的 replay-gate manifest 能批准具体 suite。当前 V1 manifest 由
`github:@ferqx` 显式批准并绑定：

- suite id、revision、digest 与精确 case 集；
- fixture、cassette、oracle、catalog/schema/privacy policy、workspace normalizer、actor lineage/cursor 和
  deterministic clock/ID revision，以及精确 route、adapter protocol/replay-owner；
- 每条 `ModelAttemptOutcomeV1` 的 actor-local logical invocation/attempt ordinal、`surfaceDigest`（或仅获批
  fixture 可用的版本化 `replayDigest`）、`envelopeReplayDigest` 与 `outcomeDigest`；
- 允许忽略的 canonical event 字段；
- 本文定义的 privacy/no-egress 与 risk coverage 证明；
- 每条 record 恰好消费一次的 `assertConsumed` 与清理安全证明。

manifest digest 由 parser 外的独立 authority 常量锚定；manifest 再用 qualification 文件 SHA-256 绑定 parser、
package command、Required workflow、OS network isolation wrapper、纵深防御 preload、gate/record runner、
pilot/risk runner、Gateway/response-source/catalog 及
crash/restore/fork、Tool Pipeline 和 ToolOutcome recovery qualification tests。旧 D-07 approval、case 数量、
测试通过或普通 code review 都不能推导 replay approval。上述 identity、
revision、digest、route/owner、risk 或 privacy schema 任一变化，都必须产生新 manifest revision，旧 approval
自动回到 candidate/revoked。RP-03 只能消费已批准 manifest，不能在 workflow 中自行批准、录制或更新 baseline。

live、record 与 replay 必须在 catalog lookup/transport 前重新执行当前 provider-data admission、resource
admission、reservation 与 prepared/attempt acknowledgement。当前策略拒绝、预算不可授予或 ack 失败时，
lookup 与 dispatch 均为零；历史 cassette 不是当前 admission、resource 或 Provider dispatch authority。

PS-03 已把 start/resume 的 actor-local ordinal、sibling identity、continuation cursor、suite/revision/fixture/
replay digest 与 exact attempt acknowledgement 传播到 sealed grant 和唯一 Child Runtime Gateway 路径；定向负例
证明 drift、ack failure 与 Fake Provider 路径在 catalog lookup/Source/Driver 前 fail closed。依据 ADR-0115，PS-03
的传播资格使用封闭的 deterministic synthetic in-memory Source：它在真实 Gateway/Pipeline/Local Provider/Driver
路径中产生两条 `ModelAttemptOutcomeV1`，随后在新的 private Artifact root/key 中由 fresh
`StrictModelReplayCatalogV1` 重新执行 start→blocked→resume，并严格调用 `assertConsumed()`。该资格不需要
live record authority、API credential、持久化 cassette 或人工 cassette review；record 阶段与 fresh replay 均为
零 Provider transport、零 credential、零 live fallback；真实 model handle 的 `doGenerate`/`doStream` 由 observer
包装并机械断言 transport attempt 为零，真实 Model/Capability Artifact readback 仍逐 attempt
验证 exact owner/schema/canonical content/invocation binding，wrong-key、tamper、missing、cross-owner 全部
fail closed。Required isolated runner 实际执行 `tests/evals/agent-tasks/replay-subagent-journey.test.ts`，manifest
以 qualification file 精确绑定 journey source/test，并以 TypeScript static import graph 的机器计算 aggregate
digest 绑定其完整 repository-local Runtime 依赖闭包；任一传递依赖或 import graph 漂移都会在 journey 执行前
使 Required qualification fail closed。Required manifest 不含 record authority，PS-03 qualification 也没有
credential/cassette/manual-review 输入。该证据只证明 PS-03 seam 的 propagation/admission/digest contract，
不是 production replay authority 或真实模型质量证据；若未来修改版本控制 catalog、fixture、oracle 或 approved
suite，必须通过自动 schema/privacy/exact-digest/revision gate，不要求人工 review。

PS-03 child actor identity 由稳定的 parent Model invocation、parent task tool call、outer Task/capability attempt
(`parentAttempt`) 与 role 派生；该 attempt 与 sealed grant 使用同一 exact capability attempt，
不由 task capability invocation、Capability Artifact ref 或 installation integrity key 派生；因此 record 与 fresh
replay 可使用不同 private artifact root/key，仍必须匹配同一 actor。已保存 suspended continuation 直接复用旧 child
identity，schema/format epoch 不变。

## 三个内容域

| 域 | 允许 | 永久禁止 |
| --- | --- | --- |
| Production Model Artifact | installation-private Surface/Response evidence；按 production key、retention 与 GC 治理 | 提交仓库、复制为 cassette、作为 Session Logger/telemetry source |
| Evaluation replay input | 通过自动 schema/privacy/exact-digest/revision gate 的 synthetic Surface、逐 attempt `ModelAttemptOutcomeV1`、normalized response/tool call、必要 reasoning、usage/cache/finish ordering 与稳定 failure/retry observation | 用户/production workspace 正文、credential/header/raw endpoint、host path/env、production artifact、session log、raw provider ID/metadata/error/stack、无界 stream dump |
| Optional record credential | 仅显式 `eval:replay:record` 这一非资格、非 authority 的 operational CLI 在受信任本机交互环境从 worktree 外 owner-only secret file 按精确 DeepSeek route allowlist 临时读取，并只注入 Provider transport handle | project `.env`、workspace/Runtime/Tool/Sandbox/child env、fixture、catalog、日志、报告、diff、error body、CI/fork/untrusted checkout 自动或无人值守 record |

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
维度，或显式记录可由 schema 校验的不适用理由：

- actor：parent、并发 sibling subagent、continuation/resume 与 actor-local ordinal；
- model purpose：primary、compaction、auto review、verification review、subagent；
- attempt：success、retryable failure、fatal failure、aborted，以及 miss/out-of-order/corrupt/digest、route、
  replay-owner mismatch；
- Tool/Execution：read-only、workspace mutation、sandbox deny、receipt/Artifact、unknown effect 与 recovery；
- Runtime：compaction、Verification、crash/restore/fork、canonical terminal/oracle；
- determinism/privacy：固定 fixture identity、workspace normalizer、clock/ID、network deny、无 API key、无
  Provider transport、安全 cleanup 与全部 record 正好一次消费。

其中固定 suite/fixture/cassette/oracle/catalog identity、workspace normalizer、deterministic clock/ID source、
privacy/no-egress、无 credential、无 Provider transport、经外层已知可达 loopback listener 反向探针确认的 OS
network isolation、strict digest/mismatch fail-closed、`assertConsumed` 与安全 cleanup 是不可豁免 G0，不能标记为
不适用或由 authority waiver。Required replay command 必须在 checkout/setup/install 与 Linux isolation dependency
安装完成后进入该隔离；Linux wrapper 由 GitHub-hosted runner 的非交互式 `sudo` 只启动一次 CI 安装的
bubblewrap，以绕过宿主禁用非特权 namespace 创建的平台限制；bubblewrap 随即建立独立 mount/PID/network
namespace、只读绑定必需系统根与 checkout，并把 Bun runtime directory 投影到固定隔离根；只给 owner-only private runtime bind
写权限；在任何仓库代码运行前，系统 `setpriv` 再降回 runner UID/GID、清空 groups/capability、建立
`NoNewPrivs`。isolated runner 必须机械证明它不在外层 network namespace、
supplementary groups/capability 已清空、no-new-privs 已建立，且不能通过本机提权工具返回宿主 namespace。
这里的 bubblewrap 只实现 Required replay 的 no-egress wrapper，不构成 production sandbox support 或平台资格。
外层、isolated runner、gate 与 tests 的 Bun 入口必须显式使用
`--no-env-file`，外层命令还必须在启动 Bun 前删除 `BUN_OPTIONS`/`NODE_OPTIONS`；isolated child 只接收
`env -i` 构造的固定 allowlist，禁止从 checkout `.env` 重新装载 credential 或通过环境注入 preload。
JavaScript preload 对选定进程内网络 primitive 的拒绝只是纵深防御，不能单独
充当 no-egress 证明。只有外层 wrapper 在 isolated child 完成后才能生成 Required passed report；Core gate
报告不得自行声称 OS isolation。isolated gate/tests 的 stdout/stderr 不得转发到 CI，外层只输出固定
suite/status/reason/isolation metadata；失败细节须由对应本地定向测试诊断，不能把 cassette、prompt、response、
raw mismatch 或 host path 写入 Required log。外层 `sudo` 不得进入 isolated child environment，也不得成为
child 内的 fallback；启动失败只允许按 privileged launcher、bubblewrap setup、privilege drop、namespace、mount、
access/configuration、process crash 或 isolated runtime
等固定低信息枚举报告，外层异常同样只允许按 runtime directory、loopback listener、command build、spawn 或
observation 阶段归类，不得回显原始 stderr。平台无法建立或探针无法确认隔离时必须 fail closed，不得降级为
仅 preload 或 live Provider。

初始 12 case 只提供候选任务 taxonomy，不能单独证明以上矩阵。RP-03 以 RP-02 pilot 覆盖
parent/sibling cursor、read/write effect、Verification、canonical oracle 与 G0 cleanup；五条 risk contract 经 Gateway
覆盖五 purpose、continuation cursor 和四类 attempt outcome；manifest-bound qualification tests 再覆盖
miss/out-of-order/digest/route/owner/corruption、sandbox deny、receipt/Artifact、unknown recovery 及
crash/restore/fork。任一绑定文件、digest 或 G0 证据漂移都使 Required gate fail closed。

## 证据含义与 baseline 更新

通过 replay 只证明冻结 attempt outcome 下的 Runtime regression 边界，不证明真实模型质量、Provider 当前
兼容性、外部 cohort、发布资格或未覆盖安全属性。现有 synthetic eval 与显式 live smoke 继续保留各自证据
含义，不能互相替代。

Baseline 更新必须显式运行 `bun run eval:replay:record -- ...`，且所有要求 live success 的 attempt 仍只经
`ModelInvocationGatewayV1` 的逐 attempt ack 后 single-attempt transport。它只能在受信任的本机交互环境
使用 synthetic fixture、精确 DeepSeek route allowlist、worktree 外 credential source 和无 production workspace，
产生新 suite/cassette revision 与 digest；credential handle
必须从 Runtime、Tool、Sandbox 与 child env 移除。Record staging 在 worktree 外完成，exact known-key scan
覆盖 Surface/outcome/catalog/codec/diff/error 后，再由自动 schema/privacy/exact-digest/revision gate 决定是否可提交。Required CI、
fork 与 untrusted checkout 禁止 record；Required CI 只 replay，绝不读取 credential、建立 Provider transport、
自动修补 cassette 或在失败时回退 live。CI/普通日志只允许 case、固定状态和 reason code，不打印 cassette、
prompt、response、reasoning、tool args 或 raw mismatch body。

record 命令还必须绑定干净 HEAD、上游 remote、`github:@ferqx` 与精确确认字符，并拒绝
CI/GitHub Actions、fork remote、任何 environment API key/token、credential symlink/宽权限以及 worktree 内
staging。它只在新建的 owner-only 目录写入 pilot/risk candidate catalog、Surface/outcome inspection 和
metadata-only index，固定 `approval=absent/installAutomatically=false`。新 candidate 若未重新满足完整 risk matrix、
自动 privacy/schema/exact-digest/revision gate 和新 manifest identity，不得替换当前 Required baseline。该 CLI
及其 credential/staging 防护不属于本计划、RP-03 或 PS-03 qualification authority，也不会生成 PS-03 package。

Risk candidate 的 retryable/fatal/aborted attempt 不是从真实 Provider 偶发故障推断，而是由版本化 risk
contract 注入受控 synthetic outcome；primary retry 的第二次 success、verification success 与 subagent success
才委派同一个显式 live Source。record 必须保留每 case 的 `maxAttempts`，并在写 candidate 前逐 case 验证
`retryable→success | fatal | aborted | success` 的精确 outcome 序列；当前 risk catalog 因而固定为六条 attempt
record，而不是五条 case 各一条。

这里的 keyless 只表示 replay 不读取模型 API key、不创建 live Provider transport；它与 ADR-0062 的
Sigstore/OIDC keyless signing、attestation 或 provenance 无关。Replay gate/qualification 没有 Runtime format
authority；schema v25/new epoch 由独立的 CUT-01/ADR-0117 切换。
