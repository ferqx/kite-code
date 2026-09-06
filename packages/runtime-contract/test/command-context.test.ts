import { describe, expect, test } from 'bun:test';
import {
  freezeRuntimeCommandContext,
  isRuntimeCommandContext,
  type RuntimeCommandContext,
} from '../src';

const valid: RuntimeCommandContext = {
  schema: 'kite.runtime-command-context.v1',
  connectionId: 'connection-1',
  requestId: 'request-1',
  bindingReference: 'binding-1',
  clientInfo: { name: 'test', version: '1', instanceId: 'client-1' },
};

describe('in-process RuntimeCommandContext', () => {
  test('accepts and freezes the admission context without changing its shape', () => {
    const pinned = freezeRuntimeCommandContext(valid);
    expect(isRuntimeCommandContext(pinned)).toBeTrue();
    expect(Object.isFrozen(pinned)).toBeTrue();
    expect(Object.isFrozen(pinned.clientInfo)).toBeTrue();
    expect(pinned).toEqual(valid);
  });

  test('rejects malformed identity and binding references', () => {
    expect(isRuntimeCommandContext({ ...valid, connectionId: '' })).toBeFalse();
    expect(isRuntimeCommandContext({ ...valid, requestId: '\u0000' })).toBeFalse();
    expect(isRuntimeCommandContext({ ...valid, bindingReference: '' })).toBeFalse();
    expect(isRuntimeCommandContext({ ...valid, bindingReference: null })).toBeTrue();
    expect(() => freezeRuntimeCommandContext({ ...valid, bindingReference: '' })).toThrow(
      'Invalid RuntimeCommandContext',
    );
  });
});
