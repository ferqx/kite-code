# LangGraph Code Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a standalone Bun/TypeScript LangGraph code agent with SQLite persistence, streaming, interrupts, memory, multi-agent roles, patch and shell tools, and a real DeepSeek end-to-end test.

**Architecture:** A LangGraph `StateGraph` coordinates planner, coder, approval, and reviewer nodes. Short-term state is persisted through `SqliteSaver`; long-term memories use a local SQLite table. Public APIs expose `runCodeAgent`, `resumeCodeAgent`, and `streamCodeAgent`.

**Tech Stack:** Bun, TypeScript, LangGraph.js, LangChain DeepSeek, SQLite, JSONC parser, Zod, Bun test.

---

## File Structure

- `package.json`: scripts and dependencies.
- `tsconfig.json`: TypeScript settings for Bun ESM.
- `src/config.ts`: JSONC config loader for DeepSeek credentials and defaults.
- `src/types.ts`: shared agent, event, memory, and tool types.
- `src/memory.ts`: SQLite long-term memory store.
- `src/tools.ts`: workspace-safe patch and shell tools.
- `src/model.ts`: DeepSeek model factory.
- `src/graph.ts`: LangGraph state, graph construction, interrupt handling, and role nodes.
- `src/runner.ts`: high-level run/resume/stream API.
- `src/cli.ts`: small CLI surface.
- `src/index.ts`: public exports.
- `tests/tools.test.ts`: non-model tool safety tests.
- `tests/memory.test.ts`: non-model SQLite memory tests.
- `tests/real-agent.test.ts`: real DeepSeek end-to-end graph test.

## Tasks

### Task 1: Project Scaffold

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `src/index.ts`

- [ ] Write the initial files with Bun scripts: `test`, `test:real`, `typecheck`, and `agent`.
- [ ] Run `bun install`.
- [ ] Run `bun run typecheck`; expect initial success after source files exist.

### Task 2: Config Loader

**Files:**
- Create: `src/config.ts`
- Test: `tests/config.test.ts`

- [ ] Write a failing test that loads a temporary JSONC config and extracts `provider.deepseek.apiKey`, `baseURL`, and `model.default.name`.
- [ ] Run `bun test tests/config.test.ts`; expect failure because `loadAgentConfig` does not exist.
- [ ] Implement `loadAgentConfig`.
- [ ] Run `bun test tests/config.test.ts`; expect pass.

### Task 3: Memory Store

**Files:**
- Create: `src/memory.ts`
- Test: `tests/memory.test.ts`

- [ ] Write a failing test that stores a memory for `user_id` in a SQLite file and reads it from a new store instance.
- [ ] Run `bun test tests/memory.test.ts`; expect failure because `SqliteLongTermMemory` does not exist.
- [ ] Implement the SQLite table and methods `put`, `list`, and `recallText`.
- [ ] Run `bun test tests/memory.test.ts`; expect pass.

### Task 4: Tools

**Files:**
- Create: `src/types.ts`
- Create: `src/tools.ts`
- Test: `tests/tools.test.ts`

- [ ] Write failing tests for path escape rejection and successful patch file creation.
- [ ] Run `bun test tests/tools.test.ts`; expect failure because tool functions do not exist.
- [ ] Implement `assertInsideWorkspace`, `applyPatchTool`, and `shellTool`.
- [ ] Run `bun test tests/tools.test.ts`; expect pass.

### Task 5: Graph and Runner

**Files:**
- Create: `src/model.ts`
- Create: `src/graph.ts`
- Create: `src/runner.ts`
- Modify: `src/index.ts`
- Test: `tests/real-agent.test.ts`

- [ ] Write a real DeepSeek test that starts the graph, receives an interrupt, resumes approval, verifies file creation, verifies checkpoint persistence, and verifies cross-thread memory.
- [ ] Run `bun test tests/real-agent.test.ts --timeout 120000`; expect failure because graph APIs do not exist.
- [ ] Implement model creation, graph construction, role nodes, interrupt/resume handling, and public runner APIs.
- [ ] Run `bun test tests/real-agent.test.ts --timeout 120000`; expect pass with real DeepSeek.

### Task 6: CLI and Final Verification

**Files:**
- Create: `src/cli.ts`
- Modify: `package.json`
- Modify: `README.md`

- [ ] Add CLI commands for `run` and `resume`.
- [ ] Add README usage notes with config path, SQLite data path, and real-test command.
- [ ] Run `bun test`.
- [ ] Run `bun run typecheck`.
- [ ] Run `bun test tests/real-agent.test.ts --timeout 120000`.

## Self-Review

The plan covers all confirmed design requirements. No placeholder implementation steps remain. The real acceptance path uses DeepSeek and validates the full agent loop, not just isolated helpers.
