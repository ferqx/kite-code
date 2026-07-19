import { createHash } from 'node:crypto';
import type { OAuthDiscoveryState } from '@modelcontextprotocol/sdk/client/auth.js';
import type {
  OAuthClientInformationMixed,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import { AsyncEntry } from '@napi-rs/keyring';
import type { McpConfigSourceKind } from '@/core/config/mcp-config';

const CREDENTIAL_SERVICE = 'kite-code.mcp';
const CREDENTIAL_KEY_DOMAIN = 'kite-mcp-credential-key-v1\0';

export type McpCredentialStoreStatus = 'available' | 'locked' | 'unavailable';

export interface McpCredentialKey {
  workspaceKey: string;
  source: McpConfigSourceKind;
  server: string;
  profile: string;
}

export interface McpBearerCredentialMaterial {
  version: 1;
  kind: 'bearer';
  secret: string;
  accountLabel?: string;
  updatedAt: string;
}

export interface McpOAuthCredentialMaterial {
  version: 1;
  kind: 'oauth';
  tokens?: OAuthTokens;
  clientInformation?: OAuthClientInformationMixed;
  codeVerifier?: string;
  discoveryState?: OAuthDiscoveryState;
  accountLabel?: string;
  updatedAt: string;
}

export type McpCredentialMaterial = McpBearerCredentialMaterial | McpOAuthCredentialMaterial;

export interface McpCredentialStore {
  get(key: McpCredentialKey): Promise<McpCredentialMaterial | null>;
  put(key: McpCredentialKey, value: McpCredentialMaterial): Promise<void>;
  delete(key: McpCredentialKey): Promise<void>;
  status(): Promise<McpCredentialStoreStatus>;
}

export class McpCredentialStoreError extends Error {
  readonly status: Exclude<McpCredentialStoreStatus, 'available'>;

  constructor(status: Exclude<McpCredentialStoreStatus, 'available'>, message: string) {
    super(message);
    this.name = 'McpCredentialStoreError';
    this.status = status;
  }
}

/** OS-vault-only credential storage. There is intentionally no file or CLI fallback. */
export class NativeMcpCredentialStore implements McpCredentialStore {
  private readonly service: string;
  private readonly entryFactory: (service: string, account: string) => KeyringEntry;

  constructor(options: NativeMcpCredentialStoreOptions = {}) {
    this.service = options.service ?? CREDENTIAL_SERVICE;
    this.entryFactory =
      options.entryFactory ??
      ((service, account) => new AsyncEntry(service, account) as KeyringEntry);
  }

  async get(key: McpCredentialKey): Promise<McpCredentialMaterial | null> {
    try {
      const rawSecret = await this.entry(key).getSecret();
      if (!rawSecret) return null;
      const secret = rawSecret instanceof Uint8Array ? rawSecret : Uint8Array.from(rawSecret);
      try {
        return parseCredentialMaterial(secret);
      } finally {
        secret.fill(0);
        if (rawSecret !== secret) rawSecret.fill(0);
      }
    } catch (error) {
      throw credentialStoreError(error);
    }
  }

  async put(key: McpCredentialKey, value: McpCredentialMaterial): Promise<void> {
    validateCredentialMaterial(value);
    const encoded = new TextEncoder().encode(JSON.stringify(value));
    try {
      await this.entry(key).setSecret(encoded);
    } catch (error) {
      throw credentialStoreError(error);
    } finally {
      encoded.fill(0);
    }
  }

  async delete(key: McpCredentialKey): Promise<void> {
    try {
      await this.entry(key).deleteCredential();
    } catch (error) {
      if (isMissingCredentialError(error)) return;
      throw credentialStoreError(error);
    }
  }

  async status(): Promise<McpCredentialStoreStatus> {
    const probe: McpCredentialKey = {
      workspaceKey: 'availability',
      source: 'user',
      server: 'probe',
      profile: 'status',
    };
    try {
      const secret = await this.entry(probe).getSecret();
      secret?.fill(0);
      return 'available';
    } catch (error) {
      return classifyCredentialStoreFailure(error);
    }
  }

  private entry(key: McpCredentialKey): KeyringEntry {
    return this.entryFactory(this.service, credentialAccount(key));
  }
}

export interface NativeMcpCredentialStoreOptions {
  service?: string;
  entryFactory?: (service: string, account: string) => KeyringEntry;
}

interface KeyringEntry {
  getSecret(): Promise<Uint8Array | number[] | undefined>;
  setSecret(secret: Uint8Array): Promise<void>;
  deleteCredential(): Promise<boolean>;
}

/** Test/CI fake. Production construction must use NativeMcpCredentialStore. */
export class MemoryMcpCredentialStore implements McpCredentialStore {
  private readonly values = new Map<string, McpCredentialMaterial>();
  private currentStatus: McpCredentialStoreStatus;

  constructor(status: McpCredentialStoreStatus = 'available') {
    this.currentStatus = status;
  }

  setStatus(status: McpCredentialStoreStatus): void {
    this.currentStatus = status;
  }

  async get(key: McpCredentialKey): Promise<McpCredentialMaterial | null> {
    this.assertAvailable();
    const value = this.values.get(credentialAccount(key));
    return value ? structuredClone(value) : null;
  }

  async put(key: McpCredentialKey, value: McpCredentialMaterial): Promise<void> {
    this.assertAvailable();
    validateCredentialMaterial(value);
    this.values.set(credentialAccount(key), structuredClone(value));
  }

  async delete(key: McpCredentialKey): Promise<void> {
    this.assertAvailable();
    this.values.delete(credentialAccount(key));
  }

  async status(): Promise<McpCredentialStoreStatus> {
    return this.currentStatus;
  }

  private assertAvailable(): void {
    if (this.currentStatus !== 'available') {
      throw new McpCredentialStoreError(this.currentStatus, 'Credential store is not available.');
    }
  }
}

export function credentialAccount(key: McpCredentialKey): string {
  const normalized = JSON.stringify({
    workspaceKey: key.workspaceKey,
    source: key.source,
    server: key.server,
    profile: key.profile,
  });
  return `mcp:${createHash('sha256').update(CREDENTIAL_KEY_DOMAIN).update(normalized).digest('hex')}`;
}

function parseCredentialMaterial(encoded: Uint8Array): McpCredentialMaterial {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(encoded));
  } catch {
    throw new McpCredentialStoreError('unavailable', 'Credential material is invalid.');
  }
  validateCredentialMaterial(parsed);
  return parsed;
}

function validateCredentialMaterial(value: unknown): asserts value is McpCredentialMaterial {
  if (!value || typeof value !== 'object') {
    throw new McpCredentialStoreError('unavailable', 'Credential material is invalid.');
  }
  const material = value as Record<string, unknown>;
  if (
    material.version !== 1 ||
    (material.kind !== 'bearer' && material.kind !== 'oauth') ||
    typeof material.updatedAt !== 'string'
  ) {
    throw new McpCredentialStoreError('unavailable', 'Credential material is invalid.');
  }
  if (material.kind === 'bearer' && typeof material.secret !== 'string') {
    throw new McpCredentialStoreError('unavailable', 'Credential material is invalid.');
  }
}

function credentialStoreError(error: unknown): McpCredentialStoreError {
  if (error instanceof McpCredentialStoreError) return error;
  const status = classifyCredentialStoreFailure(error);
  return new McpCredentialStoreError(
    status,
    status === 'locked' ? 'Credential store is locked.' : 'Credential store is unavailable.',
  );
}

function classifyCredentialStoreFailure(
  error: unknown,
): Exclude<McpCredentialStoreStatus, 'available'> {
  const message = error instanceof Error ? `${error.name} ${error.message}` : String(error);
  return /locked|interaction.*not.*allowed|user.*interaction|access.*denied|permission/i.test(
    message,
  )
    ? 'locked'
    : 'unavailable';
}

function isMissingCredentialError(error: unknown): boolean {
  const message = error instanceof Error ? `${error.name} ${error.message}` : String(error);
  return /noentry|no entry|not found|does not exist/i.test(message);
}
