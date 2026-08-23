import { describe, expect, test } from 'bun:test';
import { createRuntimeControlFrameV1, verifyRuntimeControlFrameV1 } from '../src/control-frame';

describe('process control frame boundary', () => {
  test('binds peer, invocation, exact shape, and monotonic sequence', () => {
    const frame = createRuntimeControlFrameV1({
      schema: 'kite.runtime-control-frame.v1',
      domain: 'sandbox-posix-v1',
      peerId: 'child:1',
      invocationId: 'i1',
      sequence: 1,
      payload: { status: 'attempted' },
    });
    expect(
      verifyRuntimeControlFrameV1({
        frame,
        expectedDomain: 'sandbox-posix-v1',
        expectedPeerId: 'child:1',
        expectedInvocationId: 'i1',
      }),
    ).toEqual({ status: 'attempted' });
    expect(() =>
      verifyRuntimeControlFrameV1({
        frame,
        expectedDomain: 'sandbox-posix-v1',
        expectedPeerId: 'child:1',
        expectedInvocationId: 'i1',
        lastSequence: 1,
      }),
    ).toThrow('replay');
    expect(() =>
      verifyRuntimeControlFrameV1({
        frame: { ...frame, extra: true } as typeof frame,
        expectedDomain: 'sandbox-posix-v1',
        expectedPeerId: 'child:1',
        expectedInvocationId: 'i1',
      }),
    ).toThrow('identity');
  });
});
