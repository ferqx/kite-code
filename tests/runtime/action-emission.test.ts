import { describe, expect, test } from 'bun:test';
import type { RuntimeEvent } from '@kite/agent-kernel';
import { acceptRuntimeAction, rejectRuntimeAction } from '@kite/runtime-host';

describe('Runtime Action emission boundary', () => {
  test('a rejection cannot carry domain events', () => {
    expect(rejectRuntimeAction('stale command')).toEqual({
      ok: false,
      stdout: '',
      stderr: 'stale command',
    });
  });

  test('an accepted command preserves event order for atomic submission', () => {
    const events: RuntimeEvent[] = [
      { type: 'turn.started', turnId: 'turn-2' },
      { type: 'turn.completed', turnId: 'turn-2' },
    ];

    const emission = acceptRuntimeAction('{"ok":true}', events);

    expect(emission.ok).toBe(true);
    if (!emission.ok) throw new Error('accepted Runtime Action was rejected');
    expect(emission.runtimeEvents).toBe(events);
    expect(emission.runtimeEvents.map((event) => event.type)).toEqual([
      'turn.started',
      'turn.completed',
    ]);
  });
});
