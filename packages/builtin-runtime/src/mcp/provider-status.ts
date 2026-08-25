import type { McpInventoryNextAction } from './inventory';
import type { McpProviderDirectoryStatus } from './runtime-provider';

export function isMcpProviderCallable(status: McpProviderDirectoryStatus): boolean {
  return status === 'ready' || status === 'degraded';
}

export function isMcpProviderUnavailable(status: McpProviderDirectoryStatus): boolean {
  return !isMcpProviderCallable(status);
}

export function isMcpProviderHealthy(status: McpProviderDirectoryStatus): boolean {
  return status === 'ready';
}

export function mcpProviderSearchNextAction(status: McpProviderDirectoryStatus): string {
  switch (status) {
    case 'pending_approval':
      return 'Complete the MCP project approval prompt.';
    case 'rejected':
      return 'Update the MCP project approval decision.';
    case 'disabled':
      return 'Enable the provider in MCP configuration.';
    case 'login_required':
      return 'Complete the MCP authentication prompt.';
    case 'connecting':
      return 'Wait for the provider to finish connecting.';
    case 'degraded':
    case 'failed':
      return 'Retry the provider connection outside the current tool call.';
    case 'quarantined':
      return 'Fix the MCP provider configuration or capability schema.';
    default:
      return '';
  }
}

export function mcpProviderInventoryNextAction(
  status: McpProviderDirectoryStatus,
): McpInventoryNextAction | undefined {
  switch (status) {
    case 'pending_approval':
      return 'approve_project_provider';
    case 'rejected':
      return 'review_project_approval';
    case 'disabled':
      return 'enable_provider';
    case 'login_required':
      return 'authenticate';
    case 'connecting':
      return 'wait_or_retry';
    case 'failed':
      return 'retry_connection';
    case 'degraded':
      return 'retry_if_needed';
    case 'quarantined':
      return 'fix_configuration_or_schema';
    default:
      return undefined;
  }
}
