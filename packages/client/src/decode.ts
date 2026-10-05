import type * as API from './generated/api';
import { queryInput, requestValidators, responseValidators } from './generated/validators.js';

export interface Responses {
  FileCheckpointPage: API.FileCheckpointPage;
  FileCheckpointDetail: API.FileCheckpointDetail;
  FileRestoreStatus: API.FileRestoreStatus;
  FileCheckpointRecoveryBoundary: API.FileCheckpointRecoveryBoundary;
  SessionLogPage: API.SessionLogPage;
  SkillCataloguePage: API.SkillCataloguePage;
  HostStatus: API.HostStatus;
  ServiceLifecycle: API.ServiceLifecycle;
  ShutdownServiceResponse: API.ShutdownServiceResponse;
  ModelSettingsView: API.ModelSettingsView;
  ConfigurationView: API.ConfigurationView;
  HostMutation: API.HostMutation;
  SessionExportManifest: API.SessionExportManifest;
  SessionExportPage: API.SessionExportPage;
  SessionExportTextPage: API.SessionExportTextPage;
  SessionExportCompletion: API.SessionExportCompletion;
  WorkspaceDirectoryPage: API.WorkspaceDirectoryPage;
  SessionDirectoryPage: API.SessionDirectoryPage;
  BrowserWorkspaceDirectoryPage: API.BrowserWorkspaceDirectoryPage;
  PermissionModeState: API.PermissionModeState;
  WorkspaceTrustState: API.WorkspaceTrustState;
  PermissionMutation: API.PermissionMutation;
  PermissionGrantPage: API.PermissionGrantPage;
  ModelInputPage: API.ModelInputPage;
  ModelInputSnapshot: API.ModelInputSnapshot;
  ModelOutputSnapshot: API.ModelOutputSnapshot;
  BrowserInfo: API.BrowserInfo;
  BrowserWorkspaceList: API.BrowserWorkspaceList;
  BrowserSessionList: API.BrowserSessionList;
  BrowserView: API.BrowserView;
  SelectedContextPage: API.SelectedContextPage;
  SelectContextResponse: API.SelectContextResponse;
  ForkSessionResponse: API.ForkSessionResponse;
  SessionMutationResponse: API.SessionMutationResponse;
  IncludeResultResponse: API.IncludeResultResponse;
  PendingInputPage: API.PendingInputPage;
  Interaction: API.Interaction;
  InteractionPage: API.InteractionPage;
  ServerInfo: API.ServerInfo;
  Problem: API.Problem;
  Workspace: API.Workspace;
  Session: API.Session;
  SessionView: API.SessionView;
  Command: API.Command;
  ResumeJobReportResponse: API.ResumeJobReportResponse;
  JobReconcileCommand: API.JobReconcileCommand;
  ResumeRunResponse: API.ResumeRunResponse;
  RecoverSessionResponse: API.RecoverSessionResponse;
  Run: API.Run;
  Execution: API.Execution;
  ExecutionOutputPage: API.ExecutionOutputPage;
  Message: API.Message;
  Change: API.Change;
  WorkspaceList: API.WorkspaceList;
  SessionList: API.SessionList;
  MessageList: API.MessageList;
  StreamReady: API.StreamReady;
  StreamCheckpoint: API.StreamCheckpoint;
  ExtensionList: API.ExtensionList;
  QueryResponse: API.QueryResponse;
}

export class ClientError extends Error {
  readonly code: string;
  readonly status: number | undefined;
  readonly problem: API.Problem | undefined;
  constructor(code: string, message = code, status?: number, problem?: API.Problem) {
    super(message);
    this.code = code;
    this.status = status;
    this.problem = problem;
  }
}

/** Build-generated response validators retain additive fields without runtime code generation. */
export function decodeResponse<K extends keyof Responses>(name: K, value: unknown): Responses[K] {
  const validate = responseValidators[name];
  if (!validate(value)) throw new ClientError('invalid_response', `Invalid ${name} response.`);
  return value as Responses[K];
}

export function validateRequest(
  name:
    | 'FileCheckpointListQuery'
    | 'SessionLogQuery'
    | 'BrowserSessionLogQuery'
    | 'SkillCatalogueQuery'
    | 'HostStatusQuery'
    | 'ShutdownServiceRequest'
    | 'ModelSettingsRequest'
    | 'ConfigurationReadQuery'
    | 'HostMutationQuery'
    | 'ConfigurationPatchRequest'
    | 'ConfigurationRepairRequest'
    | 'CredentialPutRequest'
    | 'CredentialRevokeRequest'
    | 'BeginSessionExportQuery'
    | 'SessionExportPageQuery'
    | 'SessionExportTextQuery'
    | 'VerifySessionExportQuery'
    | 'BrowserBeginSessionExportQuery'
    | 'BrowserSessionExportPageQuery'
    | 'BrowserSessionExportTextQuery'
    | 'BrowserVerifySessionExportQuery'
    | 'WorkspaceDirectoryQuery'
    | 'SessionDirectoryQuery'
    | 'BrowserWorkspaceDirectoryQuery'
    | 'BrowserSessionDirectoryQuery'
    | 'PermissionControlQuery'
    | 'SetPermissionModeRequest'
    | 'SetWorkspaceTrustRequest'
    | 'PermissionGrantQuery'
    | 'ClearPermissionGrantsRequest'
    | 'ModelInputQuery'
    | 'ModelOutputQuery'
    | 'BrowserModelInputQuery'
    | 'ContextQuery'
    | 'BrowserContextQuery'
    | 'SelectContextRequest'
    | 'ForkSessionRequest'
    | 'RenameSessionRequest'
    | 'DeleteSessionRequest'
    | 'CompressContextRequest'
    | 'ResetCompressionRequest'
    | 'IncludeResultRequest'
    | 'SteerCommandRequest'
    | 'FollowUpCommandRequest'
    | 'InputListQuery'
    | 'AnswerInteractionRequest'
    | 'InteractionListQuery'
    | 'CreateWorkspaceRequest'
    | 'CreateSessionRequest'
    | 'ResumeRunRequest'
    | 'ResumeRunTarget'
    | 'RecoverSessionRequest'
    | 'RecoverSessionTarget'
    | 'ReconcileJobRequest'
    | 'ReconcileJobTarget'
    | 'ResumeJobReportRequest'
    | 'ResumeJobReportTarget'
    | 'StartCommandRequest'
    | 'CancelCommandRequest'
    | 'CancelRunRequest'
    | 'CancelExecutionRequest'
    | 'CancelSessionRequest'
    | 'ExtensionCommandRequest',
  value: unknown,
): void {
  const validate = requestValidators[name];
  if (!validate(value)) throw new ClientError('invalid_request', `Invalid ${name} request.`);
}

/** Reuse the generated recursive JSON definition for generic Query input. */
export function validateQueryInput(value: unknown): void {
  try {
    if (queryInput(value)) return;
  } catch {}
  throw new ClientError('invalid_query_arguments');
}
