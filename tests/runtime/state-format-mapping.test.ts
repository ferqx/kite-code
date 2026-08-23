import { expect, test } from 'bun:test';
import { createRuntimeHostStateInitialState } from '@kite/runtime-host/kernel-adapter';
import {
  mapHistoricalStateToState,
  STATE_STATE_TOP_LEVEL_FIELDS_,
} from '../reliability-harness/runtime-authority/state-format-mapping';
import stateShape from '../reliability-harness/runtime-modularization/manifests/runtime-state-shape.generated.json';

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
  expect([...STATE_STATE_TOP_LEVEL_FIELDS_].map(String).sort()).toEqual(
    stateShape.facts.fields.map((field) => field.name).sort(),
  );
  expect(() =>
    mapHistoricalStateToState({
      state: { ...state, unknownAuthority: true },
      projectId,
      canonicalWorkspaceDigest,
    }),
  ).toThrow('invalid');
});
