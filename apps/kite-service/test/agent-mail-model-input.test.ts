import { describe, expect, test } from 'bun:test';
import type { RuntimeAgentMailboxMutation } from '@kite-ai/runtime-host/storage';
import { createRootAgentMailModelInput } from '../src/bootstrap/runtime/agent-mail-model-input';
import type {
  RuntimeEvent,
  RuntimeState,
  StateRuntimeStorage,
} from '../src/bootstrap/runtime/state-runtime';

function activeState(): RuntimeState {
  return {
    session: { threadId: 'session-1' },
    turn: { status: 'active' },
  } as RuntimeState;
}

describe('root Agent mail model input', () => {
  test('leaves the ordinary Model path untouched when no mail is pending', () => {
    const storage = {
      agentMailbox: {
        readAgent: () => ({ status: 'active', currentTaskId: 'run-1', unreadCount: 0 }),
      },
      agentMailInput: { readPendingMailForActiveTask: () => [] },
    } as unknown as StateRuntimeStorage;
    expect(
      createRootAgentMailModelInput({
        storage,
        getState: activeState,
        currentRunId: () => 'run-1',
        persistAdmission: async () => true,
      }),
    ).toBeUndefined();
  });

  test('binds one private body to a single exact model admission without placing it in events', async () => {
    const admission: Array<{
      events: readonly RuntimeEvent[];
      mutation: Extract<RuntimeAgentMailboxMutation, { kind: 'prepare_input' }>;
    }> = [];
    const storage = {
      agentMailbox: {
        readAgent: () => ({
          status: 'active',
          currentTaskId: 'run-1',
          unreadCount: 1,
          preparedThroughSequence: 0,
        }),
      },
      agentMailInput: {
        readPendingMailForActiveTask: () => [
          {
            messageId: 'mail-1',
            sequence: 1,
            senderAgentId: 'child-1',
            sourceTaskId: 'task-1',
            bodyText: 'private reply',
            mode: 'reply',
          },
        ],
      },
    } as unknown as StateRuntimeStorage;
    const binding = createRootAgentMailModelInput({
      storage,
      getState: activeState,
      currentRunId: () => 'run-1',
      persistAdmission: async (input) => {
        admission.push(input);
        return true;
      },
    });
    expect(binding).toBeDefined();
    const prepared = await binding!.prepareAgentMail({
      invocationId: 'model-1',
      existingMessages: [],
    });
    expect(prepared.frames).toHaveLength(1);
    expect(prepared.frames[0]).toMatchObject({
      type: 'human',
      name: 'agent_message',
      response_metadata: { source: 'agent_message' },
    });
    expect(String(prepared.frames[0]!.content)).toContain('private reply');
    const modelPrepared = {
      type: 'model.invocation_prepared',
      invocationId: 'model-1',
      budget: { kind: 'no_budget', reason: 'resource_budget_disabled' },
    } as RuntimeEvent;
    expect(
      await binding!.persistAdmission({
        invocationId: 'model-1',
        events: [modelPrepared],
        mailPreparation: { preparationId: prepared.preparationId! },
      }),
    ).toBe(true);
    expect(admission).toHaveLength(1);
    expect(admission[0]!.events.at(-1)).toMatchObject({
      type: 'agent.mail_input_prepared',
      invocationId: 'model-1',
      modelAdmissionId: 'model-1',
      messageIds: ['mail-1'],
    });
    expect(admission[0]!.mutation).toMatchObject({
      kind: 'prepare_input',
      modelInvocationId: 'model-1',
      fromSequence: 0,
      throughSequence: 1,
      messageIds: ['mail-1'],
    });
    expect(JSON.stringify(admission)).not.toContain('private reply');
  });
});
