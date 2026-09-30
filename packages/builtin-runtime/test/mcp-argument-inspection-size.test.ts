import { describe, expect, test } from 'bun:test';
import { inspectMcpArguments, snapshotMcpArguments } from '../src/mcp/argument-inspection';

describe('MCP argument inspection', () => {
  test('inspects all large and deeply nested JSON arguments', () => {
    let nested: Record<string, unknown> = { value: 'clear' };
    for (let index = 0; index < 40; index += 1) nested = { child: nested };
    const args = {
      body: 'x'.repeat(1_000_001),
      entries: Array.from({ length: 4_100 }, (_, index) => ({ index })),
      nested,
    };
    const snapshot = snapshotMcpArguments(args);
    expect(snapshot.ok).toBe(true);
    if (!snapshot.ok) throw new Error('Expected immutable MCP argument snapshot.');
    expect(inspectMcpArguments(snapshot.arguments)).toBe('clear');
    expect(Object.isFrozen(snapshot.arguments)).toBe(true);

    const hiddenSecret = { ...args, entries: [...args.entries, { password: 'sensitive' }] };
    expect(inspectMcpArguments(hiddenSecret)).toBe('secret');
    expect(
      inspectMcpArguments(
        { payload: `${'x'.repeat(1_000_001)} known-secret` },
        {
          knownSecrets: ['known-secret'],
        },
      ),
    ).toBe('secret');
  });

  test('rejects getters and cycles without executing untrusted accessors', () => {
    let accessed = false;
    const getter = Object.defineProperty({}, 'token', {
      enumerable: true,
      get() {
        accessed = true;
        return 'secret';
      },
    });
    expect(snapshotMcpArguments(getter)).toEqual({ ok: false });
    expect(inspectMcpArguments(getter)).toBe('unknown');
    expect(accessed).toBe(false);
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(snapshotMcpArguments(cycle)).toEqual({ ok: false });
    expect(inspectMcpArguments(cycle)).toBe('unknown');
  });
});
