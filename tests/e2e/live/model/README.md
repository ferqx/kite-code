# 真实模型 E2E 套件

本目录包含显式 opt-in 的真实模型端到端套件。运行受维护的 context compaction 套件：

```bash
KITE_RUN_LIVE_CONTEXT_STRATEGY_PILOT=1 bun run eval:context:live-pilot
```

只有 DeepSeek-compatible endpoint 才设置 `KITE_LIVE_MODEL_PROVIDER_TYPE=deepseek`。Pilot 有超时上限，串行执行
direct/incremental 两次 summary 和三个 continuation Provider 调用；它只输出脱敏 aggregate，不输出 prompt、request、summary、配置或凭据。每个套件必须：

- 使用 `*.live.ts` 文件名；
- 从隔离的环境配置选择 provider 和 model；
- 作为独立 runner，由显式 package script 和 opt-in 环境门禁通过 `bun run` 调用；
- 串行运行并设置超时上限；
- 脱敏凭据、完整 prompt、request 和用户配置；
- 记录所有被引用结果的 provider、model、日期、网络条件和命令。

Mock model、仅公网 MCP 和本地 transport 测试不属于本目录。

`eval:context:live-pilot` 是唯一的真实模型上下文 runner：它验证 direct/incremental summary compatibility，
再在同一实际 summary 后比较 raw、简单 `summary + tail` 和当前 `summary + Working Set`。它只回答该固定事实恢复
用例的 Provider 行为，不是完整 coding-agent 四臂 benchmark、route qualification 或 default-on 证据：

```bash
KITE_RUN_LIVE_CONTEXT_STRATEGY_PILOT=1 bun run eval:context:live-pilot
```

- 2026-08-12，provider `deepseek`，model `deepseek-v4-flash`，正常本地网络条件。
- 结果：direct/incremental summary compatibility 均通过；raw 恢复 4/4 个固定事实，rolling 和 progressive
  Working Set 均恢复 0/4。三者输入 token 分别为 14,208 / 482 / 2,478。该结果是 failure signal，不构成策略
  有效性或 rollout 证据；未保留正文。

历史 `context-compaction.live.ts` 不再由 package script 发现或运行；保留源码只为追溯旧记录，不得作为第二个
真实模型入口。

## 验证记录

- 2026-07-22，provider `deepseek`，model `deepseek-v4-flash`，正常网络条件。
- 历史命令：`bun run test:model:live`（现已由 `eval:context:live-pilot` 取代）。
- 结果：`manual-direct-summary` 和 `incremental-summary` 通过。本记录未保留 request 或 response 正文。
- 2026-07-29，provider `deepseek`，model `deepseek-v4-flash`，正常本地网络条件。
- 历史命令：`bun run test:model:live`（现已由 `eval:context:live-pilot` 取代）。
- 结果：`manual-direct-summary` 因 `ContextCompactionValidationError: Summary was truncated` 失败，未进入 incremental 场景。本记录未保留 request 或 response 正文。
