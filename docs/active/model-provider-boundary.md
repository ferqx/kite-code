# 当前规则：模型 Provider 边界

状态：active

读取时机：修改模型配置、Model Controller、provider adapter、reasoning、模型上下文或缓存指标时。

验证：`bun test tests/config.test.ts tests/model.test.ts tests/runtime/model-controller-failures.test.ts tests/runtime-context.test.ts`、`bun run typecheck`。

相关：`real-model-test-boundary.md`、`plan-state-reminder.md`。

## 规则

Kite Code 是 provider-neutral 系统。`deepseek`、`openai`、`openai-compatible` 和 `ollama` 通过 AI SDK 模型边界接入；Runtime Kernel、Tool Controller、Policy 和 Verification 不得依赖某个 provider 的消息类或 SDK。

- 共享代码使用 `provider`、`providerType`、`baseURL`、`apiKey`、`modelName` 等中立命名。
- Provider 专有 reasoning、缓存指标和请求参数隔离在 `src/core/model/` 或配置解析边界。
- Model Controller 将 provider 输出规范化为 Runtime transcript/events；上游不读取私有响应对象。
- Provider 是否支持 tool calling 与上下文预算会影响 Capability disclosure，但不能改变授权语义。
- API key、base URL 和本地模型配置不得写入测试 fixture、日志或文档。

模型上下文能力必须先解析为统一的 `ResolvedModelCapabilities`。单字段优先级依次为：选中模型条目的显式配置、内置模型目录、provider adapter metadata、`modelKwargs` 兼容字段；未知自定义模型保持 unknown，不得假设 128K 或其他大窗口。`contextWindow`、`maxOutputTokens`、tokenizer family、usage metadata 和 prompt cache support 是模型条目的正式 schema。Capability disclosure、输出 token 预留、上下文 preflight 和实际模型请求必须共用同一个 resolved object。

M2 summary model 通过同一 provider-neutral AI SDK 边界调用，temperature 固定为确定性设置，不绑定任何工具，并限制 max output tokens。其原始 JSON 输出不可信；只有通过 Runtime 的结构化 schema、provenance、mandatory facts、coverage 和 reduction 校验后才能写入 checkpoint。V2 schema 要求所有 durable fact section（`objective`、`userRequests`、`userConstraints`、`decisions`、`completedEffects`、`observations`、`failures`、`pendingWork`）强制携带 `factId` 以纳入 mandatory fact coverage；evidence 校验作用于 covered range 内全部消息 ID（user、assistant、tool），而非仅限用户消息；evidence 绑定验证要求 summary evidence 与 ledger fact evidence 存在非空交集；immutable 字段（path、digest、resource、revision）采用双向校验——模型既不能修改也不能省略 ledger 中已有的字段；增量压缩时 base objective 单调保留，不会被 tail 的第一条 user message 覆盖；旧版 V2 checkpoint（`objective` 和 `userRequests` 缺少 `factId`）通过 `parsePersistedCheckpointSummary` 自动迁移。

Provider context overflow 必须与 timeout/rate limit/server error 区分；启用自动 M2 时，每个 turn 最多转化为一次 `overflow_recovery` compaction request，恢复后再次 overflow 必须明确失败，不能进入 adapter 的普通 transient retry。

## 禁止事项

- 不得把 DeepSeek/OpenAI 假设写入 Scheduler、Policy、工具路由或持久化 schema。
- 不得在模型 SDK 的 tool `execute` 中绕过 Runtime 执行工具。
- 不得把真实网络测试混入默认确定性测试。
- 不得在没有实际真实模型套件的情况下声称某 provider 已通过端到端验证。
