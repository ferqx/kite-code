import type {
  CapabilityApproval,
  CapabilityAvailability,
  CapabilityDescriptor,
  EffectProfile,
} from './capability-domain';
import type { McpConfigSourceKind, McpWritableScope } from './config-domain';
import type { McpDiagnostic } from './diagnostics';
import type {
  McpHealthState,
  McpPrompt,
  McpResource,
  McpToolRetryPolicy,
  McpTransportType,
} from './types';

export interface McpServerKey {
  name: string;
  source: McpConfigSourceKind;
}

export type McpConfigStatus =
  | 'configured'
  | 'pending_approval'
  | 'approved'
  | 'rejected'
  | 'invalid'
  | 'store_corrupt'
  | 'store_unavailable'
  | 'shadowed'
  | 'disabled';

export type McpAuthStatus =
  | 'not_required'
  | 'login_required'
  | 'authorizing'
  | 'authenticated'
  | 'refreshing'
  | 'reauth_required'
  | 'revoked'
  | 'error';

export interface McpToolControlState {
  name: string;
  description?: string;
  parameters: readonly Readonly<{
    name: string;
    required: boolean;
    type: string;
    description?: string;
  }>[];
  discovered: boolean;
  enabled: boolean;
  availability: CapabilityAvailability;
  available: boolean;
  declaredEffects: Readonly<EffectProfile>;
  effectiveEffects: Readonly<EffectProfile>;
  annotationProvenance: CapabilityDescriptor['provider']['provenance'];
  policySource: 'default' | McpConfigSourceKind;
  minimumApproval: CapabilityApproval;
  retry: McpToolRetryPolicy;
  idempotencyKeyArgument?: string;
  diagnostic?: McpDiagnostic;
}

export interface McpApprovalControlState {
  configDigest: string;
  review: Readonly<{
    command?: string;
    argumentCount?: number;
    endpoint?: string;
  }>;
}

export interface McpServerConfigurationView {
  command?: string;
  argumentCount?: number;
  endpoint?: string;
}

export interface McpServerControlState {
  key: Readonly<McpServerKey>;
  effective: boolean;
  configStatus: McpConfigStatus;
  authStatus: McpAuthStatus;
  credentialPresent: boolean;
  authFlowId?: string;
  authErrorCode?: string;
  health: McpHealthState;
  transport: McpTransportType;
  /** Redacted content boundary; independent of effects approval and Provider consent. */
  contentEgress: Readonly<{
    remote: boolean;
    nonEmptyArgumentsClassification: 'confidential';
    independentPermitRequired: boolean;
  }>;
  source: McpConfigSourceKind;
  sourcePath: string;
  configuration: Readonly<McpServerConfigurationView>;
  revision: string;
  enabled: boolean;
  required: boolean;
  shadowedBy?: McpConfigSourceKind;
  fallbackSource?: McpConfigSourceKind;
  capabilityRevision?: string;
  toolCount: number;
  availableToolCount: number;
  resourceCount: number;
  promptCount: number;
  tools: readonly Readonly<McpToolControlState>[];
  resources: readonly Readonly<McpResource>[];
  prompts: readonly Readonly<McpPrompt>[];
  approval?: Readonly<McpApprovalControlState>;
  retryAt?: number;
  lastAttemptAt?: string;
  diagnostic?: McpDiagnostic;
}

export interface McpControlSnapshot {
  revision: string;
  generation: number;
  servers: readonly Readonly<McpServerControlState>[];
  sourceRevisions: Readonly<Record<McpWritableScope | 'local', string>>;
}
