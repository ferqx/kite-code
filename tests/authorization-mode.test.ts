import { describe, expect, test } from "bun:test";
import { AIMessage } from "@langchain/core/messages";
import { routeAfterAgent } from "../src/core/harness/routes";
import { runApprovedTool } from "../src/core/harness/tool-runner";
import {
  evaluateToolPolicy,
  defaultAuthorizationState,
} from "../src/core/harness/tool-policy";
import type { CodeAgentState } from "../src/core/harness/state";

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

  test("override full_access allows write_file without approval", () => {
    const decision = evaluateToolPolicy({
      request: {
        id: "call-4",
        name: "write_file",
        args: { path: "hello.txt", content: "hi" },
        reason: "create file",
        protectedCommand: "write_file hello.txt",
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

  test("routes shell_execute directly to tools under full_access override", () => {
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

  // ---- tool execution ----

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
    });
    expect(decision.allowed).toBe(true);
    expect(decision.requiresApproval).toBe(false);
    expect(decision.grantUsed).toBe("full_access");
  });
});
