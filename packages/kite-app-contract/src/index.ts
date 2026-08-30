/**
 * Browser-safe, repository-private App Control contract.
 *
 * This package contains only the exact no-secret DTOs needed by the current
 * CLI/TUI journeys.  Runtime I/O, local process state, credentials, and UI
 * component types belong to other owners and are deliberately absent here.
 */

export const KITE_APP_CONTRACT_REVISION_ = 'kite-app-contract-v1' as const;

export * from './client';
export * from './mcp';
export * from './provider-model';
export * from './skills';
export * from './status';
export * from './validation';
export * from './web';
export * from './workspace-trust';
