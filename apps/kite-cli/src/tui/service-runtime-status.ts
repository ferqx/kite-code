export interface ServiceRuntimePresentation {
  readonly pid: number;
  readonly startedAt: string;
  readonly buildId: string;
  readonly expectedBuildId?: string;
}

export interface ServiceRuntimeStatusLabels {
  readonly pid: string;
  readonly startedAt: string;
  readonly buildId: string;
  readonly expectedBuildId: string;
  readonly driftWarning: string;
}

export function hasServiceBuildDrift(service: ServiceRuntimePresentation): boolean {
  return service.expectedBuildId !== undefined && service.expectedBuildId !== service.buildId;
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
  if (hasServiceBuildDrift(service)) {
    lines.push(`     ${labels.driftWarning}`);
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
