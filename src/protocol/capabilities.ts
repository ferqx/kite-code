/** Provider-neutral capability contracts persisted by the Runtime Kernel. */

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

export interface CapabilitySnapshot {
  revision: string;
  descriptors: CapabilityDescriptor[];
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
  externalReferences?: string[];
  error?: string;
  idempotencyKey?: string;
}

/** Read-only projection of a durable invocation record for receipts and verification. */
export type ExecutionReceipt = CapabilityInvocationRecord;
