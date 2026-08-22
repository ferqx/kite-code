import type { RuntimeJsonValueV1 } from './contracts';

/** RAV1-03 provenance, egress and credential authority IR. */
export type DataClassificationV1 = 'public' | 'internal' | 'confidential' | 'secret';
export type DataOriginKindV1 = 'runtime' | 'project' | 'user' | 'external' | 'credential';

export interface DataOriginV1 extends Readonly<Record<string, RuntimeJsonValueV1>> {
  readonly originId: string;
  readonly kind: DataOriginKindV1;
  readonly classification: DataClassificationV1;
  readonly ownerProjectId: string | null;
  readonly parentOriginIds: readonly string[];
  readonly observationId: string;
}

export interface EgressDestinationV1 {
  readonly destinationId: string;
  readonly kind: 'model' | 'mcp' | 'filesystem' | 'process';
  readonly routeIdentity: string;
  readonly nonceNamespace: string;
}

export interface EgressAuthorityV1 {
  readonly egressId: string;
  readonly destination: EgressDestinationV1;
  readonly allowedClassifications: readonly DataClassificationV1[];
  readonly allowedOriginKinds: readonly DataOriginKindV1[];
  readonly invocationId: string;
  readonly expiresAt: string;
}

export interface CredentialHandleV1 {
  readonly handleId: string;
  readonly projectId: string;
  readonly provider: string;
  readonly profile: string;
  readonly purpose: string;
  readonly expiresAt: string;
  readonly revocationRevision: number;
}

export function joinDataOriginsV1(origins: readonly DataOriginV1[]): DataClassificationV1 {
  if (origins.some((origin) => origin.classification === 'secret')) return 'secret';
  if (origins.some((origin) => origin.classification === 'confidential')) return 'confidential';
  if (origins.some((origin) => origin.classification === 'internal')) return 'internal';
  return 'public';
}

export function assertEgressAllowedV1(input: {
  origins: readonly DataOriginV1[];
  authority: EgressAuthorityV1;
  now?: Date;
}): void {
  const { origins, authority, now = new Date() } = input;
  if (Date.parse(authority.expiresAt) <= now.getTime())
    throw new Error('Egress authority expired.');
  const classification = joinDataOriginsV1(origins);
  if (!authority.allowedClassifications.includes(classification))
    throw new Error('Egress classification denied.');
  if (origins.some((origin) => !authority.allowedOriginKinds.includes(origin.kind)))
    throw new Error('Egress origin denied.');
}

export interface CredentialBrokerV1 {
  issue(input: Omit<CredentialHandleV1, 'handleId'>): Promise<CredentialHandleV1>;
  use(handle: CredentialHandleV1, purpose: string): Promise<Uint8Array>;
  revoke(handleId: string, revision: number): void;
}
