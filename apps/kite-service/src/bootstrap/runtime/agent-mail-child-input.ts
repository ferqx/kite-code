import { createHash } from 'node:crypto';
import type {
  BaseMessage,
  ModelInvocationPersistence,
  ModelMailPreparationDescriptor,
} from '@kite-ai/builtin-runtime/model';
import { createAgentMessageContextFrame } from '@kite-ai/runtime-host/kernel-adapter';
import type { RuntimeAgentMailboxMutation } from '@kite-ai/runtime-host/storage';
import type { RuntimeEvent, RuntimeState, StateRuntimeStorage } from './state-runtime';

interface ChildIdentity {
  readonly sessionId: string;
  readonly agentId: string;
  readonly taskId: string;
  readonly grantId: string;
  readonly grantDigest: string;
}

interface PendingChildMailBatch {
  readonly invocationId: string;
  readonly fromSequence: number;
  readonly throughSequence: number;
  readonly messageIds: readonly string[];
}

export interface ChildAgentMailFactoryRequest extends ChildIdentity {
  readonly persistence: ModelInvocationPersistence<RuntimeState, RuntimeEvent>;
}

export interface ChildAgentMailModelInput {
  readonly agentMail: Readonly<{
    childIdentity: Readonly<{ agentId: string; taskId: string }>;
    prepareAgentMail: (request: {
      readonly invocationId: string;
      readonly existingMessages: readonly BaseMessage[];
      readonly childIdentity: Readonly<{ agentId: string; taskId: string }>;
    }) => Promise<{
      readonly frames: readonly ReturnType<typeof createAgentMessageContextFrame>[];
      readonly preparationId?: string;
    }>;
  }>;
  readonly modelInvocationPersistence: ModelInvocationPersistence<RuntimeState, RuntimeEvent>;
}

export type ChildAgentMailFactory = (
  request: ChildAgentMailFactoryRequest,
) => ChildAgentMailModelInput | undefined;

/** Creates only a bound child port. The Store proves the live task and grant at each read. */
export function createChildAgentMailModelInputFactory(input: {
  readonly storage: StateRuntimeStorage;
  readonly getState: () => Readonly<RuntimeState>;
  /** Bridge-owned enqueueSessionWork scope; private reads and admission share this fence. */
  readonly withExecution: <Result>(operation: () => Result | Promise<Result>) => Promise<Result>;
  readonly persistAdmission: (request: {
    readonly child: ChildIdentity;
    readonly events: readonly RuntimeEvent[];
    readonly mutation: Extract<RuntimeAgentMailboxMutation, { kind: 'prepare_input' }>;
  }) => Promise<boolean>;
}): ChildAgentMailFactory {
  const metadata = input.storage.agentMailbox;
  const bodies = input.storage.agentMailInput;
  if (!metadata || !bodies) return () => undefined;

  return (request) => {
    const child = Object.freeze({ ...request });
    if (
      !child.sessionId ||
      !child.agentId ||
      !child.taskId ||
      !child.grantId ||
      !/^sha256:[a-f0-9]{64}$/u.test(child.grantDigest)
    )
      throw new Error('Child Agent mail grant identity is invalid.');
    const identity = Object.freeze({ agentId: child.agentId, taskId: child.taskId });
    const pending = new Map<string, PendingChildMailBatch>();
    const assertBoundTask = () => {
      if (input.getState().session.threadId !== child.sessionId)
        throw new Error('Child Agent mail Session binding changed.');
      const proof = metadata.readActiveTaskProof(
        child.sessionId,
        child.agentId,
        child.agentId,
        child.taskId,
      );
      if (proof?.grantDigest !== child.grantDigest)
        throw new Error('Child Agent mail grant or active task changed.');
      const agent = metadata.readAgent(child.sessionId, child.agentId, child.agentId);
      if (agent?.status !== 'active' || agent.currentTaskId !== child.taskId)
        throw new Error('Child Agent mail active task changed.');
      return agent;
    };
    const agentMail: ChildAgentMailModelInput['agentMail'] = Object.freeze({
      childIdentity: identity,
      async prepareAgentMail(request) {
        return input.withExecution(async () => {
          if (
            request.childIdentity.agentId !== identity.agentId ||
            request.childIdentity.taskId !== identity.taskId ||
            !request.invocationId
          )
            throw new Error('Child Agent mail model identity changed.');
          const agent = assertBoundTask();
          const rows = bodies.readPendingMailForActiveTask({
            sessionId: child.sessionId,
            targetAgentId: child.agentId,
            currentTaskId: child.taskId,
            modelInvocationId: request.invocationId,
            fromSequence: agent.preparedThroughSequence,
          });
          if (rows.length === 0) return Object.freeze({ frames: Object.freeze([]) });
          const frames = rows.map((row) =>
            createAgentMessageContextFrame({
              messageId: row.messageId,
              senderAgentId: row.senderAgentId,
              ...(row.sourceTaskId ? { sourceTaskId: row.sourceTaskId } : {}),
              body: row.bodyText,
            }),
          );
          const messageIds = rows.map((row) => row.messageId);
          const throughSequence = rows.at(-1)!.sequence;
          const preparationId = `mailprep_${createHash('sha256')
            .update(
              JSON.stringify([
                child.sessionId,
                child.agentId,
                child.taskId,
                child.grantId,
                child.grantDigest,
                request.invocationId,
                agent.preparedThroughSequence,
                throughSequence,
                messageIds,
              ]),
            )
            .digest('hex')}`;
          pending.set(
            preparationId,
            Object.freeze({
              invocationId: request.invocationId,
              fromSequence: agent.preparedThroughSequence,
              throughSequence,
              messageIds: Object.freeze(messageIds),
            }),
          );
          return Object.freeze({ frames: Object.freeze(frames), preparationId });
        });
      },
    });
    const persistence: ModelInvocationPersistence<RuntimeState, RuntimeEvent> = Object.freeze({
      getState: () => child.persistence.getState(),
      persistEvents: (events: RuntimeEvent[]) => child.persistence.persistEvents(events),
      async persistAdmission(request: {
        readonly invocationId: string;
        readonly events: RuntimeEvent[];
        readonly mailPreparation: ModelMailPreparationDescriptor;
      }) {
        return input.withExecution(async () => {
          const batch = pending.get(request.mailPreparation.preparationId);
          const prepared = request.events.filter(
            (event): event is Extract<RuntimeEvent, { type: 'model.invocation_prepared' }> =>
              event.type === 'model.invocation_prepared',
          );
          if (
            !batch ||
            batch.invocationId !== request.invocationId ||
            prepared.length !== 1 ||
            prepared[0]?.invocationId !== request.invocationId ||
            prepared[0].purpose !== 'subagent'
          )
            throw new Error('Child Agent mail model admission identity changed.');
          assertBoundTask();
          const modelAdmissionId =
            prepared[0].budget.kind === 'reservation'
              ? prepared[0].budget.reservationId
              : request.invocationId;
          const event: Extract<RuntimeEvent, { type: 'agent.mail_input_prepared' }> = {
            type: 'agent.mail_input_prepared',
            targetAgentId: child.agentId,
            invocationId: request.invocationId,
            modelAdmissionId,
            fromSequence: batch.fromSequence,
            throughSequence: batch.throughSequence,
            messageIds: [...batch.messageIds],
          };
          const mutation: Extract<RuntimeAgentMailboxMutation, { kind: 'prepare_input' }> = {
            kind: 'prepare_input',
            targetAgentId: child.agentId,
            modelInvocationId: request.invocationId,
            modelAdmissionId,
            fromSequence: batch.fromSequence,
            throughSequence: batch.throughSequence,
            messageIds: batch.messageIds,
          };
          const accepted = await input.persistAdmission({
            child,
            events: [...request.events, event],
            mutation,
          });
          if (accepted) pending.delete(request.mailPreparation.preparationId);
          return accepted;
        });
      },
    });
    return Object.freeze({ agentMail, modelInvocationPersistence: persistence });
  };
}
