# 当前规则：模型 Provider 边界

状态：active

读取时机：修改模型配置、Model Controller、provider adapter、reasoning、模型上下文或缓存指标时。

验证：`bun test tests/config.test.ts tests/model.test.ts tests/model-invoke.test.ts tests/model-capabilities.test.ts tests/runtime/model-controller-failures.test.ts tests/runtime/context-compaction-auto.test.ts tests/runtime-context.test.ts tests/tui-reducer.test.ts tests/session-manager.test.ts tests/runtime/kernel.test.ts`、`bun run scripts/run-tui-system-tests.ts model-streaming thought-lifecycle`、`bun run typecheck`。

相关：ADR-0022、ADR-0023、ADR-0024、ADR-0031、`real-model-test-boundary.md`、`plan-state-reminder.md`、`docs/space/plans/2026-07-21-context-compaction-production-rollout.md`。

## 规则

Kite Code 是 provider-neutral 系统。`deepseek`、`openai`、`openai-compatible` 和 `ollama` 通过 AI SDK 模型边界接入；Runtime Kernel、Tool Controller、Policy 和 Verification 不得依赖某个 provider 的消息类或 SDK。

- 共享代码使用 `provider`、`providerType`、`baseURL`、`apiKey`、`modelName` 等中立命名。
- Provider 专有 reasoning、缓存指标和请求参数隔离在 `src/core/model/` 或配置解析边界。
- Model Controller 将 provider 输出规范化为 Runtime transcript/events；上游不读取私有响应对象。
- `model.responded` 事件必须把模型调用时长（`kite_code.model.duration_ms`，来自 `model.responded.durationMs`）持久化进会话日志属性；TUI 阶段块的 `Thought for Xs` 计时（thought-pre-consolidation.md 规则 11/22）依赖此字段，缺失时回放回退墙钟。
- Provider 是否支持 tool calling 与上下文预算会影响 Capability disclosure，但不能改变授权语义。
- API key、base URL 和本地模型配置不得写入测试 fixture、日志或文档。

模型上下文能力必须先解析为统一的 `ResolvedModelCapabilities`。每个字段只按所选模型条目的显式配置、provider adapter runtime metadata、`modelKwargs` 兼容字段依次解析，并记录 `explicit_config | adapter_runtime | compatibility_config` source；缺失值保持 unknown，布尔能力保持 true/false/unknown 三态。模型名称和默认模型列表不得提供 context window、max output、tokenizer、usage 或 prompt-cache 能力，也不得为未知输出预算隐式预留 4096 tokens。Capability disclosure、上下文 preflight、metrics 和实际模型请求必须共用同一个 resolved object；未知窗口不显示利用率，也不运行 ratio auto，但不阻止普通模型请求或手动 `/compact`。

模型响应流式能力优先从显式模型配置、adapter runtime metadata 或 `modelKwargs.streaming` 解析；缺失时默认 `true` 且不伪造 source，用户无需配置。正常 Agent 调用使用单步 `streamText`，以累计全文语义实时发出不可持久化的 `model.text_delta` / `model.reasoning_delta`，流结束后仍只由 durable `model.responded` 推进 transcript、工具分发和轮次状态。显式 `streaming: false` 时使用 `generateText`；summary/reviewer 等内部模型调用不切换到此 TUI 流式路径。详见 ADR-0034。

流式调用的 transient retry 覆盖完整 stream 消费。服务在部分 SSE 后断开时，`model.retry` 冻结已经展示的 text/Thought；重连后的文本总是新开一段。新流重放相同前缀时只派发追平后的新增后缀，发生分歧时完整的新生成内容进入新段，旧段不删除。未完整结束的尝试不产生 `model.responded` 或 `tool.queued`，partial tool call 不进入 Runtime；只有成功尝试的 `finalStep` 一次性提交工具调用。恢复后的 delta 或 `model.responded` 清除 TUI retry 状态。完整流重试与工具规则见 ADR-0032，展示规则见 ADR-0033。

Summary model 通过同一 provider-neutral AI SDK 边界调用，temperature 固定为确定性设置，不绑定任何工具，SDK retry 固定为零，并限制 max output tokens。专用请求只产生一份 Markdown narrative；原始输出必须非空、未因 length 截断、没有 tool call、低于 narrative 上限，并通过统一 candidate projection 的绝对缩减验证后才能写入 checkpoint。Checkpoint 不保存 Provider 原始响应、usage、JSON schema、fact/evidence ledger 或第二份模型内容。手动压缩把全部 safe settled history 交给一次调用；自动压缩仅保护当前 turn；增量压缩把旧 narrative 与 checkpoint 后的全部新 safe history 交给同一次调用，并整体替换 active checkpoint。显式输入上限超出时整体失败，不做部分前缀压缩。Compaction effect 不读取旧 `lastPreflight` 参与 acceptance。

Core 不解释通用 Provider 术语（模型供应商）HTTP 400，也不通过状态码、错误码或消息子串推断上下文溢出。正常模型请求失败后只展示脱敏错误，不自动创建压缩请求或 `ContextHardBlock`。Summary Provider 请求失败同样不清理工具输出、不分块、不自动重试；终态提示要求用户核对所选模型的 `contextWindowTokens` 或执行 `/clear`。live 自动压缩失败或取消时，本 turn 不再发送普通模型请求；下一用户 turn 重新 preflight 后可再次尝试。

Compaction 的 `preparing / summarizing / validating` 是 App-only 进度，不持久化。Completed、failed、cancelled 由 Core 统一映射为脱敏终态提示并按 `compactionId` 去重。指标 reporter 由 Runtime 组合根注入并由组合根拥有 flush；不存在全局 compaction metrics singleton。三轮 follow-up、稳定 session cohort 和显式 opt-in local debug 都不得记录 summary、transcript、prompt 或工具正文。

压缩原因只允许 `manual | auto`。本地 context pressure 术语（上下文压力）、token ratio 术语（文本计量比例）、绝对 token threshold 术语（文本计量阈值）与 target ratio 术语（目标比例）都只是诊断或自动尝试启发式，不能证明 Provider admission 术语（模型供应商接纳）、阻止普通模型请求或创建 `ContextHardBlock`。`ContextHardBlock` 只接受 Runtime correctness failure 术语（运行时正确性故障）原因。

## 禁止事项

- 不得把 DeepSeek/OpenAI 假设写入 Scheduler、Policy、工具路由或持久化 schema。
- 不得在模型 SDK 的 tool `execute` 中绕过 Runtime 执行工具。
- 不得把真实网络测试混入默认确定性测试。
- 不得在没有实际真实模型套件的情况下声称某 provider 已通过端到端验证。
