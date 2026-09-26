import { describe, expect, test } from 'bun:test';
import type { ModelInvocationPersistence } from '@kite-ai/builtin-runtime/model';
import type { RuntimeAgentMailboxMutation } from '@kite-ai/runtime-host/storage';
import { createChildAgentMailModelInputFactory } from '../src/bootstrap/runtime/agent-mail-child-input';
import type {
  RuntimeEvent,
  RuntimeState,
  StateRuntimeStorage,
} from '../src/bootstrap/runtime/state-runtime';

const digest = `sha256:${'a'.repeat(64)}`;
const child = {
  sessionId: 'session-1',
  agentId: 'child-1',
  taskId: 'task-1',
  grantId: 'grant-1',
  grantDigest: digest,
};

function state(): RuntimeState {
  return { session: { threadId: child.sessionId } } as RuntimeState;
}

describe('child Agent mail model input', () => {
  test('binds private mail to an exact active grant and one atomic model admission', async () => {
    let inExecution = false;
    let executionScopes = 0;
    const accepted: Array<{
      events: readonly RuntimeEvent[];
      mutation: Extract<RuntimeAgentMailboxMutation, { kind: 'prepare_input' }>;
    }> = [];
    const storage = {
      agentMailbox: {
        readActiveTaskProof: () => {
          expect(inExecution).toBe(true);
          return { ownerGeneration: '4', grantDigest: digest };
        },
        readAgent: () => ({
          status: 'active',
          currentTaskId: child.taskId,
          preparedThroughSequence: 0,
        }),
      },
      agentMailInput: {
        readPendingMailForActiveTask: () => {
          expect(inExecution).toBe(true);
          return [
            {
              messageId: 'mail-1',
              sequence: 1,
              senderAgentId: 'session-1',
              sourceTaskId: null,
              bodyText: 'private instruction',
            },
          ];
        },
      },
    } as unknown as StateRuntimeStorage;
    const base: ModelInvocationPersistence<RuntimeState, RuntimeEvent> = {
      getState: state,
      persistEvents: async () => true,
    };
    const factory = createChildAgentMailModelInputFactory({
      storage,
      getState: state,
      withExecution: async (operation) => {
        executionScopes += 1;
        inExecution = true;
        try {
          return await operation();
        } finally {
          inExecution = false;
        }
      },
      persistAdmission: async ({ events, mutation }) => {
        expect(inExecution).toBe(true);
        accepted.push({ events, mutation });
        return true;
      },
    });
    const binding = factory({ ...child, persistence: base });
    expect(binding).toBeDefined();
    const prepared = await binding!.agentMail.prepareAgentMail({
      invocationId: 'model-1',
      existingMessages: [],
      childIdentity: { agentId: child.agentId, taskId: child.taskId },
    });
    expect(prepared.frames).toMatchObject([
      { kind: 'agent_message', trust: 'untrusted_agent', modelRole: 'user', messageId: 'mail-1' },
    ]);
    expect(prepared.frames[0]?.content).toContain('private instruction');
    expect(
      await binding!.modelInvocationPersistence.persistAdmission!({
        invocationId: 'model-1',
        events: [
          {
            type: 'model.invocation_prepared',
            invocationId: 'model-1',
            purpose: 'subagent',
            budget: { kind: 'reservation', reservationId: 'reserve-1' },
          } as RuntimeEvent,
        ],
        mailPreparation: { preparationId: prepared.preparationId! },
      }),
    ).toBe(true);
    expect(accepted).toHaveLength(1);
    expect(executionScopes).toBe(2);
    expect(accepted[0]!.events.at(-1)).toMatchObject({
      type: 'agent.mail_input_prepared',
      targetAgentId: child.agentId,
      modelAdmissionId: 'reserve-1',
      messageIds: ['mail-1'],
    });
    expect(accepted[0]!.mutation).toMatchObject({
      kind: 'prepare_input',
      targetAgentId: child.agentId,
      fromSequence: 0,
      throughSequence: 1,
    });
    expect(JSON.stringify(accepted)).not.toContain('private instruction');
    await expect(
      binding!.modelInvocationPersistence.persistAdmission!({
        invocationId: 'model-1',
        events: [],
        mailPreparation: { preparationId: prepared.preparationId! },
      }),
    ).rejects.toThrow('identity changed');
  });

  test('rejects a stale grant before reading a private body', async () => {
    let bodyReads = 0;
    const storage = {
      agentMailbox: {
        readActiveTaskProof: () => ({
          ownerGeneration: '4',
          grantDigest: `sha256:${'b'.repeat(64)}`,
        }),
      },
      agentMailInput: {
        readPendingMailForActiveTask: () => {
          bodyReads += 1;
          return [];
        },
      },
    } as unknown as StateRuntimeStorage;
    const binding = createChildAgentMailModelInputFactory({
      storage,
      getState: state,
      withExecution: async (operation) => operation(),
      persistAdmission: async () => true,
    })({ ...child, persistence: { getState: state, persistEvents: async () => true } });
    await expect(
      binding!.agentMail.prepareAgentMail({
        invocationId: 'model-1',
        existingMessages: [],
        childIdentity: { agentId: child.agentId, taskId: child.taskId },
      }),
    ).rejects.toThrow('grant or active task changed');
    expect(bodyReads).toBe(0);
  });
});
