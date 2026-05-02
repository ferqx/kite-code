import { describe, expect, test } from "bun:test";
import {
  buildRealTestCommand,
  buildRealTestEnv,
  parseRealTestArgs,
  REAL_TEST_MODEL_ENV,
  REAL_TEST_PROVIDER_ENV,
} from "../src/app/real-test-options";

describe("real model override options", () => {
  test("parses provider and model inline flags", () => {
    expect(
      parseRealTestArgs([
        "--provider=ollama",
        "--model=gemma4:31b-cloud",
      ]),
    ).toEqual({
      providerName: "ollama",
      modelName: "gemma4:31b-cloud",
      passthroughArgs: [],
    });
  });

  test("parses provider and model space-separated flags", () => {
    expect(
      parseRealTestArgs([
        "--provider",
        "openrouter",
        "--model",
        "anthropic/claude-sonnet-4.5",
      ]),
    ).toEqual({
      providerName: "openrouter",
      modelName: "anthropic/claude-sonnet-4.5",
      passthroughArgs: [],
    });
  });

  test("rejects flags without values", () => {
    expect(() => parseRealTestArgs(["--provider"]))
      .toThrow("--provider requires a value");
    expect(() => parseRealTestArgs(["--model="]))
      .toThrow("--model requires a value");
  });

  test("passes non override arguments through to bun test", () => {
    expect(
      parseRealTestArgs([
        "--provider=ollama",
        "--model=gemma4:31b-cloud",
        "--test-name-pattern",
        "preflight",
      ]),
    ).toEqual({
      providerName: "ollama",
      modelName: "gemma4:31b-cloud",
      passthroughArgs: ["--test-name-pattern", "preflight"],
    });
  });

  test("builds the real test command with passthrough arguments", () => {
    expect(
      buildRealTestCommand({
        providerName: "ollama",
        modelName: "gemma4:31b-cloud",
        passthroughArgs: ["--test-name-pattern", "preflight"],
      }),
    ).toEqual([
      "bun",
      "test",
      "--concurrent",
      "--max-concurrency",
      "3",
      "./tests/real-agent.real.ts",
      "--test-name-pattern",
      "preflight",
    ]);
  });

  test("injects provider and model overrides into child test environment", () => {
    expect(
      buildRealTestEnv(
        { KEEP: "yes" },
        {
          providerName: "ollama",
          modelName: "gemma4:31b-cloud",
          passthroughArgs: [],
        },
      ),
    ).toEqual({
      KEEP: "yes",
      [REAL_TEST_PROVIDER_ENV]: "ollama",
      [REAL_TEST_MODEL_ENV]: "gemma4:31b-cloud",
    });
  });

  test("clears stale internal override environment without explicit flags", () => {
    expect(
      buildRealTestEnv(
        {
          KEEP: "yes",
          [REAL_TEST_PROVIDER_ENV]: "stale-provider",
          [REAL_TEST_MODEL_ENV]: "stale-model",
        },
        { passthroughArgs: [] },
      ),
    ).toEqual({ KEEP: "yes" });
  });
});
