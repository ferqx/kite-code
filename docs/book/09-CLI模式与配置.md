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
  "mcpServers": {},
  "features": {}
}
```

Provider 支持 `deepseek`、`openai`、`openai-compatible` 和 `ollama`，统一通过 AI SDK 模型边界调用。API key 和配置字符串支持环境变量展开。

## 9.4 MCP 配置

MCP server 可配置 stdio/HTTP transport、`enabled`、`required`、`cwd`、timeout、trust 和逐工具 policy override。`enabledTools` 是 allowlist，`disabledTools` 随后应用，最后由 `tools.<name>.enabled` 精确覆盖。逐工具配置还使用 `effects`、`minimumApproval`、`retry` 和 `idempotencyKeyArgument`，不使用旧的单一 `risk` 字段作为权威策略。开启默认关闭的 `mcpProviderActionV1` 后，非 ready/degraded 的 required Provider 会在首次模型调用前要求 Retry、当前 session waiver 或 Cancel Run；waiver 不会恢复该 Provider 的 capability 可见性。

默认 MCP 规范来源只有 project `<workspace>/.kite-code/mcp.json` 与 user `~/.kite-code/mcp.json`，优先级为 `project > user`。旧 hash workspace 文件、`.mcp.json` 和 `kite-code.jsonc#mcpServers` 只读并通过显式迁移进入规范位置。所有 project 来源必须匹配 `~/.kite-code/mcp-project-approvals.jsonc` 中绑定 workspace/source/name/config digest 的本地决定；未批准、已拒绝、配置变化或存储损坏时不创建 transport，且不回退同名低优先级 Server。项目批准只保留 allowlist、denylist、精确 disable、`minimumApproval: user` 和 `retry: never` 等收紧项，不采纳 annotation trust、精确 enable 或逐工具放宽策略。显式 `configPath` 是调用方授权的单文件来源，不与 workspace 来源合并。

`McpSupervisor` 投影全部来源和 shadow 状态，`McpConfigRepository` 使用 expected revision、JSONC edit 与原子 rename 提供 add/update/remove/set_enabled/migrate；文件 watcher 只触发 debounce 后全量 reload，外部冲突不覆盖。TUI `/mcp` 可通过 typed mutation 向 project/user 两个规范位置添加最小 Server、启停和移除，但不编辑高级字段或执行 legacy migrate。项目配置只可在脱敏 Review 页面按当前摘要决定，不能隐式自批。

## 9.5 Feature flags

Engine/Lifecycle 迁移由注册表中的 feature flags 控制。Flag 关闭时按各 active 规则 fail closed 或回到当前受治理路径，不允许恢复已删除的旧 MCP adapter、Prompt Skill 或旧状态机。
