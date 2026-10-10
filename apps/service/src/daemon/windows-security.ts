import { createHash } from 'node:crypto';
import { win32 } from 'node:path';

/** Daemon-only current-token policy. Importing the leaf performs no native or filesystem I/O. */
let cached: ReturnType<typeof createSecurity> | undefined;
const retainedFailures = new Set<unknown>();
export function windowsDaemonSecurity() {
  if (process.platform !== 'win32' || process.arch !== 'x64')
    throw Error('daemon_platform_unsupported');
  cached ??= createSecurity();
  return cached;
}
function createSecurity() {
  const { dlopen, ptr, toArrayBuffer, CString } = require('bun:ffi') as typeof import('bun:ffi');
  const kernel = dlopen('kernel32.dll', {
    GetCurrentProcess: { args: [], returns: 'u64' },
    GetSystemDirectoryW: { args: ['ptr', 'u32'], returns: 'u32' },
    CloseHandle: { args: ['u64'], returns: 'bool' },
    LocalFree: { args: ['ptr'], returns: 'ptr' },
  });
  const fail = (): never => {
    throw Error('daemon_endpoint_unsafe');
  };
  const pointer = (value: bigint) => {
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number <= 0) return fail();
    return number as import('bun:ffi').Pointer;
  };
  const system = new Uint16Array(32768);
  const length = kernel.symbols.GetSystemDirectoryW(ptr(system), system.length);
  if (!length || length >= system.length) fail();
  const systemPath = Buffer.from(system.buffer, 0, length * 2).toString('utf16le');
  const adv = dlopen(`${systemPath}\\advapi32.dll`, {
    OpenProcessToken: { args: ['u64', 'u32', 'ptr'], returns: 'bool' },
    GetTokenInformation: { args: ['u64', 'u32', 'ptr', 'u32', 'ptr'], returns: 'bool' },
    ConvertSidToStringSidA: { args: ['ptr', 'ptr'], returns: 'bool' },
    ConvertStringSecurityDescriptorToSecurityDescriptorW: {
      args: ['ptr', 'u32', 'ptr', 'ptr'],
      returns: 'bool',
    },
    GetSecurityInfo: {
      args: ['u64', 'u32', 'u32', 'ptr', 'ptr', 'ptr', 'ptr', 'ptr'],
      returns: 'u32',
    },
    GetSecurityDescriptorControl: { args: ['ptr', 'ptr', 'ptr'], returns: 'bool' },
    EqualSid: { args: ['ptr', 'ptr'], returns: 'bool' },
    GetAce: { args: ['ptr', 'u32', 'ptr'], returns: 'bool' },
  });
  const shell = dlopen(`${systemPath}\\shell32.dll`, {
    SHGetKnownFolderPath: { args: ['ptr', 'u32', 'u64', 'ptr'], returns: 'i32' },
  });
  const ole = dlopen(`${systemPath}\\ole32.dll`, {
    CoTaskMemFree: { args: ['ptr'], returns: 'void' },
  });
  const pendingHandles = new Set<bigint>();
  const pendingAllocations = new Set<import('bun:ffi').Pointer>();
  // The DLLs and every unconfirmed native resource remain owned even if construction throws.
  const owner = { kernel, adv, shell, ole, pendingHandles, pendingAllocations };
  const free = (address: import('bun:ffi').Pointer) => {
    if (kernel.symbols.LocalFree(address)) {
      pendingAllocations.add(address);
      retainedFailures.add(owner);
      throw Error('daemon_security_close_unknown');
    }
    pendingAllocations.delete(address);
  };
  const wide = (value: string) => Buffer.from(`${value}\0`, 'utf16le');
  const token = new BigUint64Array(1);
  const closeToken = () => {
    if (!kernel.symbols.CloseHandle(token[0]!)) throw Error('daemon_security_close_unknown');
    pendingHandles.delete(token[0]!);
  };
  let user: Uint8Array;
  let sid: import('bun:ffi').Pointer;
  let sidText: string;
  let localAppData: string;
  try {
    if (!adv.symbols.OpenProcessToken(kernel.symbols.GetCurrentProcess(), 8, ptr(token))) fail();
    pendingHandles.add(token[0]!);
    try {
      const size = new Uint32Array(1);
      adv.symbols.GetTokenInformation(token[0]!, 1, null, 0, ptr(size));
      if (!size[0] || size[0] > 65536) fail();
      user = new Uint8Array(size[0]!);
      if (!adv.symbols.GetTokenInformation(token[0]!, 1, ptr(user), user.length, ptr(size))) fail();
      sid = pointer(new DataView(user.buffer).getBigUint64(0, true));
      const text = new BigUint64Array(1);
      if (!adv.symbols.ConvertSidToStringSidA(sid, ptr(text))) fail();
      const address = pointer(text[0]!);
      pendingAllocations.add(address);
      try {
        sidText = new CString(address).toString();
      } finally {
        free(address);
      }
      if (!/^S-1-(?:\d+-)*\d+$/.test(sidText) || sidText.length > 256) fail();
    } finally {
      closeToken();
    }
    // FOLDERID_LocalAppData, DONT_VERIFY: absent status queries never create a directory.
    const guid = new Uint8Array([
      0x85, 0x27, 0xb3, 0xf1, 0xba, 0x6f, 0xcf, 0x4f, 0x9d, 0x55, 0x7b, 0x8e, 0x7f, 0x15, 0x70,
      0x91,
    ]);
    const path = new BigUint64Array(1);
    if (shell.symbols.SHGetKnownFolderPath(ptr(guid), 0x4000, 0, ptr(path)) !== 0 || !path[0])
      fail();
    const address = pointer(path[0]!);
    try {
      // Scan only the bounded WCHAR string returned by the OS, never an unbounded CString.
      const chars: number[] = [];
      for (let index = 0; index < 32768; index++) {
        const character = new DataView(toArrayBuffer(address, index * 2, 2)).getUint16(0, true);
        if (!character) break;
        chars.push(character);
      }
      if (!chars.length || chars.length >= 32768) fail();
      localAppData = Buffer.from(new Uint16Array(chars).buffer).toString('utf16le');
    } finally {
      ole.symbols.CoTaskMemFree(address);
    }
    if (
      !/^[A-Za-z]:\\/.test(localAppData) ||
      /\p{Cc}/u.test(localAppData) ||
      win32.resolve(localAppData) !== localAppData
    )
      fail();
  } catch (error) {
    retainedFailures.add(owner);
    throw error;
  }
  const sidKey = createHash('sha256').update(sidText).digest('hex');
  const recordBase = win32.join(localAppData, `kite-daemon-${sidKey}`, 'v1');
  const verifyPrivateObject = (handle: bigint | number, directory: boolean) => {
    if (!user.byteLength) fail(); // Retain the original TOKEN_USER SID storage.
    const ownerSid = new BigUint64Array(1),
      dacl = new BigUint64Array(1),
      sd = new BigUint64Array(1);
    if (
      adv.symbols.GetSecurityInfo(handle, 1, 5, ptr(ownerSid), null, ptr(dacl), null, ptr(sd)) !== 0
    )
      fail();
    const address = pointer(sd[0]!);
    pendingAllocations.add(address);
    try {
      if (!ownerSid[0] || !dacl[0] || !adv.symbols.EqualSid(pointer(ownerSid[0]), sid)) fail();
      const control = new Uint16Array(1),
        revision = new Uint32Array(1);
      if (
        !adv.symbols.GetSecurityDescriptorControl(address, ptr(control), ptr(revision)) ||
        (control[0]! & 0x1004) !== 0x1004
      )
        fail();
      const acl = new DataView(toArrayBuffer(pointer(dacl[0]!), 0, 8));
      if (acl.getUint16(4, true) !== 1) fail();
      const ace = new BigUint64Array(1);
      if (!adv.symbols.GetAce(pointer(dacl[0]!), 0, ptr(ace))) fail();
      const aceAddress = pointer(ace[0]!);
      const header = new DataView(toArrayBuffer(aceAddress, 0, 8));
      if (
        header.getUint8(0) !== 0 ||
        (directory ? header.getUint8(1) !== 3 : header.getUint8(1) !== 0) ||
        header.getUint16(2, true) < 12 ||
        header.getUint32(4, true) !== 0x1f01ff ||
        !adv.symbols.EqualSid(pointer(BigInt(aceAddress) + 8n), sid)
      )
        fail();
    } finally {
      free(address);
    }
  };
  return Object.freeze({
    sidText,
    recordBase,
    descriptor(directory: boolean) {
      const output = new BigUint64Array(1);
      if (
        !adv.symbols.ConvertStringSecurityDescriptorToSecurityDescriptorW(
          ptr(wide(`O:${sidText}D:P(A;${directory ? 'OICI' : ''};FA;;;${sidText})`)),
          1,
          ptr(output),
          null,
        )
      )
        fail();
      const address = pointer(output[0]!);
      pendingAllocations.add(address);
      const attributes = new Uint8Array(24);
      const view = new DataView(attributes.buffer);
      view.setUint32(0, 24, true);
      view.setBigUint64(8, BigInt(address), true);
      let closed = false;
      return Object.freeze({
        attributes,
        close() {
          if (closed) return;
          free(address);
          closed = true;
        },
      });
    },
    verifyPipe(handle: bigint | number) {
      verifyPrivateObject(handle, false);
    },
    verifyPrivateObject,
  });
}
