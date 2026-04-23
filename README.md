# LangGraph Code Agent for Bun

This is a standalone Bun/TypeScript code-agent reference built with LangGraph.js and DeepSeek.

## Features

- LangGraph `StateGraph` with planner, coder, tool-review, and reviewer roles.
- Bun-native SQLite checkpointer for short-term thread persistence.
- Bun-native SQLite long-term memory store keyed by `user_id`.
- Streaming graph updates with normalized interrupt and final events.
- Human-in-the-loop approval through LangGraph `interrupt()` and `Command({ resume })`.
- Workspace-safe file patch tool and structured shell tool results.
- Real DeepSeek end-to-end test.

## Setup

Install dependencies:

```bash
bun install
```

The default model config is read from:

```text
C:\Users\Administrator\.openpx\openpx.jsonc
```

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

When the stream emits an `interrupt` event, approve and resume:

```bash
bun run agent resume --thread demo --user local --approve
```

By default, the CLI writes SQLite files under `.openpx/` in the current workspace. You can override paths with `--checkpoints` and `--memory`.

## Test

Unit-level tests:

```bash
bun test tests/config.test.ts tests/memory.test.ts tests/tools.test.ts tests/checkpoint.test.ts
```

Real DeepSeek end-to-end test:

```bash
bun run test:real
```

The real test calls `deepseek-chat`, streams to an interrupt, resumes approval, writes a file, checks the checkpoint database, and verifies long-term memory across a second thread.
