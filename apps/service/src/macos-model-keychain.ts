import { ConfigurationError } from '@kite-ai/agent/config';
import { dlopen, ptr, toArrayBuffer } from '@kite-ai/agent/runtime-ffi';
import { type ModelKeyringOperation, runModelKeyringChild } from './model-keyring-process';

const itemNotFound = -25300;
const duplicateItem = -25299;
const maxSecretBytes = 65536;
const userKeychainDomain = 0;

function checkStatus(status: number): void {
  if (status === 0) return;
  if (status === -25293 || status === -25308 || status === -25315)
    throw new ConfigurationError('model_credentials_locked');
  throw new ConfigurationError('credential_unavailable');
}

function nativeKeychain() {
  return dlopen('/System/Library/Frameworks/Security.framework/Versions/A/Security', {
    SecKeychainSetUserInteractionAllowed: { args: ['u16'], returns: 'i32' },
    SecKeychainCopyDomainDefault: { args: ['i32', 'ptr'], returns: 'i32' },
    SecKeychainFindGenericPassword: {
      args: ['ptr', 'u32', 'ptr', 'u32', 'ptr', 'ptr', 'ptr', 'ptr'],
      returns: 'i32',
    },
    SecKeychainItemFreeContent: { args: ['ptr', 'ptr'], returns: 'i32' },
    SecKeychainAddGenericPassword: {
      args: ['ptr', 'u32', 'ptr', 'u32', 'ptr', 'u32', 'ptr', 'ptr'],
      returns: 'i32',
    },
    SecKeychainItemDelete: { args: ['ptr'], returns: 'i32' },
  });
}

function nativeCoreFoundation() {
  return dlopen('/System/Library/Frameworks/CoreFoundation.framework/Versions/A/CoreFoundation', {
    CFRelease: { args: ['ptr'], returns: 'void' },
  });
}

function operate(
  security: ReturnType<typeof nativeKeychain>['symbols'],
  release: ReturnType<typeof nativeCoreFoundation>['symbols']['CFRelease'],
  input: ModelKeyringOperation,
): Buffer | null {
  const service = Buffer.from(input.service, 'utf8');
  const account = Buffer.from(input.account, 'utf8');
  const keychain = new BigUint64Array(1);
  checkStatus(security.SecKeychainCopyDomainDefault(userKeychainDomain, ptr(keychain)));
  if (keychain[0] === 0n) throw new ConfigurationError('credential_unavailable');
  try {
    const attributes = [
      keychain[0]!,
      service.length,
      ptr(service),
      account.length,
      ptr(account),
    ] as const;
    if (input.operation === 'create') {
      const key = input.key;
      if (!key?.byteLength || key.byteLength > maxSecretBytes)
        throw new ConfigurationError('credential_unavailable');
      const status = security.SecKeychainAddGenericPassword(
        ...attributes,
        key.byteLength,
        ptr(key),
        null,
      );
      if (status === duplicateItem) throw new ConfigurationError('credential_already_exists');
      checkStatus(status);
      return null;
    }
    if (input.operation === 'remove') {
      const item = new BigUint64Array(1);
      const status = security.SecKeychainFindGenericPassword(...attributes, null, null, ptr(item));
      if (status === itemNotFound) return null;
      checkStatus(status);
      if (item[0] === 0n) throw new ConfigurationError('credential_unavailable');
      try {
        const removed = security.SecKeychainItemDelete(item[0]!);
        if (removed !== itemNotFound) checkStatus(removed);
      } finally {
        release(item[0]!);
      }
      return null;
    }
    const length = new Uint32Array(1);
    const data = new BigUint64Array(1);
    const status = security.SecKeychainFindGenericPassword(
      ...attributes,
      ptr(length),
      ptr(data),
      null,
    );
    if (status === itemNotFound) return null;
    checkStatus(status);
    try {
      if (data[0] === 0n || length[0]! < 1 || length[0]! > maxSecretBytes)
        throw new ConfigurationError('credential_unavailable');
      const content = new Uint8Array(toArrayBuffer(data[0]!, 0, length[0]!));
      try {
        return Buffer.from(content);
      } finally {
        content.fill(0);
      }
    } finally {
      if (data[0] !== 0n) checkStatus(security.SecKeychainItemFreeContent(null, data[0]!));
    }
  } finally {
    release(keychain[0]!);
  }
}

/** Invoked by a fresh same-executable child with private pipes and one request. */
export function modelKeyringOperation(input: ModelKeyringOperation): Buffer | null {
  if (process.platform !== 'darwin') throw new ConfigurationError('credential_unavailable');
  if (
    (input.operation !== 'read' && input.operation !== 'create' && input.operation !== 'remove') ||
    typeof input.service !== 'string' ||
    typeof input.account !== 'string' ||
    !/^[A-Za-z0-9._:-]{1,128}$/u.test(input.service) ||
    !/^[A-Za-z0-9._:/-]{1,192}$/u.test(input.account)
  )
    throw new ConfigurationError('credential_unavailable');
  const security = nativeKeychain();
  try {
    // The legacy file-based Keychain can ignore per-query UI flags for a denied ACL.
    // Change process-wide state only in this child, which exits after the operation.
    if (input.operation !== 'read' || input.interactive !== true)
      checkStatus(security.symbols.SecKeychainSetUserInteractionAllowed(0));
    const core = nativeCoreFoundation();
    try {
      return operate(security.symbols, core.symbols.CFRelease, input);
    } finally {
      core.close();
    }
  } finally {
    security.close();
  }
}

function childModuleUrl(): string {
  // Shared bundles may put these functions in a chunk with renamed exports.
  return new URL(
    import.meta.url.endsWith('.ts') ? './macos-model-keychain.ts' : './macos-model-keychain.js',
    import.meta.url,
  ).href;
}

export function readMacosModelKeychain(
  service: string,
  account: string,
  interactive = false,
): Promise<Buffer | null> {
  return runModelKeyringChild(childModuleUrl(), {
    operation: 'read',
    service,
    account,
    ...(interactive ? { interactive } : {}),
  });
}

export async function createMacosModelKeychain(
  service: string,
  account: string,
  key: Buffer,
): Promise<void> {
  await runModelKeyringChild(childModuleUrl(), { operation: 'create', service, account, key });
}

export async function removeMacosModelKeychain(service: string, account: string): Promise<void> {
  await runModelKeyringChild(childModuleUrl(), { operation: 'remove', service, account });
}
