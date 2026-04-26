# LangGraph Code Agent for Bun

This is a standalone Bun/TypeScript code-agent reference built with LangGraph.js and DeepSeek.

## Features

- LangGraph `StateGraph` with an `agent -> approval/tools -> reflect -> agent` loop.
- Plan mode with read-only tools and no non-dangerous confirmation gate.
- Context budgeting with compacted history summaries plus internal evidence/progress state.
- Prompt cache metric extraction from streamed model responses.
- Bun-native SQLite checkpointer for short-term thread persistence.
- Streaming graph updates with normalized interrupt and final events.
- Human-in-the-loop approval for protected tool execution through LangGraph `interrupt()` and `Command({ resume })`.
- Workspace-safe file patch tool and structured shell tool results.
- Real DeepSeek end-to-end test.

## Source Layout

- `src/app/`: CLI entrypoint, run/resume orchestration, and streamed event normalization.
- `src/harness/`: LangGraph control loop, state, routes, approval, tool dispatch, evidence, progress, and reflection.
- `src/model/`: DeepSeek adapter, static prompts, runtime context, and context compaction.
- `src/tools/`: model tool definitions plus file, shell, and patch tool implementations.
- `src/persistence/`: Bun SQLite LangGraph checkpointer.
- `src/config/`: local `~/.openpx/openpx.jsonc` configuration loader.
- `src/shared/`: shared types and prompt cache metrics.

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

Plan mode ends after the model returns its plan summary. It does not prompt for
a non-dangerous builder handoff; protected builder tools still require approval
when a later builder run requests them.

When the stream emits a protected-tool `interrupt` event, approve and resume:

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

The real test calls `deepseek-chat`, exercises approval for protected tools, writes a file, and checks the checkpoint database.
