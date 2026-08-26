import { createHash } from 'node:crypto';
import type { StateRuntimeSession } from '@kite-ai/runtime-host/kernel-adapter';
import type {
  RuntimeCommandCommitEvidence,
  RuntimeStoredCommandReceipt,
} from '@kite-ai/runtime-host/storage';
import {
  approvalRejectionSettlementEvents,
  eventsForRuntimeAction,
  type RuntimeUserAction,
} from './state-actions';
import type { RuntimeEvent, RuntimeState } from './state-runtime';

export interface RuntimeInteractionCommandCommitInput {
  readonly action: RuntimeUserAction;
  readonly sessionId: string;
  readonly interactionId: string;
  readonly expectedRevision: number;
  readonly effectType:
    | 'request_user_input'
    | 'request_plan_review'
    | 'request_tool_approval'
    | 'request_verification_decision'
    | 'request_provider_action'
    | 'request_provider_admission';
  readonly reservationReconciliationEvents: readonly RuntimeEvent[];
  readonly sandboxAvailable: boolean;
  readonly evidence: RuntimeCommandCommitEvidence;
}

export interface PrecommittedInteractionActionDescriptor {
  readonly kind: 'precommitted_interaction_action';
  readonly sessionId: string;
  readonly interactionId: string;
  readonly effectType: RuntimeInteractionCommandCommitInput['effectType'];
  readonly expectedRevision: number;
  readonly committedRevision: number;
  readonly action: RuntimeUserAction;
  readonly actionDigest: string;
  readonly events: readonly RuntimeEvent[];
  readonly eventsDigest: string;
}

export interface CommittedInteractionCommand {
  readonly receipt: RuntimeStoredCommandReceipt;
  readonly events: readonly RuntimeEvent[];
  readonly descriptor: PrecommittedInteractionActionDescriptor;
}

/**
 * The only interaction command write path.  It deliberately never resolves a
 * provider waiter: bridge activation may do that only after Host receipt
 * verification completes.
 */
export function commitInteractionCommand(
  session: StateRuntimeSession,
  input: RuntimeInteractionCommandCommitInput,
): CommittedInteractionCommand {
  const state = session.getState() as RuntimeState;
  if (
    state.session.threadId !== input.sessionId ||
    input.evidence.targetSessionId !== input.sessionId ||
    state.revision !== input.expectedRevision
  ) {
    throw new Error(
      'Runtime interaction command session or revision does not match current State.',
    );
  }
  if (
    input.effectType === 'request_verification_decision'
      ? !state.verification.records[input.interactionId]
      : state.interactions.kind === 'idle' ||
        state.interactions.interactionId !== input.interactionId
  ) {
    throw new Error('Runtime interaction command does not match the active interaction.');
  }

  const actionEvents = eventsForRuntimeAction(state, input.action, {
    sandboxAvailable: input.sandboxAvailable,
  });
  if (actionEvents.length === 0) {
    throw new Error('Runtime interaction command produced no accepted events.');
  }
  const reconciliation =
    input.effectType === 'request_provider_action' ? input.reservationReconciliationEvents : [];
  const settlement = approvalRejectionSettlementEvents(state, actionEvents);
  const committed = session.commitCommandBatch(
    [...actionEvents, ...reconciliation, ...settlement],
    input.evidence,
  );
  const events = committed.events as readonly RuntimeEvent[];
  const descriptor: PrecommittedInteractionActionDescriptor = Object.freeze({
    kind: 'precommitted_interaction_action',
    sessionId: input.sessionId,
    interactionId: input.interactionId,
    effectType: input.effectType,
    expectedRevision: input.expectedRevision,
    committedRevision: committed.receipt.committedRevision,
    action: input.action,
    actionDigest: digestValue(input.action),
    events,
    eventsDigest: digestValue(events),
  });
  return Object.freeze({ receipt: committed.receipt, events, descriptor });
}

export function isPrecommittedInteractionAction(
  value: RuntimeUserAction | PrecommittedInteractionActionDescriptor,
): value is PrecommittedInteractionActionDescriptor {
  return 'kind' in value && value.kind === 'precommitted_interaction_action';
}

export function assertPrecommittedInteractionAction(
  state: Readonly<RuntimeState>,
  descriptor: PrecommittedInteractionActionDescriptor,
  sessionId: string,
): void {
  const actionIdentity =
    'interactionId' in descriptor.action
      ? descriptor.action.interactionId
      : 'verificationId' in descriptor.action
        ? descriptor.action.verificationId
        : undefined;
  if (
    descriptor.sessionId !== sessionId ||
    state.session.threadId !== sessionId ||
    state.revision !== descriptor.committedRevision ||
    actionIdentity !== descriptor.interactionId ||
    digestValue(descriptor.action) !== descriptor.actionDigest ||
    digestValue(descriptor.events) !== descriptor.eventsDigest
  ) {
    throw new Error('Runtime precommitted interaction action does not match current State.');
  }
}

function digestValue(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function canonicalJson(value: unknown, ancestors: Set<object> = new Set()): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'string':
      return JSON.stringify(value);
    case 'number':
      if (!Number.isFinite(value))
        throw new Error('Runtime interaction descriptor is not JSON-safe.');
      return JSON.stringify(value);
    case 'object':
      break;
    default:
      throw new Error('Runtime interaction descriptor is not JSON-safe.');
  }
  if (ancestors.has(value)) throw new Error('Runtime interaction descriptor contains a cycle.');
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new Error('Runtime interaction descriptor has symbols.');
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) {
        throw new Error('Runtime interaction descriptor has an unsafe array prototype.');
      }
      return `[${value.map((entry) => canonicalJson(entry, ancestors)).join(',')}]`;
    }
    if (Object.getPrototypeOf(value) !== Object.prototype) {
      throw new Error('Runtime interaction descriptor has an unsafe object prototype.');
    }
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    if (Object.getOwnPropertyNames(record).length !== keys.length) {
      throw new Error('Runtime interaction descriptor has an unsafe object shape.');
    }
    return `{${keys
      .map((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(record, key);
        if (!descriptor?.enumerable || !('value' in descriptor)) {
          throw new Error('Runtime interaction descriptor has an unsafe property.');
        }
        return `${JSON.stringify(key)}:${canonicalJson(descriptor.value, ancestors)}`;
      })
      .join(',')}}`;
  } finally {
    ancestors.delete(value);
  }
}
