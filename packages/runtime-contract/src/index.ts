export const RUNTIME_CONTRACT_SCHEMA_V1 = 'kite.runtime-contract.v1' as const;
export const RUNTIME_COMMAND_SCHEMA_V1 = 'kite.runtime-command.v1' as const;
export const RUNTIME_QUERY_SCHEMA_V1 = 'kite.runtime-query.v1' as const;
export const RUNTIME_NOTIFICATION_SCHEMA_V1 = 'kite.runtime-notification.v1' as const;
export const RUNTIME_PROJECTION_SCHEMA_V1 = 'kite.runtime-projection.v1' as const;

export * from './capabilities';
export * from './observability';
export * from './presentation';

export interface RuntimeContractBoundaryV1 {
  readonly audience: 'kite-app';
  readonly transport: 'in-process';
  readonly revision: 'rmv1-03';
  readonly schema: typeof RUNTIME_CONTRACT_SCHEMA_V1;
}

export const RUNTIME_CONTRACT_BOUNDARY_V1: RuntimeContractBoundaryV1 = Object.freeze({
  audience: 'kite-app',
  transport: 'in-process',
  revision: 'rmv1-03',
  schema: RUNTIME_CONTRACT_SCHEMA_V1,
});

export interface RuntimeCommandBase {
  readonly schema: typeof RUNTIME_COMMAND_SCHEMA_V1;
  readonly commandId: string;
}

export interface RuntimeSessionCommandBase extends RuntimeCommandBase {
  readonly sessionId: string;
  readonly expectedRevision: number;
}

/** Bootstrap-issued identity binding. It is not an execution grant. */
export interface ProjectHandleV1 {
  readonly version: 1;
  readonly installationId: string;
  readonly keyId: `sha256:${string}`;
  readonly project: {
    readonly projectId: `project_${string}`;
    readonly revision: number;
    readonly workspaceDigest: `sha256:${string}`;
  };
  readonly canonicalWorkspaceDigest: `sha256:${string}`;
  readonly bootstrapIdentity: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly nonce: string;
  readonly authenticator: `hmac-sha256:${string}`;
}

/** RAV1 CreateSession identity: Workspace is accepted only when bound by this Handle. */
export interface CreateSessionCommand extends RuntimeCommandBase {
  readonly type: 'create_session';
  readonly workspace: string;
  readonly projectHandle: ProjectHandleV1;
  readonly bootstrapSessionId?: string;
}

export interface ResumeSessionCommand extends RuntimeCommandBase {
  readonly type: 'resume_session';
  readonly sessionId: string;
  readonly afterRevision?: number;
}

export interface StartTurnCommand extends RuntimeSessionCommandBase {
  readonly type: 'start_turn';
  readonly input: string;
  readonly phase?: 'planning' | 'building';
  readonly initialSkills?: readonly {
    readonly skillId: string;
    readonly input: Readonly<Record<string, unknown>>;
  }[];
}

export interface CancelTurnCommand extends RuntimeSessionCommandBase {
  readonly type: 'cancel_turn';
  readonly turnId: string;
  readonly runId?: string;
}

export type RuntimeInteractionResponse =
  | { readonly kind: 'text'; readonly value: string }
  | {
      readonly kind: 'approval';
      readonly decision: 'approve_once' | 'full_access' | 'reject';
    }
  | {
      readonly kind: 'plan_review';
      readonly decision: 'auto' | 'accept_edits' | 'feedback' | 'cancel';
      readonly feedback?: string;
    }
  | {
      readonly kind: 'provider_action';
      readonly outcome: 'completed' | 'deferred' | 'cancelled';
      readonly detail?: string;
    }
  | {
      readonly kind: 'verification';
      readonly decision: 'replan' | 'waive' | 'compensate';
      readonly detail: string;
    };

export interface RespondInteractionCommand extends RuntimeSessionCommandBase {
  readonly type: 'respond_interaction';
  readonly interactionId: string;
  readonly response: RuntimeInteractionResponse;
}

export interface SetInteractionModeCommand extends RuntimeSessionCommandBase {
  readonly type: 'set_interaction_mode';
  readonly mode: 'accept_edits' | 'auto' | 'full';
}

export interface CompactSessionCommand extends RuntimeSessionCommandBase {
  readonly type: 'compact_session';
  readonly mode: 'manual' | 'reset';
  readonly instructions?: string;
}

export interface RewindSessionCommand extends RuntimeSessionCommandBase {
  readonly type: 'rewind_session';
  readonly checkpointId: string;
  readonly scope: 'conversation_only' | 'conversation_and_workspace' | 'code_only';
}

export interface ForkSessionCommand extends RuntimeCommandBase {
  readonly type: 'fork_session';
  readonly sourceSessionId: string;
  readonly sourceRevision: number;
  readonly checkpointId?: string;
}

export interface CloseSessionCommand extends RuntimeSessionCommandBase {
  readonly type: 'close_session';
}

export type RuntimeCommand =
  | CreateSessionCommand
  | ResumeSessionCommand
  | StartTurnCommand
  | CancelTurnCommand
  | RespondInteractionCommand
  | SetInteractionModeCommand
  | CompactSessionCommand
  | RewindSessionCommand
  | ForkSessionCommand
  | CloseSessionCommand;

export type RuntimeCommandErrorCode =
  | 'invalid_command'
  | 'invalid_session'
  | 'session_not_found'
  | 'revision_conflict'
  | 'turn_not_found'
  | 'interaction_mismatch'
  | 'checkpoint_unavailable'
  | 'policy_denied'
  | 'runtime_busy'
  | 'session_unavailable'
  | 'unsupported'
  | 'already_closed';

export type RuntimeCommandReceipt =
  | {
      readonly status: 'applied';
      readonly commandId: string;
      readonly sessionId: string;
      readonly revision: number;
    }
  | {
      readonly status: 'conflict' | 'rejected' | 'not_found';
      readonly commandId: string;
      readonly code: RuntimeCommandErrorCode;
      readonly currentRevision?: number;
    }
  | {
      readonly status: 'idempotent_replay';
      readonly commandId: string;
      readonly sessionId: string;
      readonly originalRevision: number;
    };

export interface RuntimeEvidenceSummary {
  readonly kind: string;
  readonly status: 'pending' | 'accepted' | 'rejected' | 'unavailable';
  readonly digest?: string;
}

export interface RuntimeInteractionProjection {
  readonly interactionId: string;
  readonly kind: 'approval' | 'input' | 'plan_review' | 'provider_action' | 'verification';
  readonly title?: string;
  readonly summary?: string;
}

export interface RuntimeTurnProjection {
  readonly turnId: string;
  readonly status: 'queued' | 'running' | 'waiting' | 'completed' | 'cancelled' | 'failed';
  readonly summary?: string;
  readonly interaction?: RuntimeInteractionProjection;
  readonly evidence?: readonly RuntimeEvidenceSummary[];
}

export interface RuntimeWorkProjection {
  readonly workId: string;
  readonly phase: 'planning' | 'building';
  readonly status: 'queued' | 'running' | 'waiting' | 'completed' | 'cancelled' | 'failed';
  readonly title?: string;
  readonly activeTurn?: RuntimeTurnProjection;
}

export interface RuntimeSessionProjection {
  readonly schema: typeof RUNTIME_PROJECTION_SCHEMA_V1;
  readonly sessionId: string;
  readonly revision: number;
  readonly displayName?: string;
  readonly workspace?: string;
  readonly updatedAt?: string;
  readonly lifecycle: 'open' | 'closed' | 'unavailable';
  readonly activeWork?: RuntimeWorkProjection;
}

export interface RuntimeCheckpointProjection {
  readonly checkpointId: string;
  readonly sessionId: string;
  readonly revision: number;
  readonly createdAt?: string;
  readonly summary?: string;
}

export interface RuntimeContextProjection {
  readonly sessionId: string;
  readonly revision: number;
  readonly usedTokens?: number;
  readonly availableTokens?: number;
  readonly compactionAvailable: boolean;
}

export type RuntimeQuery =
  | { readonly schema: typeof RUNTIME_QUERY_SCHEMA_V1; readonly type: 'list_sessions' }
  | {
      readonly schema: typeof RUNTIME_QUERY_SCHEMA_V1;
      readonly type: 'get_session_projection';
      readonly sessionId: string;
    }
  | {
      readonly schema: typeof RUNTIME_QUERY_SCHEMA_V1;
      readonly type: 'get_context_status';
      readonly sessionId: string;
    }
  | {
      readonly schema: typeof RUNTIME_QUERY_SCHEMA_V1;
      readonly type: 'list_checkpoints';
      readonly sessionId: string;
    }
  | {
      readonly schema: typeof RUNTIME_QUERY_SCHEMA_V1;
      readonly type: 'get_rewind_preview';
      readonly sessionId: string;
      readonly checkpointId: string;
    };

export type RuntimeQueryResult =
  | {
      readonly status: 'ok';
      readonly queryType: RuntimeQuery['type'];
      readonly revision?: number;
      readonly sessions?: readonly RuntimeSessionProjection[];
      readonly session?: RuntimeSessionProjection;
      readonly context?: RuntimeContextProjection;
      readonly checkpoints?: readonly RuntimeCheckpointProjection[];
      readonly rewindPreview?: RuntimeCheckpointProjection;
    }
  | {
      readonly status: 'not_found' | 'rejected' | 'unavailable';
      readonly queryType: RuntimeQuery['type'];
      readonly code: RuntimeCommandErrorCode;
    };

export interface RuntimeProjectionDelta {
  readonly kind: 'snapshot' | 'session' | 'work' | 'turn' | 'interaction' | 'evidence';
  readonly session: RuntimeSessionProjection;
  /** App-safe legacy presentation payload retained only during RMV1 migration. */
  readonly presentation?: ClientPresentationEvent;
}

/**
 * A presentation-only compatibility payload. It carries no state/store/provider
 * authority. RMV1-16 removes it when the remaining App presentation handlers
 * have migrated to typed Runtime projections.
 */
export type ClientPresentationEvent = Readonly<{ type: string } & Record<string, unknown>>;

export type RuntimeStreamPayload =
  | { readonly type: 'model_delta'; readonly text: string }
  | { readonly type: 'reasoning_delta'; readonly text: string }
  | {
      readonly type: 'tool_progress';
      readonly toolId: string;
      readonly status: 'started' | 'progress' | 'completed' | 'failed';
      readonly summary?: string;
      readonly stream?: 'stdout' | 'stderr';
      readonly lineCount?: number;
    };

export type RuntimeNotification =
  | {
      readonly schema: typeof RUNTIME_NOTIFICATION_SCHEMA_V1;
      readonly durability: 'durable';
      readonly sessionId: string;
      readonly revision: number;
      readonly projection: RuntimeProjectionDelta;
    }
  | {
      readonly schema: typeof RUNTIME_NOTIFICATION_SCHEMA_V1;
      readonly durability: 'ephemeral';
      readonly sessionId: string;
      readonly workId: string;
      readonly turnId: string;
      readonly actorId: string;
      readonly attemptId: string;
      readonly compositionRevision: string;
      readonly streamId: string;
      readonly sequence: number;
      readonly payload: RuntimeStreamPayload;
    };

export interface RuntimeSubscription {
  readonly sessionId: string;
  readonly afterRevision?: number;
  readonly signal?: AbortSignal;
}

export interface RuntimeAccess {
  command(command: RuntimeCommand): Promise<RuntimeCommandReceipt>;
  query(query: RuntimeQuery): Promise<RuntimeQueryResult>;
  subscribe(subscription: RuntimeSubscription): AsyncIterable<RuntimeNotification>;
}

const RUNTIME_COMMAND_TYPES: ReadonlySet<RuntimeCommand['type']> = new Set([
  'create_session',
  'resume_session',
  'start_turn',
  'cancel_turn',
  'respond_interaction',
  'set_interaction_mode',
  'compact_session',
  'rewind_session',
  'fork_session',
  'close_session',
]);

export function isRuntimeCommand(value: unknown): value is RuntimeCommand {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<RuntimeCommand>;
  if (
    !(
      candidate.schema === RUNTIME_COMMAND_SCHEMA_V1 &&
      typeof candidate.commandId === 'string' &&
      candidate.commandId.length > 0 &&
      typeof candidate.type === 'string' &&
      RUNTIME_COMMAND_TYPES.has(candidate.type as RuntimeCommand['type'])
    )
  ) {
    return false;
  }
  if (candidate.type !== 'create_session') return true;
  const create = candidate as Partial<CreateSessionCommand>;
  return (
    typeof create.workspace === 'string' &&
    create.workspace.length > 0 &&
    isProjectHandleV1(create.projectHandle)
  );
}

function isProjectHandleV1(value: unknown): value is ProjectHandleV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const handle = value as Partial<ProjectHandleV1>;
  const project = handle.project as Partial<ProjectHandleV1['project']> | undefined;
  return (
    handle.version === 1 &&
    typeof handle.installationId === 'string' &&
    /^sha256:[a-f0-9]{64}$/u.test(handle.keyId ?? '') &&
    !!project &&
    typeof project.projectId === 'string' &&
    project.projectId.startsWith('project_') &&
    Number.isSafeInteger(project.revision) &&
    /^sha256:[a-f0-9]{64}$/u.test(project.workspaceDigest ?? '') &&
    /^sha256:[a-f0-9]{64}$/u.test(handle.canonicalWorkspaceDigest ?? '') &&
    typeof handle.bootstrapIdentity === 'string' &&
    handle.bootstrapIdentity.length > 0 &&
    typeof handle.issuedAt === 'string' &&
    typeof handle.expiresAt === 'string' &&
    typeof handle.nonce === 'string' &&
    handle.nonce.length > 0 &&
    /^hmac-sha256:[a-f0-9]{64}$/u.test(handle.authenticator ?? '')
  );
}

export function assertRuntimeCommand(value: unknown): asserts value is RuntimeCommand {
  if (!isRuntimeCommand(value)) throw new TypeError('Invalid RuntimeCommand');
}
