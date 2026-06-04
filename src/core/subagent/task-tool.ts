import { tool } from "@langchain/core/tools";
import { z } from "zod";
import type { AgentConfig } from "@/core/config/index";
import type { ShellExecutor } from "@/core/tools/shell";
import type { McpManager } from "@/core/mcp";
import type { SkillManifest, SkillScanOptions } from "@/core/skills/types";
import type { SupportedChatModel } from "@/core/model/factory";
import type { SubAgentEventSink } from "./types";
import { getRoleConfig } from "./roles";
import { runSubAgent } from "./runner";

export interface TaskToolDeps {
  config: AgentConfig;
  workspace: string;
  shellExecutor?: ShellExecutor;
  mcpManager?: McpManager;
  skills?: SkillManifest[];
  skillOptions?: SkillScanOptions;
  eventSink: SubAgentEventSink;
  signal?: AbortSignal;
  /** 可选自定义模型实例（用于 E2E mock）/ Optional custom model instance (for E2E mock) */
  model?: SupportedChatModel;
  /** 最大允许嵌套深度（0 = 不允许子 agent 再派生）/ Max nesting depth (0 = no further nesting) */
  maxDepth?: number;
}

/** 最大并发子 agent 数 */
const MAX_CONCURRENT = 10;

export function createTaskTool(deps: TaskToolDeps) {
  // 按 session 隔离并发计数，避免多 session 互相干扰
  // Per-session concurrency counter to avoid cross-session interference
  let activeCount = 0;

  return tool(
    async ({ subagent_type, task }) => {
      if (activeCount >= MAX_CONCURRENT) {
        return JSON.stringify({
          ok: false,
          error: `Maximum concurrent sub-agents (${MAX_CONCURRENT}) reached. Wait for running sub-agents to complete.`,
        });
      }

      const roleConfig = getRoleConfig(subagent_type);
      const signal = deps.signal ?? new AbortController().signal;

      activeCount++;
      try {
        const result = await runSubAgent({
          config: deps.config,
          workspace: deps.workspace,
          role: roleConfig,
          task,
          shellExecutor: deps.shellExecutor,
          mcpManager: deps.mcpManager,
          skills: deps.skills,
          skillOptions: deps.skillOptions,
          timeoutMs: 30 * 60 * 1000, // 30 分钟
          signal,
          eventSink: deps.eventSink,
          model: deps.model,
          depth: 1,
          maxDepth: deps.maxDepth ?? 0,
        });
        return JSON.stringify(result);
      } finally {
        activeCount--;
      }
    },
    {
      name: "task",
      description: [
        "Dispatch a specialized sub-agent to handle a standalone task in an isolated context window.",
        "Sub-agents have their own context — they CANNOT see the main conversation history.",
        "Use this to: run independent work in parallel, delegate well-scoped tasks, or keep the main conversation focused.",
        "",
        "When to use (prefer task over direct tool calls):",
        "- Searching for something across many files — use explore sub-agent instead of multiple greps/reads",
        "- Implementing a self-contained feature or fix — use code sub-agent with clear, specific instructions",
        "- Reviewing code for bugs or security issues — use review sub-agent for an impartial audit",
        "- Any task where the sub-agent can work independently without needing main conversation context",
        "- The user explicitly asks you to 'dispatch', 'delegate', or 'use a sub-agent'",
        "",
        "When NOT to use:",
        "- Simple single-file reads or single grep — use read_file or shell_execute directly",
        "- Tasks that depend on understanding the full conversation history",
        "",
        "Available types:",
        "- explore: Read-only search across the codebase. Best for: finding usages, tracing call chains, gathering evidence.",
        "- code: Full read/write/execute. Best for: implementing features, fixing bugs, running tests.",
        "- review: Read-only critical review. Best for: security audit, code quality check, regression detection.",
        "",
        "Write self-contained instructions in the task field — include file paths, function names, and specific requirements.",
      ].join("\n"),
      schema: z.object({
        subagent_type: z.enum(["explore", "code", "review"]).describe("Type of sub-agent to invoke"),
        task: z.string().min(1).describe("Self-contained task description with all necessary context. The sub-agent cannot see the main conversation."),
      }),
    },
  );
}
