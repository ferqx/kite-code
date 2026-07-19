import { tool, zodSchema } from 'ai';
import { z } from 'zod';
import type { AgentConfig } from '@/core/config/index';
import type { McpRuntimeProvider } from '@/core/mcp';
import type { SupportedChatModel } from '@/core/model/factory';
import type { SkillManifest, SkillScanOptions } from '@/core/skills/types';
import type { ShellExecutor } from '@/core/tools/shell';
import { getRoleConfig } from './roles';
import { runSubAgent } from './runner';
import type { SubAgentEventSink, SubAgentResult } from './types';

export interface TaskToolDeps {
  config: AgentConfig;
  workspace: string;
  shellExecutor?: ShellExecutor;
  mcpManager?: McpRuntimeProvider;
  skills?: SkillManifest[];
  skillOptions?: SkillScanOptions;
  allowedTools?: Set<string>;
  mcpBindings?: Array<{
    binding: import('@/protocol/capabilities').CapabilityBinding;
    descriptor: import('@/protocol/capabilities').CapabilityDescriptor;
  }>;
  authorization?: import('@/core/types').ThreadAuthorizationState;
  workspaceAccess?: import('@/protocol/events').WorkspaceAccess;
  phase?: import('@/protocol/events').AgentPhase;
  threadId?: string;
  eventSink: SubAgentEventSink;
  signal?: AbortSignal;
  model?: SupportedChatModel;
  maxDepth?: number;
}

const MAX_CONCURRENT = 10;
const activeCounts = new Map<string, number>();

export async function runTaskSubAgent(
  deps: TaskToolDeps,
  args: { subagent_type: 'explore' | 'plan' | 'code' | 'review'; task: string },
): Promise<SubAgentResult> {
  const key = deps.threadId ?? deps.workspace;
  const activeCount = activeCounts.get(key) ?? 0;
  if (activeCount >= MAX_CONCURRENT) {
    const summary = `Maximum concurrent sub-agents (${MAX_CONCURRENT}) reached. Wait for running sub-agents to complete.`;
    return { ok: false, summary, error: summary, toolCallCount: 0, durationMs: 0 };
  }

  activeCounts.set(key, activeCount + 1);
  try {
    const baseRole = getRoleConfig(args.subagent_type);
    return await runSubAgent({
      config: deps.config,
      workspace: deps.workspace,
      role: {
        ...baseRole,
        ...(deps.allowedTools
          ? {
              allowedTools: new Set(
                [...deps.allowedTools].filter(
                  (toolName) => !baseRole.allowedTools || baseRole.allowedTools.has(toolName),
                ),
              ),
            }
          : {}),
      },
      task: args.task,
      shellExecutor: deps.shellExecutor,
      mcpManager: deps.mcpManager,
      skills: deps.skills,
      skillOptions: deps.skillOptions,
      mcpBindings: deps.mcpBindings,
      authorization: deps.authorization,
      workspaceAccess: deps.workspaceAccess,
      phase: deps.phase,
      threadId: deps.threadId,
      timeoutMs: 30 * 60 * 1000,
      signal: deps.signal ?? new AbortController().signal,
      eventSink: deps.eventSink,
      model: deps.model,
      depth: 1,
      maxDepth: deps.maxDepth ?? 0,
    });
  } finally {
    const next = (activeCounts.get(key) ?? 1) - 1;
    if (next > 0) activeCounts.set(key, next);
    else activeCounts.delete(key);
  }
}

export function createTaskTool(deps: TaskToolDeps) {
  return tool({
    description: [
      'Dispatch a specialized sub-agent to handle a standalone task in an isolated context window.',
      'Sub-agents have their own context; they CANNOT see the main conversation history.',
      'Use this to: run independent work in parallel, delegate well-scoped tasks, or keep the main conversation focused.',
      '',
      'When to use (prefer task over direct tool calls):',
      '- Searching for something across many files: use explore sub-agent instead of multiple greps/reads',
      '- Implementing a self-contained feature or fix: use code sub-agent with clear, specific instructions',
      '- Reviewing code for bugs or security issues: use review sub-agent for an impartial audit',
      '- Any task where the sub-agent can work independently without needing main conversation context',
      "- The user explicitly asks you to 'dispatch', 'delegate', or 'use a sub-agent'",
      '',
      'When NOT to use:',
      '- Simple single-file reads or single grep: use read_file or shell_execute directly',
      '- Tasks that depend on understanding the full conversation history',
      '',
      'Available types:',
      '- explore: Read-only search across the codebase. Best for: finding usages, tracing call chains, gathering evidence.',
      '- plan: Read-only architecture design. Best for: designing implementation approaches, evaluating trade-offs, proposing file structures.',
      '- code: Full read/write/execute. Best for: implementing features, fixing bugs, running tests.',
      '- review: Read-only critical review. Best for: security audit, code quality check, regression detection.',
      '',
      'If the sub-agent returns blocked.reasonCode=SUBAGENT_TOOL_REQUIRES_APPROVAL, do not retry task. The harness will resume the sub-agent after approval.',
      '',
      'Write self-contained instructions in the task field; include file paths, function names, and specific requirements.',
    ].join('\n'),
    inputSchema: zodSchema(
      z.object({
        subagent_type: z
          .enum(['explore', 'plan', 'code', 'review'])
          .describe('Type of sub-agent to invoke'),
        task: z
          .string()
          .min(1)
          .describe(
            'Self-contained task description with all necessary context. The sub-agent cannot see the main conversation.',
          ),
      }),
    ),
    execute: async ({ subagent_type, task }) => {
      const result = await runTaskSubAgent(deps, { subagent_type, task });
      return JSON.stringify(result);
    },
  });
}
