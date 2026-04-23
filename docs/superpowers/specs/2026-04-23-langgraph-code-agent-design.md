# LangGraph Code Agent Design

## Goal

Build a standalone Bun/TypeScript code-agent project in `D:\app\openpx-new` using LangGraph.js. The agent must run against the user's DeepSeek configuration, persist local execution state in SQLite, stream progress, support human interrupts and resume, maintain short-term and long-term memory, coordinate multiple agent roles, and expose code-editing tools for `apply_patch` and shell execution.

## Scope

The project is a reference implementation, not an OpenPX integration. It should be usable from tests and from a CLI. The implementation must keep the LangGraph pieces visible instead of hiding them behind a large framework.

## Architecture

Use a LangGraph `StateGraph` as the durable run loop. The graph state stores the current task, messages, plan, tool request, tool results, final answer, and role trace. It is compiled with `SqliteSaver` from `@langchain/langgraph-checkpoint-sqlite` so every run step is checkpointed by `thread_id`.

DeepSeek is accessed through LangChain's `ChatDeepSeek` integration from `@langchain/deepseek`. The config loader reads JSONC from `C:\Users\Administrator\.openpx\openpx.jsonc` by default, with optional overrides for tests or CLI usage.

Long-term memory is implemented as a small SQLite table using Bun's built-in `bun:sqlite`. It stores namespaced key/value memories by `user_id`, so a second thread can recall facts saved by a previous thread. Short-term memory is the graph checkpoint state for a single `thread_id`.

## Graph Flow

The graph has four role nodes:

1. `planner`: uses DeepSeek to produce a concise plan.
2. `coder`: uses DeepSeek to choose one next action: `apply_patch`, `shell`, `remember`, or `finish`.
3. `toolReview`: interrupts before risky tool execution and returns a structured approval request.
4. `reviewer`: uses DeepSeek to review the result and produce the final answer.

Conditional edges route from planner to coder, from coder to toolReview or reviewer, from toolReview back to coder, and from reviewer to `END`.

## Tools

`apply_patch` accepts a target file and replacement content. For the first implementation, it writes complete file contents under the workspace root and refuses paths that escape the workspace. This keeps the tool reliable for end-to-end validation while still representing code edits.

`shell` executes a command in the workspace via Bun's `$` shell API. The tool returns stdout, stderr, exit code, and command metadata. It refuses commands that clearly try to leave the workspace or perform destructive operations unless approved by the graph interrupt.

## Interrupts

The graph calls LangGraph `interrupt()` from `toolReview` with a JSON payload describing the proposed action. The caller resumes with `new Command({ resume })` using the same `thread_id`. A `true` or `{ approved: true }` resume value executes the action. A rejected resume value records the rejection and routes back to coder.

## Streaming

The public runner exposes an async stream wrapper around `graph.stream(..., { streamMode: ["updates", "custom"] })`. It emits normalized events for node updates, model decisions, tool results, interrupts, and final output.

## Tests

Tests are written with `bun test`. The real end-to-end test must use DeepSeek through the config file and run the complete graph flow:

- Start a new thread.
- Receive a streamed interrupt for a proposed patch.
- Resume with approval.
- Verify a file was created in a temporary workspace.
- Start a second thread with the same user ID.
- Verify long-term memory from the first thread can influence the second run.
- Verify the SQLite checkpoint database exists and has persisted state.

Non-model tests may cover path safety and memory persistence, but the acceptance test is the real DeepSeek graph flow.

## Error Handling

Config errors should name the missing field without printing secrets. Tool failures are recorded in state and returned to the model for recovery. Interrupt rejections are recorded as tool results instead of throwing. SQLite setup creates parent directories automatically.

## Source References

LangGraph JS persistence docs describe thread-scoped checkpoints and checkpointer libraries including `@langchain/langgraph-checkpoint-sqlite`.

LangGraph JS interrupt docs describe `interrupt()` payloads and resuming with `new Command({ resume })` on the same `thread_id`.

LangGraph JS streaming docs describe streaming graph updates and custom events.

LangGraph memory docs distinguish short-term thread state from long-term cross-thread stores.

LangChain DeepSeek docs describe `ChatDeepSeek` from `@langchain/deepseek`, including tool calling and token-level streaming support for `deepseek-chat`.

## Self-Review

No placeholders remain. The scope is intentionally a standalone reference project. The design uses SQLite for both LangGraph checkpoints and project-owned long-term memory. Tool semantics are narrow enough to validate safely while still demonstrating code-agent behavior.
