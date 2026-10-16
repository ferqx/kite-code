import { expect, test } from 'bun:test';
import { parseTUIArguments } from '../host/tui-arguments';

test('ordinary TUI arguments reject test diagnostics in every environment', () => {
  for (const environment of ['development', 'production', 'test']) {
    const previous = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = environment;
      expect(parseTUIArguments([])).toEqual({ kind: 'tui' });
      for (const argv of [
        ['--test-ui-diagnostics'],
        ['--test-ui-diagnostics', '--thread', 's'],
        ['--test-ui-diagnostics', '--test-ui-diagnostics'],
        ['--test-ui-diagnostics', 'true'],
      ])
        expect(() => parseTUIArguments(argv)).toThrow('invalid_tui_arguments');
    } finally {
      if (previous === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previous;
    }
  }
});

test('development TUI arguments are pure, closed and do not invent authority or endpoints', () => {
  expect(parseTUIArguments([])).toEqual({ kind: 'tui' });
  expect(
    parseTUIArguments([
      '--workspace',
      'relative',
      '--thread',
      'actual',
      '--data-root',
      '/temporary/new',
    ]),
  ).toEqual({ kind: 'tui', workspace: 'relative', thread: 'actual', dataRoot: '/temporary/new' });
  expect(parseTUIArguments(['--help'])).toEqual({ kind: 'help' });
  expect(parseTUIArguments(['--version'])).toEqual({ kind: 'version' });
  expect(parseTUIArguments(['--server', '/private/tmp/original.sock'])).toEqual({
    kind: 'tui',
    server: '/private/tmp/original.sock',
  });
  for (const input of [
    ['--full'],
    ['--mode', 'auto'],
    ['--token', 'secret'],
    ['--server', 'url'],
    ['--server', 'http://127.0.0.1:1234'],
    ['--server', '/original.sock', '--server', '/changed.sock'],
    ['--data-root', 'relative'],
    ['--help', '--thread', 'actual'],
    ['--thread'],
    ['--thread', 'a', '--thread', 'b'],
    ['task'],
    ['--workspace', 'bad\0path'],
  ])
    expect(() => parseTUIArguments(input)).toThrow('invalid_tui_arguments');
});
