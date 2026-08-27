import { dlopen, type Pointer, ptr, read, toArrayBuffer } from 'bun:ffi';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const WINDOWS_STATE_SECURITY_TIMEOUT_MS = 10_000;
const OWNER_SECURITY_INFORMATION = 0x0000_0001;
const DACL_SECURITY_INFORMATION = 0x0000_0004;
const PROTECTED_DACL_SECURITY_INFORMATION = 0x8000_0000;
const SE_DACL_PROTECTED = 0x1000;
const SE_FILE_OBJECT = 1;
const ACL_REVISION = 2;
const ACL_SIZE_INFORMATION_CLASS = 2;
const ACCESS_ALLOWED_ACE_TYPE = 0;
const INHERITED_ACE = 0x10;
const OBJECT_INHERIT_ACE = 0x01;
const CONTAINER_INHERIT_ACE = 0x02;
const FILE_ATTRIBUTE_DIRECTORY = 0x10;
const FILE_ATTRIBUTE_REPARSE_POINT = 0x400;
const INVALID_FILE_ATTRIBUTES = 0xffff_ffff;
const FILE_ALL_ACCESS = 0x001f_01ff;

export type WindowsStatePathKind = 'directory' | 'file';

export class WindowsStateSecurityError extends Error {
  readonly diagnostic: string;

  constructor(diagnostic: string) {
    super(`Windows state security failed: ${diagnostic}.`);
    this.name = 'WindowsStateSecurityError';
    this.diagnostic = diagnostic;
  }
}

export function windowsStateSecurityDiagnostic(error: unknown): string | undefined {
  return error instanceof WindowsStateSecurityError ? error.diagnostic : undefined;
}

let cachedWindowsUserSid: string | undefined;
let cachedWindowsSecurityApi: WindowsSecurityApi | undefined;

export function secureWindowsStatePath(
  path: string,
  kind: WindowsStatePathKind,
  options: { readonly allowOwnerInitialization?: boolean } = {},
): void {
  if (process.platform !== 'win32') return;
  assertWindowsStatePathType(path, kind);
  withCurrentUserSid((sid) => {
    if (!options.allowOwnerInitialization) verifyWindowsOwner(path, sid);
    applyWindowsOwnerOnlyAcl(path, kind, sid);
    verifyWindowsOwnerOnlyAcl(path, kind, sid);
  });
}

export function verifyWindowsStatePath(path: string, kind: WindowsStatePathKind): void {
  if (process.platform !== 'win32') return;
  assertWindowsStatePathType(path, kind);
  withCurrentUserSid((sid) => verifyWindowsOwnerOnlyAcl(path, kind, sid));
}

function assertWindowsStatePathType(path: string, kind: WindowsStatePathKind): void {
  const nativePath = Buffer.from(`${path}\0`, 'utf16le');
  const attributes = windowsSecurityApi().kernel32.GetFileAttributesW(ptr(nativePath));
  if (attributes === INVALID_FILE_ATTRIBUTES) fail('attributes_unavailable');
  if ((attributes & FILE_ATTRIBUTE_REPARSE_POINT) !== 0) fail('reparse_point');
  const isDirectory = (attributes & FILE_ATTRIBUTE_DIRECTORY) !== 0;
  if (isDirectory !== (kind === 'directory')) fail('type_mismatch');
}

function resolveCurrentWindowsUserSid(): string {
  if (cachedWindowsUserSid) return cachedWindowsUserSid;
  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? 'C:\\Windows';
  const result = spawnSync(
    join(systemRoot, 'System32', 'whoami.exe'),
    ['/user', '/fo', 'csv', '/nh'],
    {
      encoding: 'utf8',
      windowsHide: true,
      timeout: WINDOWS_STATE_SECURITY_TIMEOUT_MS,
      killSignal: 'SIGKILL',
      env: { SystemRoot: systemRoot, SYSTEMROOT: systemRoot },
    },
  );
  const sid = result.stdout.match(/\bS-\d+(?:-\d+)+\b/iu)?.[0];
  if (result.status !== 0 || !sid) fail('current_sid_unavailable');
  cachedWindowsUserSid = sid;
  return sid;
}

function withCurrentUserSid<T>(use: (sid: Pointer) => T): T {
  const api = windowsSecurityApi();
  const sidText = Buffer.from(`${resolveCurrentWindowsUserSid()}\0`, 'utf16le');
  const sidOut = pointerOut();
  if (!api.advapi32.ConvertStringSidToSidW(ptr(sidText), ptr(sidOut))) {
    fail('current_sid_invalid');
  }
  const sid = read.ptr(ptr(sidOut)) as Pointer | null;
  if (!sid) fail('current_sid_invalid');
  try {
    return use(sid);
  } finally {
    api.kernel32.LocalFree(sid);
  }
}

function applyWindowsOwnerOnlyAcl(path: string, kind: WindowsStatePathKind, sid: Pointer): void {
  const api = windowsSecurityApi().advapi32;
  const sidLength = api.GetLengthSid(sid);
  if (sidLength === 0) fail('current_sid_invalid');
  const acl = new Uint8Array(8 + 12 + sidLength);
  if (!api.InitializeAcl(ptr(acl), acl.length, ACL_REVISION)) fail('acl_initialize_failed');
  const inheritance = kind === 'directory' ? OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE : 0;
  if (!api.AddAccessAllowedAceEx(ptr(acl), ACL_REVISION, inheritance, FILE_ALL_ACCESS, sid)) {
    fail('acl_rule_failed');
  }
  const descriptor = new Uint8Array(64);
  if (
    !api.InitializeSecurityDescriptor(ptr(descriptor), 1) ||
    !api.SetSecurityDescriptorOwner(ptr(descriptor), sid, false) ||
    !api.SetSecurityDescriptorDacl(ptr(descriptor), true, ptr(acl), false) ||
    !api.SetSecurityDescriptorControl(ptr(descriptor), SE_DACL_PROTECTED, SE_DACL_PROTECTED)
  ) {
    fail('security_descriptor_failed');
  }
  const nativePath = Buffer.from(`${path}\0`, 'utf16le');
  if (
    !api.SetFileSecurityW(
      ptr(nativePath),
      OWNER_SECURITY_INFORMATION + DACL_SECURITY_INFORMATION + PROTECTED_DACL_SECURITY_INFORMATION,
      ptr(descriptor),
    )
  ) {
    fail('acl_apply_failed');
  }
}

function verifyWindowsOwner(path: string, sid: Pointer): void {
  withWindowsSecurityDescriptor(path, (owner) => {
    if (!windowsSecurityApi().advapi32.EqualSid(owner, sid)) fail('owner_mismatch');
  });
}

function verifyWindowsOwnerOnlyAcl(path: string, kind: WindowsStatePathKind, sid: Pointer): void {
  assertWindowsStatePathType(path, kind);
  withWindowsSecurityDescriptor(path, (owner, dacl, descriptor) => {
    const api = windowsSecurityApi().advapi32;
    if (!api.EqualSid(owner, sid)) fail('owner_mismatch');
    const control = new Uint8Array(2);
    const revision = new Uint8Array(4);
    if (!api.GetSecurityDescriptorControl(descriptor, ptr(control), ptr(revision))) {
      fail('descriptor_control_unavailable');
    }
    if ((new DataView(control.buffer).getUint16(0, true) & SE_DACL_PROTECTED) === 0) {
      fail('dacl_not_protected');
    }
    const information = new Uint8Array(12);
    if (
      !api.GetAclInformation(dacl, ptr(information), information.length, ACL_SIZE_INFORMATION_CLASS)
    ) {
      fail('acl_information_unavailable');
    }
    const aceCount = new DataView(information.buffer).getUint32(0, true);
    if (aceCount !== 1) fail('acl_rule_count');
    const aceOut = pointerOut();
    if (!api.GetAce(dacl, 0, ptr(aceOut))) fail('acl_rule_unavailable');
    const acePointer = read.ptr(ptr(aceOut)) as Pointer | null;
    if (!acePointer) fail('acl_rule_unavailable');
    const header = new Uint8Array(toArrayBuffer(acePointer, 0, 8));
    const headerView = new DataView(header.buffer, header.byteOffset, header.byteLength);
    const aceSize = headerView.getUint16(2, true);
    if (aceSize < 12) fail('acl_rule_invalid');
    const ace = new Uint8Array(toArrayBuffer(acePointer, 0, aceSize));
    const view = new DataView(ace.buffer, ace.byteOffset, ace.byteLength);
    if (ace[0] !== ACCESS_ALLOWED_ACE_TYPE || (ace[1]! & INHERITED_ACE) !== 0) {
      fail('acl_rule_invalid');
    }
    if ((view.getUint32(4, true) & FILE_ALL_ACCESS) !== FILE_ALL_ACCESS) {
      fail('acl_access_insufficient');
    }
    if (!api.EqualSid(ptr(ace, 8), sid)) fail('acl_foreign_sid');
  });
}

function withWindowsSecurityDescriptor<T>(
  path: string,
  use: (owner: Pointer, dacl: Pointer, descriptor: Pointer) => T,
): T {
  const api = windowsSecurityApi();
  const nativePath = Buffer.from(`${path}\0`, 'utf16le');
  const ownerOut = pointerOut();
  const daclOut = pointerOut();
  const descriptorOut = pointerOut();
  const result = api.advapi32.GetNamedSecurityInfoW(
    ptr(nativePath),
    SE_FILE_OBJECT,
    OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
    ptr(ownerOut),
    null,
    ptr(daclOut),
    null,
    ptr(descriptorOut),
  );
  if (result !== 0) fail(`security_info_${result}`);
  const owner = read.ptr(ptr(ownerOut)) as Pointer | null;
  const dacl = read.ptr(ptr(daclOut)) as Pointer | null;
  const descriptor = read.ptr(ptr(descriptorOut)) as Pointer | null;
  if (!owner || !dacl || !descriptor) {
    if (descriptor) api.kernel32.LocalFree(descriptor);
    fail('security_info_missing');
  }
  try {
    return use(owner, dacl, descriptor);
  } finally {
    api.kernel32.LocalFree(descriptor);
  }
}

function pointerOut(): Uint8Array {
  return new Uint8Array(process.arch === 'ia32' ? 4 : 8);
}

function fail(diagnostic: string): never {
  throw new WindowsStateSecurityError(diagnostic);
}

interface WindowsSecurityApi {
  readonly advapi32: {
    ConvertStringSidToSidW(sidText: Pointer, sidOut: Pointer): boolean;
    GetLengthSid(sid: Pointer): number;
    InitializeAcl(acl: Pointer, length: number, revision: number): boolean;
    AddAccessAllowedAceEx(
      acl: Pointer,
      revision: number,
      flags: number,
      mask: number,
      sid: Pointer,
    ): boolean;
    InitializeSecurityDescriptor(descriptor: Pointer, revision: number): boolean;
    SetSecurityDescriptorOwner(descriptor: Pointer, owner: Pointer, defaulted: boolean): boolean;
    SetSecurityDescriptorDacl(
      descriptor: Pointer,
      present: boolean,
      dacl: Pointer,
      defaulted: boolean,
    ): boolean;
    SetSecurityDescriptorControl(descriptor: Pointer, interest: number, control: number): boolean;
    SetFileSecurityW(path: Pointer, information: number, descriptor: Pointer): boolean;
    GetNamedSecurityInfoW(
      path: Pointer,
      objectType: number,
      information: number,
      ownerOut: Pointer,
      groupOut: Pointer | null,
      daclOut: Pointer,
      saclOut: Pointer | null,
      descriptorOut: Pointer,
    ): number;
    EqualSid(left: Pointer, right: Pointer): boolean;
    GetSecurityDescriptorControl(
      descriptor: Pointer,
      controlOut: Pointer,
      revisionOut: Pointer,
    ): boolean;
    GetAclInformation(acl: Pointer, information: Pointer, length: number, kind: number): boolean;
    GetAce(acl: Pointer, index: number, aceOut: Pointer): boolean;
  };
  readonly kernel32: {
    GetFileAttributesW(path: Pointer): number;
    LocalFree(memory: Pointer): Pointer | null;
  };
}

function windowsSecurityApi(): WindowsSecurityApi {
  if (cachedWindowsSecurityApi) return cachedWindowsSecurityApi;
  cachedWindowsSecurityApi = {
    advapi32: dlopen('advapi32.dll', {
      ConvertStringSidToSidW: { args: ['ptr', 'ptr'], returns: 'bool' },
      GetLengthSid: { args: ['ptr'], returns: 'u32' },
      InitializeAcl: { args: ['ptr', 'u32', 'u32'], returns: 'bool' },
      AddAccessAllowedAceEx: { args: ['ptr', 'u32', 'u32', 'u32', 'ptr'], returns: 'bool' },
      InitializeSecurityDescriptor: { args: ['ptr', 'u32'], returns: 'bool' },
      SetSecurityDescriptorOwner: { args: ['ptr', 'ptr', 'bool'], returns: 'bool' },
      SetSecurityDescriptorDacl: { args: ['ptr', 'bool', 'ptr', 'bool'], returns: 'bool' },
      SetSecurityDescriptorControl: { args: ['ptr', 'u16', 'u16'], returns: 'bool' },
      SetFileSecurityW: { args: ['ptr', 'u32', 'ptr'], returns: 'bool' },
      GetNamedSecurityInfoW: {
        args: ['ptr', 'u32', 'u32', 'ptr', 'ptr', 'ptr', 'ptr', 'ptr'],
        returns: 'u32',
      },
      EqualSid: { args: ['ptr', 'ptr'], returns: 'bool' },
      GetSecurityDescriptorControl: { args: ['ptr', 'ptr', 'ptr'], returns: 'bool' },
      GetAclInformation: { args: ['ptr', 'ptr', 'u32', 'u32'], returns: 'bool' },
      GetAce: { args: ['ptr', 'u32', 'ptr'], returns: 'bool' },
    }).symbols,
    kernel32: dlopen('kernel32.dll', {
      GetFileAttributesW: { args: ['ptr'], returns: 'u32' },
      LocalFree: { args: ['ptr'], returns: 'ptr' },
    }).symbols,
  };
  return cachedWindowsSecurityApi;
}
