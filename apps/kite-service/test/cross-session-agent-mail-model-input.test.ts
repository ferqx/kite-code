import { expect, test } from 'bun:test';
import {
  type CrossSessionQueueMailModelPort,
  createCrossSessionRootAgentMailModelInput,
} from '../src/bootstrap/runtime/agent-mail-model-input';
import type { RuntimeEvent, RuntimeState } from '../src/bootstrap/runtime/state-runtime';

test('cross-Session inbox body enters one exact model admission and stays out of State events', async () => {
  const admitted: Parameters<CrossSessionQueueMailModelPort['persistPreparedInput']>[0][] = [];
  const storage: CrossSessionQueueMailModelPort = {
    readPendingForModel: () => ({
      fromSequence: 0,
      rows: [
        { messageId: 'mail-1', sequence: 1, sourceSessionId: 'child', bodyText: 'private reply' },
      ],
    }),
    async persistPreparedInput(input) {
      admitted.push(input);
      return true;
    },
  };
  const state = {
    session: { threadId: 'parent' },
    turn: { status: 'active' },
  } as RuntimeState;
  const binding = createCrossSessionRootAgentMailModelInput({
    storage,
    getState: () => state,
    currentRunId: () => 'run-1',
  });
  const prepared = await binding.prepareAgentMail({
    invocationId: 'model-1',
    existingMessages: [],
  });
  expect(prepared.frames).toHaveLength(1);
  expect(String(prepared.frames[0]!.content)).toContain('private reply');
  const modelPrepared = {
    type: 'model.invocation_prepared',
    invocationId: 'model-1',
    budget: { kind: 'no_budget', reason: 'resource_budget_disabled' },
  } as RuntimeEvent;
  expect(
    await binding.persistAdmission({
      invocationId: 'model-1',
      events: [modelPrepared],
      mailPreparation: { preparationId: prepared.preparationId! },
    }),
  ).toBe(true);
  expect(admitted).toHaveLength(1);
  expect(admitted[0]).toMatchObject({
    targetSessionId: 'parent',
    targetTaskId: 'run-1',
    invocationId: 'model-1',
    modelAdmissionId: 'model-1',
    fromSequence: 0,
    throughSequence: 1,
    messageIds: ['mail-1'],
  });
  expect(admitted[0]!.events.at(-1)).toMatchObject({
    type: 'agent.mail_input_prepared',
    targetAgentId: 'parent',
    messageIds: ['mail-1'],
  });
  expect(JSON.stringify(admitted)).not.toContain('private reply');
});
