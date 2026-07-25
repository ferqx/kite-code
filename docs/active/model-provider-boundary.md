# 当前规则：模型 Provider 边界

状态：active

读取时机：修改模型配置、Model Controller、provider adapter、reasoning、模型上下文或缓存指标时。

验证：`bun test tests/config.test.ts tests/model.test.ts tests/runtime/model-controller-failures.test.ts tests/runtime/context-compaction-auto.test.ts tests/runtime-context.test.ts`、`bun run typecheck`。

相关：ADR-0022、ADR-0023、ADR-0024、`real-model-test-boundary.md`、`plan-state-reminder.md`、`docs/space/plans/2026-07-21-context-compaction-production-rollout.md`。

## 规则

Kite Code 是 provider-neutral 系统。`deepseek`、`openai`、`openai-compatible` 和 `ollama` 通过 AI SDK 模型边界接入；Runtime Kernel、Tool Controller、Policy 和 Verification 不得依赖某个 provider 的消息类或 SDK。

- 共享代码使用 `provider`、`providerType`、`baseURL`、`apiKey`、`modelName` 等中立命名。
- Provider 专有 reasoning、缓存指标和请求参数隔离在 `src/core/model/` 或配置解析边界。
- 文件工具超长输出在最后完整行处截断并报告省略行数（如 `... (25 more lines omitted)`），避免发送拆散行号的散碎文本给模型。
- Model Controller 将 provider 输出规范化为 Runtime transcript/events；上游不读取私有响应对象。
- Provider 是否支持 tool calling 与上下文预算会影响 Capability disclosure，但不能改变授权语义。
- API key、base URL 和本地模型配置不得写入测试 fixture、日志或文档。

模型上下文能力必须先解析为统一的 `ResolvedModelCapabilities`。每个字段只按所选模型条目的显式配置、provider adapter runtime metadata、`modelKwargs` 兼容字段依次解析，并记录 `explicit_config | adapter_runtime | compatibility_config` source；缺失值保持 unknown，布尔能力保持 true/false/unknown 三态。模型名称和默认模型列表不得提供 context window、max output、tokenizer、usage 或 prompt-cache 能力，也不得为未知输出预算隐式预留 4096 tokens。Capability disclosure、上下文 preflight、metrics 和实际模型请求必须共用同一个 resolved object；未知窗口不显示利用率，也不运行 ratio auto，但不阻止普通模型请求或手动 `/compact`。

Summary model 通过同一 provider-neutral AI SDK 边界调用，temperature 固定为确定性设置，不绑定任何工具，SDK retry 固定为零，并限制 max output tokens。专用请求只产生一份 Markdown narrative；原始输出必须非空、未因 length 截断、没有 tool call、低于 narrative 上限，并通过统一 candidate projection 的绝对缩减验证后才能写入 checkpoint。Checkpoint 不保存 Provider 原始响应、usage、JSON schema、fact/evidence ledger 或第二份模型内容。手动压缩把全部 safe settled history 交给一次调用；自动压缩仅保护当前 turn；增量压缩把旧 narrative 与 checkpoint 后的全部新 safe history 交给同一次调用，并整体替换 active checkpoint。显式输入上限超出时整体失败，不做部分前缀压缩。Compaction effect 不读取旧 `lastPreflight` 参与 acceptance。

Core 不解释通用 Provider 术语（模型供应商）HTTP 400，也不通过状态码、错误码或消息子串推断上下文溢出。正常模型请求失败后只展示脱敏错误，不自动创建压缩请求或 `ContextHardBlock`。Summary Provider 请求失败同样不清理工具输出、不分块、不自动重试；终态提示要求用户核对所选模型的 `contextWindowTokens` 或执行 `/clear`。live 自动压缩失败或取消时，本 turn 不再发送普通模型请求；下一用户 turn 重新 preflight 后可再次尝试。

Compaction 的 `preparing / summarizing / validating` 是 App-only 进度，不持久化。Completed、failed、cancelled 由 Core 统一映射为脱敏终态提示并按 `compactionId` 去重。指标 reporter 由 Runtime 组合根注入并由组合根拥有 flush；不存在全局 compaction metrics singleton。三轮 follow-up、稳定 session cohort 和显式 opt-in local debug 都不得记录 summary、transcript、prompt 或工具正文。

压缩原因只允许 `manual | auto`。本地 context pressure 术语（上下文压力）、token ratio 术语（文本计量比例）、绝对 token threshold 术语（文本计量阈值）与 target ratio 术语（目标比例）都只是诊断或自动尝试启发式，不能证明 Provider admission 术语（模型供应商接纳）、阻止普通模型请求或创建 `ContextHardBlock`。`ContextHardBlock` 只接受 Runtime correctness failure 术语（运行时正确性故障）原因。

## 禁止事项

- 不得把 DeepSeek/OpenAI 假设写入 Scheduler、Policy、工具路由或持久化 schema。
- 不得在模型 SDK 的 tool `execute` 中绕过 Runtime 执行工具。
- 不得把真实网络测试混入默认确定性测试。
- 不得在没有实际真实模型套件的情况下声称某 provider 已通过端到端验证。
