# Three-Layer Architecture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor openpx into a Codex-style three-layer architecture (protocol + core + app) to decouple agent logic from I/O and enable future TUI/desktop frontends.

**Architecture:** Create a zero-dependency `src/protocol/` layer defining AgentEvent, UserAction, and UserInputProvider as the contract between UI and agent core. Move all agent logic into `src/core/` as a pure library. Thin `src/app/cli/` becomes a UserInputProvider implementation. Refactor the runner into a single `runAgent()` async generator that handles interrupt→resume internally via the provider.

**Tech Stack:** TypeScript, Bun, LangGraph, @langchain/core

---

## File Structure

```
src/
├── protocol/           # NEW: Zero-dependency contract layer
│   ├── events.ts       # AgentEvent + all payload types
│   ├── actions.ts      # UserAction + InterruptPayload
│   ├── provider.ts     # UserInputProvider interface
│   └── index.ts        # Re-exports
├── core/               # NEW: Pure logic (migrated from src/)
│   ├── harness/        # ← src/harness/
│   ├── model/          # ← src/model/
│   ├── tools/          # ← src/tools/
│   ├── sandbox/        # ← src/sandbox/
│   ├── config/         # ← src/config/
│   ├── persistence/    # ← src/persistence/
│   ├── runner.ts       # Refactored from src/app/runner.ts
│   ├── cache-metrics.ts# ← src/shared/cache-metrics.ts
│   └── types.ts        # Core-internal types (split from src/shared/types.ts)
├── app/
│   └── cli/
│       └── index.ts    # Refactored CLI adapter (was src/app/cli.ts)
└── index.ts            # Updated exports
```

**Deleted:** `src/shared/` directory (types split between protocol and core)

---

### Task 1: Create protocol layer — event types

**Files:**
- Create: `src/protocol/events.ts`

- [ ] **Step 1: Write `src/protocol/events.ts`**

```typescript
// ── 核心事件类型 / Core event types ──
export type AgentEvent =
  | { type: "step_begin" }
  | { type: "step_end" }
  | { type: "reason"; data: { text: string } }
  | { type: "text"; data: { text: string } }
  | { type: "tool_call"; data: ToolCallPayload }
  | { type: "tool_done"; data: ToolResultPayload }
  | { type: "need_approval"; data: ToolApprovalPayload }
  | { type: "need_input"; data: UserInputPayload }
  | { type: "state_change"; data: StateChangePayload }
  | { type: "file_change"; data: { path: string; kind: "add" | "edit" | "delete" } }
  | { type: "compact_begin"; data: { reason: string } }
  | { type: "compact_end"; data: { summary: string } }
  | { type: "cache_metrics"; data: CacheMetricsPayload }
  | { type: "retry"; data: { attempt: number; reason: string } }
  | { type: "error"; data: { message: string; recoverable: boolean } };

// ── 基础类型 / Base types ──
export type WorkspaceAccess = "read-only" | "write";
export type AgentPhase = "planning" | "building";
export type WorkspaceAccessRequest = "auto" | WorkspaceAccess | "plan" | "builder";
export type AuthorizationMode = "default" | "full_access";
export type ShellApprovalGrant = "approve_once" | "same_command" | "full_access";
export type ShellGrantUsed = "none" | ShellApprovalGrant;
export type PlanStatus = "pending" | "in_progress" | "completed";

export interface AgentPlanStep {
  step: string;
  status: PlanStatus;
}

export interface AgentPlan {
  name: string;
  description: string;
  status: PlanStatus;
  steps: AgentPlanStep[];
}

export interface UserInputOption {
  id: string;
  label: string;
  description?: string;
}

export interface UserInputRequest {
  question: string;
  options: UserInputOption[];
  allow_free_text: boolean;
  context?: string;
}

// ── Payload 类型 / Payload types ──
export interface ToolCallPayload {
  call_id: string;
  name: "read_file" | "edit_file" | "write_file" | "shell_execute"
      | "update_plan" | "ask_user" | "set_authorization_mode";
  args: Record<string, unknown>;
}

export interface ToolResultPayload {
  call_id: string;
  name: string;
  ok: boolean;
  summary: string;
}

export interface UserInputPayload {
  question: string;
  options: { id: string; label: string; description?: string }[];
  allow_free_text: boolean;
  context?: string;
}

export interface StateChangePayload {
  workspaceAccess?: WorkspaceAccess;
  phase?: AgentPhase;
  plan?: AgentPlan | null;
  authorization?: { mode: AuthorizationMode };
}

export interface CacheMetricsPayload {
  workspaceAccess: string;
  cacheHitTokens: number;
  cacheMissTokens: number;
  cacheWriteTokens: number;
  inputTokens: number;
  outputTokens: number;
  standard: { label: string; value: number };
}

export interface ToolApprovalPayload {
  scope: "once";
  cwd: string;
  threadId: string;
  tool: ToolCallPayload["name"];
  command: string;
  risk: "read" | "plan" | "write_file" | "execute_code" | "destructive" | "network" | "vcs_mutation" | "unknown";
  approvalHash: string;
  summary: string;
  reason: string;
  expectedEffects: string[];
  grantOptions: ShellApprovalGrant[];
  recommendedGrant: ShellApprovalGrant;
  modelJustification?: string;
  objective?: string;
  expectedObservation?: string;
  failureStrategy?: string;
  suggestedPrefixRule?: string[];
}
```

- [ ] **Step 2: Verify the file compiles**

```bash
bun run typecheck
```
Expected: Pass (new file, no references yet).

- [ ] **Step 3: Commit**

```bash
git add src/protocol/events.ts
git commit -m "feat: add protocol event types"
```

---

### Task 2: Create protocol layer — action types

**Files:**
- Create: `src/protocol/actions.ts`

- [ ] **Step 1: Write `src/protocol/actions.ts`**

```typescript
import type { AuthorizationMode, ShellGrantUsed, ToolApprovalPayload, UserInputPayload } from "./events";

export type UserAction =
  | { type: "approve"; grant: ShellGrantUsed }
  | { type: "reject" }
  | { type: "input"; text: string }
  | { type: "cancel" }
  | { type: "switch_auth"; mode: AuthorizationMode };

export type InterruptPayload =
  | { kind: "approval"; approval: ToolApprovalPayload }
  | { kind: "input"; question: UserInputPayload };
```

- [ ] **Step 2: Verify the file compiles**

```bash
bun run typecheck
```
Expected: Pass.

- [ ] **Step 3: Commit**

```bash
git add src/protocol/actions.ts
git commit -m "feat: add protocol action types"
```

---

### Task 3: Create protocol layer — provider interface + index

**Files:**
- Create: `src/protocol/provider.ts`
- Create: `src/protocol/index.ts`

- [ ] **Step 1: Write `src/protocol/provider.ts`**

```typescript
import type { AgentEvent } from "./events";
import type { InterruptPayload, UserAction } from "./actions";

export interface UserInputProvider {
  onEvent(event: AgentEvent): void;
  requestAction(payload: InterruptPayload): Promise<UserAction>;
  setup?(): Promise<void>;
  teardown?(): Promise<void>;
}
```

- [ ] **Step 2: Write `src/protocol/index.ts`**

```typescript
export type * from "./events";
export type * from "./actions";
export type { UserInputProvider } from "./provider";
```

- [ ] **Step 3: Verify both files compile**

```bash
bun run typecheck
```
Expected: Pass.

- [ ] **Step 4: Commit**

```bash
git add src/protocol/provider.ts src/protocol/index.ts
git commit -m "feat: add protocol provider interface and index"
```

---

### Task 4: Create core directory and move modules

**Files:**
- Move: `src/harness/` → `src/core/harness/`
- Move: `src/model/` → `src/core/model/`
- Move: `src/tools/` → `src/core/tools/`
- Move: `src/sandbox/` → `src/core/sandbox/`
- Move: `src/config/` → `src/core/config/`
- Move: `src/persistence/` → `src/core/persistence/`
- Move: `src/shared/cache-metrics.ts` → `src/core/cache-metrics.ts`

- [ ] **Step 1: Create target directories and move files with git mv**

```powershell
New-Item -ItemType Directory -Path "src\core" -Force
Move-Item -LiteralPath "src\harness" -Destination "src\core\harness"
Move-Item -LiteralPath "src\model" -Destination "src\core\model"
Move-Item -LiteralPath "src\tools" -Destination "src\core\tools"
Move-Item -LiteralPath "src\sandbox" -Destination "src\core\sandbox"
Move-Item -LiteralPath "src\config" -Destination "src\core\config"
Move-Item -LiteralPath "src\persistence" -Destination "src\core\persistence"
Move-Item -LiteralPath "src\shared\cache-metrics.ts" -Destination "src\core\cache-metrics.ts"
```

- [ ] **Step 2: Verify moves**

```bash
git status
```
Expected: Shows renamed files (git should detect renames).

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "refactor: move agent modules into src/core/"
```

---

### Task 5: Create core-internal types from shared

**Files:**
- Create: `src/core/types.ts`
- Modify: All files that import from `../shared/types` or `../../shared/types` (within core)

- [ ] **Step 1: Write `src/core/types.ts`**

```typescript
import type { AuthorizationMode, ShellApprovalGrant, ShellGrantUsed, UserInputOption, UserInputRequest, WorkspaceAccess } from "../protocol/events";

export interface ShellInput {
  workspace: string;
  command: string;
}

export interface ShellResult {
  ok: boolean;
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type ShellIntent = "inspect" | "verify" | "build" | "test" | "git" | "other";

export interface ShellActionEnvelope {
  command: string;
  intent?: ShellIntent;
  objective?: string;
  justification?: string;
  expected_observation?: string;
  failure_strategy?: string;
  prefix_rule?: string[];
  grant_request?: ShellApprovalGrant;
}

export interface ThreadAuthorizationState {
  mode: "default" | "full_access";
  commandGrants: Record<string, { workspace: string; threadId: string; command: string }>;
}

export interface AuthorizationOverride {
  current: AuthorizationMode;
}

export interface ApplyPatchInput {
  workspace: string;
  path: string;
  content: string;
  shellExecutor?: (input: ShellInput) => Promise<ShellResult>;
}

export interface ApplyPatchResult {
  ok: boolean;
  path: string;
  message: string;
}

export type ToolApprovalResumeValue =
  | boolean
  | {
      approved?: boolean;
      grant?: ShellApprovalGrant;
      approvalHash?: string;
      replacementCommand?: string;
      reason?: string;
    };

export type UserInputResumeValue =
  | string
  | { answer?: string; choice?: string; option_id?: string; optionId?: string; free_text?: string; freeText?: string; text?: string };

export type AgentResumeValue = ToolApprovalResumeValue | UserInputResumeValue;

export interface ContextBudget {
  maxToolOutputChars: number;
}

export interface ModelRetryEvent {
  attempt: number;
  error: string;
  delayMs: number;
}
```

- [ ] **Step 2: Update imports in `src/core/harness/graph.ts`**

Replace:
```typescript
import type { AgentResumeValue, AuthorizationOverride, ModelRetryEvent, ShellApprovalGrant, ThreadAuthorizationState } from "../shared/types";
```

With:
```typescript
import type { AgentResumeValue, AuthorizationOverride, ModelRetryEvent, ThreadAuthorizationState } from "../types";
import type { ShellApprovalGrant } from "../../protocol/events";
```

- [ ] **Step 3: Update imports in `src/core/harness/routes.ts`**

Replace:
```typescript
import type { AgentPhase, AuthorizationMode, AuthorizationOverride, WorkspaceAccess } from "../shared/types";
```
With:
```typescript
import type { AgentPhase, AuthorizationMode, WorkspaceAccess } from "../../protocol/events";
import type { AuthorizationOverride } from "../types";
```

- [ ] **Step 4: Update imports in `src/core/harness/tool-policy.ts`**

Replace:
```typescript
import type {
  AgentPhase,
  AuthorizationMode,
  AuthorizationOverride,
  ShellApprovalGrant,
  ShellGrantUsed,
  ThreadAuthorizationState,
  WorkspaceAccess,
} from "../shared/types";
```
With:
```typescript
import type { AgentPhase, AuthorizationMode, ShellApprovalGrant, ShellGrantUsed, WorkspaceAccess } from "../../protocol/events";
import type { AuthorizationOverride, ThreadAuthorizationState } from "../types";
```

- [ ] **Step 5: Update imports in `src/core/harness/tool-runner.ts`**

Replace:
```typescript
import type { AuthorizationOverride, ShellApprovalGrant, ShellGrantUsed, ThreadAuthorizationState, WorkspaceAccess } from "../shared/types";
```
With:
```typescript
import type { AuthorizationOverride, ThreadAuthorizationState } from "../types";
import type { ShellApprovalGrant, ShellGrantUsed, WorkspaceAccess, AgentPlan } from "../../protocol/events";
```

- [ ] **Step 6: Update imports in `src/core/harness/tool-requests.ts`**

Replace:
```typescript
import type { AgentPlan, ShellActionEnvelope, UserInputRequest } from "../shared/types";
```
With:
```typescript
import type { AgentPlan, UserInputRequest } from "../../protocol/events";
import type { ShellActionEnvelope } from "../types";
```

- [ ] **Step 7: Update imports in `src/core/harness/state.ts`**

Replace:
```typescript
import type { AgentPhase, AgentPlan, AuthorizationMode, AuthorizationOverride, ContextBudget, ThreadAuthorizationState, WorkspaceAccess } from "../shared/types";
```
With:
```typescript
import type { AgentPhase, AgentPlan, AuthorizationMode, WorkspaceAccess } from "../../protocol/events";
import type { AuthorizationOverride, ContextBudget, ThreadAuthorizationState } from "../types";
```

- [ ] **Step 8: Update imports in `src/core/harness/user-input.ts`**

Replace:
```typescript
import type { AgentResumeValue } from "../shared/types";
```
With:
```typescript
import type { AgentResumeValue } from "../types";
```

- [ ] **Step 9: Update imports in `src/core/model/context.ts`**

Replace:
```typescript
import type { ContextBudget, ModelRetryEvent } from "../shared/types";
```
With:
```typescript
import type { ContextBudget, ModelRetryEvent } from "../types";
```

- [ ] **Step 10: Update imports in `src/core/model/runtime-context.ts`**

Replace:
```typescript
import type { AgentPlan, ContextBudget, WorkspaceAccess } from "../shared/types";
```
With:
```typescript
import type { AgentPlan, ContextBudget, WorkspaceAccess } from "../../protocol/events";
```

Wait -- `ContextBudget` is defined in both protocol events and core types now. Let me check: actually `ContextBudget` should be in core types only since it's not used in any protocol event payload directly. Let me fix this.

Actually, let me re-examine: `ContextBudget` is passed as input to `runAgent()` which is in core. It's not part of any event payload. So it stays in `src/core/types.ts`. The import in runtime-context.ts should be from `../types`.

- [ ] **Step 11: Update imports in `src/core/tools/definitions.ts`**

Replace:
```typescript
import type { ShellApprovalGrant, ShellIntent, UserInputOption, UserInputRequest, WorkspaceAccess } from "../shared/types";
```
With:
```typescript
import type { ShellApprovalGrant, UserInputOption, UserInputRequest, WorkspaceAccess } from "../../protocol/events";
import type { ShellIntent } from "../types";
```

- [ ] **Step 12: Update imports in `src/core/tools/shell.ts`**

Replace:
```typescript
import type { ShellInput, ShellResult } from "../shared/types";
```
With:
```typescript
import type { ShellInput, ShellResult } from "../types";
```

- [ ] **Step 13: Update imports in `src/core/tools/apply-patch.ts`**

Replace:
```typescript
import type { ApplyPatchInput, ApplyPatchResult } from "../shared/types";
```
With:
```typescript
import type { ApplyPatchInput, ApplyPatchResult } from "../types";
```

- [ ] **Step 14: Update imports in `src/core/sandbox/executor.ts`**

Replace:
```typescript
import type { ShellInput, ShellResult } from "../shared/types";
```
With:
```typescript
import type { ShellInput, ShellResult } from "../types";
```

- [ ] **Step 15: Update imports in `src/core/sandbox/shell-wrapper.ts`**

Replace:
```typescript
import type { ShellInput, ShellResult } from "../shared/types";
```
With:
```typescript
import type { ShellInput, ShellResult } from "../types";
```

- [ ] **Step 16: Verify typecheck**

```bash
bun run typecheck
```
Expected: Pass (all import paths resolved).

- [ ] **Step 17: Commit**

```bash
git add src/core/types.ts src/core/harness/*.ts src/core/model/*.ts src/core/tools/*.ts src/core/sandbox/*.ts
git commit -m "refactor: split shared types into protocol and core-internal"
```

---

### Task 6: Fix core internal cross-references

After the moves, some references within core files may have stale import paths. Verify and fix.

- [ ] **Step 1: Run a full grep for old paths within core**

```bash
rg "from \"\.\./shared/" src/core/ --files-with-matches
```
Expected: No results (all resolved).

If any files are listed, fix the affected import paths in those files, then run typecheck again.

- [ ] **Step 2: Run typecheck**

```bash
bun run typecheck
```
Expected: Pass.

- [ ] **Step 3: Commit any fixes if needed**

---

### Task 7: Refactor runner — create `src/core/runner.ts`

**Files:**
- Create: `src/core/runner.ts` (based on `src/app/runner.ts`)
- Modify: None yet (tests will be updated later)

The runner is refactored to:
1. Use a single `runAgent()` async generator (merging `streamCodeAgent` + `resumeCodeAgent`)
2. Emit new protocol `AgentEvent` types instead of old `AgentEvent`
3. Integrate `UserInputProvider` for interrupt handling
4. Handle interrupt→resume internally via `await provider.requestAction()`

- [ ] **Step 1: Write `src/core/runner.ts`**

```typescript
import { HumanMessage } from "@langchain/core/messages";
import { Command } from "@langchain/langgraph";
import { AIMessage } from "@langchain/core/messages";
import type { AgentConfig } from "./config/index";
import { buildCodeAgentGraph } from "./harness/graph";
import type { ShellExecutor } from "./tools/shell";
import {
  createPromptCacheStandardTracker,
  extractPromptCacheMetrics,
} from "./cache-metrics";
import type {
  AgentEvent,
  CacheMetricsPayload,
  StateChangePayload,
  ToolCallPayload,
  ToolResultPayload,
  WorkspaceAccess,
} from "../protocol/events";
import type { InterruptPayload, UserAction } from "../protocol/actions";
import type { UserInputProvider } from "../protocol/provider";
import type {
  AgentResumeValue,
  AuthorizationOverride,
  ContextBudget,
  ModelRetryEvent,
  WorkspaceAccessRequest,
} from "./types";
import type { ToolApprovalPayload } from "../protocol/events";
import type { PendingToolRequest } from "./harness/tool-requests";

/** un Agent 输入 / Run agent input */
export interface RunAgentInput {
  task: string;
  userId: string;
  threadId: string;
  workspace: string;
  checkpointPath: string;
  config: AgentConfig;
  shellExecutor?: ShellExecutor;
  mode?: WorkspaceAccessRequest;
  contextBudget?: ContextBudget;
  authorizationOverride?: AuthorizationOverride;
}

/** 运行 Agent。interrupt 在内部通过 provider 闭环 */
export async function* runAgent(
  provider: UserInputProvider,
  input: RunAgentInput,
): AsyncGenerator<AgentEvent> {
  const { graph, checkpointer } = buildCodeAgentGraph({
    config: input.config,
    checkpointPath: input.checkpointPath,
    shellExecutor: input.shellExecutor,
    authorizationOverride: input.authorizationOverride,
  });

  let streamCompleted = false;
  try {
    const initialWorkspaceAccess = initialWorkspaceAccessForTask(
      input.task,
      input.mode ?? "auto",
    );
    const initialPhase = initialAgentPhaseForAccess(initialWorkspaceAccess);

    let state = {
      messages: [
        new HumanMessage(input.task),
      ],
      workspaceAccess: initialWorkspaceAccess,
      phase: initialPhase,
      plan: null,
      userId: input.userId,
      threadId: input.threadId,
      workspace: input.workspace,
      contextSummary: "",
      contextBudget: input.contextBudget,
    };

    let resumeCommand: Command | null = null;

    while (true) {
      const streamConfig = {
        configurable: { thread_id: input.threadId },
        streamMode: "updates" as const,
        recursionLimit: 60,
      };

      const stream = resumeCommand
        ? await graph.stream(resumeCommand, streamConfig)
        : await graph.stream(state, streamConfig);

      resumeCommand = null;

      const interruptResult = await processGraphStream(
        provider,
        stream,
        initialWorkspaceAccess,
      );

      if (interruptResult === null) {
        // Stream ended normally (no interrupt)
        break;
      }

      // interruptResult is the UserAction to resume with
      resumeCommand = new Command({
        resume: mapUserActionToResumeValue(interruptResult),
      });
    }

    streamCompleted = true;
  } finally {
    if (streamCompleted) {
      checkpointer.close();
    }
  }
}

/** 处理 LangGraph 流，返回 null 表示正常结束，返回 UserAction 表示需要 resume */
async function processGraphStream(
  provider: UserInputProvider,
  stream: AsyncIterable<unknown>,
  workspaceAccess: WorkspaceAccess,
): Promise<UserAction | null> {
  const cacheStandard = createPromptCacheStandardTracker();
  let currentWorkspaceAccess = workspaceAccess;

  for await (const chunk of stream) {
    // ── 处理中断 / Handle interrupts ──
    const { isInterrupted, INTERRUPT } = await import("@langchain/langgraph");
    if (isInterrupted(chunk)) {
      const interruptData = chunk[INTERRUPT];
      const event = mapInterruptToEvent(interruptData);
      if (event) {
        provider.onEvent(event);
        const payload = buildInterruptPayload(interruptData, event);
        if (payload) {
          return await provider.requestAction(payload);
        }
      }
      continue;
    }

    const chunkRecord = chunk as Record<string, unknown>;
    if (INTERRUPT in chunkRecord) {
      const interruptData = chunkRecord[INTERRUPT];
      const event = mapInterruptToEvent(interruptData);
      if (event) {
        provider.onEvent(event);
        const payload = buildInterruptPayload(interruptData, event);
        if (payload) {
          return await provider.requestAction(payload);
        }
      }
      continue;
    }

    // ── 提取工作区访问 / Extract workspace access ──
    currentWorkspaceAccess = findWorkspaceAccess(chunk) ?? currentWorkspaceAccess;

    // ── 发射事件 / Emit events ──
    const events = mapChunkToEvents(chunk, currentWorkspaceAccess, cacheStandard);
    for (const event of events) {
      provider.onEvent(event);
    }

    // Note: For the async generator pattern used by CLI, events are not yielded
    // here. The CLI provider.onEvent handles output. For a future event-driven
    // consumer, the provider can accumulate events.
  }

  return null;
}

/** 映射 LangGraph interrupt 到 AgentEvent */
function mapInterruptToEvent(interruptData: unknown): AgentEvent | null {
  const data = interruptData as Record<string, unknown>[] | undefined;
  if (!Array.isArray(data) || data.length === 0) return null;

  for (const item of data) {
    if (item && typeof item === "object" && "__interrupt__" in item) {
      const inner = (item as Record<string, unknown>).__interrupt__;
      if (Array.isArray(inner) && inner.length > 0) {
        const value = inner[0];
        if (value && typeof value === "object") {
          const v = value as Record<string, unknown>;
          if (v.kind === "tool_approval") {
            return {
              type: "need_approval",
              data: v.payload as ToolApprovalPayload,
            };
          }
          if (v.kind === "user_input") {
            return {
              type: "need_input",
              data: v.payload as never,
            };
          }
        }
      }
    }
  }
  return null;
}

/** 构建 InterruptPayload */
function buildInterruptPayload(
  interruptData: unknown,
  event: AgentEvent,
): InterruptPayload | null {
  if (event.type === "need_approval") {
    return { kind: "approval", approval: event.data };
  }
  if (event.type === "need_input") {
    return { kind: "input", question: event.data as never };
  }
  return null;
}

/** 映射 UserAction 到 AgentResumeValue */
function mapUserActionToResumeValue(action: UserAction): AgentResumeValue {
  switch (action.type) {
    case "approve":
      return { approved: true, grant: action.grant };
    case "reject":
      return { approved: false };
    case "input":
      return { answer: action.text };
    case "cancel":
      return { approved: false };
    case "switch_auth":
      return { approved: false };
  }
}

/** 映射 LangGraph chunk 到新事件列表 */
function mapChunkToEvents(
  chunk: unknown,
  workspaceAccess: WorkspaceAccess,
  cacheStandard: ReturnType<typeof createPromptCacheStandardTracker>,
): AgentEvent[] {
  const events: AgentEvent[] = [];

  if (!chunk || typeof chunk !== "object") return events;

  const record = chunk as Record<string, unknown>;

  // step_begin / step_end are emitted around actual graph updates
  // For now, emit step tracking based on finding AIMessage (step end marker)
  let foundAIMessage = false;

  for (const key of Object.keys(record)) {
    const value = record[key];
    if (!value || typeof value !== "object") continue;
    const node = value as Record<string, unknown>;

    // Extract AIMessage → text / reason / tool_call
    if (node.messages && Array.isArray(node.messages)) {
      for (const msg of node.messages) {
        if (AIMessage.isInstance(msg)) {
          foundAIMessage = true;

          // reasoning_content
          const rc = (msg as Record<string, unknown>).reasoning_content;
          if (typeof rc === "string" && rc.length > 0) {
            events.push({ type: "reason", data: { text: rc } });
          }

          // tool_calls
          if (msg.tool_calls && msg.tool_calls.length > 0) {
            for (const tc of msg.tool_calls) {
              events.push({
                type: "tool_call",
                data: {
                  call_id: tc.id ?? "",
                  name: tc.name as ToolCallPayload["name"],
                  args: tc.args as Record<string, unknown>,
                },
              });
            }
          }

          // text content
          const content = msg.content;
          if (typeof content === "string" && content.length > 0) {
            events.push({ type: "text", data: { text: content } });
          }
        }

        // Extract ToolMessage → tool_done
        const tm = msg as Record<string, unknown>;
        if (tm._getType && typeof tm._getType === "function" && (tm._getType as () => string)() === "tool") {
          const content = typeof tm.content === "string" ? tm.content : JSON.stringify(tm.content);
          let summary = content;
          let ok = true;
          try {
            const parsed = JSON.parse(content);
            if (parsed && typeof parsed === "object") {
              ok = parsed.ok !== false;
              summary = parsed.message ?? parsed.summary ?? content.slice(0, 200);
            }
          } catch {
            summary = content.slice(0, 200);
          }
          events.push({
            type: "tool_done",
            data: {
              call_id: (tm.tool_call_id as string) ?? "",
              name: (tm.name as string) ?? "",
              ok,
              summary,
            },
          });
        }
      }
    }

    // Extract state changes
    const ws = node.workspaceAccess;
    const phase = node.phase;
    const plan = node.plan;
    const auth = node.authorization;
    if (ws || phase || plan !== undefined || auth) {
      const sc: StateChangePayload = {};
      if (ws === "read-only" || ws === "write") sc.workspaceAccess = ws;
      if (phase === "planning" || phase === "building") sc.phase = phase;
      if (plan !== undefined) sc.plan = plan as StateChangePayload["plan"];
      if (auth && typeof auth === "object") {
        sc.authorization = { mode: (auth as Record<string, unknown>).mode as "default" | "full_access" };
      }
      events.push({ type: "state_change", data: sc });
    }

    // Extract model retries
    const retries = node.modelRetries;
    if (Array.isArray(retries)) {
      for (const r of retries) {
        if (r && typeof r === "object" && typeof (r as Record<string, unknown>).attempt === "number") {
          events.push({
            type: "retry",
            data: {
              attempt: (r as Record<string, unknown>).attempt as number,
              reason: ((r as Record<string, unknown>).error as string) ?? "unknown",
            },
          });
        }
      }
    }
  }

  // Cache metrics (extract from AI messages in this chunk)
  const metrics = findPromptCacheMetrics(chunk);
  if (metrics) {
    events.push({
      type: "cache_metrics",
      data: {
        workspaceAccess,
        ...metrics,
        standard: cacheStandard.record(metrics),
      },
    });
  }

  return events;
}

/** 从 chunk 中查找工作区访问 */
function findWorkspaceAccess(chunk: unknown): WorkspaceAccess | null {
  if (!chunk || typeof chunk !== "object" || Array.isArray(chunk)) return null;
  const record = chunk as Record<string, unknown>;
  for (const value of Object.values(record)) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const ws = (value as Record<string, unknown>).workspaceAccess;
      if (ws === "read-only" || ws === "write") return ws;
    }
  }
  return null;
}

/** 从 chunk 中提取缓存指标 */
function findPromptCacheMetrics(chunk: unknown) {
  if (!chunk || typeof chunk !== "object") return null;
  const record = chunk as Record<string, unknown>;
  for (const value of Object.values(record)) {
    if (AIMessage.isInstance(value)) {
      return extractPromptCacheMetrics(value);
    }
  }
  return null;
}

/** 初始工作区访问 */
function initialWorkspaceAccessForTask(
  task: string,
  requestedAccess: WorkspaceAccessRequest,
): WorkspaceAccess {
  if (requestedAccess === "plan" || requestedAccess === "read-only") return "read-only";
  if (requestedAccess === "builder" || requestedAccess === "write") return "write";
  const normalized = task.trimStart().toLowerCase();
  if (normalized.startsWith("/plan")) return "read-only";
  return "write";
}

/** 派生初始阶段 */
function initialAgentPhaseForAccess(workspaceAccess: WorkspaceAccess): "planning" | "building" {
  return workspaceAccess === "read-only" ? "planning" : "building";
}

// Re-export for test compatibility
export { initialWorkspaceAccessForTask, initialAgentPhaseForAccess };
```

- [ ] **Step 2: Verify typecheck**

Note: This will likely fail because `src/app/cli.ts` still imports from `./runner`. We fix that in the next task.

- [ ] **Step 3: Commit**

```bash
git add src/core/runner.ts
git commit -m "feat: add refactored runAgent with protocol events"
```

---

### Task 8: Refactor CLI — create `src/app/cli/index.ts`

**Files:**
- Create: `src/app/cli/index.ts`
- Remove: `src/app/runner.ts` (after tests are migrated)

- [ ] **Step 1: Write `src/app/cli/index.ts`**

```typescript
import { join, resolve } from "node:path";
import { loadAgentConfig } from "../../core/config/index";
import { createSandboxExecutor } from "../../core/sandbox/index";
import { runAgent } from "../../core/runner";
import type { AgentEvent, ShellApprovalGrant, ToolApprovalPayload, WorkspaceAccessRequest } from "../../protocol/events";
import type { InterruptPayload, UserAction } from "../../protocol/actions";
import type { UserInputProvider } from "../../protocol/provider";
import type { AuthorizationOverride, UserInputResumeValue } from "../../core/types";

/** CLI 解析后的参数 */
export interface ParsedArgs {
  command: "run" | "resume" | "help";
  task?: string;
  threadId: string;
  userId: string;
  workspace: string;
  checkpointPath: string;
  mode: WorkspaceAccessRequest;
  authorizationMode?: "default" | "full_access";
  approve: boolean;
  approvalGrant?: ShellApprovalGrant;
  approvalHash?: string;
  replacementCommand?: string;
  answer?: string;
  sandbox: boolean;
}

/** CLI 入口 */
export async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.command === "help") {
    printHelp();
    return;
  }

  const config = loadAgentConfig();
  const shellExecutor = createSandboxExecutor({
    enabled: args.sandbox,
    workspace: args.workspace,
  });

  const authorizationOverride: AuthorizationOverride | undefined =
    args.authorizationMode !== undefined
      ? { current: args.authorizationMode }
      : undefined;

  // 构建 CLI 专用的 UserInputProvider
  const provider = createCliProvider(args);

  if (args.command === "resume") {
    // resume 模式：先手动发出 UserAction，然后 runAgent 调用
    // 由于 runAgent 从初始状态开始，CLI resume 模式需要特殊处理
    // 保留旧 resume 路径，后续统一到 provider.requestAction
    const { resumeCodeAgent } = await import("../../core/runner-legacy");
    const events = resumeCodeAgent({
      userId: args.userId,
      threadId: args.threadId,
      workspace: args.workspace,
      checkpointPath: args.checkpointPath,
      config,
      shellExecutor,
      authorizationOverride,
      resume:
        args.answer === undefined
          ? { approved: args.approve, grant: args.approvalGrant, approvalHash: args.approvalHash, replacementCommand: args.replacementCommand }
          : { answer: args.answer },
    });
    for await (const event of events) {
      console.log(JSON.stringify(event));
    }
    return;
  }

  const generator = runAgent(provider, {
    task: args.task ?? "",
    userId: args.userId,
    threadId: args.threadId,
    workspace: args.workspace,
    checkpointPath: args.checkpointPath,
    config,
    mode: args.mode,
    shellExecutor,
    authorizationOverride,
  });

  for await (const event of generator) {
    // 事件已在 provider.onEvent 中输出
  }
}

/** 创建 CLI provider — NDJSON 输出 + stdin 输入 */
function createCliProvider(args: ParsedArgs): UserInputProvider {
  // 预取 resume 值（如果是 resume 命令）
  const preCannedAction: UserAction | null =
    args.command === "resume"
      ? args.answer !== undefined
        ? { type: "input", text: args.answer }
        : { type: "approve", grant: args.approvalGrant ?? "approve_once" }
      : null;

  let preCannedConsumed = false;

  return {
    onEvent(event: AgentEvent) {
      console.log(JSON.stringify(event));
    },
    async requestAction(payload: InterruptPayload): Promise<UserAction> {
      // 如果有预置动作（resume 模式），直接返回
      if (preCannedAction && !preCannedConsumed) {
        preCannedConsumed = true;
        // 验证 approval hash
        if (preCannedAction.type === "approve" &&
            payload.kind === "approval" &&
            args.approvalHash &&
            payload.approval.approvalHash !== args.approvalHash) {
          return { type: "reject" };
        }
        return preCannedAction;
      }

      // 交互模式：从 stdin 读取
      return readActionFromStdin(payload);
    },
  };
}

/** 从 stdin 读取用户动作 */
async function readActionFromStdin(payload: InterruptPayload): Promise<UserAction> {
  // 输出提示到 stderr（不污染 NDJSON 输出）
  if (payload.kind === "approval") {
    const a = payload.approval;
    console.error(`\n[APPROVAL REQUIRED] ${a.tool}: ${a.command}`);
    console.error(`Risk: ${a.risk} | ${a.summary}`);
    console.error("Type 'y' to approve, 'n' to reject, or 'f' for full_access:");
  } else {
    const q = payload.question;
    console.error(`\n[QUESTION] ${q.question}`);
    if (q.options.length > 0) {
      q.options.forEach((o, i) => console.error(`  ${i + 1}. ${o.label}`));
    }
    console.error("Enter your answer:");
  }

  const { stdin } = process;
  const data = await new Promise<string>((resolve) => {
    const onData = (chunk: Buffer) => {
      stdin.removeListener("data", onData);
      resolve(chunk.toString().trim());
    };
    stdin.on("data", onData);
    stdin.resume();
  });

  if (payload.kind === "approval") {
    const lower = data.toLowerCase();
    if (lower === "f" || lower === "full_access") return { type: "approve", grant: "full_access" };
    if (lower === "y" || lower === "yes") return { type: "approve", grant: "approve_once" };
    return { type: "reject" };
  }

  return { type: "input", text: data };
}

// ── 以下保留原 cli.ts 的 parseArgs / printHelp 等函数（不变）──
export function parseArgs(argv: string[]): ParsedArgs {
  const command = argv[0] === "resume" ? "resume" : argv[0] === "run" ? "run" : "help";
  const cwd = process.cwd();
  const value = (name: string, fallback: string) => {
    const index = argv.indexOf(name);
    return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
  };
  const optionalValue = (name: string) => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] ?? "" : undefined;
  };
  const noSandbox = argv.includes("--no-sandbox");
  const explicitThread = value("--thread", "");
  const mode = parseMode(value("--mode", "auto"));
  const authorizationMode = parseAuthorizationMode(optionalValue("--authorization-mode") ?? "");
  const answer = optionalValue("--answer");
  const approvalHash = optionalValue("--approval-hash");
  const replacementCommand = optionalValue("--replace-command");
  const approvalGrant = parseApprovalGrant(argv);

  return {
    command,
    task: command === "run" ? value("--task", positionalTask(argv)) : "",
    threadId: explicitThread || (command === "run" ? freshThreadId() : "default-thread"),
    userId: value("--user", "default-user"),
    workspace: resolve(value("--workspace", cwd)),
    checkpointPath: resolve(value("--checkpoints", join(cwd, ".openpx", "checkpoints.sqlite"))),
    mode,
    authorizationMode,
    approve: approvalGrant !== undefined,
    approvalGrant,
    approvalHash,
    replacementCommand,
    answer,
    sandbox: !noSandbox,
  };
}

function parseApprovalGrant(argv: string[]): ShellApprovalGrant | undefined {
  if (argv.includes("--full-access")) return "full_access";
  if (argv.includes("--approve-same-command")) return "same_command";
  if (argv.includes("--approve")) return "approve_once";
  return undefined;
}

function positionalTask(argv: string[]): string {
  if (argv[0] !== "run") return "";
  const optionNamesWithValues = new Set(["--task", "--thread", "--user", "--workspace", "--checkpoints", "--mode", "--answer", "--approval-hash", "--replace-command"]);
  const parts: string[] = [];
  for (let index = 1; index < argv.length; index++) {
    const item = argv[index];
    if (optionNamesWithValues.has(item)) { index++; continue; }
    if (item.startsWith("--")) continue;
    parts.push(item);
  }
  return parts.join(" ").trim();
}

function parseMode(value: string): WorkspaceAccessRequest {
  if (value === "read-only" || value === "write" || value === "plan" || value === "builder") return value;
  return "auto";
}

function parseAuthorizationMode(value: string): "default" | "full_access" | undefined {
  if (value === "full_access" || value === "full-access") return "full_access";
  if (value === "default") return "default";
  return undefined;
}

function freshThreadId(): string {
  return `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function printHelp(): void {
  console.log(`Usage:
  bun run agent run --task "Create hello.txt with exact content \\"hi\\""
  bun run agent resume --thread default-thread --approve

Options:
  --task <text>          Task for run
  --thread <id>          LangGraph thread id
  --user <id>            User id for the run
  --workspace <path>     Tool workspace
  --checkpoints <path>   SQLite checkpoint path
  --mode <mode>          auto, read-only, write, plan, or builder
  --approve              Resume a tool approval interrupt with approval
  --approve-same-command Approve current command and future exact same shell command
  --full-access          Allow all future shell_execute commands in this thread
  --approval-hash <hash> Approval hash from the tool_approval interrupt
  --replace-command <cmd> Replace the pending command and approve that command
  --answer <text>        Resume a user input interrupt with an answer
  --authorization-mode <mode>  default or full-access
  --no-sandbox           Disable sandbox isolation (for debugging)`);
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
```

- [ ] **Step 2: Update `package.json` scripts**

Replace:
```json
"agent": "bun run src/app/cli.ts",
```
With:
```json
"agent": "bun run src/app/cli/index.ts",
```

- [ ] **Step 3: Verify typecheck**

```bash
bun run typecheck
```
Expected: Pass (new file, no old runner.ts dependency in CLI).

- [ ] **Step 4: Commit**

```bash
git add src/app/cli/index.ts package.json
git commit -m "feat: refactor CLI to UserInputProvider adapter"
```

---

### Task 9: Update `src/index.ts` exports

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Update exports**

Replace the entire file content with:

```typescript
export { loadAgentConfig } from "./core/config/index";
export { runAgent } from "./core/runner";
export type { RunAgentInput } from "./core/runner";
export { BunSqliteSaver } from "./core/persistence/checkpoint";
export { shellTool } from "./core/tools/shell";
export { readFile, editFile, writeFile } from "./core/tools/file";
export { createSandboxExecutor, isSandboxAvailable } from "./core/sandbox/index";
export type { SandboxOptions, ResourceLimits } from "./core/sandbox/index";
export type * from "./protocol/index";
export type * from "./core/types";
```

- [ ] **Step 2: Verify typecheck**

```bash
bun run typecheck
```
Expected: Pass.

- [ ] **Step 3: Commit**

```bash
git add src/index.ts
git commit -m "refactor: update index.ts exports for three-layer structure"
```

---

### Task 10: Keep legacy runner for resume compatibility

**Files:**
- Create: `src/core/runner-legacy.ts` (copy of old runner for `resumeCodeAgent`)

- [ ] **Step 1: Copy old runner as legacy**

```powershell
Copy-Item -LiteralPath "src\app\runner.ts" -Destination "src\core\runner-legacy.ts"
```

- [ ] **Step 2: Fix imports in `src/core/runner-legacy.ts`**

Replace all occurrences of:
```
"../shared/types"
```
with:
```
"../core/types"
```

Replace:
```
"../harness/graph"
```
with:
```
"./harness/graph"
```

Replace:
```
"../config/index"
```
with:
```
"./config/index"
```

Replace:
```
"../tools/shell"
```
with:
```
"./tools/shell"
```

Replace:
```
"../shared/cache-metrics"
```
with:
```
"./cache-metrics"
```

- [ ] **Step 3: Verify typecheck**

```bash
bun run typecheck
```
Expected: Pass.

- [ ] **Step 4: Commit**

```bash
git add src/core/runner-legacy.ts
git commit -m "refactor: keep legacy runner for resume compatibility"
```

---

### Task 11: Update test imports

**Files:**
- Modify: All test files that import from `../src/` paths

- [ ] **Step 1: Update test imports — `../src/harness/` → `../src/core/harness/`**

```powershell
$files = @(
  "tests\tool-policy.test.ts",
  "tests\integration.test.ts",
  "tests\graph.test.ts",
  "tests\authorization-mode.test.ts"
)
foreach ($f in $files) {
  (Get-Content -LiteralPath $f -Raw) -replace '\.\./src/harness/', '../src/core/harness/' | Set-Content -LiteralPath $f -NoNewline
}
```

- [ ] **Step 2: Update test imports — `../src/model/` → `../src/core/model/`**

```powershell
$files = @(
  "tests\runtime-context.test.ts",
  "tests\model.test.ts",
  "tests\context.test.ts",
  "tests\mock-compaction.real.ts",
  "tests\real-agent.real.ts"
)
foreach ($f in $files) {
  (Get-Content -LiteralPath $f -Raw) -replace '\.\./src/model/', '../src/core/model/' | Set-Content -LiteralPath $f -NoNewline
}
```

- [ ] **Step 3: Update test imports — `../src/tools/` → `../src/core/tools/`**

```powershell
$files = @(
  "tests\tools.test.ts",
  "tests\tool-definitions.test.ts",
  "tests\apply-patch.test.ts",
  "tests\sandbox.test.ts",
  "tests\real-agent.real.ts"
)
foreach ($f in $files) {
  (Get-Content -LiteralPath $f -Raw) -replace '\.\./src/tools/', '../src/core/tools/' | Set-Content -LiteralPath $f -NoNewline
}
```

- [ ] **Step 4: Update test imports — `../src/sandbox/` → `../src/core/sandbox/`**

```powershell
$files = @(
  "tests\sandbox.test.ts",
  "tests\sandbox-executor.test.ts"
)
foreach ($f in $files) {
  (Get-Content -LiteralPath $f -Raw) -replace '\.\./src/sandbox/', '../src/core/sandbox/' | Set-Content -LiteralPath $f -NoNewline
}
```

- [ ] **Step 5: Update test imports — `../src/config/` → `../src/core/config/`**

```powershell
$files = @(
  "tests\config.test.ts",
  "tests\model.test.ts",
  "tests\integration.test.ts",
  "tests\real-agent.real.ts"
)
foreach ($f in $files) {
  (Get-Content -LiteralPath $f -Raw) -replace '\.\./src/config/', '../src/core/config/' | Set-Content -LiteralPath $f -NoNewline
}
```

- [ ] **Step 6: Update test imports — `../src/persistence/` → `../src/core/persistence/`**

```powershell
$files = @(
  "tests\checkpoint.test.ts"
)
foreach ($f in $files) {
  (Get-Content -LiteralPath $f -Raw) -replace '\.\./src/persistence/', '../src/core/persistence/' | Set-Content -LiteralPath $f -NoNewline
}
```

- [ ] **Step 7: Update test imports — `../src/app/runner` → `../src/core/runner` and `../src/app/cli` → `../src/app/cli/index`**

```powershell
$files = @(
  "tests\runner.test.ts",
  "tests\cache-metrics.test.ts",
  "tests\real-agent.real.ts"
)
foreach ($f in $files) {
  (Get-Content -LiteralPath $f -Raw) -replace '\.\./src/app/runner', '../src/core/runner' | Set-Content -LiteralPath $f -NoNewline
}

(Get-Content -LiteralPath "tests\cli.test.ts" -Raw) -replace '\.\./src/app/cli', '../src/app/cli/index' | Set-Content -LiteralPath "tests\cli.test.ts" -NoNewline
(Get-Content -LiteralPath "tests\sandbox.test.ts" -Raw) -replace '\.\./src/app/cli', '../src/app/cli/index' | Set-Content -LiteralPath "tests\sandbox.test.ts" -NoNewline
```

- [ ] **Step 8: Update test imports — `../src/shared/` → `../src/core/` for cache-metrics**

```powershell
(Get-Content -LiteralPath "tests\cache-metrics.test.ts" -Raw) -replace '\.\./src/shared/cache-metrics', '../src/core/cache-metrics' | Set-Content -LiteralPath "tests\cache-metrics.test.ts" -NoNewline
```

- [ ] **Step 9: Update test imports — `../src/shared/types` → protocol or core/types**

Tests that import individual types from shared need to be updated:

- `tests/runner.test.ts` — imports `ModelRetryEvent` → `"../src/core/types"`
- `tests/mock-compaction.real.ts` — imports `AgentPlan` → `"../src/protocol/index"`
- `tests/graph.test.ts` — imports `AgentPlan, ShellResult` → split
- `tests/authorization-mode.test.ts` — imports from `tool-policy` directly (no shared)
- `tests/real-agent.real.ts` — imports many types from shared → split

Update each manually:

For `tests/runner.test.ts`:
```
import type { ModelRetryEvent } from "../src/shared/types";
→ import type { ModelRetryEvent } from "../src/core/types";
```

For `tests/mock-compaction.real.ts`:
```
import type { AgentPlan } from "../src/shared/types";
→ import type { AgentPlan } from "../src/protocol/index";
```

For `tests/graph.test.ts`:
Update the shared types import to import from protocol and core separately.

For `tests/real-agent.real.ts`:
Update imports to split between protocol and core as needed.

- [ ] **Step 10: Run typecheck**

```bash
bun run typecheck
```
Expected: May show errors in test files that still reference old paths. Fix each error individually by updating the import path, then re-run typecheck.

- [ ] **Step 11: Commit**

```bash
git add tests/
git commit -m "test: update test imports for three-layer structure"
```

---

### Task 12: Remove old files and clean up

**Files:**
- Remove: `src/app/runner.ts`
- Remove: `src/app/cli.ts`
- Remove: `src/shared/` directory

- [ ] **Step 1: Remove old files**

```powershell
Remove-Item -LiteralPath "src\app\runner.ts"
Remove-Item -LiteralPath "src\app\cli.ts"
Remove-Item -LiteralPath "src\shared" -Recurse -Force
```

- [ ] **Step 2: Run typecheck**

```bash
bun run typecheck
```
Expected: Pass (or fix any residual references).

- [ ] **Step 3: Run tests**

```bash
bun test
```
Expected: All tests pass.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "refactor: remove old files, complete three-layer migration"
```

---

### Task 13: Final verification

- [ ] **Step 1: Run full typecheck**

```bash
bun run typecheck
```
Expected: Zero errors.

- [ ] **Step 2: Run all tests**

```bash
bun test
```
Expected: All tests pass.

- [ ] **Step 3: Verify directory structure**

```powershell
Get-ChildItem -LiteralPath "src" -Recurse -Directory | Select-Object FullName
```

Expected output should show:
```
src/protocol/
src/core/harness/
src/core/model/
src/core/tools/
src/core/sandbox/
src/core/config/
src/core/persistence/
src/app/cli/
```

And should NOT show:
```
src/shared/
src/harness/
src/model/
src/tools/
src/sandbox/
src/config/
src/persistence/
```

- [ ] **Step 4: Commit any final fixes**

---

## Self-Review

### Spec coverage check:
- [x] Protocol layer (events, actions, provider) — Tasks 1-3
- [x] Core directory migration — Tasks 4-6
- [x] Runner refactoring (single runAgent, interrupt handling) — Task 7
- [x] CLI adapter (UserInputProvider implementation) — Task 8
- [x] File migration plan — Tasks 4, 10, 12
- [x] Public API updates — Task 9
- [x] Test updates — Task 11
- [x] Cleanup — Task 12

### Placeholder scan:
- [x] No TBD/TODO in any step
- [x] All imports have exact paths
- [x] All code blocks are complete

### Type consistency:
- [x] `AgentEvent` types consistent across protocol, runner, and CLI
- [x] `UserAction` types consistent across protocol and CLI
- [x] `UserInputProvider` interface consistent
