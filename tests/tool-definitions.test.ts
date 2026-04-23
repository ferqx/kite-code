import { describe, expect, test } from "bun:test";
import { createCodeAgentTools } from "../src/tool-definitions";

describe("code agent tool definitions", () => {
  test("exposes real model-bindable shell and apply_patch tools", () => {
    const tools = createCodeAgentTools({
      workspace: "D:\\workspace",
      shellExecutor: async (input) => ({
        ok: true,
        command: input.command,
        exitCode: 0,
        stdout: "ok",
        stderr: "",
      }),
    });

    expect(tools.map((item) => item.name)).toEqual([
      "shell_execute",
      "apply_patch",
      "remember",
    ]);
    expect(tools[0].schema).toBeDefined();
    expect(tools[1].schema).toBeDefined();
    expect(tools[2].schema).toBeDefined();
  });
});
