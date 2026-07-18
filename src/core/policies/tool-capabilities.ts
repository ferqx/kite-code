// ── 工具能力分类 / Shared tool capability classification ──
// 所有运行时层都使用这份分类结果判断工具是否会越过 Plan 边界。

import { isReadOnlyShellCommand } from '@/core/tools/definitions';
import {
  isDestructiveShellCommand,
  isNetworkCommand,
  isVcsMutationCommand,
  isWriteLikeShellCommand,
} from './shell-classification';

export type ToolEffectClass =
  | 'read_only'
  | 'plan_only'
  | 'workspace_write'
  | 'external_side_effect'
  | 'unknown';

export interface ToolCapability {
  effectClass: ToolEffectClass;
  sideEffect: boolean;
  classificationReason: string;
}

const READ_ONLY_TOOLS = new Set([
  'read_file',
  'list_files',
  'search_content',
  'search_files',
  'capability_search',
  'list_mcp_resources',
  'read_mcp_resource',
  'web_fetch',
  'Skill',
  'ask_user',
]);

const PLAN_ONLY_TOOLS = new Set(['write_plan', 'update_plan']);

const READ_ONLY_SUBAGENTS = new Set(['explore', 'plan', 'review']);

/**
 * 对工具调用进行一次性能力分类。
 * Classify a tool call once so policy, reducer and model context share the same result.
 */
export function classifyToolCapability(toolName: string, args: unknown): ToolCapability {
  if (READ_ONLY_TOOLS.has(toolName)) {
    return {
      effectClass: 'read_only',
      sideEffect: false,
      classificationReason: `${toolName} is a read-only capability.`,
    };
  }

  if (PLAN_ONLY_TOOLS.has(toolName)) {
    return {
      effectClass: 'plan_only',
      sideEffect: false,
      classificationReason: `${toolName} changes runtime planning state only.`,
    };
  }

  if (toolName === 'task') {
    const subagentType =
      args && typeof args === 'object'
        ? (args as Record<string, unknown>).subagent_type
        : undefined;
    if (typeof subagentType === 'string' && READ_ONLY_SUBAGENTS.has(subagentType)) {
      return {
        effectClass: 'read_only',
        sideEffect: false,
        classificationReason: `${subagentType} sub-agent is read-only by role.`,
      };
    }
    return {
      effectClass: 'workspace_write',
      sideEffect: true,
      classificationReason: 'Implementation-capable or unknown sub-agent role.',
    };
  }

  if (toolName === 'shell_execute') {
    const command =
      args && typeof args === 'object'
        ? String((args as Record<string, unknown>).command ?? '')
        : '';
    if (isReadOnlyShellCommand(command)) {
      return {
        effectClass: 'read_only',
        sideEffect: false,
        classificationReason: 'Shell command matches the conservative read-only allowlist.',
      };
    }
    if (isNetworkCommand(command)) {
      return {
        effectClass: 'external_side_effect',
        sideEffect: true,
        classificationReason: 'Shell command may access the network.',
      };
    }
    if (
      isDestructiveShellCommand(command) ||
      isVcsMutationCommand(command) ||
      isWriteLikeShellCommand(command)
    ) {
      return {
        effectClass: 'workspace_write',
        sideEffect: true,
        classificationReason: 'Shell command may mutate files or version-control state.',
      };
    }
    return {
      effectClass: 'unknown',
      sideEffect: true,
      classificationReason: 'Shell command could not be proven read-only.',
    };
  }

  return {
    effectClass: 'unknown',
    sideEffect: true,
    classificationReason: `No safe capability classification exists for ${toolName}.`,
  };
}
