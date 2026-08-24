export const RUNTIME_COMMAND_SCHEMA_ = 'kite.runtime-command.v1' as const;

export interface RuntimeCommandBase {
  readonly schema: typeof RUNTIME_COMMAND_SCHEMA_;
  readonly commandId: string;
}

export interface RuntimeSessionCommandBase extends RuntimeCommandBase {
  readonly sessionId: string;
  readonly expectedRevision: number;
}

/** Create a session for the canonical Workspace resolved by the Runtime Host. */
export interface CreateSessionCommand extends RuntimeCommandBase {
  readonly type: 'create_session';
  readonly workspace: string;
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
      readonly decision: 'approve_once' | 'same_command' | 'reject';
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
      candidate.schema === RUNTIME_COMMAND_SCHEMA_ &&
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
  return typeof create.workspace === 'string' && create.workspace.length > 0;
}

export function assertRuntimeCommand(value: unknown): asserts value is RuntimeCommand {
  if (!isRuntimeCommand(value)) throw new TypeError('Invalid RuntimeCommand');
}
