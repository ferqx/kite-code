import type { Pointer } from 'bun:ffi';

/** These functions query the original HANDLE, never a name or inherited parent ACL. */
export const windowsSecurityDescriptorSymbols = {
  GetKernelObjectSecurity: { args: ['u64', 'u32', 'ptr', 'u32', 'ptr'], returns: 'bool' },
  GetSecurityDescriptorOwner: { args: ['ptr', 'ptr', 'ptr'], returns: 'bool' },
  GetSecurityDescriptorDacl: { args: ['ptr', 'ptr', 'ptr', 'ptr'], returns: 'bool' },
} as const;

interface ReaderApi {
  GetKernelObjectSecurity(
    handle: bigint | number,
    flags: number,
    bytes: Pointer,
    length: number,
    needed: Pointer,
  ): boolean;
  GetSecurityDescriptorOwner(descriptor: Pointer, owner: Pointer, defaulted: Pointer): boolean;
  GetSecurityDescriptorDacl(
    descriptor: Pointer,
    present: Pointer,
    dacl: Pointer,
    defaulted: Pointer,
  ): boolean;
}

/** Synchronous scratch storage belongs to this reader; the next read replaces its pointers. */
export function windowsSecurityDescriptorReader(
  api: ReaderApi,
  ptr: (bytes: Uint8Array | Uint32Array | BigUint64Array) => Pointer,
  fail: () => never,
) {
  // A self-relative owner + DACL fits in this bound (ACL size itself is a USHORT).
  // An unsupported larger descriptor fails closed; no partial descriptor is consumed.
  const bytes = new Uint8Array(new ArrayBuffer(131072));
  const needed = new Uint32Array(1),
    owner = new BigUint64Array(1),
    dacl = new BigUint64Array(1),
    present = new Uint32Array(1),
    defaulted = new Uint32Array(1);
  const descriptor = ptr(bytes);
  return (handle: bigint | number) => {
    if (
      !api.GetKernelObjectSecurity(handle, 5, descriptor, bytes.length, ptr(needed)) ||
      needed[0]! < 20 ||
      needed[0]! > bytes.length ||
      !api.GetSecurityDescriptorOwner(descriptor, ptr(owner), ptr(defaulted)) ||
      !api.GetSecurityDescriptorDacl(descriptor, ptr(present), ptr(dacl), ptr(defaulted)) ||
      !present[0] ||
      !owner[0] ||
      !dacl[0]
    )
      fail();
    // Keep the backing storage live while the caller consumes the returned descriptor.
    return { bytes, descriptor, owner: owner[0]!, dacl: dacl[0]! };
  };
}
