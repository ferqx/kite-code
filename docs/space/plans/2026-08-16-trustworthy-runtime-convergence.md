# 可信 Runtime 收敛：Model Surface、Tool Pipeline、Replay 与受治理 Provider

状态：active

日期：2026-08-16

范围：Core Runtime、模型调用、工具执行、私有 artifact、评测；不包含通用插件生态、远端工作区或新的产品发布承诺。

当前行为权威：源码与测试、docs/active/、已接受 ADR。本文是经用户确认的实施契约，记录任务依赖与验收条件；它不能替代 active 文档或 ADR，也不能让尚未完成的 Task 提前成为当前行为。

## 1. 目标与边界

Kite 的目标不是复刻 DeepSeek Harness 的 Cordis 或 “everything is plugin” 体系，而是把既有的 Kernel、Capability Binding、Policy、Receipt、Verification、Recovery 和 Eval 形成一条更可证明的闭环。

本文按四个阶段设计：Model Surface V1、Tool Pipeline V1、LLM Replay V1、Governed Provider Seams V1。

依赖顺序：

          Phase 1 Model Surface
                    ↓
          Phase 2 Tool Pipeline
                 ↙   ↘
    Phase 3 LLM Replay   Phase 4 Governed Provider Seams
                              ↓
                       CUT-01 format epoch

Replay engine 严格依赖 Phase 1；完整的 replay execution gate 还依赖 Phase 2 的 terminal/receipt 语义。Phase 4 必须建立在 Phase 2 已有明确 dispatch 边界之后。不得并行引入通用插件注册表。

`CUT-01` 是唯一的 Production Runtime format epoch 切换点；它只在 Model、Tool Pipeline 和三条 Local Provider seam 都已迁移且不再存在旧 dispatch 路径时执行。Phase 3 可在同一证据边界上独立推进，但不为未完成的 Tool/Provider 迁移提供 production fallback。

本计划明确不做：

- 不引入 Core 中的动态插件发现、通用依赖注入容器或 everything-is-plugin 模型。
- 不将 Runtime Event 的状态权威转移到 artifact、trace 或 session logger。
- 不把流式文本或 reasoning delta 变成 Runtime 状态转换来源。
- 不把模型 replay 表述成真实模型质量、生产可用性或发布证据。
- 不允许 Provider seam 绕过 Capability Binding、Policy、approval、execution boundary、receipt 或 verification。

## 2. 现状、缺口与架构不变量

### 2.1 现有基础

当前 ContextProjection 已经统一生成系统消息、压缩摘要、transcript、动态 Runtime 消息、最终 provider messages 与 token estimate。Model Controller 会在模型调用前完成工具 disclosure、MCP binding、上下文预算和 provider data admission。

当前 Tool Controller 已涵盖解析、MCP binding/schema 检查、Policy/approval、MCP egress、subagent、durable MCP invocation record、artifact receipt、verification request 与 recovery，但这些阶段仍高度交织。

当前 Runtime Kernel 以 Runtime Event 到 reducer 到 snapshot 为状态权威；工具副作用已经具备重要的 intent、recovery journal 和 verification 基础。Session logger 是 metadata-first 观测产品，不是模型请求或原始工具结果的保存位置。

### 2.2 关键缺口

1. Model Requested 目前只有请求标识，无法在项目指令、Skill、能力目录、binding、sandbox、模型参数变化后重建历史 provider request。
2. 低层模型调用散布在主 Agent、context compaction、auto review、verification review 与 subagent 路径；没有唯一的模型证据边界。
3. 工具阶段在语义上存在，但没有可独立约束的 stage contract。
4. Kernel event replay 不等于 LLM response replay；当前没有严格的、无 API key 的模型响应 catalog。
5. MCP 有清晰的 Runtime Provider contract；Filesystem、Sandbox 和 Subagent 仍主要是实现边界，尚无同等级、受治理的执行后端契约。

### 2.3 全阶段不变量

1. Runtime Event 和 reducer 仍是唯一可恢复状态权威。artifact 是不可变证据，不能直接驱动状态转换。
2. 任何模型 attempt 或工具 Provider dispatch（包括 read-only observation、provider readiness 和 mutation prepare）前必须具备持久化意图证据；证据 ack 失败，dispatch 必须为零。RuntimeStore、artifact persistence、project instruction discovery 等受信 infrastructure I/O 不属于工具 Provider dispatch。
3. 外部副作用后的 receipt 无法提交时，恢复状态必须为 unknown，不得伪装成 success 或允许盲目重试。
4. 私有的 ModelSurface artifact 与 ModelResponse artifact 为了精确重建必然承载模型可见输入/输出正文；artifact 本体不属于 Runtime Event、Session Logger 或遥测载荷。所有新增 model.invocation 事件、artifact reference 和 metadata logger 永不携带正文。既有 user.message_appended、model.responded 和 tool terminal event 仍按 transcript 恢复所需保存其已接受的正文字段；V1 不伪装成 response artifact 能从 Runtime Event Store 删除这些已有内容。Session Logger 继续严格遵循现有 off、metadata、content policy：metadata 永不记录正文，content 仅在双重 opt-in 与 secret detector clear 后记录允许的 user/model-visible answer。
5. 任何 replay miss、artifact 损坏、route ownership 不匹配或持久化失败都 fail closed；不得回退到 live Provider。
6. 所有 Provider adapter 只能返回受限 observation，不能写 Runtime Event、改变 Runtime State、做 Policy 决定或调用 approval。
7. 任何新 Core contract 均须 protocol-first，且 src/core 不得依赖 src/app 或 TUI 展示类型。
8. 本计划采用新 Runtime format epoch，不提供旧请求或旧工具 dispatch 路径的运行时 fallback。只有 CUT-01 能切换该 epoch；在此之前，未完成的迁移只能存在开发分支/未合并 task 中，不能作为生产 Runtime 的降级模式。

## 3. DeepSeek Harness 参考模式与采用边界

本计划参考 deepseek-ai/deepseek-harness，研究基线为 2026-08-16 获取的 master commit 47f943859bef60e4160492346772ded9b24f765a。Harness 当前仍是 developer preview，声明可发生 breaking changes，因此只能作为设计参考，不能成为 Kite 当前行为权威。

| Harness 模式 | 可借鉴的设计事实 | Kite 的采用方式 | 明确不采用 |
| --- | --- | --- | --- |
| durable session event 与 live agent control 分离 | durable 事件用于重放；live coordination/status 不是持久化重放 API | Model Surface 与 tool receipt 进入私有 artifact 加 Runtime Event 引用；流式 UI 仍保持 ephemeral | 用 UI/live bus 取代 Kernel 事件日志 |
| snapshot harness 的 record/replay/refresh 加 llm-replay 插件 | replay 默认无 key；record 才读取密钥；fixture 驱动 keyless 回归；插件本身从已录 session log 推导 stream | record、live、replay 三种显式模式；CI 只运行 replay | 在每次提交调用真实模型，或 replay miss 自动联网 |
| adapter-owned native replay state | 只有历史和当前 route 都由同一个精确 adapter instance 拥有时才可恢复；adapter 自行判断合法性 | opaque native state 由当前 adapter 显式 canRestore 判定 | 依据 provider/model 名称或 protocol version 猜测跨 adapter 兼容性 |
| SandboxProvider 抽象 seam | sandbox 是执行后端，不是 Policy 本身 | SandboxExecutionProvider 接受已授权 grant，返回能力证据 | 通用 run(command) 接口，或将 sandbox 作为可提升权限的 plugin |
| canonical tool result 与 presentation 分离 | canonical value 和 UI 投影分开，replay 不依赖临时卡片状态 | Pipeline receipt 是 canonical evidence，TUI 仅消费事件投影 | 为了展示把 UI 格式混入模型结果或 receipt |

参考来源：

- https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/docs/agent-lifecycle.md
- https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/vitest.snapshot.config.ts
- https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/test-support/llm-replay/README.md
- https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/docs/cookbook/adding-an-llm-adapter.md
- https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/docs/subsystems/sandbox.zh.md
- https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/docs/cookbook/adding-a-tool.md

Harness 的组件化和 replay 纪律值得学习；Kite 则保留“所有重要动作都必须经过治理、证据和验证”的产品约束。

Harness 将 assistant chunk 作为 durable session event 用于重构 stream；Kite 当前 model.text_delta、model.reasoning_delta 和 model.reasoning_completed 刻意保持 ephemeral。本文借鉴 durable/live 分层与 strict consumption，不改变 Kite 的 delta 持久化策略。

## 4. Phase 1 — Model Surface V1

### 4.1 目标

建立如下强制边界：

    Runtime State + frozen environment
      → deterministic ModelSurface compiler
      → immutable private surface artifact
      → durable invocation prepared acknowledgment
      → Provider dispatch
      → immutable response artifact
      → terminal Runtime Event

“模型看到的一切可重建”定义为：Kite 在调用 Provider SDK 前编译出的完整、provider-neutral semantic request 可由历史 artifact 精确重建。它不虚假承诺重建 Provider 内部不可观测的 HTTP 序列化或服务端隐式行为。

### 4.2 契约

新增 src/protocol/model-surface.ts，定义下列 protocol-first 类型；src/core/model/surface-compiler.ts 和 Gateway 只实现它们：

    ModelSurfaceV1
    ModelInvocationEnvelopeV1
    CanonicalModelMessageV1
    CanonicalToolDeclarationV1
    ModelRouteIdentityV1
    ModelResponseRecordV1
    PrivateArtifactRefV1

ModelSurfaceV1 至少包含：

| 区域 | 必填字段 |
| --- | --- |
| schema | 固定 schema 名、canonicalizer 版本、surface format version |
| purpose | primary_agent、context_compaction、auto_review、verification_review、subagent；并与现有 provider dispatch purpose 有显式映射 |
| route | provider kind、model name、adapter protocol version、无秘密 route fingerprint、稳定且无秘密的 adapter replay-owner descriptor |
| semantic request | 合并后的 system、canonical messages、canonical tools、temperature、max output、single-step stop policy、stream/generate transport mode、固定为零的 SDK retry、resolved capability value/digest、canonical provider options 或其私有 option artifact ref/digest |

ModelInvocationEnvelopeV1 不进入 surfaceDigest，至少包含：

| 区域 | 必填字段 |
| --- | --- |
| surface reference | 私有 Surface artifact ref、surface integrity identifier |
| admission | provider data policy revision、route identity digest、payload classification digest、admitted decision；不保存原始 payload 分类内容 |
| provenance | invocation、thread、turn、parent invocation/tool、state revision、context checkpoint、prompt contract、projection environment digest、capability binding digest |
| resource | reservation identity 或明确的 no-budget 标记、有界 attempt/time budget |

purpose 与当前 provider dispatch purpose 的 mapping 在 protocol 中封闭定义：primary_agent 对应 primary_model，context_compaction 对应 compaction，auto_review 对应 auto_review，verification_review 对应 verification_review，subagent 对应 subagent。新增 purpose 必须同时更新两边，不得自由字符串扩展。

约束：

- Surface 是 Core 自有 CanonicalModelMessageV1 与 CanonicalToolDeclarationV1，不直接持久化 AI SDK ModelMessage 类型。Gateway 从同一 ModelSurfaceV1 编译 SDK request，避免“保存一种请求、实际发送另一种请求”。Runtime 在资源 admission 前只编译一次 Surface，后续预算、artifact、Gateway 和 transport 共用该冻结对象，不得只用 token count 相等代替请求同一性。
- system 合并、工具 execute handler 移除、工具声明、temperature、max output、stop policy、stream/generate 选择、SDK retry=0 和 provider options 都进入 semantic request；Gateway 的 bounded attempt/time plan 进入 ModelInvocationEnvelopeV1，不由 SDK 私自 retry。
- Surface 内的工具只保存模型可见的纯数据，绝不保存 executable closure。
- provider API key、authorization header、credential、原始机密 endpoint 不得出现在 route 或 event 中。
- surfaceDigest 使用私有 domain-separated canonical JSON，只覆盖决定 Provider dispatch 语义的 ModelSurfaceV1。invocation、thread、turn、state revision、reservation、admission decision、当前时间、进程 ID 和临时 artifact 路径不进入 surfaceDigest；它们通过 ModelInvocationEnvelopeV1 与 Surface 引用关联。
- 写入 Runtime Event 与 metadata logger 的 artifact locator 必须是 opaque/keyed identifier，不得暴露原始 surfaceDigest、responseDigest 或由它们可直接推导的相对路径。安装级 integrity key 缺失或无法验证时 artifact evidence fail closed，不使用新 key 猜测历史身份。
- 若 Prompt 中存在二进制、附件或 provider-native message part，必须有 lossless JSON-safe canonical projection；无安全投影时拒绝该调用。

### 4.3 Artifact、事件与提交顺序

新增 ModelArtifactStoreV1，独立于 CapabilityArtifactStore：

    model-artifacts/
      surfaces/<opaqueArtifactId>.json
      responses/<opaqueArtifactId>.json

Store 在私有域内使用不可变内容寻址，对外只暴露 keyed opaque locator；同时要求 root canonicalization、no-follow、拒绝 symlink/reparse/hardlink、exclusive temp、file 与 directory fsync、原子 rename、并发同 digest winner/loser 规则、digest 回读校验、目录 0700 和文件 0600。artifact 内容永远不进入 Session Logger；event 只保留 opaque artifact reference、keyed integrity identifier、byte length、purpose、route fingerprint 与故障码。GC 还必须定义 retention、missing/corrupt artifact 的 restore 终态。

Model 与 Capability artifact 保持独立 namespace、内容 schema、访问策略和 retention，但应复用同一个经过测试的 private immutable artifact storage primitive，不应复制两套 fsync/no-follow/concurrency 实现。Phase 2 在收紧 capability receipt 时把现有 CapabilityArtifactStore 迁移到该 primitive。

新增通用 Runtime Event：

    model.invocation_prepared
    model.invocation_attempt_started
    model.invocation_completed
    model.invocation_interrupted

既有 model.requested 与 model.responded 继续维持主 Agent 的 TUI/transcript 语义，但须补充 invocationId。辅助调用不伪装为主 Agent transcript。

Reducer 新增 RuntimeState.modelInvocations[invocationId]，其状态为 prepared、dispatching、completed 或 interrupted。prepared 至少携带 invocationId、purpose、surface ref、route identity、reservation identity 或 no-budget 标记，以及 prepared state revision。

严格顺序：

1. 在资源 admission 前编译一次冻结 Surface；准备 effect 携带该 Surface，不在 Gateway 中重建。
2. 写入 immutable surface artifact。
3. 使用同一 Surface 完成 provider data admission 与 resource reservation planning，生成 ModelInvocationEnvelopeV1。
4. 通过 Runtime execution context 的 persistEvents/getState 把 resource reservation/queue promotion 与 model.invocation_prepared 纳入同一原子 preparation batch，并等待 Kernel acknowledgement；不得仅依赖 emitRuntimeEvent。无启用资源账本的开发测试组合必须写明 no-budget，不能伪造 reservation。
5. 以同一冻结 Surface 授权 bounded retry plan。每次真实 Provider attempt 前都先持久化 model.invocation_attempt_started 并等待 ack；首次 attempt 与 resource_budget.dispatch_started 同一 batch。primary 的首次 attempt 还在该 batch 中带 model.requested；retry 则使用 model.retry 加新 attempt evidence。
6. attempt ack 成功后才能 Provider dispatch。partial stream 只影响 ephemeral UI，不能写 response artifact、model.responded 或 tool.queued。
7. 接收成功终端响应，先规范化并写 immutable response artifact。
8. primary 调用通过一次 persistEvents 原子提交 model.invocation_completed、既有 model.responded、由该 response 派生的全部 tool.queued/非法 tool terminal、usage/resource reconciliation 与必要 cache metrics。任一事件不能通过时整批不可见，也不得执行 tool call。
9. 辅助调用的 response 在 completion handle 内保持 sealed。Gateway 可调用 purpose adapter 提供的纯本地 finalizer，让其以只读 response 生成 purpose-owned terminal event，但 finalizer 不得执行 I/O、修改 Runtime 或保留 response 引用。Gateway 随后要么把 completed 与该 purpose event 同 batch 提交，要么在所属 effect 尚未能终结时先单独提交 completed；ack 成功后才向 compaction/reviewer/subagent 执行逻辑返回可消费的 NormalizedModelResponseV1。subagent 的每个 model step 独立终结，不等到整个 child 完成。后续所属 effect terminal 必须引用 invocationId，不得早于 invocation completed。

Surface artifact 成功、prepared event 失败会留下可 GC 的孤儿 artifact，但不得调用 Provider。Provider dispatch 已发生而 response receipt 不能提交时，当前进程不得伪造“已持久化 interrupted”；它必须停止消费 response，由下次 createAgentKernel() 根据已持久化 attempt evidence 收敛为 interrupted/unknown。不得将未 ack 的结果用于执行 tool call。interrupted 必须记录 dispatch certainty 为 none、attempted 或 unknown，不能仅用笼统状态覆盖 retry/crash 边界。

### 4.4 模型调用网关

新增 ModelInvocationGatewayV1，唯一拥有 live/replay response source、attempt/retry orchestration 和 artifact protocol。Gateway 必须接收 persistEvent/persistEvents/getState，而不是只接收 emitRuntimeEvent；RuntimeExecutorDependencies、createRuntimeEffectExecutor 和 invokeRuntimeModel 负责传递该 execution context。现有 invokeBoundModel 降为 Gateway 的私有 single-attempt transport primitive；它不得在内部开始首次请求或自动 retry。若 transport 需要 retry callback，必须是 Gateway 可 await 的 beforeAttempt，不得是 dispatch 失败后才通知的 onRetry。现有 partial-stream 公共前缀抑制和分歧展示语义由 Gateway 保留。

Gateway 使用两阶段 completion handle：response artifact 写入后得到 PendingModelCompletionV1，只有 commitWith(pureFinalizer?) 的 persistEvents ack 成功才能返回可消费的 NormalizedModelResponseV1 或 finalizer 结果。primary adapter 的 finalizer 生成全部 response-derived Runtime events；辅助 adapter 的 finalizer 只允许纯本地解析/验证，不得让 response 在 ack 前逃逸到执行逻辑。生产源码不得绕过 handle 直接取得 response。

必须迁移五类调用：primary agent、context compaction、auto review、verification review、subagent step。新增静态边界检查：生产源码仅 Gateway 可 import 底层 transport。

Context compaction 和 child agent 不能以“辅助路径”绕过 Surface。subagent 事件应带 parent invocation/tool identity，但其模型 response 不应污染父 transcript。

### 4.5 恢复、fork 与 epoch cutover

- prepared 或 dispatching 而未 completed 的 invocation 是未知中断态。restoreRuntimeStateFromStore() 仍只读；真正恢复执行的 createAgentKernel() 依据 reducer state 持久化 model.invocation_interrupted 与 dispatch certainty。默认不自动重发 live 模型请求，避免重复计费和非确定性续跑。
- 只有明确的 replacement invocation policy 或已有 replay response 才可继续。
- fork 复用不可变 artifact reference；artifact GC 必须按所有 session/fork 的可达引用扫描。
- MS-04 不单独提升 `RUNTIME_STATE_SCHEMA_VERSION` 或更换 `RUNTIME_STATE_FORMAT_EPOCH`，避免仍在迁移中的 Tool Controller/Provider 成为新 epoch 的旧 dispatch 路径。只有 CUT-01（依赖 MS-04、TP-04、PS-01、PS-02、PS-03）可切换 schema/format epoch；届时旧 snapshot/event log/fork 不迁移、不 restore、不 replay，稳定进入 `incompatible_runtime_format`。不使用当前 Skill、指令或模型配置补造旧 Surface，也不自动删除旧本地数据。
- 新 epoch 内已完成 invocation 的 artifact 缺失或损坏不改变已持久化 transcript restore，而把该 invocation 标记为 modelEvidenceUnavailable 且禁止 strict replay；pending invocation 的 artifact 缺失或损坏必须收敛为 interrupted/unknown。

### 4.6 验收

- 任一 project instruction、Skill、binding revision、tool schema、实际被投影到 model-visible runtime context 的 sandbox identity、模型 generation 参数变化都必须改变 surfaceDigest。
- 新增 model.invocation 事件和 metadata logger 中不存在 prompt、reasoning、tool argument、response 正文；既有 model.responded 与 Session Logger content mode 的已接受 transcript/opt-in 语义不在本阶段改变。
- artifact write 或 prepared ack 失败时 transport 零调用。
- 资源 admission、artifact 与 transport 消费同一冻结 Surface；改变请求内容但保持 token count 不变也必须被检测并零 dispatch。
- 首次与每次 retry attempt 都有 ack-before-dispatch 测试；底层 transport 没有内部 retry 入口。
- primary 的 completed/responded/tool queue/resource reconciliation 是单个原子 batch；辅助 response 在 completed ack 前不可消费。
- restore/fork 可验证历史 artifact digest。
- 五种 purpose 都有覆盖测试。
- 新增 crash-point tests：surface 写入后、prepared 后、dispatch 后、response artifact 后、terminal event 前。

## 5. Phase 2 — Tool Pipeline V1

### 5.1 目标

保留 executeRuntimeTools 作为外部入口，将内部收敛成稳定的 stage boundary。目标不是立即拆 package，而是让每个阶段拥有输入、输出、允许副作用和失败语义。

    resolve
      → validate
      → classify
      → policy
      → approval
      → admission
      → persist intent
      → dispatch
      → normalize
      → receipt
      → verification

### 5.2 类型状态与职责

在 src/core/execution/tool-pipeline/ 建立内部类型。每一步只接受前一步的不可变结果，不能重新读取未绑定的 model call args：

    ToolCallSnapshot
      → ResolvedInvocation
      → ValidatedInvocation
      → ClassifiedInvocation
      → AuthorizedInvocation
      → AdmittedInvocation
      → RecordedInvocation
      → DispatchedOutcome
      → NormalizedOutcome
      → ReceiptCommittedOutcome

| Stage | 允许的工作 | 禁止事项 |
| --- | --- | --- |
| resolve | 解析 builtin/MCP/Skill/Subagent target 与 binding | I/O、Policy、修改 state |
| validate | schema、descriptor revision、disclosure freshness | I/O |
| classify | effective effects、风险、receipt/retry requirement | 批准、I/O |
| policy | workspace、phase、capability ceiling、execution boundary 判断 | Provider 调用 |
| approval | 形成 allow、user approval、auto review、reject 分支 | 将等待批准视为 dispatch |
| admission | 仅做本地 reservation、lease、sealed permit 与无网络 freshness validation | 建连、等待远端 provider、跳过 intent |
| persist intent | 写 invocation identity、args/effect/approval digest | 外部 I/O |
| dispatch | 仅此处调用 builtin/MCP/Sandbox/Subagent adapter | 产生 Runtime Event |
| normalize | 转为 ToolOutcomeV1 | 重新执行 |
| receipt | 写 artifact、提交 terminal evidence | 声称未提交的 success |
| verification | 从已提交 receipt 请求或运行验证 | 消费临时内存结果 |

### 5.3 事务边界

所有会进入 Provider/adapter 的 invocation 必须遵循；read-only observation 和 side-effecting commit 使用不同的 recovery contract，但不存在无 intent 的 Provider 调用：

    admitted
      → durable intent
      → freshness revalidation
      → external dispatch
      → immutable result artifact
      → durable receipt

顶层资源预算和 effect scheduling 仍由 RuntimeEffectExecutor 所有；Pipeline 只消费已授予 reservation。网络与 MCP egress 的 one-shot decision 是 admission receipt，必须在任何 socket 或 protocol request 前持久化。

若 dispatch 后 receipt 无法持久化，恢复状态必须是 unknown。对 unknown 禁止自动重试，除非 provider 明确支持并且旧 intent 带有有效 idempotency contract。

Provider readiness 若可能连接、认证或等待远端服务，不得伪装成纯 admission stage；它必须是有自身 admission/intent/receipt 的独立 provider lifecycle effect。该 lifecycle 使用 `(providerId, route/config revision, execution boundary)` 作为稳定 key，持久化自身 identity、状态和 expiry；多个 tool 调用只能引用同一 ready receipt 或等待同一个 lifecycle effect，不能各自隐式建连。任何 direct readiness call site（包括 capability discovery/search）都迁移到该 effect。auto-review 与 verification review 也是 Kernel 调度的独立模型 invocation effect，必须经 Phase 1 Gateway，不能作为 Tool Pipeline 内部 await 的 approval 子步骤。

read-only、可安全重试的外部 observation 与 write/unknown effect 必须有分别定义的 intent/recovery contract。当前 MCP success path 中 artifact write 失败仍可能只省略 artifact 而保留成功 terminal；Phase 2 必须将 CapabilityArtifactStore 迁移到 Phase 1 的 hardened private artifact primitive，并将该情况改为 typed receipt failure 或 execution_unknown，禁止声称已拥有成功 receipt。

每个 tool invocation 的 terminal commit 必须是一个由 Pipeline 组装、Kernel 原子接受的 batch，至少包含 canonical capability terminal/receipt、tool.finished/failed/rejected/cancelled、必要 file-change observation、verification.requested 与 resource reconciliation。tool.finished success 不得早于 receipt，verification.requested 不得引用未提交 receipt；任一必要事件无法提交时整批不可见，并按 dispatch certainty 进入 failed 或 unknown。

### 5.4 迁移策略

1. 建立 Pipeline 类型与纯 resolve/validate/classify stage，不改变 dispatch。
2. 迁移 Policy/approval 与全部 early-terminal branch。
3. 把可能建连/认证/等待的 provider readiness 拆成独立 lifecycle effect 与 keyed waiter/coalescing ledger，先完成其 intent/receipt，不在 capability dispatch 栈内隐式 await；迁移 discovery/search 的 direct readiness call site。
4. 迁移 MCP、builtin、subagent dispatch adapter。
5. 将 intent/receipt/terminal batch commit 改为 execution-context acknowledgement。
6. 启用静态边界检查：Provider-specific import 只能位于 dispatch adapter。

直接调用、并行 subagent、approval resume、ask_user、tool progress、auto review、verification request 和 recovery journal 都必须保留为明确 branch；它们不是可以被通用 middleware 吞掉的异常。

### 5.5 验收

- 迁移期间比较既有可观察 terminal semantics 的等价性，并单独断言新增 intent/receipt 不变量；不能要求事件序列逐字相等而排斥设计上新增的证据事件。
- 每个 stage 有单元测试；整体有 schema drift、stale binding、approval、egress denial、artifact failure、unknown recovery、idempotency retry 测试。
- 对每个 side-effecting adapter 注入 spy，断言无 durable intent 时零 dispatch。
- 对 read-only/provider-readiness/mutation-prepare adapter 同样断言无 durable intent 时零 dispatch。
- capability receipt、tool terminal、verification request 和 resource reconciliation 的原子 batch 在每个 crash point 都不会留下半终态。
- required verification 缺 receipt 时永远不能通过 CompletionGuard。

## 6. Phase 3 — LLM Replay V1

### 6.1 目标

让一次明确授权的真实模型运行可以生成受审查记录；之后在没有 API key、没有真实模型网络调用的条件下，完整重跑 Agent、Tool Pipeline、Sandbox 与 Verification。

这不是只 replay event log。Runtime 仍需重新执行业务逻辑和工具，以暴露“模型响应不变但 Runtime 行为变了”的回归。

### 6.2 模式与 response source

定义三种模式：

    live
    record
    replay

定义 `ModelResponseSourceV1`：它接收 `ModelSurfaceV1`、`ModelInvocationContextV1` 与 attempt ordinal，返回单次 `ModelAttemptOutcomeV1`，而不是直接返回成功响应：

    success { response: NormalizedModelResponseV1 }
    retryable_failure { failure classification, retry observation }
    fatal_failure { failure classification }
    aborted { cancellation / in-band terminal classification }

Source 只提供一个已发生或可重放的 attempt outcome；Gateway 是唯一决定重试、backoff、attempt budget 与下一次 `model.invocation_attempt_started` 的组件。live Source 调用 single-attempt transport，record Source 在结果确认后追加一个 outcome record，replay Source 从 catalog 读取同一 ordinal 的 outcome；三者不得各自实现 retry。

- live：使用真实模型；与其他模式一样强制写 Surface/invocation/response evidence，但不产生可提交 fixture。
- record：使用真实模型，在强制生产 evidence 之外写入受审查 replay catalog。
- replay：不创建真实 Provider transport，不读取 API key，只从 catalog 返回 attempt outcome。

Replay 失败的任何原因都产生 typed MODEL_REPLAY_MISS、MODEL_REPLAY_CORRUPT 或 MODEL_REPLAY_ROUTE_MISMATCH，而不是回退 live。

### 6.3 Catalog 与匹配

每个 replay attempt record 必须绑定：

    suite id + suite revision + fixture digest
    actor identity + purpose + actor-local logical invocation ordinal + attempt ordinal
    route fingerprint + adapter protocol version
    surface digest + replay digest + envelope replay digest
    outcome/response digest

所有模式都先在当前 Runtime 重新执行 provider-data admission 与 resource admission；若当前策略拒绝、预算不可授予或 prepared ack 失败，必须在 catalog lookup/transport 前终止。`envelopeReplayDigest` 只覆盖会影响 response-source/retry 语义且可稳定比较的 Envelope 字段：purpose、route identity、provider-data policy revision 与 admitted decision、payload classification digest、projection/capability contract digest，以及 retry algorithm/attempt/time limits；它明确排除 invocation/thread/turn、reservation identity、当前资源余量、时钟和临时路径。

`surfaceDigest` 是真实完整 `ModelSurfaceV1` 的 digest，不包含 invocation/thread/reservation/admission 等 envelope 字段。普通 record/replay 必须精确匹配 `surfaceDigest` 与 `envelopeReplayDigest`。为消除 CI checkout 根目录差异，受批准 evaluation suite 可定义 `replayDigest`；它只能按 suite 明确声明的、经过验证且版本化的 fixture workspace-root tokenization 计算。此种 suite 以 `replayDigest + envelopeReplayDigest` 作为匹配键，原始 `surfaceDigest` 保留为审计/差异诊断字段；tokenization 后仍有任何语义差异必须造成 replay miss。生产 session 和任意未声明路径禁止 tokenization。运行身份通过 actor lineage 匹配，不通过污染 surfaceDigest 获得唯一性。

success outcome 包含 assistant text、reasoning（若会进入未来上下文）、tool calls 与稳定 ID、usage 和必要完成顺序；failure/aborted outcome 包含稳定错误分类与 retry observation。Catalog 按 attempt ordinal 保存这些 outcome，流式 delta 可以作为可选 UI artifact 保存，但不得影响 Kernel 语义。

Provider-native replay state 作为 opaque private artifact 保存。同一 live composition 内，只有历史 route 与目标 route 当前由同一 adapter object instance 拥有时，Runtime 才把 native state 交给该 adapter。跨进程 keyless replay 不伪造“同一 object instance”；Gateway 根据持久化 replay-owner descriptor 选择同一 adapter implementation 提供的纯本地 replay-state codec/canRestoreNativeState(historyOwner, currentRoute)，该检查不构造 Provider transport、不读取 API key。owner descriptor 或 adapter protocol version 只能用于选择 codec 与拒绝不兼容状态，不能独立授权恢复；最终决定始终属于 adapter。

purpose 加全局 invocation ordinal 不是稳定 replay key：sibling subagent 可以并发运行。Catalog 必须使用 durable causal lineage：

    suite id + fixture digest
    actor = parent 或 { parentToolCallId, subagentId, continuationId? }
    purpose + actor-local logical invocation ordinal + attempt ordinal
    surface/replay digest（按本节匹配规则）+ envelope replay digest

所有随机 identity 路径必须注入 deterministic RuntimeIdSource；每个 actor 有独立 cursor。suite teardown 必须调用 assertConsumed，要求每个 cassette record 恰好消费一次且没有多余或未消费调用。record 还须保存 response ID、finish reason、invalid tool-call form、cache/usage、attempt outcome、retry observations、native replay state。所谓 canonical event equality 必须在每个 suite 明确列出允许忽略的时间、随机 ID 和 OS observation 字段。

### 6.4 评测与数据治理

先由 RP-00 建立评测 ADR 与 active evaluation policy，定义 cassette 的正文允许域、approved suite authority、PR replay gate 的证据含义和按风险覆盖扩展 suite 的准入/审批条件。当前 12-case synthetic suite 是初始候选基线；是否全部进入 replay gate、何时增加 case，由 RP-00 和 pilot 根据 actor concurrency、tool effect、compaction、verification、failure/recovery 等风险维度决定，不使用任意固定数量代替覆盖证据。

record、replay 与生产 artifact 必须分为三个存储域：

    Production ModelArtifactStore
      private, never committed, never Session Logger source
    Evaluation cassette
      仅受审查的 synthetic fixture 内容，可版本控制，
      可含 replay 必需的安全 response/tool-call 数据，禁止 CI 输出
    Record credentials
      仅显式 record 命令从受控环境或本机配置读取；
      禁止项目 .env、workspace 文件、cassette、日志和 error body

在 RP-00 批准 replay gate 后，approved suite 的所有任务在每次提交运行 keyless replay。每个任务必须具备：

- 固定 fixture identity、workspace normalizer、deterministic clock/ID source。
- mock 或禁用外部网络。
- 有界 cleanup，且仅清理已验证属于该 case 的 worktree/process。
- oracle、suite revision、fixture digest 与 record catalog 的一致性校验。
- 允许的 terminal event、receipt、verification 与文件变更断言。

record 命令必须显式触发，并要求 route allowlist、无生产 workspace、无用户内容、人工 review。record 命令本身可以从上述受控域读取 credential，但 credential 不得进入 workspace、fixture、cassette、日志或错误正文。更新基线必须创建新的 suite revision/digest 并审查 Surface 和 response diff。

现有 synthetic evaluation 与有限 live smoke 的边界仍然有效。回放结果只证明固定记录下的 Runtime regression，不证明当前真实模型质量。

### 6.5 验收

- replay 模式没有 API key 仍能完成所有 suite。
- missing、out-of-order、digest mismatch、损坏 artifact 均 fail closed。
- 同一 fixture 两次 replay 的 canonical terminal event 和关键 receipt digest 相同。
- 故意改变 prompt、binding、schema、工具输出或 verification 规则时，得到可定位 mismatch 或 oracle failure。
- Production artifact 不进入 Session Logger；metadata logger、普通日志和 CI 输出不泄漏 prompt/response/tool 正文。Session Logger content mode 仍仅按既有双重 opt-in 与 secret detector policy 保存允许的 user/model-visible answer；受审查 evaluation cassette 仅保存 replay 必需且来自 synthetic fixture 的安全正文。

## 7. Phase 4 — Governed Provider Seams V1

### 7.1 共同原则

    Pipeline owns authority, lifecycle and Runtime Events.
    Provider owns bounded execution and observations.

Provider 不是插件协议。初始版本只提供显式构造的 Local 实现；没有动态发现、第三方加载或 provider 自行扩权。

### 7.2 WorkspaceFilesystemProviderV1

Filesystem seam 采用“intent → prepare → ready → commit” mutation contract，避免 prepareMutation 成为无证据的 Provider I/O：

1. Pipeline 先对 FilesystemOperationV1、canonical workspace、lexical target、effect/approval/protected-path revision 形成 mutation intent，持久化 ack 后才签发 FilesystemPrepareGrantV1。
2. prepareMutation 仅接收该 grant 和 cancellation signal，返回 immutable target identity 与 preimage observation；它不得写文件。
3. Pipeline 把 preimage 写入独立私有 rewind/preimage artifact，再原子持久化 mutation_ready，artifact ref、target identity 和 operation digest 共同生成 sealed FilesystemCommitGrantV1。
4. commitMutation 重验 canonical path、no-follow identity、preimage digest、operation digest、grant expiry 和 cancellation；目标在 prepare 后变化时返回 typed stale_preimage，不得写入。
5. commit 返回 post-state observation，由 Pipeline 写 artifact 并提交 terminal receipt batch。

只读操作使用已持久化 invocation intent 签发的 FilesystemObserveGrantV1 单步 observe；不因为无写入就绕过 intent。

grant 必须绑定 thread、turn、toolCall、invocation、capability revision、effect digest、canonical workspace、protected-path policy revision、审批摘要、允许 operation 与有限有效期。Provider 在 prepare 与 commit 都以 canonical path、no-follow identity、operation digest 和 sealed grant 重验，避免 symlink/TOCTOU。prepare grant 不具有写权限，commit grant 只能在 mutation_ready ack 后建立且单次消费。

observation 返回 canonical path、读写前后 digest、变更摘要、内部原始结果；Pipeline 决定模型投影、artifact 和 receipt。Provider 不拥有 protected-path Policy、preimage/recovery journal、approval 或 Runtime Event。只有 LocalFilesystemProvider 可直接使用 capability execution 的 Node fs；RuntimeStore、artifact persistence、project instruction discovery 等 trusted infrastructure I/O 明确不属于该 import rule。

### 7.3 SandboxExecutionProviderV1

SandboxExecutionProviderV1 只拥有 confinement preparation，不拥有 process execution。prepare 接收 SandboxPreparationV1 和精确 argv，返回 data-first PreparedSandboxExecutionV1：替换 argv、command digest、backend、ExecutionBackendCapabilitiesV1、full/partial enforcement、command-denied 与 runner-failed 的可区分证据，以及必要的 dispose cleanup handle。PreparedSandboxExecutionV1 没有 execute/spawn 方法。Tool Pipeline 的 Shell dispatch consumer 拥有唯一 spawn、timeout/cancellation、输出上限、process cleanup 和结果归因，并在 finally 中调用 dispose。

`prepare` 的资源语义必须在每个 backend contract 中封闭声明，二者不得混用：默认的 pure preparation 只能计算 confinement argv/证据，零外部资源分配，`dispose` 至多释放进程内对象；若 backend 必须创建容器、挂载、远端 lease 或任何可泄漏资源，它不得冒充 pure preparation，必须进入独立 `sandbox_preparation` lifecycle：admission → durable preparation intent → prepare → private preparation artifact → durable `preparation_ready` receipt → spawn。`preparation_ready` ack 前禁止 spawn；crash 后 Kernel 依据该 receipt 调度有自身 intent/receipt 的 disposal/reconciliation effect，不能依赖丢失的进程内 handle。没有可验证 cleanup/recovery contract 的 allocating backend 一律拒绝。

SandboxPreparation 绑定 invocation、canonical workspace、sealed execution boundary、resource limits、network policy 与 cancellation。ApprovedShellCommand 必须绑定精确 argv/command digest、grant、有效期和 cancellation；Provider 在 prepare 时验证 sealed grant，consumer 在 spawn 紧前重验 prepared command digest、expiry 与 cancellation。Prepared object 只能用于当前 invocation 的一次 spawn，不持久化、不缓存、不更换 argv。command 在进入 Provider 前必须已通过 Pipeline classify/policy/approval 和 durable intent ack。要求 confinement 的 effective policy 缺少 backend/evidence 时 fail closed，且 silent unconfined passthrough 永远非法；明确授权的 danger_full_access 是独立非-confined 路径，不得被误表述为 sandbox fallback。

### 7.4 SubagentProviderV1

SubagentProviderV1 提供 start 和 resume，分别接受 SubagentDelegationGrantV1 和 SubagentResumeGrantV1，返回 SubagentHandleV1。

delegation grant 必须绑定 parent invocation、角色、任务 artifact digest、精确 capability ceiling/binding revision、authorization、workspace/execution boundary、资源 reservation/预算、cancellation correlation、Model Surface/replay context。

当前 in-process runner 直接建模模型、工具与部分 policy/recovery 决策，不能直接作为满足此 seam 的薄包装。先拆出 ChildRuntimeDriver：其模型调用经过 ModelInvocationGateway，工具调用经过 Tool Pipeline；LocalSubagentProvider 只负责生命周期、取消和 observation transport。Provider 只能产出 child observation、completion、blocked continuation 和 recovery journal。approval、父 Runtime Event、receipt merge 和 verification 仍由父 Pipeline/Kernel 拥有；远端 child backend 不在本计划范围。

### 7.5 验收

- Local Provider 与迁移前实现对同一 fixture 产生等价 canonical event/receipt。
- Provider implementation 不得 import Policy、Kernel 或 Runtime Event emitter；ChildRuntimeDriver 是受治理执行层，不属于 Provider 实现。
- Filesystem prepare 在 durable intent ack 前零调用；preimage/ready ack 失败时零 commit，stale preimage 零写入。
- Sandbox Provider 不 spawn process；consumer 只能单次消费与 approved command digest 完全一致的 prepared argv，并总是执行 dispose。
- 拒绝型 fake provider 产生明确 typed failure；不能退回 Node fs、裸 shell 或直接 runner。
- execution boundary 的 fail-closed 测试持续通过。

## 8. 横切风险、迁移和 rollback

| 风险 | 设计控制 | rollback |
| --- | --- | --- |
| Model Surface 存储敏感内容 | 私有 immutable store、权限、opaque/keyed event reference、不可发送 logger/telemetry | 代码 revert 后使用新的开发 epoch/store；不在当前 epoch 重开无证据 dispatch |
| artifact 与 event 无法原子跨介质提交 | event ack 前不 dispatch；孤儿 artifact 可 GC；dispatch 后无 receipt 归为 unknown | 禁止 replay/自动重试，手动恢复或 replacement invocation |
| Surface 过大 | hard size bound、无截断、明确失败码 | 拒绝该 invocation；不降级到无 Surface 路径 |
| 现有 Tool 行为回归 | shadow/differential event fixture、逐 adapter 迁移 | 旧内部实现只留在未合并迁移分支；cutover epoch 不保留运行时 fallback |
| replay fixture 固化 nondeterminism | 固定 clock/ID/workspace normalizer、mock egress、严格 digest | baseline 更新须显式 record/review，不能 CI 自更新 |
| Provider seam 成为绕过点 | sealed grant、Pipeline-owned events、static import boundary、Local-only composition | 停止 cutover 并 revert 未合并代码；已 cutover epoch 只 fail closed，不退回裸接口 |

核心证据边界不使用可在运行时退回 legacy dispatch 的 feature flag。live/record/replay 只选择 response source，三者都必须经过 Surface、intent、attempt 和 receipt。开发期 shadow/differential 只用于未 cutover 分支的 parity 测试，不是 production composition mode。新 epoch 生效后，artifact、event acknowledgement 或 strict matching 失败一律 fail closed。

## 9. ADR、当前文档与验证要求

在任何代码阶段开始前，新建以下 ADR，编号由仓库当前序列分配：

1. Model Invocation Evidence and Replay。
2. Tool Pipeline Commit Boundaries。
3. Governed Local Provider Seams。

每个实施阶段在行为落地时同步更新：

- docs/active/six-concept-runtime-architecture.md
- docs/active/model-provider-boundary.md
- docs/active/execution-boundary.md
- docs/active/verification-governance.md
- docs/active/agent-task-evaluation.md
- docs/active/session-logging-policy.md
- docs/active/runtime-resilience-qualification.md（若增加 fault/soak coverage）
- docs/documentation-map.json

每一 task 完成前运行与修改范围匹配的单元、Runtime journey、fault/soak、typecheck 和 core boundary 检查；在 stage、commit、push 或 PR 前必须执行项目 document-before-commit Skill、bun run check:docs-impact 与 bun run check:docs。

## 10. Task 执行矩阵

| Task | dependsOn | 文件/产出 | 定向验证 | 迁移与回滚 |
| --- | --- | --- | --- | --- |
| MS-01 | — | ADR；ModelSurfaceV1、ModelInvocationEnvelopeV1 protocol、canonicalizer、分层 digest tests | canonicalization、secret exclusion、运行 identity 不污染 surfaceDigest、typecheck | 纯新增；未 cutover 不改变 dispatch |
| MS-02 | MS-01 | private immutable artifact primitive、ModelArtifactStoreV1、opaque locator、权限/原子写/GC reachability 设计与测试 | corruption、concurrency、fork reachability、key loss、crash points | 孤儿 artifact 可 GC；未 cutover 可删除新 store |
| MS-03 | MS-01、MS-02 | frozen pre-admission Surface、ModelInvocationGateway、single-attempt transport、invocation state/events、primary response-derived 原子 batch | ack-before-every-attempt、request drift、retry/crash certainty、event/redaction、restore/fork journey | 与 MS-04 作为一个模型迁移 series 合并；不增加 legacy runtime flag |
| MS-04 | MS-03 | compaction、review、verification、subagent 迁移；reverse-import allowlist；cutover readiness | 五 purpose、auxiliary response-before-ack 不可消费、child step parent linkage、no-bypass | 未完成 Tool/Provider 迁移时不得进入 Production epoch |
| TP-01 | MS-04 | ToolPipeline 类型、resolve/validate/classify 纯 stage | binding/schema/effect classification | 只在未合并迁移分支保留现有 dispatch |
| TP-02 | TP-01 | policy/approval/admission stage、keyed provider-readiness lifecycle/waiter ledger、early terminal branches | approval、auto-review、ask_user、readiness coalescing/crash、discovery/search 无 direct readiness、egress denial | differential event tests |
| TP-03 | TP-02 | hardened capability artifact、durable intent/receipt/terminal batch commit、MCP/builtin/subagent adapter migration | no-intent-no-dispatch、atomic terminal、artifact failure、unknown recovery、idempotency | adapter parity 通过后 cutover；无运行时 adapter fallback |
| TP-04 | TP-03 | verification stage、static provider boundary、ToolController 瘦身 | receipt-before-verification、legacy parity journey | 移除旧路径前全量 parity |
| RP-00 | — | ADR、active evaluation policy、cassette content domains、approved suite authority 与 risk-based promotion criteria | policy/doc review、fixture privacy tests | 维持当前 12-case 候选基线；未批准不建立 replay gate |
| RP-01 | MS-04、RP-00 | ModelResponseSource、record/replay modes、strict catalog parser | no-key replay、miss/corruption/route mismatch、exact replay-owner check | replay disabled 不得产生 live fallback |
| RP-02 | RP-01 | deterministic pilot cassette suite、workspace normalization、actor-local cursor/oracle | repeated replay、concurrent-child determinism、cleanup safety、suite identity | catalog revision 固定，不能 CI 自更新 |
| RP-03 | RP-02、TP-04、RP-00 | approved suite 的每提交 keyless replay gate 与基线更新流程 | approved suite 全量、risk coverage、no egress、docs/eval checks | gate failure 阻止合并；record 人工修复 |
| PS-01 | TP-04 | WorkspaceFilesystemProviderV1 加 Local 实现；intent/prepare/ready/commit 接线 | no-intent-no-prepare、path/effect/preimage/stale parity、fake deny | parity 通过后 cutover；无运行时旧 adapter |
| PS-02 | TP-04 | SandboxExecutionProviderV1 加 Local 实现；consumer-owned spawn 接线；pure/allocating preparation contract | execution-boundary negative tests、single-use prepared plan、prepare crash/dispose recovery、leak tests | fail closed；不可降级裸 shell |
| PS-03 | MS-04、TP-04 | SubagentProviderV1 加 Local 实现 | ceiling/budget/cancel/resume/replay propagation | parity 通过后 cutover；旧 runner 不作为运行时 fallback |
| CUT-01 | MS-04、TP-04、PS-01、PS-02、PS-03 | 唯一 Production Runtime schema/format epoch cutover；移除全部旧 model/tool/provider dispatch composition | old epoch incompatible、全量 no-bypass、journey/fault/restore/fork、无 runtime fallback | cutover 前仅可撤销未合并迁移；cutover 后只 fail closed |
| DOC-01 | 每个实现 task | active docs、ADR、documentation map、完成记录 | docs-impact、docs、相关 runtime tests | 文档不收敛即 blocked |

### 10.1 当前执行状态

| Task | 状态 | 已验证证据 |
| --- | --- | --- |
| MS-01 | completed | ADR-0109/0110/0111 已建立；Protocol-first Model Surface/Envelope/Response/opaque artifact ref、五 purpose 映射、严格 private canonical JSON 与分层 digest 已落地；定向与默认全量测试、typecheck、Core boundary 和 docs 检查通过；production dispatch、Runtime event/state/store 与 format epoch 均未改变 |
| MS-02 | next | 尚未开始；必须先复用单一 private immutable storage primitive，再实现 ModelArtifactStoreV1 与 GC reachability |
| MS-03 及后续 | pending | 不得越过依赖；当前仍无 Gateway、attempt ack、Tool Pipeline、Replay、Local Provider seam 或 CUT-01 |

## 11. 完成定义

本计划的四阶段全部完成，必须同时满足：

1. 每个 Production Runtime 模型调用都有 Model Surface 与可验证的 invocation/response evidence。
2. 所有工具调用都通过唯一 Pipeline；所有 Provider observation、readiness、prepare 和 side-effecting commit 都拥有 intent、receipt 和与 effect 匹配的 recovery 语义。
3. 经 RP-00 批准的 risk-covering suite 在每次提交以无 key、无真实 Provider 请求的模式完整 replay。
4. Filesystem、Sandbox、Subagent 都通过受治理 Local Provider seam；受治理 capability execution 中不存在裸 fallback。
5. 新 Runtime format epoch 中不存在无 Model Surface、无 Tool intent/receipt 或裸 Provider adapter 的 legacy runtime fallback。
6. 相关 active 文档、ADR、测试和 documentation map 一致，且文档门禁通过。

在此之前，本文保持 active，并逐项记录已完成 Task 与下一依赖；只有全部验收条件满足后才归档。任何单个 Task 的完成都不得被表述为四阶段收敛完成。
