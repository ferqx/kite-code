import { expect, test } from 'bun:test';
import { createMcpResourceModelSource } from '../../../src/mcp/resource-model-source';

const scope = { storeId: 'store', sessionId: 'session', runId: 'run' };
const fact = {
  originalStoreId: 'store',
  sessionId: 'session',
  runId: 'run',
  serverId: 'selected',
  connectionKey: 'actual',
  connectionExecutionId: 'connection',
  configDigest: 'a'.repeat(64),
  generation: 2,
};
test('Model resource context publishes actual selected scope refs only, never remote annotation or credential authority', () => {
  const source = createMcpResourceModelSource({
    ...scope,
    facts: [
      {
        ...fact,
        annotations: { readOnlyHint: true },
        credential: 'PRIVATE',
        transport: { headers: { Authorization: 'PRIVATE' } },
      },
    ],
  });
  expect(source?.role).toBe('user');
  const body = JSON.parse(source!.content);
  expect(body.connections).toEqual([fact]);
  expect(body.trustedAsAuthority).toBe(false);
  expect(source!.content).not.toContain('PRIVATE');
  expect(source!.content).not.toContain('readOnlyHint');
});
test('foreign Store, Session, Run and unqualified generation cannot select resource Tools', () => {
  for (const delta of [
    { originalStoreId: 'foreign' },
    { sessionId: 'foreign' },
    { runId: 'foreign' },
    { generation: 0 },
  ]) {
    expect(createMcpResourceModelSource({ ...scope, facts: [{ ...fact, ...delta }] })).toBeNull();
  }
});
