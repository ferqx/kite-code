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

Use Bun 1.4.2, install the locked dependencies, and build the new workspaces and Terminal candidate:

```bash
bun install --frozen-lockfile
bun run build
bun run release:build
bun run tui
```

The formal TUI and CLI select the complete candidate in `dist/unified-terminal`. Each launcher starts its paired Service and uses the shared HTTP/SSE Client for business requests. The default profile is separate from the former implementation; this cutover does not migrate old user data. Model configuration and current client behavior are described in the [handbook](docs/handbook/README.md).

Headless CLI:

```bash
bun run agent run \
  --workspace . \
  --trust-workspace \
  --task "Inspect and fix tests"
```

Use `bun run agent --help` for the current command syntax. V1.3 is still being implemented: the default production Shell is currently unavailable, and complete capability and platform qualification is pending. See the [implementation progress](docs/plans/unified-agent-refactor-v1-progress.md) for the exact evidence and limits.

## Local Service and Web

`bun run server` explicitly starts the selected candidate's local daemon and prints its read-only Web address. `bun run agent server start|status|stop|restart` manages that explicit daemon; `bun run agent web` only discovers an existing one. The Browser uses the same public read-only API through its Cookie Gateway. Closing a Browser view does not cancel an active Run.

For development, run `bun run build` and then `bun run web:dev`, `cli:dev`, or `tui:dev`. These entries use the explicit `development` profile. The Web launcher closes its owned Service when the foreground launcher exits. Current behavior is owned by the [Web](apps/web/README.md) and [CLI/TUI](apps/cli/README.md) workspaces; see [local development](docs/development/local-development.md) for profile and artifact selection.

## Documentation

- [Product handbook (Chinese)](docs/handbook/README.md): shared concepts, client guides, references, and troubleshooting.
- [TUI guide](docs/handbook/clients/tui/README.md) · [Web guide](docs/handbook/clients/web/README.md)
- [CLI](docs/handbook/cli/README.md) · [Server](docs/handbook/server/README.md) · [Client capabilities](docs/handbook/capabilities.md)
- [Developer documentation (Chinese)](docs/development/README.md): architecture, module entrypoints, and verification.
- [Current plans](docs/plans/README.md)

## Unified Agent V1.3 implementation

The root build, typecheck, default tests, CLI/TUI and release tools now select the eight new workspaces. Run `bun run build` and `bun run release:build` before the formal `agent` / `tui` entries; development entries keep their explicit development profile. Current behavior and qualification limits are recorded in the [implementation progress](docs/plans/unified-agent-refactor-v1-progress.md) and [release control](docs/active/release-control.md). Complete V1.3 and three-platform release qualification remain in progress.
