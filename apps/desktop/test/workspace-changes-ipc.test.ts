import { expect, test } from '#kite-test';
import { decodeNativeRequest } from '../electron/native-ipc';
import { decodeNativeEvent } from '../src/native-bridge';

test('workspace Git IPC accepts only IDs and current generation/selection, never paths', () => {
  const list = {
    method: 'workspaceChanges.list',
    generation: 1,
    viewSelection: 1,
    readId: 'read',
  } as const;
  const detail = {
    method: 'workspaceChanges.detail',
    generation: 1,
    readId: 'read',
    changeId: 'change',
  } as const;
  for (const request of [
    list,
    detail,
    { method: 'workspaceChanges.close', generation: 1, readId: 'read' },
  ] as const)
    expect(decodeNativeRequest(request)).toEqual(request);
  for (const request of [
    { ...list, root: '/tmp' },
    { ...list, workspaceId: 'other' },
    { ...list, viewSelection: 0 },
    { ...list, readId: '../path' },
    { ...detail, changeId: '/tmp/file' },
    { ...detail, path: '/tmp/file' },
    { ...detail, generation: 0 },
  ])
    expect(() => decodeNativeRequest(request)).toThrow();
});

test('file snapshot detail accepts explicit diff or snapshot but no unknown view', () => {
  const detail = {
    method: 'fileChanges.detail',
    generation: 1,
    readId: 'read',
    changeId: 'change',
  } as const;
  for (const view of ['diff', 'snapshot'] as const)
    expect(decodeNativeRequest({ ...detail, view })).toEqual({ ...detail, view });
  expect(() => decodeNativeRequest({ ...detail, view: 'raw' })).toThrow();
});

test('workspace invalidation events are scoped and reject malformed or extra payload', () => {
  const event = {
    kind: 'workspaceChanges.changed',
    generation: 1,
    readId: 'read',
    scope: {
      generation: 1,
      viewSelection: 1,
      storeId: 'store',
      sessionId: 'session',
      workspaceId: 'workspace',
    },
  } as const;
  expect(decodeNativeEvent(event)).toEqual(event);
  for (const invalid of [
    { ...event, readId: '../file' },
    { ...event, root: '/private' },
    { ...event, generation: 2 },
    { ...event, scope: null },
    { ...event, scope: { ...event.scope, viewSelection: 0 } },
    { ...event, scope: { ...event.scope, sessionId: '' } },
    { ...event, scope: { ...event.scope, root: '/private' } },
  ])
    expect(decodeNativeEvent(invalid)).toBeUndefined();
});
