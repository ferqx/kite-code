import type {
  CallerCommandRequest,
  ClearPermissionGrantsRequest,
  Command,
  Execution,
  FileCheckpointDetail,
  FileCheckpointPage,
  FileCheckpointRecoveryBoundary,
  FileRestoreStatus,
  Interaction,
  Message,
  ModelInputPage,
  PermissionGrantPage,
  PermissionMutation,
  Run,
  SelectContextRequest,
  SelectedContextPage,
  Session,
  Workspace,
} from '@kite-ai/client';
import type { FileRecoveryIntent } from '@kite-ai/client/file-recovery-intent';
import type {
  ContextSubmission,
  DesktopPermissionFacts,
  InteractionAnswerSubmission,
  PermissionSubmission,
} from './controller';
import type { InputMetadata, InputRequest } from './input';

export type NativeAnswerMetadata = {
  scope: { storeId: string; sessionId: string; workspaceId: string; contextSelectionId: string };
  subjectId: string;
  interaction: Pick<Interaction, 'id' | 'revision' | 'kind'>;
  request: { expectedStoreId: string; commandId: string; expectedRevision: string };
  bodyDigest: string;
  requestDigest: string;
  phase: 'submitting' | 'unknown' | 'accepted' | 'failed';
  association: 'current' | 'unavailable';
};

export const nativeChannel = 'kite:native:request';
export const nativeEventChannel = 'kite:native:changed';
export type NativeCallerIntent = {
  scope: { storeId: string; sessionId: string; workspaceId: string };
  subjectId: string;
  request: CallerCommandRequest;
  target: {
    kind: 'session' | 'run' | 'after_run' | 'command' | 'execution';
    id: string | null;
    contextSelectionId?: string;
  };
  bodyDigest: string;
  requestDigest: string;
  draft?: { id: string; revision: string; textDigest: string };
};
export type NativeCallerRecord = {
  intent: NativeCallerIntent;
  phase: 'submitting' | 'unknown' | 'accepted' | 'applied' | 'rejected';
};
export type NativeCallerMetadata = Omit<NativeCallerIntent, 'request'> & {
  request: Pick<CallerCommandRequest, 'kind' | 'commandId' | 'expectedStoreId'>;
  phase: NativeCallerRecord['phase'];
};
export type NativeCallerBody = {
  kind: 'caller.body';
  commandId: string;
  readId: string;
  bodyDigest: string;
  offset: number;
  nextOffset: number;
  eof: boolean;
  data: string;
  bodyBytes: number;
};
export type NativeSelection = {
  readonly canReadContext?: boolean;
  readonly canReadModelOutput: boolean;
  readonly canReadModelInput?: boolean;
  readonly canReadPermissionGrants?: boolean;
  readonly permissionUnavailable?: boolean;
  readonly viewLoading?: boolean;
  readonly viewGeneration: number;
  readonly viewSelection?: number;
  readonly storeId: string;
  readonly session: Session;
  readonly runs: readonly Run[];
  readonly activeCommand?: Command;
  readonly executions: readonly Execution[];
  readonly interactions: readonly Interaction[];
  readonly interactionsAfterId: string | null;
  readonly permissions?: DesktopPermissionFacts;
};
export type NativeDraft = {
  id: string;
  storeId: string;
  workspaceId: string;
  rootSessionId: string;
  revision: number;
  content: string;
  association?: 'current' | 'unavailable';
};
export type NativeCreation = {
  input: {
    expectedStoreId: string;
    workspaceId: string;
    commandId: string;
    sessionId: string;
    title: string;
  };
  phase: 'pending' | 'unknown' | 'created' | 'rejected';
  code?: string;
};
export type NativeGrantFacts = { observationId: number; page: PermissionGrantPage };
export type NativeModelSettingsFacts = {
  kind: 'settings.models';
  observationId: number;
  storeId: string;
  scope: 'user' | 'workspace';
  workspaceId?: string;
  canWrite: boolean;
  errors: string[];
  defaultModelId: string | null;
  models: {
    id: string;
    provider?: string;
    model?: string;
    enabled: boolean;
    configured: boolean;
    diagnostics: string[];
  }[];
};
export type NativeModelSettingsSubmission = {
  kind: 'settings.models.submission';
  commandId: string;
  storeId: string;
  scope: 'user' | 'workspace';
  workspaceId?: string;
  observationId: number;
  operation:
    | { kind: 'enabled'; modelId: string; enabled: boolean }
    | { kind: 'default'; modelId: string };
  phase: 'submitting' | 'unknown' | 'applied' | 'failed';
  error?: string;
};
export type NativeContextFacts = { observationId: number; page: SelectedContextPage };
export type NativeCompressionSubmission = {
  kind: 'compress' | 'reset';
  sessionId: string;
  rootSessionId: string;
  phase: 'saved' | 'submitting' | 'unknown' | 'accepted' | 'applied' | 'failed';
  intent: {
    expectedStoreId: string;
    commandId: string;
    expectedContextSelectionId: string;
    expectedCompressionId: string | null;
    focusBytes: number;
    focusHash: string;
  };
  command?: Command;
  run?: Run;
  error?: string;
};
export type NativeSessionFacts = { observationId: number; session: Session };
export type NativeSessionSubmission = {
  kind: 'fork' | 'rename' | 'delete';
  phase: 'saved' | 'submitting' | 'unknown' | 'applied' | 'failed';
  sessionId: string;
  workspaceId: string;
  intent: {
    expectedStoreId: string;
    commandId: string;
    ifRevision: string;
    expectedContextSelectionId: string;
    title?: string;
    newSessionId?: string;
  };
  error?: string;
  newSessionId?: string;
  omittedExtensionState?: boolean;
  stopConfirmed?: false;
  session?: Session;
};
export type NativeGrantSubmission = {
  sessionId: string;
  workspaceId: string;
  observationId: number;
  intent: ClearPermissionGrantsRequest;
  phase: 'saved' | 'submitting' | 'unknown' | 'applied' | 'failed';
  error?: string;
  receipt?: PermissionMutation;
};
export type NativeRecoveryFacts = {
  observationId: number;
  storeId: string;
  sessionId: string;
  kind: 'run' | 'report' | 'interrupt';
  targetId?: string;
  originalCommandId?: string;
};
export type NativeRecoverySubmission = NativeRecoveryFacts & {
  commandId: string;
  phase:
    | 'submitting'
    | 'accepted'
    | 'resumed'
    | 'interrupted'
    | 'suppressed'
    | 'failed'
    | 'outcome_unknown';
  command?: Command;
  run?: Run;
  error?: string;
};
export type NativeRecoveryIntent = Omit<NativeRecoverySubmission, 'command' | 'run'>;
export type NativeFileRecoveryObservation = {
  kind: 'fileRecovery.observation';
  observationId: number;
  inputRevision: number;
  detail: FileCheckpointDetail;
  boundary: FileCheckpointRecoveryBoundary;
};
export type NativeState = {
  readonly generation: number;
  readonly fileRecoverySubmissions?: readonly FileRecoveryIntent[];
  readonly recoverySubmissions?: readonly NativeRecoverySubmission[];
  readonly historyEpoch?: number;
  readonly selection?: NativeSelection;
  readonly creationSubmissions: readonly NativeCreation[];
  readonly inputSubmissions: readonly InputMetadata[];
  readonly callerSubmissions?: readonly NativeCallerMetadata[];
  readonly callerUnavailable?: boolean;
  readonly grantSubmissions?: readonly NativeGrantSubmission[];
  readonly contextSubmissions?: readonly ContextSubmission[];
  readonly compressionSubmissions?: readonly NativeCompressionSubmission[];
  readonly sessionSubmissions?: readonly NativeSessionSubmission[];
  readonly modelSettingsSubmissions?: readonly NativeModelSettingsSubmission[];
  readonly permissionSubmissions: readonly PermissionSubmission[];
  readonly interactionSubmissions: readonly InteractionAnswerSubmission[];
  readonly answerSubmissions?: readonly NativeAnswerMetadata[];
  readonly answerUnavailable?: boolean;
};
export type NativeEvent = { readonly generation: number; readonly kind: 'changed' };
export type NativeModelBodyOpen<K extends 'modelOutput' | 'modelInput'> = {
  kind: `${K}.opened`;
  readId: string;
  viewGeneration: number;
  viewSelection: number;
  storeId: string;
  sessionId: string;
  executionId: string;
  wireBytes: string;
  bodyHash: string;
  bodyBytes: string;
};
export type NativeModelBodyChunk<K extends 'modelOutput' | 'modelInput'> = {
  kind: `${K}.chunk`;
  readId: string;
  offset: number;
  nextOffset: number;
  eof: boolean;
  data: string;
};
export type NativeModelOutputOpen = NativeModelBodyOpen<'modelOutput'>;
export type NativeModelOutputChunk = NativeModelBodyChunk<'modelOutput'>;
export type NativeModelInputOpen = NativeModelBodyOpen<'modelInput'>;
export type NativeModelInputChunk = NativeModelBodyChunk<'modelInput'>;
export type NativeRequest =
  | { method: 'interactions.next'; generation: number; viewGeneration: number; afterId: string }
  | { method: 'interactions.close'; generation: number; viewGeneration: number }
  | { method: 'settings.models.read'; generation: number; scope: 'user' | 'workspace' }
  | { method: 'settings.models.close'; generation: number }
  | {
      method: 'settings.models.enabled';
      generation: number;
      observationId: number;
      modelId: string;
      enabled: boolean;
    }
  | {
      method: 'settings.models.default';
      generation: number;
      observationId: number;
      modelId: string;
    }
  | { method: 'settings.models.lookup'; generation: number; commandId: string }
  | {
      method: 'recovery.prepare';
      generation: number;
      kind: 'run' | 'report' | 'interrupt';
      targetId?: string;
      readId: string;
    }
  | { method: 'recovery.submit'; generation: number; observationId: number; confirm: boolean }
  | { method: 'recovery.lookup'; generation: number; commandId: string; readId: string }
  | { method: 'recovery.close'; generation: number; readId: string }
  | { method: 'fileRecovery.list'; generation: number; readId: string; afterKey?: string }
  | {
      method: 'fileRecovery.detail';
      generation: number;
      readId: string;
      pointId: string;
      inputRevision: number;
    }
  | {
      method: 'fileRecovery.status';
      generation: number;
      readId: string;
      pointId: string;
      restoreId: string;
    }
  | {
      method: 'fileRecovery.begin';
      generation: number;
      observationId: number;
      scope: 'session' | 'code' | 'both';
      title: string;
      inputRevision: number;
    }
  | { method: 'fileRecovery.continue'; generation: number; intentId: string }
  | { method: 'fileRecovery.lookup'; generation: number; intentId: string; readId: string }
  | { method: 'fileRecovery.listSaved'; generation: number }
  | { method: 'fileRecovery.close'; generation: number; readId: string }
  | { method: 'session.observe'; generation: number; sessionId: string }
  | {
      method: 'session.fork' | 'session.rename';
      generation: number;
      observationId: number;
      title: string;
    }
  | { method: 'session.delete'; generation: number; observationId: number }
  | { method: 'lookupSessionMutation'; generation: number; commandId: string }
  | {
      method: 'context.read' | 'context.next';
      generation: number;
      sessionId: string;
      readId: string;
    }
  | { method: 'context.close'; generation: number; readId: string }
  | {
      method: 'context.rewind';
      generation: number;
      observationId: number;
      boundary: SelectContextRequest['boundary'];
    }
  | {
      method: 'context.include';
      generation: number;
      observationId: number;
      executionId: string;
      resultRevision: string;
      scope: {
        storeId: string;
        sessionId: string;
        contextSelectionId: string;
        targetRunId?: string;
      };
    }
  | { method: 'lookupContext'; generation: number; commandId: string }
  | { method: 'context.compress'; generation: number; observationId: number; focus?: string }
  | { method: 'context.resetCompression'; generation: number; observationId: number }
  | { method: 'lookupCompression'; generation: number; commandId: string }
  | {
      method: 'grants.read';
      generation: number;
      sessionId: string;
      afterSeq?: string;
      upperSeq?: string;
      revision?: string;
    }
  | { method: 'grants.clear'; generation: number; observationId: number }
  | { method: 'lookupGrant'; generation: number; commandId: string }
  | {
      method: 'modelInputs.list';
      generation: number;
      readId: string;
      expectedStoreId: string;
      sessionId: string;
      afterSeq?: string;
      upperSeq?: string;
      limit?: number;
    }
  | { method: 'modelInputs.close'; generation: number; readId: string }
  | {
      method: 'modelInput.open';
      generation: number;
      readId: string;
      expectedStoreId: string;
      sessionId: string;
      executionId: string;
    }
  | { method: 'modelInput.read'; generation: number; readId: string; offset: number; limit: number }
  | { method: 'modelInput.close'; generation: number; readId: string }
  | {
      method: 'modelOutput.open';
      generation: number;
      readId: string;
      expectedStoreId: string;
      sessionId: string;
      executionId: string;
      messageId?: string;
    }
  | {
      method: 'modelOutput.read';
      generation: number;
      readId: string;
      offset: number;
      limit: number;
    }
  | { method: 'modelOutput.close'; generation: number; readId: string }
  | { method: 'attach' }
  | { method: 'state' | 'directory' | 'detach' | 'workspace.pick'; generation: number }
  | { method: 'select'; generation: number; sessionId: string }
  | {
      method: 'createSession';
      generation: number;
      workspaceId: string;
      commandId: string;
      sessionId: string;
      title: string;
      expectedStoreId: string;
    }
  | {
      method: 'messages';
      generation: number;
      expectedStoreId?: string;
      readId?: string;
      sessionId: string;
      afterSeq?: string;
      upperSeq?: string;
      limit?: number;
    }
  | { method: 'messages.close'; generation: number; readId: string }
  | {
      method: 'submit';
      generation: number;
      sessionId: string;
      intent: InputRequest;
      draft?: NativeCallerIntent['draft'];
    }
  | {
      method: 'caller.prepare';
      generation: number;
      sessionId: string;
      intent: CallerCommandRequest;
      draft?: NativeCallerIntent['draft'];
    }
  | {
      method: 'caller.submit' | 'caller.lookup' | 'caller.clear';
      generation: number;
      commandId: string;
    }
  | { method: 'caller.list'; generation: number }
  | {
      method: 'caller.body';
      generation: number;
      commandId: string;
      readId: string;
      offset: number;
      limit: number;
    }
  | { method: 'caller.close'; generation: number; readId: string }
  | {
      method: 'lookupInput' | 'cancelInput' | 'lookupPermission' | 'lookupInteraction';
      generation: number;
      commandId: string;
    }
  | { method: 'draft.list'; generation: number; afterId?: string }
  | { method: 'draft.original'; generation: number; draftId: string }
  | { method: 'lookupCreation'; generation: number; commandId: string }
  | { method: 'draft.read'; generation: number; sessionId: string }
  | {
      method: 'draft.write';
      generation: number;
      sessionId: string;
      revision: number;
      content: string;
    }
  | {
      method: 'permission.mode';
      generation: number;
      observationId: number;
      mode: 'ask' | 'accept_edits' | 'auto' | 'full';
      makeDefault: boolean;
    }
  | { method: 'permission.trust'; generation: number; observationId: number; trusted: boolean }
  | { method: 'permission.refresh'; generation: number }
  | {
      method: 'interaction.answer';
      generation: number;
      interactionId: string;
      revision: string;
      answer: import('@kite-ai/client').AnswerInteractionRequest['answer'];
    };
export type NativeResult =
  | FileCheckpointPage
  | FileCheckpointDetail
  | FileCheckpointRecoveryBoundary
  | FileRestoreStatus
  | NativeFileRecoveryObservation
  | FileRecoveryIntent
  | FileRecoveryIntent[]
  | NativeRecoveryFacts
  | NativeRecoverySubmission
  | NativeModelSettingsFacts
  | NativeModelSettingsSubmission
  | NativeSessionFacts
  | NativeContextFacts
  | NativeGrantFacts
  | NativeState
  | ModelInputPage
  | NativeModelInputOpen
  | NativeModelInputChunk
  | NativeModelOutputOpen
  | NativeModelOutputChunk
  | { workspaces: Workspace[]; sessions: Session[]; storeId: string }
  | { messages: Message[]; nextAfterSeq: string | null; highWaterSeq: string }
  | NativeDraft
  | NativeCreation
  | { drafts: Omit<NativeDraft, 'content'>[]; nextId: string | null }
  | InputMetadata
  | NativeCallerMetadata
  | { kind: 'caller.directory'; records: NativeCallerMetadata[] }
  | NativeCallerBody
  | PermissionMutation
  | Command
  | Session
  | null;
export type NativeReply = { ok: true; value: NativeResult } | { ok: false; code: string };
export interface NativeBridge {
  request(input: NativeRequest): Promise<NativeResult>;
  watch(listener: (event: NativeEvent) => void): () => void;
}
declare global {
  interface Window {
    readonly kiteNative?: Readonly<NativeBridge>;
  }
}
