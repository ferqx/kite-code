import { expect, test } from 'bun:test';
import type { ToolScope } from '../../../src/execution';
import type { ToolContext } from '../../../src/extensions';
import { ExtensionHost, type ExtensionHostOptions } from '../../../src/extensions/host';
import { createTaskExtension } from '../../../src/extensions/task';
import { modelCursor } from '../../../src/model-cursor';
import type { Store } from '../../../src/storage/port';
import { AgentError } from '../../../src/storage/types';

test('Agent waits keep managed positions private and accept explicit positions from old calls', async () => {
  const extension = createTaskExtension({
    roles: [{ id: 'worker', configurationId: 'worker', description: 'Worker' }],
  });
  const definition = extension.tools!.find((tool) => tool.id === 'task.events')!;
  const reads: (string | undefined)[] = [];
  const context = {
    sessionId: 'root',
    operations: {
      async waitAgentEvents(options: { afterSeq?: string }) {
        reads.push(options.afterSeq);
        if (options.afterSeq === '0') throw new AgentError('cursor_expired', '41');
        return {
          reason: 'timeout',
          nextSeq: options.afterSeq === '9007199254740993' ? options.afterSeq : '42',
          events: [],
          ...(options.afterSeq === undefined
            ? { observation: { scope: '[]', nextSeq: '42' }, historyGap: true }
            : {}),
        };
      },
    },
  } as unknown as ToolContext;
  const initial = await definition.execute({}, context);
  expect(JSON.parse(initial.content)).toEqual({ reason: 'timeout', events: [], history_gap: true });
  expect(initial.details).toMatchObject({ agentEventObservation: { scope: '[]', nextSeq: '42' } });
  const legacy = modelCursor({ kind: 'agent_events', sessionId: 'root' }, '42');
  for (const cursor of [
    legacy.slice(0, -1),
    '042',
    '-1',
    modelCursor({ kind: 'agent_events', sessionId: 'other' }, '42'),
  ]) {
    const rejected = await definition.execute({ cursor }, context);
    expect(rejected.outcome).toBe('failed');
    expect(JSON.parse(rejected.content).error).toMatchObject({
      code: 'invalid_cursor',
      message: expect.stringContaining('Reuse the last valid next_cursor'),
      next_action: 'restart_observation',
    });
  }
  expect(reads).toEqual([undefined]);
  const expired = await definition.execute({ cursor: '0' }, context);
  expect(expired.outcome).toBe('failed');
  const recovery = JSON.parse(expired.content);
  expect(recovery).toMatchObject({
    resume_after_seq: '41',
    error: {
      code: 'cursor_expired',
      message: expect.stringContaining('resume_after_seq as cursor'),
    },
  });
  for (const cursor of ['42', legacy, recovery.resume_after_seq]) {
    const resumed = await definition.execute({ cursor }, context);
    expect(resumed.outcome).toBe('succeeded');
    expect(JSON.parse(resumed.content).next_cursor).toBe('42');
  }
  expect(reads).toEqual([undefined, '0', '42', '42', '41']);
  const large = '9007199254740993';
  expect(
    JSON.parse((await definition.execute({ cursor: large }, context)).content).next_cursor,
  ).toBe(large);
  expect(reads.at(-1)).toBe(large);
});

for (const active of [true, false])
  test(`mailbox wait reads beyond 100 idle collaborators when the last child is ${active ? 'running' : 'idle'}`, async () => {
    const extension = createTaskExtension({
      roles: [{ id: 'worker', configurationId: 'worker', description: 'Worker' }],
    });
    const definition = extension.tools!.find((tool) => tool.id === 'task.events')!;
    const reads: Parameters<Store['listStableAgents']>[0][] = [];
    let waits = 0;
    const store = {
      async getExecution() {
        return { runId: null };
      },
      async getMetadata() {
        return { lastChangeCursor: '101' };
      },
      async getSession() {
        return { parentSessionId: null, deletedAt: null };
      },
      async readHumanWorkState() {
        return null;
      },
      async listAgentEvents() {
        return {
          events: waits
            ? [{ seq: '102', agentId: 'child-101', kind: 'completed', summary: 'Done' }]
            : [],
          nextSeq: waits ? '102' : '101',
        };
      },
      async listStableAgents(input: Parameters<Store['listStableAgents']>[0]) {
        reads.push(input);
        // The real Store defaults to 100 entries and anchors each child at first creation.
        const after = Number(input.afterSeq ?? '0');
        const upper = Number(input.upperSeq ?? '101');
        const limit = input.limit ?? 100;
        const items = Array.from({ length: 101 }, (_, index) => ({
          agentId: `child-${index + 1}`,
          seq: String(index + 1),
          state: active && index === 100 ? 'running' : 'idle',
        })).filter((item) => Number(item.seq) > after && Number(item.seq) <= upper);
        return {
          items: items.slice(0, limit),
          upperSeq: String(upper),
          nextAfterSeq: items.length > limit ? items[limit - 1]!.seq : null,
        };
      },
    };
    const host = new ExtensionHost({
      store,
      extensions: [extension],
      tools: new Map(),
      execution: { interactionRequesterWithReceipt: () => async () => undefined },
      async waitForChange() {
        waits++;
        return [{ cursor: '102', sessionId: 'root', type: 'execution.completed' }];
      },
    } as unknown as ExtensionHostOptions);
    const scope = {
      command: { sessionId: 'root', subjectId: 'owner', originStoreId: 'store' },
      signal: new AbortController().signal,
      requirements: [],
    } as unknown as ToolScope;
    const context = await host.toolContext(scope, definition, 'wait', {});
    const result = await definition.execute({ waitMs: 10000 }, context as ToolContext);
    const body = JSON.parse(result.content);
    expect(reads).toHaveLength(2);
    expect(reads[1]).toMatchObject({ afterSeq: '100', upperSeq: '101' });
    expect(body.reason).toBe(active ? 'events' : 'completed');
    expect(waits).toBe(active ? 1 : 0);
    expect(body.events).toHaveLength(active ? 1 : 0);
    if (active) expect(body.events[0]).toMatchObject({ agent_id: 'child-101', kind: 'completed' });
  });
