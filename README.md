# Kite Code

**English** | [中文](README.zh-CN.md)

[![Required checks](https://github.com/ferqx/kite-code/actions/workflows/required.yml/badge.svg)](https://github.com/ferqx/kite-code/actions/workflows/required.yml)

**A controllable, recoverable, and verifiable open-source coding agent.**

Kite Code helps you understand codebases, modify files, run commands, and check results using multiple models. Use the TUI or CLI to execute tasks, and the local read-only Web interface to inspect sessions and diagnostics.

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
- **Evidence-backed completion**: Required execution evidence and enabled verification checks help determine whether a task is complete.

## Quick Start

Install [Bun](https://bun.sh/) first.

```bash
bun install
bun run tui
```

`bun run tui` starts a same-build, parent-owned App Server over stdio; it does not build Web assets or
discover a shared process. `/status` shows the transport, profile, build, App Server version, and
verified pairing. Sessions remain durable across TUI exits.
On first launch, follow the interface to configure a model provider.

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

This builds the Web assets, explicitly starts the local App Server daemon, and prints its stable
loopback root URL. The same origin serves `/v1` and `/api-docs`. `bun run agent web` only discovers
an already-running daemon and never starts or upgrades it.

Default TUI/CLI each own a same-build stdio App Server and share durable `kite-session.sqlite` facts
through per-Session writer fencing; they do not open Web ports. The explicit daemon owns one stable
Web origin. Visiting `/` establishes an HttpOnly read-only session, then the Browser reads Workspace,
Session, History and Checkpoint data from `/v1`. Use `bun run agent server start|status|stop` for the
explicit daemon lifecycle. `bun run --cwd apps/kite-web dev` remains only a Vite asset server.

## Documentation

- [Product handbook (Chinese)](docs/handbook/README.md): shared concepts, client guides, references, and troubleshooting.
- [TUI guide](docs/handbook/clients/tui/README.md) · [Web guide](docs/handbook/clients/web/README.md)
- [CLI](docs/handbook/cli/README.md) · [Server](docs/handbook/server/README.md) · [Client capabilities](docs/handbook/capabilities.md)
- [Developer documentation (Chinese)](docs/development/README.md): architecture, module entrypoints, and verification.
- [Current plans](docs/plans/README.md)
