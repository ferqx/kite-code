import type { Json, ToolContext, ToolResult } from '../extensions';
import type { McpHttpAuthRejection } from './index';

/** A real failed RPC may request information; the answer never grants another Tool call. */
export async function requestMcpProviderAction(
  input: {
    serverId: string;
    serverName: string;
    code: 'mcp_oauth_login_required' | 'mcp_oauth_reauth_required';
    rejection?: McpHttpAuthRejection['rejection'];
    login(context: ToolContext): Promise<Json>;
  },
  context: ToolContext,
): Promise<ToolResult> {
  const own = await context.getExecution(context.executionId);
  if (
    !own ||
    own.kind !== 'tool' ||
    own.sessionId !== context.sessionId ||
    !own.originStoreId ||
    typeof own.definitionId !== 'string' ||
    typeof own.definitionVersion !== 'string'
  )
    return {
      outcome: 'outcome_unknown',
      content: input.code,
      details: { adapterAttempted: true, remoteStopConfirmed: false },
    };
  const negative =
    input.rejection &&
    input.rejection.httpStatus === 401 &&
    input.rejection.rpcMethod === 'tools/call' &&
    input.rejection.originalStoreId === own.originStoreId &&
    input.rejection.sessionId === context.sessionId &&
    input.rejection.serverId === input.serverId;
  const answer = await context.requestInteraction({
    kind: 'question',
    request: {
      kind: 'mcp_provider_action',
      originalStoreId: own.originStoreId,
      sessionId: context.sessionId,
      serverId: input.serverId,
      serverName: input.serverName,
      sourceCode: input.code,
      failedTool: {
        executionId: own.id,
        definitionId: own.definitionId,
        definitionVersion: own.definitionVersion,
      },
      title: `MCP provider '${input.serverName}' requires login.`,
      schema: {
        title: `MCP provider '${input.serverName}' requires login.`,
        type: 'object',
        additionalProperties: false,
        required: ['action'],
        properties: {
          action: {
            title: 'Provider Action',
            oneOf: [
              {
                const: 'login',
                title: '1. Run login',
                description:
                  'Authenticate through the ordinary permission path; this failed call will not be replayed.',
              },
              {
                const: 'later',
                title: '2. Later',
                description: 'Continue with the original failed result without replaying the call.',
              },
            ],
          },
        },
      },
    },
  });
  const selected =
    answer && typeof answer === 'object' && !Array.isArray(answer) ? answer.action : undefined;
  let authentication: Json = null;
  if (selected === 'login') authentication = await input.login(context);
  else if (selected !== 'later' && answer !== null)
    throw Error('mcp_provider_action_answer_invalid');
  const details = {
    adapterAttempted: true,
    remoteStopConfirmed: false,
    providerAuthRequired: true,
    serverId: input.serverId,
    sourceCode: input.code,
    choice: selected ?? 'later',
    replayed: false,
    authentication,
    ...(negative ? { authorizationRejection: input.rejection! } : {}),
  };
  return {
    outcome: negative ? 'failed' : 'outcome_unknown',
    content: `provider_auth_required: ${input.code}`,
    details,
  };
}
