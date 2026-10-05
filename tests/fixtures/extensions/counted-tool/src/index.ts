import { appendFileSync } from 'node:fs';
import {
  defineExtension,
  type Json,
  type ToolContext,
  type ToolResult,
} from '@kite-ai/agent/extensions';

/** The ledger belongs to the test environment, outside recoverable profile data. */
export function countedTool(ledgerPath: string) {
  return defineExtension({
    id: 'fixture.counted',
    version: '1.0.0',
    apiMajor: 1,
    tools: [
      {
        id: 'fixture.count',
        version: '1.0.0',
        description: 'Append one harmless invocation to the external test ledger.',
        inputSchema: {
          type: 'object',
          properties: { value: { type: 'string' }, fail: { type: 'boolean' } },
          required: ['value'],
          additionalProperties: false,
        },
        async execute(input: Json, context: ToolContext): Promise<ToolResult> {
          context.signal.throwIfAborted();
          appendFileSync(
            ledgerPath,
            `${JSON.stringify({
              sessionId: context.sessionId,
              runId: context.runId,
              executionId: context.executionId,
              input,
            })}\n`,
            { mode: 0o600 },
          );
          const argumentsObject = input as { value: string; fail?: boolean };
          if (argumentsObject.fail)
            return {
              outcome: 'failed',
              content: 'Known fixture failure',
              details: { value: argumentsObject.value },
            };
          return {
            outcome: 'succeeded',
            content: `counted:${argumentsObject.value}`,
            details: { value: argumentsObject.value },
          };
        },
      },
    ],
  });
}
