export const STATE_STATE_TOP_LEVEL_FIELDS_ = Object.freeze([
  'activeTaskId',
  'appliedEventIds',
  'autoReview',
  'capabilities',
  'completionGuard',
  'context',
  'doomLoop',
  'formatEpoch',
  'interactions',
  'lastAppliedEventId',
  'mode',
  'interactionModeRevision',
  'modelInvocations',
  'providerAdmission',
  'providerReadiness',
  'pendingApprovals',
  'activeApprovalId',
  'nextQueueSequence',
  'approvalGeneration',
  'sessionCommandGrants',
  'approvalReceipts',
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
 * RA-05 conformance mapping only. Production never opens or migrates an
 * older Session; this explicit mapping proves the State 27 target fields.
 */
export function mapHistoricalStateToState(input: {
  readonly state: Readonly<Record<string, unknown>>;
  readonly projectId: `project_${string}`;
  readonly canonicalWorkspaceDigest: `sha256:${string}`;
}): Readonly<Record<string, unknown>> {
  const allowed = new Set<string>(STATE_STATE_TOP_LEVEL_FIELDS_);
  if (
    input.state.schemaVersion !== 27 ||
    input.state.formatEpoch !== 'kite-runtime-saq-v1-2026-08-25' ||
    Object.keys(input.state).some((field) => !allowed.has(field)) ||
    !input.projectId.startsWith('project_') ||
    !/^sha256:[a-f0-9]{64}$/u.test(input.canonicalWorkspaceDigest)
  ) {
    throw new Error('Historical State mapping input is invalid.');
  }
  const session = input.state.session;
  if (!session || typeof session !== 'object' || Array.isArray(session)) {
    throw new Error('Historical State Session identity is invalid.');
  }
  return Object.freeze({
    ...structuredClone(input.state),
    schemaVersion: 27,
    formatEpoch: 'kite-runtime-saq-v2-2026-09-05',
    session: Object.freeze({
      ...(session as Readonly<Record<string, unknown>>),
      projectId: input.projectId,
      canonicalWorkspaceDigest: input.canonicalWorkspaceDigest,
    }),
  });
}
