import { randomUUID } from 'node:crypto';
import { win32 } from 'node:path';

export interface WindowsOwnedChildEvidence {
  readonly version: 1;
  readonly coverage: 'windows-job-members';
  readonly root: {
    readonly pid: number;
    readonly creationTime: string;
    readonly exitCode: number | null;
    readonly waitConfirmed: boolean;
  };
  readonly job: { readonly activeProcesses: number | null; readonly treeStopped: boolean };
  readonly closed: boolean;
  readonly closeUnknown: boolean;
}
export interface WindowsOwnedChild {
  readonly pid: number;
  readonly rootCreationTime: string;
  readonly stdout: AsyncIterable<Uint8Array>;
  readonly stderr: AsyncIterable<Uint8Array>;
  readonly exited: Promise<number>;
  writeStdin(bytes: Uint8Array): Promise<void>;
  endStdin(): Promise<void>;
  stop(options: { graceMs: number }): Promise<WindowsOwnedChildEvidence>;
  close(): Promise<void>;
  readEvidence(): WindowsOwnedChildEvidence;
}
/** A failed start may already own native resources; consumers must await cleanup before exiting. */
export class WindowsOwnedChildStartError extends Error {
  readonly code = 'windows_owned_child_start_failed';
  readonly cleanup: Promise<void>;
  constructor(cause: unknown, cleanup: Promise<void>) {
    super('windows_owned_child_start_failed', { cause });
    this.cleanup = cleanup;
  }
}

export interface WindowsOwnedProcessObservation {
  readonly pid: number;
  readonly creationTime: string | undefined;
  verify(): boolean;
  inspect(): 'alive' | 'dead' | 'uncertain';
  close(): void;
}

const INVALID = 0xffffffffffffffffn;
const retained = new Set<object>();
const delay = () => new Promise<void>((resolve) => setTimeout(resolve, 5));
const wide = (value: string) => Buffer.from(`${value}\0`, 'utf16le');
const validPid = (pid: number) => Number.isSafeInteger(pid) && pid > 0 && pid <= 0xffffffff;
function failure(operation: string, win32Error?: number) {
  return Object.assign(Error(`windows_owned_child_${operation}`), {
    code: `windows_owned_child_${operation}`,
    ...(win32Error === undefined ? {} : { win32Error }),
  });
}
function native() {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw failure('unsupported');
  // Fixed KnownDLL, lazy on import; no caller-provided DLL or native HANDLE.
  const { dlopen, ptr, toArrayBuffer } = require('bun:ffi') as typeof import('bun:ffi');
  const kernel = dlopen('kernel32.dll', {
    CreateJobObjectW: { args: ['ptr', 'ptr'], returns: 'u64' },
    SetInformationJobObject: { args: ['u64', 'u32', 'ptr', 'u32'], returns: 'bool' },
    QueryInformationJobObject: { args: ['u64', 'u32', 'ptr', 'u32', 'ptr'], returns: 'bool' },
    AssignProcessToJobObject: { args: ['u64', 'u64'], returns: 'bool' },
    TerminateJobObject: { args: ['u64', 'u32'], returns: 'bool' },
    CreateProcessW: {
      args: ['ptr', 'ptr', 'ptr', 'ptr', 'bool', 'u32', 'ptr', 'ptr', 'ptr', 'ptr'],
      returns: 'bool',
    },
    InitializeProcThreadAttributeList: { args: ['ptr', 'u32', 'u32', 'ptr'], returns: 'bool' },
    UpdateProcThreadAttribute: {
      args: ['ptr', 'u32', 'u64', 'ptr', 'u64', 'ptr', 'ptr'],
      returns: 'bool',
    },
    DeleteProcThreadAttributeList: { args: ['ptr'], returns: 'void' },
    ResumeThread: { args: ['u64'], returns: 'u32' },
    WaitForSingleObject: { args: ['u64', 'u32'], returns: 'u32' },
    GetExitCodeProcess: { args: ['u64', 'ptr'], returns: 'bool' },
    GetProcessId: { args: ['u64'], returns: 'u32' },
    GetProcessTimes: { args: ['u64', 'ptr', 'ptr', 'ptr', 'ptr'], returns: 'bool' },
    OpenProcess: { args: ['u32', 'bool', 'u32'], returns: 'u64' },
    TerminateProcess: { args: ['u64', 'u32'], returns: 'bool' },
    CloseHandle: { args: ['u64'], returns: 'bool' },
    GetLastError: { args: [], returns: 'u32' },
    CreatePipe: { args: ['ptr', 'ptr', 'ptr', 'u32'], returns: 'bool' },
    SetHandleInformation: { args: ['u64', 'u32', 'u32'], returns: 'bool' },
    PeekNamedPipe: { args: ['u64', 'ptr', 'u32', 'ptr', 'ptr', 'ptr'], returns: 'bool' },
    ReadFile: { args: ['u64', 'ptr', 'u32', 'ptr', 'ptr'], returns: 'bool' },
    WriteFile: { args: ['u64', 'ptr', 'u32', 'ptr', 'ptr'], returns: 'bool' },
    CreateNamedPipeW: {
      args: ['ptr', 'u32', 'u32', 'u32', 'u32', 'u32', 'u32', 'ptr'],
      returns: 'u64',
    },
    ConnectNamedPipe: { args: ['u64', 'ptr'], returns: 'bool' },
    CreateFileW: { args: ['ptr', 'u32', 'u32', 'ptr', 'u32', 'u32', 'u64'], returns: 'u64' },
    CreateEventW: { args: ['ptr', 'bool', 'bool', 'ptr'], returns: 'u64' },
    GetOverlappedResult: { args: ['u64', 'ptr', 'ptr', 'bool'], returns: 'bool' },
    CancelIoEx: { args: ['u64', 'ptr'], returns: 'bool' },
    GetCurrentProcess: { args: [], returns: 'u64' },
    LocalFree: { args: ['u64'], returns: 'u64' },
  });
  const raw = kernel.symbols;
  // Bun's u64 fast path may return a number when exactly representable.
  const api = {
    ...raw,
    CreateJobObjectW: (...args: Parameters<typeof raw.CreateJobObjectW>) =>
      BigInt(raw.CreateJobObjectW(...args)),
    OpenProcess: (...args: Parameters<typeof raw.OpenProcess>) => BigInt(raw.OpenProcess(...args)),
    CreateNamedPipeW: (...args: Parameters<typeof raw.CreateNamedPipeW>) =>
      BigInt(raw.CreateNamedPipeW(...args)),
    CreateFileW: (...args: Parameters<typeof raw.CreateFileW>) => BigInt(raw.CreateFileW(...args)),
    CreateEventW: (...args: Parameters<typeof raw.CreateEventW>) =>
      BigInt(raw.CreateEventW(...args)),
    GetCurrentProcess: () => BigInt(raw.GetCurrentProcess()),
    LocalFree: (...args: Parameters<typeof raw.LocalFree>) => BigInt(raw.LocalFree(...args)),
  };
  return { api, ptr, toArrayBuffer, kernel };
}
type Native = ReturnType<typeof native>;
function creation(system: Native, handle: bigint, pid: number): string {
  const start = new BigUint64Array(1),
    exit = new BigUint64Array(1),
    kernel = new BigUint64Array(1),
    user = new BigUint64Array(1);
  const { api, ptr } = system;
  if (
    api.GetProcessId(handle) !== pid ||
    !api.GetProcessTimes(handle, ptr(start), ptr(exit), ptr(kernel), ptr(user)) ||
    start[0] === 0n
  )
    throw failure('identity_unknown', api.GetLastError());
  return start[0]!.toString();
}

/** Read-only original process object; OpenProcess failure is never absence. */
export function retainWindowsOwnedProcessObservation(pid: number): WindowsOwnedProcessObservation {
  if (!validPid(pid)) throw failure('invalid_pid');
  const system = native(),
    { api } = system;
  const handle = api.OpenProcess(0x101000, false, pid);
  let closed = false,
    born: string | undefined;
  const owner = { system, handle, keeper: handle === 0n ? undefined : setInterval(() => {}, 1000) };
  if (handle !== 0n) {
    retained.add(owner);
    try {
      born = creation(system, handle, pid);
    } catch {
      /* Explicit unknown. */
    }
  }
  const inspect = (): 'alive' | 'dead' | 'uncertain' => {
    if (closed || handle === 0n || born === undefined) return 'uncertain';
    try {
      if (creation(system, handle, pid) !== born) return 'uncertain';
      const wait = api.WaitForSingleObject(handle, 0);
      return wait === 0 ? 'dead' : wait === 258 ? 'alive' : 'uncertain';
    } catch {
      return 'uncertain';
    }
  };
  return Object.freeze({
    pid,
    creationTime: born,
    inspect,
    verify: () => inspect() === 'alive',
    close() {
      if (closed) return;
      if (handle !== 0n && !api.CloseHandle(handle))
        throw failure('close_unknown', api.GetLastError());
      closed = true;
      system.kernel.close();
      if (owner.keeper) clearInterval(owner.keeper);
      retained.delete(owner);
    },
  });
}

function quote(value: string): string {
  // CommandLineToArgv/CRT backslash-before-quote rule, including trailing slashes.
  return `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1')}"`;
}
function securityAttributes(sd = 0n, inherit = false): Buffer {
  const value = Buffer.alloc(24);
  value.writeUInt32LE(24, 0);
  value.writeBigUInt64LE(sd, 8);
  value.writeUInt32LE(inherit ? 1 : 0, 16);
  return value;
}

/** Owns only a fresh Job's members, not external broker launches or a filesystem sandbox. */
export function startWindowsOwnedChild(input: {
  executable: string;
  argv: readonly string[];
  cwd: string;
  env: Readonly<Record<string, string>>;
  stdin: 'pipe' | 'ignore';
}): WindowsOwnedChild {
  const absolute = (path: string) =>
    win32.isAbsolute(path) && (/^[A-Za-z]:[\\/]/.test(path) || /^\\\\[^\\]+\\[^\\]+\\/.test(path));
  if (
    !absolute(input.executable) ||
    !absolute(input.cwd) ||
    input.argv.length > 256 ||
    !['pipe', 'ignore'].includes(input.stdin) ||
    [input.executable, input.cwd, ...input.argv].some((value) => value.includes('\0')) ||
    Object.entries(input.env).length > 256 ||
    Object.entries(input.env).some(
      ([key, value]) =>
        !key ||
        key.includes('=') ||
        key.includes('\0') ||
        typeof value !== 'string' ||
        value.includes('\0'),
    )
  )
    throw failure('invalid_start');
  const command = wide([input.executable, ...input.argv].map(quote).join(' '));
  if (command.length > 65534) throw failure('invalid_start');
  const keys = Object.keys(input.env).sort((a, b) => {
    const left = a.toUpperCase(),
      right = b.toUpperCase();
    return left < right ? -1 : left > right ? 1 : 0;
  });
  if (new Set(keys.map((key) => key.toUpperCase())).size !== keys.length)
    throw failure('invalid_env');
  const environment = Buffer.from(
    `${keys.map((key) => `${key}=${input.env[key]}`).join('\0')}\0\0`,
    'utf16le',
  );
  if (environment.length > 1024 * 1024) throw failure('invalid_env');
  const system = native(),
    { api, ptr } = system;
  const handles = new Set<bigint>();
  const owner = {
    system,
    handles,
    pending: new Set<PendingWrite>(),
    memory: [] as unknown[],
    local: new Set<bigint>(),
    libraries: [] as { close(): void }[],
    keeper: setInterval(() => {}, 1000),
  };
  retained.add(owner);
  let job = 0n,
    processHandle = 0n,
    thread = 0n,
    stdinHandle = 0n;
  let pid = 0,
    born = '',
    exitCode: number | null = null,
    waited = false;
  let active: number | null = null,
    stopped = false,
    closed = false,
    closeUnknown = false;
  let admissionClosed = false,
    stopping = false,
    outputsClosed = false,
    queuedBytes = 0;
  let stopPromise: Promise<WindowsOwnedChildEvidence> | undefined;
  let closePromise: Promise<void> | undefined;
  let writeQueue = Promise.resolve();
  type PendingWrite = {
    handle: bigint;
    event: bigint;
    overlap: Buffer;
    bytes: Buffer;
    cancelled: boolean;
  };
  const check = (operation: string, success: boolean) => {
    if (!success) throw failure(operation, api.GetLastError());
  };
  const take = (operation: string, handle: bigint) => {
    if (handle === 0n || handle === INVALID) throw failure(operation, api.GetLastError());
    handles.add(handle);
    return handle;
  };
  const releaseNativeMemory = () => {
    for (const address of owner.local) {
      if (api.LocalFree(address) !== 0n)
        throw failure('security_close_unknown', api.GetLastError());
      owner.local.delete(address);
    }
    for (const library of owner.libraries) library.close();
    owner.libraries.length = 0;
  };
  const closeHandle = (handle: bigint) => {
    if (!handles.has(handle)) return;
    if (!api.CloseHandle(handle)) {
      closeUnknown = true;
      throw failure('close_unknown', api.GetLastError());
    }
    handles.delete(handle);
  };
  const snapshot = (): WindowsOwnedChildEvidence =>
    Object.freeze({
      version: 1,
      coverage: 'windows-job-members',
      root: Object.freeze({ pid, creationTime: born, exitCode, waitConfirmed: waited }),
      job: Object.freeze({ activeProcesses: active, treeStopped: stopped }),
      closed,
      closeUnknown,
    });
  const rootExit = () => {
    if (waited) return true;
    const wait = api.WaitForSingleObject(processHandle, 0);
    if (wait === 258) return false;
    if (wait !== 0) throw failure('wait_unknown', api.GetLastError());
    const code = new Uint32Array(1);
    check('exit_unknown', api.GetExitCodeProcess(processHandle, ptr(code)));
    exitCode = code[0]!;
    waited = true;
    return true;
  };
  const jobEmpty = () => {
    const accounting = Buffer.alloc(48);
    check('job_query_unknown', api.QueryInformationJobObject(job, 1, ptr(accounting), 48, null));
    active = accounting.readUInt32LE(40);
    return active === 0;
  };
  const cancelWrites = () => {
    for (const pending of owner.pending) {
      if (pending.cancelled) continue;
      if (!api.CancelIoEx(pending.handle, ptr(pending.overlap)) && api.GetLastError() !== 1168)
        throw failure('io_cancel_unknown', api.GetLastError());
      pending.cancelled = true;
    }
  };
  const stop = (options: { graceMs: number }): Promise<WindowsOwnedChildEvidence> => {
    if (!Number.isSafeInteger(options.graceMs) || options.graceMs < 0 || options.graceMs > 30000)
      return Promise.reject(failure('invalid_grace'));
    admissionClosed = true;
    stopping = true;
    if (stopPromise) return stopPromise;
    stopPromise = (async () => {
      cancelWrites();
      // Windows has no safe generic per-process SIGTERM. Grace permits natural exit;
      // force targets only this retained Job, never a console broadcast or numeric PID.
      const grace = Date.now() + options.graceMs;
      while (Date.now() < grace && !rootExit()) await delay();
      if (!jobEmpty()) check('terminate_unknown', api.TerminateJobObject(job, 1));
      const deadline = Date.now() + 5000;
      while (!rootExit() || !jobEmpty()) {
        if (Date.now() >= deadline) throw failure('stop_unknown');
        await delay();
      }
      stopped = true;
      return snapshot();
    })();
    void stopPromise.catch(() => {
      closeUnknown = true;
      stopPromise = undefined;
    });
    return stopPromise;
  };
  const settleWrites = async () => {
    const deadline = Date.now() + 1000;
    while (owner.pending.size) {
      for (const pending of owner.pending) {
        const count = new Uint32Array(1);
        const complete = api.GetOverlappedResult(
          pending.handle,
          ptr(pending.overlap),
          ptr(count),
          false,
        );
        if (!complete && api.GetLastError() !== 995) continue;
        owner.pending.delete(pending);
        closeHandle(pending.event);
      }
      if (owner.pending.size) {
        if (Date.now() >= deadline) throw failure('io_close_unknown');
        await delay();
      }
    }
  };
  const close = (): Promise<void> => {
    admissionClosed = true;
    if (closed) return Promise.resolve();
    if (closePromise) return closePromise;
    closePromise = (async () => {
      await stop({ graceMs: 0 });
      cancelWrites();
      await writeQueue;
      await settleWrites();
      outputsClosed = true;
      releaseNativeMemory();
      // Never release Job or root identity while any original I/O HANDLE is unknown.
      for (const handle of [...handles])
        if (handle !== job && handle !== processHandle && handle !== thread) closeHandle(handle);
      closeHandle(thread);
      closeHandle(processHandle);
      closeHandle(job);
      system.kernel.close();
      closed = true;
      closeUnknown = false;
      clearInterval(owner.keeper);
      retained.delete(owner);
    })();
    void closePromise.catch(() => {
      closeUnknown = true;
      closePromise = undefined;
    });
    return closePromise;
  };
  const output = (handle: bigint): AsyncIterable<Uint8Array> => {
    let consumed = false;
    return {
      async *[Symbol.asyncIterator]() {
        if (consumed) throw failure('output_consumer_conflict');
        consumed = true;
        while (!outputsClosed) {
          const available = new Uint32Array(1);
          if (!api.PeekNamedPipe(handle, null, 0, null, ptr(available), null)) {
            if ([109, 232].includes(api.GetLastError())) return;
            throw failure('output_unknown', api.GetLastError());
          }
          if (!available[0]) {
            await delay();
            continue;
          }
          const bytes = Buffer.alloc(Math.min(available[0]!, 32768)),
            read = new Uint32Array(1);
          check('output_unknown', api.ReadFile(handle, ptr(bytes), bytes.length, ptr(read), null));
          if (!read[0] || read[0] > bytes.length) throw failure('output_unknown');
          yield bytes.subarray(0, read[0]);
        }
      },
    };
  };
  const write = async (bytes: Buffer) => {
    for (let offset = 0; offset < bytes.length; ) {
      if (stopping || !handles.has(stdinHandle)) throw failure('stdin_closed');
      const chunk = bytes.subarray(offset, offset + 32768);
      const event = take('io_event', api.CreateEventW(null, true, false, null));
      const overlap = Buffer.alloc(32);
      overlap.writeBigUInt64LE(event, 24);
      const pending: PendingWrite = {
        handle: stdinHandle,
        event,
        overlap,
        bytes: chunk,
        cancelled: false,
      };
      owner.pending.add(pending);
      const count = new Uint32Array(1);
      let complete = false;
      try {
        const ok = api.WriteFile(stdinHandle, ptr(chunk), chunk.length, ptr(count), ptr(overlap));
        if (!ok && api.GetLastError() !== 997) {
          complete = true;
          throw failure('stdin_write', api.GetLastError());
        }
        const deadline = Date.now() + 5000;
        let cancelling = false,
          cancelDeadline = 0;
        while (!api.GetOverlappedResult(stdinHandle, ptr(overlap), ptr(count), false)) {
          const error = api.GetLastError();
          if (error !== 996) {
            complete = error === 995;
            throw failure('stdin_write', error);
          }
          if (!cancelling && (stopping || Date.now() >= deadline)) {
            check(
              'io_cancel_unknown',
              api.CancelIoEx(stdinHandle, ptr(overlap)) || api.GetLastError() === 1168,
            );
            pending.cancelled = true;
            cancelling = true;
            cancelDeadline = Date.now() + 1000;
          }
          if (cancelling && Date.now() >= cancelDeadline) throw failure('io_completion_unknown');
          await delay();
        }
        complete = true;
        if (count[0] === 0 || count[0]! > chunk.length) throw failure('stdin_write');
        offset += count[0]!;
      } finally {
        // Pending buffers/event stay strongly owned until real completion, including cancellation.
        if (complete) {
          owner.pending.delete(pending);
          closeHandle(event);
        }
      }
    }
  };
  let stdoutHandle = 0n,
    stderrHandle = 0n;
  let attribute: Buffer | undefined,
    attributeReady = false;
  try {
    job = take('job_create', api.CreateJobObjectW(null, null));
    const limits = Buffer.alloc(144);
    limits.writeUInt32LE(0x2000, 16); // KILL_ON_JOB_CLOSE only.
    check('job_configure', api.SetInformationJobObject(job, 9, ptr(limits), limits.length));
    const sa = securityAttributes(0n, true);
    const makeOutput = () => {
      const read = new BigUint64Array(1),
        write = new BigUint64Array(1);
      check('pipe_create', api.CreatePipe(ptr(read), ptr(write), ptr(sa), 0));
      const reader = take('pipe_create', read[0]!),
        writer = take('pipe_create', write[0]!);
      check('pipe_inherit', api.SetHandleInformation(reader, 1, 0));
      return { reader, writer };
    };
    const out = makeOutput(),
      err = makeOutput();
    stdoutHandle = out.reader;
    stderrHandle = err.reader;
    let childStdin: bigint;
    if (input.stdin === 'ignore') {
      const nullDevice = wide('NUL');
      owner.memory.push(nullDevice);
      childStdin = take(
        'null_open',
        api.CreateFileW(ptr(nullDevice), 0x80000000, 3, ptr(sa), 3, 0, 0n),
      );
    } else {
      // A private first-instance named pipe is needed: anonymous WriteFile cannot be overlapped.
      const { dlopen, ptr: nativePtr } = require('bun:ffi') as typeof import('bun:ffi');
      const adv = dlopen('advapi32.dll', {
        OpenProcessToken: { args: ['u64', 'u32', 'ptr'], returns: 'bool' },
        GetTokenInformation: { args: ['u64', 'u32', 'ptr', 'u32', 'ptr'], returns: 'bool' },
        ConvertSidToStringSidW: { args: ['ptr', 'ptr'], returns: 'bool' },
        ConvertStringSecurityDescriptorToSecurityDescriptorW: {
          args: ['ptr', 'u32', 'ptr', 'ptr'],
          returns: 'bool',
        },
      });
      owner.memory.push(adv);
      owner.libraries.push(adv);
      const token = new BigUint64Array(1),
        size = new Uint32Array(1);
      check(
        'token_open',
        adv.symbols.OpenProcessToken(api.GetCurrentProcess(), 8, nativePtr(token)),
      );
      take('token_open', token[0]!);
      adv.symbols.GetTokenInformation(token[0]!, 1, null, 0, nativePtr(size));
      if (!size[0] || size[0] > 16384) throw failure('token_unknown');
      const user = Buffer.alloc(size[0]!);
      owner.memory.push(user);
      check(
        'token_read',
        adv.symbols.GetTokenInformation(
          token[0]!,
          1,
          nativePtr(user),
          user.length,
          nativePtr(size),
        ),
      );
      const sid = new BigUint64Array(1),
        sd = new BigUint64Array(1);
      check(
        'sid_read',
        adv.symbols.ConvertSidToStringSidW(
          Number(user.readBigUInt64LE(0)) as import('bun:ffi').Pointer,
          nativePtr(sid),
        ),
      );
      owner.memory.push(sid, sd);
      owner.local.add(sid[0]!);
      let text = '';
      for (let index = 0; index < 184; index++) {
        const char = new DataView(
          system.toArrayBuffer(Number(sid[0]!) as import('bun:ffi').Pointer, index * 2, 2),
        ).getUint16(0, true);
        if (!char) break;
        text += String.fromCharCode(char);
      }
      if (!/^S-1-(?:\d+-)*\d+$/.test(text)) throw failure('sid_unknown');
      const sddl = wide(`O:${text}D:P(A;;FA;;;${text})`);
      owner.memory.push(sddl);
      check(
        'descriptor_create',
        adv.symbols.ConvertStringSecurityDescriptorToSecurityDescriptorW(
          nativePtr(sddl),
          1,
          nativePtr(sd),
          null,
        ),
      );
      owner.local.add(sd[0]!);
      const privateSA = securityAttributes(sd[0]!),
        childSA = securityAttributes(sd[0]!, true);
      const name = wide(`\\\\.\\pipe\\kite-owned-stdin-${randomUUID().replaceAll('-', '')}`);
      owner.memory.push(privateSA, childSA, name);
      stdinHandle = take(
        'stdin_create',
        api.CreateNamedPipeW(ptr(name), 0x40080002, 8, 1, 32768, 32768, 0, ptr(privateSA)),
      );
      childStdin = take(
        'stdin_connect',
        api.CreateFileW(ptr(name), 0x80000000, 0, ptr(childSA), 3, 0, 0n),
      );
      const connected = Buffer.alloc(32);
      const connectionEvent = take('io_event', api.CreateEventW(null, true, false, null));
      connected.writeBigUInt64LE(connectionEvent, 24);
      owner.memory.push(connected);
      const connectionOk = api.ConnectNamedPipe(stdinHandle, ptr(connected));
      const connectionError = connectionOk ? 0 : api.GetLastError();
      if (!connectionOk && connectionError !== 535) {
        if (connectionError === 997)
          owner.pending.add({
            handle: stdinHandle,
            event: connectionEvent,
            overlap: connected,
            bytes: Buffer.alloc(0),
            cancelled: false,
          });
        throw failure('stdin_connect', connectionError);
      }
      closeHandle(connectionEvent);
      releaseNativeMemory();
      closeHandle(token[0]!);
      owner.memory.splice(owner.memory.indexOf(adv), 1);
    }
    const inherited = BigUint64Array.from([childStdin, out.writer, err.writer]);
    const bytes = new BigUint64Array(1);
    api.InitializeProcThreadAttributeList(null, 1, 0, ptr(bytes));
    if (bytes[0] === 0n || bytes[0]! > 65536n) throw failure('attribute_size');
    attribute = Buffer.alloc(Number(bytes[0]));
    check(
      'attribute_init',
      api.InitializeProcThreadAttributeList(ptr(attribute), 1, 0, ptr(bytes)),
    );
    attributeReady = true;
    check(
      'attribute_handles',
      api.UpdateProcThreadAttribute(ptr(attribute), 0, 0x20002n, ptr(inherited), 24n, null, null),
    );
    const startup = Buffer.alloc(112),
      info = Buffer.alloc(24);
    startup.writeUInt32LE(112, 0);
    startup.writeUInt32LE(0x100, 60);
    startup.writeBigUInt64LE(childStdin, 80);
    startup.writeBigUInt64LE(out.writer, 88);
    startup.writeBigUInt64LE(err.writer, 96);
    startup.writeBigUInt64LE(BigInt(ptr(attribute)), 104);
    const executable = wide(input.executable),
      cwd = wide(input.cwd);
    owner.memory.push(attribute, inherited, startup, info, command, environment, executable, cwd);
    check(
      'create',
      api.CreateProcessW(
        ptr(executable),
        ptr(command),
        null,
        null,
        true,
        0x80404,
        ptr(environment),
        ptr(cwd),
        ptr(startup),
        ptr(info),
      ),
    );
    processHandle = take('create_process', info.readBigUInt64LE(0));
    thread = take('create_thread', info.readBigUInt64LE(8));
    pid = info.readUInt32LE(16);
    if (!validPid(pid)) throw failure('identity_unknown');
    born = creation(system, processHandle, pid);
    check('assign', api.AssignProcessToJobObject(job, processHandle));
    closeHandle(childStdin);
    closeHandle(out.writer);
    closeHandle(err.writer);
    if (api.ResumeThread(thread) !== 1) throw failure('resume_unknown', api.GetLastError());
  } catch (error) {
    admissionClosed = true;
    // The suspended process may exist even when assignment failed. Target its original H.
    if (processHandle) api.TerminateProcess(processHandle, 1);
    const cleanup = (async () => {
      if (processHandle) {
        const deadline = Date.now() + 5000;
        while (!rootExit()) {
          if (Date.now() >= deadline) throw failure('start_close_unknown');
          await delay();
        }
      }
      if (job) {
        if (!jobEmpty()) api.TerminateJobObject(job, 1);
        const deadline = Date.now() + 5000;
        while (!jobEmpty()) {
          if (Date.now() >= deadline) throw failure('start_close_unknown');
          await delay();
        }
      }
      cancelWrites();
      await settleWrites();
      releaseNativeMemory();
      for (const handle of [...handles]) if (handle !== job) closeHandle(handle);
      closeHandle(job);
      system.kernel.close();
      clearInterval(owner.keeper);
      retained.delete(owner);
    })();
    void cleanup.catch(() => {
      closeUnknown = true; /* Original owner and keeper remain. */
    });
    throw new WindowsOwnedChildStartError(error, cleanup);
  } finally {
    if (attributeReady) api.DeleteProcThreadAttributeList(ptr(attribute!));
  }
  const exited = (async () => {
    while (!rootExit()) await delay();
    // Natural root exit owns the same descendant stop path as explicit cancellation.
    void stop({ graceMs: 0 }).catch(() => {});
    return exitCode!;
  })();
  void exited.catch(() => {
    closeUnknown = true;
  });
  return Object.freeze({
    pid,
    rootCreationTime: born,
    stdout: output(stdoutHandle),
    stderr: output(stderrHandle),
    exited,
    readEvidence: snapshot,
    stop,
    close,
    writeStdin(bytes: Uint8Array) {
      if (
        admissionClosed ||
        input.stdin !== 'pipe' ||
        !(bytes instanceof Uint8Array) ||
        bytes.length > 1024 * 1024 ||
        queuedBytes + bytes.length > 1024 * 1024
      )
        return Promise.reject(failure('stdin_closed'));
      const owned = Buffer.from(bytes);
      queuedBytes += owned.length;
      const operation = writeQueue
        .then(() => write(owned))
        .finally(() => {
          queuedBytes -= owned.length;
        });
      // Preserve serialization after an ordinary broken-pipe result; pending native I/O stays owned.
      writeQueue = operation.catch(() => {});
      return operation;
    },
    async endStdin() {
      admissionClosed = true;
      await writeQueue;
      await settleWrites();
      if (stdinHandle) closeHandle(stdinHandle);
    },
  });
}
