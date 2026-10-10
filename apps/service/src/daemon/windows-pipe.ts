import { retainWindowsProcess } from './windows-process';
import { windowsDaemonSecurity } from './windows-security';

const limit = 16384;
const pendingOwners = new Set<object>();
const error = (code: string) => Object.assign(Error(code), { code });
const delay = () => new Promise<void>((resolve) => setTimeout(resolve, 10));
function validate(pipe: string) {
  if (!/^\\\\\.\\pipe\\kite-daemon-[a-z0-9-]+$/.test(pipe) || pipe.length > 256)
    throw error('daemon_invalid_endpoint');
}
function native() {
  if (process.platform !== 'win32' || process.arch !== 'x64')
    throw error('daemon_platform_unsupported');
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
    WaitNamedPipeW: { args: ['ptr', 'u32'], returns: 'bool' },
    GetNamedPipeServerProcessId: { args: ['u64', 'ptr'], returns: 'bool' },
  });
  return { k: kernel.symbols, ptr };
}
let backend: ReturnType<typeof native> | undefined;
const api = () => (backend ??= native());
const invalid = 18446744073709551615n;
type Handle = bigint | number;
const validHandle = (handle: Handle) =>
  typeof handle === 'bigint'
    ? handle > 0n && handle !== invalid
    : Number.isSafeInteger(handle) && handle > 0;
const wide = (value: string) => Buffer.from(`${value}\0`, 'utf16le');
/** Exact local namespace observation; permission failures never imply absence. */
export function windowsPipeExists(pipe: string): boolean {
  validate(pipe);
  const { k, ptr } = api();
  if (k.WaitNamedPipeW(ptr(wide(pipe)), 1)) return true;
  const code = k.GetLastError();
  if (code === 2) return false;
  if (code === 121 || code === 231) return true;
  throw error('daemon_identity_unknown');
}
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
    pendingOwners.add(this);
  }
  closeHandle(handle: Handle) {
    if (!api().k.CloseHandle(handle)) throw error('daemon_endpoint_close_unknown');
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
    if (!validHandle(event)) throw error('daemon_unavailable');
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
        throw error(k.GetLastError() === 109 ? 'daemon_peer_closed' : 'daemon_unavailable');
      }
      let cancellation = false,
        cancelDeadline = 0;
      for (;;) {
        if (k.GetOverlappedResult(handle, ptr(overlap), ptr(count), false)) {
          settled = true;
          if (cancellation) throw error('daemon_bootstrap_timeout');
          return count[0]!;
        }
        const code = k.GetLastError();
        if (code !== 996) {
          settled = true;
          throw error(
            cancellation
              ? 'daemon_bootstrap_timeout'
              : code === 109
                ? 'daemon_peer_closed'
                : 'daemon_unavailable',
          );
        }
        if (!cancellation && (this.stopped || Date.now() >= deadline)) {
          k.CancelIoEx(handle, ptr(overlap));
          cancellation = true;
          cancelDeadline = Date.now() + 5000;
        }
        if (cancellation && Date.now() >= cancelDeadline)
          throw error('daemon_endpoint_close_unknown');
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
    if (this.operations.size) throw error('daemon_endpoint_close_unknown');
    const failures: unknown[] = [];
    for (const handle of this.handles) {
      try {
        this.closeHandle(handle);
      } catch (e) {
        failures.push(e);
      }
    }
    if (failures.length) throw new AggregateError(failures, 'daemon_endpoint_close_unknown');
    pendingOwners.delete(this);
  }
}
async function readFrame(owner: Owner, handle: Handle, deadline: number) {
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const bytes = new Uint8Array(limit + 1 - size);
    const count = await owner.io(handle, 'read', bytes, deadline);
    if (count < 1 || count > bytes.length) throw error('daemon_invalid_bootstrap');
    const part = bytes.slice(0, count);
    size += count;
    if (size > limit) throw error('daemon_invalid_bootstrap');
    parts.push(part);
    const newline = part.indexOf(10);
    if (newline >= 0) {
      if (newline !== part.length - 1) throw error('daemon_invalid_bootstrap');
      return new Uint8Array(Buffer.concat(parts));
    }
  }
}
function frame(bytes: Uint8Array) {
  if (
    !bytes.length ||
    bytes.length > limit ||
    bytes.at(-1) !== 10 ||
    bytes.subarray(0, -1).includes(10)
  )
    throw error('daemon_invalid_bootstrap');
}
async function writeFrame(owner: Owner, handle: Handle, bytes: Uint8Array, deadline: number) {
  frame(bytes);
  for (let offset = 0; offset < bytes.length; ) {
    const count = await owner.io(handle, 'write', bytes.subarray(offset), deadline);
    if (count < 1 || count > bytes.length - offset) throw error('daemon_unavailable');
    offset += count;
  }
}
export function createWindowsDaemonPipe(pipe: string) {
  validate(pipe);
  const { k, ptr } = api(),
    security = windowsDaemonSecurity(),
    owner = new Owner();
  const create = (first: boolean) => {
    const descriptor = security.descriptor(false);
    try {
      const handle = k.CreateNamedPipeW(
        ptr(wide(pipe)),
        3 | 0x40000000 | (first ? 0x80000 : 0),
        8,
        64,
        limit,
        limit,
        5000,
        ptr(descriptor.attributes),
      );
      if (!validHandle(handle)) throw error(first ? 'daemon_endpoint_busy' : 'daemon_unavailable');
      owner.handles.add(handle);
      security.verifyPipe(handle);
      return handle;
    } finally {
      descriptor.close();
    }
  };
  let first: Handle;
  try {
    first = create(true);
  } catch (e) {
    try {
      owner.release();
    } catch (cleanup) {
      throw new AggregateError([e, cleanup], 'daemon_endpoint_close_unknown');
    }
    throw e;
  }
  const tasks: Promise<void>[] = [];
  let listening = false,
    closeTask: Promise<void> | undefined;
  return Object.freeze({
    async listen(respond: (request: Uint8Array) => Uint8Array | null) {
      if (listening || owner.stopped) throw error('daemon_endpoint_state');
      listening = true;
      const serve = async (handle: Handle) => {
        while (!owner.stopped) {
          try {
            await owner.io(handle, 'connect', undefined, Number.POSITIVE_INFINITY);
            if (owner.stopped) break;
            security.verifyPipe(handle);
            const deadline = Date.now() + 5000;
            const response = respond(await readFrame(owner, handle, deadline));
            if (response) {
              await writeFrame(owner, handle, response, deadline);
              // Write completion is not peer receipt. Preserve unread output until peer closes.
              try {
                const trailing = await owner.io(handle, 'read', new Uint8Array(1), deadline);
                if (trailing !== 0) throw error('daemon_invalid_bootstrap');
              } catch (e) {
                if ((e as { code?: string }).code !== 'daemon_peer_closed') throw e;
              }
            }
          } catch (e) {
            if (
              [...owner.operations].some((op) => op.handle === handle) ||
              (e as { code?: string }).code === 'daemon_endpoint_close_unknown'
            ) {
              owner.seal();
              throw e;
            }
          }
          if (!owner.stopped && !k.DisconnectNamedPipe(handle)) {
            if (k.GetLastError() !== 233) {
              owner.seal();
              throw error('daemon_endpoint_close_unknown');
            }
          }
        }
      };
      try {
        for (let index = 0; index < 64; index++) {
          const task = serve(index === 0 ? first : create(false));
          tasks.push(task);
          void task.catch(() => {});
        }
      } catch (e) {
        owner.seal();
        throw e;
      }
    },
    close() {
      closeTask ??= (async () => {
        owner.seal();
        const settled = await Promise.allSettled(tasks);
        const failures = settled
          .filter((item): item is PromiseRejectedResult => item.status === 'rejected')
          .map((item) => item.reason);
        try {
          owner.release();
        } catch (e) {
          failures.push(e);
        }
        if (failures.length) throw new AggregateError(failures, 'daemon_endpoint_close_unknown');
      })();
      return closeTask;
    },
  });
}
export async function requestWindowsDaemonPipe(
  pipe: string,
  expected: { pid: number; processStartIdentity: string },
  request: Uint8Array,
): Promise<Uint8Array> {
  validate(pipe);
  frame(request);
  const { k, ptr } = api(),
    owner = new Owner(),
    deadline = Date.now() + 5000;
  let processOwner: ReturnType<typeof retainWindowsProcess> | undefined;
  let result: Uint8Array | undefined, failure: unknown;
  try {
    let handle: Handle;
    for (;;) {
      handle = k.CreateFileW(ptr(wide(pipe)), 0x12019b, 0, null, 3, 0x40110000, 0);
      if (validHandle(handle)) break;
      if (k.GetLastError() !== 231) throw error('daemon_unavailable');
      if (Date.now() >= deadline) throw error('daemon_bootstrap_timeout');
      await delay();
    }
    owner.handles.add(handle);
    windowsDaemonSecurity().verifyPipe(handle);
    const pid = new Uint32Array(1);
    if (!k.GetNamedPipeServerProcessId(handle, ptr(pid)) || pid[0] !== expected.pid)
      throw error('daemon_identity_mismatch');
    processOwner = retainWindowsProcess(expected.pid, expected.processStartIdentity);
    if (
      processOwner.identity !== expected.processStartIdentity ||
      processOwner.inspect() !== 'alive'
    )
      throw error('daemon_identity_mismatch');
    await writeFrame(owner, handle, request, deadline);
    result = await readFrame(owner, handle, deadline);
    if (processOwner.inspect() !== 'alive') throw error('daemon_identity_mismatch');
  } catch (e) {
    failure = e;
  }
  owner.seal();
  try {
    owner.release();
  } catch (e) {
    pendingOwners.add({ owner, processOwner });
    failure = failure ? new AggregateError([failure, e], 'daemon_endpoint_close_unknown') : e;
  }
  try {
    processOwner?.close();
  } catch (e) {
    pendingOwners.add({ processOwner });
    failure = failure ? new AggregateError([failure, e], 'daemon_endpoint_close_unknown') : e;
  }
  if (failure) throw failure;
  return result!;
}
