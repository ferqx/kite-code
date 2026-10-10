import { realpathSync } from 'node:fs';
import { win32 } from 'node:path';

const retained = new Set<object>();
const invalid = 18446744073709551615n;
type Handle = bigint | number;
const valid = (handle: Handle) =>
  typeof handle === 'bigint'
    ? handle > 0n && handle !== invalid
    : Number.isSafeInteger(handle) && handle > 0;
const fail = (code = 'windows_native_parent_unavailable'): never => {
  throw Object.assign(Error(code), { code });
};
let backend: ReturnType<typeof native> | undefined;
function native() {
  if (process.platform !== 'win32' || process.arch !== 'x64')
    fail('windows_native_parent_platform_unsupported');
  const { dlopen, ptr } = require('bun:ffi') as typeof import('bun:ffi');
  const kernel = dlopen('kernel32.dll', {
    GetCurrentProcess: { args: [], returns: 'u64' },
    GetCurrentProcessId: { args: [], returns: 'u32' },
    CreateToolhelp32Snapshot: { args: ['u32', 'u32'], returns: 'u64' },
    Process32FirstW: { args: ['u64', 'ptr'], returns: 'bool' },
    Process32NextW: { args: ['u64', 'ptr'], returns: 'bool' },
    OpenProcess: { args: ['u32', 'bool', 'u32'], returns: 'u64' },
    GetProcessTimes: { args: ['u64', 'ptr', 'ptr', 'ptr', 'ptr'], returns: 'bool' },
    QueryFullProcessImageNameW: { args: ['u64', 'u32', 'ptr', 'ptr'], returns: 'bool' },
    WaitForSingleObject: { args: ['u64', 'u32'], returns: 'u32' },
    CloseHandle: { args: ['u64'], returns: 'bool' },
  });
  return { k: kernel.symbols, ptr };
}
/** Trusted host-only, after the caller has retained the complete original frontdoor files. */
export function retainWindowsNativeLauncherParent(prefix: string, kind: 'cli' | 'tui' | 'desktop') {
  if (
    !['cli', 'tui', 'desktop'].includes(kind) ||
    !/^[A-Za-z]:\\/.test(prefix) ||
    win32.resolve(prefix) !== prefix ||
    realpathSync.native(prefix) !== prefix ||
    /\p{Cc}/u.test(prefix)
  )
    fail();
  const expected = win32.join(
    prefix,
    'bin',
    kind === 'cli' ? 'kite.exe' : kind === 'tui' ? 'kite-tui.exe' : 'kite-desktop.exe',
  );
  backend ??= native();
  const { k, ptr } = backend;
  const handles = new Set<Handle>();
  const owner = { handles };
  retained.add(owner);
  const close = () => {
    const failures: unknown[] = [];
    for (const handle of handles) {
      if (k.CloseHandle(handle)) handles.delete(handle);
      else failures.push(Error('windows_native_parent_close_unknown'));
    }
    if (failures.length)
      throw Object.assign(new AggregateError(failures, 'windows_native_parent_close_unknown'), {
        code: 'windows_native_parent_close_unknown',
      });
    retained.delete(owner);
  };
  const times = (handle: Handle) => {
    const created = new BigUint64Array(1),
      exited = new BigUint64Array(1),
      kernel = new BigUint64Array(1),
      user = new BigUint64Array(1);
    if (
      !k.GetProcessTimes(handle, ptr(created), ptr(exited), ptr(kernel), ptr(user)) ||
      !created[0]
    )
      fail();
    return created[0]!;
  };
  try {
    const self = k.GetCurrentProcessId();
    if (!self) fail();
    const selfBirth = times(k.GetCurrentProcess()); // Pseudo HANDLE is never closed.
    const snapshot = k.CreateToolhelp32Snapshot(2, 0);
    if (!valid(snapshot)) fail();
    handles.add(snapshot);
    const entry = new Uint8Array(568),
      view = new DataView(entry.buffer);
    view.setUint32(0, entry.length, true);
    let present = k.Process32FirstW(snapshot, ptr(entry)),
      parentId = 0;
    while (present) {
      if (view.getUint32(8, true) === self) {
        parentId = view.getUint32(32, true);
        break;
      }
      view.setUint32(0, entry.length, true);
      present = k.Process32NextW(snapshot, ptr(entry));
    }
    if (!parentId || parentId === self) fail();
    // Query and SYNCHRONIZE only. Keep this original kernel object through child exit.
    const parent = k.OpenProcess(0x101000, false, parentId);
    if (!valid(parent)) fail();
    handles.add(parent);
    const birth = times(parent);
    if (birth > selfBirth) fail('windows_native_parent_identity_mismatch');
    if (!k.CloseHandle(snapshot)) fail('windows_native_parent_close_unknown');
    handles.delete(snapshot);
    let released = false;
    const verify = () => {
      if (
        released ||
        !handles.has(parent) ||
        k.WaitForSingleObject(parent, 0) !== 258 ||
        times(parent) !== birth
      )
        fail('windows_native_parent_identity_mismatch');
      const text = new Uint16Array(32768),
        count = new Uint32Array([text.length]);
      if (
        !k.QueryFullProcessImageNameW(parent, 0, ptr(text), ptr(count)) ||
        !count[0] ||
        count[0]! >= text.length
      )
        fail();
      const image = Buffer.from(text.buffer, 0, count[0]! * 2).toString('utf16le');
      if (
        image.toLowerCase() !== expected.toLowerCase() ||
        realpathSync.native(image).toLowerCase() !== expected.toLowerCase()
      )
        fail('windows_native_parent_identity_mismatch');
    };
    verify();
    return Object.freeze({
      parentPid: parentId,
      parentCreationTime: birth,
      selfPid: self,
      selfCreationTime: selfBirth,
      verify,
      release() {
        if (released) return;
        close();
        released = true;
      },
    });
  } catch (error) {
    try {
      close();
    } catch (cleanup) {
      throw Object.assign(
        new AggregateError([error, cleanup], 'windows_native_parent_close_unknown'),
        { code: 'windows_native_parent_close_unknown' },
      );
    }
    throw error;
  }
}
