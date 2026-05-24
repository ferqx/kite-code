/**
 * Skills e2e test scenarios.
 *
 * Two types:
 * - Mock-agent scenarios: test TUI reducer actions using dispatch steps
 * - Real-agent scenarios: test full agent loop with mock model + real SKILL.md files
 */
import type { Scenario, SnapshotExpectation, RealAgentScenario } from "../types";
import type { SkillManifest } from "../../../src/core/skills/types";
import { skillDirs } from "../../../src/core/config/paths";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const baseFreeze: Scenario["freeze"] = ["timer", "cacheHitRate", "cacheTokenCount"];

// ══════════════════════════════════════════════════════════
// Mock-agent: TUI reducer skill actions
// ══════════════════════════════════════════════════════════

interface CmdCase {
  scenario: Scenario;
  expectations: SnapshotExpectation[];
}

/** /skills with no skills available — shows empty message */
export const listSkillsEmpty: CmdCase = {
  scenario: {
    terminalWidth: 120, stepTimeout: 5000, freeze: baseFreeze,
    steps: [
      { type: "dispatch", actionType: "LIST_SKILLS" },
      { type: "agent-done" },
    ],
  },
  expectations: [
    {
      reason: "terminal",
      ansi: [
        { type: "contains", text: "No skills available", description: "empty skills message" },
      ],
      state: [
        { type: "running-is", value: false },
      ],
    },
  ],
};

/** /skills with manifests set — shows skill list */
export const listSkillsWithManifests: CmdCase = {
  scenario: {
    terminalWidth: 120, stepTimeout: 5000, freeze: baseFreeze,
    steps: [
      {
        type: "dispatch",
        actionType: "SET_SKILL_MANIFESTS",
        payload: {
          manifests: [
            { name: "tdd", description: "Test-driven development workflow", source: "project", origin: ".openpx" },
            { name: "code-review", description: "Code review helper", source: "project", origin: ".openpx" },
          ],
        },
      },
      { type: "dispatch", actionType: "LIST_SKILLS" },
      { type: "agent-done" },
    ],
  },
  expectations: [
    {
      reason: "terminal",
      ansi: [
        { type: "contains", text: "Available Skills", description: "skills list header" },
        { type: "contains", text: "tdd", description: "tdd skill listed" },
        { type: "contains", text: "Test-driven development workflow", description: "tdd description shown" },
        { type: "contains", text: "code-review", description: "code-review skill listed" },
        { type: "contains", text: "project/.openpx", description: "source/origin shown" },
      ],
      state: [
        { type: "running-is", value: false },
      ],
    },
  ],
};

/** ACTIVATE_SKILL + DEACTIVATE_SKILL state changes */
export const skillActivateDeactivate: CmdCase = {
  scenario: {
    terminalWidth: 120, stepTimeout: 5000, freeze: baseFreeze,
    steps: [
      {
        type: "dispatch",
        actionType: "ACTIVATE_SKILL",
        payload: { name: "tdd", content: "# TDD\n\nWrite tests first, then implement." },
      },
      { type: "agent-done" },
      {
        type: "dispatch",
        actionType: "DEACTIVATE_SKILL",
        payload: { name: "tdd" },
      },
      { type: "agent-done" },
    ],
  },
  expectations: [
    {
      reason: "terminal",
      state: [
        { type: "running-is", value: false },
      ],
    },
    {
      reason: "terminal",
      state: [
        { type: "running-is", value: false },
      ],
    },
  ],
};

/** SET_SKILL_MANIFESTS action */
export const setSkillManifestsAction: CmdCase = {
  scenario: {
    terminalWidth: 120, stepTimeout: 5000, freeze: baseFreeze,
    steps: [
      {
        type: "dispatch",
        actionType: "SET_SKILL_MANIFESTS",
        payload: {
          manifests: [
            { name: "tdd", description: "Test-driven development", source: "project", origin: ".openpx" },
          ],
        },
      },
      { type: "agent-done" },
    ],
  },
  expectations: [
    {
      reason: "terminal",
      state: [
        { type: "running-is", value: false },
      ],
    },
  ],
};

// ══════════════════════════════════════════════════════════
// Real-agent: full agent loop with real SKILL.md files
// ══════════════════════════════════════════════════════════

const realFreeze: RealAgentScenario["freeze"] = ["timer", "cacheHitRate", "cacheTokenCount", "toolElapsed"];

/** Helper: create a real-agent scenario that sets up skills in the workspace */
export function createSkillScenario(config: {
  name: string;
  task: string;
  modelResponses: RealAgentScenario["modelResponses"];
  autoApprove?: boolean;
  expectations: SnapshotExpectation[];
  skillName?: string;
  skillDescription?: string;
  skillContent?: string;
}): RealAgentScenario {
  const skillName = config.skillName ?? "tdd";
  const skillDescription = config.skillDescription ?? "Test-driven development workflow";
  const skillContent = config.skillContent ?? `# Test-Driven Development\n\n1. Write a failing test first\n2. Run the test to see it fail\n3. Write minimal code to pass\n4. Refactor\n5. Repeat`;

  const manifest: SkillManifest = {
    name: skillName,
    description: skillDescription,
    source: "project",
    origin: ".openpx",
  };

  const scenario: RealAgentScenario = {
    terminalWidth: 120,
    stepTimeout: 20000,
    freeze: realFreeze,
    task: config.task,
    modelResponses: config.modelResponses,
    autoApprove: config.autoApprove ?? true,
    skills: [manifest],
    // skillOptions set in onWorkspaceReady
    onWorkspaceReady: (workspace: string) => {
      const skillDirPath = join(workspace, ".openpx", "skills", skillName);
      mkdirSync(skillDirPath, { recursive: true });
      writeFileSync(
        join(skillDirPath, "SKILL.md"),
        `---\nname: ${skillName}\ndescription: ${skillDescription}\n---\n\n${skillContent}`,
      );
      // Set skillOptions now that we know the workspace path
      scenario.skillOptions = skillDirs(workspace);
    },
    expectations: config.expectations,
  };

  return scenario;
}

/** Agent calls Skill tool and receives skill content */
export function agentCallsSkillTool(): RealAgentScenario {
  return createSkillScenario({
    name: "agent-calls-skill",
    task: "Use the tdd skill to understand the testing workflow",
    modelResponses: [
      {
        message: {
          content: "Let me check the TDD skill for guidance.",
          tool_calls: [{ id: "sk1", name: "Skill", args: { skill: "tdd" } }],
        },
      },
      {
        message: { content: "According to the TDD skill, I should write tests first before implementing." },
      },
    ],
    expectations: [
      {
        reason: "terminal",
        state: [
          { type: "running-is", value: false },
          { type: "has-block-kind", kind: "tool_card" },
          { type: "has-block-kind", kind: "text" },
        ],
      },
    ],
  });
}

/** Agent calls Skill tool with unknown name — gets error */
export function agentCallsUnknownSkill(): RealAgentScenario {
  return createSkillScenario({
    name: "agent-calls-unknown-skill",
    task: "Use the nonexistent-skill to help",
    skillName: "known-skill",
    skillDescription: "A known skill",
    skillContent: "This is a known skill.",
    modelResponses: [
      {
        message: {
          content: "Let me try the nonexistent skill.",
          tool_calls: [{ id: "sk1", name: "Skill", args: { skill: "nonexistent-skill" } }],
        },
      },
      {
        message: { content: "That skill doesn't exist. Let me proceed without it." },
      },
    ],
    expectations: [
      {
        reason: "terminal",
        ansi: [
          { type: "contains", text: "Skill", description: "skill tool card visible" },
        ],
        state: [
          { type: "running-is", value: false },
          { type: "has-block-kind", kind: "tool_card" },
        ],
      },
    ],
  });
}

/** Agent calls Skill tool and uses content across multiple turns */
export function agentUsesSkillMultiTurn(): RealAgentScenario {
  return createSkillScenario({
    name: "agent-uses-skill-multi-turn",
    task: "Help me implement a feature using TDD",
    skillName: "tdd",
    skillDescription: "Test-Driven Development",
    skillContent: "# TDD\n\n1. Write a failing test\n2. Make it pass\n3. Refactor",
    modelResponses: [
      {
        message: {
          content: "Let me load the TDD skill first.",
          tool_calls: [{ id: "sk1", name: "Skill", args: { skill: "tdd" } }],
        },
      },
      {
        message: { content: "I'll follow the TDD workflow: first write a failing test, then implement." },
      },
    ],
    expectations: [
      {
        reason: "terminal",
        ansi: [
          { type: "contains", text: "TDD", description: "TDD skill referenced" },
        ],
        state: [
          { type: "running-is", value: false },
          { type: "has-block-kind", kind: "tool_card" },
        ],
      },
    ],
  });
}

// ── Exported scenarios for real-agent tests (pre-computed for simple cases) ──

export const skillToolCallScenario = agentCallsSkillTool();
export const unknownSkillScenario = agentCallsUnknownSkill();
export const skillMultiTurnScenario = agentUsesSkillMultiTurn();
