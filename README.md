# Kite Code

**English** | [中文](README.zh-CN.md)

[![Required checks](https://github.com/ferqx/kite-code/actions/workflows/required.yml/badge.svg)](https://github.com/ferqx/kite-code/actions/workflows/required.yml)

**A controllable, recoverable, and verifiable open-source coding agent.**

Kite Code understands codebases, modifies files, runs commands, and verifies results from the terminal. It supports multiple models through an interactive TUI and a headless CLI.

<p align="center">
  <a href="terminal.png">
    <img src="terminal.png" alt="Kite Code terminal interface" width="100%">
  </a>
</p>

## Why Kite Code

- **Multi-model**: DeepSeek, OpenAI, OpenAI-compatible providers, and Ollama.
- **Recoverable**: Persistent session state with Restore and Fork.
- **Bounded**: Approvals, authorization, and sandboxing constrain side effects.
- **Extensible**: Builtin Tools, MCP, and Subagents; Skill Workflow is feature-gated and disabled by default.
- **Evidence-backed completion**: Receipts, Artifacts, and Verification determine whether work is complete.

## Quick Start

Install [Bun](https://bun.sh/) first.

```bash
bun install
bun run tui
```

`bun run tui` builds the Web assets and ensures the one Local Service before opening the terminal
UI. On first launch, follow the interface to configure a model provider.

Headless CLI:

```bash
bun run agent run \
  --workspace . \
  --trust-workspace \
  --task "Inspect and fix tests"
```

For all options, run `bun run agent --help`.

## Local Server and Web

To start the Server without opening the TUI:

```bash
bun run server
```

This builds the Web assets, ensures the same Local Service used by the TUI, and prints its stable
loopback root URL. The Service root address is the Web entrypoint; the same origin serves `/v1` and
`/api-docs`. `bun run agent web` ensures the Service and prints the same root URL.

TUI/CLI and Browser reuse one Service, Runtime, listener and `kite.sqlite`. Visiting `/` establishes
an HttpOnly read-only session, then the Browser reads Workspace, Session, History and Checkpoint data from
the Service `/v1` REST API. Use `bun run agent service status|stop|restart` for the only lifecycle;
there is no separate Web service to start or stop. `bun run --cwd apps/kite-web dev` remains only a
Vite asset server.

## Documentation

- [Project overview (Chinese)](docs/book/01-项目全景.md)
- [CLI and configuration (Chinese)](docs/book/09-CLI模式与配置.md)
- [Runtime architecture (Chinese)](docs/active/six-concept-runtime-architecture.md)
- [Tools and safety policy (Chinese)](docs/book/05-工具系统与安全策略.md)
- [MCP and Skills (Chinese)](docs/book/11-MCP与Skills扩展.md)
- [Current behavior rules (Chinese)](docs/active/)
