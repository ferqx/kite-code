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

## DeepSeek 后台任务与多会话

以下套件固定使用 provider `deepseek` 和 model `deepseek-v4-flash`，不接受模型覆盖：

```bash
KITE_RUN_LIVE_BACKGROUND_MULTISESSION=1 \
KITE_LIVE_DEEPSEEK_API_KEY=... \
bun run test:model:live:background
```

默认 endpoint 为 `https://api.deepseek.com/v1`；只有使用受信的 DeepSeek-compatible 代理时才设置 `KITE_LIVE_DEEPSEEK_BASE_URL`。未设置 `KITE_RUN_LIVE_BACKGROUND_MULTISESSION=1` 时 runner 会在建立网络连接前明确拒绝执行。

Runner 在权限为 `0700` 的临时根目录内创建隔离的 Kite 配置和 Workspace，以权限 `0600` 写入从环境变量取得的 API key，并在 `finally` 中关闭 App Server、递归清理临时目录。日志只输出固定 provider/model 标识及通过的场景，不输出 key、prompt、request、response 或临时配置。

该套件通过真实 App Server 协议断言以下场景：

- 会话 A 同时派发后台 Shell 与后台子 Agent，并在两者运行时保持准确的非终态；
- A 仍有后台执行时创建会话 B，并由真实模型在 B 中调用文件工具；
- A/B 的历史事件及后台执行投影互不串线；
- B 完成后返回 A，Shell 与子 Agent 均达到持久终态；
- 不重启 Service 热重进 A，历史正确投影 `tool.finished` 与 `subagent.completed`。

这是付费且依赖公网的串行 E2E。超时可通过 `KITE_LIVE_BACKGROUND_TIMEOUT_MS` 调整；测试失败也不得把完整 provider payload 加入日志。

## 验证记录

- 2026-07-22，provider `deepseek`，model `deepseek-v4-flash`，正常网络条件。
- 命令：从本地 Kite Code 配置填充 opt-in 变量后运行 `bun run test:model:live`。
- 结果：`manual-direct-summary` 和 `incremental-summary` 通过。本记录未保留 request 或 response 正文。
- 2026-07-29，provider `deepseek`，model `deepseek-v4-flash`，正常本地网络条件。
- 命令：从本地 Kite Code 配置填充 opt-in 变量后运行 `bun run test:model:live`。
- 结果：`manual-direct-summary` 因 `ContextCompactionValidationError: Summary was truncated` 失败，未进入 incremental 场景。本记录未保留 request 或 response 正文。
- 2026-09-20，provider `deepseek`，model `deepseek-v4-flash`，正常本地网络条件。
- 命令：从本地 Kite Code 配置填充 opt-in 变量后运行 `bun run test:model:live:background`。
- 结果：A/B 会话隔离、B 独立交互、后台 Shell 与后台子 Agent 的工具调用及持久终态均通过；A 的两项后台执行已 `completed` 且 `cleanupConfirmed`，但主 Run 在最终模型正文返回后仍停留于 `waiting`，套件因此按预期失败。未保留 provider 请求或响应正文。
