/**
 * Test Workspace — temporary isolated environment for PTY system tests.
 *
 * Each PTY test gets its own:
 * - Temp HOME directory with minimal kite-code.jsonc config
 * - Temp workspace directory (for file operations)
 * - Temp checkpoint database path (isolated SQLite)
 *
 * Reuses the temp-home isolation pattern previously used by the old TUI harness.
 */

import { Database } from 'bun:sqlite';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sqliteRuntimeStorePath } from '@kite/runtime-storage-sqlite';

export interface TestWorkspace {
  /** Temp HOME directory */
  home: string;
  /** Temp workspace directory */
  workspace: string;
  /** Path to kite-code.jsonc config */
  configPath: string;
  /** Environment variables to pass to child process */
  env: Record<string, string>;
  /** Additional config fields merged into generated test config */
  configOverrides?: Record<string, unknown>;
  /** Optional project-only overrides; defaults to configOverrides for compatibility. */
  projectConfigOverrides?: Record<string, unknown>;
  /** true 时 spawnTui 不预写信任记录，workspace trust 门禁会在启动时触发 */
  enforceWorkspaceTrust?: boolean;
  /** Remove all temp directories */
  cleanup(): void;
}

type PersistedSessionRow = {
  thread_id: string;
  name: string;
};

export type PersistedRuntimeObservation<T> =
  | { status: 'ready'; path: string; value: T }
  | { status: 'not_created'; path: string }
  | { status: 'initializing'; path: string; detail: string }
  | { status: 'transient_lock'; path: string; detail: string };

export function requirePersistedRuntimeReady<T>(observation: PersistedRuntimeObservation<T>): T {
  if (observation.status === 'ready') return observation.value;
  throw new Error(`Runtime Store observation is ${observation.status} at ${observation.path}`);
}

/** Read plan artifacts from the isolated child HOME as durable side-effect evidence. */
export function readPersistedPlanArtifacts(
  workspace: Pick<TestWorkspace, 'home'>,
): Array<{ path: string; content: string }> {
  const root = join(workspace.home, '.kite-code', 'plans');
  if (!existsSync(root)) return [];
  return readdirSync(root, { recursive: true, encoding: 'utf8' })
    .filter((path) => path.endsWith('.md'))
    .sort()
    .map((relativePath) => {
      const path = join(root, relativePath);
      return { path, content: readFileSync(path, 'utf8') };
    });
}

function persistedRuntimeObservationFailure(
  error: unknown,
): Extract<
  PersistedRuntimeObservation<never>,
  { status: 'initializing' | 'transient_lock' }
> | null {
  const errorRecord = typeof error === 'object' && error !== null ? error : undefined;
  const code = errorRecord && 'code' in errorRecord ? String(errorRecord.code) : undefined;
  const errno =
    errorRecord && 'errno' in errorRecord && typeof errorRecord.errno === 'number'
      ? errorRecord.errno & 0xff
      : undefined;
  const message = error instanceof Error ? error.message : '';
  if (
    code === 'SQLITE_BUSY' ||
    code === 'SQLITE_LOCKED' ||
    code === 'SQLITE_PROTOCOL' ||
    errno === 5 ||
    errno === 6 ||
    errno === 15
  ) {
    return { status: 'transient_lock', path: '', detail: message || code || 'SQLite lock' };
  }
  if (/^no such table: runtime_(?:sessions|events)$/.test(message)) {
    return { status: 'initializing', path: '', detail: message };
  }
  return null;
}

function persistedRuntimePath(workspace: Pick<TestWorkspace, 'home'>): string {
  return sqliteRuntimeStorePath(join(workspace.home, '.kite-code', 'checkpoints.sqlite'));
}

/**
 * Observe the child Runtime Store without running production initialization.
 * Polling helpers must never execute journal/schema writes against the system
 * under test: on slower hosts that can contend with or starve the real writer.
 */
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
    const failure = persistedRuntimeObservationFailure(error);
    if (failure) return { ...failure, path };
    throw new Error(`Failed to observe isolated Runtime Store at ${path}`, { cause: error });
  } finally {
    database?.close();
  }
}

/** Read the durable Runtime session identities without relying on terminal scrollback. */
export function observePersistedSessionIds(
  workspace: Pick<TestWorkspace, 'home'>,
): PersistedRuntimeObservation<string[]> {
  return readPersistedRuntime(workspace, (database) =>
    database
      .query<{ thread_id: string }, []>(
        'SELECT session_id AS thread_id FROM runtime_sessions ORDER BY session_id ASC',
      )
      .all()
      .map((session) => session.thread_id),
  );
}

/** Read durable session identity/name pairs in the same recency order used by SessionSelector. */
export function observePersistedSessionSummaries(
  workspace: Pick<TestWorkspace, 'home'>,
): PersistedRuntimeObservation<Array<{ threadId: string; name: string }>> {
  return readPersistedRuntime(workspace, (database) =>
    database
      .query<PersistedSessionRow, []>(`
        SELECT
          session.session_id AS thread_id,
          COALESCE(
            NULLIF(session.name, ''),
            NULLIF((
              SELECT json_extract(event.event_json, '$.content')
              FROM runtime_events event
              WHERE event.session_id = session.session_id
                AND json_extract(event.event_json, '$.type') = 'user.message_appended'
              ORDER BY event.sequence ASC
              LIMIT 1
            ), ''),
            session.session_id
          ) AS name
        FROM runtime_sessions session
        ORDER BY session.updated_at DESC
        LIMIT 50
      `)
      .all()
      .map(({ thread_id: threadId, name }) => ({ threadId, name })),
  );
}

/** Resolve the exact session carrying a durable slash-command audit event. */
export function observePersistedCommandSession(
  workspace: Pick<TestWorkspace, 'home'>,
  command: string,
): PersistedRuntimeObservation<{ threadId: string; name: string } | undefined> {
  return readPersistedRuntime(workspace, (database) => {
    const row = database
      .query<PersistedSessionRow, [string]>(`
        SELECT
          session.session_id AS thread_id,
          COALESCE(
            NULLIF(session.name, ''),
            NULLIF((
              SELECT json_extract(first_event.event_json, '$.content')
              FROM runtime_events first_event
              WHERE first_event.session_id = session.session_id
                AND json_extract(first_event.event_json, '$.type') = 'user.message_appended'
              ORDER BY first_event.sequence ASC
              LIMIT 1
            ), ''),
            session.session_id
          ) AS name
        FROM runtime_events command_event
        JOIN runtime_sessions session ON session.session_id = command_event.session_id
        WHERE json_extract(command_event.event_json, '$.type') = 'user.command_invoked'
          AND json_extract(command_event.event_json, '$.command') = ?
        ORDER BY command_event.sequence DESC
        LIMIT 1
      `)
      .get(command);
    return row ? { threadId: row.thread_id, name: row.name } : undefined;
  });
}

/** Resolve the exact session carrying a durable user message event. */
export function observePersistedUserMessageSession(
  workspace: Pick<TestWorkspace, 'home'>,
  content: string,
): PersistedRuntimeObservation<{ threadId: string } | undefined> {
  return readPersistedRuntime(workspace, (database) => {
    const row = database
      .query<{ thread_id: string }, [string]>(`
        SELECT session_id AS thread_id
        FROM runtime_events
        WHERE json_extract(event_json, '$.type') = 'user.message_appended'
          AND json_extract(event_json, '$.content') = ?
        ORDER BY sequence DESC
        LIMIT 1
      `)
      .get(content);
    return row ? { threadId: row.thread_id } : undefined;
  });
}

export type PersistedTurnEvent = {
  type: string;
  turnId?: string;
  [field: string]: unknown;
};

/**
 * Read one exact user turn from the isolated child Runtime Store. The observer
 * resolves the session from the durable user message, then resolves that
 * message's next durable turn start before reading its ordered event window.
 */
export function observePersistedTurnEvents(
  workspace: Pick<TestWorkspace, 'home'>,
  userMessage: string,
): PersistedRuntimeObservation<
  { threadId: string; turnId: string; events: PersistedTurnEvent[] } | undefined
> {
  return readPersistedRuntime(workspace, (database) => {
    const message = database
      .query<{ thread_id: string; id: number }, [string]>(`
        SELECT session_id AS thread_id, sequence AS id
        FROM runtime_events
        WHERE json_extract(event_json, '$.type') = 'user.message_appended'
          AND json_extract(event_json, '$.content') = ?
        ORDER BY sequence DESC
        LIMIT 1
      `)
      .get(userMessage);
    if (!message) return undefined;

    const turn = database
      .query<{ id: number; turn_id: string | null }, [string, number]>(`
        SELECT sequence AS id, json_extract(event_json, '$.turnId') AS turn_id
        FROM runtime_events
        WHERE session_id = ?
          AND sequence > ?
          AND json_extract(event_json, '$.type') = 'turn.started'
        ORDER BY sequence ASC
        LIMIT 1
      `)
      .get(message.thread_id, message.id);
    if (!turn?.turn_id) return undefined;

    const nextTurn = database
      .query<{ id: number }, [string, number]>(`
        SELECT sequence AS id
        FROM runtime_events
        WHERE session_id = ?
          AND sequence > ?
          AND json_extract(event_json, '$.type') = 'turn.started'
        ORDER BY sequence ASC
        LIMIT 1
      `)
      .get(message.thread_id, turn.id);
    const events = database
      .query<{ event_json: string }, [string, number, number]>(`
        SELECT event_json
        FROM runtime_events
        WHERE session_id = ?
          AND sequence >= ?
          AND sequence < ?
        ORDER BY sequence ASC
      `)
      .all(message.thread_id, turn.id, nextTurn?.id ?? Number.MAX_SAFE_INTEGER)
      .map(({ event_json }) => {
        const event: unknown = JSON.parse(event_json);
        if (
          typeof event !== 'object' ||
          event === null ||
          !('type' in event) ||
          typeof event.type !== 'string'
        ) {
          throw new Error('Persisted Runtime event is not valid');
        }
        return event as PersistedTurnEvent;
      });
    return { threadId: message.thread_id, turnId: turn.turn_id, events };
  });
}

/**
 * Create a fully isolated test environment.
 *
 * Creates:
 * - <tmp>/kite-code-e2e-<random>/.kite-code/kite-code.jsonc
 * - <tmp>/kite-code-ws-<random>/ (workspace)
 *
 * The returned `env` object should be spread into the child process's env.
 */
export function createTestWorkspace(opts?: {
  files?: Record<string, string>; // path → content, created in workspace
  workspaceFiles?: Record<string, string>;
  configOverrides?: Record<string, unknown>;
  projectConfigOverrides?: Record<string, unknown>;
  projectMcpServers?: Record<string, unknown>;
  /**
   * 默认由 spawnTui 向临时信任存储预写一条 source:'test' 记录，启动目录按
   * 生产环境的"已信任"快速路径放行，避免每个 PTY 场景卡在启动授权界面。
   * 设为 true 时不预写，门禁在启动时触发，用于验证门禁本身的场景。
   * 注意：不使用环境变量旁路——Bun 会自动注入 `<cwd>/.env*`，env 开关可被
   * workspace 内文件伪造（见 docs/active/workspace-trust.md）。
   */
  enforceWorkspaceTrust?: boolean;
}): TestWorkspace {
  const tempHome = realpathSync(mkdtempSync(join(tmpdir(), 'kite-code-e2e-')));
  const kiteCodeDir = join(tempHome, '.kite-code');
  mkdirSync(kiteCodeDir, { recursive: true });

  // Minimal config pointing to a fake DeepSeek provider.
  // In PTY tests, the model will be overridden by the mock model server
  // or env-var-injected mock model.
  const normalizedConfigOverrides: Record<string, unknown> = {
    // PTY scenarios assert localized copy. Pin their isolated user preference
    // so the same scenario does not change language with the host OS locale.
    language: 'zh-CN',
    ...(opts?.configOverrides ?? {}),
  };
  const { mcpServers: userMcpServers, ...configOverrides } = normalizedConfigOverrides;
  const config = {
    provider: {
      deepseek: {
        type: 'deepseek' as const,
        apiKey: 'test-key',
        baseURL: 'https://test.api.example.com',
      },
    },
    model: {
      default: { provider: 'deepseek' as const, name: 'deepseek-v4-flash' },
    },
    ...configOverrides,
  };
  writeFileSync(join(kiteCodeDir, 'kite-code.jsonc'), JSON.stringify(config, null, 2));
  if (userMcpServers && typeof userMcpServers === 'object') {
    writeFileSync(
      join(kiteCodeDir, 'mcp.json'),
      `${JSON.stringify({ mcpServers: userMcpServers }, null, 2)}\n`,
      'utf-8',
    );
  }

  const ws = realpathSync(mkdtempSync(join(tmpdir(), 'kite-code-ws-')));
  const files = opts?.files ?? opts?.workspaceFiles;
  if (files) {
    for (const [relPath, content] of Object.entries(files)) {
      const fullPath = join(ws, relPath);
      const parent = fullPath.replace(/[/\\][^/\\]+$/, '');
      mkdirSync(parent, { recursive: true });
      writeFileSync(fullPath, content, 'utf-8');
    }
  }
  if (opts?.projectMcpServers) {
    const projectKiteCodeDir = join(ws, '.kite-code');
    mkdirSync(projectKiteCodeDir, { recursive: true });
    writeFileSync(
      join(projectKiteCodeDir, 'mcp.json'),
      `${JSON.stringify({ mcpServers: opts.projectMcpServers }, null, 2)}\n`,
      'utf-8',
    );
  }

  const env: Record<string, string> = {
    HOME: tempHome,
    KITE_CODE_HOME: tempHome,
    // Override checkpoint path to use temp dir
    // (the TUI reads this via defaultCheckpointPath() which uses KITE_CODE_HOME)
  };

  const configPath = join(kiteCodeDir, 'kite-code.jsonc');

  const cleanup = () => {
    const errors: unknown[] = [];
    for (const path of [tempHome, ws]) {
      try {
        rmSync(path, { recursive: true, force: true });
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0) throw new AggregateError(errors, 'Failed to clean TUI test workspace');
  };

  return {
    home: tempHome,
    workspace: ws,
    configPath,
    env,
    configOverrides,
    projectConfigOverrides: opts?.projectConfigOverrides,
    enforceWorkspaceTrust: opts?.enforceWorkspaceTrust ?? false,
    cleanup,
  };
}
