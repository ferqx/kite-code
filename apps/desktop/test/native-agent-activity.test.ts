import { expect, test } from 'bun:test';
import type { Message } from '@kite-ai/client';
import { nativeAgentActivities, nativeAgentActivityForTool } from '../src/native-agent-activity';
import type { NativeToolMessageFact } from '../src/tool-messages-bridge';
import { backgroundItem } from './background-item.fixture';

function fixture(id = 1, toolId = 'spawn', definitionId = 'task.spawn') {
  const item = backgroundItem(id, true);
  item.sourceTool = { id: toolId, definitionId, definitionVersion: '1' };
  item.execution.parentExecutionId = toolId;
  item.childSession!.title = 'Grant review';
  const message: Message = {
    id: `receipt-${toolId}`,
    sessionId: 'root',
    runId: 'parent-run',
    role: 'tool',
    seq: '2',
    status: 'complete',
    content: 'accepted: queued',
    sourceIds: [toolId],
  };
  const fact: NativeToolMessageFact = {
    messageId: message.id,
    executionId: toolId,
    definitionId,
    definitionVersion: '1',
    status: 'succeeded',
    resultRevision: '1',
  };
  return { item, message, fact };
}

test('accepted spawn waits for its exact child activation and carrier outcome', () => {
  const { item, message, fact } = fixture();
  const project = () =>
    nativeAgentActivityForTool(
      nativeAgentActivities([item], 'store', 'root', true),
      message,
      fact,
    )!;
  item.execution.status = 'planned';
  item.childRun = null;
  expect(project().childAgent).toMatchObject({ name: 'Grant review', status: 'queued' });
  item.execution.status = 'running';
  expect(project().childAgent.status).toBe('starting');
  item.childRun = fixture().item.childRun;
  expect(project().childAgent.status).toBe('running');
  item.childRun!.status = 'waiting_interaction';
  expect(project().childAgent.status).toBe('waiting');
  item.childRun!.status = 'waiting_execution';
  expect(project().childAgent.status).toBe('waiting_results');
  for (const status of ['completed', 'failed', 'cancelled', 'interrupted'] as const) {
    item.childRun!.status = status;
    item.childRun!.isActive = false;
    expect(project().childAgent.status).toBe('waiting_results');
  }
  item.execution.cancelRequested = true;
  expect(project().childAgent.status).toBe('stopping');
  item.execution.status = 'succeeded';
  expect(project().childAgent.status).toBe('completed');
  item.execution.status = 'failed';
  expect(project().childAgent.status).toBe('failed');
  item.execution.status = 'outcome_unknown';
  expect(project().childAgent.status).toBe('unknown');
  item.execution.status = 'cancelled';
  expect(project().childAgent.status).toBe('cancelled');
});

test('later work on the same Agent never restarts an earlier spawn or active guidance row', () => {
  const spawn = fixture();
  spawn.item.execution.status = 'succeeded';
  const followup = fixture(2, 'followup', 'task.follow_up');
  const activities = nativeAgentActivities([spawn.item, followup.item], 'store', 'root', true);
  const first = nativeAgentActivityForTool(activities, spawn.message, spawn.fact)!;
  const second = nativeAgentActivityForTool(activities, followup.message, followup.fact)!;
  expect(first.childAgent.status).toBe('completed');
  expect(second.childAgent.status).toBe('running');
  expect(first.childAgent.identity).toBe(second.childAgent.identity);
  expect(first.executionId).not.toBe(second.executionId);
  const guidance = fixture(3, 'guidance', 'task.follow_up');
  expect(nativeAgentActivityForTool(activities, guidance.message, guidance.fact)).toBeUndefined();
  for (const definitionId of ['task.message', 'task.list', 'task.events']) {
    const other = fixture(4, 'other', definitionId);
    expect(nativeAgentActivities([other.item], 'store', 'root', true)).toEqual([]);
  }
});

test('an Agent activity cannot come from another run, Store, source, restored receipt or failed Tool', () => {
  const { item, message, fact } = fixture();
  const activities = nativeAgentActivities([item], 'store', 'root', true);
  expect(
    nativeAgentActivityForTool(activities, { ...message, runId: 'later-run' }, fact),
  ).toBeUndefined();
  expect(
    nativeAgentActivityForTool(activities, { ...message, sourceIds: ['unrelated'] }, fact),
  ).toBeUndefined();
  expect(
    nativeAgentActivityForTool(activities, message, { ...fact, status: 'failed' }),
  ).toBeUndefined();
  expect(
    nativeAgentActivityForTool(activities, message, { ...fact, definitionVersion: '9' }),
  ).toBeUndefined();
  expect(
    nativeAgentActivityForTool(
      activities,
      {
        ...message,
        originMessage: {
          storeId: 'old-store',
          sessionId: 'root',
          runId: 'parent-run',
          messageId: 'old',
        },
      },
      fact,
    ),
  ).toBeUndefined();
  expect(nativeAgentActivities([item], 'other-store', 'root', true)).toEqual([]);
  expect(nativeAgentActivities([item], 'store', 'other-session', true)).toEqual([]);
  expect(nativeAgentActivityForTool([...activities, ...activities], message, fact)).toBeUndefined();
  item.childRun!.originCommandId = 'child-start-another-carrier';
  expect(nativeAgentActivities([item], 'store', 'root', true)).toEqual([]);
});

test('cached display retains the observed start and stable target without claiming fresh execution', () => {
  const { item, message, fact } = fixture();
  const fresh = nativeAgentActivities([item], 'store', 'root', true);
  const stale = nativeAgentActivities([item], 'store', 'root', false);
  expect(nativeAgentActivityForTool(stale, message, fact)).toEqual({
    ...fresh[0]!,
    childAgent: { ...fresh[0]!.childAgent, fresh: false },
  });
});
