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

On first launch, follow the interface to configure a model provider.

Headless CLI:

```bash
bun run agent run \
  --workspace . \
  --trust-workspace \
  --task "Inspect and fix tests"
```

For all options, run `bun run agent --help`.

## Documentation

- [Project overview (Chinese)](docs/book/01-项目全景.md)
- [CLI and configuration (Chinese)](docs/book/09-CLI模式与配置.md)
- [Runtime architecture (Chinese)](docs/active/six-concept-runtime-architecture.md)
- [Tools and safety policy (Chinese)](docs/book/05-工具系统与安全策略.md)
- [MCP and Skills (Chinese)](docs/book/11-MCP与Skills扩展.md)
- [Current behavior rules (Chinese)](docs/active/)
