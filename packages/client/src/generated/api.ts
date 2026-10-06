// Generated from apps/service/src/http/schema. Run bun run generate:unified-api.
export type FileCheckpointListQuery = { afterKey?: string; limit?: number };
export type FileCheckpointBaseline = { hash: string; size: number; device: string; inode: string };
export type FileCheckpointArtifact = {
  id: string;
  mediaType: 'application/octet-stream';
  size: string;
  scope: { kind: 'execution'; id: string };
};
export type FileCheckpointBoundary = {
  storeId: string;
  workspaceId: string;
  sessionId: string;
  runId: string;
  contextSelectionId: string;
  messageId: string | null;
  messageSeq: string;
  triggerMessageId: string;
  triggerSeq: string;
};
export type FileCheckpoint = {
  id: string;
  boundary: {
    storeId: string;
    workspaceId: string;
    sessionId: string;
    runId: string;
    contextSelectionId: string;
    messageId: string | null;
    messageSeq: string;
    triggerMessageId: string;
    triggerSeq: string;
  };
  workspace: { device: string; inode: string };
};
export type FileCheckpointRestoreJournal =
  | {
      id: string;
      checkpointId: string;
      phase: 'blocked';
      reason: 'checkpoint_restore_boundary_unavailable';
      headRevision: string;
      fileRevisions: Array<{ path: string; revision: string }>;
    }
  | {
      id: string;
      checkpointId: string;
      executionId: string;
      planDigest: string;
      phase: 'restoring' | 'restored' | 'failed' | 'outcome_unknown';
      files: Array<{
        path: string;
        operation: 'restore' | 'remove' | 'unchanged';
        state:
          | 'not_started'
          | 'pending'
          | 'restored'
          | 'removed'
          | 'unchanged'
          | 'failed'
          | 'outcome_unknown';
        expected: { hash: string; size: number; device: string; inode: string };
        original: { hash: string; size: number; device: string; inode: string } | null;
        preimage: {
          id: string;
          mediaType: 'application/octet-stream';
          size: string;
          scope: { kind: 'execution'; id: string };
        } | null;
        error: string | null;
      }>;
    }
  | {
      id: string;
      checkpointId: string;
      executionId: string;
      planDigest: string;
      phase: 'restoring' | 'restored' | 'failed' | 'outcome_unknown';
      files: Array<{
        path: string;
        operation: 'restore' | 'remove' | 'unchanged';
        state:
          | 'not_started'
          | 'pending'
          | 'restored'
          | 'removed'
          | 'unchanged'
          | 'failed'
          | 'outcome_unknown';
        expected: { hash: string; size: number; device: string; inode: string } | null;
        original: { hash: string; size: number; device: string; inode: string } | null;
        preimage: {
          id: string;
          mediaType: 'application/octet-stream';
          size: string;
          scope: { kind: 'execution'; id: string };
        } | null;
        error: string | null;
        confirmedPost: {
          baseline: { hash: string; size: number; device: string; inode: string } | null;
        } | null;
      }>;
      rootWorkSeq: string;
    };
export type FileCheckpointPage = {
  storeId: string;
  sessionId: string;
  workspaceId: string;
  payload: {
    items: Array<{
      checkpoint: {
        id: string;
        boundary: {
          storeId: string;
          workspaceId: string;
          sessionId: string;
          runId: string;
          contextSelectionId: string;
          messageId: string | null;
          messageSeq: string;
          triggerMessageId: string;
          triggerSeq: string;
        };
        workspace: { device: string; inode: string };
      };
      revision: string;
    }>;
    nextAfterKey: string | null;
  };
};
export type FileCheckpointDetail = {
  storeId: string;
  sessionId: string;
  workspaceId: string;
  payload: {
    checkpoint: {
      id: string;
      boundary: {
        storeId: string;
        workspaceId: string;
        sessionId: string;
        runId: string;
        contextSelectionId: string;
        messageId: string | null;
        messageSeq: string;
        triggerMessageId: string;
        triggerSeq: string;
      };
      workspace: { device: string; inode: string };
    };
    files: Array<{
      path: string;
      recordRevision: string;
      status: 'restore' | 'remove' | 'unchanged' | 'conflict' | 'unavailable';
      reason: string | null;
      preimage: {
        id: string;
        mediaType: 'application/octet-stream';
        size: string;
        scope: { kind: 'execution'; id: string };
      } | null;
      original: { hash: string; size: number; device: string; inode: string } | null;
      expected: { hash: string; size: number; device: string; inode: string } | null;
    }>;
  };
};
export type FileRestoreStatus = {
  storeId: string;
  sessionId: string;
  workspaceId: string;
  payload: {
    journal:
      | (
          | {
              id: string;
              checkpointId: string;
              phase: 'blocked';
              reason: 'checkpoint_restore_boundary_unavailable';
              headRevision: string;
              fileRevisions: Array<{ path: string; revision: string }>;
            }
          | {
              id: string;
              checkpointId: string;
              executionId: string;
              planDigest: string;
              phase: 'restoring' | 'restored' | 'failed' | 'outcome_unknown';
              files: Array<{
                path: string;
                operation: 'restore' | 'remove' | 'unchanged';
                state:
                  | 'not_started'
                  | 'pending'
                  | 'restored'
                  | 'removed'
                  | 'unchanged'
                  | 'failed'
                  | 'outcome_unknown';
                expected: { hash: string; size: number; device: string; inode: string };
                original: { hash: string; size: number; device: string; inode: string } | null;
                preimage: {
                  id: string;
                  mediaType: 'application/octet-stream';
                  size: string;
                  scope: { kind: 'execution'; id: string };
                } | null;
                error: string | null;
              }>;
            }
          | {
              id: string;
              checkpointId: string;
              executionId: string;
              planDigest: string;
              phase: 'restoring' | 'restored' | 'failed' | 'outcome_unknown';
              files: Array<{
                path: string;
                operation: 'restore' | 'remove' | 'unchanged';
                state:
                  | 'not_started'
                  | 'pending'
                  | 'restored'
                  | 'removed'
                  | 'unchanged'
                  | 'failed'
                  | 'outcome_unknown';
                expected: { hash: string; size: number; device: string; inode: string } | null;
                original: { hash: string; size: number; device: string; inode: string } | null;
                preimage: {
                  id: string;
                  mediaType: 'application/octet-stream';
                  size: string;
                  scope: { kind: 'execution'; id: string };
                } | null;
                error: string | null;
                confirmedPost: {
                  baseline: { hash: string; size: number; device: string; inode: string } | null;
                } | null;
              }>;
              rootWorkSeq: string;
            }
        )
      | null;
    execution: {
      id: string;
      status:
        | 'planned'
        | 'dispatching'
        | 'running'
        | 'succeeded'
        | 'failed'
        | 'cancelled'
        | 'outcome_unknown';
      resultRevision: string;
    } | null;
  };
};
export type FileCheckpointRecoveryBoundary = {
  storeId: string;
  sessionId: string;
  workspaceId: string;
  contextSelectionId: string;
  checkpoint: {
    id: string;
    boundary: {
      storeId: string;
      workspaceId: string;
      sessionId: string;
      runId: string;
      contextSelectionId: string;
      messageId: string | null;
      messageSeq: string;
      triggerMessageId: string;
      triggerSeq: string;
    };
    workspace: { device: string; inode: string };
  };
  boundary: { messageId: string; seq: string } | null;
  trigger: { messageId: string; seq: string };
};
export type SessionLogQuery = {
  afterCursor: string;
  upperCursor?: string;
  limit?: number;
  storeId: string;
};
export type BrowserSessionLogQuery = { afterCursor: string; upperCursor?: string; limit?: number };
export type SessionLogDetails = {
  kind?: 'model' | 'tool' | 'job';
  definitionId?: string;
  definitionVersion?: string;
  commandId?: string;
  runId?: string;
  executionId?: string;
  interactionId?: string;
  attempt?: number;
};
export type SessionLogEntry = {
  cursor: string;
  sessionId: string;
  objectId: string;
  type: string;
  revision: string;
  occurredAt: number | null;
  category:
    | 'command'
    | 'run'
    | 'execution'
    | 'interaction'
    | 'message'
    | 'context'
    | 'extension'
    | 'session'
    | 'other';
  recordedStatus:
    | (
        | 'accepted'
        | 'applied'
        | 'rejected'
        | 'needs_review'
        | 'running'
        | 'waiting_interaction'
        | 'waiting_execution'
        | 'cancelling'
        | 'completed'
        | 'failed'
        | 'cancelled'
        | 'interrupted'
        | 'planned'
        | 'dispatching'
        | 'succeeded'
        | 'outcome_unknown'
        | 'pending'
        | 'answered'
        | 'complete'
        | 'incomplete'
      )
    | null;
  summary: string;
  details: {
    kind?: 'model' | 'tool' | 'job';
    definitionId?: string;
    definitionVersion?: string;
    commandId?: string;
    runId?: string;
    executionId?: string;
    interactionId?: string;
    attempt?: number;
  };
  modelExecutionId: string | null;
};
export type SessionLogPage = {
  storeId: string;
  sessionId: string;
  upperCursor: string;
  nextAfterCursor: string | null;
  replayFloor: string;
  snapshotCursor: string;
  entries: Array<{
    cursor: string;
    sessionId: string;
    objectId: string;
    type: string;
    revision: string;
    occurredAt: number | null;
    category:
      | 'command'
      | 'run'
      | 'execution'
      | 'interaction'
      | 'message'
      | 'context'
      | 'extension'
      | 'session'
      | 'other';
    recordedStatus:
      | (
          | 'accepted'
          | 'applied'
          | 'rejected'
          | 'needs_review'
          | 'running'
          | 'waiting_interaction'
          | 'waiting_execution'
          | 'cancelling'
          | 'completed'
          | 'failed'
          | 'cancelled'
          | 'interrupted'
          | 'planned'
          | 'dispatching'
          | 'succeeded'
          | 'outcome_unknown'
          | 'pending'
          | 'answered'
          | 'complete'
          | 'incomplete'
        )
      | null;
    summary: string;
    details: {
      kind?: 'model' | 'tool' | 'job';
      definitionId?: string;
      definitionVersion?: string;
      commandId?: string;
      runId?: string;
      executionId?: string;
      interactionId?: string;
      attempt?: number;
    };
    modelExecutionId: string | null;
  }>;
  complete: boolean;
};
export type SkillCatalogueQuery = {
  storeId: string;
  workflow?: 'manual';
  afterId?: string;
  revision?: string;
  limit?: number;
  byteLimit?: number;
};
export type SkillCataloguePage = {
  version: 1;
  storeId: string;
  workspaceId: string;
  revision: string;
  availability: 'available' | 'unavailable';
  reason:
    | (
        | 'configuration_unavailable'
        | 'workspace_configuration_unavailable'
        | 'skill_catalogue_source_unavailable'
      )
    | null;
  entries: Array<{
    id: string;
    source?: {
      scope: 'project' | 'user';
      origin: '.agents' | '.kite-code' | 'profile' | 'configured';
    } | null;
    name: string | null;
    description: string | null;
    version: string | null;
    enabled: boolean;
    state: 'available' | 'disabled' | 'unavailable';
    reason:
      | (
          | 'invalid_skill_configuration'
          | 'skill_path_denied'
          | 'unsupported_skill_options'
          | 'skill_unavailable'
          | 'skill_version_changed'
          | 'duplicate_skill_location'
          | 'skill_capability_missing'
          | 'skill_metadata_limit'
          | 'skill_text_limit'
          | 'skill_text_invalid'
          | 'skill_path_changed'
        )
      | null;
    requiredCapabilities: Array<string>;
    missingCapabilities: Array<string>;
    workflow?: {
      extensionId: 'builtin.skill-workflow';
      definitionVersion: '1';
      skillId: string | null;
      name: string | null;
      revision: string | null;
      state: 'available' | 'disabled' | 'unavailable';
      reason:
        | (
            | 'workflow_disabled'
            | 'workflow_configuration_unavailable'
            | 'workflow_contract_unavailable'
            | 'workflow_dependency_unavailable'
            | 'workflow_manual_not_allowed'
            | 'workflow_input_required'
            | 'workflow_fork_unavailable'
            | 'workflow_verifier_unavailable'
            | 'workflow_source_changed'
            | 'skill_unavailable'
          )
        | null;
      manualAllowed: boolean;
      emptyInputValid: boolean;
      contextMode: ('inline' | 'fork') | null;
    };
  }>;
  nextAfterId: string | null;
  complete: boolean;
};
export type HostStatusQuery = { workspaceId?: string; sessionId?: string };
export type HostStatus = {
  version: 1;
  identity: {
    instanceId: string;
    buildId: string;
    apiMajor: 1;
    profileAccessKey: string;
    dataAvailability: 'available' | 'unavailable';
    storeId: string | null;
  };
  scope: { workspaceId: string | null; sessionId: string | null };
  execution: {
    state: 'available' | 'unavailable';
    reason: 'diagnostic_source_unavailable' | null;
    sandbox: { backend: 'none'; available: false; qualification: 'unqualified' };
    shell: {
      configured: boolean;
      available: boolean;
      supervision: 'none' | 'posix_group';
      qualification: 'not_configured' | 'darwin_supervision_only' | 'unavailable';
      reason:
        | (
            | 'shell_not_configured'
            | 'shell_platform_unqualified'
            | 'shell_asset_unavailable'
            | 'invalid_shell_configuration'
            | 'diagnostic_source_unavailable'
          )
        | null;
    };
    permissions: {
      state: 'available' | 'unbound' | 'unavailable';
      scope: 'default' | 'session' | 'unbound';
      mode: ('ask' | 'auto' | 'accept_edits' | 'full') | null;
      defaultMode: ('ask' | 'auto' | 'accept_edits' | 'full') | null;
      workspaceTrust: 'trusted' | 'untrusted' | 'scope_changed' | 'unbound' | 'unavailable';
      reason: ('data_unavailable' | 'permission_source_unavailable') | null;
    };
  };
  release: {
    state: 'available' | 'unavailable';
    active: false;
    production: null;
    qualification: 'unverified';
    reason: 'release_manifest_not_bound' | 'diagnostic_source_unavailable';
  };
  telemetry: {
    state: 'available' | 'unavailable';
    enabled: false;
    exporterConfigured: false;
    diskSpool: false;
    reason: 'exporter_not_configured' | 'diagnostic_source_unavailable';
  };
};
type ModelInputMetadata___schema0 =
  | string
  | number
  | boolean
  | null
  | Array<ModelInputMetadata___schema0>
  | { [key: string]: ModelInputMetadata___schema0 };
export type ModelInputMetadata =
  | {
      version: 1;
      adapter:
        | {
            availability: 'available';
            adapterId: string;
            adapterVersion: string;
            provider:
              | { availability: 'available'; family: string; modelId: string }
              | { availability: 'unavailable'; reason: string };
            settings: {
              temperature?: number;
              topP?: number;
              maxOutputTokens?: number;
              reasoningEffort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
              maxRetries: number;
              maxSteps: number;
              allowSystemInMessages: boolean;
              includeUsage?: boolean;
            };
            transformation: { id: string; version: string };
          }
        | { availability: 'unavailable'; reason: 'adapter_opaque' };
      assembly: {
        extensions: Array<{ id: string; version: string }>;
        tools: Array<{ id: string; definitionVersion: string; extensionId: string }>;
        capabilitySnapshotDigest: string | null;
      };
      context: {
        transformationId: 'kite.model-request';
        transformationVersion: '1';
        messageOrder: 'request.messages';
        sourceOrder: 'request.messages[].sourceIds';
        sources: Array<{ id: string; digest: string }>;
      };
      authorization:
        | { availability: 'unavailable'; reason: 'not_dispatched' }
        | {
            availability: 'available';
            allowed: true;
            revision: string;
            definitionVersion: string;
            inputDigest: string;
            controlReads?: Array<{
              kind: 'permission.mode' | 'workspace.trust';
              scope: string;
              revision: string;
            }>;
            policy: {
              namespace: string;
              version: string;
              data: ModelInputMetadata___schema0;
            } | null;
          };
    }
  | {
      version: 1;
      adapter: { availability: 'unavailable'; reason: 'not_recorded' | 'unsupported_version' };
      assembly: null;
      context: null;
      authorization:
        | { availability: 'unavailable'; reason: 'not_dispatched' }
        | {
            availability: 'available';
            allowed: true;
            revision: string;
            definitionVersion: string;
            inputDigest: string;
            controlReads?: Array<{
              kind: 'permission.mode' | 'workspace.trust';
              scope: string;
              revision: string;
            }>;
            policy: {
              namespace: string;
              version: string;
              data: ModelInputMetadata___schema0;
            } | null;
          };
    };
export type PermissionControlQuery = { storeId: string };
export type PermissionModeState = {
  storeId: string;
  sessionId: string;
  scopeSessionId: string;
  mode: 'ask' | 'accept_edits' | 'auto' | 'full';
  revision: string;
  defaultMode: 'ask' | 'accept_edits' | 'auto' | 'full';
  defaultRevision: string;
};
export type WorkspaceTrustState = {
  storeId: string;
  workspaceId: string;
  status: 'trusted' | 'untrusted' | 'scope_changed';
  trusted: boolean;
  revision: string;
  canonicalIdentity: string;
  externalReadScopeDigest: string;
  readScopes: Array<{ kind: string; description: string }>;
};
export type SetPermissionModeRequest = {
  expectedStoreId: string;
  commandId: string;
  mode: 'ask' | 'accept_edits' | 'auto' | 'full';
  ifRevision: string;
  makeDefault: boolean;
  ifDefaultRevision: string;
};
export type SetWorkspaceTrustRequest = {
  expectedStoreId: string;
  commandId: string;
  canonicalIdentity: string;
  externalReadScopeDigest: string;
  trusted: boolean;
  ifRevision: string;
};
export type PermissionGrantQuery = {
  storeId: string;
  afterSeq?: string;
  upperSeq?: string;
  limit?: number;
};
export type PermissionGrantPage = {
  storeId: string;
  sessionId: string;
  revision: string;
  items: Array<{
    seq: string;
    grant: {
      id: string;
      originStoreId: string;
      sessionId: string;
      workspaceId: string;
      kind: 'tool' | 'job';
      definitionId: string;
      definitionVersion: string;
      inputDigest: string;
      commandDigest?: string;
      interactionId: string;
      decisionRevision: string;
      executionId: string;
    };
  }>;
  highWaterSeq: string;
  upperSeq: string;
  nextAfterSeq: string | null;
  snapshotCursor: string;
};
export type ClearPermissionGrantsRequest = {
  expectedStoreId: string;
  commandId: string;
  ifRevision: string;
};
export type PermissionMutation =
  | (
      | {
          commandId: string;
          kind: 'permission.mode';
          state: 'pending';
          receipt: Record<string, never>;
        }
      | {
          commandId: string;
          kind: 'permission.mode';
          state: 'applied';
          receipt: {
            status: 'applied';
            mode: 'ask' | 'accept_edits' | 'auto' | 'full';
            revision: string;
            makeDefault: boolean;
            defaultRevision: string;
          };
        }
      | {
          commandId: string;
          kind: 'permission.mode';
          state: 'failed';
          receipt: { status: 'failed'; code?: string };
        }
      | {
          commandId: string;
          kind: 'permission.mode';
          state: 'outcome_unknown';
          receipt: { status: 'outcome_unknown'; code?: string };
        }
    )
  | (
      | {
          commandId: string;
          kind: 'workspace.trust';
          state: 'pending';
          receipt: Record<string, never>;
        }
      | {
          commandId: string;
          kind: 'workspace.trust';
          state: 'applied';
          receipt: {
            status: 'applied';
            trusted: boolean;
            revision: string;
            canonicalIdentity: string;
            externalReadScopeDigest: string;
          };
        }
      | {
          commandId: string;
          kind: 'workspace.trust';
          state: 'failed';
          receipt: { status: 'failed'; code?: string };
        }
      | {
          commandId: string;
          kind: 'workspace.trust';
          state: 'outcome_unknown';
          receipt: { status: 'outcome_unknown'; code?: string };
        }
    )
  | (
      | {
          commandId: string;
          kind: 'permission.grants.clear';
          state: 'pending';
          receipt: Record<string, never>;
        }
      | {
          commandId: string;
          kind: 'permission.grants.clear';
          state: 'applied';
          receipt: { status: 'applied'; sessionId: string; revision: string };
        }
      | {
          commandId: string;
          kind: 'permission.grants.clear';
          state: 'failed';
          receipt: { status: 'failed'; code?: string };
        }
      | {
          commandId: string;
          kind: 'permission.grants.clear';
          state: 'outcome_unknown';
          receipt: { status: 'outcome_unknown'; code?: string };
        }
    );
export type ModelInputQuery = {
  storeId: string;
  afterSeq?: string;
  upperSeq?: string;
  limit?: number;
};
export type ModelInputPage = {
  storeId: string;
  sessionId: string;
  rootSessionId: string;
  items: Array<{
    seq: string;
    executionId: string;
    sessionId: string;
    runId: string;
    originCommandId: string;
    rootWorkCommandId: string;
    rootWorkSeq: string;
    attempt: number;
    status:
      | 'planned'
      | 'dispatching'
      | 'running'
      | 'succeeded'
      | 'failed'
      | 'cancelled'
      | 'outcome_unknown';
    confirmation: 'succeeded' | 'unconfirmed';
    modelId: string;
  }>;
  highWaterSeq: string;
  upperSeq: string;
  nextAfterSeq: string | null;
  snapshotCursor: string;
};
type ModelInputSnapshot___schema0 =
  | string
  | number
  | boolean
  | null
  | Array<ModelInputSnapshot___schema0>
  | { [key: string]: ModelInputSnapshot___schema0 };
export type ModelInputSnapshot = {
  storeId: string;
  sessionId: string;
  rootSessionId: string;
  runId: string;
  executionId: string;
  originCommandId: string;
  rootWorkCommandId: string;
  rootWorkSeq: string;
  attempt: number;
  status:
    | 'planned'
    | 'dispatching'
    | 'running'
    | 'succeeded'
    | 'failed'
    | 'cancelled'
    | 'outcome_unknown';
  confirmation: 'succeeded' | 'unconfirmed';
  bodyHash: string;
  bodyBytes: string;
  snapshotCursor: string;
  request: {
    modelId: string;
    requestId: string;
    messages: Array<{
      role: 'system' | 'user' | 'assistant' | 'tool';
      content: string;
      toolCalls?: Array<{ id: string; name: string; arguments: string }>;
      toolCallId?: string;
      sourceIds?: Array<string>;
    }>;
    tools: Array<{
      id: string;
      definitionVersion: string;
      description?: string;
      inputSchema: { [key: string]: ModelInputSnapshot___schema0 };
    }>;
  };
  metadata:
    | {
        version: 1;
        adapter:
          | {
              availability: 'available';
              adapterId: string;
              adapterVersion: string;
              provider:
                | { availability: 'available'; family: string; modelId: string }
                | { availability: 'unavailable'; reason: string };
              settings: {
                temperature?: number;
                topP?: number;
                maxOutputTokens?: number;
                reasoningEffort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
                maxRetries: number;
                maxSteps: number;
                allowSystemInMessages: boolean;
                includeUsage?: boolean;
              };
              transformation: { id: string; version: string };
            }
          | { availability: 'unavailable'; reason: 'adapter_opaque' };
        assembly: {
          extensions: Array<{ id: string; version: string }>;
          tools: Array<{ id: string; definitionVersion: string; extensionId: string }>;
          capabilitySnapshotDigest: string | null;
        };
        context: {
          transformationId: 'kite.model-request';
          transformationVersion: '1';
          messageOrder: 'request.messages';
          sourceOrder: 'request.messages[].sourceIds';
          sources: Array<{ id: string; digest: string }>;
        };
        authorization:
          | { availability: 'unavailable'; reason: 'not_dispatched' }
          | {
              availability: 'available';
              allowed: true;
              revision: string;
              definitionVersion: string;
              inputDigest: string;
              controlReads?: Array<{
                kind: 'permission.mode' | 'workspace.trust';
                scope: string;
                revision: string;
              }>;
              policy: {
                namespace: string;
                version: string;
                data: ModelInputSnapshot___schema0;
              } | null;
            };
      }
    | {
        version: 1;
        adapter: { availability: 'unavailable'; reason: 'not_recorded' | 'unsupported_version' };
        assembly: null;
        context: null;
        authorization:
          | { availability: 'unavailable'; reason: 'not_dispatched' }
          | {
              availability: 'available';
              allowed: true;
              revision: string;
              definitionVersion: string;
              inputDigest: string;
              controlReads?: Array<{
                kind: 'permission.mode' | 'workspace.trust';
                scope: string;
                revision: string;
              }>;
              policy: {
                namespace: string;
                version: string;
                data: ModelInputSnapshot___schema0;
              } | null;
            };
      };
};
export type ModelOutputQuery = { storeId: string };
export type ModelOutputSnapshot = {
  storeId: string;
  sessionId: string;
  rootSessionId: string;
  runId: string;
  executionId: string;
  originCommandId: string;
  rootWorkCommandId: string;
  rootWorkSeq: string;
  attempt: number;
  status:
    | 'planned'
    | 'dispatching'
    | 'running'
    | 'succeeded'
    | 'failed'
    | 'cancelled'
    | 'outcome_unknown';
  bodyHash: string;
  bodyBytes: string;
  contentBytes: string;
  reasoningBytes: string;
  snapshotCursor: string;
  output: {
    content: string;
    reasoning: string;
    toolCalls: Array<{ id: string; name: string; arguments: string }>;
    complete: boolean;
  };
};
export type ContextSelection = {
  id: string;
  sessionId: string;
  previousSelectionId: string | null;
  boundaryMessageId: string | null;
  boundarySeq: string;
  tailFromSeq: string;
  ranges: Array<{ afterSeq: string; throughSeq: string }>;
};
type ResultContextSource___schema0 =
  | string
  | number
  | boolean
  | null
  | Array<ResultContextSource___schema0>
  | { [key: string]: ResultContextSource___schema0 };
export type ResultContextSource = {
  id: string;
  seq: string;
  sessionId: string;
  createdSelectionId: string;
  executionId: string;
  resultRevision: string;
  originStoreId: string;
  inclusion: 'automatic' | 'explicit';
  result: ResultContextSource___schema0;
};
export type ContextQuery = {
  storeId: string;
  contextSelectionId?: string;
  afterSeq?: string;
  upperSeq?: string;
  messageLimit?: number;
  afterSourceId?: string;
  sourceLimit?: number;
  byteLimit?: number;
};
export type SelectContextRequest = {
  expectedStoreId: string;
  commandId: string;
  expectedContextSelectionId: string;
  boundary: { messageId: string; seq: string } | null;
};
export type ForkSessionRequest = {
  expectedStoreId: string;
  commandId: string;
  expectedContextSelectionId: string;
  boundary?: { messageId: string; seq: string } | null;
  newSessionId: string;
  title: string;
};
export type RenameSessionRequest = {
  expectedStoreId: string;
  commandId: string;
  ifRevision: string;
  title: string;
};
export type DeleteSessionRequest = {
  expectedStoreId: string;
  commandId: string;
  ifRevision: string;
};
export type CompressContextRequest = {
  expectedStoreId: string;
  commandId: string;
  expectedContextSelectionId: string;
  focus?: string;
};
export type ResetCompressionRequest = {
  expectedStoreId: string;
  commandId: string;
  expectedContextSelectionId: string;
  expectedCompressionId: string | null;
};
type CompressionRecord___schema0 =
  | string
  | number
  | boolean
  | null
  | Array<CompressionRecord___schema0>
  | { [key: string]: CompressionRecord___schema0 };
export type CompressionRecord = {
  id: string;
  originSessionId: string;
  originCompressionId: string;
  sessionId: string;
  contextSelectionId: string;
  originStoreId: string;
  modelExecutionId: string;
  runId: string;
  coveredThroughSeq: string;
  publishedSeq: string;
  previousCompressionId: string | null;
  compressor: { id: string; version: string; snapshot: CompressionRecord___schema0 };
  trigger: 'manual' | 'automatic';
};
export type IncludeResultRequest = {
  expectedStoreId: string;
  commandId: string;
  expectedContextSelectionId: string;
  resultRevision: string;
  targetRunId?: string;
};
export type SteerCommandRequest = {
  kind: 'input.steer';
  content: string;
  targetRunId: string;
  contextSelectionId: string;
  expectedStoreId: string;
  commandId: string;
};
type FollowUpCommandRequest___schema0 =
  | string
  | number
  | boolean
  | null
  | Array<FollowUpCommandRequest___schema0>
  | { [key: string]: FollowUpCommandRequest___schema0 };
export type FollowUpCommandRequest = {
  kind: 'input.follow_up';
  content: string;
  afterRunId: string | null;
  contextSelectionId: string;
  modelId?: string;
  reasoningEffort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  selectedSkills?: Array<string>;
  extensionInputs?: Array<{
    extensionId: string;
    definitionVersion: string;
    input: FollowUpCommandRequest___schema0;
  }>;
  expectedStoreId: string;
  commandId: string;
};
export type InputListQuery = {
  storeId: string;
  kind?: 'input.steer' | 'input.follow_up';
  targetRunId?: string;
  afterSeq?: string;
  limit?: number;
};
type Interaction___schema0 =
  | string
  | number
  | boolean
  | null
  | Array<Interaction___schema0>
  | { [key: string]: Interaction___schema0 };
export type Interaction = {
  id: string;
  originStoreId: string;
  sessionId: string;
  runId: string | null;
  executionId: string;
  attempt: number;
  presentationSessionId: string;
  ancestry: Array<string>;
  kind: 'approval' | 'question' | 'plan_review';
  definitionId: string;
  definitionVersion: string;
  inputDigest: string;
  policyRevision: string;
  requiredRefs: Array<{
    extensionId: string;
    definitionVersion: string;
    requirementId: string;
    revision: string;
    phase: 'dispatch' | 'completion' | 'both';
    sessionId: string;
    runId: string;
    executionId?: string;
    attempt?: number;
    recordKey: string;
  }>;
  request: Interaction___schema0;
  answer:
    | (
        | {
            kind: 'approval';
            decision: 'approve' | 'deny';
            grant?: 'approve_once' | 'same_command';
          }
        | { kind: 'question'; answers: Interaction___schema0 }
        | {
            kind: 'plan_review';
            decision: 'approve' | 'deny' | 'revise';
            feedback?: string;
            mode?: string;
          }
      )
    | null;
  revision: string;
  acceptedDecisionRevision: string | null;
  state: 'pending' | 'answered' | 'cancelled';
};
type InteractionPage___schema0 =
  | string
  | number
  | boolean
  | null
  | Array<InteractionPage___schema0>
  | { [key: string]: InteractionPage___schema0 };
export type InteractionPage = {
  interactions: Array<{
    id: string;
    originStoreId: string;
    sessionId: string;
    runId: string | null;
    executionId: string;
    attempt: number;
    presentationSessionId: string;
    ancestry: Array<string>;
    kind: 'approval' | 'question' | 'plan_review';
    definitionId: string;
    definitionVersion: string;
    inputDigest: string;
    policyRevision: string;
    requiredRefs: Array<{
      extensionId: string;
      definitionVersion: string;
      requirementId: string;
      revision: string;
      phase: 'dispatch' | 'completion' | 'both';
      sessionId: string;
      runId: string;
      executionId?: string;
      attempt?: number;
      recordKey: string;
    }>;
    request: InteractionPage___schema0;
    answer:
      | (
          | {
              kind: 'approval';
              decision: 'approve' | 'deny';
              grant?: 'approve_once' | 'same_command';
            }
          | { kind: 'question'; answers: InteractionPage___schema0 }
          | {
              kind: 'plan_review';
              decision: 'approve' | 'deny' | 'revise';
              feedback?: string;
              mode?: string;
            }
        )
      | null;
    revision: string;
    acceptedDecisionRevision: string | null;
    state: 'pending' | 'answered' | 'cancelled';
  }>;
  nextAfterId: string | null;
  snapshotCursor: string;
};
type AnswerInteractionRequest___schema0 =
  | string
  | number
  | boolean
  | null
  | Array<AnswerInteractionRequest___schema0>
  | { [key: string]: AnswerInteractionRequest___schema0 };
export type AnswerInteractionRequest = {
  expectedStoreId: string;
  commandId: string;
  expectedRevision: string;
  answer:
    | { kind: 'approval'; decision: 'approve' | 'deny'; grant?: 'approve_once' | 'same_command' }
    | { kind: 'question'; answers: AnswerInteractionRequest___schema0 }
    | {
        kind: 'plan_review';
        decision: 'approve' | 'deny' | 'revise';
        feedback?: string;
        mode?: string;
      };
};
export type InteractionListQuery = {
  storeId: string;
  afterId?: string;
  limit?: number;
  state?: 'pending' | 'answered' | 'cancelled';
};
export type ModelSettingsView = {
  storeId: string;
  scope: 'user' | 'workspace';
  workspaceId?: string;
  readSet: {
    userEtag: string;
    workspaceEtag: string | null;
    explicitDigest: string;
    effectiveDigest: string;
  } | null;
  defaultModelId: string | null;
  models: Array<{
    id: string;
    enabled: boolean;
    configured: boolean;
    provider?: string;
    model?: string;
    reasoningEffort?: ('none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max') | null;
    reasoningEffortChoices?: Array<
      'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
    >;
    reasoningEffortSupport?: 'compatible_wire' | 'unsupported';
    reasoningEffortReadonlyReason?:
      | ('model_settings_override' | 'model_reasoning_effort_unsupported')
      | null;
    diagnostics: Array<string>;
  }>;
  errors: Array<string>;
};
export type ModelSettingsRequest = {
  expectedStoreId: string;
  commandId: string;
  workspaceId?: string;
  expectedReadSet: {
    userEtag: string;
    workspaceEtag: string | null;
    explicitDigest: string;
    effectiveDigest: string;
  };
  operation:
    | { kind: 'enabled'; modelId: string; enabled: boolean }
    | { kind: 'default'; modelId: string }
    | {
        kind: 'effort';
        modelId: string;
        reasoningEffort: ('none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max') | null;
      };
};
export type ProviderSettingsView = {
  storeId: string;
  readSet: {
    userEtag: string;
    workspaceEtag: string | null;
    explicitDigest: string;
    effectiveDigest: string;
  } | null;
  providers: Array<{
    id: 'openai' | 'deepseek' | 'compatible' | 'ollama';
    label: string;
    defaultBaseURL: string;
    requiresCredential: boolean;
    connections: Array<{
      id: string;
      baseURL: string;
      hasCredential: boolean;
      modelNames: Array<string>;
      canWrite: boolean;
    }>;
  }>;
  errors: Array<string>;
};
export type ProviderSettingsRequest = {
  expectedStoreId: string;
  commandId: string;
  expectedReadSet: {
    userEtag: string;
    workspaceEtag: string | null;
    explicitDigest: string;
    effectiveDigest: string;
  };
  operation: {
    provider: 'openai' | 'deepseek' | 'compatible' | 'ollama';
    connectionId: string | null;
    baseURL: string;
    modelNames: Array<string>;
    credential: 'keep' | 'replace' | 'none';
  };
  secret?: string;
};
export type ConfigurationReadQuery = { storeId?: string; workspaceId?: string };
export type HostMutationQuery = { storeId: string };
type ConfigurationView___schema0 =
  | string
  | number
  | boolean
  | null
  | Array<ConfigurationView___schema0>
  | { [key: string]: ConfigurationView___schema0 };
export type ConfigurationView = {
  storeId?: string;
  scope: 'user' | 'workspace';
  workspaceId?: string;
  etag: string;
  raw: ConfigurationView___schema0 | null;
  effective: ConfigurationView___schema0 | null;
  snapshot: ConfigurationView___schema0 | null;
  errors: Array<string>;
};
type ConfigurationPatchRequest___schema0 =
  | string
  | number
  | boolean
  | null
  | Array<ConfigurationPatchRequest___schema0>
  | { [key: string]: ConfigurationPatchRequest___schema0 };
export type ConfigurationPatchRequest = {
  commandId: string;
  expectedStoreId: string;
  ifMatch: string;
  workspaceId?: string;
  operations: Array<
    | { kind: 'set'; path: Array<string | number>; value: ConfigurationPatchRequest___schema0 }
    | { kind: 'remove'; path: Array<string | number> }
  >;
};
type ConfigurationRepairRequest___schema0 =
  | string
  | number
  | boolean
  | null
  | Array<ConfigurationRepairRequest___schema0>
  | { [key: string]: ConfigurationRepairRequest___schema0 };
export type ConfigurationRepairRequest = {
  commandId: string;
  expectedStoreId: string;
  ifMatch: string;
  workspaceId?: string;
  value: { [key: string]: ConfigurationRepairRequest___schema0 };
};
export type CredentialPutRequest = { commandId: string; expectedStoreId: string; secret: string };
export type CredentialRevokeRequest = { commandId: string; expectedStoreId: string };
export type HostMutation = {
  commandId: string;
  originStoreId: string;
  scope: 'user' | 'workspace';
  workspaceId?: string;
  ifMatch?: string;
  kind:
    | 'config.patch'
    | 'config.repair'
    | 'credential.put'
    | 'credential.revoke'
    | 'model_settings.update'
    | 'provider_settings.update';
  modelSettings?: {
    expectedReadSet: {
      userEtag: string;
      workspaceEtag: string | null;
      explicitDigest: string;
      effectiveDigest: string;
    };
    operation:
      | { kind: 'enabled'; modelId: string; enabled: boolean }
      | { kind: 'default'; modelId: string }
      | {
          kind: 'effort';
          modelId: string;
          reasoningEffort:
            | ('none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max')
            | null;
        };
  };
  providerSettings?: {
    expectedReadSet: {
      userEtag: string;
      workspaceEtag: string | null;
      explicitDigest: string;
      effectiveDigest: string;
    };
    operation: {
      provider: 'openai' | 'deepseek' | 'compatible' | 'ollama';
      connectionId: string | null;
      baseURL: string;
      modelNames: Array<string>;
      credential: 'keep' | 'replace' | 'none';
    };
  };
  state: 'pending' | 'applied' | 'failed' | 'outcome_unknown';
  receipt:
    | Record<string, never>
    | { status: 'applied'; etag: string }
    | {
        status: 'applied';
        etag: string;
        credentialState: 'unchanged' | 'stored';
        configurationState: 'published';
        opaqueRef?: string;
      }
    | { status: 'applied'; opaqueRef: string; persistence: 'os' | 'temporary' }
    | { status: 'failed' | 'outcome_unknown'; code: string }
    | {
        status: 'failed' | 'outcome_unknown';
        code: string;
        credentialState: 'unchanged' | 'stored' | 'outcome_unknown';
        configurationState: 'not_attempted' | 'outcome_unknown';
        opaqueRef?: string;
      };
};
export type ServiceLifecycle = {
  lifecycleVersion: 1;
  profile: { dataRoot: string; name: string; accessKey: string };
  instanceId: string;
  buildId: string;
  apiMajor: number;
  capabilities: Array<string>;
  dataAvailability: 'available' | 'unavailable';
  state: 'accepting' | 'draining' | 'closed' | 'drain_failed';
  busy: boolean;
  reasons: Array<'admission' | 'dispatch' | 'execution' | 'background' | 'cleanup'>;
};
export type ShutdownServiceRequest = {
  lifecycleVersion: 1;
  expectedProfile: { dataRoot: string; name: string; accessKey: string };
  expectedInstanceId: string;
  mode: 'if_idle' | 'cancel';
};
export type ShutdownServiceResponse = {
  lifecycleVersion: 1;
  accepted: true;
  lifecycle: {
    lifecycleVersion: 1;
    profile: { dataRoot: string; name: string; accessKey: string };
    instanceId: string;
    buildId: string;
    apiMajor: number;
    capabilities: Array<string>;
    dataAvailability: 'available' | 'unavailable';
    state: 'accepting' | 'draining' | 'closed' | 'drain_failed';
    busy: boolean;
    reasons: Array<'admission' | 'dispatch' | 'execution' | 'background' | 'cleanup'>;
  };
};
export type ServerInfo =
  | {
      subjectId?: string;
      instanceId: string;
      buildId: string;
      apiMajor: number;
      capabilities: Array<string>;
      profile: { dataRoot: string; name: string; accessKey: string };
      dataAvailability: 'available';
      storeId: string;
    }
  | {
      subjectId?: string;
      instanceId: string;
      buildId: string;
      apiMajor: number;
      capabilities: Array<string>;
      profile: { dataRoot: string; name: string; accessKey: string };
      dataAvailability: 'unavailable';
      storeId?: string;
    };
export type Problem = {
  code: string;
  message: string;
  scope: string;
  resourceId?: string;
  requestId: string;
  retryable: boolean;
  outcome?: string;
};
export type Workspace = { id: string; rootUri: string; name: string };
export type Session = {
  id: string;
  workspaceId: string;
  parentSessionId: string | null;
  rootSessionId?: string;
  title: string;
  controlRevision: string;
  contextSelectionId: string;
  nextSeq: string;
  deletedAt: number | null;
};
type Command___schema0 =
  | string
  | number
  | boolean
  | null
  | Array<Command___schema0>
  | { [key: string]: Command___schema0 };
export type Command = {
  id: string;
  sessionId: string;
  kind: string;
  status: 'accepted' | 'applied' | 'rejected' | 'needs_review';
  receipt: Command___schema0;
  dispatchFailure?: { code: string; instanceId: string };
  originStoreId: string;
  subjectId?: string;
  requestDigest?: string;
  cancelRequestedAt: number | null;
};
type Run___schema0 =
  | string
  | number
  | boolean
  | null
  | Array<Run___schema0>
  | { [key: string]: Run___schema0 };
export type Run = {
  id: string;
  sessionId: string;
  originCommandId: string;
  originStoreId: string;
  status:
    | 'running'
    | 'waiting_interaction'
    | 'waiting_execution'
    | 'cancelling'
    | 'completed'
    | 'failed'
    | 'cancelled'
    | 'interrupted';
  isActive: boolean;
  waitingForResults?: Array<string>;
  configuration?: Run___schema0;
  createdAt: number;
  finishedAt: number | null;
  reason: string | null;
};
type Execution___schema0 =
  | string
  | number
  | boolean
  | null
  | Array<Execution___schema0>
  | { [key: string]: Execution___schema0 };
export type Execution = {
  id: string;
  originStoreId?: string;
  childSessionId?: string | null;
  parentExecutionId?: string | null;
  cancelWithParent?: boolean;
  sessionId: string;
  runId: string | null;
  kind: 'model' | 'tool' | 'job';
  definitionId: string;
  definitionVersion: string;
  status:
    | 'planned'
    | 'dispatching'
    | 'running'
    | 'succeeded'
    | 'failed'
    | 'cancelled'
    | 'outcome_unknown';
  result: Execution___schema0;
  resultRevision: string;
  cancelRequestedAt: number | null;
  delivery?: ('pending' | 'consumed' | 'suppressed') | null;
  deliveryReason?: string | null;
};
export type ExecutionOutputRecord = {
  executionId: string;
  seq: string;
  throughSeq: string;
  stream: 'stdout' | 'stderr' | 'progress';
  content: string;
  droppedBytes: string | null;
};
export type ExecutionOutputPage = {
  items: Array<{
    executionId: string;
    seq: string;
    throughSeq: string;
    stream: 'stdout' | 'stderr' | 'progress';
    content: string;
    droppedBytes: string | null;
  }>;
  highWaterSeq: string;
};
export type Message = {
  id: string;
  sessionId: string;
  runId: string | null;
  seq: string;
  status: 'complete' | 'incomplete';
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  originMessage?: { storeId: string; sessionId: string; messageId: string; runId: string | null };
  contentFormat?: 'unsupported';
  outputBody?: {
    kind: 'model_output';
    executionId: string;
    complete: boolean;
    contentBytes: string;
    reasoningBytes: string;
    toolCallCount: number;
    readAvailability?: 'unsupported';
  };
  toolCalls?: Array<{ id: string; name: string; arguments: string }>;
  toolCallId?: string;
  sourceIds?: Array<string>;
  originCommandId?: string;
  contextSelectionId?: string;
  inputKind?: 'input.steer' | 'input.follow_up' | 'result.include';
};
type Change___schema0 =
  | string
  | number
  | boolean
  | null
  | Array<Change___schema0>
  | { [key: string]: Change___schema0 };
export type Change = {
  cursor: string;
  sessionId: string | null;
  objectId: string;
  type: string;
  revision: string;
  payload: Change___schema0;
};
export type StreamReady = { storeId: string; replayFloor: string; highWaterCursor: string };
export type StreamCheckpoint = { storeId: string; cursor: string };
type PublicAction___schema0 =
  | string
  | number
  | boolean
  | null
  | Array<PublicAction___schema0>
  | { [key: string]: PublicAction___schema0 };
export type PublicAction = {
  actionId: string;
  definitionVersion: string;
  label: string;
  input: PublicAction___schema0;
};
export type ArtifactRef = {
  id: string;
  storeId?: string;
  mediaType: string;
  size: string;
  scope?: { kind: 'session' | 'execution' | 'message'; id: string };
};
export type ArtifactContent = string;
export type CreateWorkspaceRequest = {
  expectedStoreId: string;
  id: string;
  rootUri: string;
  name: string;
};
export type CreateSessionRequest = {
  expectedStoreId: string;
  commandId: string;
  sessionId: string;
  workspaceId: string;
  title: string;
};
export type ResumeRunRequest = {
  kind: 'run.resume';
  expectedStoreId: string;
  commandId: string;
  runId: string;
};
export type ResumeRunTarget = { sessionId: string };
export type RecoverSessionRequest = {
  kind: 'session.recover';
  expectedStoreId: string;
  commandId: string;
  decision: 'interrupt';
};
export type RecoverSessionTarget = { sessionId: string };
export type ReconcileJobRequest = {
  kind: 'job.reconcile';
  expectedStoreId: string;
  commandId: string;
  executionId: string;
  expectedResultRevision: string;
};
export type ReconcileJobTarget = { sessionId: string };
export type ResumeJobReportRequest = { expectedStoreId: string; commandId: string };
export type ResumeJobReportTarget = { sessionId: string; reportCommandId: string };
type StartCommandRequest___schema0 =
  | string
  | number
  | boolean
  | null
  | Array<StartCommandRequest___schema0>
  | { [key: string]: StartCommandRequest___schema0 };
export type StartCommandRequest = {
  expectedStoreId: string;
  commandId: string;
  kind: 'run.start';
  content: string;
  modelId?: string;
  reasoningEffort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  selectedSkills?: Array<string>;
  extensionInputs?: Array<{
    extensionId: string;
    definitionVersion: string;
    input: StartCommandRequest___schema0;
  }>;
};
export type CancelCommandRequest = {
  expectedStoreId: string;
  commandId: string;
  kind: 'command.cancel';
  targetCommandId: string;
};
export type CancelRunRequest = {
  expectedStoreId: string;
  commandId: string;
  kind: 'run.cancel';
  runId: string;
};
export type CancelExecutionRequest = {
  expectedStoreId: string;
  commandId: string;
  kind: 'execution.cancel';
  executionId: string;
};
export type CancelSessionRequest = {
  expectedStoreId: string;
  commandId: string;
  kind: 'session.cancel';
  includeBackground: boolean;
};
type ExtensionCommandRequest___schema0 =
  | string
  | number
  | boolean
  | null
  | Array<ExtensionCommandRequest___schema0>
  | { [key: string]: ExtensionCommandRequest___schema0 };
export type ExtensionCommandRequest = {
  expectedStoreId: string;
  commandId: string;
  kind: 'extension.invoke';
  extensionId: string;
  actionId: string;
  definitionVersion: string;
  input: ExtensionCommandRequest___schema0;
};
export type BackgroundExecutionQuery = {
  storeId: string;
  afterSeq?: string;
  upperSeq?: string;
  limit?: number;
  workspaceId?: string;
  rootSessionId?: string;
  executionId?: string;
  snapshotCursor?: string;
};
export type BackgroundExecutionItem = {
  seq: string;
  execution: {
    id: string;
    sessionId: string;
    rootSessionId: string;
    runId: string | null;
    originCommandId: string;
    originStoreId: string;
    rootWorkCommandId: string;
    rootWorkSeq: string;
    parentExecutionId: string | null;
    childSessionId: string | null;
    cancelWithParent: boolean;
    stepId: string;
    callId: string;
    attempt: number;
    kind: 'job';
    definitionId: string;
    definitionVersion: string;
    status:
      | 'planned'
      | 'dispatching'
      | 'running'
      | 'succeeded'
      | 'failed'
      | 'cancelled'
      | 'outcome_unknown';
    ownerGeneration: string;
    cancelRequested: boolean;
    cancelRequestedAt: number | null;
    resultRevision: string;
    delivery: ('pending' | 'consumed' | 'suppressed') | null;
    deliveryReason: string | null;
    deliveryTargetSessionId: string | null;
    contextSelectionId: string | null;
  };
  session: {
    id: string;
    workspaceId: string;
    parentSessionId: string | null;
    rootSessionId: string;
    title: string;
    controlRevision: string;
    contextSelectionId: string;
    nextSeq: string;
    deletedAt: number | null;
    ownerInstanceId: string | null;
    ownerGeneration: string;
  };
  rootSession: {
    id: string;
    workspaceId: string;
    parentSessionId: string | null;
    rootSessionId: string;
    title: string;
    controlRevision: string;
    contextSelectionId: string;
    nextSeq: string;
    deletedAt: number | null;
    ownerInstanceId: string | null;
    ownerGeneration: string;
  };
  run: {
    id: string;
    sessionId: string;
    originCommandId: string;
    originStoreId: string;
    rootWorkCommandId: string;
    rootWorkSeq: string;
    contextSelectionId: string;
    waitingForResults: Array<string>;
    status:
      | 'running'
      | 'waiting_interaction'
      | 'waiting_execution'
      | 'cancelling'
      | 'completed'
      | 'failed'
      | 'cancelled'
      | 'interrupted';
    isActive: boolean;
    createdAt: number;
    deadlineAt: number | null;
    finishedAt: number | null;
    reason: string | null;
  } | null;
  childRun: {
    id: string;
    sessionId: string;
    originCommandId: string;
    originStoreId: string;
    rootWorkCommandId: string;
    rootWorkSeq: string;
    contextSelectionId: string;
    waitingForResults: Array<string>;
    status:
      | 'running'
      | 'waiting_interaction'
      | 'waiting_execution'
      | 'cancelling'
      | 'completed'
      | 'failed'
      | 'cancelled'
      | 'interrupted';
    isActive: boolean;
    createdAt: number;
    deadlineAt: number | null;
    finishedAt: number | null;
    reason: string | null;
  } | null;
  childSession: {
    id: string;
    workspaceId: string;
    parentSessionId: string | null;
    rootSessionId: string;
    title: string;
    controlRevision: string;
    contextSelectionId: string;
    nextSeq: string;
    deletedAt: number | null;
    ownerInstanceId: string | null;
    ownerGeneration: string;
  } | null;
};
export type BackgroundExecutionPage = {
  storeId: string;
  highWaterSeq: string;
  upperSeq: string;
  nextAfterSeq: string | null;
  snapshotCursor: string;
  items: Array<{
    seq: string;
    execution: {
      id: string;
      sessionId: string;
      rootSessionId: string;
      runId: string | null;
      originCommandId: string;
      originStoreId: string;
      rootWorkCommandId: string;
      rootWorkSeq: string;
      parentExecutionId: string | null;
      childSessionId: string | null;
      cancelWithParent: boolean;
      stepId: string;
      callId: string;
      attempt: number;
      kind: 'job';
      definitionId: string;
      definitionVersion: string;
      status:
        | 'planned'
        | 'dispatching'
        | 'running'
        | 'succeeded'
        | 'failed'
        | 'cancelled'
        | 'outcome_unknown';
      ownerGeneration: string;
      cancelRequested: boolean;
      cancelRequestedAt: number | null;
      resultRevision: string;
      delivery: ('pending' | 'consumed' | 'suppressed') | null;
      deliveryReason: string | null;
      deliveryTargetSessionId: string | null;
      contextSelectionId: string | null;
    };
    session: {
      id: string;
      workspaceId: string;
      parentSessionId: string | null;
      rootSessionId: string;
      title: string;
      controlRevision: string;
      contextSelectionId: string;
      nextSeq: string;
      deletedAt: number | null;
      ownerInstanceId: string | null;
      ownerGeneration: string;
    };
    rootSession: {
      id: string;
      workspaceId: string;
      parentSessionId: string | null;
      rootSessionId: string;
      title: string;
      controlRevision: string;
      contextSelectionId: string;
      nextSeq: string;
      deletedAt: number | null;
      ownerInstanceId: string | null;
      ownerGeneration: string;
    };
    run: {
      id: string;
      sessionId: string;
      originCommandId: string;
      originStoreId: string;
      rootWorkCommandId: string;
      rootWorkSeq: string;
      contextSelectionId: string;
      waitingForResults: Array<string>;
      status:
        | 'running'
        | 'waiting_interaction'
        | 'waiting_execution'
        | 'cancelling'
        | 'completed'
        | 'failed'
        | 'cancelled'
        | 'interrupted';
      isActive: boolean;
      createdAt: number;
      deadlineAt: number | null;
      finishedAt: number | null;
      reason: string | null;
    } | null;
    childRun: {
      id: string;
      sessionId: string;
      originCommandId: string;
      originStoreId: string;
      rootWorkCommandId: string;
      rootWorkSeq: string;
      contextSelectionId: string;
      waitingForResults: Array<string>;
      status:
        | 'running'
        | 'waiting_interaction'
        | 'waiting_execution'
        | 'cancelling'
        | 'completed'
        | 'failed'
        | 'cancelled'
        | 'interrupted';
      isActive: boolean;
      createdAt: number;
      deadlineAt: number | null;
      finishedAt: number | null;
      reason: string | null;
    } | null;
    childSession: {
      id: string;
      workspaceId: string;
      parentSessionId: string | null;
      rootSessionId: string;
      title: string;
      controlRevision: string;
      contextSelectionId: string;
      nextSeq: string;
      deletedAt: number | null;
      ownerInstanceId: string | null;
      ownerGeneration: string;
    } | null;
  }>;
};
export type WorkspaceDirectoryQuery = {
  storeId: string;
  afterSeq?: string;
  upperSeq?: string;
  limit?: number;
};
export type SessionDirectoryQuery = {
  storeId: string;
  afterSeq?: string;
  upperSeq?: string;
  limit?: number;
  workspaceId?: string;
};
export type BrowserWorkspaceDirectoryQuery = {
  afterSeq?: string;
  upperSeq?: string;
  limit?: number;
};
export type BrowserSessionDirectoryQuery = {
  afterSeq?: string;
  upperSeq?: string;
  limit?: number;
  workspaceId?: string;
};
export type WorkspaceDirectoryPage = {
  storeId: string;
  highWaterSeq: string;
  upperSeq: string;
  nextAfterSeq: string | null;
  snapshotCursor: string;
  items: Array<{ seq: string; workspace: { id: string; rootUri: string; name: string } }>;
};
export type SessionDirectoryPage = {
  storeId: string;
  highWaterSeq: string;
  upperSeq: string;
  nextAfterSeq: string | null;
  snapshotCursor: string;
  items: Array<{
    seq: string;
    session: {
      id: string;
      workspaceId: string;
      parentSessionId: string | null;
      rootSessionId?: string;
      title: string;
      controlRevision: string;
      contextSelectionId: string;
      nextSeq: string;
      deletedAt: number | null;
    };
  }>;
};
export type BrowserWorkspaceDirectoryPage = {
  storeId: string;
  highWaterSeq: string;
  upperSeq: string;
  nextAfterSeq: string | null;
  snapshotCursor: string;
  items: Array<{ seq: string; workspace: { id: string; name: string } }>;
};
export type BrowserInfo = {
  instanceId: string;
  buildId: string;
  pageIdentity: string;
  storeId: string | null;
  dataAvailability: 'available' | 'unavailable';
  capabilities: Array<
    | 'workspaces'
    | 'sessions'
    | 'history'
    | 'context'
    | 'execution_output'
    | 'model_inputs'
    | 'model_outputs'
    | 'session_exports'
    | 'session_logs'
    | 'file_checkpoints'
  >;
};
export type BrowserContextQuery = {
  contextSelectionId?: string;
  afterSeq?: string;
  upperSeq?: string;
  messageLimit?: number;
  afterSourceId?: string;
  sourceLimit?: number;
  byteLimit?: number;
};
export type BrowserModelInputQuery = { afterSeq?: string; upperSeq?: string; limit?: number };
export type BrowserWorkspaceList = Array<{ id: string; name: string }>;
export type BrowserSessionList = Array<{
  id: string;
  workspaceId: string;
  parentSessionId: string | null;
  rootSessionId?: string;
  title: string;
  controlRevision: string;
  contextSelectionId: string;
  nextSeq: string;
  deletedAt: number | null;
}>;
export type BrowserView = {
  session: {
    id: string;
    workspaceId: string;
    parentSessionId: string | null;
    rootSessionId?: string;
    title: string;
    controlRevision: string;
    contextSelectionId: string;
    nextSeq: string;
    deletedAt: number | null;
  };
  runs: Array<{
    id: string;
    sessionId: string;
    originCommandId: string;
    originStoreId: string;
    status:
      | 'running'
      | 'waiting_interaction'
      | 'waiting_execution'
      | 'cancelling'
      | 'completed'
      | 'failed'
      | 'cancelled'
      | 'interrupted';
    isActive: boolean;
    waitingForResults?: Array<string>;
    createdAt: number;
    finishedAt: number | null;
    reason: string | null;
  }>;
  executions: Array<{
    id: string;
    originStoreId?: string;
    childSessionId?: string | null;
    parentExecutionId?: string | null;
    cancelWithParent?: boolean;
    sessionId: string;
    runId: string | null;
    kind: 'model' | 'tool' | 'job';
    definitionId: string;
    definitionVersion: string;
    status:
      | 'planned'
      | 'dispatching'
      | 'running'
      | 'succeeded'
      | 'failed'
      | 'cancelled'
      | 'outcome_unknown';
    resultRevision: string;
    cancelRequestedAt: number | null;
    delivery?: ('pending' | 'consumed' | 'suppressed') | null;
    deliveryReason?: string | null;
  }>;
  snapshotCursor: string;
  storeId: string;
};
type SelectedContextPage___schema0 =
  | string
  | number
  | boolean
  | null
  | Array<SelectedContextPage___schema0>
  | { [key: string]: SelectedContextPage___schema0 };
export type SelectedContextPage = {
  selection: {
    id: string;
    sessionId: string;
    previousSelectionId: string | null;
    boundaryMessageId: string | null;
    boundarySeq: string;
    tailFromSeq: string;
    ranges: Array<{ afterSeq: string; throughSeq: string }>;
  };
  highWaterSeq: string;
  messages: Array<{
    id: string;
    sessionId: string;
    runId: string | null;
    seq: string;
    status: 'complete' | 'incomplete';
    role: 'system' | 'user' | 'assistant' | 'tool';
    content: string;
    originMessage?: { storeId: string; sessionId: string; messageId: string; runId: string | null };
    contentFormat?: 'unsupported';
    outputBody?: {
      kind: 'model_output';
      executionId: string;
      complete: boolean;
      contentBytes: string;
      reasoningBytes: string;
      toolCallCount: number;
      readAvailability?: 'unsupported';
    };
    toolCalls?: Array<{ id: string; name: string; arguments: string }>;
    toolCallId?: string;
    sourceIds?: Array<string>;
    originCommandId?: string;
    contextSelectionId?: string;
    inputKind?: 'input.steer' | 'input.follow_up' | 'result.include';
  }>;
  resultSources: Array<{
    id: string;
    seq: string;
    sessionId: string;
    createdSelectionId: string;
    executionId: string;
    resultRevision: string;
    originStoreId: string;
    inclusion: 'automatic' | 'explicit';
    result: SelectedContextPage___schema0;
  }>;
  nextAfterSeq: string | null;
  nextAfterSourceId: string | null;
  snapshotCursor: string;
  compression?: {
    id: string;
    originSessionId: string;
    originCompressionId: string;
    sessionId: string;
    contextSelectionId: string;
    originStoreId: string;
    modelExecutionId: string;
    runId: string;
    coveredThroughSeq: string;
    publishedSeq: string;
    previousCompressionId: string | null;
    compressor: { id: string; version: string; snapshot: SelectedContextPage___schema0 };
    trigger: 'manual' | 'automatic';
  };
};
type SelectContextResponse___schema0 =
  | string
  | number
  | boolean
  | null
  | Array<SelectContextResponse___schema0>
  | { [key: string]: SelectContextResponse___schema0 };
export type SelectContextResponse = {
  command: {
    id: string;
    sessionId: string;
    kind: string;
    status: 'accepted' | 'applied' | 'rejected' | 'needs_review';
    receipt: SelectContextResponse___schema0;
    dispatchFailure?: { code: string; instanceId: string };
    originStoreId: string;
    subjectId?: string;
    requestDigest?: string;
    cancelRequestedAt: number | null;
  };
  selection: {
    id: string;
    sessionId: string;
    previousSelectionId: string | null;
    boundaryMessageId: string | null;
    boundarySeq: string;
    tailFromSeq: string;
    ranges: Array<{ afterSeq: string; throughSeq: string }>;
  };
};
type ForkSessionResponse___schema0 =
  | string
  | number
  | boolean
  | null
  | Array<ForkSessionResponse___schema0>
  | { [key: string]: ForkSessionResponse___schema0 };
export type ForkSessionResponse = {
  command: {
    id: string;
    sessionId: string;
    kind: string;
    status: 'accepted' | 'applied' | 'rejected' | 'needs_review';
    receipt: ForkSessionResponse___schema0;
    dispatchFailure?: { code: string; instanceId: string };
    originStoreId: string;
    subjectId?: string;
    requestDigest?: string;
    cancelRequestedAt: number | null;
  };
  session: {
    id: string;
    workspaceId: string;
    parentSessionId: string | null;
    rootSessionId?: string;
    title: string;
    controlRevision: string;
    contextSelectionId: string;
    nextSeq: string;
    deletedAt: number | null;
  };
  selection: {
    id: string;
    sessionId: string;
    previousSelectionId: string | null;
    boundaryMessageId: string | null;
    boundarySeq: string;
    tailFromSeq: string;
    ranges: Array<{ afterSeq: string; throughSeq: string }>;
  };
  omittedExtensionState: boolean;
  namespaceReport?: Array<{
    extensionId: string;
    contentType: string;
    contentVersion: number;
    mode: 'copy' | 'rebuild' | 'omit';
    ruleVersion: string | null;
    copied: number;
    rebuilt: number;
    omitted: number;
  }>;
};
type SessionMutationResponse___schema0 =
  | string
  | number
  | boolean
  | null
  | Array<SessionMutationResponse___schema0>
  | { [key: string]: SessionMutationResponse___schema0 };
export type SessionMutationResponse = {
  command: {
    id: string;
    sessionId: string;
    kind: string;
    status: 'accepted' | 'applied' | 'rejected' | 'needs_review';
    receipt: SessionMutationResponse___schema0;
    dispatchFailure?: { code: string; instanceId: string };
    originStoreId: string;
    subjectId?: string;
    requestDigest?: string;
    cancelRequestedAt: number | null;
  };
  session: {
    id: string;
    workspaceId: string;
    parentSessionId: string | null;
    rootSessionId?: string;
    title: string;
    controlRevision: string;
    contextSelectionId: string;
    nextSeq: string;
    deletedAt: number | null;
  };
};
type IncludeResultResponse___schema0 =
  | string
  | number
  | boolean
  | null
  | Array<IncludeResultResponse___schema0>
  | { [key: string]: IncludeResultResponse___schema0 };
export type IncludeResultResponse = {
  command: {
    id: string;
    sessionId: string;
    kind: string;
    status: 'accepted' | 'applied' | 'rejected' | 'needs_review';
    receipt: IncludeResultResponse___schema0;
    dispatchFailure?: { code: string; instanceId: string };
    originStoreId: string;
    subjectId?: string;
    requestDigest?: string;
    cancelRequestedAt: number | null;
  };
  source: {
    id: string;
    seq: string;
    sessionId: string;
    createdSelectionId: string;
    executionId: string;
    resultRevision: string;
    originStoreId: string;
    inclusion: 'automatic' | 'explicit';
    result: IncludeResultResponse___schema0;
  };
};
type PublicView___schema0 =
  | string
  | number
  | boolean
  | null
  | Array<PublicView___schema0>
  | { [key: string]: PublicView___schema0 };
export type PublicView = {
  extensionId: string;
  contentType: string;
  contentVersion: number;
  summary: string;
  payload: PublicView___schema0;
  artifactRefs: Array<{
    id: string;
    storeId?: string;
    mediaType: string;
    size: string;
    scope?: { kind: 'session' | 'execution' | 'message'; id: string };
  }>;
  actions: Array<{
    actionId: string;
    definitionVersion: string;
    label: string;
    input: PublicView___schema0;
  }>;
};
type QueryResponse___schema0 =
  | string
  | number
  | boolean
  | null
  | Array<QueryResponse___schema0>
  | { [key: string]: QueryResponse___schema0 };
export type QueryResponse = Array<{
  extensionId: string;
  contentType: string;
  contentVersion: number;
  summary: string;
  payload: QueryResponse___schema0;
  artifactRefs: Array<{
    id: string;
    storeId?: string;
    mediaType: string;
    size: string;
    scope?: { kind: 'session' | 'execution' | 'message'; id: string };
  }>;
  actions: Array<{
    actionId: string;
    definitionVersion: string;
    label: string;
    input: QueryResponse___schema0;
  }>;
}>;
type ExtensionCatalogue___schema0 =
  | string
  | number
  | boolean
  | null
  | Array<ExtensionCatalogue___schema0>
  | { [key: string]: ExtensionCatalogue___schema0 };
export type ExtensionCatalogue = {
  extensionId: string;
  version: string;
  actions: Array<{
    id: string;
    version: string;
    description: string;
    inputSchema: { [key: string]: ExtensionCatalogue___schema0 };
  }>;
  queries: Array<{
    id: string;
    version: string;
    description: string;
    inputSchema: { [key: string]: ExtensionCatalogue___schema0 };
  }>;
};
type ExtensionList___schema0 =
  | string
  | number
  | boolean
  | null
  | Array<ExtensionList___schema0>
  | { [key: string]: ExtensionList___schema0 };
export type ExtensionList = Array<{
  extensionId: string;
  version: string;
  actions: Array<{
    id: string;
    version: string;
    description: string;
    inputSchema: { [key: string]: ExtensionList___schema0 };
  }>;
  queries: Array<{
    id: string;
    version: string;
    description: string;
    inputSchema: { [key: string]: ExtensionList___schema0 };
  }>;
}>;
export type WorkspaceList = Array<{ id: string; rootUri: string; name: string }>;
export type SessionList = Array<{
  id: string;
  workspaceId: string;
  parentSessionId: string | null;
  rootSessionId?: string;
  title: string;
  controlRevision: string;
  contextSelectionId: string;
  nextSeq: string;
  deletedAt: number | null;
}>;
export type MessageList = Array<{
  id: string;
  sessionId: string;
  runId: string | null;
  seq: string;
  status: 'complete' | 'incomplete';
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  originMessage?: { storeId: string; sessionId: string; messageId: string; runId: string | null };
  contentFormat?: 'unsupported';
  outputBody?: {
    kind: 'model_output';
    executionId: string;
    complete: boolean;
    contentBytes: string;
    reasoningBytes: string;
    toolCallCount: number;
    readAvailability?: 'unsupported';
  };
  toolCalls?: Array<{ id: string; name: string; arguments: string }>;
  toolCallId?: string;
  sourceIds?: Array<string>;
  originCommandId?: string;
  contextSelectionId?: string;
  inputKind?: 'input.steer' | 'input.follow_up' | 'result.include';
}>;
type SessionView___schema0 =
  | string
  | number
  | boolean
  | null
  | Array<SessionView___schema0>
  | { [key: string]: SessionView___schema0 };
export type SessionView = {
  session: {
    id: string;
    workspaceId: string;
    parentSessionId: string | null;
    rootSessionId?: string;
    title: string;
    controlRevision: string;
    contextSelectionId: string;
    nextSeq: string;
    deletedAt: number | null;
  };
  runs: Array<{
    id: string;
    sessionId: string;
    originCommandId: string;
    originStoreId: string;
    status:
      | 'running'
      | 'waiting_interaction'
      | 'waiting_execution'
      | 'cancelling'
      | 'completed'
      | 'failed'
      | 'cancelled'
      | 'interrupted';
    isActive: boolean;
    waitingForResults?: Array<string>;
    configuration?: SessionView___schema0;
    createdAt: number;
    finishedAt: number | null;
    reason: string | null;
  }>;
  executions: Array<{
    id: string;
    originStoreId?: string;
    childSessionId?: string | null;
    parentExecutionId?: string | null;
    cancelWithParent?: boolean;
    sessionId: string;
    runId: string | null;
    kind: 'model' | 'tool' | 'job';
    definitionId: string;
    definitionVersion: string;
    status:
      | 'planned'
      | 'dispatching'
      | 'running'
      | 'succeeded'
      | 'failed'
      | 'cancelled'
      | 'outcome_unknown';
    result: SessionView___schema0;
    resultRevision: string;
    cancelRequestedAt: number | null;
    delivery?: ('pending' | 'consumed' | 'suppressed') | null;
    deliveryReason?: string | null;
  }>;
  messages: Array<{
    id: string;
    sessionId: string;
    runId: string | null;
    seq: string;
    status: 'complete' | 'incomplete';
    role: 'system' | 'user' | 'assistant' | 'tool';
    content: string;
    originMessage?: { storeId: string; sessionId: string; messageId: string; runId: string | null };
    contentFormat?: 'unsupported';
    outputBody?: {
      kind: 'model_output';
      executionId: string;
      complete: boolean;
      contentBytes: string;
      reasoningBytes: string;
      toolCallCount: number;
      readAvailability?: 'unsupported';
    };
    toolCalls?: Array<{ id: string; name: string; arguments: string }>;
    toolCallId?: string;
    sourceIds?: Array<string>;
    originCommandId?: string;
    contextSelectionId?: string;
    inputKind?: 'input.steer' | 'input.follow_up' | 'result.include';
  }>;
  snapshotCursor: string;
  storeId: string;
};
type CommandRequest___schema0 =
  | string
  | number
  | boolean
  | null
  | Array<CommandRequest___schema0>
  | { [key: string]: CommandRequest___schema0 };
export type CommandRequest =
  | {
      kind: 'input.steer';
      content: string;
      targetRunId: string;
      contextSelectionId: string;
      expectedStoreId: string;
      commandId: string;
    }
  | {
      kind: 'input.follow_up';
      content: string;
      afterRunId: string | null;
      contextSelectionId: string;
      modelId?: string;
      reasoningEffort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
      selectedSkills?: Array<string>;
      extensionInputs?: Array<{
        extensionId: string;
        definitionVersion: string;
        input: CommandRequest___schema0;
      }>;
      expectedStoreId: string;
      commandId: string;
    }
  | {
      expectedStoreId: string;
      commandId: string;
      kind: 'run.start';
      content: string;
      modelId?: string;
      reasoningEffort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
      selectedSkills?: Array<string>;
      extensionInputs?: Array<{
        extensionId: string;
        definitionVersion: string;
        input: CommandRequest___schema0;
      }>;
    }
  | { expectedStoreId: string; commandId: string; kind: 'command.cancel'; targetCommandId: string }
  | { expectedStoreId: string; commandId: string; kind: 'run.cancel'; runId: string }
  | { expectedStoreId: string; commandId: string; kind: 'execution.cancel'; executionId: string }
  | {
      expectedStoreId: string;
      commandId: string;
      kind: 'session.cancel';
      includeBackground: boolean;
    }
  | {
      expectedStoreId: string;
      commandId: string;
      kind: 'extension.invoke';
      extensionId: string;
      actionId: string;
      definitionVersion: string;
      input: CommandRequest___schema0;
    }
  | {
      kind: 'job.reconcile';
      expectedStoreId: string;
      commandId: string;
      executionId: string;
      expectedResultRevision: string;
    }
  | { kind: 'run.resume'; expectedStoreId: string; commandId: string; runId: string }
  | { kind: 'session.recover'; expectedStoreId: string; commandId: string; decision: 'interrupt' };
export type ResumeJobReportResponse = {
  id: string;
  sessionId: string;
  kind: 'job.report.resume';
  status: 'applied';
  receipt:
    | { reportCommandId: string; runId: string; outcome: 'report_resumed' }
    | { reportCommandId: string; runId: null; outcome: 'report_suppressed'; reason?: string };
  dispatchFailure?: { code: string; instanceId: string };
  originStoreId: string;
  subjectId?: string;
  requestDigest?: string;
  cancelRequestedAt: number | null;
};
export type ResumeRunResponse =
  | {
      id: string;
      sessionId: string;
      kind: 'run.resume';
      status: 'accepted';
      receipt: null;
      dispatchFailure?: { code: string; instanceId: string };
      originStoreId: string;
      subjectId?: string;
      requestDigest?: string;
      cancelRequestedAt: number | null;
    }
  | {
      id: string;
      sessionId: string;
      kind: 'run.resume';
      status: 'applied';
      receipt: {
        outcome: 'run_resumed';
        runId: string;
        originalCommandId: string;
        boundary: 'before_model_dispatch' | 'tool_calls' | 'completion';
      };
      dispatchFailure?: { code: string; instanceId: string };
      originStoreId: string;
      subjectId?: string;
      requestDigest?: string;
      cancelRequestedAt: number | null;
    };
export type RecoverSessionResponse = {
  id: string;
  sessionId: string;
  kind: 'session.recover';
  status: 'applied';
  receipt: {
    kind: 'session_interrupted';
    sessionId: string;
    storeId: string;
    interruptedRunIds: Array<string>;
    settledExecutionIds: Array<string>;
    unknownExecutionIds: Array<string>;
    cancelledExecutionIds: Array<string>;
    partialMessageIds: Array<string>;
    snapshotCursor: string;
  };
  dispatchFailure?: { code: string; instanceId: string };
  originStoreId: string;
  subjectId?: string;
  requestDigest?: string;
  cancelRequestedAt: number | null;
};
type JobReconcileCommand___schema0 =
  | string
  | number
  | boolean
  | null
  | Array<JobReconcileCommand___schema0>
  | { [key: string]: JobReconcileCommand___schema0 };
export type JobReconcileCommand =
  | {
      id: string;
      sessionId: string;
      kind: 'job.reconcile';
      status: 'accepted';
      receipt: null;
      dispatchFailure?: { code: string; instanceId: string };
      originStoreId: string;
      subjectId?: string;
      requestDigest?: string;
      cancelRequestedAt: number | null;
    }
  | {
      id: string;
      sessionId: string;
      kind: 'job.reconcile';
      status: 'applied';
      receipt:
        | {
            executionId: string;
            resultRevision: string;
            evidence: JobReconcileCommand___schema0;
            reason: string | null;
            evidenceSource: 'adapter_reconcile';
            outcome: 'verified';
            supervision: 'ended';
            result: {
              outcome: 'succeeded' | 'failed' | 'cancelled';
              content: string;
              details?: JobReconcileCommand___schema0;
              artifactRefs?: Array<{
                id: string;
                storeId?: string;
                mediaType: string;
                size: string;
                scope?: { kind: 'session' | 'execution' | 'message'; id: string };
              }>;
              modelContent?: {
                kind: 'artifact';
                reference: {
                  id: string;
                  storeId?: string;
                  mediaType: string;
                  size: string;
                  scope?: { kind: 'session' | 'execution' | 'message'; id: string };
                };
                encoding: 'utf-8';
              };
            };
          }
        | {
            executionId: string;
            resultRevision: string;
            evidence: JobReconcileCommand___schema0;
            reason: string | null;
            evidenceSource: 'adapter_reconcile';
            outcome: 'unresolved';
            supervision: 'ended' | 'running' | 'unknown';
            result: JobReconcileCommand___schema0;
          };
      dispatchFailure?: { code: string; instanceId: string };
      originStoreId: string;
      subjectId?: string;
      requestDigest?: string;
      cancelRequestedAt: number | null;
    };
type PendingInputPage___schema0 =
  | string
  | number
  | boolean
  | null
  | Array<PendingInputPage___schema0>
  | { [key: string]: PendingInputPage___schema0 };
export type PendingInputPage = {
  commands: Array<{
    id: string;
    sessionId: string;
    kind: string;
    status: 'accepted' | 'applied' | 'rejected' | 'needs_review';
    receipt: PendingInputPage___schema0;
    dispatchFailure?: { code: string; instanceId: string };
    originStoreId: string;
    subjectId?: string;
    requestDigest?: string;
    cancelRequestedAt: number | null;
    seq: string;
    request:
      | { kind: 'input.steer'; content: string; targetRunId: string; contextSelectionId: string }
      | {
          kind: 'input.follow_up';
          content: string;
          afterRunId: string | null;
          contextSelectionId: string;
          modelId?: string;
          reasoningEffort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
          selectedSkills?: Array<string>;
          extensionInputs?: Array<{
            extensionId: string;
            definitionVersion: string;
            input: PendingInputPage___schema0;
          }>;
        };
  }>;
  nextAfterSeq: string | null;
  snapshotCursor: string;
};
export type BeginSessionExportQuery = { storeId: string };
export type SessionExportPageQuery = {
  storeId: string;
  manifest: {
    version: 1;
    storeId: string;
    rootSessionId: string;
    readInstanceId: string;
    snapshotCursor: string;
    dataVersion: string;
    sections: Array<{
      section:
        | 'sessions'
        | 'commands'
        | 'runs'
        | 'messages'
        | 'message_parts'
        | 'executions'
        | 'execution_output'
        | 'interactions'
        | 'context_snapshots'
        | 'extension_records'
        | 'artifact_refs';
      highWaterSeq: string;
      count: string;
    }>;
    excluded: Array<string>;
    contentMedia: 'sqlite-records-and-original-scope-artifact-references';
  };
  section:
    | 'sessions'
    | 'commands'
    | 'runs'
    | 'messages'
    | 'message_parts'
    | 'executions'
    | 'execution_output'
    | 'interactions'
    | 'context_snapshots'
    | 'extension_records'
    | 'artifact_refs';
  afterSeq?: string;
  limit?: number;
  byteLimit?: number;
};
export type SessionExportTextQuery = {
  storeId: string;
  manifest: {
    version: 1;
    storeId: string;
    rootSessionId: string;
    readInstanceId: string;
    snapshotCursor: string;
    dataVersion: string;
    sections: Array<{
      section:
        | 'sessions'
        | 'commands'
        | 'runs'
        | 'messages'
        | 'message_parts'
        | 'executions'
        | 'execution_output'
        | 'interactions'
        | 'context_snapshots'
        | 'extension_records'
        | 'artifact_refs';
      highWaterSeq: string;
      count: string;
    }>;
    excluded: Array<string>;
    contentMedia: 'sqlite-records-and-original-scope-artifact-references';
  };
  section:
    | 'sessions'
    | 'commands'
    | 'runs'
    | 'messages'
    | 'message_parts'
    | 'executions'
    | 'execution_output'
    | 'interactions'
    | 'context_snapshots'
    | 'extension_records'
    | 'artifact_refs';
  seq: string;
  field: string;
  afterByte?: string;
  limitBytes?: number;
};
export type VerifySessionExportQuery = {
  storeId: string;
  manifest: {
    version: 1;
    storeId: string;
    rootSessionId: string;
    readInstanceId: string;
    snapshotCursor: string;
    dataVersion: string;
    sections: Array<{
      section:
        | 'sessions'
        | 'commands'
        | 'runs'
        | 'messages'
        | 'message_parts'
        | 'executions'
        | 'execution_output'
        | 'interactions'
        | 'context_snapshots'
        | 'extension_records'
        | 'artifact_refs';
      highWaterSeq: string;
      count: string;
    }>;
    excluded: Array<string>;
    contentMedia: 'sqlite-records-and-original-scope-artifact-references';
  };
};
export type BrowserBeginSessionExportQuery = Record<string, never>;
export type BrowserSessionExportPageQuery = {
  manifest: {
    version: 1;
    storeId: string;
    rootSessionId: string;
    readInstanceId: string;
    snapshotCursor: string;
    dataVersion: string;
    sections: Array<{
      section:
        | 'sessions'
        | 'commands'
        | 'runs'
        | 'messages'
        | 'message_parts'
        | 'executions'
        | 'execution_output'
        | 'interactions'
        | 'context_snapshots'
        | 'extension_records'
        | 'artifact_refs';
      highWaterSeq: string;
      count: string;
    }>;
    excluded: Array<string>;
    contentMedia: 'sqlite-records-and-original-scope-artifact-references';
  };
  section:
    | 'sessions'
    | 'commands'
    | 'runs'
    | 'messages'
    | 'message_parts'
    | 'executions'
    | 'execution_output'
    | 'interactions'
    | 'context_snapshots'
    | 'extension_records'
    | 'artifact_refs';
  afterSeq?: string;
  limit?: number;
  byteLimit?: number;
};
export type BrowserSessionExportTextQuery = {
  manifest: {
    version: 1;
    storeId: string;
    rootSessionId: string;
    readInstanceId: string;
    snapshotCursor: string;
    dataVersion: string;
    sections: Array<{
      section:
        | 'sessions'
        | 'commands'
        | 'runs'
        | 'messages'
        | 'message_parts'
        | 'executions'
        | 'execution_output'
        | 'interactions'
        | 'context_snapshots'
        | 'extension_records'
        | 'artifact_refs';
      highWaterSeq: string;
      count: string;
    }>;
    excluded: Array<string>;
    contentMedia: 'sqlite-records-and-original-scope-artifact-references';
  };
  section:
    | 'sessions'
    | 'commands'
    | 'runs'
    | 'messages'
    | 'message_parts'
    | 'executions'
    | 'execution_output'
    | 'interactions'
    | 'context_snapshots'
    | 'extension_records'
    | 'artifact_refs';
  seq: string;
  field: string;
  afterByte?: string;
  limitBytes?: number;
};
export type BrowserVerifySessionExportQuery = {
  manifest: {
    version: 1;
    storeId: string;
    rootSessionId: string;
    readInstanceId: string;
    snapshotCursor: string;
    dataVersion: string;
    sections: Array<{
      section:
        | 'sessions'
        | 'commands'
        | 'runs'
        | 'messages'
        | 'message_parts'
        | 'executions'
        | 'execution_output'
        | 'interactions'
        | 'context_snapshots'
        | 'extension_records'
        | 'artifact_refs';
      highWaterSeq: string;
      count: string;
    }>;
    excluded: Array<string>;
    contentMedia: 'sqlite-records-and-original-scope-artifact-references';
  };
};
export type SessionExportManifest = {
  version: 1;
  storeId: string;
  rootSessionId: string;
  readInstanceId: string;
  snapshotCursor: string;
  dataVersion: string;
  sections: Array<{
    section:
      | 'sessions'
      | 'commands'
      | 'runs'
      | 'messages'
      | 'message_parts'
      | 'executions'
      | 'execution_output'
      | 'interactions'
      | 'context_snapshots'
      | 'extension_records'
      | 'artifact_refs';
    highWaterSeq: string;
    count: string;
  }>;
  excluded: Array<string>;
  contentMedia: 'sqlite-records-and-original-scope-artifact-references';
};
type SessionExportPage___schema0 =
  | string
  | number
  | boolean
  | null
  | Array<SessionExportPage___schema0>
  | { [key: string]: SessionExportPage___schema0 };
export type SessionExportPage = {
  storeId: string;
  rootSessionId: string;
  section:
    | 'sessions'
    | 'commands'
    | 'runs'
    | 'messages'
    | 'message_parts'
    | 'executions'
    | 'execution_output'
    | 'interactions'
    | 'context_snapshots'
    | 'extension_records'
    | 'artifact_refs';
  snapshotCursor: string;
  upperSeq: string;
  records: Array<{
    section:
      | 'sessions'
      | 'commands'
      | 'runs'
      | 'messages'
      | 'message_parts'
      | 'executions'
      | 'execution_output'
      | 'interactions'
      | 'context_snapshots'
      | 'extension_records'
      | 'artifact_refs';
    seq: string;
    sessionId: string;
    id: string;
    record: SessionExportPage___schema0;
  }>;
  nextAfterSeq: string | null;
};
export type SessionExportTextPage = {
  storeId: string;
  rootSessionId: string;
  section:
    | 'sessions'
    | 'commands'
    | 'runs'
    | 'messages'
    | 'message_parts'
    | 'executions'
    | 'execution_output'
    | 'interactions'
    | 'context_snapshots'
    | 'extension_records'
    | 'artifact_refs';
  seq: string;
  field: string;
  afterByte: string;
  byteLength: string;
  contentBase64: string;
  nextAfterByte: string | null;
};
export type SessionExportCompletion = {
  manifest: {
    version: 1;
    storeId: string;
    rootSessionId: string;
    readInstanceId: string;
    snapshotCursor: string;
    dataVersion: string;
    sections: Array<{
      section:
        | 'sessions'
        | 'commands'
        | 'runs'
        | 'messages'
        | 'message_parts'
        | 'executions'
        | 'execution_output'
        | 'interactions'
        | 'context_snapshots'
        | 'extension_records'
        | 'artifact_refs';
      highWaterSeq: string;
      count: string;
    }>;
    excluded: Array<string>;
    contentMedia: 'sqlite-records-and-original-scope-artifact-references';
  };
  verified: true;
  contentMedia: 'sqlite-records-and-original-scope-artifact-references';
};
