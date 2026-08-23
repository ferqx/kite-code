import type {
  BuiltinOperationExecutionValue,
  BuiltinWorkspaceFilesystemTerminalVerifier,
  CapabilityArtifactWriter,
} from '@kite/builtin-runtime';
import type { StateRuntimeEvent, StateRuntimeState } from '@kite/runtime-host';
import type {
  PreparedToolInvocation,
  SandboxPreparationArtifactPort,
  SandboxPreparationLifecycle,
  ToolPipelinePersistence,
  WorkspaceFilesystemDurableEvidencePort,
  WorkspaceFilesystemEditObservationPort,
  WorkspaceFilesystemMutationDurableEvidencePort,
} from '@kite/runtime-spi';

export const APP_STATE_TOOL_PIPELINE_PERSISTENCE_SCHEMA_ =
  'kite.app-state-tool-pipeline-persistence.v1' as const;

export type StateBuiltinOperationStructuredContent = BuiltinOperationExecutionValue;

export interface AppStateToolPipelinePersistence
  extends ToolPipelinePersistence<StateBuiltinOperationStructuredContent> {
  readonly workspaceFilesystemEvidence: WorkspaceFilesystemDurableEvidencePort;
  readonly workspaceFilesystemMutationEvidence: WorkspaceFilesystemMutationDurableEvidencePort;
  readonly workspaceFilesystemEditObservation: WorkspaceFilesystemEditObservationPort;
  readonly createSandboxLifecycle: (input: {
    readonly prepared: Readonly<PreparedToolInvocation>;
    readonly artifacts: SandboxPreparationArtifactPort;
  }) => SandboxPreparationLifecycle;
}

export interface CreateAppStateToolPipelinePersistenceInput {
  readonly getState: () => Readonly<StateRuntimeState>;
  readonly persistAttemptStartEvents: (events: StateRuntimeEvent[]) => Promise<boolean>;
  readonly persistTerminalRecoveryEvents: (events: StateRuntimeEvent[]) => Promise<boolean>;
  readonly persistReceiptEvents: (events: StateRuntimeEvent[]) => Promise<boolean>;
  readonly now: () => string;
  readonly capabilityArtifactWriter: CapabilityArtifactWriter;
  readonly verifyBuiltinWorkspaceFilesystemTerminal?: BuiltinWorkspaceFilesystemTerminalVerifier;
  readonly providerAction?: Readonly<{
    enabled: boolean;
    createInteractionId: () => string;
  }>;
  readonly verificationEnabled?: boolean;
}

export type AppStateToolPipelinePersistenceErrorCode =
  | 'invalid_prepared_request'
  | 'unsupported_operation'
  | 'attempt_identity_mismatch'
  | 'invocation_collision'
  | 'terminal_invocation'
  | 'subagent_lifecycle_pending'
  | 'persistence_unavailable'
  | 'persistence_stale'
  | 'acknowledgement_mismatch'
  | 'filesystem_intent_invalid'
  | 'filesystem_intent_commit_failed'
  | 'filesystem_mutation_ready_invalid'
  | 'filesystem_mutation_ready_commit_failed'
  | 'filesystem_edit_observation_invalid'
  | 'invalid_terminal_result'
  | 'invalid_suspension_result'
  | 'artifact_write_failed'
  | 'terminal_commit_failed'
  | 'retryable_commit_failed'
  | 'suspension_commit_failed';

export class AppStateToolPipelinePersistenceError extends Error {
  readonly code: AppStateToolPipelinePersistenceErrorCode;

  constructor(code: AppStateToolPipelinePersistenceErrorCode, message?: string) {
    super(message ?? persistenceErrorMessage(code));
    this.name = 'AppStateToolPipelinePersistenceError';
    this.code = code;
  }
}

function persistenceErrorMessage(code: AppStateToolPipelinePersistenceErrorCode): string {
  switch (code) {
    case 'invalid_prepared_request':
      return 'State Tool Pipeline prepared request facts are invalid.';
    case 'unsupported_operation':
      return 'State Tool Pipeline persistence does not own this operation family.';
    case 'attempt_identity_mismatch':
      return 'State Tool Pipeline attempt identity does not match prepared facts.';
    case 'invocation_collision':
      return 'State Tool Pipeline invocation identity collided with another Tool call.';
    case 'terminal_invocation':
      return 'A terminal State Tool invocation cannot start another attempt.';
    case 'subagent_lifecycle_pending':
      return 'A pending Subagent Provider lifecycle blocks another attempt.';
    case 'persistence_unavailable':
      return 'State Tool Pipeline persistence is unavailable.';
    case 'persistence_stale':
      return 'State Tool Pipeline persistence became stale before acknowledgement.';
    case 'acknowledgement_mismatch':
      return 'State Tool Pipeline acknowledgement does not match State state.';
    case 'filesystem_intent_invalid':
      return 'State filesystem intent does not match the acknowledged prepared attempt.';
    case 'filesystem_intent_commit_failed':
      return 'State filesystem intent could not be durably acknowledged.';
    case 'filesystem_mutation_ready_invalid':
      return 'State filesystem mutation ready evidence is invalid.';
    case 'filesystem_mutation_ready_commit_failed':
      return 'State filesystem mutation ready evidence could not be durably acknowledged.';
    case 'filesystem_edit_observation_invalid':
      return 'State filesystem edit observation query is invalid.';
    case 'invalid_terminal_result':
      return 'State Tool Pipeline terminal result is invalid.';
    case 'invalid_suspension_result':
      return 'State Tool Pipeline suspension result is invalid.';
    case 'artifact_write_failed':
      return 'Capability result Artifact could not be durably written.';
    case 'terminal_commit_failed':
      return 'State Tool Pipeline terminal receipt could not be committed.';
    case 'retryable_commit_failed':
      return 'State Tool Pipeline safe-read retry evidence could not be committed.';
    case 'suspension_commit_failed':
      return 'State Tool Pipeline suspension evidence could not be committed.';
  }
}
