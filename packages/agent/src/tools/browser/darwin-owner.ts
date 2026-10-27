import { spawn } from 'node:child_process';
import { PassThrough } from 'node:stream';
import {
  isOwnedProcessIdentity,
  type OwnedProcessIdentity,
  type OwnedProcessRecord,
  observeOwnedProcessIdentity,
  ownedProcessKernelState,
} from '../../platform/process/owned-process-observation';

export interface DarwinBrowserEvidence {
  ownerPid: number;
  nonce: string;
  phase: 'starting' | 'ready' | 'terminal' | 'unknown';
  broker: OwnedProcessRecord | null;
  guardian: OwnedProcessRecord | null;
  root: OwnedProcessRecord | null;
  coalition: { id: string; uniqueId: string; pidVersion: number; taskCount: number | null } | null;
  registration: { label: string; domain: string; removed: boolean } | null;
  treeStopped: boolean;
  fdClosed: boolean;
}
export interface DarwinBrowserOwner {
  readonly stdout: PassThrough;
  readonly stderr: PassThrough;
  readonly ready: Promise<void>;
  readonly completion: Promise<{ confirmed: boolean }>;
  cancel(): Promise<{ confirmed: boolean }>;
  readProcessEvidence(): DarwinBrowserEvidence;
}
const retained = new Set<object>();
const same = (a: OwnedProcessIdentity | null, b: OwnedProcessIdentity | null) =>
  !!a &&
  !!b &&
  a.pid === b.pid &&
  a.parentPid === b.parentPid &&
  !!a.birth &&
  !!b.birth &&
  a.birth.seconds === b.birth.seconds &&
  a.birth.microseconds === b.birth.microseconds;
/** Reuse the sealed stdio guardian as a raw program owner. No MCP client or RPC session is created. */
export function startDarwinBrowserOwner(input: {
  guardianPath: string;
  bunExecutable: string;
  executable: string;
  cwd: string;
  env: Record<string, string>;
  nonce: string;
  graceMs: number;
  startupTimeoutMs: number;
}): DarwinBrowserOwner {
  const child = spawn(input.bunExecutable, [input.guardianPath, '--browser-owner'], {
    cwd: input.cwd,
    env: {},
    detached: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const stdout = new PassThrough(),
    stderr = new PassThrough();
  const evidence: DarwinBrowserEvidence = {
    ownerPid: process.pid,
    nonce: input.nonce,
    phase: 'starting',
    broker: child.pid
      ? { ...observeOwnedProcessIdentity(child.pid), exit: null, kernelState: 'alive' }
      : null,
    guardian: null,
    root: null,
    coalition: null,
    registration: null,
    treeStopped: false,
    fdClosed: false,
  };
  let sequence = 0,
    buffer = Buffer.alloc(0),
    closing = false,
    finished = false,
    invalid = false,
    terminalSeen = false;
  let exit: OwnedProcessRecord['exit'] = null,
    eof = false,
    errorEof = false;
  let resolveReady!: () => void, rejectReady!: (cause: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  void ready.catch(() => {});
  let resolveEnd!: (value: { confirmed: boolean }) => void;
  const completion = new Promise<{ confirmed: boolean }>((resolve) => {
    resolveEnd = resolve;
  });
  let stopTimer: ReturnType<typeof setTimeout> | undefined;
  const startupTimer = setTimeout(() => {
    rejectReady(Error('browser_darwin_start_timeout'));
    void cancel();
  }, input.startupTimeoutMs);
  const finish = (confirmed: boolean) => {
    if (finished) return;
    confirmed = confirmed && !invalid;
    finished = true;
    closing = true;
    clearTimeout(startupTimer);
    clearTimeout(stopTimer);
    evidence.phase = confirmed ? 'terminal' : 'unknown';
    rejectReady(Error('browser_darwin_ended'));
    if (!confirmed) retained.add({ child, stdout, stderr, evidence });
    resolveEnd({ confirmed });
  };
  function cancel() {
    if (!closing) {
      closing = true;
      rejectReady(Error('browser_darwin_closed'));
      if (child.stdin.writable)
        child.stdin.write(JSON.stringify({ type: 'cancel', nonce: input.nonce }) + '\n');
      stopTimer = setTimeout(() => {
        child.stdin.end();
        finish(false);
      }, input.graceMs + 5000);
    }
    return completion;
  }
  function malformed() {
    invalid = true;
    rejectReady(Error('browser_darwin_owner_invalid'));
    void cancel();
  }
  child.stdin.on('error', malformed);
  child.on('error', () => {
    malformed();
    if (!child.pid) finish(false);
  });
  child.stdout.on('data', (chunk: Buffer) => {
    try {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > 65536) throw Error('control_limit');
      for (let end = buffer.indexOf(10); end >= 0; end = buffer.indexOf(10)) {
        const frame = JSON.parse(
          new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, end)),
        );
        buffer = buffer.subarray(end + 1);
        if (frame.nonce !== input.nonce || frame.sequence !== ++sequence)
          throw Error('control_identity');
        if (terminalSeen) throw Error('control_after_terminal');
        if (frame.type === 'ready') {
          if (
            evidence.phase !== 'starting' ||
            !child.pid ||
            !isOwnedProcessIdentity(frame.broker, child.pid, process.pid) ||
            !same(evidence.broker, frame.broker) ||
            !isOwnedProcessIdentity(
              {
                pid: frame.guardian?.pid,
                parentPid: frame.guardian?.parentPid,
                birth: frame.guardian?.birth,
                unavailable: frame.guardian?.unavailable,
              },
              frame.guardianPid,
              1,
            ) ||
            !isOwnedProcessIdentity(
              {
                pid: frame.server?.pid,
                parentPid: frame.server?.parentPid,
                birth: frame.server?.birth,
                unavailable: frame.server?.unavailable,
              },
              frame.processGroupId,
              frame.guardianPid,
            ) ||
            !frame.broker.birth ||
            !frame.guardian.birth ||
            !frame.server.birth ||
            frame.guardian.exit !== null ||
            frame.server.exit !== null ||
            frame.coalition?.pid !== frame.guardianPid ||
            !/^[1-9][0-9]{0,19}$/.test(frame.coalition.coalitionId) ||
            !/^[1-9][0-9]{0,19}$/.test(frame.coalition.uniqueId) ||
            !Number.isSafeInteger(frame.coalition.pidVersion) ||
            frame.registration?.removed !== false ||
            !/^com\.kitecode\.browser\.[a-f0-9-]{36}$/.test(frame.registration.label) ||
            frame.registration.domain !== 'user/' + process.getuid!()
          )
            throw Error('ready_identity');
          evidence.guardian = frame.guardian;
          evidence.root = frame.server;
          evidence.coalition = {
            id: frame.coalition.coalitionId,
            uniqueId: frame.coalition.uniqueId,
            pidVersion: frame.coalition.pidVersion,
            taskCount: null,
          };
          evidence.registration = frame.registration;
          evidence.phase = 'ready';
          clearTimeout(startupTimer);
          // Cancellation prevents all business requests but must not discard
          // a first valid ownership binding needed by the ensuing terminal.
          if (!closing) resolveReady();
        } else if (
          frame.type === 'rpc' &&
          typeof frame.content === 'string' &&
          frame.content.length <= 32768
        ) {
          stdout.write(Buffer.from(frame.content, 'base64'));
        } else if (frame.type === 'terminal') {
          if (
            frame.guardian?.exit !== null ||
            !same(evidence.guardian, frame.guardian) ||
            !same(evidence.root, frame.server) ||
            !evidence.registration ||
            frame.registration?.label !== evidence.registration.label ||
            frame.registration.domain !== evidence.registration.domain ||
            frame.registration.removed !== true ||
            frame.registrationRemoved !== true ||
            frame.server?.exit?.reaped !== true ||
            !(
              (Number.isInteger(frame.server.exit.code) &&
                frame.server.exit.code >= 0 &&
                frame.server.exit.code <= 255 &&
                frame.server.exit.signal === null) ||
              (frame.server.exit.code === null &&
                /^SIG[A-Z0-9]{1,12}$/.test(frame.server.exit.signal))
            )
          )
            throw Error('terminal_identity');
          terminalSeen = true;
          evidence.root = frame.server;
          evidence.guardian = {
            ...frame.guardian,
            kernelState: ownedProcessKernelState(frame.guardian),
          };
          evidence.registration.removed = true;
          evidence.coalition!.taskCount = frame.terminalTaskCount;
          evidence.treeStopped =
            frame.groupStopped === true &&
            frame.processTreeStopped === true &&
            frame.terminalTaskCount === 1 &&
            evidence.guardian!.kernelState === 'absent' &&
            ownedProcessKernelState(evidence.root!) === 'absent';
        } else throw Error('control_frame');
      }
    } catch {
      malformed();
    }
  });
  child.stdout.on('end', () => {
    if (buffer.length) malformed();
    eof = true;
    stdout.end();
  });
  child.stdout.on('error', malformed);
  child.stderr.on('data', (bytes: Buffer) => stderr.write(bytes));
  child.stderr.on('end', () => {
    errorEof = true;
    stderr.end();
  });
  child.stderr.on('error', malformed);
  child.once('exit', (code, signal) => {
    exit = { code, signal, reaped: true };
  });
  child.once('close', () => {
    evidence.fdClosed = child.stdin.destroyed && eof && errorEof;
    if (evidence.broker)
      evidence.broker = {
        ...evidence.broker,
        exit,
        kernelState: ownedProcessKernelState(evidence.broker),
      };
    finish(
      evidence.treeStopped &&
        evidence.fdClosed &&
        !!exit &&
        exit.code === 0 &&
        exit.signal === null &&
        evidence.broker?.kernelState === 'absent',
    );
  });
  child.stdin.write(
    JSON.stringify({
      type: 'start',
      nonce: input.nonce,
      command: input.executable,
      args: [],
      cwd: input.cwd,
      env: input.env,
      controlBase: input.cwd,
      graceMs: input.graceMs,
      stderrBytes: 65536,
      frameBytes: 131072,
      outputBytes: 65536,
    }) + '\n',
  );
  return {
    stdout,
    stderr,
    ready,
    completion,
    cancel,
    readProcessEvidence: () => structuredClone(evidence),
  };
}
