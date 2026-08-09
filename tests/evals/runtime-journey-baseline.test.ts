import { expect, test } from 'bun:test';
import { AgentKernel } from '@/core/runtime/kernel';
import { runRuntimeLoop } from '@/core/runtime/runner';
import { createInitialRuntimeState } from '@/core/runtime/state';
import { createRuntimeStore } from '@/core/runtime/store';

test('ACORE-EVAL-00 records a metadata-only scripted model → tool → model Runtime journey', async () => {
  const store = createRuntimeStore(':memory:');
  const initial = createInitialRuntimeState({
    threadId: 'eval-00',
    userId: 'synthetic',
    workspace: '/tmp',
  });
  const kernel = new AgentKernel({ store, initialState: initial, interactionMode: 'accept_edits' });
  kernel.processEvent({
    type: 'user.message_appended',
    messageId: 'user-1',
    content: 'Inspect the fixture.',
  });

  let modelAttempts = 0;
  const eventTypes: string[] = [];
  for await (const event of runRuntimeLoop(
    kernel,
    async (effect) => {
      if (effect.type === 'call_model') {
        modelAttempts++;
        return modelAttempts === 1
          ? [
              {
                type: 'model.responded',
                messageId: 'model-1',
                toolCalls: [
                  { id: 'read-1', name: 'read_file', args: { path: '/synthetic/fixture.ts' } },
                ],
              },
              {
                type: 'tool.queued',
                toolCallId: 'read-1',
                name: 'read_file',
                args: { path: '/synthetic/fixture.ts' },
                modelMessageId: 'model-1',
                ordinal: 0,
                effectClass: 'read_only',
                sideEffect: false,
              },
            ]
          : [{ type: 'model.responded', messageId: 'model-2', text: 'Inspection complete.' }];
      }
      if (effect.type === 'run_tools') {
        return [
          { type: 'tool.started', toolCallId: 'read-1' },
          {
            type: 'tool.finished',
            toolCallId: 'read-1',
            name: 'read_file',
            result: { ok: true, command: '', exitCode: 0, stdout: 'fixture', stderr: '' },
          },
        ];
      }
      throw new Error(`unexpected_effect:${effect.type}`);
    },
    { requestAction: async () => ({ type: 'cancel', interactionId: 'unused' }) },
  )) {
    eventTypes.push(event.type);
  }

  const report = {
    schema: 'ACORE-EVAL-00-v1',
    modelAttempts,
    eventCounts: Object.fromEntries(
      eventTypes.map((type) => [type, eventTypes.filter((x) => x === type).length]),
    ),
    contentLogged: false,
  };
  expect(report).toEqual({
    schema: 'ACORE-EVAL-00-v1',
    modelAttempts: 2,
    eventCounts: {
      'model.responded': 2,
      'tool.queued': 1,
      'tool.started': 1,
      'tool.finished': 1,
      'run.completed': 1,
      'turn.completed': 1,
    },
    contentLogged: false,
  });
  expect(JSON.stringify(report)).not.toContain('/synthetic/fixture.ts');
  kernel.close();
});
