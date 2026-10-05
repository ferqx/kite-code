import { expect, test } from 'bun:test';
import { parseCLIArguments } from '../src/arguments';

const request = {
  kind: 'run.resume',
  expectedStoreId: 'store',
  commandId: 'recovery',
  runId: 'original-run',
};
test('explicit recovery parses original closed IDs separately from new follow-up resume', () => {
  expect(parseCLIArguments(['recovery', 'run', 's', '--input', JSON.stringify(request)])).toEqual({
    kind: 'recovery',
    action: 'run',
    sessionId: 's',
    input: request,
  });
  const intent = { kind: 'run', sessionId: 's', request };
  expect(parseCLIArguments(['recovery', 'lookup', 's', '--input', JSON.stringify(intent)])).toEqual(
    { kind: 'recovery', action: 'lookup', sessionId: 's', input: intent },
  );
  expect(
    parseCLIArguments([
      'recovery',
      'report',
      's',
      'original-report',
      '--input',
      JSON.stringify({ expectedStoreId: 'store', commandId: 'report-recovery' }),
    ]),
  ).toMatchObject({ kind: 'recovery', action: 'report', reportCommandId: 'original-report' });
  expect(parseCLIArguments(['resume', '--thread', 's', '--task', 'new follow-up'])).toMatchObject({
    kind: 'resume',
    task: 'new follow-up',
    thread: 's',
  });
});
for (const input of [
  { ...request, expectedOwnerGeneration: 7 },
  { ...request, runId: 'current run' },
  { kind: 'session.recover', expectedStoreId: 'store', commandId: 'recovery', decision: 'resume' },
  {
    kind: 'session.recover',
    expectedStoreId: 'store',
    commandId: 'recovery',
    decision: 'interrupt',
    lease: 'private',
  },
])
  test('recovery refuses unclosed or private authority request', () => {
    expect(() =>
      parseCLIArguments([
        'recovery',
        input.kind === 'session.recover' ? 'interrupt' : 'run',
        's',
        '--input',
        JSON.stringify(input),
      ]),
    ).toThrow();
  });
test('lookup rejects changed Session, invented report field or missing explicit original report ID', () => {
  for (const intent of [
    { kind: 'run', sessionId: 'b', request },
    { kind: 'run', sessionId: 's', request, reportCommandId: 'invented' },
    { kind: 'report', sessionId: 's', request: { expectedStoreId: 'store', commandId: 'r' } },
  ])
    expect(() =>
      parseCLIArguments(['recovery', 'lookup', 's', '--input', JSON.stringify(intent)]),
    ).toThrow();
  expect(() => parseCLIArguments(['recovery', 'report', 's', '--input', '{}'])).toThrow();
});
