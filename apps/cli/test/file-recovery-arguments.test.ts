import { expect, test } from 'bun:test';
import { CLIArgumentError, parseCLIArguments } from '../src/arguments';

const point = 'a'.repeat(64);
test('Files explicit scopes preserve exact point and original JSON; list is readonly directory alias', () => {
  expect(parseCLIArguments(['files', 'list', '_s'])).toEqual({
    kind: 'files',
    action: 'checkpoints',
    sessionId: '_s',
  });
  for (const scope of ['session', 'code', 'both'] as const)
    expect(parseCLIArguments(['files', 'restore', 's', point, `--scope=${scope}`])).toEqual({
      kind: 'files',
      action: 'restore',
      sessionId: 's',
      pointId: point,
      scope,
    });
  const original = { version: 1, original: '完整原请求' };
  expect(parseCLIArguments(['files', 'lookup', 's', '--input', JSON.stringify(original)])).toEqual({
    kind: 'files',
    action: 'lookup',
    sessionId: 's',
    input: original,
  });
});
test('Files rejects missing scope, unknown flags, extra targets and malformed input before opening host', () => {
  for (const argv of [
    ['files', 'restore', 's', point],
    ['files', 'restore', 's', point, '--scope=all'],
    ['files', 'restore', 's', point, '--scope=both', '--full'],
    ['files', 'detail', 's', point, 'extra'],
    ['files', 'lookup', 's', '--input', '[]'],
    ['files', 'lookup', 's', '--input', '{'],
    ['files', 'restore', 'foreign.session', point, '--scope=code'],
    ['files', 'detail', 's', 'a'],
  ])
    expect(() => parseCLIArguments(argv)).toThrow(CLIArgumentError);
});
