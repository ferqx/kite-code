import type { KernelEvent } from '../../events';
import { recordToolOwnedProgressV1 } from '../../recovery';
import {
  arrayField,
  asJsonObject,
  eventRecord,
  isRecord,
  nonEmptyStringField,
  numberField,
  recordField,
  stringField,
  updateToolCall,
} from '../../reducer-utils';
import type { AgentPlan, AgentState, AgentTranscriptMessage, PlanDocument } from '../../state';

const EPOCH_CREATED_AT = '1970-01-01T00:00:00.000Z';

function isTimestamp(value: unknown): value is string {
  return (
    typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value)
  );
}

function objectValue(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return isRecord(value) ? value : undefined;
}

function hasOnlyKeys(value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function isPlanTransport(value: unknown): value is AgentPlan {
  const plan = objectValue(value);
  if (
    !plan ||
    Object.keys(plan).length !== 4 ||
    !hasOnlyKeys(plan, ['name', 'description', 'status', 'steps']) ||
    typeof plan.name !== 'string' ||
    typeof plan.description !== 'string' ||
    plan.status !== 'pending' ||
    !Array.isArray(plan.steps)
  ) {
    return false;
  }
  return plan.steps.every((value) => {
    const step = objectValue(value);
    return (
      step !== undefined &&
      hasOnlyKeys(step, ['id', 'step', 'status', 'note']) &&
      typeof step.step === 'string' &&
      (step.status === 'pending' ||
        step.status === 'in_progress' ||
        step.status === 'completed' ||
        step.status === 'skipped') &&
      (step.id === undefined || typeof step.id === 'string') &&
      (step.note === undefined || typeof step.note === 'string')
    );
  });
}

function planTransportMatchesDocument(value: unknown, document: PlanDocument): value is AgentPlan {
  if (
    !isPlanTransport(value) ||
    value.name !== document.title ||
    value.description !== document.bodyMarkdown ||
    value.steps.length !== document.steps.length
  ) {
    return false;
  }
  return value.steps.every((candidate, index) => {
    const step = document.steps[index];
    return (
      step !== undefined &&
      candidate.id === step.id &&
      candidate.step === step.title &&
      candidate.status === step.status &&
      candidate.note === step.note &&
      Object.hasOwn(candidate, 'note') === (step.note !== undefined)
    );
  });
}

function canonicalPlan(document: PlanDocument): AgentPlan {
  return {
    name: document.title,
    description: document.bodyMarkdown,
    status: 'pending',
    steps: document.steps.map((step) => ({
      id: step.id,
      step: step.title,
      status: step.status,
      ...(step.note === undefined ? {} : { note: step.note }),
    })),
  };
}

function reviewIdentityMatches(
  state: AgentState,
  payload: Readonly<Record<string, unknown>>,
): boolean {
  const interaction = state.interactions;
  if (interaction.kind !== 'awaiting_review') return false;
  return (
    nonEmptyStringField(payload, 'interactionId') === interaction.interactionId &&
    nonEmptyStringField(payload, 'toolCallId') === interaction.toolCallId &&
    nonEmptyStringField(payload, 'planId') === interaction.planId &&
    numberField(payload, 'version') === interaction.version &&
    nonEmptyStringField(payload, 'structuralDigest') === interaction.structuralDigest
  );
}

function appendRuntimeTranscript(
  state: AgentState,
  messageId: string,
  content: string,
): AgentState {
  return {
    ...state,
    transcript: {
      ...state.transcript,
      messages: [
        ...state.transcript.messages,
        {
          kind: 'runtime',
          messageId,
          turnId: state.turn.turnId,
          ordinal: state.transcript.messages.length,
          createdAt: EPOCH_CREATED_AT,
          content,
        },
      ],
    },
  };
}

/** Keep sibling tool results in the model declaration order. */
function appendToolTranscript(
  state: AgentState,
  call: AgentState['tools']['calls'][string],
): AgentState {
  const message = {
    kind: 'tool' as const,
    messageId: `tool-${call.toolCallId}`,
    turnId: state.turn.turnId,
    ordinal: state.transcript.messages.length,
    createdAt: EPOCH_CREATED_AT,
    toolCallId: call.toolCallId,
    name: call.name,
    content: call.error ?? 'MCP provider action is required.',
    ok: false,
  };
  const messages = [...state.transcript.messages, message];
  if (call.modelMessageId) {
    const positions = messages.flatMap((candidate, index) => {
      if (candidate.kind !== 'tool') return [];
      const toolMessage = candidate as Extract<AgentTranscriptMessage, { kind: 'tool' }>;
      return state.tools.calls[toolMessage.toolCallId]?.modelMessageId === call.modelMessageId
        ? [index]
        : [];
    });
    const ordered = positions
      .map((index) => ({
        index,
        message: messages[index]! as Extract<AgentTranscriptMessage, { kind: 'tool' }>,
      }))
      .sort((left, right) => {
        const leftOrdinal = state.tools.calls[left.message.toolCallId]?.ordinal;
        const rightOrdinal = state.tools.calls[right.message.toolCallId]?.ordinal;
        if (leftOrdinal == null && rightOrdinal == null) return left.index - right.index;
        if (leftOrdinal == null) return 1;
        if (rightOrdinal == null) return -1;
        return leftOrdinal - rightOrdinal || left.index - right.index;
      })
      .map((entry) => entry.message);
    for (const [orderedIndex, position] of positions.entries()) {
      messages[position] = ordered[orderedIndex]!;
    }
  }
  return {
    ...state,
    transcript: {
      ...state.transcript,
      messages: messages.map((candidate, ordinal) => ({ ...candidate, ordinal })),
    },
  };
}

function activeProviderFailureIds(state: AgentState, toolCallId: string): string[] {
  return state.toolRecovery.order.filter((failureId) => {
    const failure = state.toolRecovery.failures[failureId];
    return (
      failure !== undefined &&
      failure.status === 'unresolved' &&
      failure.taskId === (state.activeTaskId ?? undefined) &&
      failure.turnId === state.turn.turnId &&
      failure.toolCallId === toolCallId
    );
  });
}

function settleProviderAdmission(
  state: AgentState,
  interactionId: string | undefined,
  waiver?: { providerId: string; source: unknown; reason: unknown; waivedAt: unknown },
): AgentState {
  if (!interactionId) return state;
  const pending = (arrayField(state.providerAdmission, 'pending') ?? []).filter(
    (entry) =>
      !(
        typeof entry === 'object' &&
        entry !== null &&
        stringField(entry, 'interactionId') === interactionId
      ),
  );
  const waivers = recordField(state.providerAdmission, 'waivers') ?? {};
  const next = pending[0];
  return {
    ...state,
    providerAdmission: asJsonObject({
      ...state.providerAdmission,
      pending,
      ...(waiver
        ? {
            waivers: {
              ...waivers,
              [waiver.providerId]: asJsonObject(waiver),
            },
          }
        : {}),
    }),
    interactions: next
      ? asJsonObject({ kind: 'awaiting_provider_admission', ...next })
      : { kind: 'idle' },
  };
}

/** User, plan-review, and provider admission interactions share one reducer. */
export function reduceInteractionState(state: AgentState, event: KernelEvent): AgentState {
  const payload = eventRecord(event);
  switch (event.type) {
    case 'user_input.requested': {
      const interactionId = nonEmptyStringField(payload, 'interactionId');
      const toolCallId = nonEmptyStringField(payload, 'toolCallId');
      const request = recordField(payload, 'request');
      if (!interactionId || !toolCallId || !request) return state;
      return {
        ...updateToolCall(state, toolCallId, (call) =>
          call ? { ...call, status: 'awaiting_user_input' } : call,
        ),
        interactions: asJsonObject({
          kind: 'awaiting_user_input',
          interactionId,
          toolCallId,
          request,
        }),
      };
    }
    case 'user_input.answered':
    case 'user_input.cancelled': {
      const interaction = state.interactions;
      const interactionId = nonEmptyStringField(payload, 'interactionId');
      const toolCallId = nonEmptyStringField(payload, 'toolCallId');
      return interaction.kind === 'awaiting_user_input' &&
        interaction.interactionId === interactionId &&
        interaction.toolCallId === toolCallId
        ? { ...state, interactions: { kind: 'idle' } }
        : state;
    }
    case 'plan.review_requested': {
      const interactionId = nonEmptyStringField(payload, 'interactionId');
      const toolCallId = nonEmptyStringField(payload, 'toolCallId');
      const taskId = nonEmptyStringField(payload, 'taskId');
      const planId = nonEmptyStringField(payload, 'planId');
      const version = numberField(payload, 'version');
      const structuralDigest = nonEmptyStringField(payload, 'structuralDigest');
      const task = taskId ? state.tasks[taskId] : undefined;
      const planning = task?.planning;
      const document =
        planning?.kind === 'planning_draft' || planning?.kind === 'replanning_draft'
          ? planning.document
          : undefined;
      if (
        !interactionId ||
        !toolCallId ||
        !taskId ||
        taskId !== state.activeTaskId ||
        task?.status !== 'active' ||
        !document ||
        !planId ||
        version === undefined ||
        !Number.isSafeInteger(version) ||
        version < 1 ||
        !structuralDigest ||
        document.planId !== planId ||
        document.version !== version ||
        document.structuralDigest !== structuralDigest ||
        !planTransportMatchesDocument(payload.plan, document) ||
        !state.tools.calls[toolCallId]
      ) {
        return state;
      }
      const next = updateToolCall(state, toolCallId, (call) =>
        call ? { ...call, status: 'awaiting_review' } : call,
      );
      return {
        ...next,
        tasks: {
          ...next.tasks,
          [taskId]: {
            ...next.tasks[taskId]!,
            planning: {
              kind: 'awaiting_review',
              document,
              interactionId,
              exitToolCallId: toolCallId,
            },
          },
        },
        interactions: {
          kind: 'awaiting_review',
          interactionId,
          toolCallId,
          planId: document.planId,
          version: document.version,
          structuralDigest: document.structuralDigest,
          plan: canonicalPlan(document),
          planSummary: `${document.title}\n\n${document.steps
            .map((step, index) => `${index + 1}. ${step.title}`)
            .join('\n')}`,
          ...(document.artifact ? { artifact: document.artifact } : {}),
        },
      };
    }
    case 'plan.approved': {
      if (!reviewIdentityMatches(state, payload)) return state;
      const task = state.activeTaskId ? state.tasks[state.activeTaskId] : undefined;
      const interaction = state.interactions;
      const executionMode = stringField(payload, 'executionMode');
      if (
        task?.status !== 'active' ||
        task.planning.kind !== 'awaiting_review' ||
        !interaction ||
        interaction.kind !== 'awaiting_review' ||
        (executionMode !== 'auto' && executionMode !== 'accept_edits')
      ) {
        return state;
      }
      const approvedMode = executionMode as 'auto' | 'accept_edits';
      const taskWithPlanning = {
        ...task,
        planning: {
          kind: 'executing' as const,
          document: task.planning.document,
          executionMode: approvedMode,
          approvedAtTurnId: state.turn.turnId,
        },
      };
      return {
        ...state,
        tasks: {
          ...state.tasks,
          [task.taskId]: { ...taskWithPlanning, executionMode: approvedMode },
        },
        interactions: { kind: 'idle' },
      };
    }
    case 'plan.revision_requested':
    case 'plan.review_cancelled': {
      if (!reviewIdentityMatches(state, payload)) return state;
      const task = state.activeTaskId ? state.tasks[state.activeTaskId] : undefined;
      if (task?.status !== 'active' || task.planning.kind !== 'awaiting_review') {
        return state;
      }
      const feedback =
        event.type === 'plan.revision_requested'
          ? stringField(payload, 'feedback')
          : stringField(payload, 'reason');
      if (feedback === undefined) return state;
      return {
        ...state,
        tasks: {
          ...state.tasks,
          [task.taskId]: {
            ...task,
            planning: {
              kind: 'planning_draft',
              document: task.planning.document,
              revisionFeedback: feedback,
            },
          },
        },
        interactions: { kind: 'idle' },
      };
    }
    case 'provider.action_required': {
      const interactionId = nonEmptyStringField(payload, 'interactionId');
      const providerId = nonEmptyStringField(payload, 'providerId');
      const originatingToolCallId = nonEmptyStringField(payload, 'originatingToolCallId');
      const action = payload.action;
      const call = originatingToolCallId ? state.tools.calls[originatingToolCallId] : undefined;
      if (
        state.interactions.kind !== 'idle' ||
        !interactionId ||
        !providerId ||
        !originatingToolCallId ||
        !Object.hasOwn(payload, 'action') ||
        call?.status !== 'failed'
      ) {
        return state;
      }
      const next: AgentState = {
        ...state,
        interactions: {
          kind: 'awaiting_provider_action',
          interactionId,
          providerId,
          action: action as Extract<
            AgentState['interactions'],
            { kind: 'awaiting_provider_action' }
          >['action'],
          originatingToolCallId,
          status: 'required',
        },
      };
      return next.transcript.messages.some(
        (message) => message.kind === 'tool' && message.toolCallId === originatingToolCallId,
      )
        ? next
        : appendToolTranscript(next, call);
    }
    case 'provider.action_started': {
      const interactionId = nonEmptyStringField(payload, 'interactionId');
      if (
        state.interactions.kind !== 'awaiting_provider_action' ||
        !interactionId ||
        state.interactions.interactionId !== interactionId
      ) {
        return state;
      }
      return { ...state, interactions: { ...state.interactions, status: 'started' } };
    }
    case 'provider.action_completed':
    case 'provider.action_deferred':
    case 'provider.action_failed': {
      const interactionId = nonEmptyStringField(payload, 'interactionId');
      const originatingToolCallId = nonEmptyStringField(payload, 'originatingToolCallId');
      if (
        state.interactions.kind !== 'awaiting_provider_action' ||
        !interactionId ||
        state.interactions.interactionId !== interactionId ||
        originatingToolCallId !== state.interactions.originatingToolCallId
      ) {
        return state;
      }
      const providerId = state.interactions.providerId;
      const outcome =
        event.type === 'provider.action_completed'
          ? 'completed'
          : event.type === 'provider.action_deferred'
            ? 'deferred'
            : `failed (${stringField(payload, 'failureCode') ?? ''})`;
      const failureIds = activeProviderFailureIds(state, originatingToolCallId);
      const toolRecovery =
        event.type === 'provider.action_completed' && failureIds.length > 0
          ? recordToolOwnedProgressV1(state.toolRecovery, {
              kind: 'provider_revision',
              referenceId: interactionId,
              resolvesFailureIds: failureIds,
            })
          : state.toolRecovery;
      return appendRuntimeTranscript(
        {
          ...state,
          toolRecovery,
          interactions: { kind: 'idle' },
        },
        `provider-action-${interactionId}`,
        `MCP provider '${providerId}' recovery ${outcome}.`,
      );
    }
    case 'provider.admission_required': {
      const interactionId = nonEmptyStringField(payload, 'interactionId');
      const providerId = nonEmptyStringField(payload, 'providerId');
      if (
        !interactionId ||
        !providerId ||
        (state.interactions.kind !== 'idle' &&
          state.interactions.kind !== 'awaiting_provider_admission')
      )
        return state;
      const waivers = recordField(state.providerAdmission, 'waivers') ?? {};
      if (waivers[providerId] !== undefined) return state;
      const pending = arrayField(state.providerAdmission, 'pending') ?? [];
      if (
        pending.some(
          (entry) =>
            typeof entry === 'object' &&
            entry !== null &&
            stringField(entry, 'providerId') === providerId,
        )
      ) {
        return state;
      }
      const retryable = payload.retryable;
      if (typeof retryable !== 'boolean') return state;
      const record = asJsonObject({
        interactionId,
        providerId,
        source: payload.source,
        providerStatus: payload.providerStatus,
        ...(payload.diagnosticCode ? { diagnosticCode: payload.diagnosticCode } : {}),
        retryable,
      });
      return {
        ...state,
        providerAdmission: asJsonObject({
          ...state.providerAdmission,
          pending: [...pending, record],
        }),
        interactions:
          state.interactions.kind === 'idle'
            ? asJsonObject({ kind: 'awaiting_provider_admission', ...record })
            : state.interactions,
      };
    }
    case 'provider.admission_retry_requested':
      return state;
    case 'provider.admission_retry_failed': {
      const interactionId = nonEmptyStringField(payload, 'interactionId');
      if (
        !interactionId ||
        state.interactions.kind !== 'awaiting_provider_admission' ||
        state.interactions.interactionId !== interactionId
      ) {
        return state;
      }
      const pending = (arrayField(state.providerAdmission, 'pending') ?? []).map((entry) =>
        typeof entry === 'object' &&
        entry !== null &&
        stringField(entry, 'interactionId') === interactionId
          ? asJsonObject({
              ...entry,
              providerStatus: payload.providerStatus,
              ...(payload.diagnosticCode ? { diagnosticCode: payload.diagnosticCode } : {}),
            })
          : entry,
      );
      const current = pending.find(
        (entry) =>
          typeof entry === 'object' &&
          entry !== null &&
          stringField(entry, 'interactionId') === interactionId,
      );
      if (!current) return state;
      return {
        ...state,
        providerAdmission: asJsonObject({ ...state.providerAdmission, pending }),
        interactions: asJsonObject({ kind: 'awaiting_provider_admission', ...current }),
      };
    }
    case 'provider.admission_satisfied': {
      const interactionId = nonEmptyStringField(payload, 'interactionId');
      return state.interactions.kind === 'awaiting_provider_admission' &&
        state.interactions.interactionId === interactionId
        ? settleProviderAdmission(state, interactionId)
        : state;
    }
    case 'provider.admission_cancelled': {
      const interactionId = nonEmptyStringField(payload, 'interactionId');
      const providerId = nonEmptyStringField(payload, 'providerId');
      return state.interactions.kind === 'awaiting_provider_admission' &&
        state.interactions.interactionId === interactionId &&
        state.interactions.providerId === providerId
        ? settleProviderAdmission(state, interactionId)
        : state;
    }
    case 'provider.admission_waived': {
      const interactionId = nonEmptyStringField(payload, 'interactionId');
      const providerId = nonEmptyStringField(payload, 'providerId');
      if (
        !interactionId ||
        !providerId ||
        state.interactions.kind !== 'awaiting_provider_admission' ||
        state.interactions.interactionId !== interactionId ||
        state.interactions.providerId !== providerId
      ) {
        return state;
      }
      const source = payload.source;
      const reason = payload.reason;
      const waivedAt = stringField(payload, 'waivedAt');
      if (!source || !reason || !waivedAt || !isTimestamp(waivedAt)) return state;
      const settled = settleProviderAdmission(state, interactionId, {
        providerId,
        source,
        reason,
        waivedAt,
      });
      return {
        ...settled,
        providerAdmission: asJsonObject({
          ...settled.providerAdmission,
          waivers: {
            ...recordField(settled.providerAdmission, 'waivers'),
            [providerId]: asJsonObject({ providerId, source, reason, waivedAt }),
          },
        }),
        transcript: {
          ...settled.transcript,
          messages: [
            ...settled.transcript.messages,
            {
              kind: 'runtime',
              messageId: `provider-admission-waiver-${interactionId}`,
              turnId: settled.turn.turnId,
              ordinal: settled.transcript.messages.length,
              createdAt: waivedAt,
              content:
                `Required MCP provider '${providerId}' is unavailable. ` +
                'The user waived it for this session; its capabilities remain unavailable.',
            },
          ],
        },
      };
    }
    default:
      return state;
  }
}
