import { expect, test } from 'bun:test';
import { callerDigest, callerRequestDigest, callerTarget } from '../host/caller-intents';
import { parseCLIArguments } from '../src/arguments';

test('work accepts only five closed existing DTOs; complete original caller lookup is not an HTTP proxy', () => {
  const bodies = [
    {
      kind: 'run.start',
      expectedStoreId: 'store',
      commandId: 'c',
      content: '完整🙂e\u0301\r\n',
      extensionInputs: [
        { extensionId: 'builtin.planning', definitionVersion: '1', input: { mode: 'plan' } },
      ],
    },
    {
      kind: 'input.steer',
      expectedStoreId: 'store',
      commandId: 'c',
      content: 'text',
      targetRunId: 'r',
      contextSelectionId: 'context',
    },
    {
      kind: 'input.follow_up',
      expectedStoreId: 'store',
      commandId: 'c',
      content: 'text',
      afterRunId: null,
      contextSelectionId: 'context',
    },
    {
      kind: 'command.cancel',
      expectedStoreId: 'store',
      commandId: 'c',
      targetCommandId: 'original',
    },
    { kind: 'execution.cancel', expectedStoreId: 'store', commandId: 'c', executionId: 'job' },
  ];
  expect(() =>
    callerTarget({ storeId: 'store', sessionId: 's', workspaceId: 'w' }, {
      kind: 'unknown',
    } as never),
  ).toThrow('caller_intent_invalid');
  for (const body of bodies)
    expect(parseCLIArguments(['work', 's', '--input', JSON.stringify(body)])).toEqual({
      kind: 'work',
      sessionId: 's',
      input: body,
    });
  const request = bodies[0]!;
  const intent = {
    scope: { storeId: 'store', sessionId: 's', workspaceId: 'w' },
    request,
    target: { kind: 'session', id: 's' },
    subjectId: 'local-user',
    bodyDigest: callerDigest(request),
    requestDigest: callerRequestDigest(request as never),
  };
  expect(parseCLIArguments(['caller', 'lookup', 's', '--input', JSON.stringify(intent)]).kind).toBe(
    'caller',
  );
  expect(
    parseCLIArguments([
      'caller',
      'list',
      's',
      '--input',
      '{"expectedStoreId":"store","workspaceId":"w"}',
    ]).kind,
  ).toBe('caller');
  for (const argv of [
    ['work', 's', '--input', JSON.stringify({ ...request, url: 'http://ambient' })],
    ['work', 's', '--input', JSON.stringify({ ...request, kind: 'extension.invoke' })],
    ['work', 's', '--input', JSON.stringify(request), '--json'],
    ['caller', 'list', 's', '--input', '{"expectedStoreId":"store"}'],
    ['caller', 'lookup', 'other', '--input', JSON.stringify(intent)],
    [
      'caller',
      'lookup',
      's',
      '--input',
      JSON.stringify({ ...intent, target: { kind: 'session', id: 'other' } }),
    ],
    [
      'caller',
      'lookup',
      's',
      '--input',
      JSON.stringify({ ...intent, scope: { ...intent.scope, generation: 'private' } }),
    ],
    ['caller', 'lookup', 's', '--input', JSON.stringify({ ...intent, draft: null })],
  ])
    expect(() => parseCLIArguments(argv)).toThrow();
});
