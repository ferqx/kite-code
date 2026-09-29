import { createHash } from 'node:crypto';
import type { ModelMailPreparationDescriptor } from '@kite-ai/builtin-runtime/model';
import { type BaseMessage, humanMessage } from '@kite-ai/builtin-runtime/model';
import { createAgentMessageContextFrame } from '@kite-ai/runtime-host/kernel-adapter';
import type { RuntimeAgentMailboxMutation } from '@kite-ai/runtime-host/storage';
import type { RuntimeEvent, RuntimeState, StateRuntimeStorage } from './state-runtime';

interface PendingRootMailBatch {
  readonly invocationId: string;
  readonly runId: string;
  readonly fromSequence: number;
  readonly throughSequence: number;
  readonly messageIds: readonly string[];
}

export interface CrossSessionQueueMailModelPort {
  readPendingForModel(input: {
    readonly targetSessionId: string;
    readonly targetTaskId: string;
    readonly modelInvocationId: string;
  }): Readonly<{
    fromSequence: number;
    rows: readonly Readonly<{
      messageId: string;
      sequence: number;
      sourceSessionId: string;
      sourceTaskId?: string | null;
      bodyText: string;
    }>[];
  }>;
  persistPreparedInput(input: {
    readonly targetSessionId: string;
    readonly targetTaskId: string;
    readonly invocationId: string;
    readonly modelAdmissionId: string;
    readonly fromSequence: number;
    readonly throughSequence: number;
    readonly messageIds: readonly string[];
    readonly events: readonly RuntimeEvent[];
  }): Promise<boolean>;
}

/** Private cross-Session inbox bodies become model frames only for an exact active Run. */
export function createCrossSessionRootAgentMailModelInput(input: {
  readonly storage: CrossSessionQueueMailModelPort;
  readonly getState: () => Readonly<RuntimeState>;
  readonly currentRunId: () => string | null;
}): {
  readonly prepareAgentMail: (request: {
    readonly invocationId: string;
    readonly existingMessages: readonly BaseMessage[];
  }) => Promise<Readonly<{ frames: readonly BaseMessage[]; preparationId?: string }>>;
  readonly persistAdmission: (request: {
    readonly invocationId: string;
    readonly events: RuntimeEvent[];
    readonly mailPreparation: ModelMailPreparationDescriptor;
  }) => Promise<boolean>;
} {
  const pending = new Map<string, PendingRootMailBatch>();
  return Object.freeze({
    async prepareAgentMail(request) {
      const state = input.getState();
      const sessionId = state.session.threadId;
      const runId = input.currentRunId();
      if (!runId || !request.invocationId || state.turn.status !== 'active')
        throw new Error('Cross-Session Agent mail input has no active model execution.');
      const batch = input.storage.readPendingForModel({
        targetSessionId: sessionId,
        targetTaskId: runId,
        modelInvocationId: request.invocationId,
      });
      if (batch.rows.length === 0) return Object.freeze({ frames: Object.freeze([]) });
      if (
        !Number.isSafeInteger(batch.fromSequence) ||
        batch.fromSequence < 0 ||
        batch.rows.some((row, index) =>
          index === 0
            ? row.sequence <= batch.fromSequence
            : row.sequence <= batch.rows[index - 1]!.sequence,
        )
      )
        throw new Error('Cross-Session Agent mail input sequence is invalid.');
      const messageIds = batch.rows.map((row) => row.messageId);
      const throughSequence = batch.rows.at(-1)!.sequence;
      const frames = batch.rows.map((row) => {
        const frame = createAgentMessageContextFrame({
          messageId: row.messageId,
          senderAgentId: row.sourceSessionId,
          ...(row.sourceTaskId ? { sourceTaskId: row.sourceTaskId } : {}),
          body: row.bodyText,
        });
        return humanMessage({
          id: frame.messageId,
          name: 'agent_message',
          content: frame.content,
          response_metadata: { source: 'agent_message' },
        });
      });
      const preparationId = `mailprep_${createHash('sha256')
        .update(
          JSON.stringify([
            sessionId,
            runId,
            request.invocationId,
            batch.fromSequence,
            throughSequence,
            messageIds,
          ]),
        )
        .digest('hex')}`;
      pending.set(
        preparationId,
        Object.freeze({
          invocationId: request.invocationId,
          runId,
          fromSequence: batch.fromSequence,
          throughSequence,
          messageIds: Object.freeze(messageIds),
        }),
      );
      return Object.freeze({ frames: Object.freeze(frames), preparationId });
    },
    async persistAdmission(request) {
      const batch = pending.get(request.mailPreparation.preparationId);
      const prepared = request.events.filter(
        (event): event is Extract<RuntimeEvent, { type: 'model.invocation_prepared' }> =>
          event.type === 'model.invocation_prepared',
      );
      if (
        !batch ||
        prepared.length !== 1 ||
        batch.invocationId !== request.invocationId ||
        prepared[0]?.invocationId !== request.invocationId ||
        input.currentRunId() !== batch.runId
      )
        throw new Error('Cross-Session Agent mail model admission identity changed.');
      const modelAdmissionId =
        prepared[0].budget.kind === 'reservation'
          ? prepared[0].budget.reservationId
          : request.invocationId;
      const sessionId = input.getState().session.threadId;
      const event: Extract<RuntimeEvent, { type: 'agent.mail_input_prepared' }> = {
        type: 'agent.mail_input_prepared',
        targetAgentId: sessionId,
        invocationId: request.invocationId,
        modelAdmissionId,
        fromSequence: batch.fromSequence,
        throughSequence: batch.throughSequence,
        messageIds: [...batch.messageIds],
      };
      const accepted = await input.storage.persistPreparedInput({
        targetSessionId: sessionId,
        targetTaskId: batch.runId,
        invocationId: request.invocationId,
        modelAdmissionId,
        fromSequence: batch.fromSequence,
        throughSequence: batch.throughSequence,
        messageIds: batch.messageIds,
        events: [...request.events, event],
      });
      if (accepted) pending.delete(request.mailPreparation.preparationId);
      return accepted;
    },
  });
}

/** Private bodies are read only inside the Store's active execution scope. */
export function createRootAgentMailModelInput(input: {
  readonly storage: StateRuntimeStorage;
  readonly getState: () => Readonly<RuntimeState>;
  readonly currentRunId: () => string | null;
  readonly persistAdmission: (input: {
    readonly events: readonly RuntimeEvent[];
    readonly mutation: Extract<RuntimeAgentMailboxMutation, { kind: 'prepare_input' }>;
  }) => Promise<boolean>;
}):
  | {
      readonly prepareAgentMail: (request: {
        readonly invocationId: string;
        readonly existingMessages: readonly BaseMessage[];
      }) => Promise<Readonly<{ frames: readonly BaseMessage[]; preparationId?: string }>>;
      readonly persistAdmission: (request: {
        readonly invocationId: string;
        readonly events: RuntimeEvent[];
        readonly mailPreparation: ModelMailPreparationDescriptor;
      }) => Promise<boolean>;
    }
  | undefined {
  const metadata = input.storage.agentMailbox;
  const bodies = input.storage.agentMailInput;
  if (!metadata || !bodies) return undefined;
  const initialState = input.getState();
  const initialRunId = input.currentRunId();
  if (!initialRunId) return undefined;
  const initialRoot = metadata.readAgent(
    initialState.session.threadId,
    initialState.session.threadId,
    initialState.session.threadId,
  );
  if (
    initialRoot?.status !== 'active' ||
    initialRoot.currentTaskId !== initialRunId ||
    initialRoot.unreadCount === 0
  )
    return undefined;
  const pending = new Map<string, PendingRootMailBatch>();
  return Object.freeze({
    async prepareAgentMail(request: {
      readonly invocationId: string;
      readonly existingMessages: readonly BaseMessage[];
    }) {
      const state = input.getState();
      const sessionId = state.session.threadId;
      const runId = input.currentRunId();
      if (!runId || state.turn.status !== 'active' || !request.invocationId)
        throw new Error('Root Agent mail input has no active model execution.');
      const root = metadata.readAgent(sessionId, sessionId, sessionId);
      if (root?.status !== 'active' || root.currentTaskId !== runId)
        throw new Error('Root Agent mail input task binding is stale.');
      const rows = bodies.readPendingMailForActiveTask({
        sessionId,
        targetAgentId: sessionId,
        currentTaskId: runId,
        modelInvocationId: request.invocationId,
        fromSequence: root.preparedThroughSequence,
      });
      if (rows.length === 0) return Object.freeze({ frames: Object.freeze([]) });
      const frames = rows.map((row) => {
        const frame = createAgentMessageContextFrame({
          messageId: row.messageId,
          senderAgentId: row.senderAgentId,
          ...(row.sourceTaskId ? { sourceTaskId: row.sourceTaskId } : {}),
          body: row.bodyText,
        });
        return humanMessage({
          id: frame.messageId,
          name: 'agent_message',
          content: frame.content,
          response_metadata: { source: 'agent_message' },
        });
      });
      const messageIds = rows.map((row) => row.messageId);
      const throughSequence = rows.at(-1)!.sequence;
      const preparationId = `mailprep_${createHash('sha256')
        .update(
          JSON.stringify([
            sessionId,
            runId,
            request.invocationId,
            root.preparedThroughSequence,
            throughSequence,
            messageIds,
          ]),
        )
        .digest('hex')}`;
      pending.set(
        preparationId,
        Object.freeze({
          invocationId: request.invocationId,
          runId,
          fromSequence: root.preparedThroughSequence,
          throughSequence,
          messageIds: Object.freeze(messageIds),
        }),
      );
      return Object.freeze({ frames: Object.freeze(frames), preparationId });
    },
    async persistAdmission(request: {
      readonly invocationId: string;
      readonly events: RuntimeEvent[];
      readonly mailPreparation: ModelMailPreparationDescriptor;
    }) {
      const batch = pending.get(request.mailPreparation.preparationId);
      const prepared = request.events.find(
        (event): event is Extract<RuntimeEvent, { type: 'model.invocation_prepared' }> =>
          event.type === 'model.invocation_prepared',
      );
      if (
        !batch ||
        !prepared ||
        batch.invocationId !== request.invocationId ||
        prepared.invocationId !== request.invocationId ||
        input.currentRunId() !== batch.runId
      )
        throw new Error('Root Agent mail model admission identity changed.');
      const modelAdmissionId =
        prepared.budget.kind === 'reservation'
          ? prepared.budget.reservationId
          : request.invocationId;
      const sessionId = input.getState().session.threadId;
      const event: Extract<RuntimeEvent, { type: 'agent.mail_input_prepared' }> = {
        type: 'agent.mail_input_prepared',
        targetAgentId: sessionId,
        invocationId: request.invocationId,
        modelAdmissionId,
        fromSequence: batch.fromSequence,
        throughSequence: batch.throughSequence,
        messageIds: [...batch.messageIds],
      };
      const mutation: Extract<RuntimeAgentMailboxMutation, { kind: 'prepare_input' }> = {
        kind: 'prepare_input',
        targetAgentId: sessionId,
        modelInvocationId: request.invocationId,
        modelAdmissionId,
        fromSequence: batch.fromSequence,
        throughSequence: batch.throughSequence,
        messageIds: batch.messageIds,
      };
      const accepted = await input.persistAdmission({
        events: [...request.events, event],
        mutation,
      });
      if (accepted) pending.delete(request.mailPreparation.preparationId);
      return accepted;
    },
  });
}
