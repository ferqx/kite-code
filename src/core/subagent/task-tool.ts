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
}

/** 最大并发子 agent 数 */
const MAX_CONCURRENT = 10;
let activeCount = 0;

export function createTaskTool(deps: TaskToolDeps) {
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
        });
        return JSON.stringify(result);
      } finally {
        activeCount--;
      }
    },
    {
      name: "task",
      description: [
        "Dispatch a task to a specialized sub-agent with an isolated context window and restricted tool set.",
        "Sub-agents run independently and return a final summary — they cannot see the main conversation history.",
        "",
        "Available sub-agent types:",
        "- explore: Read-only codebase search and evidence gathering. Returns structured findings with file:line references.",
        "- code: Full implementation agent. Can read, write, edit files, and run shell commands. Provide precise, detailed instructions.",
        "- review: Critical code reviewer. Returns findings organized by severity (Critical/Warning/Suggestion) with file:line references.",
        "",
        "When NOT to use:",
        "- Do NOT delegate tasks that require understanding the full conversation context — handle those yourself.",
        "- Do NOT use for simple single-file reads or grep commands — use read_file or shell_execute directly.",
        "",
        "The task description must be self-contained and include ALL necessary context, as the sub-agent has no access to the conversation history.",
      ].join("\n"),
      schema: z.object({
        subagent_type: z.enum(["explore", "code", "review"]).describe("Type of sub-agent to invoke"),
        task: z.string().min(1).describe("Self-contained task description with all necessary context. The sub-agent cannot see the main conversation."),
      }),
    },
  );
}
