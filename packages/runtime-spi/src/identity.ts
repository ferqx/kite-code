/** Layered identities are deterministic bindings, not separate authority objects. */
export interface ProjectIdentity {
  readonly projectId: `project_${string}`;
  readonly revision: number;
  readonly workspaceDigest: `sha256:${string}`;
}
export interface SessionCompositionIdentity {
  readonly formatEpoch: string;
  readonly stateSchema: 25 | 26;
  readonly storeSchema: 4 | 5;
  readonly kernelRevision: string;
  readonly policyRevision: string;
  readonly project: ProjectIdentity;
  readonly capabilityCatalogRevision: string;
}

export interface ExecutionEnvironmentIdentityBinding {
  readonly platformQualification: string;
  readonly sandbox: string;
  readonly networkPolicy: string;
  readonly protectedPathRevision: string;
  readonly canonicalWorkspaceDigest: `sha256:${string}`;
}

export interface ProviderBindingIdentity {
  readonly provider: string;
  readonly executor: string;
  readonly capabilityRevision: string;
  readonly endpointOrRoute: string;
  readonly requestSchemaDigest: `sha256:${string}`;
  readonly transportBoundary: string;
}

export interface CredentialGrantIdentity {
  readonly projectId: `project_${string}`;
  readonly provider: string;
  readonly serverOrProfile: string;
  readonly purpose: string;
  readonly expiresAt: string;
  readonly revocationRevision: number;
  readonly credentialHandleId: string;
}

export interface ArtifactNamespaceIdentity {
  readonly namespace: string;
  readonly schema: string;
  readonly ownerProjectId: `project_${string}`;
  readonly ownerSessionId: string;
  readonly ownerWorkId: string;
  readonly ownerInvocationId: string;
  readonly retentionPolicy: string;
}

export function canonicalIdentityJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => [key, sortJson(entry)]),
    );
  }
  return value;
}

export function assertIdentityDigest(
  value: string,
  field: string,
): asserts value is `sha256:${string}` {
  if (!/^sha256:[a-f0-9]{64}$/u.test(value))
    throw new Error(`${field} must be a lowercase sha256 digest.`);
}
