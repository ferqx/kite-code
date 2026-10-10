import { randomBytes } from 'node:crypto';
import { retainWindowsProcess, type WindowsProcessObservation } from './daemon/windows-process';
import { windowsDaemonSecurity } from './daemon/windows-security';
import { retainWindowsNativeLauncherParent } from './windows-native-parent';

const retained = new Set<object>();
const error = (code = 'windows_native_handoff_unavailable') => Object.assign(Error(code), { code });
const delay = () => new Promise<void>((resolve) => setTimeout(resolve, 10));
type Handle = bigint | number;
const validHandle = (handle: Handle) =>
  typeof handle === 'bigint'
    ? handle > 0n && handle !== 0xffffffffffffffffn
    : Number.isSafeInteger(handle) && handle > 0;
const wide = (value: string) => Buffer.from(`${value}\0`, 'utf16le');
function native() {
  if (process.platform !== 'win32' || process.arch !== 'x64')
    throw error('windows_native_handoff_platform_unsupported');
  const { dlopen, ptr } = require('bun:ffi') as typeof import('bun:ffi');
  const kernel = dlopen('kernel32.dll', {
    GetLastError: { args: [], returns: 'u32' },
    CreateNamedPipeW: {
      args: ['ptr', 'u32', 'u32', 'u32', 'u32', 'u32', 'u32', 'ptr'],
      returns: 'u64',
    },
    CreateFileW: { args: ['ptr', 'u32', 'u32', 'ptr', 'u32', 'u32', 'u64'], returns: 'u64' },
    CreateEventW: { args: ['ptr', 'bool', 'bool', 'ptr'], returns: 'u64' },
    ConnectNamedPipe: { args: ['u64', 'ptr'], returns: 'bool' },
    DisconnectNamedPipe: { args: ['u64'], returns: 'bool' },
    ReadFile: { args: ['u64', 'ptr', 'u32', 'ptr', 'ptr'], returns: 'bool' },
    WriteFile: { args: ['u64', 'ptr', 'u32', 'ptr', 'ptr'], returns: 'bool' },
    GetOverlappedResult: { args: ['u64', 'ptr', 'ptr', 'bool'], returns: 'bool' },
    CancelIoEx: { args: ['u64', 'ptr'], returns: 'bool' },
    CloseHandle: { args: ['u64'], returns: 'bool' },
    GetNamedPipeServerProcessId: { args: ['u64', 'ptr'], returns: 'bool' },
    GetNamedPipeClientProcessId: { args: ['u64', 'ptr'], returns: 'bool' },
  });
  return { k: kernel.symbols, ptr };
}
let backend: ReturnType<typeof native> | undefined;
const api = () => (backend ??= native());
class Owner {
  readonly handles = new Set<Handle>();
  readonly operations = new Set<{
    handle: Handle;
    overlap: Uint8Array;
    bytes?: Uint8Array;
    event: Handle;
  }>();
  stopped = false;
  constructor() {
    retained.add(this);
  }
  closeHandle(handle: Handle) {
    if (!api().k.CloseHandle(handle)) throw error('windows_native_handoff_close_unknown');
    this.handles.delete(handle);
  }
  async io(
    handle: Handle,
    kind: 'connect' | 'read' | 'write',
    bytes?: Uint8Array,
    deadline = Date.now() + 5000,
  ): Promise<number> {
    const { k, ptr } = api();
    const event = k.CreateEventW(null, true, false, null);
    if (!validHandle(event)) throw error('windows_native_handoff_unavailable');
    this.handles.add(event);
    const overlap = new Uint8Array(32);
    new DataView(overlap.buffer).setBigUint64(24, BigInt(event), true);
    const op = { handle, overlap, bytes, event };
    this.operations.add(op);
    const count = new Uint32Array(1);
    let settled = false;
    try {
      const ok =
        kind === 'connect'
          ? k.ConnectNamedPipe(handle, ptr(overlap))
          : kind === 'read'
            ? k.ReadFile(handle, ptr(bytes!), bytes!.length, ptr(count), ptr(overlap))
            : k.WriteFile(handle, ptr(bytes!), bytes!.length, ptr(count), ptr(overlap));
      if (ok || (kind === 'connect' && k.GetLastError() === 535)) {
        settled = true;
        return count[0]!;
      }
      if (k.GetLastError() !== 997) {
        settled = true;
        throw error(
          k.GetLastError() === 109
            ? 'windows_native_handoff_peer_closed'
            : 'windows_native_handoff_unavailable',
        );
      }
      let cancellation = false,
        cancelDeadline = 0,
        cancellationCode = 'windows_native_handoff_timeout';
      for (;;) {
        if (k.GetOverlappedResult(handle, ptr(overlap), ptr(count), false)) {
          settled = true;
          if (cancellation) throw error(cancellationCode);
          return count[0]!;
        }
        const code = k.GetLastError();
        if (code !== 996) {
          settled = true;
          throw error(
            cancellation
              ? cancellationCode
              : code === 995 && this.stopped
                ? 'windows_native_handoff_cancelled'
                : code === 109
                  ? 'windows_native_handoff_peer_closed'
                  : 'windows_native_handoff_unavailable',
          );
        }
        if (!cancellation && (this.stopped || Date.now() >= deadline)) {
          k.CancelIoEx(handle, ptr(overlap));
          cancellation = true;
          cancellationCode = this.stopped
            ? 'windows_native_handoff_cancelled'
            : 'windows_native_handoff_timeout';
          cancelDeadline = Date.now() + 5000;
        }
        if (cancellation && Date.now() >= cancelDeadline)
          throw error('windows_native_handoff_close_unknown');
        await delay();
      }
    } finally {
      // Neither cancellation nor a timeout proves that the kernel released these buffers.
      if (settled) {
        this.operations.delete(op);
        this.closeHandle(event);
      }
    }
  }
  seal() {
    this.stopped = true;
    const { k, ptr } = api();
    for (const op of this.operations) k.CancelIoEx(op.handle, ptr(op.overlap));
  }
  release() {
    if (this.operations.size) throw error('windows_native_handoff_close_unknown');
    const failures: unknown[] = [];
    for (const handle of this.handles) {
      try {
        this.closeHandle(handle);
      } catch (e) {
        failures.push(e);
      }
    }
    if (failures.length) throw new AggregateError(failures, 'windows_native_handoff_close_unknown');
    retained.delete(this);
  }
}
function validatePipe(pipe: string, kind: 'launch' | 'main') {
  const prefix = `\\\\.\\pipe\\kite-native-${kind}-`;
  if (!pipe.startsWith(prefix) || !/^[a-f0-9]{32}$/.test(pipe.slice(prefix.length)))
    throw error('windows_native_handoff_invalid_certificate');
}
function certificate(magic: 'KITELCH1' | 'KITEMAI1', pid: number, birth: bigint) {
  const bytes = new Uint8Array(32),
    view = new DataView(bytes.buffer);
  bytes.set(Buffer.from(magic, 'ascii'));
  view.setUint32(8, pid, true);
  view.setBigUint64(16, birth, true);
  return bytes;
}
function checkCertificate(
  bytes: Uint8Array,
  magic: 'KITELCH1' | 'KITEMAI1',
  pid: number,
  birth: bigint,
) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (
    bytes.length !== 32 ||
    Buffer.from(bytes.subarray(0, 8)).toString('ascii') !== magic ||
    view.getUint32(8, true) !== pid ||
    view.getUint32(12, true) !== 0 ||
    view.getBigUint64(16, true) !== birth ||
    view.getBigUint64(24, true) !== 0n
  )
    throw error('windows_native_handoff_invalid_certificate');
}
async function readCertificate(owner: Owner, handle: Handle, deadline: number) {
  const bytes = new Uint8Array(32);
  for (let offset = 0; offset < bytes.length; ) {
    const count = await owner.io(handle, 'read', bytes.subarray(offset), deadline);
    if (count < 1 || count > bytes.length - offset)
      throw error('windows_native_handoff_invalid_certificate');
    offset += count;
  }
  return bytes;
}
function unknown(errors: unknown[]) {
  return Object.assign(new AggregateError(errors, 'windows_native_handoff_close_unknown'), {
    code: 'windows_native_handoff_close_unknown',
  });
}
/** Private certificate binds the actual creator, in addition to the original parent process object. */
export async function retainWindowsNativeLaunchCertificate(
  prefix: string,
  kind: 'cli' | 'tui' | 'desktop',
  launcherPipe: string,
) {
  validatePipe(launcherPipe, 'launch');
  const parent = retainWindowsNativeLauncherParent(prefix, kind),
    owner = new Owner();
  const lease = { parent, owner };
  retained.add(lease);
  let released = false;
  const release = () => {
    if (released) return;
    try {
      owner.release();
    } catch (e) {
      throw unknown([e]);
    }
    try {
      parent.release();
    } catch (e) {
      throw unknown([e]);
    }
    released = true;
    retained.delete(lease);
  };
  try {
    const { k, ptr } = api(),
      deadline = Date.now() + 5000;
    const handle = k.CreateFileW(ptr(wide(launcherPipe)), 0x120089, 0, null, 3, 0x40110000, 0);
    if (!validHandle(handle)) throw error();
    owner.handles.add(handle);
    windowsDaemonSecurity().verifyPipe(handle);
    const pid = new Uint32Array(1);
    if (!k.GetNamedPipeServerProcessId(handle, ptr(pid)) || pid[0] !== parent.parentPid)
      throw error('windows_native_handoff_creator_mismatch');
    parent.verify();
    const bytes = await readCertificate(owner, handle, deadline);
    checkCertificate(bytes, 'KITELCH1', parent.selfPid, parent.selfCreationTime);
    parent.verify();
    // Closing the original client object acknowledges consumption to the C server.
    owner.closeHandle(handle);
    return Object.freeze({
      verify() {
        if (released) throw error('windows_native_handoff_released');
        parent.verify();
      },
      release,
    });
  } catch (e) {
    owner.seal();
    try {
      release();
    } catch (cleanup) {
      throw unknown([e, cleanup]);
    }
    throw e;
  }
}
/** Reserve before spawn; bind only the actual ChildProcess PID returned by the host. */
export function createWindowsNativeMainHandoff() {
  const { k, ptr } = api(),
    security = windowsDaemonSecurity(),
    owner = new Owner();
  const pipe = `\\\\.\\pipe\\kite-native-main-${randomBytes(16).toString('hex')}`;
  let processOwner: WindowsProcessObservation | undefined,
    childPid = 0,
    birth = 0n,
    handle: Handle | undefined;
  let closed = false,
    failure: unknown;
  const lease = {
    owner,
    get processOwner() {
      return processOwner;
    },
  };
  retained.add(lease);
  const release = () => {
    try {
      owner.release();
    } catch (e) {
      throw unknown([e]);
    }
    try {
      processOwner?.close();
    } catch (e) {
      throw unknown([e]);
    }
    closed = true;
    retained.delete(lease);
  };
  try {
    const descriptor = security.descriptor(false);
    try {
      const created = k.CreateNamedPipeW(
        ptr(wide(pipe)),
        3 | 0x40000000 | 0x80000,
        8,
        1,
        32,
        1,
        5000,
        ptr(descriptor.attributes),
      );
      if (!validHandle(created)) throw error();
      handle = created;
      owner.handles.add(created);
      security.verifyPipe(created);
    } finally {
      descriptor.close();
    }
  } catch (e) {
    try {
      release();
    } catch (cleanup) {
      throw unknown([e, cleanup]);
    }
    throw e;
  }
  const original = handle!;
  const task = (async () => {
    const deadline = Date.now() + 5000;
    await owner.io(original, 'connect', undefined, deadline);
    while (!processOwner && !owner.stopped && Date.now() < deadline) await delay();
    if (owner.stopped) return;
    if (processOwner?.inspect() !== 'alive') throw error('windows_native_handoff_child_mismatch');
    const peer = new Uint32Array(1);
    if (!k.GetNamedPipeClientProcessId(original, ptr(peer)) || peer[0] !== childPid)
      throw error('windows_native_handoff_child_mismatch');
    const bytes = certificate('KITEMAI1', childPid, birth);
    for (let offset = 0; offset < bytes.length; ) {
      if (processOwner.inspect() !== 'alive') throw error('windows_native_handoff_child_mismatch');
      const count = await owner.io(original, 'write', bytes.subarray(offset), deadline);
      if (count < 1 || count > bytes.length - offset) throw error();
      offset += count;
    }
    // WriteFile completion does not prove receipt; wait for the original peer to close.
    try {
      const count = await owner.io(original, 'read', new Uint8Array(1), deadline);
      if (count !== 0) throw error('windows_native_handoff_invalid_certificate');
    } catch (e) {
      if (!(e instanceof Error) || e.message !== 'windows_native_handoff_peer_closed') throw e;
    }
    if (!k.DisconnectNamedPipe(original)) throw error();
  })().catch((e) => {
    if (!(owner.stopped && e instanceof Error && e.message === 'windows_native_handoff_cancelled'))
      failure = e;
  });
  let closing: Promise<void> | undefined;
  return Object.freeze({
    pipe,
    bind(pid: number) {
      if (
        closed ||
        owner.stopped ||
        processOwner ||
        !Number.isSafeInteger(pid) ||
        pid < 1 ||
        pid > 2147483647
      )
        throw error('windows_native_handoff_child_mismatch');
      // Register before validation so failed acquisition/CloseHandle cannot lose its original object.
      processOwner = retainWindowsProcess(pid);
      const identity = processOwner.identity;
      if (
        !identity ||
        !/^windows:filetime:[1-9][0-9]{0,19}$/.test(identity) ||
        processOwner.inspect() !== 'alive'
      )
        throw error('windows_native_handoff_child_mismatch');
      childPid = pid;
      birth = BigInt(identity.slice('windows:filetime:'.length));
    },
    close() {
      if (closed) return Promise.resolve();
      if (closing) return closing;
      owner.seal();
      closing = (async () => {
        await task;
        const failures: unknown[] = [];
        if (failure !== undefined) failures.push(failure);
        try {
          release();
        } catch (e) {
          failures.push(e);
        }
        if (failures.length) throw unknown(failures);
      })();
      // A confirmed failed close remains retryable; no rejected promise is left unobserved.
      closing.catch(() => {
        closing = undefined;
      });
      return closing;
    },
  });
}
