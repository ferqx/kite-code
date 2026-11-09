import { expect, test } from 'bun:test';
import type { ToolScope } from '../../../src/execution';
import type { ToolContext } from '../../../src/extensions';
import { ExtensionHost, type ExtensionHostOptions } from '../../../src/extensions/host';
import { createTaskExtension } from '../../../src/extensions/task';
import type { Store } from '../../../src/storage/port';

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
