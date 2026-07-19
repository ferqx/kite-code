/**
 * Shared MCP provider status predicates and action mapping.
 *
 * Centralizes the definition of "callable", "unavailable", and "healthy"
 * so that inventory, search, tool controller, and the TUI panel all use
 * a single source of truth.
 */

import type { McpProviderDirectoryStatus } from '@/core/mcp/runtime-provider';

export function isProviderCallable(status: McpProviderDirectoryStatus): boolean {
  return status === 'ready' || status === 'degraded';
}

export function isProviderUnavailable(status: McpProviderDirectoryStatus): boolean {
  return !isProviderCallable(status);
}

export function isProviderHealthy(status: McpProviderDirectoryStatus): boolean {
  return status === 'ready';
}

/** Model-visible next-action text for tool_search provider diagnostics. */
export function providerSearchNextAction(status: McpProviderDirectoryStatus): string {
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

/** Machine-action identifier for list_mcp_tools provider summaries. */
export function providerInventoryNextAction(
  status: McpProviderDirectoryStatus,
): import('@/core/mcp/inventory').McpInventoryNextAction | undefined {
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
