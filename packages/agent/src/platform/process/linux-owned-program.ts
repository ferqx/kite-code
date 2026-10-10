import { spawn } from 'node:child_process';
import { fstatSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { Readable } from 'node:stream';

export interface LinuxOwnedProgramEvidence {
  version: 1;
  coverage: 'linux-pid-namespace';
  ownerPid: number;
  admission: { nonce: string; purpose: 'stdio' };
  wrapper: {
    pid: number;
    birth: string;
    parentPid: number;
    exit: { code: number | null; signal: string | null; reaped: true } | null;
    closed: boolean;
    stdoutEof: boolean;
    stderrEof: boolean;
  };
  namespace: null | {
    dev: string;
    ino: string;
    init: { pid: number; birth: string; parentPid: number; localPid: 1; dead: boolean };
    root: null | {
      pid: number;
      birth: string;
      parentPid: number;
      localPid: number;
      dead: boolean;
      waitReceipt: null | {
        localPid: number;
        code: number | null;
        signal: number | null;
        rawStatus: number;
        waitConfirmed: true;
        reaped: true;
      };
    };
    treeStopped: boolean;
  };
  phase: 'starting' | 'ready' | 'terminal' | 'unknown';
  fdClosed: boolean;
  closeUnknown: boolean;
}
export interface LinuxOwnedProgramCompletion {
  confirmed: boolean;
  code: number | null;
  signal: number | null;
  reason: 'natural' | 'cancel' | 'parent_eof' | 'control_error' | 'startup_error' | null;
}
export interface LinuxOwnedProgram {
  readonly pid: number;
  readonly stdout: Readable;
  readonly stderr: Readable;
  readonly ready: Promise<void>;
  readonly completion: Promise<LinuxOwnedProgramCompletion>;
  writeStdin(bytes: Uint8Array, beforeWrite?: () => void): Promise<void>;
  endStdin(): Promise<void>;
  cancel(): Promise<LinuxOwnedProgramCompletion>;
  readProcessEvidence(): LinuxOwnedProgramEvidence;
}
/** Unknown factory cleanup remains an owned facade, so Runtime retains its effect leases. */
export class LinuxOwnedProgramStartError extends Error {
  readonly code = 'linux_owned_program_start_failed';
  readonly cleanup: LinuxOwnedProgram;
  readonly cleanupError: unknown;
  constructor(
    cause: unknown,
    cleanupError: unknown,
    admission: { nonce: string; purpose: 'stdio' },
  ) {
    super('linux_owned_program_start_failed', { cause });
    this.cleanupError = cleanupError;
    const ready = Promise.reject(cause);
    void ready.catch(() => {});
    const completion = Promise.resolve<LinuxOwnedProgramCompletion>(
      immutable({
        confirmed: false,
        code: null,
        signal: null,
        reason: null,
      }),
    );
    const evidence: LinuxOwnedProgramEvidence = {
      version: 1,
      coverage: 'linux-pid-namespace',
      ownerPid: process.pid,
      admission: { ...admission },
      wrapper: {
        pid: 0,
        birth: '',
        parentPid: process.pid,
        exit: null,
        closed: false,
        stdoutEof: false,
        stderrEof: false,
      },
      namespace: null,
      phase: 'unknown',
      fdClosed: false,
      closeUnknown: true,
    };
    this.cleanup = {
      pid: 0,
      stdout: Readable.from([]),
      stderr: Readable.from([]),
      ready,
      completion,
      writeStdin: async () => {
        throw cause;
      },
      endStdin: async () => {
        throw cause;
      },
      cancel: () => completion,
      readProcessEvidence: () => immutable(structuredClone(evidence)),
    };
  }
}
export interface LinuxOwnedProgramOptions {
  bubblewrapPath: string;
  initExecutable: string;
  executable: string;
  argv: readonly string[];
  cwd: string;
  env: Readonly<Record<string, string>>;
  nonce: string;
  graceMs: number;
}
const retained = new Set<object>();
function retainUnknown(value: object) {
  retained.add({ value, keeper: setInterval(() => {}, 60000) });
}
const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 10));
const error = (suffix: string) =>
  Object.assign(Error(`linux_owned_program_${suffix}`), { code: `linux_owned_program_${suffix}` });
const pid = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) > 0 && Number(value) <= 0x7fffffff;
function keys(value: unknown, expected: readonly string[]): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join(',') === [...expected].sort().join(',')
  );
}
function immutable<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) immutable(child);
    Object.freeze(value);
  }
  return value;
}
function processIdentity(value: number) {
  const text = readFileSync(`/proc/${value}/stat`, 'utf8');
  const end = text.lastIndexOf(')');
  const rest = text
    .slice(end + 2)
    .trim()
    .split(/\s+/);
  if (end < 0 || !/^\d+$/.test(rest[19] ?? '') || !pid(Number(rest[1])))
    throw error('process_identity');
  return { pid: value, birth: rest[19]!, parentPid: Number(rest[1]) };
}
// These are the native 64-bit Linux msghdr/iovec/cmsghdr layouts, on both supported ABIs.
// Received descriptors get CLOEXEC atomically; the original child socket deliberately does not.
function native(admission: { nonce: string; purpose: 'stdio' }) {
  if (process.platform !== 'linux' || !['x64', 'arm64'].includes(process.arch))
    throw error('unsupported');
  const { dlopen, ptr, toArrayBuffer } = require('bun:ffi') as typeof import('bun:ffi');
  const library = dlopen('libc.so.6', {
    socketpair: { args: ['i32', 'i32', 'i32', 'ptr'], returns: 'i32' },
    setsockopt: { args: ['i32', 'i32', 'i32', 'ptr', 'u32'], returns: 'i32' },
    recvmsg: { args: ['i32', 'ptr', 'i32'], returns: 'i64' },
    send: { args: ['i32', 'ptr', 'u64', 'i32'], returns: 'i64' },
    poll: { args: ['ptr', 'u64', 'i32'], returns: 'i32' },
    close: { args: ['i32'], returns: 'i32' },
    fcntl: { args: ['i32', 'i32', 'i32'], returns: 'i32' },
    __errno_location: { args: [], returns: 'ptr' },
    // pidfd_send_signal is syscall 424 on both supported Linux ABIs. All five
    // syscall arguments are integers; no newer glibc wrapper is required.
    syscall: { args: ['i64', 'i64', 'i64', 'i64', 'i64'], returns: 'i64' },
  });
  const functions = library.symbols;
  const errno = () => {
    const address = functions.__errno_location();
    if (address === null) throw error('errno');
    return new DataView(toArrayBuffer(address, 0, 4)).getInt32(0, true);
  };
  const owned = new Map<number, 'open' | 'closed' | 'unknown'>();
  const keep = (fd: number) => {
    if (!Number.isSafeInteger(fd) || fd < 0 || (owned.has(fd) && owned.get(fd) !== 'closed'))
      throw error('descriptor');
    owned.delete(fd);
    owned.set(fd, 'open');
    return fd;
  };
  const close = (fd: number) => {
    if (owned.get(fd) === 'closed') return;
    if (owned.get(fd) !== 'open') throw error('close_unknown');
    // Never retry a failed Linux close: the kernel may already have reused the number.
    owned.set(fd, 'unknown');
    if (functions.close(fd) !== 0) throw error('close_unknown');
    owned.set(fd, 'closed');
  };
  const closeAll = () => {
    const failures: unknown[] = [];
    for (const fd of [...owned.keys()].reverse()) {
      try {
        close(fd);
      } catch (failure) {
        failures.push(failure);
      }
    }
    if (failures.length) throw new AggregateError(failures, 'linux_owned_program_close_unknown');
    library.close();
  };
  const pair = new Int32Array(2);
  try {
    if (functions.socketpair(1, 5 | 0x800, 0, ptr(pair)) !== 0) throw error('socketpair');
    keep(pair[0]!);
    keep(pair[1]!);
    if (functions.fcntl(pair[0]!, 2, 1) !== 0) throw error('cloexec');
    const one = new Int32Array([1]);
    if (functions.setsockopt(pair[0]!, 1, 16, ptr(one), 4) !== 0) throw error('passcred');
  } catch (cause) {
    try {
      closeAll();
    } catch (cleanup) {
      retainUnknown({ library, owned });
      throw new LinuxOwnedProgramStartError(cause, cleanup, admission);
    }
    throw cause;
  }
  const dead = (fd: number) => {
    const poll = Buffer.alloc(8);
    poll.writeInt32LE(fd);
    poll.writeInt16LE(1, 4);
    const result = functions.poll(ptr(poll), 1n, 0);
    if (result < 0) {
      if (errno() === 4) return false;
      throw error('pidfd_poll');
    }
    const events = poll.readInt16LE(6);
    if (events & (8 | 0x20)) throw error('pidfd_poll');
    return result === 1 && (events & 1) !== 0;
  };
  const receive = () => {
    const data = Buffer.alloc(1024),
      control = Buffer.alloc(128),
      iov = Buffer.alloc(16),
      msg = Buffer.alloc(56);
    iov.writeBigUInt64LE(BigInt(ptr(data)), 0);
    iov.writeBigUInt64LE(1024n, 8);
    msg.writeBigUInt64LE(BigInt(ptr(iov)), 16);
    msg.writeBigUInt64LE(1n, 24);
    msg.writeBigUInt64LE(BigInt(ptr(control)), 32);
    msg.writeBigUInt64LE(128n, 40);
    const count = Number(functions.recvmsg(pair[0]!, ptr(msg), 0x40 | 0x40000000));
    if (count < 0) {
      if ([4, 11].includes(errno())) return undefined;
      throw error('receive');
    }
    if (count === 0) throw error('control_eof');
    const rights: number[] = [];
    let credential: { pid: number; uid: number; gid: number } | undefined;
    const length = Number(msg.readBigUInt64LE(40));
    let malformed = length > control.length;
    for (let offset = 0; offset + 16 <= Math.min(length, control.length); ) {
      const size = Number(control.readBigUInt64LE(offset));
      if (size < 16 || offset + size > length || offset + size > control.length) {
        malformed = true;
        break;
      }
      const level = control.readInt32LE(offset + 8),
        type = control.readInt32LE(offset + 12);
      if (level === 1 && type === 1) {
        if ((size - 16) % 4 !== 0 || rights.length !== 0) malformed = true;
        for (let at = offset + 16; at + 4 <= offset + size; at += 4)
          rights.push(keep(control.readInt32LE(at)));
      } else if (level === 1 && type === 2 && size === 28 && !credential) {
        credential = {
          pid: control.readInt32LE(offset + 16),
          uid: control.readUInt32LE(offset + 20),
          gid: control.readUInt32LE(offset + 24),
        };
      } else malformed = true;
      offset += (size + 7) & ~7;
    }
    if (
      malformed ||
      count > 1024 ||
      msg.readInt32LE(48) & (0x20 | 8) ||
      !credential ||
      !pid(credential.pid) ||
      credential.uid !== process.getuid?.() ||
      credential.gid !== process.getgid?.()
    )
      throw error('ancillary');
    const body: unknown = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(data.subarray(0, count)),
    );
    return { body, rights, credential };
  };
  const send = async (command: 'P' | 'G' | 'C', deadline: number) => {
    const bytes = Buffer.from(command);
    while (performance.now() < deadline) {
      const count = Number(functions.send(pair[0]!, ptr(bytes), 1n, 0x40 | 0x4000));
      if (count === 1) return;
      if (count !== -1 || ![4, 11].includes(errno())) throw error('send');
      await pause();
    }
    throw error('send_timeout');
  };
  return {
    parent: pair[0]!,
    child: pair[1]!,
    owned,
    close,
    closeAll,
    dead,
    receive,
    send,
    library,
    killInit(fd: number) {
      if (owned.get(fd) === 'open') functions.syscall(424n, BigInt(fd), 9n, 0n, 0n);
    },
  };
}
function pidfdIdentity(fd: number, localPid: number) {
  const text = readFileSync(`/proc/self/fdinfo/${fd}`, 'utf8');
  const outer = Number(/^Pid:\s+(\d+)$/m.exec(text)?.[1]);
  const ns = /^NSpid:\s+([\d\s]+)$/m.exec(text)?.[1]?.trim().split(/\s+/).map(Number);
  if (!pid(outer) || !ns || ns[0] !== outer || ns.at(-1) !== localPid)
    throw error('pidfd_identity');
  if (ns.length < 2 || ns.some((value) => !pid(value))) throw error('pidfd_namespace_mapping');
  return { ...processIdentity(outer), namespacePids: ns };
}
function namespaceIdentity(pathOrFd: string | number) {
  const stat =
    typeof pathOrFd === 'number'
      ? fstatSync(pathOrFd, { bigint: true })
      : statSync(pathOrFd, { bigint: true });
  return { dev: stat.dev.toString(), ino: stat.ino.toString() };
}
function sameNamespace(a: { dev: string; ino: string }, b: { dev: string; ino: string }) {
  return a.dev === b.dev && a.ino === b.ino;
}
function validReceipt(
  value: unknown,
  localPid: number,
): value is NonNullable<
  NonNullable<NonNullable<LinuxOwnedProgramEvidence['namespace']>['root']>['waitReceipt']
> {
  if (
    !keys(value, ['localPid', 'code', 'signal', 'rawStatus', 'waitConfirmed', 'reaped']) ||
    value.localPid !== localPid ||
    value.waitConfirmed !== true ||
    value.reaped !== true ||
    !Number.isInteger(value.rawStatus) ||
    Number(value.rawStatus) < 0 ||
    Number(value.rawStatus) > 0xffff
  )
    return false;
  const raw = Number(value.rawStatus);
  return (
    (value.signal === null &&
      Number.isInteger(value.code) &&
      Number(value.code) >= 0 &&
      Number(value.code) <= 255 &&
      raw === Number(value.code) * 256) ||
    (value.code === null &&
      pid(value.signal) &&
      value.signal <= 64 &&
      (raw & 0x7f) === value.signal &&
      (raw & ~0xff) === 0)
  );
}
function encodeConfiguration(options: LinuxOwnedProgramOptions): Buffer {
  const paths = [options.bubblewrapPath, options.initExecutable, options.executable, options.cwd];
  const text = (value: string, maximum: number) => {
    if (
      typeof value !== 'string' ||
      value.includes('\0') ||
      Buffer.byteLength(value) > maximum ||
      Buffer.from(value).toString('utf8') !== value
    )
      throw error('options');
    const bytes = Buffer.from(value),
      size = Buffer.alloc(4);
    size.writeUInt32LE(bytes.length);
    return Buffer.concat([size, bytes]);
  };
  if (
    paths.some((path) => !isAbsolute(path)) ||
    options.argv.length > 128 ||
    Object.keys(options.env).length > 128
  )
    throw error('options');
  const header = Buffer.alloc(16);
  header.write('KITEMCP1');
  header.writeUInt32LE(options.argv.length, 8);
  header.writeUInt32LE(Object.keys(options.env).length, 12);
  const fields = [
    text(options.executable, 4096),
    text(options.cwd, 4096),
    ...options.argv.map((arg) => {
      if (typeof arg !== 'string' || arg.length > 8192) throw error('options');
      return text(arg, 32768);
    }),
    ...Object.entries(options.env).map(([key, value]) => {
      if (
        !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(key) ||
        typeof value !== 'string' ||
        value.length > 8192
      )
        throw error('options');
      return text(`${key}=${value}`, 32897);
    }),
  ];
  const result = Buffer.concat([header, ...fields]);
  if (result.length > 256 * 1024) throw error('configuration_limit');
  return result;
}
/** Explicit native effect; import performs no FFI, filesystem or process operations. */
export function startLinuxOwnedProgram(options: LinuxOwnedProgramOptions): LinuxOwnedProgram {
  const config = encodeConfiguration(options);
  if (
    !/^[a-zA-Z0-9_-]{16,128}$/.test(options.nonce) ||
    !Number.isInteger(options.graceMs) ||
    options.graceMs < 0 ||
    options.graceMs > 5000
  )
    throw error('options');
  const admission = { nonce: options.nonce, purpose: 'stdio' as const };
  const kernel = native(admission);
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(
      options.bubblewrapPath,
      [
        '--unshare-user',
        '--unshare-pid',
        '--as-pid-1',
        '--die-with-parent',
        '--cap-drop',
        'ALL',
        '--bind',
        '/',
        '/',
        '--proc',
        '/proc',
        '--dev-bind',
        '/dev',
        '/dev',
        '--chdir',
        options.cwd,
        '--',
        options.initExecutable,
        options.nonce,
        String(options.graceMs),
      ],
      {
        cwd: options.cwd,
        env: {},
        stdio: ['pipe', 'pipe', 'pipe', kernel.child, 'pipe'],
      },
    );
  } catch (cause) {
    try {
      kernel.closeAll();
    } catch (cleanup) {
      retainUnknown(kernel);
      throw new LinuxOwnedProgramStartError(cause, cleanup, admission);
    }
    throw cause;
  }
  let resolveReady!: () => void,
    rejectReady!: (cause: unknown) => void,
    resolveCompletion!: (value: LinuxOwnedProgramCompletion) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  void ready.catch(() => {});
  const completion = new Promise<LinuxOwnedProgramCompletion>((resolve) => {
    resolveCompletion = resolve;
  });
  const evidence: LinuxOwnedProgramEvidence = {
    version: 1,
    coverage: 'linux-pid-namespace',
    ownerPid: process.pid,
    admission: { nonce: options.nonce, purpose: 'stdio' },
    wrapper: {
      pid: child.pid ?? 0,
      birth: '',
      parentPid: process.pid,
      exit: null,
      closed: false,
      stdoutEof: false,
      stderrEof: false,
    },
    namespace: null,
    phase: 'starting',
    fdClosed: false,
    closeUnknown: false,
  };
  let terminal: { reason: LinuxOwnedProgramCompletion['reason'] } | undefined;
  let initFd: number | undefined, rootFd: number | undefined;
  let initNamespaceDepth: number | undefined;
  let done = false,
    cancelStarted = false,
    readySent = false;
  let deadline = performance.now() + 10000;
  const unknown = (cause: unknown) => {
    if (done) return;
    done = true;
    evidence.phase = 'unknown';
    // Only a fully admitted original init pidfd can stop its namespace. This
    // best effort cleanup never upgrades the immutable unknown result.
    if (evidence.namespace && initFd !== undefined) {
      try {
        kernel.killInit(initFd);
      } catch {
        /* Preserve the original failure and owner. */
      }
    }
    evidence.closeUnknown ||= [...kernel.owned.values()].includes('unknown');
    rejectReady(cause);
    // Keep actual native objects and their original numbers, but never retry an uncertain close.
    const keeper = setInterval(() => {}, 60000);
    retained.add({ kernel, child, evidence, keeper });
    resolveCompletion(
      immutable({
        confirmed: false,
        code: null,
        signal: null,
        reason: terminal?.reason ?? null,
      }),
    );
  };
  const stdin = child.stdin!;
  const configuration = child.stdio[4] as import('node:stream').Duplex;
  let stdinClosed = false,
    configurationClosed = false,
    configSent = false;
  let pendingBytes = 0,
    pendingWrites = 0,
    ending = false;
  let endPromise: Promise<void> | undefined;
  stdin.once('close', () => {
    stdinClosed = true;
  });
  configuration.once('close', () => {
    configurationClosed = true;
  });
  const cancelledInputError = (cause: unknown) =>
    cancelStarted &&
    [
      'EPIPE',
      'ERR_STREAM_DESTROYED',
      'ERR_STREAM_WRITE_AFTER_END',
      'ERR_STREAM_PREMATURE_CLOSE',
    ].includes(String((cause as { code?: unknown })?.code));
  stdin.on('error', (cause) => {
    if (!cancelledInputError(cause)) unknown(cause);
  });
  configuration.once('error', unknown);
  // Extra stdio is a duplex pipe on Node/Bun. Drain its read side to observe
  // actual peer EOF/close; the configuration protocol never permits a reply.
  configuration.on('data', () => unknown(error('configuration_reply')));
  configuration.resume?.();
  try {
    configuration.end(config, () => {
      configSent = true;
    });
  } catch (cause) {
    unknown(cause);
  }
  child.once('error', unknown);
  child.once('exit', (code, signal) => {
    evidence.wrapper.exit = { code, signal, reaped: true };
  });
  child.once('close', () => {
    evidence.wrapper.closed = true;
  });
  const stdout = child.stdout!,
    stderr = child.stderr!;
  stdout.once('end', () => {
    evidence.wrapper.stdoutEof = true;
  });
  stderr.once('end', () => {
    evidence.wrapper.stderrEof = true;
  });
  stdout.once('error', unknown);
  stderr.once('error', unknown);
  try {
    kernel.close(kernel.child);
    if (!pid(child.pid)) throw error('wrapper_pid');
    const identity = processIdentity(child.pid);
    if (identity.parentPid !== process.pid) throw error('wrapper_parent');
    evidence.wrapper.pid = identity.pid;
    evidence.wrapper.birth = identity.birth;
    evidence.wrapper.parentPid = identity.parentPid;
  } catch (cause) {
    unknown(cause);
  }
  const run = async () => {
    try {
      while (!done) {
        const packet = terminal ? undefined : kernel.receive();
        if (packet) {
          const frame = packet.body;
          if (
            !keys(frame, [
              'version',
              'type',
              'nonce',
              ...(evidence.namespace ? ['localPid'] : ['initLocalPid', 'namespace']),
            ]) &&
            !(
              keys(frame, [
                'version',
                'type',
                'nonce',
                'reason',
                'root',
                'treeStopped',
                'closed',
              ]) && frame.type === 'terminal'
            )
          )
            throw error('frame');
          if (frame.version !== 1 || frame.nonce !== options.nonce) throw error('binding');
          if (frame.type === 'namespace' && !evidence.namespace) {
            if (
              frame.initLocalPid !== 1 ||
              !keys(frame.namespace, ['dev', 'ino']) ||
              typeof frame.namespace.dev !== 'string' ||
              typeof frame.namespace.ino !== 'string' ||
              packet.rights.length !== 2
            )
              throw error('namespace');
            initFd = packet.rights[0]!;
            const { namespacePids, ...init } = pidfdIdentity(initFd, 1);
            const ns = namespaceIdentity(packet.rights[1]!);
            if (
              kernel.dead(initFd) ||
              init.pid !== packet.credential.pid ||
              !sameNamespace(ns, frame.namespace as { dev: string; ino: string }) ||
              init.parentPid !== evidence.wrapper.pid ||
              sameNamespace(ns, namespaceIdentity('/proc/self/ns/pid'))
            )
              throw error('namespace_binding');
            if (pidfdIdentity(initFd, 1).birth !== init.birth) throw error('init_changed');
            initNamespaceDepth = namespacePids.length;
            evidence.namespace = {
              ...ns,
              init: {
                pid: init.pid,
                birth: init.birth,
                parentPid: init.parentPid,
                localPid: 1,
                dead: false,
              },
              root: null,
              treeStopped: false,
            };
            await kernel.send('P', deadline);
          } else if (frame.type === 'root' && evidence.namespace && !evidence.namespace.root) {
            if (
              !pid(frame.localPid) ||
              packet.rights.length !== 1 ||
              packet.credential.pid !== evidence.namespace.init.pid
            )
              throw error('root');
            rootFd = packet.rights[0]!;
            const { namespacePids, ...root } = pidfdIdentity(rootFd, frame.localPid);
            if (
              kernel.dead(rootFd) ||
              root.parentPid !== evidence.namespace.init.pid ||
              namespacePids.length !== initNamespaceDepth ||
              pidfdIdentity(rootFd, frame.localPid).birth !== root.birth
            )
              throw error('root_binding');
            evidence.namespace.root = {
              pid: root.pid,
              birth: root.birth,
              parentPid: root.parentPid,
              localPid: frame.localPid,
              dead: false,
              waitReceipt: null,
            };
            await kernel.send('G', deadline);
            readySent = true;
            evidence.phase = 'ready';
            deadline = Number.POSITIVE_INFINITY;
            resolveReady();
          } else if (frame.type === 'terminal' && evidence.namespace?.root && readySent) {
            if (
              packet.rights.length !== 0 ||
              packet.credential.pid !== evidence.namespace.init.pid ||
              !['natural', 'cancel', 'parent_eof', 'control_error', 'startup_error'].includes(
                String(frame.reason),
              ) ||
              frame.treeStopped !== true ||
              frame.closed !== true ||
              !validReceipt(frame.root, evidence.namespace.root.localPid)
            )
              throw error('terminal');
            evidence.namespace.root.waitReceipt = frame.root;
            terminal = { reason: frame.reason as LinuxOwnedProgramCompletion['reason'] };
            evidence.namespace.treeStopped = true;
            deadline = Math.min(deadline, performance.now() + 4000);
          } else throw error('sequence');
        }
        if (terminal && initFd !== undefined && rootFd !== undefined && evidence.namespace?.root) {
          evidence.namespace.init.dead = kernel.dead(initFd);
          evidence.namespace.root.dead = kernel.dead(rootFd);
          if (
            evidence.wrapper.closed &&
            stdinClosed &&
            configurationClosed &&
            configSent &&
            pendingWrites === 0 &&
            evidence.wrapper.exit?.code === 0 &&
            evidence.wrapper.exit.signal === null &&
            evidence.wrapper.stdoutEof &&
            evidence.wrapper.stderrEof &&
            evidence.namespace.init.dead &&
            evidence.namespace.root.dead
          ) {
            if (!['natural', 'cancel'].includes(terminal.reason ?? ''))
              throw error('abnormal_terminal');
            try {
              kernel.closeAll();
            } catch (cause) {
              evidence.closeUnknown = true;
              throw cause;
            }
            evidence.fdClosed = true;
            evidence.phase = 'terminal';
            done = true;
            resolveCompletion(
              immutable({
                confirmed: true,
                code: evidence.namespace.root.waitReceipt!.code,
                signal: evidence.namespace.root.waitReceipt!.signal,
                reason: terminal.reason,
              }),
            );
            return;
          }
        }
        if (performance.now() >= deadline) throw error('timeout');
        await pause();
      }
    } catch (cause) {
      unknown(cause);
    }
  };
  void run();
  return {
    pid: evidence.wrapper.pid,
    stdout,
    stderr,
    ready,
    completion,
    writeStdin(bytes, beforeWrite) {
      if (
        ending ||
        done ||
        cancelStarted ||
        bytes.length > 1024 * 1024 ||
        pendingBytes + bytes.length > 2 * 1024 * 1024 ||
        pendingWrites >= 128
      )
        return Promise.reject(error('stdin_unavailable'));
      const copy = Buffer.from(bytes);
      pendingBytes += copy.length;
      pendingWrites++;
      return (async () => {
        let attempted = false;
        try {
          await ready;
          if (done || cancelStarted) throw error('stdin_unavailable');
          beforeWrite?.();
          await new Promise<void>((resolve, reject) => {
            attempted = true;
            stdin.write(copy, (cause) => (cause ? reject(cause) : resolve()));
          });
        } catch (cause) {
          if (attempted && !cancelledInputError(cause)) unknown(cause);
          throw cause;
        } finally {
          pendingBytes -= copy.length;
          pendingWrites--;
        }
      })();
    },
    endStdin() {
      if (endPromise) return endPromise;
      ending = true;
      let attempted = false;
      endPromise = (async () => {
        await ready;
        if (done || cancelStarted) throw error('stdin_unavailable');
        attempted = true;
        await new Promise<void>((resolve, reject) => {
          stdin.end((cause?: Error | null) => (cause ? reject(cause) : resolve()));
        });
      })();
      void endPromise.catch((cause) => {
        if (attempted && !cancelledInputError(cause)) unknown(cause);
      });
      return endPromise;
    },
    cancel() {
      if (!done && !cancelStarted) {
        cancelStarted = true;
        deadline = Math.min(deadline, performance.now() + options.graceMs + 4000);
        void kernel.send('C', deadline).catch(unknown);
      }
      return completion;
    },
    readProcessEvidence: () => immutable(structuredClone(evidence)),
  };
}
