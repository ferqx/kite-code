import { describe, expect, test } from 'bun:test';
import {
  createRuntimeControlFrame,
  verifyRuntimeControlFrame,
} from '../src/kernel-adapter/control-frame';

describe('process control frame boundary', () => {
  test('binds peer, invocation, exact shape, and monotonic sequence', () => {
    const frame = createRuntimeControlFrame({
      schema: 'kite.runtime-control-frame.v1',
      domain: 'sandbox-posix-v1',
      peerId: 'child:1',
      invocationId: 'i1',
      sequence: 1,
      payload: { status: 'attempted' },
    });
    expect(
      verifyRuntimeControlFrame({
        frame,
        expectedDomain: 'sandbox-posix-v1',
        expectedPeerId: 'child:1',
        expectedInvocationId: 'i1',
      }),
    ).toEqual({ status: 'attempted' });
    expect(() =>
      verifyRuntimeControlFrame({
        frame,
        expectedDomain: 'sandbox-posix-v1',
        expectedPeerId: 'child:1',
        expectedInvocationId: 'i1',
        lastSequence: 1,
      }),
    ).toThrow('replay');
    expect(() =>
      verifyRuntimeControlFrame({
        frame: { ...frame, extra: true } as typeof frame,
        expectedDomain: 'sandbox-posix-v1',
        expectedPeerId: 'child:1',
        expectedInvocationId: 'i1',
      }),
    ).toThrow('identity');
  });
});
