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

This source-development command builds the current Kite Web assets before launching the TUI, so
the URL shown by `/status` always serves the current checkout. On first launch, follow the
interface to configure a model provider.

During source development, `/status` shows the resident Local Service PID, start time, and build
identity. If the TUI reports source build drift, restart the Service safely and launch the TUI with:

```bash
bun run tui:fresh
```

Installed releases reconcile a resident Service from the previous release internally; users do
not need to find, kill, or restart the old process.

Headless CLI:

```bash
bun run agent run \
  --workspace . \
  --trust-workspace \
  --task "Inspect and fix tests"
```

For all options, run `bun run agent --help`.

## Local Web Observer

From a source checkout, one command builds and validates the Web assets, ensures the Local Service
and Web routes, and prints their loopback URL:

```bash
bun run web:dev
```

The terminal TUI/CLI ensures the single Local Service only when needed. `kite web` ensures that
Service and attaches its Browser routes to the same loopback listener. Opening a browser URL never
starts a local server; the page is only a Gateway client. The current local Web surface uses no
Cookie, launch token, or WebSocket authentication ticket. `bun run --cwd apps/kite-web dev` is only
a Vite asset server and does not connect to the Runtime.

## Documentation

- [Project overview (Chinese)](docs/book/01-项目全景.md)
- [CLI and configuration (Chinese)](docs/book/09-CLI模式与配置.md)
- [Runtime architecture (Chinese)](docs/active/six-concept-runtime-architecture.md)
- [Tools and safety policy (Chinese)](docs/book/05-工具系统与安全策略.md)
- [MCP and Skills (Chinese)](docs/book/11-MCP与Skills扩展.md)
- [Current behavior rules (Chinese)](docs/active/)
