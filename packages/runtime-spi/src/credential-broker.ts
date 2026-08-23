/** Opaque reference to credential material held inside Builtin Runtime. */
export interface CredentialHandleV1 {
  readonly handleId: string;
  readonly projectId: string;
  readonly provider: string;
  readonly profile: string;
  readonly purpose: string;
  readonly expiresAt: string;
  readonly revocationRevision: number;
}

export interface CredentialBrokerV1 {
  issue(input: Omit<CredentialHandleV1, 'handleId'>): Promise<CredentialHandleV1>;
  use(handle: CredentialHandleV1, purpose: string): Promise<Uint8Array>;
  revoke(handleId: string, revision: number): void;
}
