import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { compileCapabilitySchema } from '@/core/capabilities/schema';
import { classifyFailure } from '@/core/runtime/failures';
import type { CapabilityResult } from '@/protocol/capabilities';

/** Convert an MCP protocol result without flattening its content blocks. */
export function normalizeMcpToolResult(
  result: CallToolResult,
  outputSchema?: Record<string, unknown>,
): CapabilityResult {
  const normalized: CapabilityResult = {
    status: result.isError ? 'error' : 'success',
    content: result.content.map((content) => content as Record<string, unknown>),
    ...(result.structuredContent === undefined
      ? {}
      : { structuredContent: result.structuredContent }),
  };
  if (!outputSchema || result.structuredContent === undefined) return normalized;

  const compiled = compileCapabilitySchema(outputSchema);
  if (!compiled.ok || !compiled.compiled.validate(result.structuredContent)) {
    return {
      ...normalized,
      status: 'partial',
      error: classifyFailure(
        'tool_invalid_args',
        compiled.ok
          ? 'MCP structuredContent does not match the advertised outputSchema.'
          : `MCP outputSchema is unsupported: ${compiled.diagnostic}`,
      ),
    };
  }
  return normalized;
}
