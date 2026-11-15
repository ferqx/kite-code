import type { CapabilityDescription } from '@kite-ai/agent/permissions';

/** Applied only after actual MCP ownership/registration is resolved by the host. */
export function mcpToolPermissionDescription(
  description: CapabilityDescription,
): CapabilityDescription {
  // Connection Jobs and settings management retain their existing authority.
  if (description.kind !== 'tool') return description;
  return {
    ...description,
    revision: `${description.revision}:mcp-tool-review`,
    // Even read-only catalogue calls are tools. Remote annotations never grant
    // workspace/Auto exemptions; Full is still constrained by the parent policy.
    effects: description.effects.some((effect) => effect !== 'read' && effect !== 'workspace_write')
      ? description.effects
      : [...description.effects, 'external'],
    safeRead: false,
    autoReview: undefined,
    autoTimeoutScope: 'stop',
  };
}
