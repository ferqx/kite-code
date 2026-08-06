# 当前规则：真实模型测试边界

状态：active
最后更新：2026-08-06
最后验证：2026-08-06

读取时机：新增真实网络/模型测试、修改测试发现规则、package scripts 或声明 provider 端到端验证结果时。

验证：`bun test tests/test-discovery.test.ts tests/evals/qualification/github-actions-agent-diagnostic-model-lease.test.ts tests/evals/qualification/github-actions-agent-evaluation.test.ts tests/evals/qualification/github-actions-auto-compaction.test.ts tests/evals/qualification/github-actions-agent-diagnostic-aggregate.test.ts tests/evals/qualification/github-actions-agent-evaluation-workflow.test.ts tests/evals/qualification/auto-compaction-failure-contract.test.ts tests/evals/qualification/live-compatibility-runner.test.ts tests/evals/qualification/live-auto-compaction-runner.test.ts tests/evals/qualification/auto-compaction-live-evidence.test.ts tests/evals/qualification/live-route-resolver.test.ts tests/evals/qualification/live-scratch-supervisor-health.test.ts tests/evals/qualification/live-isolated-transport.test.ts tests/evals/qualification/live-model-transport.test.ts tests/evals/qualification/live-governance-ledger.test.ts`、`bun run typecheck`。

相关：ADR-0068、ADR-0069、`model-provider-boundary.md`、`open-source-first-release.md`。

## 当前状态

仓库保留显式 opt-in 的 `test:model:live` package script，作为 ADR-0071 **formal AQ-8 L3** 的将来诊断性 compatibility wrapper 接口；它不是当前 G1，也不是 release admission。**当前所有 formal AQ-8 L3 公共入口均安全停用。** runner 的固定 source-byte binding 通过后，`liveScratchSupervisorActivationIsImplementedV1()` 的 checked-in literal 仍为 `false`；它在读取 caller environment 或 ledger、创建 resolver/reservation/credential lease、scratch root 或 child process 之前确定性返回 `blocked/governance_reservation_unavailable`。因此 opt-in、credential、base URL、owner-only ledger root 或伪造的 health JSON 都不能开启 formal L3 transport，也不会产生 `LiveCompatibilityObservationV1`、receipt 或 diagnostic compatibility 结论。

`hasFreshLiveScratchSupervisorHealthV1` 只为将来受保护 persistent scratch supervisor 校验有界、owner-only、无 secret 的 health wire shape 与 freshness。它不是 activation、maintainer authorization、protected-ref/control-plane proof、durable deletion witness 或实际 supervisor identity；当前 literal 为 `false` 时公共 runner 不读取该 health 文件。ADR-0071 已接受 Linux root-owned service、`/run` tmpfs、immutable worker bundle、native isolation 与 deletion-proof 的架构边界；仓库中的 `L3ProtectedScratchSupervisorDeploymentV1` 只是固定、digest-bound 的部署声明，既不安装也不证明某台主机已部署服务。补充的 installation/native-boundary contract 只将 systemd/manifest/native-helper 的 future interface 做无密钥、不可执行、source-owned 约束，并不安装、启动或证明任何 host object。真实 Linux control plane/probe、actual retention proof 与 AQ-8 review 仍未完成；在它们完成前仍不可重新审查该可用性分支。默认 `bun run test` 通过 `scripts/run-default-tests.ts` 只运行确定性的本地/mock 测试：主 suite 使用 `--max-concurrency=1 --only-failures` 限制 Bun 共享进程中的测试和输出资源竞争，并包含快速 `tests/tui-system/harness/` 单元测试，但排除真实 PTY `scenarios/`、TUI/native sandbox smoke 与 spike；`tests/shell-exec.test.ts` 在默认门禁显式关闭 native sandbox，只验证统一 executor 的 Shell/进程树语义。Seatbelt/bubblewrap 正向执行由 `test:sandbox:smoke:native` 与 platform capability workflow 单独运行。每个 test process 都获得独立临时 `HOME`/`KITE_CODE_HOME`（Windows 同步 `USERPROFILE`），不得读取或修改开发机真实 Kite 配置、Plan 或 Session Log。会临时修改进程级 cwd 或 `KITE_CODE_HOME` 的少量路径测试还会逐文件启动独立 Bun 进程，避免进程级状态互相污染。不得改用 Bun per-file isolate；当前 Ink/Yoga ESM 在该模式下不能稳定初始化。`test:mock` 明确运行当前 context compaction Runtime E2E，同样不访问真实 provider。未实际执行 live runner 时，文档、PR 或完成记录不得表述为真实 provider 已验证。

GitHub-hosted `Required` workflow 仍只运行无 Provider secret 的 deterministic Agent/TUI/E2E/fault suites；它不运行任何 `eval:agent:live*` 命令，也不读取诊断 credential。已接受的 ADR-0072 另设 **manual-only** `.github/workflows/agent-live-evaluation.yml`：无密钥 preflight 只在 canonical `main` 输出脱敏 report；live job 只有在 protected main 与外部 `agent-live-eval` Environment 审核/secret 前提均满足时，才以一步环境变量执行 `eval:agent:live`。AQ-10 aggregate 是该命令的唯一 secret owner：它一次取得 opaque lease，并在同一 process/workflow 内 fresh-verify AQ-8 `runRuntimeAgent` read-file、AQ-9B success 和 AQ-9B after-Provider-fetch client-abort 三个 fixed case，精确限制为 `2 + 2 + 1` 次 Provider fetch 与 180 秒 suite cap。AQ-9B 仍以 8,192 in-memory threshold、9–10K safe synthetic context、summary `7,800/600` 与 primary `3,229/600` caps 验证 success 或 client abort；没有 `contextWindowTokens`、普通 config 或 workspace/session overlay 输入。所有 child/aggregate report 都不是 `AgentQualificationEvidenceV1`、`LiveCompatibilityObservationV1`、G0/G1、release evidence 或 production-content admission。未实际运行对应 live job 时，只能报告 deterministic/preflight 状态，不能声称真实 Provider 已验证。

该 ADR-0072 分支不要求 self-hosted runner、root service 或 native proof，也不满足 ADR-0071 的 formal L3 isolation、retention/deletion 或 governance control-plane 要求。`test:model:live` 的 formal L3 仍须在未来另行完成 persistent supervisor、native probe、governance/retention proof 与独立复审。

同一 non-activation contract 还定义 manifest、nonce-digest-bound Ed25519 attestation、root-private atomic
nonce-consumption record/complete nonce-scope index、pre-allocation commitment 与 signed lifecycle receipt：index 必须由服务签名地
证明恰有一个 nonce consumption 与一个 allocation，且只作为 verifier 输入，receipt 仅回绑其 digest。commitment 必须以直接后继
journal sequence 续接 consumption，满足 `committedAt < allocatedAt < attestation.expiresAt`；receipt 必须精确回绑
manifest-key、nonce、service epoch、attestation、consumption/index、commitment 和完整 candidate/execution/Matrix/suite/oracle/
corpus/evaluator/verifier/runner/governance binding。governance 固定 ADR-0070 `ephemeral_local` 的 profile ID/digest、retention/
storage/audit/authorizer、quota ledger/retention witness 与 owner-only projection-policy digest；receipt 还固定 terminal owner-only
projection digest。可变 ID 只可为固定 service ID 或 L3 UUIDv4 opaque token，attestation 只接受 canonical Ed25519 SPKI public
key（私钥 PEM 拒绝）。normal exit 的 reaping 和 scrub/delete 均从 worker exit 起一秒内完成，crash deletion 不得晚于 allocation
后 86,400 秒。它不含 key、完整 endpoint、prompt/response/reasoning、absolute path、PID/UID 或工作区正文；但 schema 不能自行
发现 root-held manifest/key、验证 `/run` tmpfs/native isolation、process reaping、atomic index、owner-only projection 或实际 scrub。
因此当前 L3 verifier 不接受该 receipt 产出 `observed`，public runner 的 activation 仍为 false。

ADR-0068/ADR-0069 注册 `test:provider:smoke` 作为 G1 的最小真实调用入口。它不进入默认测试：DeepSeek
固定 `deepseek-v4-flash`；千问使用 `openai-compatible` adapter，默认路由为阿里云 Token Plan
北京 `token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1` 的 `qwen3.6-flash`。环境变量和显式
本机配置都必须精确使用该 endpoint；其他 DashScope 区域端点、任意域名、HTTP、非默认端口、
query/fragment 或非 Qwen 模型均 fail closed。每条 route 只调用一次、限制 16 output tokens
和 60 秒 deadline；DeepSeek 复用 bounded-summary provider option 显式关闭 thinking，使非空正文断言
不依赖上游 reasoning token 分配。runner 只输出 provider alias、model、耗时、usage、response non-empty 与
credential source，不输出 prompt、response、key、完整 endpoint、stack 或远端 error body。缺 key、超时、
空 response 或网络失败均非零退出；本地 mock 单元测试只证明不泄密 contract，不能替代真实 G1。

ADR-0071 AQ-8 L3 的**future formal 可用性分支**与上述 G1 完全独立：它预先固定 `LiveSuitePolicyV1`、diagnostic-only provider data
policy、独立 route/suite/evaluator/verifier/runner digest 和 sealed synthetic corpus，直接 transport 的 retry 固定为零。
若且仅若 ADR-0071 已接受的 persistent-supervisor implementation/proof branch 收敛，reservation/terminal ledger 才可保存经 output guard 清洗的 metadata，
并按 profile 的 attempt/token/time/cost/concurrency 上限进行预留和对账。任何未来 L3 observation 仍固定
`authority='diagnostic'`、`evidenceEligible=false`，并携带只作 local diagnostic identity binding 的 candidate closure；
它不是 candidate aggregate，也没有 release evidence、release bundle、Gate 输入或 production content admission。
candidate/execution、scope profile、Matrix/suite/oracle/corpus/evaluator/verifier/runner 与 governance/retention/report digest
必须全部闭合；即使 route 恰好与 Qwen `qwen3.6-flash` 相同也不改变 G1。当前没有满足 ADR-0071 persistent supervisor、
protected-ref/control-plane、Linux native isolation 与 retention proof 的 L3 secret CI，CI 只能验证零网络 contract，不能把未运行的 L3 写成兼容或发布结论。

L3 的专用 verifier 从最小 observation schema 和 source-owned execution registry 重建固定的 policy、route、
Matrix/suite、candidate、fixture/corpus/oracle/evaluator/verifier/runner 与 ledger binding；runner 的 Bun metafile
contract 拒绝 generic evidence verifier、产品 config/runtime/MCP/Tool/Skill/Subagent/session graph、source-owned
surface 与 release bundle/gate 的传递依赖。该 verifier shape 与 health parser 都不证明 durable deletion 或 supervisor
authority。未来 implementation/proof 分支中，reservation 后若 dispatcher、sealed cleanup 或 terminal 发生异常/不可置信，runner 才会以
完整 request quota 保守结算并输出 `blocked/not_observed` 与 `providerDispatchCount='unknown'`，不输出 outcome 或
observation digest；可信 pre-dispatch cancellation 才保留 zero dispatch。

AQ-9A 不是 live runner：`auto-compaction-failure-contract.test.ts` 只使用本地 scripted transport 和临时
synthetic root，绝不读取 Provider credential、普通配置、workspace/project/session overlay，也不建立网络、child 或
stdio transport。它以当前 estimator 生成 9–12K 安全 context，并只在测试内采用 8,192 in-memory threshold，注入
`summary_failure`、`provider_failure` 与 `provider_network_failure`。这些结果仅形成 diagnostic、
`evidenceEligible=false` 的 metadata-only receipt，不能声明真实 Provider 兼容、G1 或任何发布准入。

AQ-9B 是与 AQ-8 observation 独立的 L3 auto-compaction 诊断接口。`test:model:auto-compaction:live:success` 与
`test:model:auto-compaction:live:cancel` 保留为将来 wrapper，但当前同样由 checked-in `false` activation 在 source-byte
binding 后、安全地在读取 caller environment/ledger、resolver/reservation/credential lease、scratch 或 child 之前阻断；
独立 opt-in、credential、ledger root 或 health JSON 都不能改变这个结果。因而 public L3 wrapper 当前不能接受真实
`observed_success` 或 `observed_cancelled`，也不会自动重试或借 AQ-9A mock 结果补足。

当前产品链覆盖由 `runSyntheticAutoCompactionContractV1` 的 test-only driver 提供：它只能使用固定 synthetic scenario 或
固定 `operation='test'` child mode，不接收 parent environment、ledger、resolver、credential lease、caller model function
或真实 provider boundary，并且绝不生成 observation、semantic receipt、report、reservation 或 evidence。它通过真实
`AgentKernel → ModelController → Runtime executor/scheduler → runner` 验证 success/cancel product-chain 语义；AQ-9B runner
只在内存中使用 8,192 的绝对阈值和 source-owned 9–10K safe synthetic projection，**不会读取、设置或推断**产品
`contextWindowTokens`（registry 固定为 `unknown/not_declared`），也不改变产品默认值。未来 implementation/proof 的两 phase 路径仍须有
12,229 token cap、JIT preflight 和受控 text-only model output；任何未广告 tool-call/non-allowed effect 必须在
Tool/Skill/MCP/Subagent child executor 前 fail closed。即使未来形成独立 `LiveAutoCompactionSemanticReceiptV1` 与 outer
`LiveCompatibilityObservationV1`，它们也固定 `authority='diagnostic'`、`evidenceEligible=false`，没有 ReleaseEvidence、
bundle、Gate、G0/G1 或 production content admission 输入位。

TUI system 使用 `@xterm/headless` 只在测试进程内解析本地 PTY 控制序列；它不会建立 Provider
连接，也不会改变 live test 发现边界。`tests/tui-system/scenarios/` 仍只连接隔离的本地 mock
model server，不能据此声明真实模型或公网 Provider 已验证。

## E2E 目录归类

`tests/e2e/` 按外部边界分为：

- `local/`：使用本地隔离 fixture 的确定性跨进程 E2E，由 `test:e2e` 执行；
- `live/mcp/`：访问公网或外部 MCP 的显式 opt-in 套件，只能使用 `*.live.ts`；
- `live/model/`：为真实模型 Provider 配额保留的显式 opt-in `*.live.ts` 接口。ADR-0071 formal AQ-8/AQ-9B wrapper 当前均安全停用，不能 dispatch；在 persistent-supervisor implementation/proof branch 落地前，它们只可作为零网络 discovery/contract 边界测试。它们不属于 Required CI，历史或单次通过也不能替代 G1、持续 provider/model 兼容或发布准入验证。ADR-0072 的 GitHub-only runner 不在此目录，也不改变此 formal L3 结论。

`test:e2e` 必须显式指向 `tests/e2e/local/`，不得以整个 `tests/e2e/` 为目标。TUI PTY 继续位于 `tests/tui-system/scenarios/`，因为它有独立的串行 harness 和测试标准。公网 MCP 验证不等于真实模型验证。

Required CI 固定分为 `quality`、`unit`、`compaction-contract`、`runtime-e2e`、`runtime-fault-soak` 与 `tui-system`。其中 `unit` 运行快速 TUI harness，`runtime-e2e` 只执行 `test:e2e` 的本地隔离套件，`runtime-fault-soak` 运行 runtime fault/soak 套件，真实 TUI scenarios 只由 `tui-system` 执行且不重复 harness；`quality` 同时运行文档完整性、文档影响和 compaction legacy symbol 门禁。

`*.live.ts` 是独立 runner，必须由显式 package script 使用 `bun run` 调用；不能用 `bun test` 调用，因为 Bun 的测试发现只执行测试命名文件。

## 新增真实套件的要求

下列要求只适用于 future ADR-0071 implementation/proof branch 经独立安全复审后启用 persistent supervisor 的情形；它们不是当前 AQ-8/AQ-9B wrapper 的可用性声明。

1. 多场景/语义套件必须放在 `tests/e2e/live/model/` 并使用 `*.live.ts`；首发单调用 runner 允许放在 `scripts/evals/`，其 mock contract 才使用 `*.test.ts`。
2. 必须提供使用 `bun run` 的显式 package script/wrapper，且默认测试不能调用它。
3. Wrapper 必须在 model dispatch 前完成预注册 route/policy、quota reservation、超时与并发限制；不得硬编码密钥，credential 只能到 resolver/model boundary，任何 Tool/Skill/MCP/Subagent/stdio child 只能获得明确 allowlist 环境。
4. Provider/model 只能使用 source-owned 预注册 identity；不得从普通用户、项目、workspace 或 session 配置 fallback，连接信息只来自显式资格化 parent environment。
5. 测试输出和 retained metadata 不得记录 API key、完整 endpoint、完整请求、prompt/response/reasoning、源码正文、工作区内容或用户配置；缺前置时只输出脱敏 reason code。
6. 必须更新 `tests/test-discovery.test.ts` 防止真实套件进入默认发现。
7. auto-compaction cancel wrapper 只能以真实 operator `AbortSignal` 验证已进入 summary transport 的取消；它不得注入 provider/network failure，无法观察到 cancel 时必须非零 `blocked`。
8. 完成记录应注明 provider、模型、日期、网络条件和实际运行命令，但不保存 response 正文。

真实套件不存在、未获授权或未运行时，只能报告本地 mock/contract 验证结果。

## 历史 live 记录（非 AQ-8 资格化证据）

下列记录早于 AQ-8 sealed policy、source-owned identity 与 append-only ledger；它们保留为历史兼容性观察，
不能重放、迁移或表述为 `LiveCompatibilityObservationV1`、G1 结果或任何发布准入结论。

2026-08-02 已用用户本机隔离配置显式运行一次 DeepSeek 官方 API 的
`deepseek-v4-flash` direct/incremental compaction smoke，两种场景均返回非空且减少上下文的 summary。
DeepSeek V4 在内部 summary 请求中显式设置 provider option 关闭 thinking，避免 reasoning token 消耗
summary 输出预算；普通 Agent 请求行为不变。该运行只证明当次真实 API 兼容性，不含 GitHub
run/artifact/attestation、正式 suite ledger 或 authenticated evaluator，因此不能登记为 2B.4、4.4 或
route qualification evidence。输出只保留 provider alias、model 与场景名，不记录 key、请求正文或 summary。

`tests/evals/agent-tasks/` 当前同样属于本地 synthetic contract。它覆盖确定性 suite、adversarial ledger、
false completion 与 identity/digest 篡改拒绝；旧重复运行、external participant 与 authenticated promotion
schema 只作为 blocked/failed 负向资产，不再对应产品路线或待完成 Task。nightly dry-run 零 network
dispatch，不能表述为真实 Provider、external 产品用户或正式 Agent task benchmark 已运行。

`tests/evals/compaction/` 也只验证 synthetic schema/matcher/blocked Gate；其中 formal semantic evidence
测试会重建 opaque blind item/receipt ledger、逐项 candidate commitment 和完整 Release/GitHub identity，
但 production OIDC/attestation verifier 为空，不能把 fixture 升级为正式证据。将来获得单独授权并实际运行的
live runner 也只能证明当次 diagnostic Provider 兼容和 compaction 语义；旧 Phase 4 rollout/promotion adapter 已被取代，不产生
milestone 或后续路线图状态。
