import type { McpDiagnostic, McpDiagnosticCode } from './diagnostics';
import type { McpProviderDirectoryEntry } from './runtime-provider';

export type McpProviderFailureKind =
  | 'provider_auth_required'
  | 'provider_approval_required'
  | 'provider_unavailable'
  | 'provider_capability_changed';

export type McpProviderRecoveryAction = 'login' | 'approve' | 'retry';

export interface McpProviderFailurePolicyFactsV1 {
  readonly kind: McpProviderFailureKind;
  readonly message: string;
  readonly retryable: boolean;
  readonly modelFixable: boolean;
  readonly needsUserIntervention: boolean;
}

/** Typed, redacted failure crossing the MCP provider → Runtime boundary. */
export class McpProviderError extends Error {
  readonly providerId: string;
  readonly kind: McpProviderFailureKind;
  readonly recoveryAction?: McpProviderRecoveryAction;
  readonly retryable: boolean;
  readonly diagnosticCode?: McpDiagnosticCode;

  constructor(input: {
    providerId: string;
    kind: McpProviderFailureKind;
    message: string;
    recoveryAction?: McpProviderRecoveryAction;
    retryable?: boolean;
    diagnosticCode?: McpDiagnosticCode;
  }) {
    super(input.message);
    this.name = 'McpProviderError';
    this.providerId = input.providerId;
    this.kind = input.kind;
    this.recoveryAction = input.recoveryAction;
    this.retryable = input.retryable ?? false;
    this.diagnosticCode = input.diagnosticCode;
  }
}

export function providerErrorFromDiagnostic(
  providerId: string,
  diagnostic: McpDiagnostic | undefined,
): McpProviderError {
  if (diagnostic?.code === 'auth_required') {
    return new McpProviderError({
      providerId,
      kind: 'provider_auth_required',
      message: diagnostic.message || 'MCP provider authentication is required.',
      recoveryAction: 'login',
      diagnosticCode: diagnostic.code,
    });
  }
  if (diagnostic?.code === 'approval_required') {
    return new McpProviderError({
      providerId,
      kind: 'provider_approval_required',
      message: 'MCP provider approval is required.',
      recoveryAction: 'approve',
      diagnosticCode: diagnostic.code,
    });
  }
  return new McpProviderError({
    providerId,
    kind: 'provider_unavailable',
    message: diagnostic?.message || 'MCP provider is unavailable.',
    recoveryAction: diagnostic?.retryable ? 'retry' : undefined,
    retryable: diagnostic?.retryable ?? false,
    ...(diagnostic ? { diagnosticCode: diagnostic.code } : {}),
  });
}

export function capabilityChangedProviderError(providerId: string): McpProviderError {
  return new McpProviderError({
    providerId,
    kind: 'provider_capability_changed',
    message: 'MCP provider capabilities changed; start a new model turn before retrying.',
  });
}

export function providerErrorFromDirectoryEntry(
  entry: Readonly<McpProviderDirectoryEntry> | undefined,
  providerId: string,
): McpProviderError {
  if (entry?.status === 'pending_approval') {
    return new McpProviderError({
      providerId,
      kind: 'provider_approval_required',
      message: 'MCP provider approval is required.',
      recoveryAction: 'approve',
      diagnosticCode: entry.diagnosticCode,
    });
  }
  if (entry?.status === 'login_required') {
    return new McpProviderError({
      providerId,
      kind: 'provider_auth_required',
      message: 'MCP provider authentication is required.',
      recoveryAction: 'login',
      diagnosticCode: entry.diagnosticCode,
    });
  }
  return providerErrorFromDiagnostic(
    providerId,
    entry?.diagnosticCode
      ? {
          code: entry.diagnosticCode,
          retryable: entry.retryable,
          message: 'MCP provider is unavailable.',
        }
      : undefined,
  );
}

export function isMcpProviderError(error: unknown): error is McpProviderError {
  return error instanceof McpProviderError;
}

/** Builtin-owned MCP facts consumed by the Kernel-owned failure strategy. */
export function mcpProviderFailurePolicyFactsV1(
  error: McpProviderError,
): McpProviderFailurePolicyFactsV1 {
  return Object.freeze({
    kind: error.kind,
    message: error.message,
    retryable: error.retryable,
    modelFixable: error.kind === 'provider_capability_changed',
    needsUserIntervention:
      error.kind === 'provider_auth_required' || error.kind === 'provider_approval_required',
  });
}
