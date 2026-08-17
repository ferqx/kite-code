/** Provider-neutral capability contracts persisted by the Runtime Kernel. */

/** JSON-safe failure details carried across capability and verification boundaries. */
export interface CapabilityFailure {
  kind: string;
  message: string;
  retryable: boolean;
  modelFixable: boolean;
  needsUserIntervention: boolean;
  terminatesTurn: boolean;
  journal: boolean;
  parseFailureCode?: string;
}

/** Provider-neutral capability result stored as an artifact or passed to verification. */
export interface CapabilityResult {
  status: 'success' | 'partial' | 'error' | 'cancelled' | 'unknown';
  content: Array<Record<string, unknown>>;
  structuredContent?: unknown;
  error?: CapabilityFailure;
  providerMeta?: Record<string, unknown>;
}

export type CapabilityKind =
  | 'builtin_tool'
  | 'mcp_tool'
  | 'mcp_resource'
  | 'mcp_prompt'
  | 'skill'
  | 'subagent';
export type CapabilityAvailability = 'available' | 'degraded' | 'unavailable' | 'quarantined';
export type CapabilityApproval = 'none' | 'auto_review' | 'user';
export type CapabilityEffectLevel = 'none' | 'read' | 'write' | 'destructive' | 'unknown';
export type CapabilityDescriptionProvenance =
  | 'builtin'
  | 'user_config'
  | 'approved_project'
  | 'generated'
  | 'remote_untrusted';

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
  /** Sanitized, bounded summary admitted to the model surface. */
  modelDescription?: string;
  /** Optional for backward-compatible persisted descriptors. */
  descriptionProvenance?: CapabilityDescriptionProvenance;
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

/** Digest-only filesystem observation admitted to Runtime state after terminal receipt commit. */
export interface WorkspaceFilesystemObservationRecordV1 {
  actorIdentityDigest: string;
  lexicalTargetDigest: string;
  canonicalTargetDigest: string;
  targetIdentityDigest: string;
  contentDigest: string;
}

/** Durable ready barrier proving that a private preimage exists before commit. */
export interface WorkspaceFilesystemIntentRecordV1 {
  attempt: number;
  capabilityRevision: string;
  argumentsDigest: string;
  admissionDigest: string;
  operationDigest: string;
  searchBoundaryDigest: string | null;
  lexicalTargetDigest: string;
  canonicalWorkspaceDigest: string;
  protectedPathRevision: string;
  approvalSummaryDigest: string;
  effectiveEffectsDigest: string;
  intentDigest: string;
  recordedAt: string;
}

/** Durable ready barrier proving that a private preimage exists before commit. */
export interface WorkspaceFilesystemMutationReadyRecordV1 {
  attempt: number;
  intentDigest: string;
  operationDigest: string;
  targetIdentityDigest: string;
  preimageDigest: string | null;
  preimageArtifact: import('./workspace-filesystem-provider').FilesystemPreimageArtifactRefV1;
  readyDigest: string;
  readyAt: string;
}

/** Durable intent required before an allocating Sandbox Provider prepare call. */
export interface SandboxPreparationIntentRecordV1 {
  attempt: number;
  toolCallId: string;
  capabilityId: string;
  capabilityRevision: string;
  canonicalWorkspace: string;
  effectiveEffectsDigest: string;
  admissionDigest: string;
  preparationDigest: string;
  commandDigest: string;
  executionBoundaryDigest: string;
  resourceSemantics: 'allocating';
  intentDigest: string;
  recordedAt: string;
}

/** Durable ready barrier binding a private prepared plan before process spawn. */
export interface SandboxPreparationReadyRecordV1 {
  attempt: number;
  intentDigest: string;
  preparationDigest: string;
  commandDigest: string;
  planDigest: string;
  backend: import('./sandbox-execution-provider').SandboxExecutionBackendV1;
  backendCapabilitiesDigest: string;
  enforcement: 'full' | 'partial';
  resourceSemantics: import('./sandbox-execution-provider').SandboxPreparationResourceSemanticsV1;
  cleanupDigest: string;
  preparationArtifact: import('./sandbox-execution-provider').SandboxPreparationArtifactRefV1;
  readyDigest: string;
  readyAt: string;
}

/** Durable single-use consumption barrier written before any Runtime process owner starts. */
export interface SandboxExecutionDispatchRecordV1 {
  attempt: number;
  readyDigest: string;
  planDigest: string;
  dispatchId: string;
  supervisorNonce: string;
  dispatchIntentDigest: string;
  status: 'intent_recorded' | 'supervisor_started';
  recordedAt: string;
  supervisorPid?: number;
  processGroupId?: number;
  processStartIdentity?: string;
  supervisorStartedAt?: string;
}

export interface SandboxDisposalRecordV1 {
  attempt: number;
  readyDigest: string;
  lifecycleIntentDigest: string;
  status: 'pending' | 'completed';
  startedAt: string;
  disposedAt?: string;
  attempts: number;
  lastFailureAt?: string;
}

export interface SandboxPreparationAbandonmentRecordV1 {
  attempt: number;
  intentDigest: string;
  lifecycleIntentDigest: string;
  status: 'pending' | 'completed';
  startedAt: string;
  disposedAt?: string;
  attempts: number;
  lastFailureAt?: string;
}

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
  admissionDigest?: string;
  effectiveEffectsDigest: string;
  status: CapabilityInvocationStatus;
  recordedAt: string;
  startedAt?: string;
  attemptsStarted?: number;
  finishedAt?: string;
  resultDigest?: string;
  evidenceDigest?: string;
  artifact?: CapabilityArtifactRef;
  filesystemMutationReady?: WorkspaceFilesystemMutationReadyRecordV1;
  filesystemIntent?: WorkspaceFilesystemIntentRecordV1;
  filesystemObservation?: WorkspaceFilesystemObservationRecordV1;
  sandboxPreparationIntent?: SandboxPreparationIntentRecordV1;
  sandboxPreparationReady?: SandboxPreparationReadyRecordV1;
  sandboxExecutionDispatch?: SandboxExecutionDispatchRecordV1;
  sandboxDisposal?: SandboxDisposalRecordV1;
  sandboxPreparationAbandonment?: SandboxPreparationAbandonmentRecordV1;
  receiptRequirement?:
    | 'observation_receipt'
    | 'effect_receipt'
    | 'control_receipt'
    | 'not_applicable';
  retryEligibility?: 'none' | 'safe_read_candidate' | 'idempotency_key_candidate';
  externalReferences?: string[];
  error?: string;
  idempotencyKey?: string;
  reconciliation?: 'confirmed_success' | 'confirmed_failure' | 'waived';
  reconciledAt?: string;
}

/** Keyed opaque handle emitted by the hardened capability Artifact writer. */
export interface PrivateCapabilityArtifactRefV1 {
  artifactId: string;
  kind: 'capability_result';
  integrityIdentifier: string;
  byteLength: number;
}

/** Previous current-epoch handle retained only for read/restore compatibility. */
export interface LegacyCapabilityArtifactRefV1 {
  artifactId: string;
  relativePath: string;
  byteLength: number;
  digest: string;
}

/** JSON-safe handle to an access-controlled capability result artifact. */
export type CapabilityArtifactRef = PrivateCapabilityArtifactRefV1 | LegacyCapabilityArtifactRefV1;

/** Read-only projection of a durable invocation record for receipts and verification. */
export type ExecutionReceipt = CapabilityInvocationRecord;
