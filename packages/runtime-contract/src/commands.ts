import { isRuntimeClientInteraction } from './notifications';
import type { RuntimeClientInteraction, RuntimeRunProjection } from './projections';
import {
  hasExactKeys,
  isBoundedString,
  isBoundedUserText,
  isIdentifier,
  isJsonSafeValue,
  isNonNegativeSafeInteger,
  isRecord,
} from './validation';

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
  /** Explicit input dismissal; never overload an empty text answer. */
  | { readonly kind: 'input_cancel' }
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

export type RespondInteractionCommand =
  | (RuntimeSessionCommandBase & {
      readonly type: 'respond_interaction';
      readonly interaction: Extract<RuntimeClientInteraction, { kind: 'input' }>;
      readonly response: Extract<RuntimeInteractionResponse, { kind: 'text' | 'input_cancel' }>;
    })
  | (RuntimeSessionCommandBase & {
      readonly type: 'respond_interaction';
      readonly interaction: Extract<RuntimeClientInteraction, { kind: 'approval' }>;
      readonly response: Extract<RuntimeInteractionResponse, { kind: 'approval' }>;
    })
  | (RuntimeSessionCommandBase & {
      readonly type: 'respond_interaction';
      readonly interaction: Extract<RuntimeClientInteraction, { kind: 'plan_review' }>;
      readonly response: Extract<RuntimeInteractionResponse, { kind: 'plan_review' }>;
    })
  | (RuntimeSessionCommandBase & {
      readonly type: 'respond_interaction';
      readonly interaction: Extract<RuntimeClientInteraction, { kind: 'provider_action' }>;
      readonly response: Extract<RuntimeInteractionResponse, { kind: 'provider_action' }>;
    })
  | (RuntimeSessionCommandBase & {
      readonly type: 'respond_interaction';
      readonly interaction: Extract<RuntimeClientInteraction, { kind: 'verification' }>;
      readonly response: Extract<RuntimeInteractionResponse, { kind: 'verification' }>;
    });

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

/** Clears every same-command approval grant in one receipt-bearing State commit. */
export interface ClearSessionCommandGrantsCommand extends RuntimeSessionCommandBase {
  readonly type: 'clear_session_command_grants';
}

/** Permanently removes one closed/idle Session and its durable State. */
export interface DeleteSessionCommand extends RuntimeSessionCommandBase {
  readonly type: 'delete_session';
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
  | CloseSessionCommand
  | ClearSessionCommandGrantsCommand
  | DeleteSessionCommand;

export type RuntimeCommandErrorCode =
  | 'invalid_command'
  | 'invalid_session'
  | 'session_not_found'
  | 'revision_conflict'
  | 'turn_not_found'
  | 'run_not_found'
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
      readonly resource?: { readonly kind: 'run'; readonly run: RuntimeRunProjection };
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
      readonly resource?: { readonly kind: 'run'; readonly run: RuntimeRunProjection };
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
  'clear_session_command_grants',
  'delete_session',
]);

export function isRuntimeCommand(value: unknown): value is RuntimeCommand {
  if (!isRecord(value)) return false;
  const candidate = value;
  if (
    candidate.schema !== RUNTIME_COMMAND_SCHEMA_ ||
    !isIdentifier(candidate.commandId) ||
    typeof candidate.type !== 'string' ||
    !RUNTIME_COMMAND_TYPES.has(candidate.type as RuntimeCommand['type'])
  ) {
    return false;
  }
  switch (candidate.type) {
    case 'create_session':
      return (
        hasExactKeys(
          candidate,
          optionalKeys(
            candidate,
            ['schema', 'commandId', 'type', 'workspace'],
            ['bootstrapSessionId'],
          ),
        ) &&
        isBoundedString(candidate.workspace) &&
        (!Object.hasOwn(candidate, 'bootstrapSessionId') ||
          isIdentifier(candidate.bootstrapSessionId))
      );
    case 'resume_session':
      return (
        hasExactKeys(
          candidate,
          optionalKeys(candidate, ['schema', 'commandId', 'type', 'sessionId'], ['afterRevision']),
        ) &&
        isIdentifier(candidate.sessionId) &&
        (!Object.hasOwn(candidate, 'afterRevision') ||
          isNonNegativeSafeInteger(candidate.afterRevision))
      );
    case 'start_turn':
      return (
        isSessionCommand(candidate, ['input', 'phase', 'initialSkills']) && isStartTurn(candidate)
      );
    case 'cancel_turn':
      return (
        isSessionCommand(candidate, ['turnId', 'runId']) &&
        isIdentifier(candidate.turnId) &&
        (!Object.hasOwn(candidate, 'runId') || isIdentifier(candidate.runId))
      );
    case 'respond_interaction':
      return (
        isSessionCommand(candidate, ['interaction', 'response']) &&
        isRuntimeClientInteraction(candidate.interaction) &&
        candidate.interaction.sessionRevision === candidate.expectedRevision &&
        isRuntimeInteractionResponse(candidate.response) &&
        responseMatchesInteraction(candidate.interaction, candidate.response)
      );
    case 'set_interaction_mode':
      return (
        isSessionCommand(candidate, ['mode']) &&
        (candidate.mode === 'accept_edits' ||
          candidate.mode === 'auto' ||
          candidate.mode === 'full')
      );
    case 'compact_session':
      return (
        isSessionCommand(candidate, ['mode', 'instructions']) &&
        (candidate.mode === 'manual' || candidate.mode === 'reset') &&
        (!Object.hasOwn(candidate, 'instructions') || isBoundedUserText(candidate.instructions))
      );
    case 'rewind_session':
      return (
        isSessionCommand(candidate, ['checkpointId', 'scope']) &&
        isIdentifier(candidate.checkpointId) &&
        (candidate.scope === 'conversation_only' ||
          candidate.scope === 'conversation_and_workspace' ||
          candidate.scope === 'code_only')
      );
    case 'fork_session':
      return (
        hasExactKeys(
          candidate,
          optionalKeys(
            candidate,
            ['schema', 'commandId', 'type', 'sourceSessionId', 'sourceRevision'],
            ['checkpointId'],
          ),
        ) &&
        isIdentifier(candidate.sourceSessionId) &&
        isNonNegativeSafeInteger(candidate.sourceRevision) &&
        (!Object.hasOwn(candidate, 'checkpointId') || isIdentifier(candidate.checkpointId))
      );
    case 'close_session':
    case 'clear_session_command_grants':
    case 'delete_session':
      return isSessionCommand(candidate, []);
    default:
      return false;
  }
}

export function assertRuntimeCommand(value: unknown): asserts value is RuntimeCommand {
  if (!isRuntimeCommand(value)) throw new TypeError('Invalid RuntimeCommand');
}

function isSessionCommand(value: Record<string, unknown>, fields: readonly string[]): boolean {
  return (
    hasExactKeys(
      value,
      optionalKeys(value, ['schema', 'commandId', 'type', 'sessionId', 'expectedRevision'], fields),
    ) &&
    isIdentifier(value.sessionId) &&
    isNonNegativeSafeInteger(value.expectedRevision)
  );
}

function optionalKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
): readonly string[] {
  return [...required, ...optional.filter((key) => Object.hasOwn(value, key))];
}

function isStartTurn(value: Record<string, unknown>): boolean {
  return (
    isBoundedUserText(value.input) &&
    (!Object.hasOwn(value, 'phase') || value.phase === 'planning' || value.phase === 'building') &&
    (!Object.hasOwn(value, 'initialSkills') ||
      (Array.isArray(value.initialSkills) &&
        value.initialSkills.length <= 64 &&
        value.initialSkills.every(
          (skill) =>
            isRecord(skill) &&
            hasExactKeys(skill, ['skillId', 'input']) &&
            isIdentifier(skill.skillId) &&
            isRecord(skill.input) &&
            isJsonSafeValue(skill.input),
        )))
  );
}

function isRuntimeInteractionResponse(value: unknown): value is RuntimeInteractionResponse {
  if (!isRecord(value) || typeof value.kind !== 'string') return false;
  switch (value.kind) {
    case 'text':
      return hasExactKeys(value, ['kind', 'value']) && isBoundedUserText(value.value);
    case 'input_cancel':
      return hasExactKeys(value, ['kind']);
    case 'approval':
      return (
        hasExactKeys(value, ['kind', 'decision']) &&
        (value.decision === 'approve_once' ||
          value.decision === 'same_command' ||
          value.decision === 'reject')
      );
    case 'plan_review':
      return (
        hasExactKeys(value, optionalKeys(value, ['kind', 'decision'], ['feedback'])) &&
        (value.decision === 'auto' ||
          value.decision === 'accept_edits' ||
          value.decision === 'feedback' ||
          value.decision === 'cancel') &&
        (!Object.hasOwn(value, 'feedback') || isBoundedUserText(value.feedback))
      );
    case 'provider_action':
      return (
        hasExactKeys(value, optionalKeys(value, ['kind', 'outcome'], ['detail'])) &&
        (value.outcome === 'completed' ||
          value.outcome === 'deferred' ||
          value.outcome === 'cancelled') &&
        (!Object.hasOwn(value, 'detail') || isBoundedUserText(value.detail))
      );
    case 'verification':
      return (
        hasExactKeys(value, ['kind', 'decision', 'detail']) &&
        (value.decision === 'replan' ||
          value.decision === 'waive' ||
          value.decision === 'compensate') &&
        isBoundedUserText(value.detail)
      );
    default:
      return false;
  }
}

function responseMatchesInteraction(
  interaction: RuntimeClientInteraction,
  response: RuntimeInteractionResponse,
): boolean {
  return (
    (interaction.kind === 'input' &&
      (response.kind === 'text' || response.kind === 'input_cancel')) ||
    (interaction.kind === 'approval' && response.kind === 'approval') ||
    (interaction.kind === 'plan_review' && response.kind === 'plan_review') ||
    (interaction.kind === 'provider_action' && response.kind === 'provider_action') ||
    (interaction.kind === 'verification' && response.kind === 'verification')
  );
}
