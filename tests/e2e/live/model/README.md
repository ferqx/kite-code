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

以下套件固定使用 provider `deepseek` 和 model `deepseek-flash`，不接受模型覆盖：

```bash
KITE_RUN_LIVE_BACKGROUND_MULTISESSION=1 \
KITE_LIVE_DEEPSEEK_API_KEY=... \
bun run test:model:live:background
```

默认从 TypeScript 服务入口运行。验证桌面端实际携带的服务二进制时，先执行
`bun run --cwd apps/kite-desktop prepare:service`，再增加
`KITE_LIVE_BACKGROUND_SERVICE_EXECUTABLE="$PWD/apps/kite-desktop/service/kite-service"`。
该路径复用同一组真实模型、多会话、后台 Shell 与子 Agent 断言。

默认 endpoint 为 `https://api.deepseek.com/v1`；只有使用受信的 DeepSeek-compatible 代理时才设置 `KITE_LIVE_DEEPSEEK_BASE_URL`。未设置 `KITE_RUN_LIVE_BACKGROUND_MULTISESSION=1` 时 runner 会在建立网络连接前明确拒绝执行。显式 opt-in 后，runner 会先调用该 endpoint 的 `/models`，确认固定模型 `deepseek-flash` 确实被公布；模型不可用时不发送测试提示，并以“场景未建立”快速失败。

Runner 在权限为 `0700` 的临时根目录内创建隔离的 Kite 配置和 Workspace，以权限 `0600` 写入从环境变量取得的 API key，并在 `finally` 中关闭 App Server、递归清理临时目录。测试使用 FIFO 事件屏障控制 child 终态，不让模型或 child 通过 `sleep` 或固定 `task_read` 轮询维持等待。日志只输出固定 provider/model、不可用的 seed 标记、通过的场景及不含正文和稳定 identity 的脱敏 cardinality trace，不输出 key、prompt、request、response 或临时配置。

该套件通过真实 App Server 协议断言以下场景：

- 会话 A 在同一响应中建立两个 `background + required` child，并从持久 waiting admission 到屏障释放保持父模型请求数和 `task_read` 数不变；
- A 等待时创建会话 B，并由真实模型在 B 中调用文件工具；
- A/B 的历史事件及后台执行投影互不串线；
- 屏障释放后 A 以同一 Run identity 收敛两个 required child；
- 会话 C 显式建立获授权的 `after_turn` child，父 Run 先完成，child 终态后按持久化的 `afterTurn.runId` 精确建立且仅建立一个后续 Run；
- 不重启 Service 热重进 A，历史正确投影 `subagent.completed`。

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
- 结果：`auto` 交互模式下，A/B 会话隔离、B 独立交互、后台 Shell 与后台子 Agent 的工具调用及持久终态、A 的主 Run 完成、热重进历史投影全部通过；A 的两项后台执行均为 `completed` 且 `cleanupConfirmed`。Service 环境显式注入指向 Workspace 外启动脚本的 `BASH_ENV` 与 `ENV`，Shell stderr 为空且启动脚本副作用未发生。未保留 provider 请求或响应正文。
- 2026-09-20，provider `deepseek`，要求 model `deepseek-v4-flash`，官方 endpoint 正常可达且凭据通过 `/models` 鉴权。
- 命令：从本地 Kite Code 配置填充 opt-in 变量后运行 `bun run test:model:live:background`。
- 结果：场景未建立。官方 `/models` 只公布 `deepseek-flash` 与 `deepseek-v4-pro`，未公布固定模型 `deepseek-v4-flash`；预检未发送模型提示，也未以其他模型替代通过。此前两次无预检运行均在首个 `model.requested` 后以 `recovery_required / unknown / operator_action` 终止且没有建立 task 调用。
- 2026-09-20，provider `deepseek`，model `deepseek-flash`，官方 endpoint 正常网络条件，seed 不可用。
- 命令：从本地 Kite Code 配置填充 opt-in 变量后运行 `bun run test:model:live:background`。
- 结果：双 required child、A 等待期间的 B 会话交互、A/B 隔离、同 Run 恢复、热重进和 exactly-one after-turn continuation 全部通过。脱敏 trace 为 required task calls `2`、waiting task count `2`、等待前后模型请求 `2 → 2`、`task_read` `0 → 0`、Run identity 保持；after-turn task calls `1`、原 Run 先完成、continuation runs `1`；B 模型响应 `2` 且子 Agent 事件 `0`。未保留 provider 请求或响应正文。
