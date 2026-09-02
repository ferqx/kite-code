export interface ServiceRuntimePresentation {
  readonly pid: number;
  readonly startedAt: string;
  readonly buildId: string;
  readonly serviceVersion?: string;
  readonly clientVersion?: string;
  readonly expectedBuildId?: string;
}

export interface AppServerRuntimePresentation {
  readonly transport: 'stdio';
  readonly mode: 'source' | 'installed';
  readonly buildId: string;
  readonly serverVersion: string;
  readonly clientVersion?: string;
}

export interface AppServerRuntimeStatusLabels {
  readonly transport: string;
  readonly mode: string;
  readonly buildId: string;
  readonly serverVersion: string;
  readonly clientVersion: string;
  readonly paired: string;
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
  lines.push(`     ${labels.paired}`);
  return lines.join('\n');
}

export interface ServiceRuntimeStatusLabels {
  readonly pid: string;
  readonly startedAt: string;
  readonly buildId: string;
  readonly serviceVersion: string;
  readonly clientVersion: string;
  readonly expectedBuildId: string;
  readonly versionStatus: string;
  readonly aligned: string;
  readonly sourceBuildDrift: string;
  readonly buildMismatch: string;
}

export type ServiceRuntimeVersionStatus =
  | 'aligned'
  | 'source_build_drift'
  | 'build_mismatch'
  | 'unknown';

export function serviceRuntimeVersionStatus(
  service: ServiceRuntimePresentation,
): ServiceRuntimeVersionStatus {
  if (service.expectedBuildId === undefined) return 'unknown';
  if (service.expectedBuildId === service.buildId) return 'aligned';
  if (service.expectedBuildId.startsWith('dev:') && service.buildId.startsWith('dev:')) {
    return 'source_build_drift';
  }
  return 'build_mismatch';
}

export function hasServiceBuildDrift(service: ServiceRuntimePresentation): boolean {
  return serviceRuntimeVersionStatus(service) === 'source_build_drift';
}

export function formatServiceRuntimeStatus(
  service: ServiceRuntimePresentation,
  labels: ServiceRuntimeStatusLabels,
): string {
  const lines = [
    `  ⎿  ${labels.pid}: ${service.pid}`,
    `     ${labels.startedAt}: ${service.startedAt}`,
    `     ${labels.buildId}: ${service.buildId}`,
  ];
  if (service.expectedBuildId !== undefined) {
    lines.push(`     ${labels.expectedBuildId}: ${service.expectedBuildId}`);
  }
  if (service.clientVersion !== undefined) {
    lines.push(`     ${labels.clientVersion}: ${service.clientVersion}`);
  }
  if (service.serviceVersion !== undefined) {
    lines.push(`     ${labels.serviceVersion}: ${service.serviceVersion}`);
  }
  const status = serviceRuntimeVersionStatus(service);
  if (status !== 'unknown') {
    const value =
      status === 'aligned'
        ? labels.aligned
        : status === 'source_build_drift'
          ? labels.sourceBuildDrift
          : labels.buildMismatch;
    lines.push(`     ${labels.versionStatus}: ${value}`);
  }
  return lines.join('\n');
}

export function formatServiceBuildDriftWarning(
  service: ServiceRuntimePresentation,
  warning: string,
): string | null {
  if (!hasServiceBuildDrift(service)) return null;
  return `  ⎿  ${warning}`;
}
