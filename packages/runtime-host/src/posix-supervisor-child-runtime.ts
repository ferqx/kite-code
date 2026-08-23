import { connect } from 'node:net';
import type { RuntimeControlFrameV1 } from '@kite/runtime-spi';
import { createRuntimeControlFrameV1, verifyRuntimeControlFrameV1 } from './control-frame';
import {
  readComparablePosixProcessStartIdentityV1,
  writePosixSupervisorIdentityV1,
} from './posix-supervisor-identity';
import { verifyInheritedPosixSupervisorLockV1 } from './posix-supervisor-lock';
import { spawnRuntimeHostProcessV1 } from './process-spawn';

const POSIX_CONTROL_FRAME_DOMAIN_V1 = 'sandbox-posix-v1';
const POSIX_HOST_PEER_ID_V1 = 'runtime-host';
const POSIX_CHILD_PEER_ID_V1 = 'posix-supervisor-child';
const RUNTIME_CONTROL_FRAME_SCHEMA_V1 = 'kite.runtime-control-frame.v1' as const;

/** Internal Runtime mode embedded in release executables; never accepts an unvalidated command directly. */
export function runPosixSupervisorChildV1(args: readonly string[]): void {
  const [
    socketPath = '',
    identityPath = '',
    controlRoot = '',
    dataRoot = '',
    dispatchId = '',
    supervisorNonce = '',
    dispatchIntentDigest = '',
  ] = args;
  if (
    !socketPath ||
    !identityPath ||
    !controlRoot ||
    !dataRoot ||
    controlRoot === dataRoot ||
    !dispatchId ||
    !supervisorNonce ||
    !dispatchIntentDigest ||
    process.platform === 'win32'
  ) {
    process.exit(125);
  }
  if (
    !verifyInheritedPosixSupervisorLockV1(3, controlRoot, {
      version: 1,
      dispatchId,
      supervisorNonce,
      dispatchIntentDigest,
    })
  ) {
    process.exit(125);
  }
  const processStartIdentity = readComparablePosixProcessStartIdentityV1(process.pid);
  if (!processStartIdentity) process.exit(125);
  writePosixSupervisorIdentityV1(identityPath, {
    version: 1,
    dispatchId,
    supervisorNonce,
    dispatchIntentDigest,
    pid: process.pid,
    processGroupId: process.pid,
    processStartIdentity,
  });

  let commandStarted = false;
  let terminalFrameSent = false;
  let lastHostSequence = -1;
  let childSequence = 0;
  const socket = connect(socketPath);
  socket.setEncoding('utf8');
  socket.on('connect', () => {
    socket.write(
      `${JSON.stringify(
        createRuntimeControlFrameV1({
          schema: RUNTIME_CONTROL_FRAME_SCHEMA_V1,
          domain: POSIX_CONTROL_FRAME_DOMAIN_V1,
          peerId: POSIX_CHILD_PEER_ID_V1,
          invocationId: dispatchId,
          sequence: childSequence++,
          payload: {
            type: 'ready',
            dispatchId,
            supervisorNonce,
            dispatchIntentDigest,
            pid: process.pid,
            processGroupId: process.pid,
            processStartIdentity,
          },
        }),
      )}\n`,
    );
  });

  let buffer = '';
  socket.on('data', (chunk: string) => {
    buffer += chunk;
    if (buffer.length > 4 * 1024 * 1024) emergencyExit();
    while (buffer.includes('\n')) {
      const boundary = buffer.indexOf('\n');
      const line = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 1);
      void handleFrame(line);
    }
  });
  socket.on('error', emergencyExit);
  socket.on('close', emergencyExit);

  async function handleFrame(line: string): Promise<void> {
    if (commandStarted) return;
    let frame: Record<string, unknown>;
    try {
      frame = JSON.parse(line) as Record<string, unknown>;
    } catch {
      emergencyExit();
      return;
    }
    let payload: Record<string, unknown>;
    try {
      payload = verifyRuntimeControlFrameV1<Record<string, unknown>>({
        frame: frame as unknown as RuntimeControlFrameV1<Record<string, unknown>>,
        expectedDomain: POSIX_CONTROL_FRAME_DOMAIN_V1,
        expectedPeerId: POSIX_HOST_PEER_ID_V1,
        expectedInvocationId: dispatchId,
        lastSequence: lastHostSequence,
      });
      lastHostSequence = (frame as { sequence: number }).sequence;
    } catch {
      emergencyExit();
      return;
    }
    if (
      payload.type !== 'go' ||
      payload.dispatchId !== dispatchId ||
      payload.supervisorNonce !== supervisorNonce ||
      payload.dispatchIntentDigest !== dispatchIntentDigest ||
      !Array.isArray(payload.argv) ||
      payload.argv.length === 0 ||
      payload.argv.some((part) => typeof part !== 'string' || part.length === 0) ||
      typeof payload.cwd !== 'string' ||
      (payload.stdin !== null && typeof payload.stdin !== 'string') ||
      !isStringRecordOrNull(payload.env) ||
      !exactKeys(payload, [
        'type',
        'dispatchId',
        'supervisorNonce',
        'dispatchIntentDigest',
        'argv',
        'cwd',
        'env',
        'stdin',
      ])
    ) {
      emergencyExit();
      return;
    }
    commandStarted = true;
    try {
      const proc = spawnRuntimeHostProcessV1(payload.argv as string[], {
        cwd: payload.cwd as string,
        stdin: payload.stdin === null ? 'inherit' : 'pipe',
        stdout: 'inherit',
        stderr: 'inherit',
        ...(payload.env ? { env: payload.env as Record<string, string> } : {}),
      });
      if (payload.stdin !== null && proc.stdin) {
        proc.stdin.write(payload.stdin as string);
        proc.stdin.end();
      }
      const exitCode = await proc.exited;
      terminalFrameSent = true;
      socket.write(
        `${JSON.stringify(
          createRuntimeControlFrameV1({
            schema: RUNTIME_CONTROL_FRAME_SCHEMA_V1,
            domain: POSIX_CONTROL_FRAME_DOMAIN_V1,
            peerId: POSIX_CHILD_PEER_ID_V1,
            invocationId: dispatchId,
            sequence: childSequence++,
            payload: { type: 'exit', dispatchId, supervisorNonce, dispatchIntentDigest, exitCode },
          }),
        )}\n`,
      );
    } catch (error) {
      terminalFrameSent = true;
      socket.write(
        `${JSON.stringify(
          createRuntimeControlFrameV1({
            schema: RUNTIME_CONTROL_FRAME_SCHEMA_V1,
            domain: POSIX_CONTROL_FRAME_DOMAIN_V1,
            peerId: POSIX_CHILD_PEER_ID_V1,
            invocationId: dispatchId,
            sequence: childSequence++,
            payload: {
              type: 'error',
              dispatchId,
              supervisorNonce,
              dispatchIntentDigest,
              message: error instanceof Error ? error.message : String(error),
            },
          }),
        )}\n`,
      );
    }
  }

  function emergencyExit(): void {
    if (commandStarted) {
      try {
        process.kill(-process.pid, 'SIGKILL');
      } catch {
        process.exit(125);
      }
      return;
    }
    process.exit(terminalFrameSent ? 0 : 125);
  }
}

function isStringRecordOrNull(value: unknown): boolean {
  return (
    value === null ||
    (typeof value === 'object' &&
      value !== null &&
      !Array.isArray(value) &&
      Object.values(value).every((part) => typeof part === 'string'))
  );
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const keys = [...expected].sort();
  return actual.length === keys.length && actual.every((key, index) => key === keys[index]);
}
