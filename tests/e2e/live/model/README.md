# 真实模型 E2E 套件

本目录包含显式 opt-in 的真实模型端到端套件。运行受维护的 context compaction 套件：

```bash
KITE_RUN_LIVE_MODEL_COMPACTION=1 \
KITE_LIVE_MODEL_API_KEY=... \
KITE_LIVE_MODEL_BASE_URL=https://provider.example/v1 \
KITE_LIVE_MODEL_NAME=model-name \
bun run test:model:live
```

只有 DeepSeek-compatible endpoint 才设置 `KITE_LIVE_MODEL_PROVIDER_TYPE=deepseek`。Runner 有超时上限，串行执行两次 Provider 调用，只报告标识，不输出 prompt、request、summary、配置或凭据。每个套件必须：

- 使用 `*.live.ts` 文件名；
- 从隔离的环境配置选择 provider 和 model；
- 作为独立 runner，由显式 package script 和 opt-in 环境门禁通过 `bun run` 调用；
- 串行运行并设置超时上限；
- 脱敏凭据、完整 prompt、request 和用户配置；
- 记录所有被引用结果的 provider、model、日期、网络条件和命令。

Mock model、仅公网 MCP 和本地 transport 测试不属于本目录。

## 验证记录

- 2026-07-22，provider `deepseek`，model `deepseek-v4-flash`，正常网络条件。
- 命令：从本地 Kite Code 配置填充 opt-in 变量后运行 `bun run test:model:live`。
- 结果：`manual-direct-summary` 和 `incremental-summary` 通过。本记录未保留 request 或 response 正文。
- 2026-07-29，provider `deepseek`，model `deepseek-v4-flash`，正常本地网络条件。
- 命令：从本地 Kite Code 配置填充 opt-in 变量后运行 `bun run test:model:live`。
- 结果：`manual-direct-summary` 因 `ContextCompactionValidationError: Summary was truncated` 失败，未进入 incremental 场景。本记录未保留 request 或 response 正文。
