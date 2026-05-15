import type { Scenario } from "../types";

const baseFreeze: Scenario["freeze"] = ["timer", "cacheHitRate", "cacheTokenCount", "toolElapsed"];

/** Question with multiple options asking user to choose */
export const questionOptions: Scenario = {
  terminalWidth: 120, stepTimeout: 5000, freeze: baseFreeze,
  steps: [
    { type: "agent-text", text: "Which approach should I use?" },
    {
      type: "need-input",
      question: {
        question: "Choose implementation approach:",
        options: [
          { id: "a", label: "Use class components", description: "Traditional OOP approach" },
          { id: "b", label: "Use functional components", description: "Modern React style" },
          { id: "c", label: "Use hooks only", description: "Minimal hook-based approach" },
        ],
      },
    },
    { type: "expect-mode", mode: "question" },
    { type: "user-action", action: { type: "input", text: "Use functional components" } },
    { type: "agent-done" },
  ],
};

/** Free text question (no options, allow_free_text: true) */
export const questionFreeText: Scenario = {
  terminalWidth: 120, stepTimeout: 5000, freeze: baseFreeze,
  steps: [
    {
      type: "need-input",
      question: {
        question: "What should the filename be?",
        options: [],
        allow_free_text: true,
      },
    },
    { type: "expect-mode", mode: "question" },
    { type: "user-action", action: { type: "input", text: "my-utils.ts" } },
    { type: "agent-done" },
  ],
};

/** Question with options + free text (both available) */
export const questionOptionsAndFreeText: Scenario = {
  terminalWidth: 120, stepTimeout: 5000, freeze: baseFreeze,
  steps: [
    {
      type: "need-input",
      question: {
        question: "Choose or type a custom value:",
        options: [
          { id: "a", label: "TypeScript", description: "Use .ts extension" },
          { id: "b", label: "JavaScript", description: "Use .js extension" },
        ],
        allow_free_text: true,
      },
    },
    { type: "expect-mode", mode: "question" },
    { type: "user-action", action: { type: "input", text: "TypeScript" } },
    { type: "agent-done" },
  ],
};

/** Question with context hint */
export const questionWithContext: Scenario = {
  terminalWidth: 120, stepTimeout: 5000, freeze: baseFreeze,
  steps: [
    { type: "agent-text", text: "I found a potential issue in the config." },
    {
      type: "need-input",
      question: {
        question: "Should I fix this config value?",
        options: [
          { id: "y", label: "Yes, fix it" },
          { id: "n", label: "No, leave it" },
        ],
      },
    },
    { type: "expect-mode", mode: "question" },
    { type: "user-action", action: { type: "input", text: "Yes, fix it" } },
    { type: "agent-done" },
  ],
};
