# 当前规则：模型 Provider 边界

状态：active

读取时机：修改模型配置、Model Controller、provider adapter、reasoning、模型上下文或缓存指标时。

验证：`bun test tests/config.test.ts tests/model.test.ts tests/runtime/model-controller-failures.test.ts tests/runtime/context-compaction-auto.test.ts tests/runtime-context.test.ts`、`bun run typecheck`。

相关：ADR-0022、ADR-0023、ADR-0024、`real-model-test-boundary.md`、`plan-state-reminder.md`、`docs/space/plans/2026-07-21-context-compaction-production-rollout.md`。

## 规则

Kite Code 是 provider-neutral 系统。`deepseek`、`openai`、`openai-compatible` 和 `ollama` 通过 AI SDK 模型边界接入；Runtime Kernel、Tool Controller、Policy 和 Verification 不得依赖某个 provider 的消息类或 SDK。

- 共享代码使用 `provider`、`providerType`、`baseURL`、`apiKey`、`modelName` 等中立命名。
- Provider 专有 reasoning、缓存指标和请求参数隔离在 `src/core/model/` 或配置解析边界。
- Model Controller 将 provider 输出规范化为 Runtime transcript/events；上游不读取私有响应对象。
- Provider 是否支持 tool calling 与上下文预算会影响 Capability disclosure，但不能改变授权语义。
- API key、base URL 和本地模型配置不得写入测试 fixture、日志或文档。

模型上下文能力必须先解析为统一的 `ResolvedModelCapabilities`。单字段优先级依次为：选中模型条目的显式配置、内置模型目录、provider adapter metadata、`modelKwargs` 兼容字段；未知自定义模型保持 unknown，不得假设 128K 或其他大窗口。`contextWindow`、`maxOutputTokens`、tokenizer family、usage metadata 和 prompt cache support 是模型条目的正式 schema。Capability disclosure、输出 token 预留、上下文 preflight 和实际模型请求必须共用同一个 resolved object。

M2 summary model 通过同一 provider-neutral AI SDK 边界调用，temperature 固定为确定性设置，不绑定任何工具，并限制 max output tokens。其原始 JSON 输出不可信；只有通过 Runtime 的结构化 schema、完整 provenance 精确匹配、mandatory facts、coverage、canonical semantic fields 和 reduction 校验后才能写入 checkpoint。V2 durable section 强制携带 `factId`；`userConstraints` 与 `decisions` 可额外携带 `sourceFactIds`，把原始 `user_request` 分类到更准确的摘要 section，但不得改写 source fact 的 text、evidence 或 mandatory identity。分类项的 mandatory coverage 只计算 `sourceFactIds`，缺省时才使用其 `factId`；observation `keyFacts` 必须与 ledger canonical text 精确一致。evidence 校验作用于 covered range 内全部消息 ID（user、assistant、tool），并要求与 ledger fact evidence 存在非空交集；canonical text、operation、outcome、error、consequence 及 path/digest/resource/revision 均采用双向校验。Compaction effect 使用当前 resolved model capabilities、output reservation 与 provider safety ratio 重新 preflight target，不读取旧 `lastPreflight` 参与 acceptance。增量压缩时 base objective 单调保留；旧版 V2 checkpoint 先经过 legacy schema 验证，迁移后再通过 current V2 schema。

Core 不解释通用 Provider 术语（模型供应商）HTTP 400，也不通过状态码、错误码或消息子串推断上下文溢出。正常模型请求失败后只展示脱敏错误，不自动创建压缩请求或 `ContextHardBlock`；会话保持可交互，由用户决定是否执行 `/compact`。

压缩原因只允许 `manual | auto`。本地 context pressure 术语（上下文压力）、token ratio 术语（文本计量比例）、绝对 token threshold 术语（文本计量阈值）与 target ratio 术语（目标比例）都只是诊断或自动尝试启发式，不能证明 Provider admission 术语（模型供应商接纳）、阻止普通模型请求或创建 `ContextHardBlock`。`ContextHardBlock` 只接受 Runtime correctness failure 术语（运行时正确性故障）原因。

## 禁止事项

- 不得把 DeepSeek/OpenAI 假设写入 Scheduler、Policy、工具路由或持久化 schema。
- 不得在模型 SDK 的 tool `execute` 中绕过 Runtime 执行工具。
- 不得把真实网络测试混入默认确定性测试。
- 不得在没有实际真实模型套件的情况下声称某 provider 已通过端到端验证。
