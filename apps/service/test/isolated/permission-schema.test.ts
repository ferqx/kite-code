import { expect, test } from 'bun:test';
import { schemas } from '../../src/http/schema';
import { HostStatusSchema } from '../../src/http/schema/host-status';

test('authoritative permission request, state and host-status schemas admit exactly the three confirmed strategies', () => {
  const request = {
    expectedStoreId: 'store',
    commandId: 'mode',
    ifRevision: '0',
    makeDefault: false,
    ifDefaultRevision: '0',
  };
  const state = {
    storeId: 'store',
    sessionId: 'session',
    scopeSessionId: 'session',
    revision: '0',
    defaultRevision: '0',
  };
  const hostMode = HostStatusSchema.shape.execution.shape.permissions.shape.mode;
  const hostDefault = HostStatusSchema.shape.execution.shape.permissions.shape.defaultMode;
  for (const mode of ['accept_edits', 'auto', 'full'] as const) {
    expect(schemas.SetPermissionModeRequest.parse({ ...request, mode }).mode).toBe(mode);
    expect(schemas.PermissionModeState.parse({ ...state, mode, defaultMode: mode }).mode).toBe(
      mode,
    );
    expect(hostMode.parse(mode)).toBe(mode);
    expect(hostDefault.parse(mode)).toBe(mode);
  }
  expect(schemas.SetPermissionModeRequest.safeParse({ ...request, mode: 'ask' }).success).toBe(
    false,
  );
  expect(
    schemas.PermissionModeState.safeParse({ ...state, mode: 'ask', defaultMode: 'accept_edits' })
      .success,
  ).toBe(false);
  expect(
    schemas.PermissionModeState.safeParse({ ...state, mode: 'accept_edits', defaultMode: 'ask' })
      .success,
  ).toBe(false);
  expect(hostMode.safeParse('ask').success).toBe(false);
  expect(hostDefault.safeParse('ask').success).toBe(false);
  expect(hostMode.parse(null)).toBeNull();
  expect(hostDefault.parse(null)).toBeNull();
});
