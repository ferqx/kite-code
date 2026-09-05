# Kite Code

[English](README.md) | **中文**

[![Required checks](https://github.com/ferqx/kite-code/actions/workflows/required.yml/badge.svg)](https://github.com/ferqx/kite-code/actions/workflows/required.yml)

**可控、可恢复、可验证的开源代码 Agent。**

Kite Code 在终端中理解代码、修改文件、运行命令并验证结果。它支持多种模型，提供交互式 TUI 和 Headless CLI。

<p align="center">
  <a href="terminal.png">
    <img src="terminal.png" alt="Kite Code 终端界面" width="100%">
  </a>
</p>

## 为什么选择 Kite Code

- **多模型**：支持 DeepSeek、OpenAI、OpenAI-compatible 和 Ollama。
- **可恢复**：持久化会话状态，支持 Restore 和 Fork。
- **有边界**：通过审批、授权和 sandbox 控制副作用。
- **可扩展**：支持 Builtin Tool、MCP 和 Subagent；Skill Workflow 受 feature flag 控制，默认关闭。
- **重验收**：使用 Receipt、Artifact 和 Verification 判断任务是否完成。

## 快速开始

需要先安装 [Bun](https://bun.sh/)。

```bash
bun install
bun run tui
```

源码开发命令会通过stdio启动同build、由TUI parent持有的App Server，不构建Web资产，也不发现共享进程。`/status`只显示transport、
profile、build、App Server版本与已验证的配对状态；TUI退出后Session仍持久保留，不再需要`tui:fresh`或手动处理旧Service。
首次启动时，按照界面引导配置模型Provider。

Headless CLI：

```bash
bun run agent run \
  --workspace . \
  --trust-workspace \
  --task "检查并修复测试"
```

完整参数以 `bun run agent --help` 为准。

## 本地 Service 与 Web

不打开TUI时，可使用以下命令构建Web assets、显式启动App Server daemon并打印稳定的loopback根地址：

```bash
bun run server
```

daemon根地址就是Web入口；同一origin提供`/v1`与`/api-docs`。默认TUI/CLI各有配套stdio App Server并共享durable
`kite-session.sqlite` facts；它们不打开Web端口。访问daemon的`/`会建立HttpOnly只读Browser session。显式daemon生命周期为
`bun run agent server start|status|stop`；`bun run agent web`只发现已运行daemon。
`bun run --cwd apps/kite-web dev`仍只是前端开发用的Vite asset server。

## 文档

- [项目全景](docs/book/01-项目全景.md)
- [CLI 与配置](docs/book/09-CLI模式与配置.md)
- [Runtime 架构](docs/active/six-concept-runtime-architecture.md)
- [工具与安全策略](docs/book/05-工具系统与安全策略.md)
- [MCP 与 Skills](docs/book/11-MCP与Skills扩展.md)
- [当前行为规则](docs/active/)
