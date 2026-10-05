import { lstatSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { AgentClient, Command, QueryResponse } from '@kite-ai/client';
import {
  decodeTuiMcpSnapshot,
  type TuiMcpConnectionExecution,
  type TuiMcpReconnectionCarrier,
  type TuiMcpReconnectionFact,
  type TuiMcpReconnectionIntent,
  type TuiMcpReconnectionObservation,
  type TuiMcpReconnectionOutcome,
  type TuiMcpReconnectionPort,
  type TuiMcpReconnectionTarget,
  type TuiMcpSourceApprovalPort,
} from '@kite-ai/ui/tui';
import { createMcpConnectionRecord, mcpConnectionRecordIdentity } from './mcp-connection-intents';
import type { McpConnectionJournal } from './mcp-connection-journal';
import {
  createMcpReconnectionRecord,
  mcpReconnectionRecordIdentity,
  parseMcpReconnectionCarrier,
  parseMcpReconnectionIntent,
  parseMcpReconnectionTarget,
  reconnectionClosed,
} from './mcp-reconnection-intents';
import type { McpReconnectionJournal } from './mcp-reconnection-journal';
import { mcpCanonical, mcpSha } from './mcp-selection-intents';
import { createTuiMcpConnectionPort } from './tui-mcp-connection';

const invalid = () => Error('mcp_reconnection_fact_invalid');
const id = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const hash = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const text = (value: unknown, maximum: number) =>
  typeof value === 'string' && value.length > 0 && value.length <= maximum;
const generation = (value: unknown) => Number.isSafeInteger(value) && Number(value) > 0;
const terminal = ['succeeded', 'failed', 'cancelled', 'outcome_unknown'];
const statuses = ['planned', 'dispatching', 'running', ...terminal];
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
function projection(value: unknown, extra: 'inputDigest' | 'resultRevision' | null) {
  const row = reconnectionClosed(value, [...executionKeys, ...(extra ? [extra] : [])]);
  if (
    !id(row.id) ||
    !id(row.originStoreId) ||
    !id(row.sessionId) ||
    !id(row.originCommandId) ||
    (row.parentExecutionId !== null && !id(row.parentExecutionId)) ||
    row.kind !== 'job' ||
    !text(row.definitionId, 512) ||
    !text(row.definitionVersion, 128) ||
    typeof row.status !== 'string' ||
    !statuses.includes(row.status)
  )
    throw invalid();
  if (
    extra === 'inputDigest' &&
    (!hash(row.inputDigest) ||
      row.definitionId !== 'builtin.mcp/mcp.reconnect' ||
      row.definitionVersion !== '1')
  )
    throw invalid();
  if (
    extra === 'resultRevision' &&
    (typeof row.resultRevision !== 'string' ||
      !/^(0|[1-9][0-9]*)$/.test(row.resultRevision) ||
      BigInt(row.resultRevision) > 9223372036854775807n)
  )
    throw invalid();
  return row;
}
function operation(value: unknown) {
  const row = reconnectionClosed(value, [
    'commandId',
    'sessionId',
    'originStoreId',
    'extensionId',
    'key',
    'executionId',
  ]);
  if (
    !id(row.commandId) ||
    !id(row.sessionId) ||
    !id(row.originStoreId) ||
    row.extensionId !== 'builtin.mcp' ||
    typeof row.key !== 'string' ||
    !/^connection\/[A-Za-z0-9_-]{1,128}\/[A-Za-z0-9_-]{1,64}$/.test(row.key) ||
    !id(row.executionId)
  )
    throw invalid();
  return row;
}
/** One closed, finite original-result display. No caller reconstruction of producer input. */
export function decodeMcpReconnectionFact(result: QueryResponse): TuiMcpReconnectionFact {
  if (
    !Array.isArray(result) ||
    result.length !== 1 ||
    Buffer.byteLength(JSON.stringify(result)) > 16 * 1024
  )
    throw invalid();
  const display = reconnectionClosed(result[0], [
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
    display.contentType !== 'builtin.mcp.reconnection' ||
    display.contentVersion !== 1 ||
    !text(display.summary, 512) ||
    !Array.isArray(display.actions) ||
    display.actions.length ||
    !Array.isArray(display.artifactRefs) ||
    display.artifactRefs.length
  )
    throw invalid();
  const row = reconnectionClosed(display.payload, [
    'storeId',
    'sessionId',
    'execution',
    'phase',
    'target',
    'oldStop',
    'newOperationRef',
    'newConnection',
    'ready',
    'live',
    'currentGeneration',
    'reason',
  ]);
  projection(row.execution, 'inputDigest');
  if (row.target !== null) parseMcpReconnectionTarget(row.target);
  const stop = reconnectionClosed(row.oldStop, ['confirmed', 'execution']);
  if (typeof stop.confirmed !== 'boolean') throw invalid();
  if (stop.execution !== null) projection(stop.execution, 'resultRevision');
  if (
    stop.confirmed &&
    (stop.execution === null ||
      !['succeeded', 'failed', 'cancelled'].includes(
        String((stop.execution as Record<string, unknown>).status),
      ) ||
      (stop.execution as Record<string, unknown>).resultRevision === '0')
  )
    throw invalid();
  if (row.newOperationRef !== null) operation(row.newOperationRef);
  if (row.newConnection !== null) projection(row.newConnection, null);
  if (row.ready !== null) {
    const ready = reconnectionClosed(row.ready, [
      'serverId',
      'configDigest',
      'generation',
      'toolCount',
    ]);
    if (
      !id(ready.serverId) ||
      !hash(ready.configDigest) ||
      !generation(ready.generation) ||
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
    !['pending', 'ready', 'failed', 'cancelled', 'outcome_unknown'].includes(row.phase) ||
    typeof row.live !== 'boolean' ||
    (row.currentGeneration !== null && !generation(row.currentGeneration)) ||
    (row.reason !== null &&
      (typeof row.reason !== 'string' || !/^[a-z][a-z0-9_]{0,127}$/.test(row.reason))) ||
    row.live !== (row.currentGeneration !== null) ||
    (row.phase === 'ready' &&
      (!row.target ||
        !stop.confirmed ||
        !row.newOperationRef ||
        !row.newConnection ||
        !row.ready)) ||
    (row.phase !== 'ready' && row.ready !== null) ||
    (row.live && row.phase !== 'ready') ||
    (row.newConnection !== null && row.newOperationRef === null) ||
    (row.target === null &&
      (stop.confirmed ||
        stop.execution !== null ||
        row.newOperationRef !== null ||
        row.newConnection !== null))
  )
    throw invalid();
  return structuredClone(row) as unknown as TuiMcpReconnectionFact;
}

type ReconnectionClient = Pick<
  AgentClient,
  | 'queryExtension'
  | 'invokeExtension'
  | 'getCommand'
  | 'serverInfo'
  | 'getView'
  | 'listAllWorkspaces'
>;

export function createTuiMcpReconnectionPort(
  client: ReconnectionClient,
  storeId: string,
  journals: { connection: McpConnectionJournal; reconnection: McpReconnectionJournal },
  source?: Pick<TuiMcpSourceApprovalPort, 'read'>,
): TuiMcpReconnectionPort {
  const subject = () => client.serverInfo?.subjectId;
  const admission = (expectedStoreId: string, sessionId: string, signal?: AbortSignal) => {
    signal?.throwIfAborted();
    if (
      !id(sessionId) ||
      expectedStoreId !== storeId ||
      client.serverInfo?.storeId !== storeId ||
      !subject()
    )
      throw Error('mcp_reconnection_scope_unavailable');
  };
  const stored = (intent: TuiMcpReconnectionIntent, signal?: AbortSignal) => {
    admission(intent.request.expectedStoreId, intent.sessionId, signal);
    const expected = createMcpReconnectionRecord(intent, subject()!);
    const row = journals.reconnection
      .list()
      .find((record) => record.intent.request.commandId === intent.request.commandId);
    if (!row || mcpReconnectionRecordIdentity(row) !== mcpReconnectionRecordIdentity(expected))
      throw Error('mcp_reconnection_original_unavailable');
    return row;
  };
  const original = (intent: TuiMcpReconnectionIntent, command: Command) => {
    admission(intent.request.expectedStoreId, intent.sessionId);
    const { commandId: _commandId, expectedStoreId: _storeId, ...request } = intent.request;
    if (
      command.id !== intent.request.commandId ||
      command.originStoreId !== storeId ||
      command.sessionId !== intent.sessionId ||
      command.subjectId !== subject() ||
      command.kind !== 'extension.invoke' ||
      command.requestDigest !== mcpSha(request)
    )
      throw Error('mcp_reconnection_original_command_mismatch');
  };
  const connectionDefinition = (
    execution: TuiMcpConnectionExecution,
    serverId: string,
    digest: string,
  ) =>
    (execution.definitionId === 'mcp.source.connection' && execution.definitionVersion === '1') ||
    (execution.definitionId === `mcp.connection.${serverId}` &&
      execution.definitionVersion === digest);

  async function outcome(
    intent: TuiMcpReconnectionIntent,
    signal?: AbortSignal,
  ): Promise<TuiMcpReconnectionOutcome> {
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
    const receipt = command.receipt;
    const executionId =
      receipt && typeof receipt === 'object' && !Array.isArray(receipt)
        ? (receipt as Record<string, unknown>).executionId
        : null;
    if (!id(executionId)) throw Error('mcp_reconnection_original_execution_unavailable');
    const fact = decodeMcpReconnectionFact(
      await client.queryExtension(
        intent.sessionId,
        'builtin.mcp',
        'mcp.reconnection',
        { executionId },
        { signal },
      ),
    );
    stored(intent, signal);
    const action = fact.execution,
      input = intent.request.input;
    if (
      fact.storeId !== storeId ||
      fact.sessionId !== intent.sessionId ||
      action.id !== executionId ||
      action.originStoreId !== storeId ||
      action.sessionId !== intent.sessionId ||
      action.originCommandId !== command.id ||
      action.parentExecutionId !== null ||
      action.inputDigest !== mcpSha(input) ||
      (fact.target !== null && mcpCanonical(fact.target) !== mcpCanonical(input.target))
    )
      throw Error('mcp_reconnection_original_execution_mismatch');
    const old = fact.oldStop.execution;
    if (
      old &&
      (old.id !== input.target.connectionExecutionId ||
        old.originStoreId !== storeId ||
        old.sessionId !== intent.sessionId ||
        old.originCommandId !== input.target.operationRef.commandId ||
        !old.parentExecutionId ||
        !connectionDefinition(old, input.serverId, input.target.configDigest))
    )
      throw Error('mcp_reconnection_original_stop_mismatch');
    const ref = fact.newOperationRef,
      next = fact.newConnection,
      ready = fact.ready;
    if (
      ref &&
      (ref.originStoreId !== storeId ||
        ref.sessionId !== intent.sessionId ||
        ref.key !== `connection/${input.serverId}/${input.key}`)
    )
      throw Error('mcp_reconnection_original_operation_mismatch');
    if (
      next &&
      (!ref ||
        next.id !== ref.executionId ||
        next.originCommandId !== ref.commandId ||
        next.originStoreId !== storeId ||
        next.sessionId !== intent.sessionId ||
        next.parentExecutionId !== action.id ||
        !(input.replacement.kind === 'source'
          ? next.definitionId === 'mcp.source.connection' && next.definitionVersion === '1'
          : next.definitionId === `mcp.connection.${input.serverId}` &&
            next.definitionVersion === input.replacement.expectedConfigDigest))
    )
      throw Error('mcp_reconnection_original_operation_mismatch');
    if (
      (fact.phase === 'ready' &&
        (action.status !== 'succeeded' ||
          ready?.serverId !== input.serverId ||
          ready.configDigest !== input.replacement.expectedConfigDigest)) ||
      (fact.phase === 'pending' &&
        !['planned', 'dispatching', 'running'].includes(action.status)) ||
      (fact.phase === 'failed' && !['failed', 'cancelled'].includes(action.status)) ||
      (fact.phase === 'cancelled' && action.status !== 'cancelled')
    )
      throw Error('mcp_reconnection_original_outcome_mismatch');
    return { intent, phase: fact.phase, command, fact };
  }

  function ownCarrier(carrier: TuiMcpReconnectionCarrier, signal: AbortSignal) {
    admission(carrier.request.expectedStoreId, carrier.sessionId, signal);
    if (carrier.request.actionId === 'mcp.connect') {
      const expected = createMcpConnectionRecord(
        carrier as Parameters<typeof createMcpConnectionRecord>[0],
        subject()!,
      );
      const row = journals.connection
        .list()
        .find((record) => record.intent.request.commandId === carrier.request.commandId);
      if (!row || mcpConnectionRecordIdentity(row) !== mcpConnectionRecordIdentity(expected))
        throw Error('mcp_reconnection_carrier_unavailable');
      return row;
    }
    const row = journals.reconnection
      .list()
      .find((record) => record.intent.request.commandId === carrier.request.commandId);
    if (
      !row ||
      row.subjectId !== subject() ||
      mcpCanonical({
        sessionId: row.intent.sessionId,
        workspaceId: row.intent.workspaceId,
        workspaceIdentity: row.intent.workspaceIdentity,
        request: row.intent.request,
      }) !== mcpCanonical(carrier)
    )
      throw Error('mcp_reconnection_carrier_unavailable');
    return row;
  }
  async function observe(
    raw: TuiMcpReconnectionCarrier,
    signal: AbortSignal,
  ): Promise<TuiMcpReconnectionObservation> {
    const carrier = parseMcpReconnectionCarrier(raw);
    const row = ownCarrier(carrier, signal);
    const previous =
      carrier.request.actionId === 'mcp.connect'
        ? await createTuiMcpConnectionPort(client, storeId, journals.connection).lookup(
            row.intent as Parameters<typeof createMcpConnectionRecord>[0],
            signal,
          )
        : await outcome(row.intent as TuiMcpReconnectionIntent, signal);
    ownCarrier(carrier, signal);
    if (
      previous.phase !== 'ready' ||
      !previous.fact?.ready ||
      !previous.fact.live ||
      previous.fact.currentGeneration === null
    )
      throw Error('mcp_reconnection_live_target_required');
    const fact = previous.fact;
    const ref = 'newOperationRef' in fact ? fact.newOperationRef : fact.operationRef;
    const connection = 'newConnection' in fact ? fact.newConnection : fact.connection;
    if (
      !ref ||
      !id(ref.executionId) ||
      !connection ||
      ref.extensionId !== 'builtin.mcp' ||
      ('childSessionId' in ref && ref.childSessionId !== undefined)
    )
      throw Error('mcp_reconnection_live_target_required');
    const target: TuiMcpReconnectionTarget = {
      carrierExecutionId: fact.execution.id,
      carrierKey: carrier.request.input.key,
      operationRef: {
        commandId: ref.commandId,
        sessionId: ref.sessionId,
        originStoreId: ref.originStoreId,
        extensionId: 'builtin.mcp',
        key: ref.key,
        executionId: ref.executionId,
      },
      connectionExecutionId: connection.id,
      configDigest: fact.ready!.configDigest,
      currentGeneration: fact.currentGeneration!,
    };
    parseMcpReconnectionTarget(target);
    const view = await client.getView(carrier.sessionId, { signal });
    ownCarrier(carrier, signal);
    if (
      view.storeId !== storeId ||
      view.session.id !== carrier.sessionId ||
      view.session.workspaceId !== carrier.workspaceId ||
      view.session.deletedAt !== null
    )
      throw Error('mcp_reconnection_scope_unavailable');
    const workspace = (await client.listAllWorkspaces({ signal })).find(
      (value) => value.id === carrier.workspaceId,
    );
    ownCarrier(carrier, signal);
    if (!workspace) throw Error('mcp_reconnection_scope_unavailable');
    const uri = new URL(workspace.rootUri);
    if (uri.protocol !== 'file:' || (uri.hostname && uri.hostname !== 'localhost'))
      throw Error('mcp_reconnection_scope_unavailable');
    const path = fileURLToPath(uri),
      before = lstatSync(path, { bigint: true }),
      root = realpathSync(path),
      after = lstatSync(path, { bigint: true });
    const identity = mcpCanonical({ root, dev: String(before.dev), ino: String(before.ino) });
    if (
      !before.isDirectory() ||
      before.isSymbolicLink() ||
      !after.isDirectory() ||
      after.isSymbolicLink() ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      identity !== carrier.workspaceIdentity
    )
      throw Error('mcp_reconnection_workspace_changed');
    const management = decodeTuiMcpSnapshot(
      await client.queryExtension(
        carrier.sessionId,
        'builtin.mcp.management',
        'mcp.servers',
        {},
        { signal },
      ),
    );
    ownCarrier(carrier, signal);
    const server = management.items.find((value) => value.id === carrier.request.input.serverId);
    if (
      management.storeId !== storeId ||
      management.sessionId !== carrier.sessionId ||
      management.workspaceId !== carrier.workspaceId ||
      management.workspaceIdentity !== identity ||
      !server?.admitted ||
      !server.selected ||
      !server.available
    )
      throw Error('mcp_reconnection_replacement_unavailable');
    let replacement: TuiMcpReconnectionObservation['replacement'];
    let snapshot: TuiMcpReconnectionObservation['source'] = null;
    if (server.source.kind === 'programmatic') {
      replacement = { kind: 'static', expectedConfigDigest: server.configDigest };
    } else {
      if (!source) throw Error('mcp_reconnection_source_unavailable');
      snapshot = await source.read(carrier.sessionId, signal);
      ownCarrier(carrier, signal);
      const selected = snapshot.items.find((value) => value.id === server.id);
      if (
        snapshot.storeId !== storeId ||
        snapshot.sessionId !== carrier.sessionId ||
        snapshot.workspaceId !== carrier.workspaceId ||
        snapshot.workspaceIdentity !== identity ||
        !snapshot.readSet ||
        !selected?.admitted ||
        !selected.enabled ||
        selected.transport !== server.transport ||
        selected.transportDigest === null ||
        selected.configDigest !== server.configDigest ||
        selected.source.kind !== server.source.kind
      )
        throw Error('mcp_reconnection_source_changed');
      replacement = {
        kind: 'source',
        expectedConfigDigest: server.configDigest,
        expectedReadSet: snapshot.readSet,
      };
    }
    const final = lstatSync(path, { bigint: true });
    if (
      !final.isDirectory() ||
      final.isSymbolicLink() ||
      final.dev !== before.dev ||
      final.ino !== before.ino ||
      realpathSync(path) !== root
    )
      throw Error('mcp_reconnection_workspace_changed');
    ownCarrier(carrier, signal);
    return structuredClone({ carrier, target, replacement, management, source: snapshot });
  }

  const port: TuiMcpReconnectionPort = {
    async list() {
      return journals.reconnection
        .list()
        .map((row) => ({ intent: row.intent, phase: 'outcome_unknown' as const }));
    },
    observe,
    async submit(raw, observed) {
      const intent = parseMcpReconnectionIntent(raw);
      let prepared: ReturnType<typeof createMcpReconnectionRecord> | undefined;
      try {
        admission(intent.request.expectedStoreId, intent.sessionId);
        const record = createMcpReconnectionRecord(intent, subject()!);
        const existing = journals.reconnection
          .list()
          .find((row) => row.intent.request.commandId === intent.request.commandId);
        if (existing) {
          if (mcpReconnectionRecordIdentity(existing) !== mcpReconnectionRecordIdentity(record))
            throw Error('mcp_reconnection_intent_conflict');
          return await port.lookup(intent, new AbortController().signal);
        }
        const fresh = await observe(
          {
            sessionId: intent.sessionId,
            workspaceId: intent.workspaceId,
            workspaceIdentity: intent.workspaceIdentity,
            request: intent.targetRequest,
          },
          new AbortController().signal,
        );
        if (
          mcpCanonical(fresh) !== mcpCanonical(observed) ||
          mcpCanonical(fresh.target) !== mcpCanonical(intent.request.input.target) ||
          mcpCanonical(fresh.replacement) !== mcpCanonical(intent.request.input.replacement)
        )
          throw Error('mcp_reconnection_observation_changed');
        if (!journals.reconnection.prepare(record))
          return await port.lookup(intent, new AbortController().signal);
        prepared = record;
        admission(intent.request.expectedStoreId, intent.sessionId);
        if (subject() !== record.subjectId) throw Error('mcp_reconnection_subject_changed');
        const { target, replacement } = intent.request.input;
        const sourceReadSet = replacement.kind === 'source' ? replacement.expectedReadSet : null;
        const command = await client.invokeExtension(intent.sessionId, {
          ...intent.request,
          input: {
            ...intent.request.input,
            target: { ...target, operationRef: { ...target.operationRef } },
            replacement:
              replacement.kind === 'source' && sourceReadSet
                ? {
                    ...replacement,
                    expectedReadSet: {
                      ...sourceReadSet,
                      user: {
                        ...sourceReadSet.user,
                        identity: { ...sourceReadSet.user.identity },
                      },
                      workspace: sourceReadSet.workspace
                        ? {
                            ...sourceReadSet.workspace,
                            identity: { ...sourceReadSet.workspace.identity },
                          }
                        : null,
                    },
                  }
                : { kind: 'static', expectedConfigDigest: replacement.expectedConfigDigest },
          },
        });
        original(intent, command);
        const result = await outcome(intent);
        journals.reconnection.record(record, result.phase);
        return result;
      } catch {
        if (prepared) {
          try {
            journals.reconnection.record(prepared, 'outcome_unknown');
          } catch {}
        }
        return { intent, phase: 'outcome_unknown' };
      }
    },
    async lookup(raw, signal) {
      const intent = parseMcpReconnectionIntent(raw);
      try {
        const record = stored(intent, signal),
          result = await outcome(intent, signal);
        signal.throwIfAborted();
        journals.reconnection.record(record, result.phase);
        return result;
      } catch {
        return { intent, phase: 'outcome_unknown' };
      }
    },
  };
  return port;
}
