/** Provider-neutral capability contracts persisted by the Runtime Kernel. */

/** Closed protocol kinds; dynamic providers remain instances of this contract. */
/** @qualification-surface-v1 {"sourceSurfaceId":"capability-catalog:protocol","featureId":"CAPABILITY-CATALOG_PROTOCOL-001","domain":"runtime","observableContract":"capability_catalog_protocol","risk":"p0","riskRationale":"governed_runtime_boundary","owner":"core-capabilities","entrypoints":["cli","runtime","tui"],"sourceKind":"contract","symbol":"CAPABILITY_KINDS_V1"} */
export const CAPABILITY_KINDS_V1 = [
  'builtin_tool',
  'mcp_tool',
  'mcp_resource',
  'mcp_prompt',
  'skill',
  'subagent',
] as const;
export type CapabilityKind = (typeof CAPABILITY_KINDS_V1)[number];
export type CapabilityAvailability = 'available' | 'degraded' | 'unavailable' | 'quarantined';
export type CapabilityApproval = 'none' | 'auto_review' | 'user';
export type CapabilityEffectLevel = 'none' | 'read' | 'write' | 'destructive' | 'unknown';

export interface EffectProfile {
  filesystem: CapabilityEffectLevel;
  network: CapabilityEffectLevel;
  externalState: CapabilityEffectLevel;
}

export interface CapabilityDescriptor {
  capabilityId: string;
  revision: string;
  kind: CapabilityKind;
  displayName: string;
  description: string;
  provider: {
    type: 'builtin' | 'mcp' | 'skill' | 'subagent';
    id: string;
    version?: string;
    provenance: 'builtin' | 'admin' | 'user' | 'project' | 'remote';
  };
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  declaredEffects: EffectProfile;
  effectiveEffects: EffectProfile;
  policy: {
    workspaceTrustRequired: boolean;
    minimumApproval: CapabilityApproval;
  };
  execution?: {
    retry: 'never' | 'safe_read' | 'idempotency_key';
    idempotencyKeyArgument?: string;
  };
  availability: CapabilityAvailability;
  diagnostics: string[];
}

export interface CapabilityBinding {
  bindingId: string;
  capabilityId: string;
  capabilityRevision: string;
  exposedToolName: string;
  schemaDigest: string;
  issuedForTurnId: string;
}

/** A capability schema selected for stable reuse in one Runtime session. */
export interface LoadedCapability {
  capabilityId: string;
  capabilityRevision: string;
  firstLoadedAtTurnId: string;
}

/** Turn-scoped visibility grant. It is discovery state, never execution authorization. */
export interface CapabilityDisclosure {
  capabilityId: string;
  capabilityRevision: string;
  issuedForTurnId: string;
}

export interface CapabilitySnapshot {
  revision: string;
  descriptors: CapabilityDescriptor[];
}

/** Non-executable metadata returned by provider-neutral capability discovery. */
export interface CapabilitySearchCandidate {
  candidateRef: string;
  capabilityId: string;
  capabilityRevision: string;
  kind: Extract<CapabilityKind, 'mcp_tool' | 'skill'>;
  displayName: string;
  providerType: CapabilityDescriptor['provider']['type'];
  providerId: string;
}

/** Durable, non-executable fact that an MCP provider matched but is unavailable. */
export interface CapabilitySearchProviderDiagnostic {
  providerId: string;
  status:
    | 'pending_approval'
    | 'rejected'
    | 'disabled'
    | 'login_required'
    | 'connecting'
    | 'degraded'
    | 'failed'
    | 'quarantined';
  nextAction: string;
  diagnosticCode?: string;
}

/** Durable search fact. Candidates never contain schemas, arguments, or invocation handles. */
export interface CapabilitySearchResult {
  searchId: string;
  query: string;
  catalogRevision: string;
  requestedAtTurnId: string;
  candidates: CapabilitySearchCandidate[];
  providers?: CapabilitySearchProviderDiagnostic[];
}

/** Durable lifecycle for an invocation that may cross an external side-effect boundary. */
export type CapabilityInvocationStatus =
  | 'recorded'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'unknown';

/** Event-sourced fact record; never contains raw arguments, content, or provider `_meta`. */
export interface CapabilityInvocationRecord {
  invocationId: string;
  toolCallId: string;
  capabilityId: string;
  capabilityRevision: string;
  taskId?: string;
  planId?: string;
  planStepId?: string;
  argumentsDigest: string;
  authorizationDigest: string;
  effectiveEffectsDigest: string;
  status: CapabilityInvocationStatus;
  recordedAt: string;
  startedAt?: string;
  finishedAt?: string;
  resultDigest?: string;
  evidenceDigest?: string;
  artifact?: CapabilityArtifactRef;
  externalReferences?: string[];
  error?: string;
  idempotencyKey?: string;
  reconciliation?: 'confirmed_success' | 'confirmed_failure' | 'waived';
  reconciledAt?: string;
}

/** JSON-safe handle to an access-controlled capability result artifact. */
export interface CapabilityArtifactRef {
  artifactId: string;
  relativePath: string;
  byteLength: number;
  digest: string;
}

/** Read-only projection of a durable invocation record for receipts and verification. */
export type ExecutionReceipt = CapabilityInvocationRecord;
