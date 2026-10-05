/** Connection transport authentication only; not a Tool/Task permission or OAuth authority. */
export interface McpCredentialIdentity {
  readonly profileId: string;
  readonly originalStoreId: string;
  readonly workspaceId: string;
  readonly workspaceIdentity: string;
  readonly sessionId: string;
  readonly connectionExecutionId: string;
  readonly source: {
    readonly kind: 'programmatic' | 'user' | 'workspace';
    readonly id: string;
    readonly revision: string;
  };
  readonly serverId: string;
  readonly configDigest: string;
  readonly authProfileId: string;
  readonly policyRevision: string;
}
export interface McpCredentialRef {
  readonly id: string;
}
export interface McpCredentialUse {
  readonly identity: McpCredentialIdentity;
  readonly purpose: 'mcp.http';
  readonly revocationRevision: number;
  readonly signal: AbortSignal;
}
export class McpCredentialError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
    this.name = 'McpCredentialError';
  }
}
function fail(code: string): never {
  throw new McpCredentialError(code);
}
const hasControl = (value: string) =>
  Array.from(value).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);
function identityKey(value: McpCredentialIdentity): string {
  const fields = [
    'profileId',
    'originalStoreId',
    'workspaceId',
    'workspaceIdentity',
    'sessionId',
    'connectionExecutionId',
    'serverId',
    'configDigest',
    'authProfileId',
    'policyRevision',
    'source',
  ];
  if (
    !value ||
    typeof value !== 'object' ||
    Object.keys(value).some((key) => !fields.includes(key))
  )
    fail('mcp_credential_identity_invalid');
  const source = value.source;
  if (
    !source ||
    !['programmatic', 'user', 'workspace'].includes(source.kind) ||
    Object.keys(source).some((key) => !['kind', 'id', 'revision'].includes(key))
  )
    fail('mcp_credential_identity_invalid');
  const strings = fields
    .filter((key) => key !== 'source')
    .map((key) => value[key as keyof McpCredentialIdentity]);
  strings.push(source.kind, source.id, source.revision);
  if (
    strings.some(
      (part) => typeof part !== 'string' || !part || part.length > 4096 || hasControl(part),
    )
  )
    fail('mcp_credential_identity_invalid');
  return JSON.stringify(strings);
}
export function createMcpCredentialBroker(options: {
  readonly vault: { resolve(ref: string): Promise<string> };
  readonly now?: () => number;
  readonly maxHandles?: number;
}) {
  const now = options.now ?? Date.now,
    maximum = options.maxHandles ?? 512,
    vault = options.vault;
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 4096)
    fail('mcp_credential_configuration_invalid');
  const handles = new Map<
    string,
    { key: string; credentialRef: string; expiresAt: number; revision: number; revoked: boolean }
  >();
  const check = (ref: McpCredentialRef, input: McpCredentialUse) => {
    if (input.signal.aborted) fail('mcp_credential_aborted');
    if (input.purpose !== 'mcp.http') fail('mcp_credential_purpose_invalid');
    const item = handles.get(ref?.id);
    if (!item) fail('mcp_credential_unavailable');
    if (item.revoked || item.revision !== input.revocationRevision) fail('mcp_credential_revoked');
    if (now() >= item.expiresAt) fail('mcp_credential_expired');
    if (identityKey(input.identity) !== item.key) fail('mcp_credential_scope_mismatch');
    return item;
  };
  return {
    issue(input: {
      credentialRef: string;
      identity: McpCredentialIdentity;
      purpose: 'mcp.http';
      expiresAt: number;
      revocationRevision: number;
    }): McpCredentialRef {
      if (input.purpose !== 'mcp.http') fail('mcp_credential_purpose_invalid');
      if (
        !/^credential:[0-9a-f-]{36}$/.test(input.credentialRef) ||
        !Number.isSafeInteger(input.expiresAt) ||
        input.expiresAt <= now() ||
        !Number.isSafeInteger(input.revocationRevision) ||
        input.revocationRevision < 0
      )
        fail('mcp_credential_configuration_invalid');
      const key = identityKey(input.identity);
      for (const [id, item] of handles)
        if (item.revoked || now() >= item.expiresAt) handles.delete(id);
      if (handles.size >= maximum) fail('mcp_credential_capacity');
      const id = `mcp-credential:${crypto.randomUUID()}`;
      handles.set(id, {
        key,
        credentialRef: input.credentialRef,
        expiresAt: input.expiresAt,
        revision: input.revocationRevision,
        revoked: false,
      });
      return Object.freeze({ id });
    },
    revoke(ref: McpCredentialRef): void {
      const item = handles.get(ref?.id);
      if (!item) fail('mcp_credential_unavailable');
      item.revoked = true;
    },
    async withHeaders<T>(
      ref: McpCredentialRef,
      input: McpCredentialUse,
      use: (headers: Readonly<{ authorization: string }>) => T | Promise<T>,
    ): Promise<T> {
      const capturedRef = Object.freeze({ id: ref?.id });
      const captured: McpCredentialUse = { ...input, identity: structuredClone(input.identity) };
      const item = check(capturedRef, captured);
      let abort!: () => void;
      let secret: string;
      try {
        secret = await Promise.race([
          vault.resolve(item.credentialRef),
          new Promise<never>((_resolve, reject) => {
            abort = () => reject(new McpCredentialError('mcp_credential_aborted'));
            captured.signal.addEventListener('abort', abort, { once: true });
            if (captured.signal.aborted) abort();
          }),
        ]);
      } catch (error) {
        if (error instanceof McpCredentialError) throw error;
        fail('mcp_credential_unavailable');
      } finally {
        if (abort) captured.signal.removeEventListener('abort', abort);
      }
      check(capturedRef, captured);
      if (typeof secret !== 'string' || !secret || secret.length > 8000 || hasControl(secret))
        fail('mcp_credential_material_invalid');
      // No await between final checks and the trusted socket callback.
      try {
        return await use(Object.freeze({ authorization: `Bearer ${secret}` }));
      } catch (error) {
        if (error instanceof McpCredentialError) throw error;
        fail('mcp_credential_use_failed');
      }
    },
  };
}
export type McpCredentialBroker = ReturnType<typeof createMcpCredentialBroker>;
