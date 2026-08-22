import { expect, test } from 'bun:test';
import { createRuntimeHostState26InitialStateV1 } from '@kite/runtime-host';
import {
  mapHistoricalState26ToState26V1,
  STATE26_STATE26_TOP_LEVEL_FIELDS_V1,
} from '../reliability-harness/runtime-authority/state26-format-mapping';
import stateShape from '../reliability-harness/runtime-modularization/manifests/runtime-state-shape.generated.json';

test('RAV1-05 maps every State26 field into the exact State26 target without a production decoder', () => {
  const projectId = 'project_mapping_fixture' as const;
  const canonicalWorkspaceDigest = `sha256:${'1'.repeat(64)}` as const;
  const target = createRuntimeHostState26InitialStateV1({
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
    ...state26Session
  } = target.session;
  const state26 = {
    ...target,
    schemaVersion: 25,
    formatEpoch: 'kite-runtime-2026-08-18',
    session: state26Session,
  };
  const mapped = mapHistoricalState26ToState26V1({
    state26,
    projectId,
    canonicalWorkspaceDigest,
  });

  expect(mapped).toEqual(target);
  expect([...STATE26_STATE26_TOP_LEVEL_FIELDS_V1].map(String).sort()).toEqual(
    stateShape.facts.fields.map((field) => field.name).sort(),
  );
  expect(() =>
    mapHistoricalState26ToState26V1({
      state26: { ...state26, unknownAuthority: true },
      projectId,
      canonicalWorkspaceDigest,
    }),
  ).toThrow('invalid');
});
