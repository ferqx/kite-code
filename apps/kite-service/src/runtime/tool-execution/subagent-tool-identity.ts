import { digestCapabilityValue } from '@kite-ai/builtin-runtime/capability';

/** Stable identity shared by live child execution and bounded history replay. */
export function childRuntimeToolCallId(input: {
  parentToolCallId: string;
  subagentId: string;
  modelInvocationId: string;
  modelToolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
}): string {
  return `subagent-tool:${digestCapabilityValue({
    schema: 'kite.subagent-runtime-tool-identity.v1',
    parentToolCallId: input.parentToolCallId,
    subagentId: input.subagentId,
    modelInvocationId: input.modelInvocationId,
    modelToolCallId: input.modelToolCallId,
    toolName: input.toolName,
    arguments: input.args,
  })}`;
}
