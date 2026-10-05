import { lstatSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { AgentClient, Command, QueryResponse } from '@kite-ai/client';
import {
  decodeTuiMcpSnapshot,
  type TuiMcpConnectionFact,
  type TuiMcpConnectionIntent,
  type TuiMcpConnectionOutcome,
  type TuiMcpConnectionPort,
  type TuiMcpSnapshot,
} from '@kite-ai/ui/tui';
import {
  createMcpConnectionRecord,
  mcpConnectionRecordIdentity,
  parseMcpConnectionIntent,
} from './mcp-connection-intents';
import type { McpConnectionJournal } from './mcp-connection-journal';
import { mcpCanonical, mcpSha } from './mcp-selection-intents';

const invalid = () => Error('mcp_connection_fact_invalid');
function closed(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !== [...keys].sort().join(',')
  )
    throw invalid();
  return value as Record<string, unknown>;
}
const obj = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
const id = (value: unknown) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const hash = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const text = (value: unknown, maximum: number) =>
  typeof value === 'string' && value.length > 0 && value.length <= maximum;
const statuses = [
  'planned',
  'dispatching',
  'running',
  'succeeded',
  'failed',
  'cancelled',
  'outcome_unknown',
];

/** Only the bounded original receipt projection crosses this caller boundary. */
export function decodeMcpConnectionFact(result: QueryResponse): TuiMcpConnectionFact {
  if (
    !Array.isArray(result) ||
    result.length !== 1 ||
    Buffer.byteLength(JSON.stringify(result)) > 16 * 1024
  )
    throw invalid();
  const display = closed(result[0], [
    'extensionId',
    'contentType',
    'contentVersion',
    'summary',
    'payload',
    'actions',
    'artifactRefs',
  ]);
  if (
    display.extensionId !== 'builtin.mcp' ||
    display.contentType !== 'builtin.mcp.connection' ||
    display.contentVersion !== 1 ||
    !text(display.summary, 512) ||
    !Array.isArray(display.actions) ||
    display.actions.length !== 0 ||
    !Array.isArray(display.artifactRefs) ||
    display.artifactRefs.length !== 0
  )
    throw invalid();
  const row = closed(display.payload, [
    'storeId',
    'sessionId',
    'execution',
    'phase',
    'operationRef',
    'connection',
    'ready',
    'live',
    'currentGeneration',
    'created',
    'reason',
  ]);
  const executionKeys = [
    'id',
    'originStoreId',
    'sessionId',
    'originCommandId',
    'parentExecutionId',
    'kind',
    'definitionId',
    'definitionVersion',
    'status',
  ];
  const execution = (value: unknown, action: boolean) => {
    const fact = closed(value, [...executionKeys, ...(action ? ['inputDigest'] : [])]);
    if (
      !id(fact.id) ||
      !id(fact.originStoreId) ||
      !id(fact.sessionId) ||
      !id(fact.originCommandId) ||
      (fact.parentExecutionId !== null && !id(fact.parentExecutionId)) ||
      fact.kind !== 'job' ||
      !text(fact.definitionId, 512) ||
      !text(fact.definitionVersion, 128) ||
      typeof fact.status !== 'string' ||
      !statuses.includes(fact.status) ||
      (action &&
        (!hash(fact.inputDigest) ||
          fact.definitionId !== 'builtin.mcp/mcp.connect' ||
          fact.definitionVersion !== '1'))
    )
      throw invalid();
    return fact;
  };
  execution(row.execution, true);
  if (row.connection !== null) execution(row.connection, false);
  if (row.operationRef !== null) {
    const raw = obj(row.operationRef);
    if (!raw) throw invalid();
    const ref = closed(raw, [
      'commandId',
      'sessionId',
      'originStoreId',
      'extensionId',
      'key',
      'executionId',
      ...(Object.hasOwn(raw, 'childSessionId') ? ['childSessionId'] : []),
    ]);
    if (
      !id(ref.commandId) ||
      !id(ref.sessionId) ||
      !id(ref.originStoreId) ||
      ref.extensionId !== 'builtin.mcp' ||
      typeof ref.key !== 'string' ||
      !/^connection\/[A-Za-z0-9_-]{1,128}\/[A-Za-z0-9_-]{1,64}$/.test(ref.key) ||
      (ref.executionId !== null && !id(ref.executionId)) ||
      (Object.hasOwn(ref, 'childSessionId') && !id(ref.childSessionId))
    )
      throw invalid();
  }
  if (row.ready !== null) {
    const ready = closed(row.ready, ['serverId', 'configDigest', 'generation', 'toolCount']);
    if (
      !id(ready.serverId) ||
      !hash(ready.configDigest) ||
      !Number.isSafeInteger(ready.generation) ||
      Number(ready.generation) < 1 ||
      !Number.isSafeInteger(ready.toolCount) ||
      Number(ready.toolCount) < 0 ||
      Number(ready.toolCount) > 16384
    )
      throw invalid();
  }
  if (
    !id(row.storeId) ||
    !id(row.sessionId) ||
    typeof row.phase !== 'string' ||
    !['pending', 'ready', 'failed', 'outcome_unknown'].includes(row.phase) ||
    typeof row.live !== 'boolean' ||
    (row.currentGeneration !== null &&
      (!Number.isSafeInteger(row.currentGeneration) || Number(row.currentGeneration) < 1)) ||
    (row.created !== null && typeof row.created !== 'boolean') ||
    (row.reason !== null &&
      (typeof row.reason !== 'string' || !/^[a-z][a-z0-9_]{0,127}$/.test(row.reason))) ||
    (row.live && row.currentGeneration === null) ||
    (!row.live && row.currentGeneration !== null) ||
    (row.phase === 'ready' &&
      (row.ready === null || row.connection === null || row.operationRef === null)) ||
    (row.phase !== 'ready' && row.ready !== null)
  )
    throw invalid();
  return structuredClone(row) as unknown as TuiMcpConnectionFact;
}

type ConnectionClient = Pick<
  AgentClient,
  | 'queryExtension'
  | 'invokeExtension'
  | 'getCommand'
  | 'serverInfo'
  | 'getView'
  | 'listAllWorkspaces'
>;

export function createTuiMcpConnectionPort(
  client: ConnectionClient,
  storeId: string,
  journal: McpConnectionJournal,
): TuiMcpConnectionPort {
  const subject = () => client.serverInfo?.subjectId;
  const admission = (intent: TuiMcpConnectionIntent, signal?: AbortSignal) => {
    signal?.throwIfAborted();
    if (
      intent.request.expectedStoreId !== storeId ||
      client.serverInfo?.storeId !== storeId ||
      !subject()
    )
      throw Error('mcp_connection_scope_unavailable');
  };
  const stored = (intent: TuiMcpConnectionIntent, signal?: AbortSignal) => {
    admission(intent, signal);
    const expected = createMcpConnectionRecord(intent, subject()!);
    const record = journal
      .list()
      .find((row) => row.intent.request.commandId === intent.request.commandId);
    if (!record || mcpConnectionRecordIdentity(record) !== mcpConnectionRecordIdentity(expected))
      throw Error('mcp_connection_original_unavailable');
    return record;
  };
  const original = (intent: TuiMcpConnectionIntent, command: Command) => {
    admission(intent);
    const { commandId: _commandId, expectedStoreId: _storeId, ...request } = intent.request;
    if (
      command.id !== intent.request.commandId ||
      command.originStoreId !== storeId ||
      command.sessionId !== intent.sessionId ||
      command.subjectId !== subject() ||
      command.kind !== 'extension.invoke' ||
      command.requestDigest !== mcpSha(request)
    )
      throw Error('mcp_connection_original_command_mismatch');
  };
  async function scope(intent: TuiMcpConnectionIntent, observed: TuiMcpSnapshot) {
    admission(intent);
    const view = await client.getView(intent.sessionId);
    admission(intent);
    if (
      view.storeId !== storeId ||
      view.session.id !== intent.sessionId ||
      view.session.workspaceId !== intent.workspaceId ||
      view.session.deletedAt !== null
    )
      throw Error('mcp_connection_scope_unavailable');
    const workspace = (await client.listAllWorkspaces()).find(
      (row) => row.id === intent.workspaceId,
    );
    admission(intent);
    if (!workspace) throw Error('mcp_connection_scope_unavailable');
    const uri = new URL(workspace.rootUri);
    if (uri.protocol !== 'file:' || (uri.hostname && uri.hostname !== 'localhost'))
      throw Error('mcp_connection_scope_unavailable');
    const path = fileURLToPath(uri),
      stat = lstatSync(path, { bigint: true });
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      mcpCanonical({ root: realpathSync(path), dev: String(stat.dev), ino: String(stat.ino) }) !==
        intent.workspaceIdentity
    )
      throw Error('mcp_connection_workspace_changed');
    const fresh = decodeTuiMcpSnapshot(
      await client.queryExtension(intent.sessionId, 'builtin.mcp.management', 'mcp.servers', {}),
    );
    admission(intent);
    const server = fresh.items.find((row) => row.id === intent.request.input.serverId);
    if (
      fresh.storeId !== storeId ||
      fresh.sessionId !== intent.sessionId ||
      fresh.workspaceId !== intent.workspaceId ||
      fresh.workspaceIdentity !== intent.workspaceIdentity ||
      mcpCanonical(fresh) !== mcpCanonical(observed) ||
      !server?.admitted ||
      !server.selected ||
      !server.available
    )
      throw Error('mcp_connection_source_changed');
  }
  async function outcome(
    intent: TuiMcpConnectionIntent,
    signal?: AbortSignal,
  ): Promise<TuiMcpConnectionOutcome> {
    stored(intent, signal);
    const command = await client.getCommand(intent.request.commandId, { signal });
    stored(intent, signal);
    original(intent, command);
    if (command.status === 'rejected') return { intent, phase: 'failed', command };
    if (command.status !== 'applied')
      return {
        intent,
        phase: command.status === 'accepted' ? 'pending' : 'outcome_unknown',
        command,
      };
    const executionId = obj(command.receipt)?.executionId;
    if (!id(executionId)) throw Error('mcp_connection_original_execution_unavailable');
    const fact = decodeMcpConnectionFact(
      await client.queryExtension(
        intent.sessionId,
        'builtin.mcp',
        'mcp.connection',
        { executionId: executionId as string, ...intent.request.input },
        { signal },
      ),
    );
    stored(intent, signal);
    const action = fact.execution;
    if (
      fact.storeId !== storeId ||
      fact.sessionId !== intent.sessionId ||
      action.id !== executionId ||
      action.originStoreId !== storeId ||
      action.sessionId !== intent.sessionId ||
      action.originCommandId !== command.id ||
      action.parentExecutionId !== null ||
      action.inputDigest !== mcpSha(intent.request.input)
    )
      throw Error('mcp_connection_original_execution_mismatch');
    const ref = fact.operationRef,
      connection = fact.connection,
      ready = fact.ready;
    if (ref) {
      if (
        ref.originStoreId !== storeId ||
        ref.sessionId !== intent.sessionId ||
        ref.childSessionId !== undefined ||
        !ref.key.startsWith(`connection/${intent.request.input.serverId}/`) ||
        (connection &&
          (connection.id !== ref.executionId ||
            connection.originCommandId !== ref.commandId ||
            connection.originStoreId !== storeId ||
            connection.sessionId !== intent.sessionId ||
            !connection.parentExecutionId))
      )
        throw Error('mcp_connection_original_operation_mismatch');
    } else if (connection || fact.created !== null || fact.live)
      throw Error('mcp_connection_original_operation_mismatch');
    if (connection) {
      if (!ref) throw Error('mcp_connection_original_operation_mismatch');
      const scoped =
        connection.definitionId === 'mcp.source.connection' && connection.definitionVersion === '1';
      const fixed =
        connection.definitionId === `mcp.connection.${intent.request.input.serverId}` &&
        hash(connection.definitionVersion) &&
        (!ready || connection.definitionVersion === ready.configDigest);
      if (!scoped && !fixed) throw Error('mcp_connection_original_operation_mismatch');
      const created =
        ref.key === `connection/${intent.request.input.serverId}/${intent.request.input.key}` &&
        connection.parentExecutionId === action.id;
      if (fact.created !== null && fact.created !== created)
        throw Error('mcp_connection_original_operation_mismatch');
    } else if (fact.created !== null || fact.live)
      throw Error('mcp_connection_original_operation_mismatch');
    if (
      (fact.phase === 'ready' &&
        (action.status !== 'succeeded' ||
          ready?.serverId !== intent.request.input.serverId ||
          fact.created === null)) ||
      (fact.phase === 'pending' &&
        !['planned', 'dispatching', 'running'].includes(action.status)) ||
      (fact.phase === 'failed' &&
        (ref !== null || !['failed', 'cancelled'].includes(action.status)))
    )
      throw Error('mcp_connection_original_outcome_mismatch');
    return { intent, phase: fact.phase, command, fact };
  }
  const port: TuiMcpConnectionPort = {
    async list() {
      return journal
        .list()
        .map((row) => ({ intent: row.intent, phase: 'outcome_unknown' as const }));
    },
    async submit(raw, observed) {
      const intent = parseMcpConnectionIntent(raw);
      let prepared: ReturnType<typeof createMcpConnectionRecord> | undefined;
      try {
        admission(intent);
        const record = createMcpConnectionRecord(intent, subject()!);
        const existing = journal
          .list()
          .find((row) => row.intent.request.commandId === intent.request.commandId);
        if (existing) {
          if (mcpConnectionRecordIdentity(existing) !== mcpConnectionRecordIdentity(record))
            throw Error('mcp_connection_intent_conflict');
          return await port.lookup(intent, new AbortController().signal);
        }
        await scope(intent, observed);
        if (!journal.prepare(record))
          return await port.lookup(intent, new AbortController().signal);
        prepared = record;
        // Only this successful in-process preparation permits the original first POST.
        admission(intent);
        if (subject() !== record.subjectId) throw Error('mcp_connection_subject_changed');
        const command = await client.invokeExtension(intent.sessionId, intent.request);
        original(intent, command);
        const result = await outcome(intent);
        journal.record(record, result.phase);
        return result;
      } catch {
        if (prepared) {
          try {
            journal.record(prepared, 'outcome_unknown');
          } catch {}
        }
        return { intent, phase: 'outcome_unknown' };
      }
    },
    async lookup(raw, signal) {
      const intent = parseMcpConnectionIntent(raw);
      try {
        const record = stored(intent, signal);
        const result = await outcome(intent, signal);
        signal.throwIfAborted();
        journal.record(record, result.phase);
        return result;
      } catch {
        return { intent, phase: 'outcome_unknown' };
      }
    },
  };
  return port;
}
