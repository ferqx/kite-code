import { connect } from 'node:net';
import {
  readComparablePosixProcessStartIdentityV1,
  writePosixSupervisorIdentityV1,
} from './posix-supervisor-identity';
import { verifyInheritedPosixSupervisorLockV1 } from './posix-supervisor-lock';

/** Internal Runtime mode embedded in release executables; never accepts an unsealed command directly. */
export function runPosixSupervisorChildV1(args: readonly string[]): void {
  const [
    socketPath,
    identityPath,
    controlRoot,
    dataRoot,
    dispatchId,
    supervisorNonce,
    dispatchIntentDigest,
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
  const socket = connect(socketPath);
  socket.setEncoding('utf8');
  socket.on('connect', () => {
    socket.write(
      `${JSON.stringify({
        type: 'ready',
        dispatchId,
        supervisorNonce,
        dispatchIntentDigest,
        pid: process.pid,
        processGroupId: process.pid,
        processStartIdentity,
      })}\n`,
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
    if (
      frame.type !== 'go' ||
      frame.dispatchId !== dispatchId ||
      frame.supervisorNonce !== supervisorNonce ||
      frame.dispatchIntentDigest !== dispatchIntentDigest ||
      !Array.isArray(frame.argv) ||
      frame.argv.length === 0 ||
      frame.argv.some((part) => typeof part !== 'string' || part.length === 0) ||
      typeof frame.cwd !== 'string' ||
      (frame.stdin !== null && typeof frame.stdin !== 'string') ||
      !isStringRecordOrNull(frame.env)
    ) {
      emergencyExit();
      return;
    }
    commandStarted = true;
    try {
      const proc = Bun.spawn(frame.argv as string[], {
        cwd: frame.cwd,
        stdin: frame.stdin === null ? 'inherit' : 'pipe',
        stdout: 'inherit',
        stderr: 'inherit',
        ...(frame.env ? { env: frame.env as Record<string, string> } : {}),
      });
      if (frame.stdin !== null && proc.stdin) {
        proc.stdin.write(frame.stdin as string);
        proc.stdin.end();
      }
      const exitCode = await proc.exited;
      terminalFrameSent = true;
      socket.write(
        `${JSON.stringify({
          type: 'exit',
          dispatchId,
          supervisorNonce,
          dispatchIntentDigest,
          exitCode,
        })}\n`,
      );
    } catch (error) {
      terminalFrameSent = true;
      socket.write(
        `${JSON.stringify({
          type: 'error',
          dispatchId,
          supervisorNonce,
          dispatchIntentDigest,
          message: error instanceof Error ? error.message : String(error),
        })}\n`,
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
