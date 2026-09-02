export interface AppServerRuntimePresentation {
  readonly transport: 'stdio' | 'unix' | 'named_pipe';
  readonly mode: 'source' | 'installed';
  readonly buildId: string;
  readonly serverVersion: string;
  readonly clientVersion?: string;
  readonly pairing: 'same_build' | 'exact_protocol';
}

export interface AppServerRuntimeStatusLabels {
  readonly transport: string;
  readonly mode: string;
  readonly buildId: string;
  readonly serverVersion: string;
  readonly clientVersion: string;
  readonly paired: string;
  readonly protocolCompatible: string;
}

export function formatAppServerRuntimeStatus(
  server: AppServerRuntimePresentation,
  labels: AppServerRuntimeStatusLabels,
): string {
  const lines = [
    `  ⎿  ${labels.transport}: ${server.transport}`,
    `     ${labels.mode}: ${server.mode}`,
    `     ${labels.buildId}: ${server.buildId}`,
    `     ${labels.serverVersion}: ${server.serverVersion}`,
  ];
  if (server.clientVersion !== undefined) {
    lines.push(`     ${labels.clientVersion}: ${server.clientVersion}`);
  }
  lines.push(`     ${server.pairing === 'same_build' ? labels.paired : labels.protocolCompatible}`);
  return lines.join('\n');
}
