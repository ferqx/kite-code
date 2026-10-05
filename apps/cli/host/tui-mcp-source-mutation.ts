import type { AgentClient, QueryResponse } from '@kite-ai/client';
import type {
  TuiMcpSourceEntryDeclaration,
  TuiMcpSourceEntryPreview,
  TuiMcpSourceMutationFact,
  TuiMcpSourceMutationIntent,
  TuiMcpSourceMutationPort,
  TuiMcpSourceSnapshot,
} from '@kite-ai/ui/tui';
import { mcpCanonical, mcpSha } from './mcp-selection-intents';
import {
  parseMcpSourceIdentity,
  parseMcpSourceReadSet,
  sourceClosed,
  sourceId,
  sourceServerId,
  sourceSha,
} from './mcp-source-approval-intents';
import {
  createMcpSourceMutationRecord,
  mcpSourceMutationRecordIdentity,
  parseMcpSourceMutationIntent,
} from './mcp-source-mutation-intents';
import type { McpSourceMutationJournal } from './mcp-source-mutation-journal';

const invalid = () => Error('mcp_source_mutation_fact_invalid');
const code = (v: unknown) => typeof v === 'string' && /^[a-z][a-z0-9_]{0,127}$/.test(v);
const states = [
  'planned',
  'dispatching',
  'running',
  'succeeded',
  'failed',
  'cancelled',
  'outcome_unknown',
];
function envelope(result: QueryResponse, type: string) {
  if (
    !Array.isArray(result) ||
    result.length !== 1 ||
    Buffer.byteLength(JSON.stringify(result)) > 16 * 1024
  )
    throw invalid();
  const c = sourceClosed(result[0], [
    'extensionId',
    'contentType',
    'contentVersion',
    'summary',
    'payload',
    'actions',
    'artifactRefs',
  ]);
  if (
    c.extensionId !== 'builtin.mcp.sources' ||
    c.contentType !== type ||
    c.contentVersion !== 1 ||
    typeof c.summary !== 'string' ||
    c.summary.length > 512 ||
    !Array.isArray(c.actions) ||
    c.actions.length ||
    !Array.isArray(c.artifactRefs) ||
    c.artifactRefs.length
  )
    throw invalid();
  return c.payload;
}
function declaration(v: unknown): TuiMcpSourceEntryDeclaration {
  const x = sourceClosed(v, [
    'serverId',
    'name',
    'source',
    'rawEntryDigest',
    'transport',
    'enabled',
    'reason',
  ]);
  parseMcpSourceIdentity(x.source);
  if (
    !sourceServerId(x.serverId) ||
    typeof x.name !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(x.name) ||
    !sourceSha(x.rawEntryDigest) ||
    ![null, 'http', 'stdio'].includes(x.transport as string | null) ||
    typeof x.enabled !== 'boolean' ||
    (x.reason !== null && !code(x.reason))
  )
    throw invalid();
  return structuredClone(x) as unknown as TuiMcpSourceEntryDeclaration;
}
function preview(v: unknown): TuiMcpSourceEntryPreview {
  const x = sourceClosed(v, ['target', 'fallback']);
  return {
    target: declaration(x.target),
    fallback: x.fallback === null ? null : declaration(x.fallback),
  };
}
export function decodeMcpSourceMutationFact(result: QueryResponse): TuiMcpSourceMutationFact {
  const value = envelope(result, 'builtin.mcp.source.mutation.result');
  const hasCleanup =
    !!value && typeof value === 'object' && Object.hasOwn(value, 'credentialCleanup');
  const x = sourceClosed(value, [
    'storeId',
    'sessionId',
    'workspaceId',
    'operation',
    'command',
    'execution',
    'phase',
    'mutation',
    'receipt',
    'reason',
    ...(hasCleanup ? ['credentialCleanup'] : []),
  ]);
  if (hasCleanup) {
    const cleanup = sourceClosed(x.credentialCleanup, ['status', 'attempted']);
    if (
      x.operation !== 'remove' ||
      !['not_attempted', 'not_needed', 'completed', 'failed', 'outcome_unknown'].includes(
        String(cleanup.status),
      ) ||
      typeof cleanup.attempted !== 'boolean' ||
      (['completed', 'failed'].includes(String(cleanup.status)) && cleanup.attempted !== true)
    )
      throw invalid();
  }
  if (
    !sourceId(x.storeId) ||
    !sourceId(x.sessionId) ||
    (x.workspaceId !== null && !sourceId(x.workspaceId)) ||
    ![null, 'add', 'remove'].includes(x.operation as string | null) ||
    typeof x.phase !== 'string' ||
    !['pending', 'saved', 'failed', 'cancelled', 'outcome_unknown'].includes(x.phase) ||
    (x.reason !== null && !code(x.reason))
  )
    throw invalid();
  if (x.command !== null) {
    const c = sourceClosed(x.command, [
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
      !sourceId(c.id) ||
      !sourceId(c.originStoreId) ||
      !sourceId(c.sessionId) ||
      typeof c.subjectId !== 'string' ||
      !c.subjectId.length ||
      c.subjectId.length > 256 ||
      c.kind !== 'extension.invoke' ||
      !sourceSha(c.requestDigest) ||
      typeof c.status !== 'string' ||
      !['accepted', 'applied', 'rejected', 'needs_review'].includes(c.status) ||
      (c.executionId !== null && !sourceId(c.executionId))
    )
      throw invalid();
  }
  if (x.execution !== null) {
    const e = sourceClosed(x.execution, [
      'id',
      'originStoreId',
      'sessionId',
      'originCommandId',
      'parentExecutionId',
      'runId',
      'kind',
      'definitionId',
      'definitionVersion',
      'inputDigest',
      'status',
    ]);
    for (const k of ['id', 'originStoreId', 'sessionId', 'originCommandId'])
      if (!sourceId(e[k])) throw invalid();
    if (
      (e.parentExecutionId !== null && !sourceId(e.parentExecutionId)) ||
      (e.runId !== null && !sourceId(e.runId)) ||
      e.kind !== 'job' ||
      typeof e.definitionId !== 'string' ||
      e.definitionVersion !== '1' ||
      !sourceSha(e.inputDigest) ||
      typeof e.status !== 'string' ||
      !states.includes(e.status)
    )
      throw invalid();
  }
  if (x.mutation !== null) {
    const m = sourceClosed(x.mutation, [
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
      !sourceId(m.id) ||
      !sourceId(m.originStoreId) ||
      typeof m.subjectId !== 'string' ||
      !m.subjectId.length ||
      m.subjectId.length > 256 ||
      typeof m.scope !== 'string' ||
      !m.scope.length ||
      typeof m.kind !== 'string' ||
      !['config.user.write', 'config.workspace.write'].includes(m.kind) ||
      !sourceSha(m.requestDigest) ||
      typeof m.state !== 'string' ||
      !['pending', 'applied', 'failed', 'outcome_unknown'].includes(m.state) ||
      (m.etag !== null && !sourceSha(m.etag))
    )
      throw invalid();
  }
  if (x.receipt !== null) {
    const r = sourceClosed(x.receipt, [
      'target',
      'fallback',
      'operationId',
      'kind',
      'oldEtag',
      'newEtag',
    ]);
    declaration(r.target);
    if (r.fallback !== null) declaration(r.fallback);
    if (
      !sourceId(r.operationId) ||
      typeof r.kind !== 'string' ||
      !['add', 'remove'].includes(r.kind) ||
      !sourceSha(r.oldEtag) ||
      !sourceSha(r.newEtag)
    )
      throw invalid();
  }
  if (x.phase === 'saved' && (!x.command || !x.execution || !x.mutation || !x.receipt))
    throw invalid();
  return structuredClone(x) as unknown as TuiMcpSourceMutationFact;
}
export function createTuiMcpSourceMutationPort(
  client: Pick<AgentClient, 'serverInfo' | 'getCommand' | 'invokeExtension' | 'queryExtension'>,
  storeId: string,
  journal: McpSourceMutationJournal,
  read: (s: string, a: AbortSignal) => Promise<TuiMcpSourceSnapshot>,
): TuiMcpSourceMutationPort {
  const subject = () => client.serverInfo?.subjectId;
  const admission = (intent: TuiMcpSourceMutationIntent, signal?: AbortSignal) => {
    signal?.throwIfAborted();
    if (
      client.serverInfo?.storeId !== storeId ||
      !subject() ||
      intent.request.expectedStoreId !== storeId
    )
      throw Error('mcp_source_mutation_scope_unavailable');
  };
  const stored = (intent: TuiMcpSourceMutationIntent, signal?: AbortSignal) => {
    admission(intent, signal);
    const expected = createMcpSourceMutationRecord(intent, subject()!),
      row = journal.list().find((r) => r.intent.request.commandId === intent.request.commandId);
    if (!row || mcpSourceMutationRecordIdentity(row) !== mcpSourceMutationRecordIdentity(expected))
      throw Error('mcp_source_mutation_original_unavailable');
    return row;
  };
  const port: TuiMcpSourceMutationPort = {
    read,
    list: async () => journal.list().map((r) => ({ intent: r.intent, phase: 'outcome_unknown' })),
    async preview(s, input, signal) {
      signal.throwIfAborted();
      if (client.serverInfo?.storeId !== storeId || !subject())
        throw Error('mcp_source_mutation_scope_unavailable');
      const originalSubject = subject();
      const result = await client.queryExtension(
        s,
        'builtin.mcp.sources',
        'mcp.source.entry.preview',
        JSON.parse(JSON.stringify(input)),
        { signal },
      );
      signal.throwIfAborted();
      if (client.serverInfo?.storeId !== storeId || subject() !== originalSubject) throw invalid();
      const x = sourceClosed(envelope(result, 'builtin.mcp.source.entry.preview'), [
        'storeId',
        'sessionId',
        'workspaceId',
        'readSet',
        'preview',
      ]);
      if (
        x.storeId !== storeId ||
        x.sessionId !== s ||
        !sourceId(x.workspaceId) ||
        mcpCanonical(parseMcpSourceReadSet(x.readSet)) !== mcpCanonical(input.expectedReadSet)
      )
        throw invalid();
      const p = preview(x.preview);
      const selected =
        input.scope === 'user' ? input.expectedReadSet.user : input.expectedReadSet.workspace;
      if (
        !selected ||
        p.target.serverId !== input.serverId ||
        mcpCanonical(p.target.source) !== mcpCanonical(selected.identity) ||
        (p.fallback !== null &&
          (input.scope !== 'workspace' ||
            p.fallback.serverId !== p.target.serverId ||
            p.fallback.name !== p.target.name ||
            mcpCanonical(p.fallback.source) !== mcpCanonical(input.expectedReadSet.user.identity)))
      )
        throw invalid();
      return p;
    },
    async submit(raw, observed) {
      const intent = parseMcpSourceMutationIntent(raw);
      let prepared = false;
      const record = createMcpSourceMutationRecord(intent, subject() ?? '');
      try {
        admission(intent);
        const prior = journal
          .list()
          .find((r) => r.intent.request.commandId === intent.request.commandId);
        if (prior) {
          if (mcpSourceMutationRecordIdentity(prior) !== mcpSourceMutationRecordIdentity(record))
            throw Error('mcp_source_mutation_intent_conflict');
          return await port.lookup(intent, new AbortController().signal);
        }
        const fresh = await read(intent.sessionId, new AbortController().signal);
        admission(intent);
        if (
          fresh.storeId !== storeId ||
          fresh.sessionId !== intent.sessionId ||
          fresh.workspaceId !== intent.workspaceId ||
          fresh.workspaceIdentity !== intent.workspaceIdentity ||
          mcpCanonical(fresh) !== mcpCanonical(observed) ||
          mcpCanonical(fresh.readSet) !== mcpCanonical(intent.request.input.expectedReadSet)
        )
          throw Error('mcp_source_mutation_observation_changed');
        if ('serverId' in intent.request.input) {
          const serverId = intent.request.input.serverId;
          const row = fresh.items.find((x) => x.id === serverId);
          if (
            !row ||
            row.source.kind !== intent.request.input.scope ||
            row.rawEntryDigest !== intent.request.input.expectedRawEntryDigest
          )
            throw Error('mcp_source_mutation_target_changed');
        }
        if (!journal.prepare(record))
          return await port.lookup(intent, new AbortController().signal);
        prepared = true;
        admission(intent);
        if (subject() !== record.subjectId) throw Error('mcp_source_mutation_subject_changed');
        const input = intent.request.input;
        await client.invokeExtension(intent.sessionId, {
          ...intent.request,
          input: JSON.parse(JSON.stringify(input)),
        });
        return await port.lookup(intent, new AbortController().signal);
      } catch (error) {
        if (!prepared) throw error;
        journal.record(record, 'outcome_unknown');
        return { intent, phase: 'outcome_unknown' };
      }
    },
    async lookup(raw, signal) {
      const intent = parseMcpSourceMutationIntent(raw);
      const record = stored(intent, signal);
      try {
        const c = await client.getCommand(intent.request.commandId, { signal });
        stored(intent, signal);
        if (
          c.id !== intent.request.commandId ||
          c.originStoreId !== storeId ||
          c.sessionId !== intent.sessionId ||
          c.subjectId !== subject() ||
          c.kind !== 'extension.invoke' ||
          c.requestDigest !== record.requestSha256
        )
          throw invalid();
        const fact = decodeMcpSourceMutationFact(
          await client.queryExtension(
            intent.sessionId,
            'builtin.mcp.sources',
            'mcp.source.mutation.result',
            { commandId: c.id },
            { signal },
          ),
        );
        stored(intent, signal);
        const e = fact.execution,
          m = fact.mutation,
          r = fact.receipt,
          projected = fact.command;
        const receipt =
          c.receipt && typeof c.receipt === 'object' && !Array.isArray(c.receipt)
            ? (c.receipt as Record<string, unknown>)
            : {};
        const eid = sourceId(receipt.executionId) ? receipt.executionId : null;
        if (
          fact.storeId !== storeId ||
          fact.sessionId !== intent.sessionId ||
          (fact.workspaceId !== null && fact.workspaceId !== intent.workspaceId) ||
          !projected ||
          projected.id !== c.id ||
          projected.originStoreId !== storeId ||
          projected.sessionId !== intent.sessionId ||
          projected.subjectId !== subject() ||
          projected.requestDigest !== c.requestDigest ||
          projected.status !== c.status ||
          projected.executionId !== eid ||
          fact.operation !== (intent.request.actionId === 'mcp.source.add' ? 'add' : 'remove')
        )
          throw invalid();
        if (
          e &&
          (e.id !== eid ||
            e.originStoreId !== storeId ||
            e.sessionId !== intent.sessionId ||
            e.originCommandId !== c.id ||
            e.parentExecutionId !== null ||
            e.runId !== null ||
            e.definitionVersion !== '1' ||
            e.definitionId !== `builtin.mcp.sources/${intent.request.actionId}` ||
            e.inputDigest !== mcpSha(intent.request.input))
        )
          throw invalid();
        if (
          m &&
          (m.id !== `mcp-entry-${eid}` ||
            m.originStoreId !== storeId ||
            m.subjectId !== subject() ||
            m.kind !==
              (intent.request.input.scope === 'user'
                ? 'config.user.write'
                : 'config.workspace.write') ||
            m.scope !== (intent.request.input.scope === 'user' ? 'user' : intent.workspaceId) ||
            m.requestDigest !==
              mcpSha({
                version: 1,
                executionId: eid,
                originCommandId: c.id,
                originalStoreId: storeId,
                sessionId: intent.sessionId,
                workspaceId: intent.workspaceId,
                actionId: intent.request.actionId,
                inputDigest: mcpSha(intent.request.input),
              }))
        )
          throw invalid();
        const input = intent.request.input;
        const selected =
          input.scope === 'user' ? input.expectedReadSet.user : input.expectedReadSet.workspace;
        if (r) {
          if (
            !selected ||
            r.operationId !== eid ||
            r.kind !== fact.operation ||
            mcpCanonical(r.target.source) !== mcpCanonical(selected.identity) ||
            r.oldEtag !== selected.etag ||
            r.newEtag === r.oldEtag ||
            (r.fallback !== null &&
              (input.scope !== 'workspace' ||
                mcpCanonical(r.fallback.source) !==
                  mcpCanonical(input.expectedReadSet.user.identity) ||
                r.fallback.serverId !== r.target.serverId ||
                r.fallback.name !== r.target.name))
          )
            throw invalid();
          if ('serverId' in input) {
            if (
              r.target.serverId !== input.serverId ||
              r.target.rawEntryDigest !== input.expectedRawEntryDigest
            )
              throw invalid();
          } else if (
            r.fallback !== null ||
            r.target.name !== input.name ||
            r.target.serverId !== `mcp-${mcpSha({ name: input.name })}` ||
            r.target.rawEntryDigest !==
              mcpSha({
                version: 1,
                name: input.name,
                raw: { ...input.entry, _kiteSourceCreation: { version: 1, operationId: eid } },
              }) ||
            r.target.transport !== input.entry.type ||
            !r.target.enabled ||
            r.target.reason !== null
          )
            throw invalid();
        }
        if (['saved', 'failed', 'cancelled'].includes(fact.phase)) {
          const partial =
            fact.phase === 'saved' &&
            fact.operation === 'remove' &&
            ((fact.credentialCleanup?.status === 'failed' &&
              fact.reason === 'mcp_source_removed_credential_cleanup_failed') ||
              (fact.credentialCleanup?.status === 'outcome_unknown' &&
                fact.reason === 'mcp_source_removed_credential_cleanup_unknown'));
          const status =
            fact.phase === 'saved' ? (partial ? 'outcome_unknown' : 'succeeded') : fact.phase;
          if (
            fact.phase === 'saved' &&
            fact.credentialCleanup &&
            !partial &&
            !['not_needed', 'completed'].includes(fact.credentialCleanup.status)
          )
            throw invalid();
          if (
            fact.workspaceId !== intent.workspaceId ||
            c.status !== 'applied' ||
            !e ||
            e.status !== status ||
            receipt.status !== e.status ||
            receipt.preparingNextAttempt === true ||
            !sourceSha(receipt.finalizationDigest)
          )
            throw invalid();
          if (fact.phase === 'saved') {
            if (m?.state !== 'applied' || !r || m.etag !== r.newEtag) throw invalid();
          } else if (
            r !== null ||
            !code(fact.reason) ||
            (m !== null && (m.state !== 'failed' || m.etag !== null))
          )
            throw invalid();
        } else if (
          fact.phase === 'pending' &&
          (r !== null ||
            (e !== null && !['planned', 'dispatching', 'running'].includes(e.status)) ||
            (m !== null && m.state !== 'pending'))
        )
          throw invalid();
        journal.record(record, fact.phase);
        return { intent, phase: fact.phase, command: c, fact };
      } catch {
        signal.throwIfAborted();
        return { intent, phase: 'outcome_unknown' };
      }
    },
  };
  return port;
}
