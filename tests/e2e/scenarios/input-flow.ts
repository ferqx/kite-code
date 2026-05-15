import type { Scenario } from "../types";

const baseFreeze: Scenario["freeze"] = ["timer", "cacheHitRate", "cacheTokenCount"];

/** Basic: user types a message, agent responds with text */
export const basicInputReply: Scenario = {
  terminalWidth: 120, stepTimeout: 5000, freeze: baseFreeze,
  steps: [
    { type: "simulate-input", text: "Write a hello function in TypeScript" },
    { type: "agent-text", text: "Here's a hello function:" },
    { type: "agent-text", text: "```ts\nfunction hello(): void {\n  console.log('Hello, world!');\n}\n```" },
    { type: "agent-done" },
  ],
};

/** Input triggers a tool call that needs approval */
export const inputToolApproval: Scenario = {
  terminalWidth: 120, stepTimeout: 5000, freeze: [...baseFreeze!, "toolElapsed"] as Scenario["freeze"],
  steps: [
    { type: "simulate-input", text: "Create a config file config.json" },
    { type: "agent-text", text: "I'll create the config file." },
    { type: "tool-call", tool: "write_file", args: { path: "config.json", content: '{"port": 3000}' } },
    { type: "need-approval", approval: { tool: "write_file", command: "write config.json", risk: "write_file", summary: "Create config.json" } },
    { type: "expect-mode", mode: "approval" },
    { type: "user-action", action: { type: "approve", grant: "approve_once" } },
    { type: "tool-result", output: "File written." },
    { type: "agent-done" },
  ],
};

/** Multi-turn conversation — short enough to fit viewport */
export const multiTurn: Scenario = {
  terminalWidth: 120, stepTimeout: 5000, freeze: baseFreeze,
  steps: [
    { type: "simulate-input", text: "Hi" },
    { type: "agent-text", text: "Hello!" },
    { type: "agent-done" },
    { type: "simulate-input", text: "What is 1+1?" },
    { type: "agent-text", text: "2" },
    { type: "agent-done" },
  ],
};

/** Ctrl+C during agent running — verify via state assertion */
export const ctrlCInterrupt: Scenario = {
  terminalWidth: 120, stepTimeout: 5000, freeze: baseFreeze,
  steps: [
    { type: "simulate-input", text: "Long task" },
    { type: "agent-text", text: "Running..." },
    { type: "simulate-key", key: "\x03" },
    { type: "agent-done" },
  ],
};
