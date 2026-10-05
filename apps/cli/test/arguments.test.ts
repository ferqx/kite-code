import { expect, test } from 'bun:test';
import { CLIArgumentError, parseCLIArguments } from '../src/arguments';

function rejected(argv: readonly string[], reason?: string) {
  let error: unknown;
  try {
    parseCLIArguments(argv);
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(CLIArgumentError);
  expect((error as CLIArgumentError).code).toBe('invalid_cli_arguments');
  if (reason) expect((error as CLIArgumentError).reason).toBe(reason);
}
test('run/resume preserve full task, host-selected strings and skill order without allocating thread or resolving workspace', () => {
  const argv = Object.freeze([
    '--data-root',
    '/explicit/profile',
    'run',
    '--workspace',
    '../relative',
    '--thread',
    'unverified original thread',
    '--task',
    '  Task\n完整正文  ',
    '--ask',
    '--trust-workspace',
    '--skill',
    'one',
    '--skill',
    'two',
    '--skill',
    'one',
    '--server',
    '/unix/endpoint',
    '--model',
    'route-A',
  ]);
  expect(parseCLIArguments(argv)).toEqual({
    kind: 'run',
    task: '  Task\n完整正文  ',
    thread: 'unverified original thread',
    workspace: '../relative',
    dataRoot: '/explicit/profile',
    model: 'route-A',
    trustWorkspace: true,
    permissionMode: 'accept_edits',
    skills: ['one', 'two', 'one'],
    server: '/unix/endpoint',
  });
  expect(parseCLIArguments(['run', 'hello', 'whole', 'world'])).toEqual({
    kind: 'run',
    task: 'hello whole world',
    trustWorkspace: false,
    skills: [],
  });
  expect(parseCLIArguments(['resume', 'continue'])).toEqual({
    kind: 'resume',
    task: 'continue',
    thread: 'default-thread',
    trustWorkspace: false,
    skills: [],
  });
  expect(
    parseCLIArguments(['resume', '--thread', 'chosen', '--auto', '--task', 'continue']),
  ).toEqual({
    kind: 'resume',
    task: 'continue',
    thread: 'chosen',
    permissionMode: 'auto',
    trustWorkspace: false,
    skills: [],
  });
  expect(parseCLIArguments(['run', '--full', 'work'])).toEqual({
    kind: 'run',
    task: 'work',
    permissionMode: 'full',
    trustWorkspace: false,
    skills: [],
  });
});
test('three explicit status paths permit empty run task, remain mutually exclusive and never relax resume task requirement', () => {
  for (const [flag, status] of [
    ['--execution-status', 'execution'],
    ['--release-status', 'release'],
    ['--telemetry-status', 'telemetry'],
  ] as const) {
    expect(parseCLIArguments(['run', flag])).toEqual({
      kind: 'run',
      task: '',
      trustWorkspace: false,
      skills: [],
      status,
    });
    const resumed = parseCLIArguments(['resume', flag, '--task', 'intent']);
    expect(resumed.kind).toBe('resume');
    if (resumed.kind === 'resume') expect(resumed.status).toBe(status);
    rejected(['resume', flag], 'task_required');
    rejected([flag], 'unknown_command');
    rejected(['run', flag, '--json'], 'option_not_supported');
  }
  rejected(['run', '--execution-status', '--release-status'], 'conflicting_status_options');
});
test('trace is only a file identity/finite positive turn/json formatter selection; no model/profile/server selection', () => {
  expect(parseCLIArguments(['trace', 'relative/events.jsonl'])).toEqual({
    kind: 'trace',
    path: 'relative/events.jsonl',
    format: 'text',
  });
  expect(
    parseCLIArguments(['trace', 'events.jsonl', '--turn', '9007199254740991', '--format', 'json']),
  ).toEqual({ kind: 'trace', path: 'events.jsonl', turn: 9007199254740991, format: 'json' });
  for (const value of ['0', '-1', '+1', '1.1', '1e2', 'NaN', 'Infinity', '9007199254740992', '01'])
    rejected(['trace', 'events', '--turn', value]);
  for (const argv of [
    ['trace'],
    ['trace', 'one', 'two'],
    ['trace', 'one', '--format', 'text'],
    ['trace', 'one', '--json'],
    ['trace', 'one', '--server', 'explicit'],
    ['trace', 'one', '--data-root', '/profile'],
    ['trace', 'one', '--model', 'id'],
  ])
    rejected(argv);
});
test('all documented server/web words have closed action-specific flags and global original profile/endpoint selection', () => {
  for (const action of ['start', 'status', 'stop', 'restart'] as const) {
    expect(
      parseCLIArguments([
        '--server',
        '\\\\.\\pipe\\explicit',
        '--data-root',
        'C:\\profile',
        'server',
        action,
      ]),
    ).toEqual({
      kind: 'server',
      action,
      server: '\\\\.\\pipe\\explicit',
      dataRoot: 'C:\\profile',
      json: false,
      cancel: false,
    });
    expect(parseCLIArguments(['server', action, '--kite-home', '/profile'])).toEqual({
      kind: 'server',
      action,
      dataRoot: '/profile',
      json: false,
      cancel: false,
    });
  }
  expect(parseCLIArguments(['server', 'status', '--json'])).toEqual({
    kind: 'server',
    action: 'status',
    json: true,
    cancel: false,
  });
  expect(parseCLIArguments(['server', 'restart', '--cancel'])).toEqual({
    kind: 'server',
    action: 'restart',
    json: false,
    cancel: true,
  });
  expect(
    parseCLIArguments(['web', '--json', '--server', '/socket', '--data-root', '/profile']),
  ).toEqual({ kind: 'web', json: true, server: '/socket', dataRoot: '/profile' });
  for (const action of ['start', 'restart'] as const)
    expect(parseCLIArguments(['server', action, '--workspace', '../selected'])).toEqual({
      kind: 'server',
      action,
      workspace: '../selected',
      json: false,
      cancel: false,
    });
  for (const action of ['start', 'stop', 'restart']) rejected(['server', action, '--json']);
  for (const action of ['start', 'status', 'stop']) rejected(['server', action, '--cancel']);
  for (const argv of [
    ['server'],
    ['server', 'other'],
    ['server', 'status', 'extra'],
    ['web', 'extra'],
    ['web', '--cancel'],
    ['web', '--model', 'model'],
    ['server', 'start', '--model', 'model'],
    ['server', 'status', '--workspace', 'relative'],
    ['server', 'stop', '--workspace', 'relative'],
    ['web', '--workspace', 'relative'],
  ])
    rejected(argv);
});
test('help/version vocabularies require zero task and cannot select a profile, endpoint or task flags', () => {
  expect(parseCLIArguments([])).toEqual({ kind: 'help' });
  for (const argv of [['--help'], ['help']])
    expect(parseCLIArguments(argv)).toEqual({ kind: 'help' });
  for (const command of ['run', 'resume', 'trace', 'server', 'web'] as const) {
    expect(parseCLIArguments([command, '--help'])).toEqual({ kind: 'help', command });
    expect(parseCLIArguments(['help', command])).toEqual({ kind: 'help', command });
  }
  for (const argv of [['--version'], ['version']])
    expect(parseCLIArguments(argv)).toEqual({ kind: 'version' });
  for (const argv of [
    ['version', '--version'],
    ['help', '--help'],
    ['--help', '--version'],
    ['run', '--version'],
    ['help', '--task', 'task'],
    ['--help', '--server', 'endpoint'],
    ['version', '--data-root', '/profile'],
    ['unknown'],
    ['--help', 'unknown'],
  ])
    rejected(argv);
});
test('retired/unknown/duplicate/conflicting/missing values are rejected before any host work and diagnostics omit argument bodies', () => {
  for (const option of [
    '--feature',
    '--checkpoints',
    '--no-sandbox',
    '--user',
    '--approve',
    '--approve-same-command',
    '--answer',
    '--approval-hash',
    '--replace-command',
    '--full-access',
    '--mode',
    '--target-generation',
    '--stdio',
  ]) {
    rejected(['run', 'task', option], 'retired_option');
    rejected(['run', 'task', `${option}=private-value`], 'retired_option');
  }
  rejected(['sandbox', 'setup'], 'retired_command');
  rejected(['server', '--stdio'], 'retired_option');
  for (const argv of [
    ['run', '--task'],
    ['run', '--task', '--auto'],
    ['run', '--skill', ''],
    ['run', '--task', 'task', '--task', 'other'],
    ['run', '--task', 'task', 'positional'],
    ['run', '--auto', '--full', 'task'],
    ['run', '--ask', '--ask', 'task'],
    ['run', 'task', '--wat'],
    ['run', 'task', '--task=second'],
    ['run'],
    ['resume'],
    ['run', 'task', '--data-root', 'relative'],
    ['run', 'task', '--data-root', '/profile', '--kite-home', '/other'],
  ])
    rejected(argv);
  for (const flag of [
    '--thread',
    '--workspace',
    '--data-root',
    '--kite-home',
    '--model',
    '--server',
  ]) {
    rejected(['run', 'task', flag]);
    rejected(['run', 'task', flag, '/one', flag, '/two'], 'duplicate_option');
  }
  rejected(['run', '--task', 'secret-body', '--mode=secret-profile'], 'retired_option');
  try {
    parseCLIArguments(['run', '--task', 'secret-body', '--mode=secret-profile']);
  } catch (error) {
    expect(String(error)).not.toContain('secret-body');
    expect(String(error)).not.toContain('secret-profile');
  }
  expect(parseCLIArguments(['run', 'task', '--data-root', '\\\\host\\share'])).toMatchObject({
    dataRoot: '\\\\host\\share',
  });
  rejected(['run', 'task', '--data-root', 'C:relative']);
  rejected(['run', '--task', 'body\0suffix']);
});

test('development session/context commands accept only finite generated JSON and explicit original identities', () => {
  const input = {
    expectedStoreId: 'store',
    commandId: 'original',
    ifRevision: '0',
    title: 'accurate',
  };
  expect(
    parseCLIArguments([
      'session',
      'rename',
      's',
      '--input',
      JSON.stringify(input),
      '--data-root',
      '/tmp/new',
    ]),
  ).toEqual({ kind: 'session', action: 'rename', sessionId: 's', input, dataRoot: '/tmp/new' });
  expect(
    parseCLIArguments([
      'context',
      'include',
      's',
      '--execution',
      'e',
      '--input',
      JSON.stringify({
        expectedStoreId: 'store',
        commandId: 'include',
        expectedContextSelectionId: 'selection',
        resultRevision: '1',
        targetRunId: 'actual-run',
      }),
    ]),
  ).toMatchObject({ kind: 'context', action: 'include', executionId: 'e' });
  for (const [command, action, request] of [
    ['session', 'rename', input],
    ['context', 'read', { storeId: 'store', contextSelectionId: 'selection' }],
  ] as const) {
    const argv = [
      command,
      action,
      's',
      '--input',
      JSON.stringify(request),
      '--server',
      '/owned.sock',
    ];
    expect(parseCLIArguments(argv)).toMatchObject({
      kind: command,
      action,
      sessionId: 's',
      input: request,
      server: '/owned.sock',
    });
    expect(() => parseCLIArguments([...argv, '--server', '/other.sock'])).toThrow();
    expect(() => parseCLIArguments([...argv, '--workspace', '/other'])).toThrow();
  }
  for (const argv of [
    ['session', 'delete', 's', '--input', '{}'],
    ['session', 'rename', 's', '--input', JSON.stringify({ ...input, grant: 'full' })],
    ['context', 'read', 's', '--input', '[]'],
    ['context', 'read', 's', '--input', '{"storeId":"store"}', '--execution', 'e'],
    ['context', 'include', 's', '--input', '{}'],
    ['session', 'rename', 's', '--input', JSON.stringify(input), '--model', 'hidden'],
  ])
    expect(() => parseCLIArguments(argv)).toThrow();
});

test('explicit Workflow activation is repeatable only for run/resume and independent of knowledge selection', () => {
  for (const command of ['run', 'resume']) {
    const args = parseCLIArguments([
      command,
      '--task',
      'original task',
      '--skill',
      'guide',
      '--activate-skill',
      'Workflow Name',
      '--activate-skill',
      'skill:exact',
    ]);
    expect(args).toMatchObject({
      kind: command,
      task: 'original task',
      skills: ['guide'],
      activateSkills: ['Workflow Name', 'skill:exact'],
    });
  }
  rejected(['run', '--task', 't', '--activate-skill', ''], 'missing_value');
  rejected(['server', 'status', '--activate-skill', 'skill:x'], 'option_not_supported');
  rejected(['trace', '/original', '--activate-skill', 'skill:x'], 'option_not_supported');
});

test('status remains readonly and cannot silently ignore explicit Workflow activation', () => {
  rejected(
    ['run', '--execution-status', '--activate-skill', 'Skill'],
    'activation_not_supported_with_status',
  );
});
