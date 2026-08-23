export const BROKERED_GIT_FEATURE_REVISION_ = 'brokered-git-r1' as const;
export const GIT_BROKER_REVISION_ = 'git-broker-v1' as const;
export const GIT_OPERATION_SCHEMA_REVISION_ = 'git-operation-schema-v1' as const;

export type GitInspectOperation = 'status' | 'diff' | 'log' | 'branch_list';

export type GitBrokerFailureCode =
  | 'sandbox_capability_missing'
  | 'protected_path_denied'
  | 'git_operation_unsupported'
  | 'managed_network_setup_required'
  | 'repository_invalid'
  | 'repository_hostile'
  | 'binary_untrusted'
  | 'lock'
  | 'cancelled'
  | 'timed_out'
  | 'process_failed'
  | 'receipt_invalid';

export interface GitCapabilityEvidence {
  featureRevision: typeof BROKERED_GIT_FEATURE_REVISION_;
  brokerRevision: typeof GIT_BROKER_REVISION_;
  operationSchemaRevision: typeof GIT_OPERATION_SCHEMA_REVISION_;
  repositoryBinding: string;
  executableIdentity: string;
  nativeDenyEvidenceIdentity: string;
}

export interface GitShellDenyEvidence {
  featureRevision: typeof BROKERED_GIT_FEATURE_REVISION_;
  platform: 'darwin' | 'linux' | 'win32';
  backend: 'seatbelt' | 'bubblewrap' | 'windows_restricted_token' | 'none';
  outcome: 'qualified' | 'excluded';
  metadataReadDeny: boolean;
  metadataWriteDeny: boolean;
  profileRevision: string;
  profileDigest: string;
  protectedRulesDigest: string;
}

export interface GitInvocationReceipt extends GitCapabilityEvidence {
  invocationId: string;
  operation: GitInspectOperation;
  effect: 'git_inspect';
  startedAtMs: number;
  finishedAtMs: number;
  exitCode: number;
}

export interface GitBrokerResult {
  ok: boolean;
  output: string;
  failureCode?: GitBrokerFailureCode;
  nextCapability?: 'git_inspect';
  receipt?: GitInvocationReceipt;
}

export interface GitInspectRequest {
  operation: GitInspectOperation;
  paths?: readonly string[];
  revision?: string;
  maxRecords?: number;
  maxOutputBytes?: number;
  timeoutMs?: number;
}
