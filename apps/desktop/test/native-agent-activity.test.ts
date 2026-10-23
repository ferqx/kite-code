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

test('successful spawn history preserves its identity and name across every child lifecycle', () => {
  const { item, message, fact } = fixture();
  const project = () =>
    nativeAgentActivityForTool(nativeAgentActivities([item], 'store', 'root'), message, fact)!;
  const original = project();
  expect(original.childAgent).toEqual({
    identity: JSON.stringify(['store', 'child']),
    name: 'Grant review',
  });
  for (const status of [
    'planned',
    'dispatching',
    'running',
    'succeeded',
    'failed',
    'cancelled',
    'outcome_unknown',
  ] as const) {
    item.execution.status = status;
    expect(project()).toEqual(original);
  }
  item.execution.cancelRequested = true;
  expect(project()).toEqual(original);
  for (const status of [
    'running',
    'waiting_interaction',
    'waiting_execution',
    'cancelling',
    'completed',
    'failed',
    'cancelled',
    'interrupted',
  ] as const) {
    item.childRun!.status = status;
    item.childRun!.isActive = !['completed', 'failed', 'cancelled', 'interrupted'].includes(status);
    expect(project()).toEqual(original);
  }
  item.childRun = null;
  expect(project()).toEqual(original);
});

test('later work on the same Agent never restarts an earlier spawn or active guidance row', () => {
  const spawn = fixture();
  spawn.item.execution.status = 'succeeded';
  const followup = fixture(2, 'followup', 'task.follow_up');
  const activities = nativeAgentActivities([spawn.item, followup.item], 'store', 'root');
  const first = nativeAgentActivityForTool(activities, spawn.message, spawn.fact)!;
  const second = nativeAgentActivityForTool(activities, followup.message, followup.fact)!;
  expect(first.childAgent).toEqual({
    identity: JSON.stringify(['store', 'child']),
    name: 'Grant review',
  });
  expect(second.childAgent).toEqual(first.childAgent);
  expect(first.childAgent.identity).toBe(second.childAgent.identity);
  expect(first.executionId).not.toBe(second.executionId);
  const guidance = fixture(3, 'guidance', 'task.follow_up');
  expect(nativeAgentActivityForTool(activities, guidance.message, guidance.fact)).toBeUndefined();
  for (const definitionId of ['task.message', 'task.list', 'task.events']) {
    const other = fixture(4, 'other', definitionId);
    expect(nativeAgentActivities([other.item], 'store', 'root')).toEqual([]);
  }
});

test('an Agent activity cannot come from another run, Store, source, restored receipt or failed Tool', () => {
  const { item, message, fact } = fixture();
  const activities = nativeAgentActivities([item], 'store', 'root');
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
  expect(nativeAgentActivities([item], 'other-store', 'root')).toEqual([]);
  expect(nativeAgentActivities([item], 'store', 'other-session')).toEqual([]);
  expect(nativeAgentActivityForTool([...activities, ...activities], message, fact)).toBeUndefined();
  item.childRun!.originCommandId = 'child-start-another-carrier';
  expect(nativeAgentActivities([item], 'store', 'root')).toEqual([]);
});

test('reprojecting historical display preserves the exact operation and navigation target', () => {
  const { item, message, fact } = fixture();
  const fresh = nativeAgentActivities([item], 'store', 'root');
  const stale = nativeAgentActivities([item], 'store', 'root');
  expect(nativeAgentActivityForTool(stale, message, fact)).toEqual(fresh[0]!);
});
