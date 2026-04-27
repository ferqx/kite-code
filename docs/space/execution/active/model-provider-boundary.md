# 当前规则：模型 provider 边界

状态：active
最后更新：2026-04-27
最后验证：2026-04-27
范围：

- `src/config/index.ts`
- `src/model/factory.ts`
- `src/model/deepseek.ts`
- `src/model/context.ts`
- `src/model/runtime-context.ts`
- `src/shared/cache-metrics.ts`
- `tests/real-agent.real.ts`
- `README.md` 和 `AGENTS.md` 中的模型 provider 示例

读取时机：

- 修改模型配置加载。
- 新增或修改聊天模型适配器。
- 修改某个 provider 的 prompt、运行时上下文或缓存指标行为。
- 修改真实配置模型测试或 provider 文档。

相关：

- `real-model-test-boundary.md`
- `plan-state-reminder.md`

验证：

- 纯文档更新可用 `git diff --check` 验证。
- provider 实现改动应运行最近的 config/model 测试和 `bun run typecheck`。
- 真实网络/模型验证仍通过显式 `bun run test:real` 完成。

## 规则

本仓库不是 DeepSeek-only。DeepSeek 应视为更广义 OpenAI-compatible provider 边界内的一个已配置 provider。

默认设计方向：

- 共享代码、文档和测试中优先使用 provider-neutral 命名，例如 `provider`、`providerType`、`baseURL`、`apiKey`、`modelName` 和 `configured model`。
- 对实现 OpenAI chat API 形状但不是 OpenAI 官方服务的 provider，使用 `openai-compatible`。
- 只有需要 DeepSeek 适配器行为时才使用 `deepseek` provider 类型，例如 reasoning-content 回传或 DeepSeek 专有缓存指标。
- provider 专有行为应隔离在 provider adapter 或明确命名的共享 helper 中。
- 真实模型测试应覆盖配置的默认模型，不要假设默认 provider 是 DeepSeek。

## 不要做

- 不要把 harness 描述成必须依赖 DeepSeek，除非主题就是 DeepSeek adapter。
- provider-neutral 配置键足够时，不要新增 DeepSeek-only 配置键。
- 不要把 DeepSeek 假设写入图路由、tool gating、plan 模式、上下文组装、CLI 行为或 checkpoint 行为。
- 不要在 README 示例、测试或未来 provider 工作中把 OpenAI-compatible provider 当成附带支持。
