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

MCP server 可配置 stdio/HTTP transport、`enabled`、`required`、`cwd`、timeout、trust 和逐工具 policy override。逐工具配置使用 `effects`、`minimumApproval`、`retry` 和 `idempotencyKeyArgument`，不使用旧的单一 `risk` 字段作为权威策略。Phase 2 只赋予 `enabled` 和 `cwd` 运行语义；`required` 的任务准入留给后续阶段。

默认 MCP 来源优先级为 local `~/.kite-code/projects/<workspaceKey>/mcp.jsonc`、legacy project `.kite-code/kite-code.jsonc`、project `.mcp.json`、user `kite-code.jsonc`。前三个产品作用域中 local/project/user 可写，legacy project 只读并通过显式迁移进入 `.mcp.json`。两个 project 来源必须匹配 `~/.kite-code/mcp-project-approvals.jsonc` 中绑定 workspace/source/name/config digest 的本地决定；未批准、已拒绝、配置变化或存储损坏时不创建 transport，且不回退同名低优先级 Server。项目批准不采纳项目声明的 annotation trust 或逐工具放宽策略。显式 `configPath` 是调用方授权的单文件来源，不与 workspace 来源合并。

`McpSupervisor` 投影全部来源和 shadow 状态，`McpConfigRepository` 使用 expected revision、JSONC edit 与原子 rename 提供 add/update/remove/set_enabled/migrate；文件 watcher 只触发 debounce 后全量 reload，外部冲突不覆盖。TUI `/mcp` 只消费 effective Server 的连接状态与名称，不写配置，也不暴露 scope 或管理子命令。项目配置通过独立的摘要信任提示决定，不能隐式自批。

## 9.5 Feature flags

Engine/Lifecycle 迁移由注册表中的 feature flags 控制。Flag 关闭时按各 active 规则 fail closed 或回到当前受治理路径，不允许恢复已删除的旧 MCP adapter、Prompt Skill 或旧状态机。
