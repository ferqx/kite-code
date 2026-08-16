# 当前规则：模型 Provider 边界

状态：active

读取时机：修改模型配置、Model Controller、provider adapter、reasoning、模型上下文、缓存指标或真实 Provider smoke 时。

验证：`bun test tests/model-surface.test.ts tests/model-artifacts.test.ts tests/model-artifact-key.test.ts tests/model-invocation-gateway.test.ts tests/model-invocation-recovery.test.ts tests/model-response-source.test.ts tests/private-immutable-artifacts.test.ts tests/config.test.ts tests/config/provider-data-policy.test.ts tests/model.test.ts tests/model-invoke.test.ts tests/model-provider-data-policy.test.ts tests/model-capabilities.test.ts tests/runtime/model-controller-failures.test.ts tests/runtime/context-compaction-auto.test.ts tests/runtime/resource-budget-admission.test.ts tests/runtime-context.test.ts tests/tui-reducer.test.ts tests/session-manager.test.ts tests/runtime/kernel.test.ts tests/subagent-runner.test.ts tests/scripts/check-core-boundary.test.ts`、`bun run scripts/run-tui-system-tests.ts model-streaming thought-lifecycle`、`bun run check:core-boundary`、`bun run typecheck`。

相关：ADR-0022、ADR-0023、ADR-0024、ADR-0031、ADR-0066、ADR-0068、ADR-0069、ADR-0093、ADR-0109、ADR-0112、`private-artifact-storage.md`、`model-replay-evaluation-policy.md`、`real-model-test-boundary.md`、`open-source-first-release.md`、`plan-state-reminder.md`、`docs/space/plans/2026-07-21-context-compaction-production-rollout.md`。

## 规则

Kite Code 是 provider-neutral 系统。`deepseek`、`openai`、`openai-compatible` 和 `ollama` 通过 AI SDK 模型边界接入；Runtime Kernel、Tool Controller、Policy 和 Verification 不得依赖某个 provider 的消息类或 SDK。

## Model Surface V1 与唯一 Gateway

`src/protocol/model-surface.ts` 与 `src/core/model/surface-canonicalizer.ts` 封闭定义五类 invocation
purpose 及其 Provider data dispatch purpose 映射、
provider-neutral message/tool/route、`ModelSurfaceV1`、`ModelInvocationEnvelopeV1`、
`ModelResponseRecordV1` 和 opaque `PrivateArtifactRefV1`。现有 `ProviderDispatchPurposeV1` 只复用该
Protocol union，避免两份 purpose 列表漂移；这不改变 admission 决策。

Model Surface canonicalizer 使用独立 private domain 的严格 canonical JSON：object key 顺序不影响
identity，message/tool array 顺序和正文 byte 差异保留；`undefined`、非有限数、sparse/accessor/custom
object、closure、未知 message part、未知 contract 字段、stale nested digest 和 credential/endpoint-bearing
provider options 都 fail closed。Surface route 只允许 provider/model/adapter 的无秘密 identity 与 digest，
不接受 API key、authorization header、credential、base URL 或原始 endpoint。

共享 `PrivateImmutableArtifactStorageV1` 与 schema-aware `ModelArtifactStoreV1` 保存 Model Surface、
response 与大尺寸 Provider options 使用独立分区、keyed opaque ref、owner-only/no-follow 单链接文件、
file/directory fsync 与 atomic publish；错误 key、corruption、未知 GC entry 和不完整的全 session/fork
reachability 都 fail closed。Artifact 正文不进入 Runtime Event、Session Logger 或 telemetry。当前
`CapabilityArtifactStore` 已在 TP-03 复用同一安全原语和 installation key，同时继续保持独立
`capability-artifacts/results` namespace、schema、ref 与访问边界；Capability receipt 不能写入或读取 Model
分区。key loader 在任一受治理 evidence namespace 已存在时都禁止生成替代 key，避免 Capability 接线使历史
Model evidence 失去 identity。

MS-03/MS-04 已作为同一个模型迁移 series 接线。`buildContextProjection()` 仍是 primary 最终消息事实源；
每类调用都先由 `compileModelSurfaceV1()` 生成并冻结唯一 Surface，再交给
`ModelInvocationGatewayV1`。Gateway 是唯一拥有 response source 选择、attempt/retry orchestration、
admission、Model Artifact protocol 与 response completion handle 的生产入口；旧 `invokeBoundModel()`
及 `src/core/model/invoke.ts` 已删除。production composition 只显式构造 live `ModelResponseSourceV1`；
live Source 是唯一可导入 single-attempt transport 的模块，Gateway 直接导入 transport 也由静态边界拒绝。
primary agent、context compaction、auto review、verification review
和 subagent step 五个 purpose 均通过该 Gateway，评测脚本也使用显式 evidence session。静态 Core boundary
检查禁止生产源码导入底层 transport、旧 invoke、AI SDK dispatch API 或直接调用 LanguageModel
`doGenerate`/`doStream`；底层 `transport.ts` 每次只执行一个 Provider attempt，SDK retry 固定为零。

一次 live invocation 的顺序固定为：写入不可变 Surface Artifact；执行 Provider data admission；按同一
冻结 Surface 建立 resource reservation 并持久化 `model.invocation_prepared`；每次实际 attempt 前持久化
`model.invocation_attempt_started`；成功后写入 Response Artifact，再把
`model.invocation_completed`、purpose-owned terminal facts 与实际 resource reconciliation 作为同一 ack
batch 提交。primary 的第一次 attempt 还把 `resource_budget.dispatch_started`、attempt intent 与
`model.requested` 放在同一 batch。completion handle 在该 ack 成功前不会向 Controller、compaction、
reviewer 或 subagent 暴露可消费 response；Artifact/ack/admission 任一步失败都不会降级到底层 transport。
重试的 `model.retry` 在 backoff 开始时持久化，下一 attempt 仍在紧邻 dispatch 前获得独立 ack；Surface
identity 在 prepared 后发生漂移时以零 Provider dispatch fail closed。record/replay 同样在 current admission、
resource reservation、prepared 与当前 attempt ack 之后才允许 append/lookup；Source 不能重试或签发下一 attempt。

production composition 使用 owner-only `~/.kite-code/model-artifacts.key` 与
`~/.kite-code/model-artifacts/`。只有尚无既有 evidence namespace 时才可创建新 key；既有 Artifact 对应 key
缺失、损坏或权限/identity 不安全时不得用新 key 覆盖，也不得回退无 evidence dispatch。Runtime schema
仍是 v24、format epoch 仍是 `kite-runtime-2026-08-15`：`modelInvocations` 是同 epoch 的加法 evidence
投影，旧 snapshot 只在该字段完全缺失时归一为空表，不反推历史 Surface。只有 CUT-01 可切换 epoch。

restore/fork 对 completed invocation 严格读取并交叉校验 Surface/Response ref、route 与 invocation identity；
Artifact 缺失、损坏或 key unavailable 时保留已经 ack 的 transcript，但记录
`model.invocation_evidence_unavailable`，该 invocation 不具备 strict replay 资格。prepared 且尚无 attempt
ack 的调用恢复为 `dispatchCertainty=none` 并释放未 dispatch reservation；已有 attempt ack 但无 completion
receipt 的调用恢复为 `unknown`，reservation 进入 reconciliation，不自动重放。Artifact 存在不能解释为
历史响应已可 replay。RP-00 已建立 cassette 内容域、suite authority 与 risk promotion policy；现有
12-case suite 在 replay 语义中仍是 candidate，gate disabled。任何 evaluation replay 都必须先重跑当前 provider-data/
resource admission 并取得 attempt ack，再查 catalog；历史 admission 或 cassette 不构成当前 dispatch authority。
RP-01 已提供 strict `ModelAttemptOutcomeV1` catalog parser 及显式 record/replay Source 构造，但 production 仍只
使用 live。replay Source 无 model/key/transport 参数，miss/corruption/route-owner mismatch typed fail closed，
不存在 live fallback。RP-02 的独立 deterministic pilot 仍是 candidate-only；RP-03 另以受审查 manifest
批准由该 pilot 与五条 purpose/outcome risk contract 组成的六 case evaluation suite，并在 Required CI 运行
keyless replay gate。该批准不进入 production composition，也不授予历史 Artifact replay authority；V1 manifest
继续拒绝非空 `replayDigest` 与 native replay state。

- 共享代码使用 `provider`、`providerType`、`baseURL`、`apiKey`、`modelName` 等中立命名。
- Provider 专有 reasoning、缓存指标和请求参数隔离在 `src/core/model/` 或配置解析边界。
- 文件工具超长输出在最后完整行处截断并报告省略行数（如 `... (25 more lines omitted)`），避免发送拆散行号的散碎文本给模型。
- Model Controller 将 provider 输出规范化为 Runtime transcript/events；上游不读取私有响应对象。
- `model.responded` 事件必须把模型调用时长（`kite_code.model.duration_ms`，来自 `model.responded.durationMs`）持久化进会话日志属性；TUI 阶段块的 `Thinking Xs` 计时（thought-pre-consolidation.md 规则 11/22）依赖此字段，缺失时回放回退墙钟。
- Provider 是否支持 tool calling 与上下文预算会影响 Capability disclosure，但不能改变授权语义。
- 模型发起 `ask_user` 时，每个选项必须显式提供 `label`、`description` 与 `recommended` 布尔值；
  恰好一个选项为推荐项。这个结构化契约让 Runtime/TUI 可以稳定投影推荐选择，不依赖选项顺序或
  自然语言猜测。
- Provider 边界代码（deepseek middleware 的 `transformParams`、Surface/transport 消息转换、SessionRuntime
  错误重试解析）使用严格类型化访问，不依赖 `any` 转义；`model.retry` 事件从错误对象的
  `attempt/maxAttempts/error/delayMs` 字段显式解析，缺失字段按 0/空串兜底。
- API key、base URL 和本地模型配置不得写入测试 fixture、日志或文档。
- TUI 模型选择把不含 credential 的 route 以 `model: "provider:model name"` 写入用户配置；只按
  第一个 `:` 分隔，允许 model name 自身包含冒号。加载器继续兼容旧的 `model.default` 对象格式。
  该个人选择优先于项目提供的初始默认值，重启后继续使用。若 route 已从有效 provider/model
  列表移除，加载器忽略陈旧选择并按现有 provider 默认规则回退。
- 同一选择还必须以完整 `provider + model name` route 绑定到当前会话。普通模型调用、上下文投影和
  压缩均读取该会话配置，而不是 TUI 启动时的静态默认值；切换会话、重启后恢复历史会话或从检查点
  派生会话时恢复各自 route。新会话使用最近一次全局选择，已有会话之间不得互相覆盖模型配置。

首发 G1 使用 `scripts/evals/live-provider-smoke.ts` 做两次独立低成本调用：DeepSeek 固定
`deepseek-v4-flash`，OpenCode Go 通过 `openai-compatible` adapter 调用。runner 只从环境变量或本机配置读取
credential，不自动读取项目 `.env`；输出只含 provider alias、model、耗时、usage 和布尔结果，不含
prompt、response、key、完整 endpoint 或错误 response body。缺 credential/非空 response/超时任一条件
都以非零退出，不得由 mock 结果替代。DeepSeek 调用复用模型绑定的 bounded-summary provider option，
显式关闭 thinking，避免 16-token smoke 预算被 reasoning 消耗而产生空正文。
OpenCode Go 环境凭据与本机配置路径都必须使用 `https://opencode.ai/zen/go/v1` 端点和
`deepseek-v4-flash` 模型。其他域名/path、HTTP、非默认端口、query/fragment 或模型都 fail closed，
不能接收该 smoke 的 credential。该 reasoning 模型使用 128 output token 上限，既保持低成本，又为
非空正文保留足够预算。

`ProviderDataPolicyV1` 是 production route 数据边界的版本化 schema。资格绑定
provider type、operator、规范化 endpoint origin、endpoint class、deployment 和 region 的
canonical identity digest；具体批准项还可在 resolved config 映射边界收紧 model 和 URL。
仓库受控 snapshot 位于 `release/provider-data-policies/`；当前 D-14.3 bundle 只批准 DeepSeek
官方 API 的 `deepseek-v4-flash` model route。`providerDataPolicyV1` 默认关闭；启用后 Model
Controller 必须在 Provider dispatch 前取得由受控 bundle 构造的 registry/gate，缺失、
未生效、过期、digest/route identity 漂移、payload kind 越权或数据分类越权全部 fail closed。
`limited` profile 的 unknown route 一律拒绝；自定义 endpoint 只能进入显式
`internal_experimental` 路径，不能产生 production 资格。

生产 loader 只能读取仓库固定的 `approved-v1.json`，并同时校验编译期 revision 与 SHA-256
digest；调用方不能传入文件路径或期望 digest。Runtime 从最终 resolved `AgentConfig` 构造
route identity。启用 flag 时，最终 `ModelInvocationGatewayV1` dispatch 边界强制要求 gate，普通模型、
context compaction、Sub-agent、auto review 与 Verification reviewer 都不能绕过。Runtime 在
启动时发出不含 endpoint/payload 的 `provider.data_policy_status`，供 CLI/TUI 显示批准状态。
ResourceBudget 与该门禁同时开启时，所有模型 purpose 都在创建 reservation 前执行同一确定性 admission；
Subagent 等已建立 child attempt 的路径若在最终本地门禁被拒绝，必须以
`local_provider_admission_denied` 证明释放，不能标记为已外发的 unknown，也不能出现
`dispatch_started` 后的 Provider 网络调用。Compaction、auto review 与 Verification reviewer
不得把 `ProviderDataAdmissionError` 转成普通业务失败或 inconclusive 后核销预算；异常必须
穿透至 Runtime reservation owner。只有整个 reservation 都能证明尚未外发/执行时才按同一
未外发证明释放；组合 Verification 若前序 command、MCP 或 reviewer check 可能已经 dispatch，
reservation 必须转为 `unknown` 并进入 reconciliation，不能整体退款。

Provider admission payload 为每段正文保留 `user_prompt | file_snippet | tool_result | summary`
provenance 和 Workspace data label。Runtime 组合根把与 session logging 相同的 content inspector
实例注入 admission，避免两条外发边界出现 detector drift；每段正文都必须得到 `clear`，inspector
抛错或返回 `unknown` 与返回 `secret` 一样在 dispatch 前 fail closed。`secret` label、runtime secret
detector、credential marker 或 protected-path marker 在 mocked/real Provider 收到请求前独立阻断。状态投影只暴露 route
alias、允许分类、retention/training/logging 用途和 policy/registry revision，不暴露 endpoint
origin。用户、项目或 CLI 配置不能向 registry 增加 policy，也不能放宽仓库批准 bundle。

首个候选已按 D-14.3 提升为批准项：只接受 resolved config 中 `providerType=deepseek`、
`modelName=deepseek-v4-flash` 和 `https://api.deepseek.com` 或其 `/v1` path；canonical route 记录
`operatorId=hangzhou-deepseek-ai`、`deploymentId=deepseek-api`、`region=unspecified`。其他模型、
其他 host、HTTP、非默认端口、URL credentials/query/fragment 都不会映射到批准 identity，因而
fail closed。2026-02-10 官方隐私政策披露的中华人民共和国处理/存储、可能用于训练和个人数据训练
opt-out，以及未承诺固定 API 正文 retention、未提供 DPA 和 deployment region，均由 single owner
在 ADR-0066 中显式接受，不再作为该精确 Route 的 admission blocker。下游产品仍是自身数据控制者，
必须用 `deepseek-route-disclosure-d14.3` 在 README/active/book 发行文档透明披露；当前 pre-release
single-maintainer 决策不要求 per-run acknowledgement，也不把 disclosure receipt 作为 admission
前置。policy 于 2026-09-01 失效，复核缺失时自动拒绝。

只读治理资产 `release/provider-data-policies/candidates-v1.json` 保留 promotion 与官方来源记录，
production admission 仍只读取 `approved-v1.json`，不能把模型存在或本地可调用解释为生产数据资格。
candidate loader 要求
四种治理目的各恰好一个 official source，并固定 HTTPS origin：model catalog/context cache 只能来自
`api-docs.deepseek.com`，terms/privacy 只能来自 `cdn.deepseek.com`；credentials、非默认端口、HTTP、
其他 hostname、重复 purpose、来源缺失或过期都 fail closed。域名约束只证明来源入口正确；生产资格
来自 owner 的 D-14.3 风险接受、精确 Route identity、披露和新鲜 approved policy 的共同约束。

Model Provider admission 与 remote HTTP MCP content egress 是两个独立授权域。模型 route 的
policy/consent 即使允许 `confidential` payload，也不能签发、复用或替代
`RemoteMcpEgressPermitV1`；反向同样成立。Tool effects approval 与 host/network admission 也不
构成正文外发许可。当前 secondary evaluator 仍默认关闭，且没有消费生产正文的旁路。

`WorkspaceDataLabelV1` 固定 `public < internal < confidential < secret` 的 deny-wins 顺序。
artifact/admin/project rule/runtime secret detector 只能提高分类；用户主动粘贴或项目配置不能降低
已有分类，也不自动产生外发授权。缺少细粒度 provenance 时，system/assistant 最低为
`internal`，user/tool 最低为 `confidential`；不能把任意正文硬编码成较低分类。auto review 与
Verification reviewer 还要求 policy 明确允许 production content evaluation。日志策略固定
metadata-first 的 7 天、总量 256 MiB、单 session 16 MiB 上限，并永久禁止
reasoning/file/tool content 字段；metadata mapper、CLI/TUI resolved mode/status 和 content
双重 opt-in 已完成。session storage 已使用 owner-only 权限/ACL、no-follow append、durable
active-session lease、bounded retention/容量回收和 fail-closed legacy quarantine；当前行为见
`session-logging-policy.md`。

模型上下文能力必须先解析为统一的 `ResolvedModelCapabilities`。每个字段只按所选模型条目的显式配置、provider adapter runtime metadata、`modelKwargs` 兼容字段依次解析，并记录 `explicit_config | adapter_runtime | compatibility_config` source；缺失值保持 unknown，布尔能力保持 true/false/unknown 三态。模型名称和默认模型列表不得提供 context window、max output、tokenizer、usage 或 prompt-cache 能力，也不得为未知输出预算隐式预留 4096 tokens。Capability disclosure、上下文 preflight、metrics 和实际模型请求必须共用同一个 resolved object；未知窗口不显示利用率，也不运行 ratio auto，但不阻止普通模型请求或手动 `/compact`。

模型响应流式能力优先从显式模型配置、adapter runtime metadata 或 `modelKwargs.streaming` 解析；缺失时默认 `true` 且不伪造 source，用户无需配置。正常 Agent 调用使用单步 `streamText`，以累计全文语义实时发出不可持久化的 `model.text_delta` / `model.reasoning_delta`；每段连续 reasoning 另发一次带稳定 `segmentId` 的 `model.reasoning_completed`，Provider 缁少显式 start/end 时由 adapter 在 reasoning→text/tool/流结束边界合成。三种瞬态事件都不进入 reducer、event store、snapshot 或 session log，流结束后仍只由 durable `model.responded` 推进 transcript、工具分发和轮次状态。显式 `streaming: false` 时使用 `generateText`；summary/reviewer 等内部模型调用不切换到此 TUI 流式路径。详见 ADR-0034、ADR-0045。

流式调用的 transient retry 覆盖完整 stream 消费。服务在部分 SSE 后断开时，`model.retry` 冻结已经展示的 text/Thought；重连后的文本总是新开一段。新流重放相同前缀时只派发追平后的新增后缀，reasoning delta 与 completed segment 同样不得重新携带已交付前缀；发生分歧时完整的新生成内容进入新段，旧段不删除。未完整结束的尝试不产生 `model.responded` 或 `tool.queued`，partial tool call 不进入 Runtime；只有成功尝试的 `finalStep` 一次性提交工具调用。恢复后的 delta 或 `model.responded` 清除 TUI retry 状态。完整流重试与工具规则见 ADR-0032，展示规则见 ADR-0033。

连接错误、5xx 与 HTTP `429` 共用同一 bounded attempt/time budget；attempt budget 包含首次请求，time budget 从第一次被分类为可重试的失败开始，不包含该失败之前的首次请求耗时。因此首次 Provider 请求即使长时间阻塞后才出现 socket/网络错误，也必须在 attempt budget 允许时至少进入第一次有界重试；后续重试请求、退避与抖动共同消费 time budget。分类读取 AI SDK `APICallError.statusCode`，同时兼容旧 adapter 的 `status`。429 只能在预算内重试，耗尽后抛出最后一次 rate-limit failure。401 等其他 4xx 不可重试。Provider retry 与 Runtime failure-mode 的 `model_rate_limit → model_retry_exhausted` 终态必须由同一 fault-soak case 同时验证；provider 路径使用本地 HTTP 429 fixture，不用手工 `{status: 429}` 代替。

Summary model 通过同一 provider-neutral AI SDK 边界调用，temperature 固定为确定性设置，不绑定任何工具，SDK retry 固定为零，并限制 max output tokens。Summary dispatch 前必须以所选模型的真实 context window 和 max output capability 校验完整 system prompt、summary input 与输出预留；无法容纳时零 Provider 调用并产生 `oversized_turn`。Provider data admission 与普通 Agent 调用使用同一批准策略，拒绝时以脱敏 `provider_admission_denied` 终态收敛 pending。专用请求只产生一份 Markdown narrative；原始输出必须非空、未因 length 截断、没有 tool call、低于 narrative 上限，并通过统一 candidate projection 的绝对缩减验证后才能写入 checkpoint。调用 Provider 前还必须用最小有效 narrative 计算理论最大缩减；无法节省至少 1024 tokens 时以非重试 manual low-gain 终态收敛且保持 Provider call count 为零。Checkpoint 不保存 Provider 原始响应、usage、JSON schema、fact/evidence ledger 或第二份模型内容。手动压缩把全部 safe settled history 交给一次调用；自动压缩仅保护当前 turn；manual 在 Runtime turn 仍 active 时也保护该 turn。增量压缩把旧 narrative 与 checkpoint 后的全部新 safe history 交给同一次调用，并整体替换 active checkpoint。active checkpoint 后没有新 safe history 时，即使带 custom instructions 也不重写已有 narrative；custom instructions 只改变包含新 source 的摘要侧重点。显式输入上限超出时整体失败，不做部分前缀压缩。Compaction effect 不读取旧 `lastPreflight` 参与 acceptance。

Core 不解释通用 Provider 术语（模型供应商）HTTP 400，也不通过状态码、错误码或消息子串推断上下文溢出。正常模型请求失败后只展示脱敏错误，不自动创建压缩请求或 `ContextHardBlock`。Summary Provider 请求失败同样不清理工具输出、不分块、不自动重试；脱敏终态按 low-gain、stale、输入过大、输出不可用、checkpoint validation 和通用 Provider 请求失败分类提示，通用失败建议检查模型、credential、连接与 context/output limits，不展示 Provider 原始正文。projection environment 在 summary 期间变化时产生 `stale_context` 可重试终态并清除 pending，不接受旧 checkpoint。live 自动压缩失败或取消时，本 turn 不再发送普通模型请求；下一用户 turn 重新 preflight 后可再次尝试。

Compaction 的 `preparing / summarizing / validating` 是 App-only 进度，不持久化。Completed、failed、cancelled 由 Core 统一映射为脱敏终态提示并按 `compactionId` 去重。指标 reporter 由 Runtime 组合根注入并由组合根拥有 flush；不存在全局 compaction metrics singleton。三轮 follow-up、稳定 session cohort 和显式 opt-in local debug 都不得记录 summary、transcript、prompt 或工具正文。

压缩原因只允许 `manual | auto`。本地 context pressure 术语（上下文压力）、token ratio 术语（文本计量比例）、绝对 token threshold 术语（文本计量阈值）与 target ratio 术语（目标比例）都只是诊断或自动尝试启发式，不能证明 Provider admission 术语（模型供应商接纳）、阻止普通模型请求或创建 `ContextHardBlock`。`ContextHardBlock` 只接受 Runtime correctness failure 术语（运行时正确性故障）原因。

## 禁止事项

- 不得把 DeepSeek/OpenAI 假设写入 Scheduler、Policy、工具路由或持久化 schema。
- 不得在模型 SDK 的 tool `execute` 中绕过 Runtime 执行工具。
- 不得把真实网络测试混入默认确定性测试。
- 不得在没有实际真实模型套件的情况下声称某 provider 已通过端到端验证。
