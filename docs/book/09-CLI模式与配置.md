# 第九章 CLI、模式与配置

## 9.1 CLI

入口为 `src/app/cli/index.ts`：

```bash
bun run agent run --task "检查并修复测试"
bun run agent resume --thread <thread-id>
bun run agent trace <events.jsonl> --turn 1
```

CLI 支持 workspace、thread、Runtime 数据库路径、interaction mode、授权恢复参数、Skill activation、feature override 和 trace 输出。帮助文本中的历史参数名可能为兼容入口，架构语义以 Runtime mode/policy 为准。

## 9.2 Interaction mode

| 模式 | 目标 |
| --- | --- |
| `accept_edits` | 保持更强的人机确认边界 |
| `auto` | 结合 effect classification 与 auto review 自动推进 |
| `full` | 提高本地自治度，但不绕过未知/外部写入等强制边界 |

Mode 不等于 authorization grant，authorization 也不等于 sandbox。三者由 Runtime Policy 分别处理。

## 9.3 配置来源

用户配置与项目配置使用 JSONC，并由 Zod 校验后合并。主要配置域包括：

```jsonc
{
  "provider": {},
  "theme": "dark",
  "colorPreset": "default",
  "interactionMode": "auto",
  "sandbox": { "enabled": true },
  "autoReview": {},
  "compaction": {},
  "mcpServers": {},
  "features": {}
}
```

Provider 支持 `deepseek`、`openai`、`openai-compatible` 和 `ollama`，统一通过 AI SDK 模型边界调用。API key 和配置字符串支持环境变量展开。

模型可使用字符串简写，也可声明正式能力字段：

```jsonc
{
  "provider": {
    "local": {
      "type": "openai-compatible",
      "model": "coder",
      "models": [{
        "name": "coder",
        "contextWindow": 131072,
        "maxOutputTokens": 8192,
        "tokenizerFamily": "cl100k_base",
        "supportsUsageMetadata": true,
        "supportsPromptCache": false
      }]
    }
  }
}
```

显式模型条目优先于内置模型目录和兼容 `modelKwargs`。未知模型不会获得假定上下文窗口；此时 Runtime 仍可调用模型，但上下文 utilization 显示为 unknown，并对 Capability disclosure 使用保守预算。

自动 M2 需要默认关闭的 `features.contextCompactionAutoV1` 与 `compaction.autoMode` 共同开启。`autoMode` 只允许 `off | shadow | live`；未配置时为 `off`。`shadow` 只计算 trigger eligibility 术语（触发资格），不调用摘要模型、不写 checkpoint 术语（检查点）；`live` 命中 `triggerRatio` 或 `triggerTokens` 后产生 `reason=auto`。`compaction` 还可配置 `warningRatio`、`compactRatio`、兼容字段 `softRatio`、`hardRatio`、`targetRatio`、`minimumReductionRatio`、`cooldownTurns`、`recentTurns`、`maxSummaryTokens`、`maxSummaryInputTokens`、`providerSafetyRatio`、`maxAutoCompactionsPerWindow`、`autoCompactionWindowTurns`、`maxConsecutiveLowGain`。其中 pressure/target ratio 术语（压力/目标比例）只作诊断或触发启发式，不构成 Provider admission 术语（模型供应商接纳）门禁。当前 summary request 术语（摘要请求）复用主模型（`tools: {}`，temperature 0），自定义指令作为数据字段传入。

## 9.4 MCP 配置

MCP server 可配置 stdio/HTTP transport、`enabled`、`required`、`cwd`、timeout、trust 和逐工具 policy override。`enabledTools` 是 allowlist，`disabledTools` 随后应用，最后由 `tools.<name>.enabled` 精确覆盖。逐工具配置还使用 `effects`、`minimumApproval`、`retry` 和 `idempotencyKeyArgument`，不使用旧的单一 `risk` 字段作为权威策略。开启默认关闭的 `mcpProviderActionV1` 后，非 ready/degraded 的 required Provider 会在首次模型调用前要求 Retry、当前 session waiver 或 Cancel Run；waiver 不会恢复该 Provider 的 capability 可见性。

默认 MCP 规范来源只有 project `<workspace>/.kite-code/mcp.json` 与 user `~/.kite-code/mcp.json`，优先级为 `project > user`。旧 hash workspace 文件、`.mcp.json` 和 `kite-code.jsonc#mcpServers` 只读并通过显式迁移进入规范位置。所有 project 来源必须匹配 `~/.kite-code/mcp-project-approvals.jsonc` 中绑定 workspace/source/name/config digest 的本地决定；未批准、已拒绝、配置变化或存储损坏时不创建 transport，且不回退同名低优先级 Server。项目批准只保留 allowlist、denylist、精确 disable、`minimumApproval: user` 和 `retry: never` 等收紧项，不采纳 annotation trust、精确 enable 或逐工具放宽策略。显式 `configPath` 是调用方授权的单文件来源，不与 workspace 来源合并。

`McpSupervisor` 投影全部来源和 shadow 状态，`McpConfigRepository` 使用 expected revision、JSONC edit 与原子 rename 提供 add/update/remove/set_enabled/migrate；文件 watcher 只触发 debounce 后全量 reload，外部冲突不覆盖。TUI `/mcp` 可通过 typed mutation 向 project/user 两个规范位置添加最小 Server、启停和移除，但不编辑高级字段或执行 legacy migrate。项目配置只可在脱敏 Review 页面按当前摘要决定，不能隐式自批。

## 9.5 Feature flags

Engine/Lifecycle 迁移由注册表中的 feature flags 控制。Flag 关闭时按各 active 规则 fail closed 或回到当前受治理路径，不允许恢复已删除的旧 MCP adapter、Prompt Skill 或旧状态机。

`toolSearchV1`（原 `capabilitySearchV1`）控制 MCP 工具渐进披露：≤20 工具时直接 binding，>20 工具时通过 `tool_search` 搜索发现。

上下文压缩使用三个独立 flag 术语（功能开关）：`contextCompactionV2` 保护 checkpoint/summary 基础契约且默认开启；`contextCompactionAutoV1` 控制自动压缩灰度且默认关闭，不会把 Provider 术语（模型供应商）错误转换为自动压缩；`contextCompactionManualV1` 控制 `/compact` 命令且默认开启。压缩原因只允许 `manual | auto`。`/compact` 接受可选的自定义摘要指令（作为数据字段 `customPreferences` 传入而非 system prompt 术语（系统提示词））；`/context` 显示分项 token 占用和压缩状态。`/compact reset` 清除 active checkpoint 术语（活动检查点），不以本地容量比例阻止重置，也不清除 Runtime correctness hard block 术语（运行时正确性硬阻断）。
