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

源码开发命令会先构建当前Kite Web assets再启动TUI，因此`/status`显示的URL始终对应当前checkout。首次启动时，按照界面引导配置模型 Provider。

源码开发时，`/status`会显示常驻Local Service的PID、启动时间与build identity。如果TUI提示源码build drift，使用以下命令
安全重启Service并启动TUI：

```bash
bun run tui:fresh
```

正式安装版会在内部安全换代上一版本遗留的Service；用户不需要查找、结束或手动重启旧进程。

Headless CLI：

```bash
bun run agent run \
  --workspace . \
  --trust-workspace \
  --task "检查并修复测试"
```

完整参数以 `bun run agent --help` 为准。

## 本地 Web Observer

源码 checkout 使用一条命令完成 Web asset 构建与前检、按需启动 Coordinator/Web Gateway，并打印一次性 loopback URL：

```bash
bun run web:dev
```

终端 TUI/CLI 只在需要时 ensure Coordinator 与目标 Workspace Worker；`kite web` ensure Coordinator 与唯一 Web Gateway。
浏览器打开 URL 不负责启动本机 server，页面只是 Gateway client。`bun run --cwd apps/kite-web dev` 只是前端开发用的 Vite
asset server，不等于带认证、Coordinator discovery 与 Worker 连接的完整 Gateway。若失败启动留下了可由 exact PID/start-token
证明已死亡的残留，可执行 `bun run agent web recover`；进程仍存活或身份不确定时继续 fail closed。

## 文档

- [项目全景](docs/book/01-项目全景.md)
- [CLI 与配置](docs/book/09-CLI模式与配置.md)
- [Runtime 架构](docs/active/six-concept-runtime-architecture.md)
- [工具与安全策略](docs/book/05-工具系统与安全策略.md)
- [MCP 与 Skills](docs/book/11-MCP与Skills扩展.md)
- [当前行为规则](docs/active/)
