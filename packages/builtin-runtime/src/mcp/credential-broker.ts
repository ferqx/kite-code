import { createHash, randomUUID } from 'node:crypto';
import type { CredentialBroker, CredentialHandle } from '@kite-ai/runtime-spi';
import type {
  McpCredentialKey,
  McpCredentialMaterial,
  McpCredentialStore,
  McpCredentialStoreStatus,
} from './credential-store';
import { NativeMcpCredentialStore } from './credential-store';

const DEFAULT_HANDLE_TTL_MS = 10 * 60 * 1000;
const MAX_HANDLE_TTL_MS = 15 * 60 * 1000;

/**
 * Builtin's sole credential authority. The store is deliberately private to
 * this object; callers receive only a purpose/expiry/revocation-bound handle.
 *
 * `store` is an explicit test seam. Production composition omits it and this
 * is the only place that constructs the native OS-vault implementation.
 */
export interface BuiltinCredentialBroker extends CredentialBroker {
  status(): Promise<McpCredentialStoreStatus>;
  issueForKey(
    key: McpCredentialKey,
    input: { purpose: string; expiresAt?: string; revocationRevision?: number },
  ): Promise<CredentialHandle>;
  hasForKey(key: McpCredentialKey): Promise<boolean>;
  hasForHandle(handle: CredentialHandle, purpose: string): Promise<boolean>;
  validateHandle(handle: CredentialHandle, purpose: string): void;
  withMaterialForKey<T>(
    key: McpCredentialKey,
    purpose: string,
    operation: (material: McpCredentialMaterial) => Promise<T> | T,
  ): Promise<T>;
  withHandleMaterial<T>(
    handle: CredentialHandle,
    purpose: string,
    operation: (material: McpCredentialMaterial) => Promise<T> | T,
  ): Promise<T>;
  authorizationHeadersForHandle(
    handle: CredentialHandle,
    purpose: string,
    input: { header: string; scheme?: string; base?: Readonly<Record<string, string>> },
  ): Promise<Record<string, string>>;
  putForKey(key: McpCredentialKey, purpose: string, material: McpCredentialMaterial): Promise<void>;
  deleteForKey(key: McpCredentialKey, purpose: string): Promise<void>;
  putForHandle(
    handle: CredentialHandle,
    purpose: string,
    material: McpCredentialMaterial,
  ): Promise<void>;
  deleteForHandle(handle: CredentialHandle, purpose: string): Promise<void>;
}

export interface BuiltinCredentialBrokerOptions {
  /** Test-only in-memory store injection; production must omit this option. */
  store?: McpCredentialStore;
  now?: () => number;
}

interface BoundHandle {
  readonly key: McpCredentialKey;
  readonly handle: CredentialHandle;
}

export function createBuiltinCredentialBroker(
  options: BuiltinCredentialBrokerOptions = {},
): BuiltinCredentialBroker {
  return new BuiltinCredentialBrokerImpl(
    options.store ?? new NativeMcpCredentialStore(),
    options.now ?? Date.now,
  );
}

class BuiltinCredentialBrokerImpl implements BuiltinCredentialBroker {
  private readonly handles = new Map<string, BoundHandle>();
  private readonly revoked = new Map<string, number>();
  private readonly store: McpCredentialStore;
  private readonly now: () => number;

  constructor(store: McpCredentialStore, now: () => number) {
    this.store = store;
    this.now = now;
  }

  status(): Promise<McpCredentialStoreStatus> {
    return this.store.status();
  }

  async issueForKey(
    key: McpCredentialKey,
    input: { purpose: string; expiresAt?: string; revocationRevision?: number },
  ): Promise<CredentialHandle> {
    assertPurpose(input.purpose);
    const now = this.now();
    const requestedExpiry = input.expiresAt ? Date.parse(input.expiresAt) : NaN;
    const expiry = Number.isFinite(requestedExpiry)
      ? Math.min(requestedExpiry, now + MAX_HANDLE_TTL_MS)
      : now + DEFAULT_HANDLE_TTL_MS;
    if (expiry <= now) throw new Error('Credential handle expiry must be in the future.');
    const projectId = `project_${createHash('sha256').update(key.workspaceKey).digest('hex')}`;
    const handle = Object.freeze({
      handleId: `cred_${randomUUID()}`,
      projectId,
      provider: key.server,
      profile: key.profile,
      purpose: input.purpose,
      expiresAt: new Date(expiry).toISOString(),
      revocationRevision: Math.max(0, input.revocationRevision ?? 0),
    });
    this.handles.set(handle.handleId, { key: { ...key }, handle });
    return handle;
  }

  /** SPI entry point. Handles issued without a key are intentionally unusable. */
  async issue(input: Omit<CredentialHandle, 'handleId'>): Promise<CredentialHandle> {
    assertPurpose(input.purpose);
    const handle = Object.freeze({ handleId: `cred_${randomUUID()}`, ...input });
    // Do not create a synthetic store binding. A caller must use issueForKey,
    // which proves that the key came from Builtin's config composition.
    return handle;
  }

  async use(handle: CredentialHandle, purpose: string): Promise<Uint8Array> {
    return this.withHandleMaterial(handle, purpose, (material) =>
      new TextEncoder().encode(JSON.stringify(material)),
    );
  }

  revoke(handleId: string, revision: number): void {
    if (!handleId || !Number.isSafeInteger(revision) || revision < 0) {
      throw new Error('Credential revocation identity is invalid.');
    }
    this.revoked.set(handleId, revision);
  }

  async hasForKey(key: McpCredentialKey): Promise<boolean> {
    const material = await this.store.get(key);
    wipeMaterial(material);
    return material !== null;
  }

  async hasForHandle(handle: CredentialHandle, purpose: string): Promise<boolean> {
    try {
      await this.withHandleMaterial(handle, purpose, () => undefined);
      return true;
    } catch (error) {
      if (error instanceof Error && error.message === 'Credential reference is unavailable.') {
        return false;
      }
      throw error;
    }
  }

  validateHandle(handle: CredentialHandle, purpose: string): void {
    this.assertHandle(handle, purpose);
  }

  async withMaterialForKey<T>(
    key: McpCredentialKey,
    purpose: string,
    operation: (material: McpCredentialMaterial) => Promise<T> | T,
  ): Promise<T> {
    const handle = await this.issueForKey(key, { purpose });
    return this.withHandleMaterial(handle, purpose, operation);
  }

  async withHandleMaterial<T>(
    handle: CredentialHandle,
    purpose: string,
    operation: (material: McpCredentialMaterial) => Promise<T> | T,
  ): Promise<T> {
    const bound = this.assertHandle(handle, purpose);
    const material = await this.store.get(bound.key);
    if (!material) throw new Error('Credential reference is unavailable.');
    try {
      return await operation(material);
    } finally {
      wipeMaterial(material);
    }
  }

  async authorizationHeadersForHandle(
    handle: CredentialHandle,
    purpose: string,
    input: { header: string; scheme?: string; base?: Readonly<Record<string, string>> },
  ): Promise<Record<string, string>> {
    if (!input.header.trim()) throw new Error('Credential header identity is invalid.');
    return this.withHandleMaterial(handle, purpose, (material) => {
      if (material.kind !== 'bearer') throw new Error('MCP credential reference is unavailable.');
      return {
        ...input.base,
        [input.header]: `${input.scheme ? `${input.scheme} ` : ''}${material.secret}`,
      };
    });
  }

  async putForKey(
    key: McpCredentialKey,
    purpose: string,
    material: McpCredentialMaterial,
  ): Promise<void> {
    const handle = await this.issueForKey(key, { purpose });
    await this.putForHandle(handle, purpose, material);
  }

  async deleteForKey(key: McpCredentialKey, purpose: string): Promise<void> {
    const handle = await this.issueForKey(key, { purpose });
    this.assertHandle(handle, purpose);
    await this.store.delete(key);
  }

  async putForHandle(
    handle: CredentialHandle,
    purpose: string,
    material: McpCredentialMaterial,
  ): Promise<void> {
    const bound = this.assertHandle(handle, purpose);
    try {
      await this.store.put(bound.key, material);
    } finally {
      wipeMaterial(material);
    }
  }

  async deleteForHandle(handle: CredentialHandle, purpose: string): Promise<void> {
    const bound = this.assertHandle(handle, purpose);
    await this.store.delete(bound.key);
  }

  private assertHandle(handle: CredentialHandle, purpose: string): BoundHandle {
    if (!handle || typeof handle !== 'object') throw new Error('Credential handle is invalid.');
    assertPurpose(purpose);
    const bound = this.handles.get(handle.handleId);
    if (!bound || !sameHandle(bound.handle, handle)) {
      throw new Error('Credential handle is not recognized.');
    }
    if (bound.handle.purpose !== purpose) throw new Error('Credential handle purpose mismatch.');
    if (Date.parse(bound.handle.expiresAt) <= this.now()) {
      throw new Error('Credential handle is expired.');
    }
    const currentRevision = this.revoked.get(bound.handle.handleId);
    if (currentRevision !== undefined && currentRevision >= bound.handle.revocationRevision) {
      throw new Error('Credential handle is revoked.');
    }
    return bound;
  }
}

function assertPurpose(purpose: string): void {
  if (!/^[a-z][a-z0-9._-]{0,63}$/u.test(purpose)) {
    throw new Error('Credential handle purpose is invalid.');
  }
}

function sameHandle(left: CredentialHandle, right: CredentialHandle): boolean {
  return (
    left.handleId === right.handleId &&
    left.projectId === right.projectId &&
    left.provider === right.provider &&
    left.profile === right.profile &&
    left.purpose === right.purpose &&
    left.expiresAt === right.expiresAt &&
    left.revocationRevision === right.revocationRevision
  );
}

function wipeMaterial(material: McpCredentialMaterial | null): void {
  if (!material) return;
  // JS strings cannot be zeroed in place. Remove references from the broker's
  // private copy and clear all nested secret-bearing fields best-effort.
  const mutable = material as unknown as Record<string, unknown>;
  for (const key of Object.keys(mutable)) {
    if (/secret|token|verifier|state|information/i.test(key)) {
      mutable[key] = undefined;
    }
  }
}
