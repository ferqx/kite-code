import { lstatSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { AgentClient, Command, QueryResponse } from '@kite-ai/client';
import type {
  TuiMcpSourceApprovalFact,
  TuiMcpSourceApprovalIntent,
  TuiMcpSourceApprovalOutcome,
  TuiMcpSourceApprovalPort,
  TuiMcpSourceItem,
  TuiMcpSourceReadSet,
  TuiMcpSourceSnapshot,
} from '@kite-ai/ui/tui';
import { mcpCanonical, mcpSha } from './mcp-selection-intents';
import {
  createMcpSourceApprovalRecord,
  mcpSourceApprovalRecordIdentity,
  parseMcpSourceApprovalIntent,
  parseMcpSourceIdentity,
  parseMcpSourceReadSet,
  sourceClosed,
  sourceId,
  sourceServerId,
  sourceSha,
} from './mcp-source-approval-intents';
import type { McpSourceApprovalJournal } from './mcp-source-approval-journal';

const invalid = () => Error('mcp_source_approval_fact_invalid');
const code = (value: unknown) => typeof value === 'string' && /^[a-z][a-z0-9_]{0,127}$/.test(value);
const text = (value: unknown, maximum: number) =>
  typeof value === 'string' && value.length > 0 && value.length <= maximum;
const executionStatuses = [
  'planned',
  'dispatching',
  'running',
  'succeeded',
  'failed',
  'cancelled',
  'outcome_unknown',
];
function envelope(result: QueryResponse, contentType: string, maximum: number) {
  if (
    !Array.isArray(result) ||
    result.length !== 1 ||
    Buffer.byteLength(JSON.stringify(result)) > maximum
  )
    throw invalid();
  const display = sourceClosed(result[0], [
    'extensionId',
    'contentType',
    'contentVersion',
    'summary',
    'payload',
    'actions',
    'artifactRefs',
  ]);
  if (
    display.extensionId !== 'builtin.mcp.sources' ||
    display.contentType !== contentType ||
    display.contentVersion !== 1 ||
    !text(display.summary, 512) ||
    !Array.isArray(display.actions) ||
    display.actions.length !== 0 ||
    !Array.isArray(display.artifactRefs) ||
    display.artifactRefs.length !== 0
  )
    throw invalid();
  return display.payload;
}
export function decodeMcpSourcePage(result: QueryResponse) {
  const row = sourceClosed(envelope(result, 'builtin.mcp.sources', 64 * 1024), [
    'items',
    'nextAfterId',
    'readSet',
    'registryRevision',
    'errors',
  ]);
  if (
    !Array.isArray(row.items) ||
    row.items.length > 25 ||
    (row.nextAfterId !== null && !sourceServerId(row.nextAfterId))
  )
    throw invalid();
  if (row.readSet === null) {
    if (
      row.registryRevision !== null ||
      row.items.length ||
      row.nextAfterId !== null ||
      !Array.isArray(row.errors) ||
      !row.errors.length ||
      !row.errors.every(code)
    )
      throw invalid();
  } else {
    parseMcpSourceReadSet(row.readSet);
    if (!sourceSha(row.registryRevision)) throw invalid();
    const errors = sourceClosed(row.errors, ['user', 'workspace', 'approval', 'binding']);
    if (!Object.values(errors).every((value) => value === null || code(value))) throw invalid();
  }
  let previous: string | undefined;
  for (const raw of row.items) {
    const item = sourceClosed(raw, [
      'id',
      'name',
      'source',
      'rawEntryDigest',
      'transportDigest',
      'transport',
      'enabled',
      'admitted',
      'reason',
      'configDigest',
    ]);
    parseMcpSourceIdentity(item.source);
    if (
      !sourceServerId(item.id) ||
      !text(item.name, 128) ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(item.name as string) ||
      !sourceSha(item.rawEntryDigest) ||
      (item.transportDigest !== null && !sourceSha(item.transportDigest)) ||
      (item.configDigest !== null && !sourceSha(item.configDigest)) ||
      ![null, 'http', 'stdio'].includes(item.transport as string | null) ||
      typeof item.enabled !== 'boolean' ||
      typeof item.admitted !== 'boolean' ||
      (item.reason !== null && !code(item.reason)) ||
      (previous !== undefined && item.id <= previous)
    )
      throw invalid();
    previous = item.id;
  }
  if (row.nextAfterId !== null && row.nextAfterId !== previous) throw invalid();
  return structuredClone(row) as {
    items: TuiMcpSourceItem[];
    nextAfterId: string | null;
    readSet: TuiMcpSourceReadSet | null;
    registryRevision: string | null;
    errors: TuiMcpSourceSnapshot['errors'];
  };
}
/** The Service validates private original Question and mutation records; only this finite projection is exposed. */
export function decodeMcpSourceApprovalFact(result: QueryResponse): TuiMcpSourceApprovalFact {
  const row = sourceClosed(envelope(result, 'builtin.mcp.source.result', 16 * 1024), [
    'storeId',
    'sessionId',
    'command',
    'execution',
    'serverId',
    'phase',
    'decision',
    'proof',
    'mutation',
    'recordKey',
    'reason',
  ]);
  if (
    !sourceId(row.storeId) ||
    !sourceId(row.sessionId) ||
    (row.serverId !== null && !sourceServerId(row.serverId)) ||
    typeof row.phase !== 'string' ||
    !['pending', 'saved', 'failed', 'cancelled', 'outcome_unknown'].includes(row.phase) ||
    ![null, 'approved', 'rejected', 'cancel'].includes(row.decision as string | null) ||
    (row.recordKey !== null && !sourceSha(row.recordKey)) ||
    (row.reason !== null && !code(row.reason))
  )
    throw invalid();
  if (row.command !== null) {
    const command = sourceClosed(row.command, [
      'id',
      'originStoreId',
      'sessionId',
      'subjectId',
      'kind',
      'requestDigest',
      'status',
      'executionId',
    ]);
    if (
      !sourceId(command.id) ||
      !sourceId(command.originStoreId) ||
      !sourceId(command.sessionId) ||
      !text(command.subjectId, 256) ||
      command.kind !== 'extension.invoke' ||
      !sourceSha(command.requestDigest) ||
      typeof command.status !== 'string' ||
      !['accepted', 'applied', 'rejected', 'needs_review'].includes(command.status) ||
      (command.executionId !== null && !sourceId(command.executionId))
    )
      throw invalid();
  }
  if (row.execution !== null) {
    const execution = sourceClosed(row.execution, [
      'id',
      'originStoreId',
      'sessionId',
      'originCommandId',
      'parentExecutionId',
      'kind',
      'definitionId',
      'definitionVersion',
      'inputDigest',
      'status',
    ]);
    if (
      !sourceId(execution.id) ||
      !sourceId(execution.originStoreId) ||
      !sourceId(execution.sessionId) ||
      !sourceId(execution.originCommandId) ||
      execution.parentExecutionId !== null ||
      execution.kind !== 'job' ||
      execution.definitionId !== 'builtin.mcp.sources/mcp.source.approve' ||
      execution.definitionVersion !== '1' ||
      !sourceSha(execution.inputDigest) ||
      typeof execution.status !== 'string' ||
      !executionStatuses.includes(execution.status)
    )
      throw invalid();
  }
  if (row.proof !== null) {
    const proof = sourceClosed(row.proof, [
      'decisionId',
      'storeId',
      'sessionId',
      'interactionId',
      'acceptedRevision',
      'subjectId',
      'requestDigest',
      'recordedAt',
    ]);
    if (
      !sourceId(proof.storeId) ||
      !sourceId(proof.sessionId) ||
      !sourceId(proof.interactionId) ||
      typeof proof.acceptedRevision !== 'string' ||
      !/^[1-9][0-9]{0,255}$/.test(proof.acceptedRevision) ||
      proof.decisionId !== `${proof.interactionId}@${proof.acceptedRevision}` ||
      !text(proof.subjectId, 256) ||
      !sourceSha(proof.requestDigest) ||
      !Number.isSafeInteger(proof.recordedAt) ||
      Number(proof.recordedAt) <= 0
    )
      throw invalid();
  }
  if (row.mutation !== null) {
    const mutation = sourceClosed(row.mutation, [
      'id',
      'originStoreId',
      'subjectId',
      'kind',
      'scope',
      'requestDigest',
      'state',
      'etag',
    ]);
    if (
      !sourceId(mutation.id) ||
      !sourceId(mutation.originStoreId) ||
      !text(mutation.subjectId, 256) ||
      mutation.kind !== 'config.user.write' ||
      mutation.scope !== 'user' ||
      !sourceSha(mutation.requestDigest) ||
      typeof mutation.state !== 'string' ||
      !['pending', 'applied', 'failed', 'outcome_unknown'].includes(mutation.state) ||
      (mutation.etag !== null && !sourceSha(mutation.etag))
    )
      throw invalid();
  }
  if (row.phase !== 'outcome_unknown' && (!row.command || !row.serverId)) throw invalid();
  if (
    row.phase === 'saved' &&
    ((row.decision !== 'approved' && row.decision !== 'rejected') ||
      !row.proof ||
      !row.mutation ||
      !row.recordKey ||
      !row.execution)
  )
    throw invalid();
  if (
    row.phase === 'pending' &&
    (row.decision !== null || row.proof !== null || row.mutation !== null || row.recordKey !== null)
  )
    throw invalid();
  if (
    row.phase === 'failed' &&
    (row.decision !== null || row.proof !== null || row.mutation !== null || row.recordKey !== null)
  )
    throw invalid();
  if (
    row.phase === 'cancelled' &&
    (row.mutation !== null ||
      row.recordKey !== null ||
      (row.decision === 'cancel'
        ? row.proof === null
        : row.decision !== null || row.proof !== null))
  )
    throw invalid();
  return structuredClone(row) as unknown as TuiMcpSourceApprovalFact;
}

type SourceClient = Pick<
  AgentClient,
  | 'queryExtension'
  | 'invokeExtension'
  | 'getCommand'
  | 'serverInfo'
  | 'getView'
  | 'listAllWorkspaces'
>;
export function createTuiMcpSourceApprovalPort(
  client: SourceClient,
  storeId: string,
  journal: McpSourceApprovalJournal,
): TuiMcpSourceApprovalPort {
  const subject = () => client.serverInfo?.subjectId;
  const admission = (sessionId: string, signal?: AbortSignal) => {
    signal?.throwIfAborted();
    if (!sourceId(sessionId) || client.serverInfo?.storeId !== storeId || !subject())
      throw Error('mcp_source_approval_scope_unavailable');
  };
  const stored = (intent: TuiMcpSourceApprovalIntent, signal?: AbortSignal) => {
    admission(intent.sessionId, signal);
    if (intent.request.expectedStoreId !== storeId)
      throw Error('mcp_source_approval_scope_unavailable');
    const expected = createMcpSourceApprovalRecord(intent, subject()!);
    const record = journal
      .list()
      .find((row) => row.intent.request.commandId === intent.request.commandId);
    if (
      !record ||
      mcpSourceApprovalRecordIdentity(record) !== mcpSourceApprovalRecordIdentity(expected)
    )
      throw Error('mcp_source_approval_original_unavailable');
    return record;
  };
  const original = (intent: TuiMcpSourceApprovalIntent, command: Command) => {
    admission(intent.sessionId);
    const { commandId: _commandId, expectedStoreId: _storeId, ...request } = intent.request;
    if (
      intent.request.expectedStoreId !== storeId ||
      command.id !== intent.request.commandId ||
      command.originStoreId !== storeId ||
      command.sessionId !== intent.sessionId ||
      command.subjectId !== subject() ||
      command.kind !== 'extension.invoke' ||
      command.requestDigest !== mcpSha(request)
    )
      throw Error('mcp_source_approval_original_command_mismatch');
  };
  async function physical(sessionId: string, signal?: AbortSignal) {
    admission(sessionId, signal);
    const view = await client.getView(sessionId, { signal });
    admission(sessionId, signal);
    if (
      view.storeId !== storeId ||
      view.session.id !== sessionId ||
      view.session.deletedAt !== null
    )
      throw Error('mcp_source_approval_scope_unavailable');
    const workspace = (await client.listAllWorkspaces({ signal })).find(
      (row) => row.id === view.session.workspaceId,
    );
    admission(sessionId, signal);
    if (!workspace) throw Error('mcp_source_approval_scope_unavailable');
    const uri = new URL(workspace.rootUri);
    if (uri.protocol !== 'file:' || (uri.hostname && uri.hostname !== 'localhost'))
      throw Error('mcp_source_approval_scope_unavailable');
    const path = fileURLToPath(uri),
      before = lstatSync(path, { bigint: true }),
      root = realpathSync(path),
      after = lstatSync(path, { bigint: true });
    if (
      !before.isDirectory() ||
      before.isSymbolicLink() ||
      !after.isDirectory() ||
      after.isSymbolicLink() ||
      before.dev !== after.dev ||
      before.ino !== after.ino
    )
      throw Error('mcp_source_approval_workspace_changed');
    return {
      workspaceId: workspace.id,
      workspaceIdentity: mcpCanonical({ root, dev: String(before.dev), ino: String(before.ino) }),
    };
  }
  async function read(sessionId: string, signal: AbortSignal): Promise<TuiMcpSourceSnapshot> {
    const scope = await physical(sessionId, signal);
    let afterId: string | undefined,
      version: string | undefined,
      items: TuiMcpSourceItem[] = [],
      first: ReturnType<typeof decodeMcpSourcePage> | undefined;
    for (;;) {
      admission(sessionId, signal);
      const page = decodeMcpSourcePage(
        await client.queryExtension(
          sessionId,
          'builtin.mcp.sources',
          'mcp.sources',
          { limit: 25, ...(afterId ? { afterId } : {}) },
          { signal },
        ),
      );
      admission(sessionId, signal);
      const currentVersion = mcpCanonical({
        readSet: page.readSet,
        registryRevision: page.registryRevision,
        errors: page.errors,
      });
      if (version !== undefined && version !== currentVersion)
        throw Error('mcp_source_approval_directory_changed');
      first ??= page;
      version ??= currentVersion;
      if (afterId !== undefined && (page.items.length === 0 || page.items[0]!.id <= afterId))
        throw invalid();
      items = [...items, ...page.items];
      if (
        items.length > 8192 ||
        Buffer.byteLength(
          JSON.stringify({
            ...scope,
            storeId,
            sessionId,
            items,
            readSet: first.readSet,
            registryRevision: first.registryRevision,
            errors: first.errors,
          }),
        ) >
          16 * 1024 * 1024
      )
        throw Error('mcp_source_approval_directory_limit');
      if (page.nextAfterId === null) break;
      if (afterId !== undefined && page.nextAfterId <= afterId) throw invalid();
      afterId = page.nextAfterId;
    }
    const after = await physical(sessionId, signal);
    if (mcpCanonical(after) !== mcpCanonical(scope))
      throw Error('mcp_source_approval_workspace_changed');
    return {
      ...scope,
      storeId,
      sessionId,
      items,
      readSet: first!.readSet,
      registryRevision: first!.registryRevision,
      errors: first!.errors,
    };
  }
  async function current(intent: TuiMcpSourceApprovalIntent, observed: TuiMcpSourceSnapshot) {
    admission(intent.sessionId);
    if (intent.request.expectedStoreId !== storeId)
      throw Error('mcp_source_approval_scope_unavailable');
    const fresh = await read(intent.sessionId, new AbortController().signal);
    const server = fresh.items.find((row) => row.id === intent.request.input.serverId);
    if (
      fresh.workspaceId !== intent.workspaceId ||
      fresh.workspaceIdentity !== intent.workspaceIdentity ||
      mcpCanonical(fresh) !== mcpCanonical(observed) ||
      mcpCanonical(fresh.readSet) !== mcpCanonical(intent.request.input.expectedReadSet) ||
      !server ||
      server.source.kind !== 'workspace' ||
      server.transport === null ||
      server.transportDigest === null ||
      !fresh.readSet?.workspace ||
      fresh.readSet.workspace.error !== null ||
      mcpCanonical(server.source) !== mcpCanonical(fresh.readSet.workspace.identity)
    )
      throw Error('mcp_source_approval_source_changed');
  }
  async function outcome(
    intent: TuiMcpSourceApprovalIntent,
    signal?: AbortSignal,
  ): Promise<TuiMcpSourceApprovalOutcome> {
    stored(intent, signal);
    const command = await client.getCommand(intent.request.commandId, { signal });
    stored(intent, signal);
    original(intent, command);
    const fact = decodeMcpSourceApprovalFact(
      await client.queryExtension(
        intent.sessionId,
        'builtin.mcp.sources',
        'mcp.source.result',
        { commandId: command.id },
        { signal },
      ),
    );
    stored(intent, signal);
    const projected = fact.command;
    const receipt =
      command.receipt !== null &&
      typeof command.receipt === 'object' &&
      !Array.isArray(command.receipt)
        ? (command.receipt as Record<string, unknown>)
        : {};
    const executionId = sourceId(receipt.executionId) ? receipt.executionId : null;
    if (
      fact.storeId !== storeId ||
      fact.sessionId !== intent.sessionId ||
      !projected ||
      projected.id !== command.id ||
      projected.originStoreId !== storeId ||
      projected.sessionId !== intent.sessionId ||
      projected.subjectId !== subject() ||
      projected.requestDigest !== command.requestDigest ||
      projected.status !== command.status ||
      projected.executionId !== executionId ||
      fact.serverId !== intent.request.input.serverId
    )
      throw Error('mcp_source_approval_original_fact_mismatch');
    const execution = fact.execution;
    if (
      execution &&
      (execution.id !== executionId ||
        execution.originStoreId !== storeId ||
        execution.sessionId !== intent.sessionId ||
        execution.originCommandId !== command.id ||
        execution.inputDigest !== mcpSha(intent.request.input))
    )
      throw Error('mcp_source_approval_original_execution_mismatch');
    if (!execution && executionId !== null && fact.phase !== 'outcome_unknown')
      throw Error('mcp_source_approval_original_execution_mismatch');
    if (
      fact.proof &&
      (fact.proof.storeId !== storeId ||
        fact.proof.sessionId !== intent.sessionId ||
        fact.proof.subjectId !== subject())
    )
      throw Error('mcp_source_approval_original_proof_mismatch');
    if (
      fact.mutation &&
      (fact.mutation.id !== `mcp-source-${executionId}` ||
        fact.mutation.originStoreId !== storeId ||
        fact.mutation.subjectId !== subject())
    )
      throw Error('mcp_source_approval_original_mutation_mismatch');
    if (
      fact.phase === 'saved' &&
      (command.status !== 'applied' ||
        execution?.status !== 'succeeded' ||
        fact.mutation?.state !== 'applied' ||
        !fact.mutation.etag)
    )
      throw Error('mcp_source_approval_original_outcome_mismatch');
    if (
      fact.phase === 'pending' &&
      (execution
        ? !['planned', 'dispatching', 'running'].includes(execution.status)
        : command.status !== 'accepted')
    )
      throw Error('mcp_source_approval_original_outcome_mismatch');
    if (
      fact.phase === 'failed' &&
      (execution ? execution.status !== 'failed' : command.status !== 'rejected')
    )
      throw Error('mcp_source_approval_original_outcome_mismatch');
    if (fact.phase === 'cancelled' && execution?.status !== 'cancelled')
      throw Error('mcp_source_approval_original_outcome_mismatch');
    return { intent, phase: fact.phase, command, fact };
  }
  const port: TuiMcpSourceApprovalPort = {
    read,
    async list() {
      return journal
        .list()
        .map((row) => ({ intent: row.intent, phase: 'outcome_unknown' as const }));
    },
    async submit(raw, observed) {
      const intent = parseMcpSourceApprovalIntent(raw);
      let prepared: ReturnType<typeof createMcpSourceApprovalRecord> | undefined;
      try {
        admission(intent.sessionId);
        if (intent.request.expectedStoreId !== storeId)
          throw Error('mcp_source_approval_scope_unavailable');
        const record = createMcpSourceApprovalRecord(intent, subject()!);
        const existing = journal
          .list()
          .find((row) => row.intent.request.commandId === intent.request.commandId);
        if (existing) {
          if (mcpSourceApprovalRecordIdentity(existing) !== mcpSourceApprovalRecordIdentity(record))
            throw Error('mcp_source_approval_intent_conflict');
          return await port.lookup(intent, new AbortController().signal);
        }
        await current(intent, observed);
        if (!journal.prepare(record))
          return await port.lookup(intent, new AbortController().signal);
        prepared = record;
        admission(intent.sessionId);
        if (subject() !== record.subjectId) throw Error('mcp_source_approval_subject_changed');
        const sourceReadSet = intent.request.input.expectedReadSet;
        const command = await client.invokeExtension(intent.sessionId, {
          ...intent.request,
          input: {
            serverId: intent.request.input.serverId,
            expectedReadSet: {
              ...sourceReadSet,
              user: { ...sourceReadSet.user, identity: { ...sourceReadSet.user.identity } },
              workspace: sourceReadSet.workspace
                ? { ...sourceReadSet.workspace, identity: { ...sourceReadSet.workspace.identity } }
                : null,
            },
          },
        });
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
      const intent = parseMcpSourceApprovalIntent(raw);
      try {
        const record = stored(intent, signal),
          result = await outcome(intent, signal);
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
