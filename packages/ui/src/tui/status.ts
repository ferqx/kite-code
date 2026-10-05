import type { HostStatus } from '@kite-ai/client';

/** Host-local connection mode and profile name; credentials and endpoint never enter UI state. */
export interface TuiStatusPort {
  readonly mode: 'paired' | 'shared';
  readonly profile: string;
  read(sessionId: string, workspaceId: string, signal: AbortSignal): Promise<HostStatus>;
}
export interface TuiStatusSnapshot {
  readonly facts?: HostStatus;
  readonly connection: 'checking' | 'verified' | 'unknown';
  readonly error?: string;
}
