import { createPermissionManagement } from '../../src/permission-management';

/** Explicit trusted test setup through the same durable controls used by ordinary clients. */
export async function initializeLivePermissionFixture(
  input: Parameters<typeof createPermissionManagement>[0] & {
    expectedStoreId: string;
    subjectId: string;
    sessionId: string;
    workspaceId: string;
    mode: 'accept_edits' | 'auto' | 'full';
    trusted?: boolean;
  },
) {
  const control = createPermissionManagement(input);
  const identity = { expectedStoreId: input.expectedStoreId, subjectId: input.subjectId };
  const state = await control.readMode({ ...identity, sessionId: input.sessionId });
  await control.setMode({
    ...identity,
    commandId: `fixture-mode-${input.sessionId}-${state.revision}-${input.mode}`,
    sessionId: input.sessionId,
    mode: input.mode,
    makeDefault: false,
    ifRevision: state.revision,
    ifDefaultRevision: state.defaultRevision,
  });
  if (input.trusted !== undefined) {
    const trust = await control.readTrust({ ...identity, workspaceId: input.workspaceId });
    await control.setTrust({
      ...identity,
      workspaceId: input.workspaceId,
      commandId: `fixture-trust-${input.workspaceId}-${trust.revision}-${input.trusted}`,
      trusted: input.trusted,
      ifRevision: trust.revision,
      canonicalIdentity: trust.canonicalIdentity,
      externalReadScopeDigest: trust.externalReadScopeDigest,
    });
  }
}
