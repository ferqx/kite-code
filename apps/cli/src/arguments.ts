import { validateRequest } from '@kite-ai/client';
import type { FileRecoveryCLIArguments } from './file-recovery';
export type CLIPermissionMode = 'accept_edits' | 'auto' | 'full';
export type CLIStatus = 'execution' | 'release' | 'telemetry';
export type CLICommand =
  | 'run'
  | 'resume'
  | 'trace'
  | 'server'
  | 'web'
  | 'session'
  | 'context'
  | 'job'
  | 'recovery'
  | 'work'
  | 'caller'
  | 'maintenance'
  | 'files';
export type MaintenanceCLIArguments =
  | { kind: 'maintenance'; action: 'inspect'; directory: string }
  | {
      kind: 'maintenance';
      action: 'backup';
      dataRoot: string;
      profile: string;
      destinationRoot: string;
    }
  | { kind: 'maintenance'; action: 'status'; dataRoot: string; profile: string }
  | {
      kind: 'maintenance';
      action: 'restore';
      dataRoot: string;
      profile: string;
      directory: string;
      expectedStoreId: string;
      confirmDataLoss: true;
    }
  | {
      kind: 'maintenance';
      action: 'reconcile';
      dataRoot: string;
      profile: string;
      restoreId: string;
      journalDigest: string;
      decision: 'complete' | 'rollback';
      confirmDataLoss: true;
    };
export interface TaskCLIArguments {
  kind: 'run' | 'resume';
  task: string;
  thread?: string;
  workspace?: string;
  dataRoot?: string;
  model?: string;
  trustWorkspace: boolean;
  permissionMode?: CLIPermissionMode;
  skills: string[];
  activateSkills?: string[];
  status?: CLIStatus;
  server?: string;
}
export type RunCLIArguments = TaskCLIArguments & { kind: 'run' };
export type ResumeCLIArguments = TaskCLIArguments & { kind: 'resume' };
export type ManagementCLIArguments =
  | {
      kind: 'recovery';
      action: 'run' | 'interrupt' | 'report' | 'lookup' | 'list';
      server?: string;
      sessionId: string;
      reportCommandId?: string;
      input: Record<string, unknown>;
      dataRoot?: string;
    }
  | {
      kind: 'job';
      action: 'reconcile';
      server?: string;
      sessionId: string;
      input: Record<string, unknown>;
      dataRoot?: string;
    }
  | {
      kind: 'session';
      server?: string;
      action: 'rename' | 'delete' | 'fork';
      sessionId: string;
      input: Record<string, unknown>;
      dataRoot?: string;
    }
  | {
      kind: 'context';
      server?: string;
      action: 'read' | 'rewind' | 'include' | 'compact' | 'reset';
      sessionId: string;
      input: Record<string, unknown>;
      executionId?: string;
      dataRoot?: string;
    };
export type CallerCLIArguments = {
  kind: 'work' | 'caller';
  action?: 'list' | 'lookup';
  sessionId: string;
  input: Record<string, unknown>;
  dataRoot?: string;
  server?: string;
};
export type CLIArguments =
  | FileRecoveryCLIArguments
  | CallerCLIArguments
  | MaintenanceCLIArguments
  | ManagementCLIArguments
  | RunCLIArguments
  | ResumeCLIArguments
  | { kind: 'trace'; path: string; turn?: number; format: 'text' | 'json' }
  | {
      kind: 'server';
      action: 'start' | 'status' | 'stop' | 'restart';
      server?: string;
      dataRoot?: string;
      workspace?: string;
      json: boolean;
      cancel: boolean;
    }
  | { kind: 'web'; server?: string; dataRoot?: string; json: boolean }
  | { kind: 'help'; command?: CLICommand }
  | { kind: 'version' };

/** Diagnostics name the invalid vocabulary; never interpolate task, endpoint or profile values. */
export class CLIArgumentError extends Error {
  readonly code = 'invalid_cli_arguments';
  readonly reason: string;
  readonly option: string | undefined;
  constructor(reason: string, option?: string) {
    super(option ? `${reason}: ${option}` : reason);
    this.name = 'CLIArgumentError';
    this.reason = reason;
    this.option = option;
  }
}
const retired = new Set([
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
]);
const valued = new Set([
  '--scope',
  '--profile',
  '--destination',
  '--expected-store',
  '--restore-id',
  '--journal-digest',
  '--decision',
  '--input',
  '--execution',
  '--task',
  '--thread',
  '--workspace',
  '--data-root',
  '--kite-home',
  '--model',
  '--skill',
  '--activate-skill',
  '--server',
  '--turn',
  '--format',
]);
const toggles = new Set([
  '--confirm-data-loss',
  '--trust-workspace',
  '--ask',
  '--auto',
  '--full',
  '--execution-status',
  '--release-status',
  '--telemetry-status',
  '--json',
  '--cancel',
  '--help',
  '--version',
]);
const commands = new Set<CLICommand>([
  'maintenance',
  'files',
  'run',
  'resume',
  'trace',
  'server',
  'web',
  'session',
  'context',
  'job',
  'recovery',
  'work',
  'caller',
]);
function fail(reason: string, option?: string): never {
  throw new CLIArgumentError(reason, option);
}
function absolute(value: string): boolean {
  return /^(?:\/|[A-Za-z]:[\\/])/.test(value) || /^\\\\[^\\/]+[\\/][^\\/]+(?:[\\/]|$)/.test(value);
}

/** Pure closed CLI vocabulary. No environment, cwd, service discovery, credentials or generated task IDs. */
export function parseCLIArguments(argv: readonly string[]): CLIArguments {
  const values = new Map<string, string[]>(),
    words: string[] = [];
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index]!;
    if (typeof argument !== 'string' || argument.includes('\0')) fail('invalid_argument');
    if (!argument.startsWith('-')) {
      words.push(argument);
      continue;
    }
    const name = argument.split('=', 1)[0]!;
    if (retired.has(name)) fail('retired_option', name);
    if ((argument.includes('=') && name !== '--scope') || (!valued.has(name) && !toggles.has(name)))
      fail('unknown_option', name);
    if (name !== '--skill' && name !== '--activate-skill' && values.has(name))
      fail('duplicate_option', name);
    const entries = values.get(name) ?? [];
    if (valued.has(name)) {
      const value = argument.includes('=')
        ? argument.slice(argument.indexOf('=') + 1)
        : argv[++index];
      if (
        typeof value !== 'string' ||
        value.startsWith('-') ||
        value.trim().length === 0 ||
        value.includes('\0')
      )
        fail('missing_value', name);
      entries.push(value);
    } else entries.push('true');
    values.set(name, entries);
  }
  const has = (flag: string) => values.has(flag),
    value = (flag: string) => values.get(flag)?.[0];
  const command = words[0];
  if (command === 'sandbox') fail('retired_command');
  if (has('--version') || command === 'version') {
    if (has('--version') && command === 'version') fail('invalid_version_combination');
    if (values.size > (has('--version') ? 1 : 0) || words.length > (command === 'version' ? 1 : 0))
      fail('invalid_version_combination');
    return { kind: 'version' };
  }
  if (has('--help') || command === 'help' || argv.length === 0) {
    if (has('--help') && command === 'help') fail('invalid_help_combination');
    if (values.size > (has('--help') ? 1 : 0)) fail('invalid_help_combination');
    const target = command === 'help' ? words[1] : command;
    if (target !== undefined && !commands.has(target as CLICommand)) fail('unknown_command');
    const expected = command === 'help' ? (target ? 2 : 1) : target ? 1 : 0;
    if (words.length !== expected) fail('invalid_help_combination');
    return target ? { kind: 'help', command: target as CLICommand } : { kind: 'help' };
  }
  if (!commands.has(command as CLICommand)) fail('unknown_command');
  if (command === 'files') {
    const action = words[1] === 'list' ? 'checkpoints' : words[1];
    if (
      !['checkpoints', 'detail', 'restore', 'lookup', 'continue', 'intents'].includes(action ?? '')
    )
      fail('file_recovery_action_invalid');
    for (const flag of values.keys())
      if (
        ![
          '--server',
          '--data-root',
          ...(action === 'restore' ? ['--scope'] : []),
          ...(['lookup', 'continue'].includes(action!) ? ['--input'] : []),
        ].includes(flag)
      )
        fail('option_not_supported', flag);
    const sessionId = words[2];
    if (!sessionId || !/^[A-Za-z0-9_-]{1,128}$/.test(sessionId))
      fail('file_recovery_session_required');
    const needsPoint = action === 'detail' || action === 'restore';
    if (words.length !== (needsPoint ? 4 : 3)) fail('unexpected_positional_argument');
    const pointId = needsPoint ? words[3] : undefined;
    if (pointId !== undefined && !/^[a-f0-9]{64}$/.test(pointId))
      fail('file_recovery_point_required');
    const scope = value('--scope');
    if (action === 'restore' && !['session', 'code', 'both'].includes(scope ?? ''))
      fail('file_recovery_scope_required');
    let input: Record<string, unknown> | undefined;
    if (['lookup', 'continue'].includes(action!)) {
      try {
        input = JSON.parse(value('--input') ?? '') as Record<string, unknown>;
      } catch {
        fail('file_recovery_input_required');
      }
      if (!input || typeof input !== 'object' || Array.isArray(input))
        fail('file_recovery_input_required');
    }
    const dataRoot = value('--data-root');
    if (dataRoot && !absolute(dataRoot)) fail('absolute_data_root_required');
    return {
      kind: 'files',
      action: action as FileRecoveryCLIArguments['action'],
      sessionId,
      ...(pointId ? { pointId } : {}),
      ...(scope ? { scope: scope as 'session' | 'code' | 'both' } : {}),
      ...(input ? { input } : {}),
      ...(dataRoot ? { dataRoot } : {}),
      ...(value('--server') ? { server: value('--server') } : {}),
    };
  }
  if (command === 'maintenance') {
    const action = words[1];
    if (!['backup', 'inspect', 'status', 'restore', 'reconcile'].includes(action ?? ''))
      fail('maintenance_action_invalid');
    const allowed = new Set(
      action === 'inspect'
        ? []
        : [
            '--data-root',
            '--profile',
            ...(action === 'backup'
              ? ['--destination']
              : action === 'restore'
                ? ['--expected-store', '--confirm-data-loss']
                : action === 'reconcile'
                  ? ['--restore-id', '--journal-digest', '--decision', '--confirm-data-loss']
                  : []),
          ],
    );
    for (const flag of values.keys()) if (!allowed.has(flag)) fail('option_not_supported', flag);
    if (words.length !== (['inspect', 'restore'].includes(action!) ? 3 : 2))
      fail('unexpected_positional_argument');
    const directory = words[2];
    if (directory !== undefined && !absolute(directory)) fail('absolute_backup_directory_required');
    if (action === 'inspect') return { kind: 'maintenance', action, directory: directory! };
    const dataRoot = value('--data-root'),
      profile = value('--profile');
    if (!dataRoot || !absolute(dataRoot)) fail('absolute_data_root_required');
    if (!profile || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(profile))
      fail('maintenance_profile_required');
    const base = { kind: 'maintenance' as const, dataRoot, profile };
    if (action === 'status') return { ...base, action };
    if (action === 'backup') {
      const destinationRoot = value('--destination');
      if (!destinationRoot || !absolute(destinationRoot)) fail('absolute_destination_required');
      return { ...base, action, destinationRoot };
    }
    if (!has('--confirm-data-loss')) fail('maintenance_data_loss_confirmation_required');
    if (action === 'restore') {
      const expectedStoreId = value('--expected-store');
      if (!expectedStoreId || !/^[A-Za-z0-9._:-]{1,128}$/.test(expectedStoreId))
        fail('maintenance_expected_store_required');
      return { ...base, action, directory: directory!, expectedStoreId, confirmDataLoss: true };
    }
    const restoreId = value('--restore-id'),
      journalDigest = value('--journal-digest'),
      decision = value('--decision');
    if (!restoreId || !/^[a-f0-9-]{36}$/.test(restoreId)) fail('maintenance_restore_id_required');
    if (!journalDigest || !/^[a-f0-9]{64}$/.test(journalDigest))
      fail('maintenance_journal_digest_required');
    if (decision !== 'complete' && decision !== 'rollback') fail('maintenance_decision_required');
    return {
      ...base,
      action: 'reconcile',
      restoreId,
      journalDigest,
      decision,
      confirmDataLoss: true,
    };
  }
  if (command === 'work' || command === 'caller') {
    for (const flag of values.keys())
      if (!['--input', '--data-root', '--kite-home', '--server'].includes(flag))
        fail('option_not_supported', flag);
    if (has('--data-root') && has('--kite-home')) fail('conflicting_profile_options');
    const dataRoot = value('--data-root') ?? value('--kite-home');
    if (dataRoot !== undefined && !absolute(dataRoot)) fail('absolute_data_root_required');
    const action = command === 'caller' ? words[1] : undefined;
    const sessionId = words[command === 'caller' ? 2 : 1];
    if (
      !sessionId ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(sessionId) ||
      words.length !== (command === 'caller' ? 3 : 2) ||
      (command === 'caller' && action !== 'list' && action !== 'lookup')
    )
      fail('caller_target_required');
    let input: Record<string, unknown>;
    try {
      input = JSON.parse(value('--input') ?? '');
      if (!input || typeof input !== 'object' || Array.isArray(input)) fail('caller_json_invalid');
      if (command === 'work') {
        const shapes: Record<string, Parameters<typeof validateRequest>[0]> = {
          'run.start': 'StartCommandRequest',
          'input.steer': 'SteerCommandRequest',
          'input.follow_up': 'FollowUpCommandRequest',
          'command.cancel': 'CancelCommandRequest',
          'execution.cancel': 'CancelExecutionRequest',
        };
        const shape = shapes[String(input.kind)];
        if (!shape) fail('caller_json_invalid');
        validateRequest(shape, input);
      } else if (action === 'list') {
        if (
          Object.keys(input).sort().join(',') !== 'expectedStoreId,workspaceId' ||
          ['expectedStoreId', 'workspaceId'].some(
            (k) => typeof input[k] !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(String(input[k])),
          )
        )
          fail('caller_json_invalid');
      } else {
        const keys = Object.keys(input).sort().join(',');
        if (
          keys !== 'bodyDigest,request,requestDigest,scope,subjectId,target' &&
          keys !== 'bodyDigest,draft,request,requestDigest,scope,subjectId,target'
        )
          fail('caller_json_invalid');
        const object = (v: unknown): v is Record<string, unknown> =>
          !!v && typeof v === 'object' && !Array.isArray(v);
        if (
          !object(input.scope) ||
          Object.keys(input.scope).sort().join(',') !== 'sessionId,storeId,workspaceId' ||
          Object.values(input.scope).some(
            (v) => typeof v !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(v),
          ) ||
          input.scope.sessionId !== sessionId ||
          !object(input.request) ||
          !object(input.target) ||
          typeof input.subjectId !== 'string' ||
          input.subjectId.length < 1 ||
          input.subjectId.length > 256 ||
          ['bodyDigest', 'requestDigest'].some(
            (k) => typeof input[k] !== 'string' || !/^[a-f0-9]{64}$/.test(String(input[k])),
          )
        )
          fail('caller_json_invalid');
        const r = input.request;
        const shapes: Record<string, Parameters<typeof validateRequest>[0]> = {
          'run.start': 'StartCommandRequest',
          'input.steer': 'SteerCommandRequest',
          'input.follow_up': 'FollowUpCommandRequest',
          'command.cancel': 'CancelCommandRequest',
          'execution.cancel': 'CancelExecutionRequest',
        };
        if (!shapes[String(r.kind)] || r.expectedStoreId !== input.scope.storeId)
          fail('caller_json_invalid');
        validateRequest(shapes[String(r.kind)]!, r);
        const target =
          r.kind === 'run.start'
            ? { kind: 'session', id: sessionId }
            : r.kind === 'input.steer'
              ? { kind: 'run', id: r.targetRunId, contextSelectionId: r.contextSelectionId }
              : r.kind === 'input.follow_up'
                ? { kind: 'after_run', id: r.afterRunId, contextSelectionId: r.contextSelectionId }
                : r.kind === 'command.cancel'
                  ? { kind: 'command', id: r.targetCommandId }
                  : { kind: 'execution', id: r.executionId };
        if (
          Object.keys(input.target).sort().join(',') !== Object.keys(target).sort().join(',') ||
          Object.entries(target).some(([k, v]) => input.target![k as never] !== v)
        )
          fail('caller_json_invalid');
        if (
          input.draft !== undefined &&
          (!object(input.draft) ||
            Object.keys(input.draft).sort().join(',') !== 'id,revision,textDigest' ||
            ['id', 'textDigest'].some(
              (k) =>
                typeof input.draft![k as never] !== 'string' ||
                !/^[a-f0-9]{64}$/.test(String(input.draft![k as never])),
            ) ||
            typeof input.draft.revision !== 'string' ||
            !/^(0|[1-9][0-9]{0,18})$/.test(input.draft.revision) ||
            BigInt(input.draft.revision) > 9223372036854775807n)
        )
          fail('caller_json_invalid');
      }
    } catch {
      fail('caller_json_invalid');
    }
    return {
      kind: command,
      sessionId,
      input,
      ...(action ? { action: action as 'list' | 'lookup' } : {}),
      ...(dataRoot ? { dataRoot } : {}),
      ...(value('--server') ? { server: value('--server') } : {}),
    };
  }
  if (command === 'recovery') {
    for (const flag of values.keys())
      if (!['--input', '--data-root', '--kite-home', '--server'].includes(flag))
        fail('option_not_supported', flag);
    if (has('--data-root') && has('--kite-home')) fail('conflicting_profile_options');
    const dataRoot = value('--data-root') ?? value('--kite-home');
    if (dataRoot !== undefined && !absolute(dataRoot)) fail('absolute_data_root_required');
    const action = words[1],
      sessionId = words[2];
    if (
      !['run', 'interrupt', 'report', 'lookup', 'list'].includes(action ?? '') ||
      !sessionId ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(sessionId) ||
      (action === 'report' && !/^[A-Za-z0-9_-]{1,128}$/.test(words[3] ?? '')) ||
      words.length !== (action === 'report' ? 4 : 3)
    )
      fail('recovery_target_required');
    let input: Record<string, unknown>;
    try {
      input = JSON.parse(value('--input') ?? '');
      if (!input || typeof input !== 'object' || Array.isArray(input))
        fail('recovery_json_invalid');
      if (action === 'list' || (action === 'lookup' && input.request === undefined)) {
        const keys = action === 'list' ? ['expectedStoreId'] : ['expectedStoreId', 'commandId'];
        if (
          Object.keys(input).sort().join(',') !== keys.sort().join(',') ||
          keys.some(
            (key) =>
              typeof input[key] !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(String(input[key])),
          )
        )
          fail('recovery_json_invalid');
      } else if (action === 'lookup') {
        if (
          input.sessionId !== sessionId ||
          !['run', 'interrupt', 'report'].includes(String(input.kind)) ||
          Object.keys(input).some(
            (key) => !['kind', 'sessionId', 'request', 'reportCommandId'].includes(key),
          )
        )
          fail('recovery_json_invalid');
        validateRequest(
          input.kind === 'run'
            ? 'ResumeRunRequest'
            : input.kind === 'interrupt'
              ? 'RecoverSessionRequest'
              : 'ResumeJobReportRequest',
          input.request,
        );
        if (
          input.kind === 'report'
            ? typeof input.reportCommandId !== 'string' ||
              !/^[A-Za-z0-9_-]{1,128}$/.test(input.reportCommandId)
            : input.reportCommandId !== undefined
        )
          fail('recovery_json_invalid');
      } else
        validateRequest(
          action === 'run'
            ? 'ResumeRunRequest'
            : action === 'interrupt'
              ? 'RecoverSessionRequest'
              : 'ResumeJobReportRequest',
          input,
        );
    } catch {
      fail('recovery_json_invalid');
    }
    return {
      kind: 'recovery',
      action: action as 'run' | 'interrupt' | 'report' | 'lookup' | 'list',
      sessionId,
      input,
      ...(action === 'report' ? { reportCommandId: words[3]! } : {}),
      ...(dataRoot ? { dataRoot } : {}),
      ...(value('--server') ? { server: value('--server')! } : {}),
    };
  }
  if (command === 'session' || command === 'context' || command === 'job') {
    for (const flag of values.keys())
      if (!['--input', '--execution', '--data-root', '--kite-home', '--server'].includes(flag))
        fail('option_not_supported', flag);
    if (has('--data-root') && has('--kite-home')) fail('conflicting_profile_options');
    const dataRoot = value('--data-root') ?? value('--kite-home');
    if (dataRoot !== undefined && !absolute(dataRoot)) fail('absolute_data_root_required');
    if (words.length !== 3 || !words[2]?.trim()) fail('management_target_required');
    const action = words[1],
      sessionId = words[2]!;
    if (
      !(
        command === 'job'
          ? ['reconcile']
          : command === 'session'
            ? ['rename', 'delete', 'fork']
            : ['read', 'rewind', 'include', 'compact', 'reset']
      ).includes(action!)
    )
      fail('management_action_invalid');
    if ((action === 'include') !== has('--execution')) fail('execution_target_required');
    let input: Record<string, unknown>;
    try {
      const parsed = JSON.parse(value('--input') ?? '');
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
        fail('management_json_object_required');
      input = parsed;
      const shape =
        command === 'job'
          ? 'ReconcileJobRequest'
          : command === 'session'
            ? action === 'rename'
              ? 'RenameSessionRequest'
              : action === 'delete'
                ? 'DeleteSessionRequest'
                : 'ForkSessionRequest'
            : action === 'read'
              ? 'ContextQuery'
              : action === 'rewind'
                ? 'SelectContextRequest'
                : action === 'include'
                  ? 'IncludeResultRequest'
                  : action === 'compact'
                    ? 'CompressContextRequest'
                    : 'ResetCompressionRequest';
      validateRequest(shape, input);
      if (
        action === 'compact' &&
        typeof input.focus === 'string' &&
        new TextEncoder().encode(input.focus).byteLength > 4096
      )
        fail('management_focus_invalid');
    } catch {
      fail('management_json_invalid');
    }
    return {
      kind: command,
      action,
      sessionId,
      input,
      ...(dataRoot ? { dataRoot } : {}),
      ...(value('--server') ? { server: value('--server')! } : {}),
      ...(value('--execution') ? { executionId: value('--execution')! } : {}),
    } as ManagementCLIArguments;
  }
  const taskCommand = command === 'run' || command === 'resume';
  const shared = ['--data-root', '--kite-home', '--server'];
  const allowed = new Set(
    taskCommand
      ? [
          ...shared,
          '--task',
          '--thread',
          '--workspace',
          '--model',
          '--trust-workspace',
          '--ask',
          '--auto',
          '--full',
          '--skill',
          '--activate-skill',
          '--execution-status',
          '--release-status',
          '--telemetry-status',
        ]
      : command === 'trace'
        ? ['--turn', '--format']
        : command === 'web'
          ? [...shared, '--json']
          : [
              ...shared,
              ...(words[1] === 'status' ? ['--json'] : words[1] === 'restart' ? ['--cancel'] : []),
              ...(['start', 'restart'].includes(words[1] ?? '') ? ['--workspace'] : []),
            ],
  );
  for (const flag of values.keys()) if (!allowed.has(flag)) fail('option_not_supported', flag);
  if (has('--data-root') && has('--kite-home')) fail('conflicting_profile_options');
  const dataRoot = value('--data-root') ?? value('--kite-home');
  if (dataRoot !== undefined && !absolute(dataRoot))
    fail('absolute_data_root_required', has('--data-root') ? '--data-root' : '--kite-home');
  const server = value('--server');
  if (taskCommand) {
    const modes = ['--ask', '--auto', '--full'].filter(has),
      statuses = ['--execution-status', '--release-status', '--telemetry-status'].filter(has);
    if (modes.length > 1) fail('conflicting_permission_modes');
    if (statuses.length > 1) fail('conflicting_status_options');
    if (has('--task') && words.length > 1) fail('conflicting_task_sources');
    const task = value('--task') ?? words.slice(1).join(' '),
      status: CLIStatus | undefined =
        statuses[0] === '--execution-status'
          ? 'execution'
          : statuses[0] === '--release-status'
            ? 'release'
            : statuses[0] === '--telemetry-status'
              ? 'telemetry'
              : undefined;
    if (task.trim().length === 0 && (command === 'resume' || status === undefined))
      fail('task_required');
    if (status && has('--activate-skill')) fail('activation_not_supported_with_status');
    const permissionMode: CLIPermissionMode | undefined =
      modes[0] === '--ask'
        ? 'accept_edits'
        : modes[0] === '--auto'
          ? 'auto'
          : modes[0] === '--full'
            ? 'full'
            : undefined;
    return {
      kind: command,
      task,
      ...(value('--thread') !== undefined || command === 'resume'
        ? { thread: value('--thread') ?? 'default-thread' }
        : {}),
      ...(value('--workspace') !== undefined ? { workspace: value('--workspace') } : {}),
      ...(dataRoot !== undefined ? { dataRoot } : {}),
      ...(value('--model') !== undefined ? { model: value('--model') } : {}),
      trustWorkspace: has('--trust-workspace'),
      ...(permissionMode ? { permissionMode } : {}),
      skills: [...(values.get('--skill') ?? [])],
      ...(has('--activate-skill') ? { activateSkills: [...values.get('--activate-skill')!] } : {}),
      ...(status ? { status } : {}),
      ...(server !== undefined ? { server } : {}),
    };
  }
  if (command === 'trace') {
    if (words.length !== 2 || !words[1]?.trim()) fail('trace_path_required');
    const rawTurn = value('--turn');
    let turn: number | undefined;
    if (rawTurn !== undefined) {
      if (!/^[1-9][0-9]*$/.test(rawTurn) || !Number.isSafeInteger(Number(rawTurn)))
        fail('invalid_turn', '--turn');
      turn = Number(rawTurn);
    }
    if (has('--format') && value('--format') !== 'json') fail('invalid_format', '--format');
    return {
      kind: 'trace',
      path: words[1],
      ...(turn !== undefined ? { turn } : {}),
      format: has('--format') ? 'json' : 'text',
    };
  }
  const selection = {
    ...(server !== undefined ? { server } : {}),
    ...(dataRoot !== undefined ? { dataRoot } : {}),
  };
  if (command === 'web') {
    if (words.length !== 1) fail('unexpected_positional_argument');
    return { kind: 'web', ...selection, json: has('--json') };
  }
  const action = words[1];
  if (words.length !== 2 || !['start', 'status', 'stop', 'restart'].includes(action ?? ''))
    fail('invalid_server_action');
  return {
    kind: 'server',
    action: action as 'start' | 'status' | 'stop' | 'restart',
    ...selection,
    ...(value('--workspace') !== undefined ? { workspace: value('--workspace') } : {}),
    json: has('--json'),
    cancel: has('--cancel'),
  };
}
