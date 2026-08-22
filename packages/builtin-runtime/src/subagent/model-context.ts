import { resolve } from 'node:path';
import {
  type BaseMessage,
  buildCacheableRuntimeContext,
  formatProjectInstructionSnapshot,
  humanMessage,
  type ProjectInstructionSnapshot,
  resolveProjectInstructionSnapshot,
  systemMessage,
} from '../model';

export interface BuiltinSubagentModelContextInputV1 {
  readonly workspace: string;
  readonly task: string;
  readonly role: 'explore' | 'plan' | 'code' | 'review';
  readonly systemPrompt: string;
  readonly promptContractV2: boolean;
  readonly projectInstructions?: ProjectInstructionSnapshot;
  readonly skills?: readonly Readonly<{ name: string; description: string }>[];
}

export interface BuiltinSubagentModelContextV1 {
  readonly workspace: string;
  readonly projectInstructions?: ProjectInstructionSnapshot;
  readonly messages: readonly BaseMessage[];
}

/**
 * Build the exact child Context/Prompt projection owned by Builtin Runtime.
 * The caller supplies only canonical App facts; the result carries no Runtime
 * State, Store, Kernel, Gateway, registry, or execution authority.
 */
export function createBuiltinSubagentModelContextV1(
  input: BuiltinSubagentModelContextInputV1,
): BuiltinSubagentModelContextV1 {
  const workspace = resolve(input.workspace);
  const cacheableRuntimeContext = buildCacheableRuntimeContext({ workspace });
  const taskWithCwd = `<runtime-state source="harness.subagent">
CWD: ${workspace}
</runtime-state>

${input.task}`;

  let systemPrompt = input.systemPrompt;
  if (input.role === 'code' && input.skills && input.skills.length > 0) {
    systemPrompt += [
      '',
      '## Available Skills',
      'Use activate_skill only for a disclosed matching workflow; use read_skill_reference and complete_skill for its lifecycle.',
      ...input.skills.map((skill) => `- ${skill.name}: ${skill.description}`),
    ].join('\n');
  }
  systemPrompt += `\n\n${cacheableRuntimeContext}`;

  const projectInstructions = input.promptContractV2
    ? (input.projectInstructions ?? resolveProjectInstructionSnapshot({ workspace }))
    : undefined;
  const messages: BaseMessage[] = [systemMessage(systemPrompt), humanMessage(taskWithCwd)];
  if (
    projectInstructions &&
    (projectInstructions.documents.length > 0 || projectInstructions.warnings.length > 0)
  ) {
    messages.push(humanMessage(formatProjectInstructionSnapshot(projectInstructions)));
  }

  return Object.freeze({
    workspace,
    ...(projectInstructions ? { projectInstructions } : {}),
    messages: Object.freeze(messages),
  });
}
