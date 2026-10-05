import type { McpSourceReadSet } from '../config/mcp-sources';

/** Original observation only. The producer verifies every identity against actual facts. */
export interface McpReconnectionTarget {
  carrierExecutionId: string;
  carrierKey: string;
  operationRef: {
    commandId: string;
    sessionId: string;
    originStoreId: string;
    extensionId: 'builtin.mcp';
    key: string;
    executionId: string;
  };
  connectionExecutionId: string;
  configDigest: string;
  currentGeneration: number;
}

/** Static registrations and current Source captures are separate closed branches. */
export type McpReconnectionReplacement =
  | { kind: 'static'; expectedConfigDigest: string }
  | {
      kind: 'source';
      expectedConfigDigest: string;
      expectedReadSet: McpSourceReadSet;
    };

export interface McpReconnectionInput {
  serverId: string;
  key: string;
  target: McpReconnectionTarget;
  replacement: McpReconnectionReplacement;
}
