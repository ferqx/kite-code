# Agent Note: 保留模型服务用量并优先显示实测输入

Status: implemented

## Problem

当前兼容服务已经返回 token 用量，但 SDK 的通用转换可能把缺失明细补成 0、丢掉嵌套额外字段，且汇总 `totalUsage` 不保留原始 usage。原适配器只保存输入、输出、缓存命中和推理四项，遗漏服务端总数及只提供旧式缓存别名的响应。已返回统计的失败／取消尝试同样可能没有用量记录。

TUI 把准确原请求的本地 cl100k 估算作为唯一上下文数值；通用词表与不同 Provider 的实际分词和封装并不相同。若把实测值和不可变输入一起缓存，运行中第一次读取的估算又会遮住后来返回的服务端统计。用户确认要求补齐上述记录、优先显示最近准确请求的实测输入，缺失时保留本地回退。

## Decision

- AI 的中立 `usage` 事件独立传递已收到的单次请求统计快照，`finish` 继续代表完整响应。重复快照替换而不累计；Core 不从统计生成成功、工具调用或派发资格，已收快照可随 failed／cancelled 结果保存。
- 兼容绑定从 SDK raw chunk 仅捕获原 `usage` 叶子。保留原 `total_tokens` 和完整原明细，不复制消息、headers、凭据或其他响应字段。标准缓存字段优先，缺失时回退 `prompt_cache_hit_tokens`；明确 0 有效，无效 normalized 数值保持未知，原始明细仍可核对。任意外部 SDK Model 沿其明确 normalized usage／raw，不猜协议。
- TUI 仍核准确 Store／Session／Run／Model 输入身份与冻结容量，分子优先采用同原 Execution 的非负安全整数 `inputTokens`；该请求缺失时用原本地估算。不可变输入缓存与实测用量观察分开，状态变化后可更新；下一调用没有统计时不借上一调用的值。累计当前已核 View 的测量按原 Execution 去重，包含有已收输入统计的失败／取消尝试，不声称账户完整消费。
- 保留当前 `gpt-tokenizer` cl100k 分块作为回退，不在本次任务中自动换词表或引入远程预计数。2026-10-16 核对到该库 [4.0.0 发布](https://github.com/niieani/gpt-tokenizer/releases/tag/4.0.0)，但新版本不使 cl100k 自动适用于第三方模型。[OpenAI 的词表映射](https://github.com/openai/tiktoken/blob/main/tiktoken/model.py)和 [DeepSeek 用量说明](https://api-docs.deepseek.com/quick_start/token_usage/)分别说明模型／分词差异及实际统计的范围；精确本地计数还需要该具体模型的词表和请求模板。原[有限分块决定](2026-10-15-context-estimate-bounded-tokenization.md)继续约束回退路径。

## Alternatives considered

- 直接持久化 SDK 的最终 `totalUsage`：通用转换的补零、汇总后的 raw 丢失与 nested schema 的字段过滤都已在隔离响应中复现，无法保留原服务端事实。
- 把用量附在异常上：正常、取消、传输错误与原重试错误并不共用一个异常契约，还会扩大已脱敏错误的载荷。独立中立事件能保留已收统计，同时保持错误与派发边界。
- 用本地 token 数替代缺失 Provider 用量，或用多次请求总和表示当前上下文：二者分别伪造测量和混淆范围，均不采用。
- 立即升级 tokenizer 并统一切到 o200k：不能证明闭源 DeepSeek／Qwen 路由使用同一词表和模板，也无法替代已返回统计；本次保留明确的兼容回退。未来需要模型专用精确本地计数时，应以具体可核实 tokenizer／模板接入，而不凭名称猜测。

## Consequences

成功、失败和取消的原结果可保存更多统计事实，旧结果没有的字段仍缺省。没有收到最终 usage 的中断仍可能缺少完整消费数据；已经返回的快照不保证是最终账单。原始明细与 normalized 值分开，异常数据不能变成百分比或缓存 0%。SQL baseline 和公开 HTTP schema 不变，也没有新的调试入口、后台网络请求或 Provider 重放。

当前实现与验证入口归 [AI owner](../../../../packages/ai/README.md)、[Agent owner](../../../../packages/agent/README.md)、[CLI Host](../../../../apps/cli/README.md)与 [TUI 产品指南](../../../../docs/handbook/clients/tui/guides/context-and-compaction.md)。SDK 本机 HTTP、真实 SQLite 成功／失败／取消与冷读取、Host 缓存更新和 Ink 面板分别证明其实际断言，不代替第三方全部路由、账户账单或三平台发行资格。

本决定中有限 View 的累计范围由[三项统计与预测](../architecture/2026-10-16-context-token-projection.md)部分替代：新完整累计读取原会话 Model 记录并报告缺失覆盖；原始 usage、失败／取消、最近请求实际输入及通用回退的取舍继续适用。
