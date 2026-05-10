import { describe, expect, test } from "bun:test";
import { AIMessage } from "@langchain/core/messages";
import { routeAfterAgent } from "../src/harness/routes";
import { runApprovedTool } from "../src/harness/tool-runner";
import {
  evaluateToolPolicy,
  defaultAuthorizationState,
} from "../src/harness/tool-policy";
import type { CodeAgentState } from "../src/harness/state";

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
    const override: { current: "default" | "full_access" } = { current: "default" };
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
    });
    expect(decision.allowed).toBe(true);
    expect(decision.requiresApproval).toBe(false);
    expect(decision.grantUsed).toBe("full_access");
  });
});
