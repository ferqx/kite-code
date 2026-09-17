import { describe, expect, test } from 'bun:test';
import type { RuntimeEvent } from '@kite-ai/agent-kernel';
import { persistSettledSiblingTerminalEvents } from '../../../src/bootstrap/runtime/runtime-tool-effect';

const completedChild: RuntimeEvent = {
  type: 'subagent.completed',
  subagent: { id: 'child-a', summary: 'Finished.', toolCallCount: 0, durationMs: 1 },
};

describe('parallel child terminal persistence', () => {
  test('acknowledges a completed child while its sibling is still running', async () => {
    let unblockSecond!: () => void;
    const second = new Promise<RuntimeEvent[]>((resolve) => {
      unblockSecond = () => resolve([]);
    });
    const durable: RuntimeEvent[][] = [];
    let allSettled = false;
    const all = Promise.allSettled([
      persistSettledSiblingTerminalEvents('parent-a', [completedChild], async (events) => {
        durable.push(events);
        return true;
      }),
      second.then((events) =>
        persistSettledSiblingTerminalEvents('parent-b', events, async () => true),
      ),
    ]).then((result) => {
      allSettled = true;
      return result;
    });
    try {
      await Promise.resolve();
      expect(durable).toEqual([[completedChild]]);
      expect(allSettled).toBe(false);
    } finally {
      unblockSecond();
    }
    expect(await all).toEqual([
      { status: 'fulfilled', value: [] },
      { status: 'fulfilled', value: [] },
    ]);
  });

  test('does not flush a child before a terminal fact and fails closed on missing acknowledgement', async () => {
    const partial: RuntimeEvent[] = [
      {
        type: 'subagent.step',
        subagent: {
          id: 'child-a',
          stepId: 'step-a',
          toolCallId: 'model-call-a',
          toolName: 'search_files',
          toolArgs: {},
        },
      },
    ];
    let writes = 0;
    expect(
      await persistSettledSiblingTerminalEvents('parent-a', partial, async () => {
        writes++;
        return true;
      }),
    ).toEqual(partial);
    expect(writes).toBe(0);
    await expect(
      persistSettledSiblingTerminalEvents('parent-a', [completedChild], async () => false),
    ).rejects.toThrow('could not persist its terminal facts');
    await expect(
      persistSettledSiblingTerminalEvents('parent-a', [completedChild], async () => {
        throw new Error('storage offline');
      }),
    ).rejects.toThrow('could not persist its terminal facts');
  });

  test('writes child completion and an uncommitted parent terminal in the same batch', async () => {
    const parentTerminal: RuntimeEvent = {
      type: 'tool.finished',
      toolCallId: 'parent-a',
      name: 'task',
      result: { ok: true, command: '', exitCode: 0, stdout: '', stderr: '' },
    };
    const committed: RuntimeEvent[][] = [];
    expect(
      await persistSettledSiblingTerminalEvents(
        'parent-a',
        [completedChild, parentTerminal],
        async (events) => {
          committed.push(events);
          return true;
        },
      ),
    ).toEqual([]);
    expect(committed).toEqual([[completedChild, parentTerminal]]);
  });
});
