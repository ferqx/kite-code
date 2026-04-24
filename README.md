# LangGraph Code Agent for Bun

This is a standalone Bun/TypeScript code-agent reference built with LangGraph.js and DeepSeek.

## Features

- LangGraph `StateGraph` with a phase-1 hardened `agent -> approval/tools -> agent` loop.
- Plan mode with read-only tools, human confirmation, and builder-mode handoff.
- Context budgeting with compacted history summaries and execution evidence.
- Prompt cache metric extraction from streamed model responses.
- Bun-native SQLite checkpointer for short-term thread persistence.
- Streaming graph updates with normalized interrupt and final events.
- Human-in-the-loop approval through LangGraph `interrupt()` and `Command({ resume })`.
- Workspace-safe file patch tool and structured shell tool results.
- Real DeepSeek end-to-end test.

## Setup

Install dependencies:

```bash
bun install
```

The default model config is read from the current user's home directory:

```text
~/.openpx/openpx.jsonc
```

Examples: `C:\Users\<user>\.openpx\openpx.jsonc` on Windows, `/Users/<user>/.openpx/openpx.jsonc` on macOS, and `/home/<user>/.openpx/openpx.jsonc` on Linux.

The expected config shape is:

```jsonc
{
  "provider": {
    "deepseek": {
      "apiKey": "sk-...",
      "baseURL": "https://api.deepseek.com/v1"
    }
  },
  "model": {
    "default": {
      "provider": "deepseek",
      "name": "deepseek-chat"
    }
  }
}
```

## Run

Start a task:

```bash
bun run agent run --thread demo --user local --task "Create hello.txt with exact content \"hello\""
```

Force planning mode, or leave the default `auto` mode to detect explicit planning requests:

```bash
bun run agent run --mode plan --thread demo --user local --task "Inspect the change and propose a plan"
```

When the stream emits an `interrupt` event, approve and resume:

```bash
bun run agent resume --thread demo --user local --approve
```

By default, the CLI writes the checkpoint SQLite file under `.openpx/` in the current workspace. You can override the path with `--checkpoints`.

## Test

Unit-level tests:

```bash
bun test tests/config.test.ts tests/tools.test.ts tests/checkpoint.test.ts
```

Real DeepSeek end-to-end test:

```bash
bun run test:real
```

The real test calls `deepseek-chat`, streams to an interrupt, resumes approval, writes a file, and checks the checkpoint database.
