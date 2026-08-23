import { expect, test } from 'bun:test';
import { createRuntimeHostStateInitialStateV1 } from '@kite/runtime-host';
import {
  mapHistoricalStateToStateV1,
  STATE26_STATE26_TOP_LEVEL_FIELDS_V1,
} from '../reliability-harness/runtime-authority/state-format-mapping';
import stateShape from '../reliability-harness/runtime-modularization/manifests/runtime-state-shape.generated.json';

test('RAV1-05 maps every State field into the exact State target without a production decoder', () => {
  const projectId = 'project_mapping_fixture' as const;
  const canonicalWorkspaceDigest = `sha256:${'1'.repeat(64)}` as const;
  const target = createRuntimeHostStateInitialStateV1({
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
  const mapped = mapHistoricalStateToStateV1({
    state,
    projectId,
    canonicalWorkspaceDigest,
  });

  expect(mapped).toEqual(target);
  expect([...STATE26_STATE26_TOP_LEVEL_FIELDS_V1].map(String).sort()).toEqual(
    stateShape.facts.fields.map((field) => field.name).sort(),
  );
  expect(() =>
    mapHistoricalStateToStateV1({
      state: { ...state, unknownAuthority: true },
      projectId,
      canonicalWorkspaceDigest,
    }),
  ).toThrow('invalid');
});
