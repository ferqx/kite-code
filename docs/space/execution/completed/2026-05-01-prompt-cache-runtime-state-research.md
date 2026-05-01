# 完成记录：提示缓存与运行时状态投影研究

状态：completed
日期：2026-05-01
范围：

- `src/model/context.ts`
- `src/model/runtime-context.ts`
- `src/app/runner.ts`
- `src/shared/cache-metrics.ts`
- `tests/context.test.ts`
- `tests/cache-metrics.test.ts`
- `docs/space/execution/active/plan-state-reminder.md`
- `docs/space/execution/active/empirical-research-archive.md`

相关：

- `../active/plan-state-reminder.md`
- `../active/empirical-research-archive.md`
- `../../understanding/2026-04-26-plan-state-context-projection.md`
- `../../understanding/space-system-design.md`

验证：

- `bun test`
- `bun run typecheck`
- `git diff --check`
- 多组真实 DeepSeek `bun -e` agent 缓存实验

## 背景

目标是让 code agent 在 coding 场景里尽量接近 Claude Code 一类产品的高 prompt cache 命中率。DeepSeek 在响应元数据里返回 prompt cache hit/miss token，因此可以基于 `cache_metrics` 建立本地标准，并用真实多轮 agent 任务验证 prompt 布局。

短轮次对话不足以判断缓存策略。有效实验必须使用足够大的稳定前缀，并区分首次读取新大文件造成的自然 miss 与 no-new-file follow-up 的稳定前缀复用。

## 缓存标准

本次实现把 `cache_metrics` 扩展为可评估的标准：

- 目标命中率：`0.95`。
- warmup 调用数：`1`。
- 进入评估的最小 measured input tokens：`8000`。
- 汇总方式：按 token 加权，使用 `cacheHitTokens / inputTokens`。
- 未达到最小 measured tokens 前，`meetsTarget` 为 `null`。

相关实现位于 `src/shared/cache-metrics.ts` 和 `src/app/runner.ts`，测试位于 `tests/cache-metrics.test.ts`。

## 实验矩阵

### 稳定大前缀基线

直接构造约 25k input token 的稳定前缀，DeepSeek cache 行为正常：

| 调用 | cacheHitTokens / inputTokens | 命中率 |
| --- | --- | --- |
| 2 | `25216 / 25250` | `99.87%` |
| 3 | `25216 / 25262` | `99.82%` |
| 4 | `25216 / 25274` | `99.77%` |

结论：provider 本身可以稳定缓存大前缀，问题主要在 agent prompt 布局和动态状态位置。

### 大文件首次读取与 follow-up

真实 agent 读取大文件时，第一次把新工具结果引入上下文会产生大量 miss；这不是缓存失效，而是新内容首次出现。

write 模式下，在不读取新文件的 follow-up 中达到：

| 场景 | cacheHitTokens / inputTokens | 命中率 |
| --- | --- | --- |
| write no-new-file follow-up | `22912 / 22987` | `99.67%` |

### 合成状态并入最新用户消息

尝试把 read-only / plan 合成状态并入最新 `HumanMessage`，真实 read-only 大上下文 follow-up 结果很差：

| 场景 | cacheHitTokens / inputTokens | 命中率 |
| --- | --- | --- |
| merge into latest HumanMessage | `2688 / 23142` | `11.60%` |

原因是 prompt 投影不是 checkpoint 状态。第一轮 checkpoint 中保存的真实用户消息不包含合成状态；下一轮再把合成状态拼进新的用户消息，会在很早的位置破坏前缀。

结论：合成状态必须是独立尾部消息，不能并入真实用户消息。

### ToolMessage 改写风险

曾考虑把工具结果改写为其他 role 以改善缓存，但这会破坏 LangGraph / LangChain 的 `AIMessage.tool_calls[]` + `ToolMessage` 协议结构。

结论：工具调用链必须保持原始消息类型。缓存问题应通过 prompt 布局解决，而不是把 `ToolMessage` 替换成 `HumanMessage`。

### 尾部 SystemMessage 实验

只把 read-only 合成状态作为尾部 `SystemMessage` 时，单纯 read-only no-new-file follow-up 表现很好：

| 场景 | cacheHitTokens / inputTokens | 命中率 |
| --- | --- | --- |
| read-only tail SystemMessage follow-up | `27392 / 27490` | `99.64%` |

但在 plan + read-only 多轮实验中，如果高频变化的 `graph.state.plan` 也使用尾部 `SystemMessage`，plan 更新后出现明显断崖：

| 场景 | cacheHitTokens / inputTokens | 命中率 |
| --- | --- | --- |
| plan SystemMessage 更新后 | `1024 / 31373` | `3.26%` |
| 下一轮 follow-up | `2816 / 31372` | `8.98%` |

推断：DeepSeek 或 OpenAI-compatible adapter 可能会对多个 system message 做提升、合并或重排。动态 `SystemMessage` 即使放在数组尾部，也可能影响更早的 provider 前缀。

结论：高频动态 runtime-state 不应使用 `SystemMessage`。

### 混合方案

保留 read-only `SystemMessage`，plan 改为独立尾部 `HumanMessage` 后，plan + read-only 多轮恢复高命中：

| 场景 | cacheHitTokens / inputTokens | 命中率 |
| --- | --- | --- |
| 第二轮 no-new-file | `31360 / 31701` | `98.92%` |
| 第三轮 update_plan 后最终调用 | `32384 / 32623` | `99.27%` |

结论：plan 必须用独立尾部 `HumanMessage`。

### read-only 频繁切换风险

用户指出 `read-only` / `write` 在某些场景也可能频繁切换，因此 read-only 继续使用 `SystemMessage` 仍有潜在 provider 重排风险。

把 read-only 也改为独立尾部 `HumanMessage` 后，真实访问权限切换实验如下：

| 场景 | cacheHitTokens / inputTokens | 命中率 |
| --- | --- | --- |
| read-only 大上下文后切到 write | `29184 / 30148` | `96.80%` |
| 再切回 read-only | `30080 / 30640` | `98.17%` |

结论：统一使用尾部 `HumanMessage` 更稳，能避免动态 `SystemMessage` 在访问权限切换场景中的 provider 差异风险。

### 最终全 Human runtime-state 方案

最终形态中，`workspaceAccess` 和 `plan` 都作为独立尾部 `HumanMessage`。真实 plan + read-only 多轮实验结果：

| 场景 | cacheHitTokens / inputTokens | 命中率 | 说明 |
| --- | --- | --- | --- |
| 第一轮读大文件后最终调用 | `29440 / 32043` | `91.88%` | 同轮多次首次读取大文件，自然 miss 较多 |
| 第二轮 no-new-file follow-up | `30208 / 32071` | `94.19%` | 无断崖，但略低于 95% |
| 第三轮 update_plan 后首调用 | `32000 / 32644` | `98.03%` | warmup，不计入标准 |
| 第三轮 update_plan 后最终调用 | `32000 / 33046` | `96.83%` | 计入标准并达标 |

结论：最终方案没有复现动态 `SystemMessage` 的 3% / 8% 断崖。第二轮 no-new-file 低于 95%，说明真实 agent 输出形态仍会引入少量波动；但后续 measured 调用达标，且访问权限切换实验稳定超过 95%。

## 当前实现结论

最终消息顺序：

```text
SystemMessage(static agent contract)
SystemMessage(cacheable runtime context)
...compacted conversation messages
HumanMessage(synthetic graph.state.workspaceAccess reminder, only when read-only)
HumanMessage(synthetic graph.state.plan reminder, when plan exists)
```

关键规则：

- `system` 前缀只放稳定 contract 和可缓存 runtime context。
- 真实 `HumanMessage` / `AIMessage` / `ToolMessage` 会话历史保留原始结构。
- 合成 runtime-state 必须在真实会话之后，且作为独立尾部 `HumanMessage`。
- 不把 runtime-state 并入真实用户消息。
- 不把动态状态写入 `buildCacheableRuntimeContext`。
- 不把工具结果改写成用户消息。

## 影响的文件

- `src/model/context.ts`：调整消息顺序和合成 runtime-state role。
- `src/model/runtime-context.ts`：保留 runtime-state 格式化函数。
- `src/app/runner.ts`：在事件流中输出带标准评估的 `cache_metrics`。
- `src/shared/cache-metrics.ts`：新增 95% 命中率标准、warmup 和最小 measured token 门槛。
- `tests/context.test.ts`：固定 ToolMessage 保留、plan/read-only 尾部 `HumanMessage` 和组合场景。
- `tests/cache-metrics.test.ts`：覆盖 cache 标准、token 加权和最小 token 门槛。
- `README.md`：记录缓存指标标准。
- `docs/space/execution/active/plan-state-reminder.md`：更新当前有效 prompt 布局规则。

## 剩余风险

- 真实实验基于当前 DeepSeek 配置；其他 OpenAI-compatible provider 可能有不同的 message 归一化策略。
- `cache_metrics` 标准会按每次 `streamCodeAgent` 调用创建 tracker；跨 CLI/API 请求的长期聚合目前仍需要外部消费事件流。
- 第二轮 no-new-file follow-up 曾出现 `94.19%`，说明即使布局正确，真实 agent 输出和 provider 行为仍可能有小幅波动。
- 未来如果引入更多合成 runtime-state，应默认使用独立尾部 `HumanMessage`，并重新跑真实大上下文缓存实验。
