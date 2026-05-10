# Authorization Mode Switch — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add per-thread authorization mode (`default` | `full_access`) that can be set at session start, toggled mid-execution via in-memory override, and toggled by the model via a new `set_authorization_mode` tool.

**Architecture:** Introduces `AuthorizationOverride` (in-memory reference) that overrides `state.authorization.mode` in `evaluateToolPolicy`. Override is created by the caller, passed through graph closure, synced to state in agent/tools node returns for checkpoint persistence. A new `set_authorization_mode` tool allows the model to change mode on user request.

**Tech Stack:** Bun + TypeScript + LangGraph.js + Zod

**Spec:** `docs/superpowers/specs/2026-05-10-authorization-mode-switch-design.md`

---

### Task 1: Add `AuthorizationMode` type and `AuthorizationOverride` interface

**Files:**
- Modify: `src/shared/types.ts`

- [ ] **Step 1: Add types after `ThreadAuthorizationState` interface**

After the `ThreadAuthorizationState` interface (line 76-90), insert:

```typescript
/** 授权模式 / Authorization mode */
export type AuthorizationMode = "default" | "full_access";

/** 内存级授权覆盖，优先级高于 state.authorization / In-memory authorization override */
export interface AuthorizationOverride {
  current: AuthorizationMode;
}
```

- [ ] **Step 2: Verify types compile**

```bash
bun run typecheck
```
Expected: No type errors.

- [ ] **Step 3: Commit**

```bash
git add src/shared/types.ts
git commit -m "feat: add AuthorizationMode and AuthorizationOverride types"
```

---

### Task 2: Add `authorization` to `ToolExecutionResult`

**Files:**
- Modify: `src/harness/tool-result.ts`

- [ ] **Step 1: Add `authorization` optional field**

Read the current file. Add after `workspaceAccess` field (line 47):

```typescript
import type {
  AgentPlan,
  ShellResult,
  ShellGrantUsed,
  ShellIntent,
  WorkspaceAccess,
  ThreadAuthorizationState, // new import
} from "../shared/types";
```

And add the field:

```typescript
  /** set_authorization_mode 返回的更新后的授权状态 / Updated authorization state from set_authorization_mode */
  authorization?: ThreadAuthorizationState;
```

- [ ] **Step 2: Verify types compile**

```bash
bun run typecheck
```
Expected: No type errors.

- [ ] **Step 3: Commit**

```bash
git add src/harness/tool-result.ts
git commit -m "feat: add authorization field to ToolExecutionResult"
```

---

### Task 3: Add `override` parameter to `evaluateToolPolicy` and `set_authorization_mode` policy

**Files:**
- Modify: `src/harness/tool-policy.ts`

- [ ] **Step 1: Add `override` to `evaluateToolPolicy` input and compute `effectiveMode`**

Change the function signature (line 160-167) to add `override`:

```typescript
/** 统一评估工具请求是否允许、是否需要审批以及用户可见风险 / Evaluate the unified tool safety policy */
export function evaluateToolPolicy(input: {
  request: PendingToolRequest;
  workspaceAccess: WorkspaceAccess;
  phase: AgentPhase;
  workspace?: string;
  threadId?: string;
  authorization?: ThreadAuthorizationState | null;
  override?: AuthorizationOverride; // new
}): ToolPolicyDecision {
  const { request, workspaceAccess, phase } = input;
  const authorization = normalizeAuthorizationState(input.authorization);
  const effectiveMode = input.override?.current ?? authorization.mode; // new
```

- [ ] **Step 2: Add `import type { AuthorizationMode }` at top**

```typescript
import type {
  AgentPhase,
  AuthorizationMode, // new
  AuthorizationOverride, // new
  ShellApprovalGrant,
  ShellGrantUsed,
  ThreadAuthorizationState,
  WorkspaceAccess,
} from "../shared/types";
```

- [ ] **Step 3: Add `set_authorization_mode` early-return policy BEFORE `denyForPlanningOrReadOnly`**

After the `read_file` block (line 196) and before the `shell_execute` block, add:

```typescript
  if (request.name === "set_authorization_mode") {
    return allow({
      risk: "plan",
      reason: "Authorization mode changes do not mutate the workspace.",
      userVisibleSummary: `Set authorization mode to: ${request.args.mode}`,
      expectedEffects: [
        "Changes thread authorization mode",
        "Does not read or write workspace files",
      ],
    });
  }
```

- [ ] **Step 4: Replace all `authorization.mode` reads with `effectiveMode` in `authorizedShellDecision`**

In `authorizedShellDecision` (line 397-440), change line 408:

```typescript
  // Before: if (input.authorization.mode === "full_access") {
  // After: use effectiveMode passed in via closure
```

Actually, `authorizedShellDecision` doesn't receive `effectiveMode`. Instead, change `authorizedShellDecision` to accept `effectiveMode`:

```typescript
function authorizedShellDecision(input: {
  authorization: ThreadAuthorizationState;
  workspace: string;
  threadId: string;
  command: string;
  effectiveMode: AuthorizationMode; // new
}): ToolPolicyDecision | null {
```

And change line 408:
```typescript
  if (input.effectiveMode === "full_access") {
```

Update the call site in `evaluateToolPolicy` (line 199-204):

```typescript
    const authorized = authorizedShellDecision({
      authorization,
      workspace: input.workspace ?? "",
      threadId: input.threadId ?? "",
      command: request.args.command,
      effectiveMode, // new
    });
```

- [ ] **Step 5: Verify types compile**

```bash
bun run typecheck
```
Expected: No type errors.

- [ ] **Step 6: Commit**

```bash
git add src/harness/tool-policy.ts
git commit -m "feat: add override parameter and set_authorization_mode policy"
```

---

### Task 4: Add `set_authorization_mode` to `PendingToolRequest` union type

**Files:**
- Modify: `src/harness/tool-requests.ts`

- [ ] **Step 1: Add new member to `PendingToolRequest`**

After the `ask_user` member (line 61-71 of the union type), add:

```typescript
  | {
      /** 工具调用 ID / Tool call ID */
      id?: string;
      name: "set_authorization_mode";
      args: { mode: "default" | "full_access" };
      /** 调用原因 / Call reason */
      reason: string;
      /** 用于审批展示的命令 / Command displayed for approval */
      protectedCommand: string;
    };
```

- [ ] **Step 2: Add parsing branch in `toolRequestFromMessage`**

After the `ask_user` block (line 160-169), add:

```typescript
  if (call.name === "set_authorization_mode") {
    const args = call.args as { mode?: string };
    const mode = args.mode === "full_access" ? "full_access" : "default";
    return {
      id: call.id,
      name: "set_authorization_mode",
      args: { mode },
      reason: "Model requested authorization mode change",
      protectedCommand: `set_authorization_mode ${mode}`,
    };
  }
```

- [ ] **Step 3: Verify types compile**

```bash
bun run typecheck
```
Expected: No type errors.

- [ ] **Step 4: Commit**

```bash
git add src/harness/tool-requests.ts
git commit -m "feat: add set_authorization_mode to PendingToolRequest"
```

---

### Task 5: Add `override` parameter to `routeAfterAgent`

**Files:**
- Modify: `src/harness/routes.ts`

- [ ] **Step 1: Import `AuthorizationOverride` type**

```typescript
import type { AuthorizationOverride } from "../shared/types";
```

- [ ] **Step 2: Add `override` parameter to `routeAfterAgent`**

```typescript
export function routeAfterAgent(
  state: CodeAgentState,
  override?: AuthorizationOverride,
): "approval" | "tools" | "user_input" | typeof END {
  const request = getPendingToolRequest(state.messages, state.workspace);
  if (!request) {
    return END;
  }
  if (request.name === "ask_user") {
    return "user_input";
  }
  const workspaceAccess = state.workspaceAccess ?? "write";
  const decision = evaluateToolPolicy({
    request,
    workspaceAccess,
    phase: state.phase ?? defaultPhaseForWorkspaceAccess(workspaceAccess),
    workspace: state.workspace,
    threadId: state.threadId,
    authorization: state.authorization,
    override, // new
  });

  if (!decision.allowed) return "tools";
  return decision.requiresApproval ? "approval" : "tools";
}
```

- [ ] **Step 3: Verify types compile**

```bash
bun run typecheck
```
Expected: No type errors.

- [ ] **Step 4: Commit**

```bash
git add src/harness/routes.ts
git commit -m "feat: pass override through routeAfterAgent"
```

---

### Task 6: Add `SET_AUTHORIZATION_MODE_CONTRACT`

**Files:**
- Modify: `src/tools/tool-contracts.ts`

- [ ] **Step 1: Add contract after `ASK_USER_CONTRACT`**

After the `ASK_USER_CONTRACT.description = ...` line (line 193), add:

```typescript
export const SET_AUTHORIZATION_MODE_CONTRACT: ToolContract = {
  name: "set_authorization_mode",
  sections: {
    whenToUse:
      "Switch between default (require user confirmation for dangerous tools) and full_access " +
      "(auto-execute all tools without confirmation) authorization modes. " +
      "Call ONLY when the user explicitly requests a mode change, e.g. 'don't ask me for confirmation' or 'switch to auto mode'. " +
      "Do NOT call this tool without an explicit user request to change authorization mode.",
    commonMistakes:
      "Calling set_authorization_mode without the user explicitly asking for a mode change. " +
      "Calling it excessively — one call is sufficient to change the mode for the entire thread.",
    outputFormat:
      "JSON with ok: true and the new mode value (default or full_access). " +
      "This tool always succeeds — if mode is already the requested value, it is a no-op.",
    failureHandling:
      "This tool always succeeds. If the mode parameter is invalid, it defaults to 'default'. " +
      "There is no error state to recover from.",
  },
  description: "",
};
SET_AUTHORIZATION_MODE_CONTRACT.description = buildDescription(SET_AUTHORIZATION_MODE_CONTRACT.sections);
```

- [ ] **Step 2: Register in `TOOL_CONTRACTS` map**

Add after the `ask_user` entry:

```typescript
  ["set_authorization_mode", SET_AUTHORIZATION_MODE_CONTRACT],
```

- [ ] **Step 3: Verify types compile**

```bash
bun run typecheck
```
Expected: No type errors.

- [ ] **Step 4: Commit**

```bash
git add src/tools/tool-contracts.ts
git commit -m "feat: add SET_AUTHORIZATION_MODE_CONTRACT"
```

---

### Task 7: Add `set_authorization_mode` tool definition

**Files:**
- Modify: `src/tools/definitions.ts`

- [ ] **Step 1: Import new contract**

Add import:
```typescript
import {
  READ_FILE_CONTRACT,
  EDIT_FILE_CONTRACT,
  WRITE_FILE_CONTRACT,
  SHELL_EXECUTE_CONTRACT,
  UPDATE_PLAN_CONTRACT,
  ASK_USER_CONTRACT,
  SET_AUTHORIZATION_MODE_CONTRACT, // new
} from "./tool-contracts";
```

- [ ] **Step 2: Add tool to `createAgentTools` return array**

In `createAgentTools`, after `createAskUserTool()`, add:

```typescript
  return [
    readFileTool,
    editFileTool,
    writeFileTool,
    shellExecute,
    createUpdatePlanTool(),
    createAskUserTool(),
    createSetAuthorizationModeTool(), // new
  ];
```

- [ ] **Step 3: Add `createSetAuthorizationModeTool` function**

After the `createAskUserTool` function (line 225), add:

```typescript
/** 创建 set_authorization_mode 工具定义，用于切换授权模式 / Create set_authorization_mode tool definition */
function createSetAuthorizationModeTool() {
  return tool(
    async ({ mode }) =>
      JSON.stringify({
        ok: true,
        mode,
      }),
    {
      name: "set_authorization_mode",
      description: SET_AUTHORIZATION_MODE_CONTRACT.description,
      schema: z.object({
        mode: z
          .enum(["default", "full_access"])
          .describe("Target authorization mode: 'default' requires confirmation for dangerous tools, 'full_access' executes all tools automatically"),
      }),
    },
  );
}
```

- [ ] **Step 4: Verify types compile**

```bash
bun run typecheck
```
Expected: No type errors.

- [ ] **Step 5: Fix existing tool names test and registered tools list**

In `tests/tool-definitions.test.ts`:

1. In test `"exposes cache-stable agent tools plus planning tools"`, add `"set_authorization_mode"` to the expected array:
```typescript
expect(tools.map((item) => item.name)).toEqual([
  "read_file", "edit_file", "write_file", "shell_execute", "update_plan", "ask_user", "set_authorization_mode",
]);
```

2. In the `registeredTools` const (line 174), add `"set_authorization_mode"`:
```typescript
const registeredTools = [
  "read_file", "edit_file", "write_file", "shell_execute",
  "update_plan", "ask_user", "set_authorization_mode",
];
```

Run to verify:
```bash
bun test tests/tool-definitions.test.ts
```
Expected: All tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/tools/definitions.ts
git commit -m "feat: add set_authorization_mode tool definition"
```

---

### Task 8: Add `set_authorization_mode` execution and `override` to `runApprovedTool`

**Files:**
- Modify: `src/harness/tool-runner.ts`

- [ ] **Step 1: Import `AuthorizationOverride` type**

```typescript
import type {
  AgentPhase,
  AgentPlan,
  AuthorizationOverride,   // new
  ShellGrantUsed,
  ShellResult,
  ThreadAuthorizationState,
  WorkspaceAccess,
} from "../shared/types";
```

- [ ] **Step 2: Add `override` parameter to `runApprovedTool`**

```typescript
export async function runApprovedTool(
  workspace: string,
  request: PendingToolRequest,
  shellExecutor?: ShellExecutor,
  workspaceAccess: WorkspaceAccess = "write",
  _existingPlan: AgentPlan | null = null,
  phase: AgentPhase = defaultPhaseForWorkspaceAccess(workspaceAccess),
  authorization: ThreadAuthorizationState | null = null,
  approvedGrant: ShellGrantUsed = "none",
  threadId = "",
  override?: AuthorizationOverride,  // new
): Promise<ToolExecutionResult> {
```

- [ ] **Step 3: Pass `override` to `evaluateToolPolicy` call**

Line 31: add `override` to the policy evaluation:

```typescript
  const policy = evaluateToolPolicy({
    request,
    workspaceAccess,
    phase,
    workspace,
    threadId,
    authorization: normalizeAuthorizationState(authorization),
    override, // new
  });
```

- [ ] **Step 4: Add `set_authorization_mode` execution branch**

After the `ask_user` branch (line 122-130), add:

```typescript
  if (request.name === "set_authorization_mode") {
    if (override) {
      override.current = request.args.mode;
    }
    const newAuth: ThreadAuthorizationState = {
      mode: request.args.mode,
      commandGrants: authorization?.commandGrants ?? {},
    };
    return withFailureGuidance(request, {
      ok: true,
      command: `set_authorization_mode ${request.args.mode}`,
      exitCode: 0,
      stdout: `Authorization mode set to: ${request.args.mode}`,
      stderr: "",
      authorization: newAuth,
    });
  }
```

- [ ] **Step 5: Verify types compile**

```bash
bun run typecheck
```
Expected: No type errors.

- [ ] **Step 6: Commit**

```bash
git add src/harness/tool-runner.ts
git commit -m "feat: add set_authorization_mode execution branch in tool runner"
```

---

### Task 9: Wire override through graph construction

**Files:**
- Modify: `src/harness/graph.ts`

- [ ] **Step 1: Import `AuthorizationOverride`**

```typescript
import type {
  AgentResumeValue,
  AuthorizationOverride,  // new
  ModelRetryEvent,
  ShellApprovalGrant,
  ThreadAuthorizationState, // new
} from "../shared/types";
```

And add `normalizeAuthorizationState` to the tool-policy imports:

```typescript
import {
  buildToolApproval,
  defaultPhaseForWorkspaceAccess,
  evaluateToolPolicy,
  applyApprovalGrant,
  normalizeAuthorizationState, // new
  replaceApprovalCommand,
  validateApprovalHash,
} from "./tool-policy";
```

- [ ] **Step 2: Add `authorizationOverride` to `BuildCodeAgentGraphInput`**

```typescript
export interface BuildCodeAgentGraphInput {
  config: AgentConfig;
  checkpointPath: string;
  shellExecutor?: ShellExecutor;
  model?: SupportedChatModel;
  authorizationOverride?: AuthorizationOverride; // new
}
```

- [ ] **Step 3: Capture override in closure, wrap `routeAfterAgent` call**

In `buildCodeAgentGraph`, after destructuring input:

```typescript
  const override = input.authorizationOverride;
```

Change the graph's conditional edge to use a wrapped route function:

```typescript
  const graph = new StateGraph(AgentState)
    .addNode("agent", agent)
    .addNode("approval", approval)
    .addNode("user_input", userInput)
    .addNode("tools", tools)
    .addConditionalEdges(START, routeEntry)
    .addConditionalEdges("agent", (state: CodeAgentState) => routeAfterAgent(state, override))
    .addConditionalEdges("approval", routeAfterApproval)
    .addConditionalEdges("user_input", routeAfterUserInput)
    .addConditionalEdges("tools", routeAfterTools)
    .compile({ checkpointer });
```

- [ ] **Step 4: Pass `override` to `evaluateToolPolicy` in `approval` node**

In the `approval` node (line 103), add `override`:

```typescript
    const policy = evaluateToolPolicy({
      request,
      workspaceAccess,
      phase: state.phase ?? defaultPhaseForWorkspaceAccess(workspaceAccess),
      workspace: state.workspace,
      threadId: state.threadId,
      authorization: state.authorization,
      override, // new
    });
```

And in the second `evaluateToolPolicy` call after interrupt (line 180):

```typescript
    const approvedPolicy = evaluateToolPolicy({
      request: approvedRequest,
      workspaceAccess,
      phase: state.phase ?? defaultPhaseForWorkspaceAccess(workspaceAccess),
      workspace: state.workspace,
      threadId: state.threadId,
      authorization: nextAuthorization,
      override, // new
    });
```

- [ ] **Step 5: Pass `override` to `runApprovedTool` in `tools` node**

In the `tools` node (line 239), add `override`:

```typescript
    const result = await runApprovedTool(
      state.workspace,
      request,
      input.shellExecutor,
      state.workspaceAccess,
      state.plan,
      state.phase,
      state.authorization,
      grantUsed,
      state.threadId,
      override, // new
    );
```

- [ ] **Step 6: Spread `authorization` from result in tools node return**

After the `toolMessage` creation, change the return logic (replace the existing `if ("plan" in result)` block):

```typescript
    const extra: Record<string, unknown> = {};
    if ("plan" in result) {
      extra.plan = result.plan;
    }
    if ("workspaceAccess" in result) {
      extra.workspaceAccess = result.workspaceAccess;
    }
    if ("authorization" in result) {
      extra.authorization = result.authorization;
    }

    return {
      approvedToolRequest: null,
      approvedToolGrant: null,
      ...extra,
      messages: [toolMessage],
    };
```

- [ ] **Step 7: Add helper and sync override in agent node return**

After the `agent` function definition, before the return in the agent node (line 88), add override sync:

In the agent node, replace the return at line 86-88:

```typescript
      const syncedAuth = authorizationForState(state, override);
      if (allRetries.length > 0) {
        return { ...result, authorization: syncedAuth, modelRetries: allRetries };
      }
      return { ...result, authorization: syncedAuth };
```

Add the `authorizationForState` helper function before `invokeModel` (after `buildCodeAgentGraph`):

```typescript
/** 将 override 同步到 state.authorization / Sync override to state.authorization */
function authorizationForState(
  state: CodeAgentState,
  override?: AuthorizationOverride,
): ThreadAuthorizationState {
  const base = normalizeAuthorizationState(state.authorization);
  if (override && override.current !== base.mode) {
    return { ...base, mode: override.current };
  }
  return base;
}
```

Import `normalizeAuthorizationState` if not already imported (check line 42 — it's imported from tool-policy.ts).

- [ ] **Step 8: Verify types compile**

```bash
bun run typecheck
```
Expected: No type errors.

- [ ] **Step 9: Commit**

```bash
git add src/harness/graph.ts
git commit -m "feat: wire authorization override through graph nodes"
```

---

### Task 10: Wire override through `streamCodeAgent`

**Files:**
- Modify: `src/app/runner.ts`

- [ ] **Step 1: Import `AuthorizationOverride` type**

```typescript
import type {
  AgentPhase,
  AgentEvent,
  AgentResumeValue,
  AuthorizationOverride,  // new
  ContextBudget,
  ModelRetryEvent,
  WorkspaceAccess,
  WorkspaceAccessRequest,
} from "../shared/types";
```

- [ ] **Step 2: Add `authorizationOverride` to `StreamCodeAgentInput`**

```typescript
export interface StreamCodeAgentInput {
  task: string;
  userId: string;
  threadId: string;
  workspace: string;
  checkpointPath: string;
  config: AgentConfig;
  shellExecutor?: ShellExecutor;
  mode?: WorkspaceAccessRequest;
  contextBudget?: ContextBudget;
  authorizationOverride?: AuthorizationOverride; // new
}
```

- [ ] **Step 3: Pass `authorizationOverride` to `buildCodeAgentGraph`**

In `streamCodeAgent`, change the call:

```typescript
  const { graph, checkpointer } = buildCodeAgentGraph({
    ...input,
    authorizationOverride: input.authorizationOverride, // new
  });
```

- [ ] **Step 4: Also pass in `resumeCodeAgent`**

In `resumeCodeAgent`:

```typescript
  const { graph, checkpointer } = buildCodeAgentGraph({
    ...input,
    authorizationOverride: input.authorizationOverride, // new
  });
```

Note: `ResumeCodeAgentInput` extends `Omit<StreamCodeAgentInput, "task">`, so it inherits `authorizationOverride`.

- [ ] **Step 5: Verify types compile**

```bash
bun run typecheck
```
Expected: No type errors.

- [ ] **Step 6: Commit**

```bash
git add src/app/runner.ts
git commit -m "feat: pass authorization override through stream runner"
```

---

### Task 11: Add CLI `--authorization-mode` flag

**Files:**
- Modify: `src/app/cli.ts`

- [ ] **Step 1: Import `AuthorizationOverride` type**

```typescript
import type {
  AuthorizationOverride,  // new
  ShellApprovalGrant,
  WorkspaceAccessRequest,
} from "../shared/types";
```

- [ ] **Step 2: Add `authorizationMode` to `ParsedArgs`**

```typescript
export interface ParsedArgs {
  command: "run" | "resume" | "help";
  task?: string;
  threadId: string;
  userId: string;
  workspace: string;
  checkpointPath: string;
  mode: WorkspaceAccessRequest;
  authorizationMode?: "default" | "full_access"; // new
  approve: boolean;
  approvalGrant?: ShellApprovalGrant;
  approvalHash?: string;
  replacementCommand?: string;
  answer?: string;
  sandbox: boolean;
}
```

- [ ] **Step 3: Parse `--authorization-mode` in `parseArgs`**

In `parseArgs`, after `const mode = parseMode(...)` and before the return statement:

```typescript
  const authorizationMode = parseAuthorizationMode(
    optionalValue("--authorization-mode") ?? "",
  );
```

Add to the return object:

```typescript
    authorizationMode,
```

- [ ] **Step 4: Add `parseAuthorizationMode` helper**

After `parseMode`:

```typescript
/** 解析授权模式参数 / Parse authorization mode argument */
function parseAuthorizationMode(value: string): "default" | "full_access" | undefined {
  if (value === "full_access" || value === "full-access") {
    return "full_access";
  }
  if (value === "default") {
    return "default";
  }
  return undefined;
}
```

- [ ] **Step 5: Create override and pass in `run` command**

In the `main` function, before the `streamCodeAgent` call (line 56-67), add:

```typescript
  const authorizationOverride = args.authorizationMode
    ? { current: args.authorizationMode }
    : undefined;
```

And pass it:

```typescript
      ? streamCodeAgent({
          task: args.task ?? "",
          userId: args.userId,
          threadId: args.threadId,
          workspace: args.workspace,
          checkpointPath: args.checkpointPath,
          config,
          mode: args.mode,
          shellExecutor,
          authorizationOverride, // new
        })
```

- [ ] **Step 6: Handle resume with authorization mode change**

In `resumeCodeAgent` call (line 68-84), when there's an `authorizationOverride`, also include it:

```typescript
      : resumeCodeAgent({
          userId: args.userId,
          threadId: args.threadId,
          workspace: args.workspace,
          checkpointPath: args.checkpointPath,
          config,
          shellExecutor,
          authorizationOverride, // new - needed for TUI override scenarios
          resume:
            args.answer === undefined
              ? { ... }
              : { answer: args.answer },
        });
```

- [ ] **Step 7: Update help text**

In `printHelp`, add to the options list:

```
  --authorization-mode <mode>  default or full-access; set initial authorization mode for the thread
```

- [ ] **Step 8: Verify types compile**

```bash
bun run typecheck
```
Expected: No type errors.

- [ ] **Step 9: Commit**

```bash
git add src/app/cli.ts
git commit -m "feat: add --authorization-mode CLI flag"
```

---

### Task 12: Write and run tests

**Files:**
- Create: `tests/authorization-mode.test.ts`

- [ ] **Step 1: Write the test file**

```typescript
import { describe, expect, test } from "bun:test";
import { AIMessage } from "@langchain/core/messages";
import { routeAfterAgent } from "../src/harness/routes";
import { runApprovedTool } from "../src/harness/tool-runner";
import {
  evaluateToolPolicy,
  defaultAuthorizationState,
} from "../src/harness/tool-policy";
import type { CodeAgentState } from "../src/harness/state";
import type { ShellResult } from "../src/shared/types";

describe("authorization mode switch", () => {
  // ---- evaluateToolPolicy with override ----

  test("override full_access bypasses shell_execute approval", () => {
    const decision = evaluateToolPolicy({
      request: {
        id: "call-1",
        name: "shell_execute",
        args: { command: "bun test" },
        reason: "test",
        protectedCommand: "bun test",
      },
      workspaceAccess: "write",
      phase: "building",
      authorization: { mode: "default", commandGrants: {} },
      override: { current: "full_access" },
    });
    expect(decision.allowed).toBe(true);
    expect(decision.requiresApproval).toBe(false);
    expect(decision.grantUsed).toBe("full_access");
  });

  test("override does NOT affect read-only shell commands (still allowed, no approval)", () => {
    const decision = evaluateToolPolicy({
      request: {
        id: "call-2",
        name: "shell_execute",
        args: { command: "git status" },
        reason: "inspect",
        protectedCommand: "git status",
      },
      workspaceAccess: "write",
      phase: "building",
      authorization: { mode: "default", commandGrants: {} },
      override: { current: "default" },
    });
    expect(decision.allowed).toBe(true);
    expect(decision.requiresApproval).toBe(false);
  });

  test("set_authorization_mode is always allowed", () => {
    const decision = evaluateToolPolicy({
      request: {
        id: "call-3",
        name: "set_authorization_mode",
        args: { mode: "full_access" },
        reason: "User requested auto-execute",
        protectedCommand: "set_authorization_mode full_access",
      },
      workspaceAccess: "write",
      phase: "building",
    });
    expect(decision.allowed).toBe(true);
    expect(decision.requiresApproval).toBe(false);
    expect(decision.risk).toBe("plan");
  });

  // ---- routing with override ----

  test("routes write_file to approval under default override", () => {
    expect(
      routeAfterAgent(
        {
          workspaceAccess: "write",
          workspace: "/tmp/workspace",
          messages: [
            new AIMessage({
              content: "",
              tool_calls: [
                { id: "call-1", name: "write_file", args: { path: "hello.txt", content: "hi" } },
              ],
            }),
          ],
        } as unknown as CodeAgentState,
        { current: "default" },
      ),
    ).toBe("approval");
  });

  test("routes write_file directly to tools under full_access override", () => {
    expect(
      routeAfterAgent(
        {
          workspaceAccess: "write",
          phase: "building",
          workspace: "/tmp/workspace",
          messages: [
            new AIMessage({
              content: "",
              tool_calls: [
                { id: "call-1", name: "shell_execute", args: { command: "bun test" } },
              ],
            }),
          ],
        } as unknown as CodeAgentState,
        { current: "full_access" },
      ),
    ).toBe("tools");
  });

  test("routes set_authorization_mode to tools (no approval)", () => {
    expect(
      routeAfterAgent(
        {
          workspaceAccess: "write",
          workspace: "/tmp/workspace",
          messages: [
            new AIMessage({
              content: "",
              tool_calls: [
                { id: "call-1", name: "set_authorization_mode", args: { mode: "full_access" } },
              ],
            }),
          ],
        } as unknown as CodeAgentState,
      ),
    ).toBe("tools");
  });

  // ---- tool execution ----

  test("set_authorization_mode updates override.current", async () => {
    const override = { current: "default" as const };
    const result = await runApprovedTool(
      "/tmp/workspace",
      {
        id: "call-1",
        name: "set_authorization_mode",
        args: { mode: "full_access" },
        reason: "User requested auto mode",
        protectedCommand: "set_authorization_mode full_access",
      },
      undefined,
      "write",
      null,
      "building",
      defaultAuthorizationState(),
      "none",
      "",
      override,
    );
    expect(override.current).toBe("full_access");
    expect(result.ok).toBe(true);
    expect(result.authorization).toEqual({
      mode: "full_access",
      commandGrants: {},
    });
  });

  test("set_authorization_mode returns authorization in result", async () => {
    const result = await runApprovedTool(
      "/tmp/workspace",
      {
        id: "call-1",
        name: "set_authorization_mode",
        args: { mode: "default" },
        reason: "User requested default mode",
        protectedCommand: "set_authorization_mode default",
      },
      undefined,
      "write",
      null,
      "building",
      defaultAuthorizationState(),
      "none",
      "",
    );
    expect(result.authorization).toEqual({
      mode: "default",
      commandGrants: {},
    });
  });

  test("evaluateToolPolicy without override falls back to state authorization", () => {
    const decision = evaluateToolPolicy({
      request: {
        id: "call-1",
        name: "shell_execute",
        args: { command: "bun test" },
        reason: "test",
        protectedCommand: "bun test",
      },
      workspaceAccess: "write",
      phase: "building",
      authorization: { mode: "full_access", commandGrants: {} },
      // no override — should use state.authorization.mode
    });
    expect(decision.allowed).toBe(true);
    expect(decision.requiresApproval).toBe(false);
    expect(decision.grantUsed).toBe("full_access");
  });
});
```

- [ ] **Step 2: Run the tests**

```bash
bun test tests/authorization-mode.test.ts
```
Expected: All 8 tests pass.

- [ ] **Step 3: Run existing test suite to ensure no regressions**

```bash
bun test
```
Expected: All existing tests pass.

- [ ] **Step 4: Commit**

```bash
git add tests/authorization-mode.test.ts
git commit -m "test: add authorization mode switch tests"
```

---

### Task 13: Final verification — full test suite

**Files:**
- N/A (verification only)

- [ ] **Step 1: Run typecheck**

```bash
bun run typecheck
```
Expected: No errors.

- [ ] **Step 2: Run full test suite**

```bash
bun test
```
Expected: All tests pass (no regressions + new tests pass).

- [ ] **Step 3: Verify no lint issues**

```bash
bun run lint 2>/dev/null || echo "No lint script configured"
```

