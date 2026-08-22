export const STATE26_STATE26_TOP_LEVEL_FIELDS_V1 = Object.freeze([
  'activeTaskId',
  'appliedEventIds',
  'authorization',
  'autoReview',
  'capabilities',
  'completionGuard',
  'context',
  'doomLoop',
  'formatEpoch',
  'interactions',
  'lastAppliedEventId',
  'mode',
  'modelInvocations',
  'providerAdmission',
  'providerReadiness',
  'recoveryState',
  'resourceBudget',
  'revision',
  'schemaVersion',
  'session',
  'skills',
  'suspendedSubagents',
  'tasks',
  'terminalOutcome',
  'toolRecovery',
  'tools',
  'transcript',
  'turn',
  'verification',
  'workspaceAccess',
] as const);

/**
 * RAV1-05 conformance mapping only. Production never opens or migrates a
 * Store4 Session; this explicit mapping proves the target field decision.
 */
export function mapHistoricalState26ToState26V1(input: {
  readonly state26: Readonly<Record<string, unknown>>;
  readonly projectId: `project_${string}`;
  readonly canonicalWorkspaceDigest: `sha256:${string}`;
}): Readonly<Record<string, unknown>> {
  const allowed = new Set<string>(STATE26_STATE26_TOP_LEVEL_FIELDS_V1);
  if (
    input.state26.schemaVersion !== 25 ||
    input.state26.formatEpoch !== 'kite-runtime-2026-08-18' ||
    Object.keys(input.state26).some((field) => !allowed.has(field)) ||
    !input.projectId.startsWith('project_') ||
    !/^sha256:[a-f0-9]{64}$/u.test(input.canonicalWorkspaceDigest)
  ) {
    throw new Error('Historical State26 mapping input is invalid.');
  }
  const session = input.state26.session;
  if (!session || typeof session !== 'object' || Array.isArray(session)) {
    throw new Error('Historical State26 Session identity is invalid.');
  }
  return Object.freeze({
    ...structuredClone(input.state26),
    schemaVersion: 26,
    formatEpoch: 'kite-runtime-modularization-v1-2026-08-19',
    session: Object.freeze({
      ...(session as Readonly<Record<string, unknown>>),
      projectId: input.projectId,
      canonicalWorkspaceDigest: input.canonicalWorkspaceDigest,
    }),
  });
}
