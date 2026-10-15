import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { selectProfile } from '@kite-ai/agent/profile';

export interface TestWorkspace {
  home: string;
  workspace: string;
  configPath: string;
  dataRoot: string;
  profile: 'development';
  profilePath: string;
  databasePath: string;
  env: Record<string, string>;
  configOverrides?: Record<string, unknown>;
  projectConfigOverrides?: Record<string, unknown>;
  permissionMode: 'accept_edits' | 'auto' | 'full';
  enforceWorkspaceTrust?: boolean;
  cleanup(): void;
}
export type PersistedRuntimeObservation<T> =
  | { status: 'ready'; path: string; value: T }
  | { status: 'not_created'; path: string }
  | { status: 'initializing' | 'transient_lock'; path: string; detail: string };
export type PersistedTurnEvent = { type: string; turnId?: string; [field: string]: unknown };
type Row = Record<string, string | number | null>;
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
export function requirePersistedRuntimeReady<T>(value: PersistedRuntimeObservation<T>): T {
  if (value.status === 'ready') return value.value;
  throw Error(`Runtime Store observation is ${value.status} at ${value.path}`);
}
export function persistedRuntimePath(workspace: Pick<TestWorkspace, 'home'>): string {
  return selectProfile({ dataRoot: join(workspace.home, '.kite-code'), profile: 'development' })
    .databasePath;
}
function readPersistedRuntime<T>(
  workspace: Pick<TestWorkspace, 'home'>,
  read: (database: Database) => T,
): PersistedRuntimeObservation<T> {
  const path = persistedRuntimePath(workspace);
  if (!existsSync(path)) return { status: 'not_created', path };
  let database: Database | undefined;
  try {
    database = new Database(path, { readonly: true });
    return { status: 'ready', path, value: read(database) };
  } catch (error) {
    const code = (error as { code?: string }).code;
    const errno = (error as { errno?: number }).errno;
    const detail = error instanceof Error ? error.message : String(error);
    if (
      ['SQLITE_BUSY', 'SQLITE_LOCKED', 'SQLITE_PROTOCOL'].includes(code ?? '') ||
      (typeof errno === 'number' && [5, 6, 15].includes(errno & 0xff))
    )
      return { status: 'transient_lock', path, detail };
    if (
      /^no such table: (session|message|message_part|run|command|change_event|extension_record)$/.test(
        detail,
      )
    )
      return { status: 'initializing', path, detail };
    throw Error(`Failed to observe isolated Runtime Store at ${path}`, { cause: error });
  } finally {
    database?.close();
  }
}
export function observePersistedSessionIds(
  workspace: Pick<TestWorkspace, 'home'>,
): PersistedRuntimeObservation<string[]> {
  return readPersistedRuntime(workspace, (database) =>
    database
      .query<{ id: string }, []>('SELECT id FROM session WHERE deleted_at IS NULL ORDER BY id')
      .all()
      .map((row) => row.id),
  );
}
const sessionNames = `SELECT s.id AS threadId,COALESCE(NULLIF(s.title,''),NULLIF((SELECT json_extract(p.json,'$.content') FROM message m JOIN message_part p ON p.message_id=m.id AND p.ordinal=0 WHERE m.session_id=s.id AND m.role='user' ORDER BY m.seq LIMIT 1),''),s.id) AS name FROM session s`;
export function observePersistedSessionSummaries(
  workspace: Pick<TestWorkspace, 'home'>,
): PersistedRuntimeObservation<Array<{ threadId: string; name: string }>> {
  return readPersistedRuntime(workspace, (database) =>
    database
      .query<{ threadId: string; name: string }, []>(
        sessionNames +
          ' WHERE s.deleted_at IS NULL ORDER BY (SELECT MAX(cursor) FROM change_event WHERE scope_session_id=s.id) DESC,s.id LIMIT 50',
      )
      .all(),
  );
}
function matchingCommand(database: Database, command: string, sessionId?: string): Row | null {
  // Core stores the actual operation request, not a literal terminal slash audit.
  // Only this exact request vocabulary has an unambiguous original equivalent.
  const compact = /^\/compact(?: (.*))?$/.exec(command);
  if (!compact) return null;
  return database
    .query<Row, [string, string, string]>(
      `SELECT c.*,e.cursor FROM command c JOIN change_event e ON e.object_id=c.id AND e.scope_session_id=c.session_id AND e.type='command.accepted' WHERE c.kind='context.compress' AND COALESCE(json_extract(c.request_json,'$.focus'),'')=? AND (?='' OR c.session_id=?) ORDER BY e.cursor DESC LIMIT 1`,
    )
    .get(compact[1] ?? '', sessionId ?? '', sessionId ?? '');
}
export function observePersistedCommandSession(
  workspace: Pick<TestWorkspace, 'home'>,
  command: string,
): PersistedRuntimeObservation<{ threadId: string; name: string } | undefined> {
  return readPersistedRuntime(workspace, (database) => {
    const commandRow = matchingCommand(database, command);
    if (!commandRow) return undefined;
    return (
      database
        .query<{ threadId: string; name: string }, [string]>(`${sessionNames} WHERE s.id=?`)
        .get(String(commandRow.session_id)) ?? undefined
    );
  });
}
function eventRows(database: Database, sessionId: string, after = 0): PersistedTurnEvent[] {
  const rows = database
    .query<Row, [string, number]>(
      'SELECT * FROM change_event WHERE scope_session_id=? AND cursor>=? ORDER BY cursor',
    )
    .all(sessionId, after);
  return rows.map((row) => {
    const envelope = object(JSON.parse(String(row.payload_json)));
    const snapshot = object(envelope.snapshot),
      details = object(snapshot.details),
      payload = object(envelope.format === 'kite.session-log' ? envelope.payload : envelope);
    let runId = typeof details.runId === 'string' ? details.runId : undefined;
    const result: PersistedTurnEvent = {
      ...payload,
      type: String(row.type),
      sourceType: String(row.type),
      sourceCursor: String(row.cursor),
      objectId: String(row.object_id),
      ...(typeof snapshot.recordedStatus === 'string' ? { status: snapshot.recordedStatus } : {}),
      ...details,
    };
    if (String(row.type).startsWith('run.')) {
      runId = String(row.object_id);
      const run = database
        .query<Row, [string, string]>(
          'SELECT origin_command_id,reason FROM run WHERE id=? AND session_id=?',
        )
        .get(runId, sessionId);
      if (run) {
        result.originCommandId = run.origin_command_id;
        result.reason = run.reason;
      }
    }
    if (String(row.type) === 'command.accepted') {
      const command = database
        .query<Row, [string, string]>(
          'SELECT kind,request_json FROM command WHERE id=? AND session_id=?',
        )
        .get(String(row.object_id), sessionId);
      if (command) {
        result.kind = command.kind;
        result.request = JSON.parse(String(command.request_json));
      }
    }
    // Only a recorded terminal Execution exposes its actual result. Earlier
    // events must not inherit a later outcome from the current database row.
    if (String(row.type) === 'execution.finished') {
      const execution = database
        .query<Row, [string, string]>('SELECT * FROM execution WHERE id=? AND session_id=?')
        .get(String(row.object_id), sessionId);
      if (execution && execution.state === snapshot.recordedStatus) {
        result.executionId = String(execution.id);
        result.kind = execution.kind;
        result.definitionId = execution.adapter_id;
        result.definitionVersion = execution.definition_version;
        result.callId = execution.call_id;
        result.parentExecutionId = execution.parent_execution_id;
        result.result =
          execution.result_json === null ? null : JSON.parse(String(execution.result_json));
        runId = execution.run_id === null ? runId : String(execution.run_id);
      }
    }
    if (String(row.type).startsWith('message.')) {
      const message = database
        .query<Row, [string, string]>(
          'SELECT m.*,p.json FROM message m JOIN message_part p ON p.message_id=m.id AND p.ordinal=0 WHERE m.id=? AND m.session_id=?',
        )
        .get(String(row.object_id), sessionId);
      if (message) {
        result.messageId = String(message.id);
        result.role = message.role;
        const body = object(JSON.parse(String(message.json)));
        result.content = body.content;
        result.toolCallId = body.toolCallId;
        runId = typeof message.run_id === 'string' ? message.run_id : runId;
      }
    }
    if (runId) result.turnId = runId;
    return result;
  });
}
export function observePersistedSessionCommandEvents(
  workspace: Pick<TestWorkspace, 'home'>,
  sessionId: string,
  command: string,
): PersistedRuntimeObservation<PersistedTurnEvent[] | undefined> {
  return readPersistedRuntime(workspace, (database) => {
    const row = matchingCommand(database, command, sessionId);
    return row ? eventRows(database, sessionId, Number(row.cursor)) : undefined;
  });
}
export function observePersistedSessionEvents(
  workspace: Pick<TestWorkspace, 'home'>,
  sessionId: string,
): PersistedRuntimeObservation<PersistedTurnEvent[]> {
  return readPersistedRuntime(workspace, (database) => eventRows(database, sessionId));
}
function userMessage(database: Database, content: string): Row | null {
  return database
    .query<Row, [string]>(
      `SELECT m.*,e.cursor FROM message m JOIN message_part p ON p.message_id=m.id AND p.ordinal=0 JOIN change_event e ON e.object_id=m.id AND e.scope_session_id=m.session_id AND e.type='message.updated' WHERE m.role='user' AND json_extract(p.json,'$.content')=? ORDER BY e.cursor DESC LIMIT 1`,
    )
    .get(content);
}
export function observePersistedUserMessageSession(
  workspace: Pick<TestWorkspace, 'home'>,
  content: string,
): PersistedRuntimeObservation<{ threadId: string } | undefined> {
  return readPersistedRuntime(workspace, (database) => {
    const row = userMessage(database, content);
    return row ? { threadId: String(row.session_id) } : undefined;
  });
}
export function observePersistedTurnEvents(
  workspace: Pick<TestWorkspace, 'home'>,
  content: string,
): PersistedRuntimeObservation<
  { threadId: string; turnId: string; events: PersistedTurnEvent[] } | undefined
> {
  return readPersistedRuntime(workspace, (database) => {
    const message = userMessage(database, content);
    if (!message || typeof message.run_id !== 'string') return undefined;
    const run = database
      .query<Row, [string, string]>('SELECT * FROM run WHERE id=? AND session_id=?')
      .get(message.run_id, String(message.session_id));
    if (!run) return undefined;
    const start = database
      .query<Row, [string, string]>(
        "SELECT cursor FROM change_event WHERE object_id=? AND scope_session_id=? AND type='run.started' ORDER BY cursor LIMIT 1",
      )
      .get(message.run_id, String(message.session_id));
    if (!start) return undefined;
    // Exact Run scope, not everything between adjacent user messages or Runs.
    const events = eventRows(database, String(message.session_id), Number(start.cursor)).filter(
      (event) => event.turnId === message.run_id,
    );
    return { threadId: String(message.session_id), turnId: message.run_id, events };
  });
}
export function readPersistedPlanArtifacts(workspace: Pick<TestWorkspace, 'home'>): Array<{
  path: string;
  content: string;
  title: string;
  planId: string;
  version: number;
  steps: unknown[];
}> {
  const observed = readPersistedRuntime(workspace, (database) =>
    database
      .query<Row, []>(
        "SELECT scope_id,key,content_type,content_version,json FROM extension_record WHERE extension_id='builtin.planning' AND scope_kind='session' AND key LIKE 'plan/%' ORDER BY scope_id,key",
      )
      .all()
      .map((row) => {
        if (row.content_type !== 'builtin.planning.record' || row.content_version !== 1)
          throw Error('planning_record_version_unavailable');
        const plan = object(JSON.parse(String(row.json)));
        if (
          plan.kind !== 'plan_document' ||
          typeof plan.body !== 'string' ||
          typeof plan.title !== 'string' ||
          typeof plan.planId !== 'string' ||
          typeof plan.version !== 'number' ||
          !Array.isArray(plan.steps)
        )
          throw Error('planning_record_source_unavailable');
        return {
          path: `${persistedRuntimePath(workspace)}#builtin.planning/${row.scope_id}/${row.key}`,
          content: plan.body,
          title: plan.title,
          planId: plan.planId,
          version: plan.version,
          steps: plan.steps,
        };
      }),
  );
  if (observed.status === 'not_created') return [];
  return requirePersistedRuntimeReady(observed);
}
export function translateOriginalTestConfig(input: Record<string, unknown> = {}) {
  const mode = input.interactionMode ?? 'accept_edits';
  if (!['accept_edits', 'auto', 'full'].includes(String(mode)))
    throw Error('test_permission_mode_invalid');
  const language = input.language ?? 'zh-CN';
  if (!['zh-CN', 'en-US', 'system'].includes(String(language)))
    throw Error('test_language_invalid');
  const provider = object(input.provider),
    selection = object(object(input.model).default);
  const providerId = typeof selection.provider === 'string' ? selection.provider : 'deepseek';
  const selectedProvider = object(provider[providerId]);
  const model = typeof selection.name === 'string' ? selection.name : 'deepseek-v4-flash';
  const id = typeof input.modelId === 'string' ? input.modelId : model;
  const configuration: Record<string, unknown> = {
    modelId: id,
    tools: [
      'files.read',
      'files.read_path',
      'files.write',
      'files.write_path',
      'files.edit',
      'files.edit_path',
      'files.list',
      'files.glob',
      'files.search',
      'shell.launch',
      'shell.execute',
      'shell.read',
      'shell.wait',
      'shell.stop',
      'ask_user',
      'task',
      'task.execute',
      'planning.read',
      'planning.write',
      'planning.update',
      'planning.review',
    ].map((id) => ({ id })),
    models: [
      {
        id,
        provider: 'compatible',
        model,
        baseURL:
          typeof selectedProvider.baseURL === 'string'
            ? selectedProvider.baseURL
            : 'http://127.0.0.1:1/v1',
        ...(input.thinkingMode !== undefined
          ? { options: { reasoningEffort: input.thinkingMode } }
          : {}),
      },
    ],
  };
  for (const key of ['modelId', 'models', 'tools', 'skills', 'mcp'])
    if (input[key] !== undefined) configuration[key] = input[key];
  return {
    configuration,
    permissionMode: mode as TestWorkspace['permissionMode'],
    language: language as 'zh-CN' | 'en-US' | 'system',
  };
}
export function createTestWorkspace(opts?: {
  files?: Record<string, string>;
  workspaceFiles?: Record<string, string>;
  configOverrides?: Record<string, unknown>;
  projectConfigOverrides?: Record<string, unknown>;
  projectMcpServers?: Record<string, unknown>;
  enforceWorkspaceTrust?: boolean;
}): TestWorkspace {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'kite-code-e2e-'))),
    workspace = realpathSync(mkdtempSync(join(tmpdir(), 'kite-code-ws-')));
  const profile = selectProfile({ dataRoot: join(home, '.kite-code'), profile: 'development' });
  const translated = translateOriginalTestConfig(opts?.configOverrides);
  mkdirSync(join(profile.profilePath, 'ui'), { recursive: true, mode: 0o700 });
  const configPath = join(profile.profilePath, 'config.jsonc');
  writeFileSync(configPath, JSON.stringify(translated.configuration, null, 2), { mode: 0o600 });
  writeFileSync(
    join(profile.profilePath, 'ui', 'preferences.jsonc'),
    JSON.stringify({ language: translated.language, colorPreset: 'teal' }, null, 2),
    { mode: 0o600 },
  );
  for (const [path, content] of Object.entries(opts?.files ?? opts?.workspaceFiles ?? {})) {
    const target = join(workspace, path);
    mkdirSync(join(target, '..'), { recursive: true });
    writeFileSync(target, content);
  }
  const projectDirectory = join(workspace, '.kite-code');
  const projectInput = opts?.projectConfigOverrides ?? opts?.configOverrides;
  if (projectInput) {
    mkdirSync(projectDirectory, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(projectDirectory, 'config.jsonc'),
      JSON.stringify(translateOriginalTestConfig(projectInput).configuration, null, 2),
      { mode: 0o600 },
    );
  }
  const mcp = opts?.configOverrides?.mcpServers;
  if (mcp && typeof mcp === 'object')
    writeFileSync(
      join(profile.profilePath, 'mcp.json'),
      JSON.stringify({ mcpServers: mcp }, null, 2),
      { mode: 0o600 },
    );
  if (opts?.projectMcpServers) {
    mkdirSync(projectDirectory, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(projectDirectory, 'mcp.json'),
      JSON.stringify({ mcpServers: opts.projectMcpServers }, null, 2),
      { mode: 0o600 },
    );
  }
  return {
    home,
    workspace,
    configPath,
    dataRoot: profile.dataRoot,
    profile: 'development',
    profilePath: profile.profilePath,
    databasePath: profile.databasePath,
    env: {
      HOME: home,
      USERPROFILE: home,
      APPDATA: home,
      LOCALAPPDATA: home,
      KITE_CODE_HOME: profile.dataRoot,
      KITE_TUI_SYSTEM_DATA_ROOT: profile.dataRoot,
      KITE_TUI_SYSTEM_PROFILE: 'development',
    },
    configOverrides: opts?.configOverrides,
    projectConfigOverrides: opts?.projectConfigOverrides,
    permissionMode: translated.permissionMode,
    enforceWorkspaceTrust: opts?.enforceWorkspaceTrust ?? false,
    cleanup() {
      const errors: unknown[] = [];
      for (const path of [home, workspace])
        try {
          rmSync(path, { recursive: true, force: true });
        } catch (error) {
          errors.push(error);
        }
      if (errors.length) throw new AggregateError(errors, 'Failed to clean TUI test workspace');
    },
  };
}
