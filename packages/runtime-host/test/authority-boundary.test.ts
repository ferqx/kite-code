import { describe, expect, test } from 'bun:test';
import { sealAuthorityFrameV1, verifyAuthorityFrameV1 } from '../src/authority-boundary';
import {
  createPosixAuthorityKeyPipeV1,
  readPosixAuthorityFrameKeyV1,
} from '../src/authority-key-bootstrap';

const key = { keyId: 'ephemeral:1', key: new Uint8Array(32).fill(9) };

describe('RAV1-02 invocation-local child frame boundary', () => {
  test('authenticates child frames and rejects replay/cross-invocation', () => {
    const frame = sealAuthorityFrameV1({
      schema: 'kite.runtime-authority-frame.v1',
      domain: 'sandbox-posix-v1',
      peerId: 'child:1',
      invocationId: 'i1',
      sequence: 1,
      payload: { status: 'attempted' },
      key,
    });
    expect(
      verifyAuthorityFrameV1({
        frame,
        key,
        expectedDomain: 'sandbox-posix-v1',
        expectedPeerId: 'child:1',
        expectedInvocationId: 'i1',
      }),
    ).toEqual({ status: 'attempted' });
    expect(() =>
      verifyAuthorityFrameV1({
        frame,
        key,
        expectedDomain: 'sandbox-posix-v1',
        expectedPeerId: 'child:1',
        expectedInvocationId: 'i1',
        lastSequence: 1,
      }),
    ).toThrow('replay');
    expect(() =>
      verifyAuthorityFrameV1({
        frame,
        key,
        expectedDomain: 'sandbox-posix-v1',
        expectedPeerId: 'child:1',
        expectedInvocationId: 'i2',
      }),
    ).toThrow('identity');
    expect(() =>
      verifyAuthorityFrameV1({
        frame: { ...frame, extra: true } as typeof frame,
        key,
        expectedDomain: 'sandbox-posix-v1',
        expectedPeerId: 'child:1',
        expectedInvocationId: 'i1',
      }),
    ).toThrow('identity');
  });

  test('round-trips serialized frames with ephemeral process-boundary material', () => {
    const frame = sealAuthorityFrameV1({
      schema: 'kite.runtime-authority-frame.v1',
      domain: 'sandbox-posix-v1',
      peerId: 'child:1',
      invocationId: 'i1',
      sequence: 0,
      payload: { status: 'ready' },
      key,
    });
    expect(
      verifyAuthorityFrameV1<{ status: string }>({
        frame: JSON.parse(JSON.stringify(frame)) as typeof frame,
        key,
        expectedDomain: 'sandbox-posix-v1',
        expectedPeerId: 'child:1',
        expectedInvocationId: 'i1',
      }),
    ).toEqual({ status: 'ready' });
  });

  test.skipIf(process.platform === 'win32')(
    'transfers only the bounded binary FD material record',
    () => {
      const pipe = createPosixAuthorityKeyPipeV1();
      pipe.write(key);
      pipe.closeWrite();
      const transferred = readPosixAuthorityFrameKeyV1(pipe.readFd);
      expect(transferred?.keyId).toBe(key.keyId);
      expect(Buffer.from(transferred?.key ?? [])).toEqual(Buffer.from(key.key));
    },
  );
});
