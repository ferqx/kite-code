# 当前规则：模型 Provider 边界

状态：active

读取时机：修改模型配置、Model Controller、provider adapter、reasoning、模型上下文或缓存指标时。

验证：`bun test tests/config.test.ts tests/config/provider-data-policy.test.ts tests/model.test.ts tests/model-invoke.test.ts tests/model-provider-data-policy.test.ts tests/model-capabilities.test.ts tests/runtime/model-controller-failures.test.ts tests/runtime/context-compaction-auto.test.ts tests/runtime-context.test.ts tests/tui-reducer.test.ts tests/session-manager.test.ts tests/runtime/kernel.test.ts`、`bun run scripts/run-tui-system-tests.ts model-streaming thought-lifecycle`、`bun run typecheck`。

相关：ADR-0022、ADR-0023、ADR-0024、ADR-0031、`real-model-test-boundary.md`、`plan-state-reminder.md`、`docs/space/plans/2026-07-21-context-compaction-production-rollout.md`。

## 规则

Kite Code 是 provider-neutral 系统。`deepseek`、`openai`、`openai-compatible` 和 `ollama` 通过 AI SDK 模型边界接入；Runtime Kernel、Tool Controller、Policy 和 Verification 不得依赖某个 provider 的消息类或 SDK。

- 共享代码使用 `provider`、`providerType`、`baseURL`、`apiKey`、`modelName` 等中立命名。
- Provider 专有 reasoning、缓存指标和请求参数隔离在 `src/core/model/` 或配置解析边界。
- 文件工具超长输出在最后完整行处截断并报告省略行数（如 `... (25 more lines omitted)`），避免发送拆散行号的散碎文本给模型。
- Model Controller 将 provider 输出规范化为 Runtime transcript/events；上游不读取私有响应对象。
- `model.responded` 事件必须把模型调用时长（`kite_code.model.duration_ms`，来自 `model.responded.durationMs`）持久化进会话日志属性；TUI 阶段块的 `Thought for Xs` 计时（thought-pre-consolidation.md 规则 11/22）依赖此字段，缺失时回放回退墙钟。
- Provider 是否支持 tool calling 与上下文预算会影响 Capability disclosure，但不能改变授权语义。
- API key、base URL 和本地模型配置不得写入测试 fixture、日志或文档。

`ProviderDataPolicyV1` 是 production route 数据边界的版本化 schema。资格绑定
provider type、operator、规范化 endpoint origin、endpoint class、deployment 和 region 的
canonical identity digest，不绑定 model name。仓库受控 snapshot 位于
`release/provider-data-policies/`；当前 D-14 批准 bundle 明确为空，因此还没有任何
production-qualified model/MCP route。`providerDataPolicyV1` 默认关闭；启用后 Model
Controller 必须在 Provider dispatch 前取得由受控 bundle 构造的 registry/gate，缺失、
未生效、过期、digest/route identity 漂移、payload kind 越权或数据分类越权全部 fail closed。
`limited` profile 的 unknown route 一律拒绝；自定义 endpoint 只能进入显式
`internal_experimental` 路径，不能产生 production 资格。

生产 loader 只能读取仓库固定的 `approved-v1.json`，并同时校验编译期 revision 与 SHA-256
digest；调用方不能传入文件路径或期望 digest。Runtime 从最终 resolved `AgentConfig` 构造
route identity。启用 flag 时，最终 `invokeBoundModel` dispatch 边界强制要求 gate，普通模型、
context compaction、Sub-agent、auto review 与 Verification reviewer 都不能绕过。Runtime 在
启动时发出不含 endpoint/payload 的 `provider.data_policy_status`，供 CLI/TUI 显示批准状态。
ResourceBudget 与该门禁同时开启时，主模型在创建 reservation 前执行同一确定性 admission；
Subagent 等已建立 child attempt 的路径若在最终本地门禁被拒绝，必须以
`local_provider_admission_denied` 证明释放，不能标记为已外发的 unknown，也不能出现
`dispatch_started` 后的 Provider 网络调用。Compaction、auto review 与 Verification reviewer
不得把 `ProviderDataAdmissionError` 转成普通业务失败或 inconclusive 后核销预算；异常必须
穿透至 Runtime reservation owner。只有整个 reservation 都能证明尚未外发/执行时才按同一
未外发证明释放；组合 Verification 若前序 command、MCP 或 reviewer check 可能已经 dispatch，
reservation 必须转为 `unknown` 并进入 reconciliation，不能整体退款。

Provider admission payload 为每段正文保留 `user_prompt | file_snippet | tool_result | summary`
provenance 和 Workspace data label。`secret` label、runtime secret detector、credential marker
或 protected-path marker 在 mocked/real Provider 收到请求前独立阻断。状态投影只暴露 route
alias、允许分类、retention/training/logging 用途和 policy/registry revision，不暴露 endpoint
origin。用户、项目或 CLI 配置不能向 registry 增加 policy，也不能放宽仓库批准 bundle。

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

Summary model 通过同一 provider-neutral AI SDK 边界调用，temperature 固定为确定性设置，不绑定任何工具，SDK retry 固定为零，并限制 max output tokens。专用请求只产生一份 Markdown narrative；原始输出必须非空、未因 length 截断、没有 tool call、低于 narrative 上限，并通过统一 candidate projection 的绝对缩减验证后才能写入 checkpoint。Checkpoint 不保存 Provider 原始响应、usage、JSON schema、fact/evidence ledger 或第二份模型内容。手动压缩把全部 safe settled history 交给一次调用；自动压缩仅保护当前 turn；增量压缩把旧 narrative 与 checkpoint 后的全部新 safe history 交给同一次调用，并整体替换 active checkpoint。显式输入上限超出时整体失败，不做部分前缀压缩。Compaction effect 不读取旧 `lastPreflight` 参与 acceptance。

Core 不解释通用 Provider 术语（模型供应商）HTTP 400，也不通过状态码、错误码或消息子串推断上下文溢出。正常模型请求失败后只展示脱敏错误，不自动创建压缩请求或 `ContextHardBlock`。Summary Provider 请求失败同样不清理工具输出、不分块、不自动重试；终态提示要求用户核对所选模型的 `contextWindowTokens` 或执行 `/clear`。live 自动压缩失败或取消时，本 turn 不再发送普通模型请求；下一用户 turn 重新 preflight 后可再次尝试。

Compaction 的 `preparing / summarizing / validating` 是 App-only 进度，不持久化。Completed、failed、cancelled 由 Core 统一映射为脱敏终态提示并按 `compactionId` 去重。指标 reporter 由 Runtime 组合根注入并由组合根拥有 flush；不存在全局 compaction metrics singleton。三轮 follow-up、稳定 session cohort 和显式 opt-in local debug 都不得记录 summary、transcript、prompt 或工具正文。

压缩原因只允许 `manual | auto`。本地 context pressure 术语（上下文压力）、token ratio 术语（文本计量比例）、绝对 token threshold 术语（文本计量阈值）与 target ratio 术语（目标比例）都只是诊断或自动尝试启发式，不能证明 Provider admission 术语（模型供应商接纳）、阻止普通模型请求或创建 `ContextHardBlock`。`ContextHardBlock` 只接受 Runtime correctness failure 术语（运行时正确性故障）原因。

## 禁止事项

- 不得把 DeepSeek/OpenAI 假设写入 Scheduler、Policy、工具路由或持久化 schema。
- 不得在模型 SDK 的 tool `execute` 中绕过 Runtime 执行工具。
- 不得把真实网络测试混入默认确定性测试。
- 不得在没有实际真实模型套件的情况下声称某 provider 已通过端到端验证。
