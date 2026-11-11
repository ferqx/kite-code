import { describe, expect, test } from 'bun:test';
import { createInvocationLifetime } from './lifetime';
import { interpretCLI, parseLaunchArguments } from './runtime';

const identity = { storeId: 'store', sessionId: 'session', commandId: 'command' };
const output = (answer: unknown = { ...identity, executionId: 'execution', complete: true }) =>
  `work intent ${JSON.stringify(identity)}\nterminal command succeeded\nanswer ${JSON.stringify(answer)}\n`;
describe('Harbor Kite launcher admission', () => {
  test('preserves literal argument values and explicit deadline', () => {
    expect(
      parseLaunchArguments([
        '--instruction-file',
        '/tmp/a;echo nope',
        '--workspace',
        '/app',
        '--output',
        '/logs/agent/kite',
        '--deadline-ms',
        '5000',
      ]).instructionFile,
    ).toBe('/tmp/a;echo nope');
  });
  test('rejects relative paths and duplicate options', () => {
    expect(() =>
      parseLaunchArguments([
        '--instruction-file',
        'relative',
        '--workspace',
        '/app',
        '--output',
        '/logs',
      ]),
    ).toThrow();
    expect(() => parseLaunchArguments(['--workspace', '/app', '--workspace', '/other'])).toThrow();
  });
  test('success requires the original terminal and matching complete answer', () => {
    expect(interpretCLI(output(), 0).status).toBe('succeeded');
    expect(() =>
      interpretCLI(
        output({ ...identity, commandId: 'other', executionId: 'execution', complete: true }),
        0,
      ),
    ).toThrow();
    expect(() =>
      interpretCLI(output().replace('terminal command succeeded', 'accepted command'), 0),
    ).toThrow();
  });
  test('unknown, input and cancellation remain distinct even with a success-looking log', () => {
    expect(interpretCLI(output(), 2).status).toBe('unknown');
    expect(interpretCLI(output(), 3).status).toBe('needs_input');
    expect(interpretCLI(output(), 130).status).toBe('cancelled');
  });
  test('missing or multiple work identities fail closed', () => {
    expect(() => interpretCLI('accepted command\n', 0)).toThrow();
    expect(() => interpretCLI(`${output()}work intent ${JSON.stringify(identity)}\n`, 0)).toThrow();
  });
});

describe('whole invocation lifetime', () => {
  test('deadline also stops a never-ending later phase', async () => {
    const life = createInvocationLifetime(10);
    try {
      await life.guard(Promise.resolve());
      await expect(life.guard(new Promise(() => {}))).rejects.toMatchObject({
        outcome: 'timed_out',
      });
    } finally {
      life.dispose();
    }
  });
  test('cancellation interrupts waiting immediately and prevents late success', async () => {
    const life = createInvocationLifetime(60000);
    try {
      const pending = life.guard(new Promise(() => {}));
      life.cancel();
      await expect(pending).rejects.toMatchObject({ outcome: 'cancelled' });
      await expect(life.guard(Promise.resolve('success'))).rejects.toMatchObject({
        outcome: 'cancelled',
      });
    } finally {
      life.dispose();
    }
  });
});
