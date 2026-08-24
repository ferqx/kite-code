import { expect, test } from 'bun:test';
import { createRuntimeHostStateInitialState } from '@kite/runtime-host/kernel-adapter';
import {
  mapHistoricalStateToState,
  STATE_STATE_TOP_LEVEL_FIELDS_,
} from '../reliability-harness/runtime-authority/state-format-mapping';

test('RA-05 maps every State field into the exact State target without a production decoder', () => {
  const projectId = 'project_mapping_fixture' as const;
  const canonicalWorkspaceDigest = `sha256:${'1'.repeat(64)}` as const;
  const target = createRuntimeHostStateInitialState({
    threadId: 'mapping-session',
    userId: 'mapping-user',
    workspace: '/workspace',
    projectId,
    canonicalWorkspaceDigest,
    recoveryIdentityKey: 'a'.repeat(64),
  });
  const {
    projectId: _projectId,
    canonicalWorkspaceDigest: _workspaceDigest,
    ...stateSession
  } = target.session;
  const state = {
    ...target,
    schemaVersion: 25,
    formatEpoch: 'kite-runtime-2026-08-18',
    session: stateSession,
  };
  const mapped = mapHistoricalStateToState({
    state,
    projectId,
    canonicalWorkspaceDigest,
  });

  expect(mapped).toEqual(target);
  const initialStateFields = new Set(Object.keys(target));
  const omittedOptionalFields = [...STATE_STATE_TOP_LEVEL_FIELDS_]
    .map(String)
    .filter((field) => !initialStateFields.has(field))
    .sort();
  expect(omittedOptionalFields).toEqual(['lastAppliedEventId', 'terminalOutcome']);
  expect(() =>
    mapHistoricalStateToState({
      state: { ...state, unknownAuthority: true },
      projectId,
      canonicalWorkspaceDigest,
    }),
  ).toThrow('invalid');
});
