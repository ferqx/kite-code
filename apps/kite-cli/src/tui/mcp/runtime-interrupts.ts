import type { UserInputPayload } from '@kite-ai/runtime-contract';

type McpProviderRecoveryAction = 'login' | 'approve' | 'retry';
type McpProviderDirectoryStatus =
  | 'pending_approval'
  | 'rejected'
  | 'disabled'
  | 'login_required'
  | 'connecting'
  | 'ready'
  | 'degraded'
  | 'failed'
  | 'quarantined';

export function providerActionInput(
  providerId: string,
  action: McpProviderRecoveryAction,
): UserInputPayload {
  return {
    question: `MCP provider '${providerId}' requires ${action}.`,
    options: [
      {
        id: 'recover',
        label: `Run ${action}`,
        description: 'Perform the provider recovery action, then continue on a new turn.',
      },
      {
        id: 'defer',
        label: 'Later',
        description: 'Keep the failed Tool Call terminal and continue without recovery.',
      },
    ],
    allow_free_text: false,
    recommended: 'recover',
    context: `mcp-provider-action:${providerId}`,
  };
}

export function providerAdmissionInput(
  providerId: string,
  providerStatus: McpProviderDirectoryStatus,
  retryable: boolean,
): UserInputPayload {
  return {
    question: `Required MCP provider '${providerId}' is ${providerStatus}.`,
    options: [
      ...(retryable
        ? [
            {
              id: 'retry',
              label: 'Retry',
              description: 'Retry the provider connection before starting the model.',
            },
          ]
        : []),
      {
        id: 'waive',
        label: 'Session Waive',
        description: 'Continue this session while the provider capabilities remain hidden.',
      },
      {
        id: 'cancel',
        label: 'Cancel Run',
        description: 'Cancel this task without calling the model.',
      },
    ],
    allow_free_text: false,
    recommended: retryable ? 'retry' : 'waive',
    context: `mcp-provider-admission:${providerId}`,
  };
}
