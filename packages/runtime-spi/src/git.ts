export const BROKERED_GIT_FEATURE_REVISION_V1 = 'brokered-git-r1' as const;
export const GIT_BROKER_REVISION_V1 = 'git-broker-v1' as const;
export const GIT_OPERATION_SCHEMA_REVISION_V1 = 'git-operation-schema-v1' as const;

export type GitInspectOperationV1 = 'status' | 'diff' | 'log' | 'branch_list';

export type GitBrokerFailureCodeV1 =
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

export interface GitCapabilityEvidenceV1 {
  featureRevision: typeof BROKERED_GIT_FEATURE_REVISION_V1;
  brokerRevision: typeof GIT_BROKER_REVISION_V1;
  operationSchemaRevision: typeof GIT_OPERATION_SCHEMA_REVISION_V1;
  repositoryBinding: string;
  executableIdentity: string;
  nativeDenyEvidenceIdentity: string;
}

export interface GitShellDenyEvidenceV1 {
  featureRevision: typeof BROKERED_GIT_FEATURE_REVISION_V1;
  platform: 'darwin' | 'linux' | 'win32';
  backend: 'seatbelt' | 'bubblewrap' | 'windows_restricted_token' | 'none';
  outcome: 'qualified' | 'excluded';
  metadataReadDeny: boolean;
  metadataWriteDeny: boolean;
  profileRevision: string;
  profileDigest: string;
  protectedRulesDigest: string;
}

export interface GitInvocationReceiptV1 extends GitCapabilityEvidenceV1 {
  invocationId: string;
  operation: GitInspectOperationV1;
  effect: 'git_inspect';
  startedAtMs: number;
  finishedAtMs: number;
  exitCode: number;
}

export interface GitBrokerResultV1 {
  ok: boolean;
  output: string;
  failureCode?: GitBrokerFailureCodeV1;
  nextCapability?: 'git_inspect';
  receipt?: GitInvocationReceiptV1;
}

export interface GitInspectRequestV1 {
  operation: GitInspectOperationV1;
  paths?: readonly string[];
  revision?: string;
  maxRecords?: number;
  maxOutputBytes?: number;
  timeoutMs?: number;
}
