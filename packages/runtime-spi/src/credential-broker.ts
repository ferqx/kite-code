/** Opaque reference to credential material held inside Builtin Runtime. */
export interface CredentialHandle {
  readonly handleId: string;
  readonly projectId: string;
  readonly provider: string;
  readonly profile: string;
  readonly purpose: string;
  readonly expiresAt: string;
  readonly revocationRevision: number;
}

export interface CredentialBroker {
  issue(input: Omit<CredentialHandle, 'handleId'>): Promise<CredentialHandle>;
  use(handle: CredentialHandle, purpose: string): Promise<Uint8Array>;
  revoke(handleId: string, revision: number): void;
}
