# Kite Code

Kite Code 是一个基于 Bun、TypeScript 和事件化 Runtime Kernel 的多模型代码 Agent。模型、工具、审批、恢复与验收统一由 Kernel 调度；TUI 和 CLI 共享相同的 Core 行为。

## 当前能力

- React Ink TUI 与 Headless CLI；
- AI SDK 模型边界，支持 DeepSeek、OpenAI、OpenAI-compatible 与 Ollama 配置；
- Runtime Event/State/Effect、SQLite Event Store、Snapshot、Restore/Fork；
- Builtin、MCP、Skill Workflow 与 Subagent 统一 Capability Catalog；
- interaction mode、authorization、approval、auto review 与 sandbox；
- Execution Receipt、Artifact、分级 Verification 与 repair/replan；
- Plan Artifact、上下文压缩、多会话和 PTY 系统测试。

总体架构见 [六概念 Runtime 架构](docs/active/six-concept-runtime-architecture.md)，当前行为规则见 [docs/active](docs/active)。

## 安装

```bash
bun install
```

用户配置位于 `~/.kite-code/kite-code.jsonc`，项目可用 `<workspace>/.kite-code/kite-code.jsonc` 覆盖。最小示例：

```jsonc
{
  "provider": {
    "default": {
      "type": "openai-compatible",
      "apiKey": "${OPENAI_API_KEY}",
      "baseURL": "https://example.com/v1",
      "model": "model-name"
    }
  },
  "interactionMode": "auto",
  "sandbox": { "enabled": true }
}
```

模型调用统一通过 AI SDK/OpenAI-compatible 边界。Provider 专有 reasoning 和缓存行为隔离在 `src/core/model/`，不会进入 Runtime 策略。

MCP 配置优先级为本机 workspace 覆盖 `~/.kite-code/projects/<workspaceKey>/mcp.jsonc`、legacy 项目 `.kite-code/kite-code.jsonc`、共享项目 `.mcp.json`、用户 `~/.kite-code/kite-code.jsonc`。legacy 来源只读，可在管理中心显式迁移到 `.mcp.json`。两个项目来源不会在首次发现时自动启动：打开 `/mcp` 进入 approval 页后，连续两次按 `a` 批准当前配置摘要，或连续两次按 `r` 拒绝；项目配置变化后必须重新批准。批准只允许连接，不能降低 MCP Tool 的 effect、审批或重试策略。

`/mcp` 提供响应式管理中心；`/mcp <server>` 打开详情，`/mcp retry <server>` 重新经过配置与审批门禁。管理中心可浏览 health、typed diagnostic、Tools、Resources 与 Prompts，并通过 `/mcp add`、`/mcp enable|disable|remove <server>`、`/mcp approve|reject <server>` 和 `/mcp reload` 管理非 OAuth 配置。项目 add 保存后仍需单独批准，删除和迁移必须显式确认。

## 运行

交互式 TUI：

```bash
bun run tui
```

CLI：

```bash
bun run agent run --thread demo --workspace . --task "检查并修复测试"
bun run agent resume --thread demo --approve
bun run agent trace events.jsonl --turn 1
```

常用参数以 `bun run agent --help` 输出和 `src/app/cli/index.ts` 为准。`--checkpoints` 是保留的 CLI 参数名，当前数据由 Runtime Store 管理。

## 安全边界

- Capability discovery 不等于授权；动态能力必须具有当前轮 binding。
- `accept_edits`、`auto`、`full` 不会绕过 schema、revision、强制审批或 sandbox。
- 远端 MCP annotation 和 Skill manifest 不能自行授予权限。
- 未获本机用户按配置摘要批准的项目 MCP 不会创建 stdio/HTTP transport。
- 外部写入先记录 invocation intent；未知结果禁止盲重放。
- Tool success 不等于任务完成；required Verification 未通过时不能完成。

## 源码结构

```text
src/protocol/       跨层事件、动作、Capability 与 Verification 契约
src/core/runtime/   Kernel、State、Event、Effect、Scheduler、Store
src/core/model/     AI SDK provider 与上下文边界
src/core/tools/     Builtin Capability provider
src/core/mcp/       MCP supervisor、control snapshot 与 Runtime provider
src/core/skills/    Skill Workflow provider
src/core/subagent/  Subagent provider
src/core/policies/  Mode、审批和副作用策略
src/core/verification/ 验收与恢复
src/app/tui/        React Ink TUI
src/app/cli/        CLI
```

## 验证

```bash
bun test
bun run test:e2e
bun run typecheck
bun run check:core-boundary
bun run check:docs
```

默认测试不访问真实模型。仓库当前没有注册真实模型测试脚本；不要把 mock model 测试表述为真实 provider 验证。
