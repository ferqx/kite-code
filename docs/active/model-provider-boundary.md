# 当前规则：模型 Provider 边界

状态：active

读取时机：修改模型配置、Model Controller、provider adapter、reasoning、模型上下文、缓存指标或真实 Provider smoke 时。

验证：当前 `packages/builtin-runtime/test`、`packages/runtime-spi/test`、`packages/runtime-host/test`、`tests/runtime/`
Model/compaction/provider suites，以及 `bun run check:core-boundary`、`bun run typecheck`。

相关：ADR-0022、ADR-0023、ADR-0024、ADR-0031、ADR-0066、ADR-0068、ADR-0069、ADR-0093、ADR-0109、ADR-0114、ADR-0115、`private-artifact-storage.md`、`open-source-first-release.md`、`plan-state-reminder.md`、`docs/space/plans/2026-07-21-context-compaction-production-rollout.md`。

## 规则

Kite Code 是 provider-neutral 系统。`deepseek`、`openai`、`openai-compatible` 和 `ollama` 通过 AI SDK 模型边界接入；Runtime Kernel、Tool Controller、Policy 和 Verification 不得依赖某个 provider 的消息类或 SDK。

## Model Surface V1 与唯一 Gateway

RMV1-15 后，`packages/runtime-spi/src/model-surface.ts` 与
`packages/builtin-runtime/src/model/surface-canonicalizer.ts` 封闭定义五类 invocation purpose 及其 Provider
dispatch purpose 映射、
provider-neutral message/tool/route、`ModelSurfaceV1`、`ModelInvocationEnvelopeV1`、
`ModelResponseRecordV1` 和 opaque `PrivateArtifactRefV1`。现有 `ProviderDispatchPurposeV1` 只复用该
Protocol union，避免两份 purpose 列表漂移；这不改变 admission 决策。

Model Surface canonicalizer 使用独立 private domain 的严格 canonical JSON：object key 顺序不影响
identity，message/tool array 顺序和正文 byte 差异保留；`undefined`、非有限数、sparse/accessor/custom
object、closure、未知 message part、未知 contract 字段、stale nested digest 和 credential/endpoint-bearing
provider options 都 fail closed。Surface route 只允许 provider/model/adapter 的无秘密 identity 与 digest，
不接受 API key、authorization header、credential、base URL 或原始 endpoint。

共享 `PrivateImmutableArtifactStorageV1` 与 schema-aware `ModelArtifactStoreV1` 保存 Model Surface、
response 与大尺寸 Provider options。它们使用独立分区、path-free content ref、owner-only/no-follow
单链接文件、file/directory fsync 与 atomic publish；corruption、未知 GC entry 和不完整的全
session/fork reachability 都 fail closed。Artifact 正文不进入 Runtime Event、Session Logger 或 telemetry。
`CapabilityArtifactStore` 复用同一无密钥内容寻址原语，但继续保持独立
`capability-artifacts/results` namespace、schema、ref 与访问边界；Capability receipt 不能写入或读取 Model 分区。

RMV1-16 的源码 caller/owner closure 已切到唯一 App/Host/Builtin seam。五个 `model:*` operation 由 Builtin registry 唯一
注册；每个 App/Host lifetime 只创建一个 `BuiltinModelOperationExecutionPortV1`、一个 Gateway 与一个
`BuiltinModelEffectCoordinatorV1`，均绑定同一 frozen snapshot。App `RuntimeSessionCoordinator`、
`runtime-effect-coordinator.ts`、`runtime-tool-effect.ts` 与 `turn-coordinator.ts` 是唯一 State26 orchestration seam；
Host `tool-pipeline-coordinator.ts` 只负责 generic prepared/ack/receipt/lifecycle mechanism，Kernel 只负责纯 decision/reducer。
Primary、compaction、auto-review、verification-review 与 subagent step 均通过同一 Gateway；Context/Prompt projection、
preflight、Surface、Provider admission、response normalization、cache/usage/tool-call facts 与 completion commit 由
Builtin/App seam 拥有。`packages/builtin-runtime/src/subagent/` 拥有 child Model loop、角色 prompt、Workspace/CWD、
Builtin catalog 与 dynamic MCP overlay；App subagent adapter 只注入 callback。旧 Core/legacy production paths、第二
coordinator、direct model caller 与 fallback 均不存在。RMV1-16 最终 manifest/docs/journey/fault/soak Gate 已全部通过。

MS-03/MS-04 已作为同一个模型迁移 series 接线。`buildContextProjection()` 仍是 primary 最终消息事实源；
每类调用都先由 `compileModelSurfaceV1()` 生成并冻结唯一 Surface，再交给
`ModelInvocationGatewayV1`。Gateway 是唯一拥有 live response attempt/retry orchestration、
admission、Model Artifact protocol 与 response completion handle 的生产入口；旧 `invokeBoundModel()`
及旧 low-level invoke authority 已删除。production composition 只显式构造 live `ModelResponseSourceV1`；
live Source 是唯一可导入 single-attempt transport 的模块，Gateway 直接导入 transport 也由静态边界拒绝。
primary agent、context compaction、auto review、verification review 和 subagent step 五个 purpose 均通过该 Gateway。

2026-08-22 的直接裁决已删除本版 evaluation 与其 ModelReplay catalog、record/replay response source、
suite actor/context 和 CI 入口；生产与测试源码不存在第二种 response source、外部 replay catalog 或
live fallback。产品态 State26 Session restore/Event replay 不属于该 evaluation，继续严格保留。
`ModelAdapterReplayOwnerV1`、`route.replayOwner` 与 `nativeReplayState` 是 Store5 Model Artifact 的既有
序列化兼容字段，仅描述 Provider adapter 对其原生响应状态的 ownership；它们不构成 evaluator、catalog、
cassette 或自动重放 authority，并在 RMV1 中不得重命名或改变形状。后续评测必须另立计划和全新边界。

Gateway、live response source、single-attempt transport、Surface compiler、message conversion、prompt assets、
Context compiler/selection、token/cache accounting、compaction 与 reviewer 的物理实现都位于
`packages/builtin-runtime/src/model/`；provider-neutral evidence contract 位于 `packages/runtime-spi/src/model-surface.ts`。
`kite-builtin-runtime-rmv1-15` 唯一注册五类 Model operation，Legacy operation 列表为空。App composition root 显式
装配 Artifact mechanism 与 live Source，再把 composition port 注入 RuntimeSessionCoordinator；App 不创建
第二 Gateway/Source，也没有 try-new-catch-old 或 live fallback。Model Surface contract 与 concrete implementation
只位于 `packages/runtime-spi/model` 与 `packages/builtin-runtime/model`，State26 typing 由 Kernel/Host seam 提供。

Subagent start/resume 的每个 child model attempt 继续只经同一 coordinator 与 Gateway；Provider 与 Driver 不能取得 transport
或 Model Surface authority。actor identity 由 parent invocation/tool/attempt/role 等不含 task 正文的稳定事实派生；
task/continuation 的 exact identity 只留在 private
Artifact。blocked child 的 auto-review 在 reviewer Gateway dispatch 前必须 exact hydrate private continuation，
reviewed call 是真实 blocked child tool，不是 parent `task` ref。missing/tamper/cross-owner 时 reviewer call count为零。
Subagent blocked/resume 与 Model Artifact readback 由当前 package/App tests 覆盖；生产路径只接受当前 Gateway、Surface、
Artifact、binding 与 attempt identity，不接受外部 catalog 或 transport handle。
Gateway completion finalizer若在 queue-time Task Artifact publication 或其他 response-derived atomic projection中
失败，先 durable `model.invocation_interrupted(persistence_unavailable, attempted)` 再抛错；不能留下 dispatching，
也不能重新调用 Source。重复 tool-call ID 同样在任何 Task publication/queue前走该边界。

静态 Runtime boundary
检查禁止生产源码导入底层 transport、旧 invoke、AI SDK dispatch API 或直接调用 LanguageModel
`doGenerate`/`doStream`；底层 `transport.ts` 每次只执行一个 Provider attempt，SDK retry 固定为零。

一次 live invocation 的顺序固定为：写入不可变 Surface Artifact；执行 configured-provider admission；按同一
冻结 Surface 建立 resource reservation 并持久化 `model.invocation_prepared`；每次实际 attempt 前持久化
`model.invocation_attempt_started`；成功后写入 Response Artifact，再把
`model.invocation_completed`、purpose-owned terminal facts 与实际 resource reconciliation 作为同一 ack
batch 提交。primary 的第一次 attempt 还把 `resource_budget.dispatch_started`、attempt intent 与
`model.requested` 放在同一 batch。completion handle 在该 ack 成功前不会向 Controller、compaction、
reviewer 或 subagent 暴露可消费 response；Artifact/ack/admission 任一步失败都不会降级到底层 transport。
重试的 `model.retry` 在 backoff 开始时持久化，下一 attempt 仍在紧邻 dispatch 前获得独立 ack；Surface
identity 在 prepared 后发生漂移时以零 Provider dispatch fail closed。每次 attempt 都必须在 current admission、
resource reservation、prepared 与当前 attempt ack 之后进入 transport；Source 不能重试或签发下一 attempt。
`perAttemptTimeoutMs` 是 Provider 活动停滞上限，而不是活跃 stream 的固定墙钟寿命：stream 收到任意
Provider part（包括 reasoning、正文与 tool streaming part）都必须刷新该上限；持续有进展的 primary response
不得仅因总生成时间超过 30 秒被中止或重试。无任何 Provider part 的停滞请求以及非 streaming generate 请求
仍受同一有界 attempt timeout 约束；Gateway 继续独占 retry/backoff 与 total retry budget。
live Source 将 Provider 的原始异常保留为进程内 `cause`，但 Gateway 对外始终抛出带结构化 attempt outcome
的失败；Runtime 依据该 outcome（而非错误文案）把耗尽的 timeout、rate limit 与 server/connection retry
统一收敛为 `model_retry_exhausted` terminal。该结构化分类不会把 Provider response body 写入 Runtime Event。

Subagent 的 actor cursor 由 sealed delegation/resume grant 绑定：start continuation 为 null，resume 使用 exact
suspension lineage；每个 sibling 的 ordinal 独立从 1 开始，resume 从 continuation 保存的 ordinal 继续。grant、
continuation 与 current attempt lineage 任一漂移都在 Gateway lookup 前 fail closed。production 只显式构造
live Source。

production composition 使用 owner-only `~/.kite-code/model-artifacts/`，不创建或加载 Artifact
installation key。既有 Artifact 缺失、损坏或路径/权限 identity 不安全时不得覆盖或回退无 evidence dispatch。
Runtime schema 已切换为 v26、format epoch `kite-runtime-modularization-v1-2026-08-19`；
`modelInvocations` 是当前格式的必需 evidence 投影，字段缺失属于 corruption，不从旧 transcript/config
反推历史 Surface。旧格式数据在 Gateway 或 Provider dispatch 前进入 `incompatible_runtime_format`。

restore/fork 对 completed invocation 严格读取并交叉校验 Surface/Response ref、route 与 invocation identity；
Artifact 缺失或损坏时保留已经 ack 的 transcript，但记录
`model.invocation_evidence_unavailable`。prepared 且尚无 attempt
ack 的调用恢复为 `dispatchCertainty=none` 并释放未 dispatch reservation；已有 attempt ack 但无 completion
receipt 的调用恢复为 `unknown`，reservation 进入 reconciliation，不自动重放。Artifact 存在不能解释为
历史响应不能被解释为当前 transport authority；当前生产只依据现行 admission、prepared identity、attempt ack 与
Artifact receipt；恢复路径不自动重放，也没有 live fallback。

- 共享代码使用 `provider`、`providerType`、`baseURL`、`apiKey`、`modelName` 等中立命名。
- Provider 专有 reasoning、缓存指标和请求参数隔离在 `packages/builtin-runtime/src/model/` 或配置解析边界。
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

Provider 真实网络访问不属于默认确定性测试。运行时只能通过唯一
`ModelInvocationGatewayV1`、configured-provider admission 和一次性 transport attempt 进入 Provider；
缺少 composition、resolved route、credential 或 transport 时必须在网络调用前 fail closed。

Gateway 的 admission 不是 release-pinned provider allowlist。它接受用户最终 resolved configuration，
为五种 purpose 生成同一 `admissionRevision`，并在 dispatch 前拒绝 credential-shaped Provider content、
缺失 inspector 或 inspector 的 `unknown/secret` 结果。它不按 prompt role 猜测 DataOrigin，不建立
Workspace classification、EgressAuthority、policy registry、expiry 或 per-route owner approval。DeepSeek、
OpenAI-compatible、本地模型和自定义 endpoint 都遵循同一 configured route 规则；真实 Provider 的
数据条款与用户选择由产品配置/披露承担，不由 Runtime 伪造技术许可。

ResourceBudget 开启时，admission 仍在 reservation/dispatch 前执行。Subagent、compaction、auto review 和
Verification reviewer 不得绕过，也不得把 denial 改写为 Tool approval。只有能够证明外部调用尚未发生的
reservation 才可释放；已有外部 dispatch 的组合 operation 仍按 unknown/reconciliation 收敛。

Model Provider 与 MCP HTTP 是两个独立 transport。两者都使用真实 endpoint/TLS/credential 边界和共享
secret inspector，但不存在跨域 permit、DataOrigin/EgressAuthority 或正文分类 ledger。Session logging
继续 metadata-first；content mode 需要 release capability 与用户双重 opt-in，并永久排除 reasoning、
credential 和任意未 allowlist 的 Runtime 字段。完整日志规则见 `session-logging-policy.md`。

模型上下文能力必须先解析为统一的 `ResolvedModelCapabilities`。每个字段只按所选模型条目的显式配置、provider adapter runtime metadata、`modelKwargs` 兼容字段依次解析，并记录 `explicit_config | adapter_runtime | compatibility_config` source；缺失值保持 unknown，布尔能力保持 true/false/unknown 三态。模型名称和默认模型列表不得提供 context window、max output、tokenizer、usage 或 prompt-cache 能力，也不得为未知输出预算隐式预留 4096 tokens。Capability disclosure、上下文 preflight、metrics 和实际模型请求必须共用同一个 resolved object；未知窗口不显示利用率，也不运行 ratio auto，但不阻止普通模型请求或手动 `/compact`。

模型响应流式能力优先从显式模型配置、adapter runtime metadata 或 `modelKwargs.streaming` 解析；缺失时默认 `true` 且不伪造 source，用户无需配置。正常 Agent 调用使用单步 `streamText`，以累计全文语义实时发出不可持久化的 `model.text_delta` / `model.reasoning_delta`；每段连续 reasoning 另发一次带稳定 `segmentId` 的 `model.reasoning_completed`，Provider 缁少显式 start/end 时由 adapter 在 reasoning→text/tool/流结束边界合成。三种瞬态事件都不进入 reducer、event store、snapshot 或 session log，流结束后仍只由 durable `model.responded` 推进 transcript、工具分发和轮次状态。显式 `streaming: false` 时使用 `generateText`；summary/reviewer 等内部模型调用不切换到此 TUI 流式路径。详见 ADR-0034、ADR-0045。

流式调用的 transient retry 覆盖完整 stream 消费。服务在部分 SSE 后断开时，`model.retry` 冻结已经展示的 text/Thought；重连后的文本总是新开一段。新流重放相同前缀时只派发追平后的新增后缀，reasoning delta 与 completed segment 同样不得重新携带已交付前缀；发生分歧时完整的新生成内容进入新段，旧段不删除。未完整结束的尝试不产生 `model.responded` 或 `tool.queued`，partial tool call 不进入 Runtime；只有成功尝试的 `finalStep` 一次性提交工具调用。恢复后的 delta 或 `model.responded` 清除 TUI retry 状态。完整流重试与工具规则见 ADR-0032，展示规则见 ADR-0033。

连接错误、5xx 与 HTTP `429` 共用同一 bounded attempt/time budget；attempt budget 包含首次请求，time budget 从第一次被分类为可重试的失败开始，不包含该失败之前的首次请求耗时。因此首次 Provider 请求即使长时间阻塞后才出现 socket/网络错误，也必须在 attempt budget 允许时至少进入第一次有界重试；后续重试请求、退避与抖动共同消费 time budget。分类读取 AI SDK `APICallError.statusCode`，同时兼容旧 adapter 的 `status`。429 只能在预算内重试，耗尽后抛出最后一次 rate-limit failure。401 等其他 4xx 不可重试。Provider retry 与 Runtime failure-mode 的 `model_rate_limit → model_retry_exhausted` 终态必须由同一 fault-soak case 同时验证；provider 路径使用本地 HTTP 429 fixture，不用手工 `{status: 429}` 代替。

Summary model 通过同一 provider-neutral AI SDK 边界调用，temperature 固定为确定性设置，不绑定任何工具，SDK retry 固定为零，并限制 max output tokens。Summary dispatch 前必须以所选模型的真实 context window 和 max output capability 校验完整 system prompt、summary input 与输出预留；无法容纳时零 Provider 调用并产生 `oversized_turn`。Configured-provider admission 与普通 Agent 调用使用同一批准策略，拒绝时以脱敏 `provider_admission_denied` 终态收敛 pending。专用请求只产生一份 Markdown narrative；原始输出必须非空、未因 length 截断、没有 tool call、低于 narrative 上限，并通过统一 candidate projection 的绝对缩减验证后才能写入 checkpoint。调用 Provider 前还必须用最小有效 narrative 计算理论最大缩减；无法节省至少 1024 tokens 时以非重试 manual low-gain 终态收敛且保持 Provider call count 为零。Checkpoint 不保存 Provider 原始响应、usage、JSON schema、fact/evidence ledger 或第二份模型内容。手动压缩把全部 safe settled history 交给一次调用；自动压缩仅保护当前 turn；manual 在 Runtime turn 仍 active 时也保护该 turn。增量压缩把旧 narrative 与 checkpoint 后的全部新 safe history 交给同一次调用，并整体替换 active checkpoint。active checkpoint 后没有新 safe history 时，即使带 custom instructions 也不重写已有 narrative；custom instructions 只改变包含新 source 的摘要侧重点。显式输入上限超出时整体失败，不做部分前缀压缩。Compaction effect 不读取旧 `lastPreflight` 参与 acceptance。

Runtime 不解释通用 Provider 术语（模型供应商）HTTP 400，也不通过状态码、错误码或消息子串推断上下文溢出。正常模型请求失败后只展示脱敏错误，不自动创建压缩请求或 `ContextHardBlock`。Summary Provider 请求失败同样不清理工具输出、不分块、不自动重试；脱敏终态按 low-gain、stale、输入过大、输出不可用、checkpoint validation 和通用 Provider 请求失败分类提示，通用失败建议检查模型、credential、连接与 context/output limits，不展示 Provider 原始正文。projection environment 在 summary 期间变化时产生 `stale_context` 可重试终态并清除 pending，不接受旧 checkpoint。live 自动压缩失败或取消时，本 turn 不再发送普通模型请求；下一用户 turn 重新 preflight 后可再次尝试。

Compaction 的 `preparing / summarizing / validating` 是 App-only 进度，不持久化。Completed、failed、cancelled 由 Kernel/App 统一映射为脱敏终态提示并按 `compactionId` 去重。指标 reporter 由 Runtime 组合根注入并由组合根拥有 flush；不存在全局 compaction metrics singleton。三轮 follow-up、稳定 session cohort 和显式 opt-in local debug 都不得记录 summary、transcript、prompt 或工具正文。

压缩原因只允许 `manual | auto`。本地 context pressure 术语（上下文压力）、token ratio 术语（文本计量比例）、绝对 token threshold 术语（文本计量阈值）与 target ratio 术语（目标比例）都只是诊断或自动尝试启发式，不能证明 Provider admission 术语（模型供应商接纳）、阻止普通模型请求或创建 `ContextHardBlock`。`ContextHardBlock` 只接受 Runtime correctness failure 术语（运行时正确性故障）原因。

## 禁止事项

- 不得把 DeepSeek/OpenAI 假设写入 Scheduler、Policy、工具路由或持久化 schema。
- 不得在模型 SDK 的 tool `execute` 中绕过 Runtime 执行工具。
- 不得把真实网络测试混入默认确定性测试。
- 不得在没有实际真实模型套件的情况下声称某 provider 已通过端到端验证。
