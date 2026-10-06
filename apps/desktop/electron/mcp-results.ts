import {
  type AgentClient,
  type Command,
  canonicalModelBody,
  decodeMcpAuthResult,
  decodeMcpConnectionFact,
  decodeMcpReconnectionFact,
  decodeMcpSourceMutationResult,
  decodeMcpSourceResult,
  type Execution,
  type Json,
  type McpConnectionExecution,
  type McpSourceMutationInput,
  type McpSourceMutationResult,
} from '@kite-ai/client';
import type { NativeMcpSubmission } from '../src/mcp-bridge';
import { mcpSha, type NativeMcpRecord, parseNativeMcpRecord } from './mcp-journal';

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const equal = (left: unknown, right: unknown) =>
  canonicalModelBody(left) === canonicalModelBody(right);
const sha = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const id = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const closed = (value: unknown, keys: string[]) =>
  Object.keys(object(value)).sort().join(',') === keys.sort().join(',');
const hash = (value: unknown) => mcpSha(canonicalModelBody(value));
const fail = (): never => {
  throw Error('mcp_original_proof_unavailable');
};

export function nativeMcpMetadata(row: NativeMcpRecord, client: AgentClient): NativeMcpSubmission {
  const input = row.request.input;
  return {
    kind: 'settings.mcp.submission',
    commandId: row.request.commandId,
    storeId: row.request.expectedStoreId,
    sessionId: row.sessionId,
    workspaceId: row.workspaceId,
    actionId: row.request.actionId,
    serverId: 'serverId' in input ? input.serverId : null,
    name: 'name' in input ? input.name : null,
    phase: row.phase,
    association:
      client.serverInfo?.storeId === row.request.expectedStoreId &&
      client.serverInfo.subjectId === row.subjectId
        ? 'current'
        : 'unavailable',
    bodySha256: row.bodySha256,
    requestSha256: row.requestSha256,
  };
}
export function verifyNativeMcpCommand(command: Command, row: NativeMcpRecord): void {
  if (
    command.id !== row.request.commandId ||
    command.originStoreId !== row.request.expectedStoreId ||
    command.sessionId !== row.sessionId ||
    command.subjectId !== row.subjectId ||
    command.kind !== 'extension.invoke' ||
    command.requestDigest !== row.requestSha256
  )
    fail();
}
function executionIdentity(e: Execution, command: Command, row: NativeMcpRecord): void {
  if (
    e.id !== object(command.receipt).executionId ||
    e.originStoreId !== row.request.expectedStoreId ||
    e.sessionId !== row.sessionId ||
    e.runId !== null ||
    e.parentExecutionId !== null ||
    e.kind !== 'job' ||
    e.definitionId !== `${row.request.extensionId}/${row.request.actionId}` ||
    e.definitionVersion !== '1'
  )
    fail();
}
function terminal(e: Execution, command: Command): boolean {
  const receipt = object(command.receipt);
  return (
    ['succeeded', 'failed', 'cancelled', 'outcome_unknown'].includes(e.status) &&
    /^(0|[1-9][0-9]{0,18})$/.test(e.resultRevision) &&
    receipt.status === e.status &&
    receipt.preparingNextAttempt === false &&
    receipt.finalizationDigest ===
      hash({
        status: e.status,
        preparingNextAttempt: false,
        result: e.result,
        writes: [],
        message: null,
      })
  );
}
function projectedExecution(
  e: Omit<McpConnectionExecution, 'status'> & { status: string; inputDigest: string },
  actual: Execution,
  row: NativeMcpRecord,
): void {
  if (
    e.id !== actual.id ||
    e.originStoreId !== row.request.expectedStoreId ||
    e.sessionId !== row.sessionId ||
    e.originCommandId !== row.request.commandId ||
    e.parentExecutionId !== null ||
    e.kind !== 'job' ||
    e.definitionId !== actual.definitionId ||
    e.definitionVersion !== '1' ||
    e.status !== actual.status ||
    e.inputDigest !== hash(row.request.input)
  )
    fail();
}
function projectedCommand(
  c: {
    id: string;
    originStoreId: string;
    sessionId: string;
    subjectId: string;
    requestDigest: string;
    status: string;
    executionId: string | null;
  } | null,
  command: Command,
  e: Execution,
): void {
  if (
    !c ||
    c.id !== command.id ||
    c.originStoreId !== command.originStoreId ||
    c.sessionId !== command.sessionId ||
    c.subjectId !== command.subjectId ||
    c.requestDigest !== command.requestDigest ||
    c.status !== command.status ||
    c.executionId !== e.id
  )
    fail();
}
async function actualMutation(
  client: AgentClient,
  row: NativeMcpRecord,
  value: unknown,
  expected: {
    id: string;
    scope: 'user' | 'workspace';
    ifMatch: string | null;
    requestDigest?: string;
  },
  signal?: AbortSignal,
): Promise<void> {
  const m = object(value),
    receipt = object(m.receipt),
    safe = object(m.safeRequest);
  if (
    m.id !== expected.id ||
    m.originStoreId !== row.request.expectedStoreId ||
    m.subjectId !== row.subjectId ||
    m.kind !== (expected.scope === 'user' ? 'config.user.write' : 'config.workspace.write') ||
    m.scope !== (expected.scope === 'user' ? 'user' : row.workspaceId) ||
    m.state !== 'applied' ||
    (expected.requestDigest !== undefined && m.requestDigest !== expected.requestDigest) ||
    !sha(m.requestDigest) ||
    !closed(receipt, ['status', 'etag']) ||
    receipt.status !== 'applied' ||
    !sha(receipt.etag) ||
    !closed(
      safe,
      expected.scope === 'user'
        ? ['scope', 'ifMatch', 'operationCount']
        : ['scope', 'workspaceId', 'ifMatch', 'operationCount'],
    ) ||
    safe.scope !== expected.scope ||
    safe.ifMatch !== expected.ifMatch ||
    safe.operationCount !== 1 ||
    (expected.scope === 'workspace' && safe.workspaceId !== row.workspaceId)
  )
    fail();
  const actual = await client.getHostMutation(expected.id, {
    storeId: row.request.expectedStoreId,
    signal,
  });
  if (
    actual.commandId !== expected.id ||
    actual.originStoreId !== row.request.expectedStoreId ||
    actual.kind !== 'config.patch' ||
    actual.scope !== expected.scope ||
    actual.workspaceId !== (expected.scope === 'user' ? undefined : row.workspaceId) ||
    actual.ifMatch !== expected.ifMatch ||
    actual.state !== 'applied' ||
    !equal(actual.receipt, receipt)
  )
    fail();
}
function sourceMutation(
  fact: McpSourceMutationResult,
  c: Command,
  e: Execution,
  row: NativeMcpRecord,
): void {
  if (row.request.actionId !== 'mcp.source.add' && row.request.actionId !== 'mcp.source.remove')
    fail();
  const input = row.request.input as McpSourceMutationInput,
    m = fact.mutation,
    r = fact.receipt;
  projectedCommand(fact.command, c, e);
  if (
    fact.storeId !== row.request.expectedStoreId ||
    fact.sessionId !== row.sessionId ||
    (fact.workspaceId !== null && fact.workspaceId !== row.workspaceId) ||
    fact.operation !== (row.request.actionId === 'mcp.source.add' ? 'add' : 'remove')
  )
    fail();
  if (fact.execution) {
    projectedExecution(fact.execution, e, row);
    if (fact.execution.runId !== null) fail();
  }
  if (
    m &&
    (m.id !== `mcp-entry-${e.id}` ||
      m.originStoreId !== row.request.expectedStoreId ||
      m.subjectId !== row.subjectId ||
      m.kind !== (input.scope === 'user' ? 'config.user.write' : 'config.workspace.write') ||
      m.scope !== (input.scope === 'user' ? 'user' : row.workspaceId) ||
      m.requestDigest !==
        hash({
          version: 1,
          executionId: e.id,
          originCommandId: c.id,
          originalStoreId: row.request.expectedStoreId,
          sessionId: row.sessionId,
          workspaceId: row.workspaceId,
          actionId: row.request.actionId,
          inputDigest: hash(input),
        }))
  )
    fail();
  const read =
    input.scope === 'user' ? input.expectedReadSet.user : input.expectedReadSet.workspace;
  if (r) {
    if (
      !read ||
      r.operationId !== e.id ||
      r.kind !== fact.operation ||
      !equal(r.target.source, read.identity) ||
      r.oldEtag !== read.etag ||
      r.newEtag === r.oldEtag ||
      (r.fallback !== null &&
        (input.scope !== 'workspace' ||
          !equal(r.fallback.source, input.expectedReadSet.user.identity) ||
          r.fallback.serverId !== r.target.serverId ||
          r.fallback.name !== r.target.name))
    )
      fail();
    if ('serverId' in input) {
      if (
        r.target.serverId !== input.serverId ||
        r.target.rawEntryDigest !== input.expectedRawEntryDigest
      )
        fail();
    } else if (
      r.fallback !== null ||
      r.target.name !== input.name ||
      r.target.serverId !== `mcp-${hash({ name: input.name })}` ||
      r.target.rawEntryDigest !==
        hash({
          version: 1,
          name: input.name,
          raw: { ...input.entry, _kiteSourceCreation: { version: 1, operationId: e.id } },
        }) ||
      r.target.transport !== input.entry.type ||
      !r.target.enabled ||
      r.target.reason !== null
    )
      fail();
  }
}

/** A historical lookup reads original IDs and does not require today's source or physical Workspace. */
export async function lookupNativeMcpResult(
  client: AgentClient,
  raw: NativeMcpRecord,
  signal?: AbortSignal,
): Promise<NativeMcpSubmission> {
  const row = parseNativeMcpRecord(raw),
    base = nativeMcpMetadata(row, client);
  const unknown: NativeMcpSubmission = { ...base, phase: 'outcome_unknown' };
  if (base.association !== 'current')
    return { ...unknown, error: 'mcp_original_scope_unavailable' };
  try {
    signal?.throwIfAborted();
    const c = await client.getCommand(row.request.commandId, { signal });
    verifyNativeMcpCommand(c, row);
    if (
      client.serverInfo?.storeId !== row.request.expectedStoreId ||
      client.serverInfo.subjectId !== row.subjectId
    )
      fail();
    if (c.status === 'rejected') return { ...base, phase: 'failed', summary: '原申请被拒绝' };
    if (c.status === 'accepted')
      return { ...base, phase: 'pending', summary: '原申请已受理，等待执行' };
    if (c.status !== 'applied' || !id(object(c.receipt).executionId)) return unknown;
    const e = await client.getExecution(object(c.receipt).executionId as string, { signal });
    executionIdentity(e, c, row);
    const result = object(e.result),
      details = object(result.details),
      action = row.request.actionId;
    const withExecution = { ...base, executionId: e.id };
    if (['planned', 'dispatching', 'running'].includes(e.status))
      return { ...withExecution, phase: 'pending', summary: '原执行仍在进行' };
    if (!terminal(e, c)) return { ...unknown, executionId: e.id };
    const query = (extension: string, name: string, input: Record<string, unknown>) =>
      client.queryExtension(
        row.sessionId,
        extension,
        name,
        JSON.parse(JSON.stringify(input)) as Json,
        { signal },
      );
    if (action === 'mcp.connect') {
      const fact = decodeMcpConnectionFact(
        await query('builtin.mcp', 'mcp.connection', { executionId: e.id, ...row.request.input }),
      );
      projectedExecution(fact.execution, e, row);
      const ref = fact.operationRef,
        connection = fact.connection;
      if (
        fact.storeId !== row.request.expectedStoreId ||
        fact.sessionId !== row.sessionId ||
        (ref &&
          (ref.originStoreId !== row.request.expectedStoreId ||
            ref.sessionId !== row.sessionId ||
            ref.childSessionId !== undefined ||
            ref.extensionId !== 'builtin.mcp' ||
            !ref.key.startsWith(`connection/${row.request.input.serverId}/`))) ||
        (connection &&
          (!ref ||
            connection.id !== ref.executionId ||
            connection.originCommandId !== ref.commandId ||
            connection.originStoreId !== row.request.expectedStoreId ||
            connection.sessionId !== row.sessionId ||
            !connection.parentExecutionId))
      )
        fail();
      if (connection) {
        if (
          !(
            connection.definitionId === 'mcp.source.connection' &&
            connection.definitionVersion === '1'
          ) &&
          !(
            connection.definitionId === `mcp.connection.${row.request.input.serverId}` &&
            sha(connection.definitionVersion) &&
            (!fact.ready || connection.definitionVersion === fact.ready.configDigest)
          )
        )
          fail();
        const created =
          ref!.key === `connection/${row.request.input.serverId}/${row.request.input.key}` &&
          connection.parentExecutionId === e.id;
        if (fact.created !== null && fact.created !== created) fail();
      } else if (fact.created !== null || fact.live) fail();
      if (
        fact.phase === 'ready' &&
        (e.status !== 'succeeded' ||
          fact.ready?.serverId !== row.request.input.serverId ||
          fact.created === null)
      )
        fail();
      return {
        ...withExecution,
        phase:
          fact.phase === 'ready'
            ? 'completed'
            : fact.phase === 'failed'
              ? 'failed'
              : 'outcome_unknown',
        fact,
        summary:
          fact.phase === 'ready' ? `原连接已就绪；当前${fact.live ? '在线' : '离线'}` : undefined,
      };
    }
    if (action === 'mcp.reconnect') {
      const fact = decodeMcpReconnectionFact(
        await query('builtin.mcp', 'mcp.reconnection', { executionId: e.id }),
      );
      projectedExecution(fact.execution, e, row);
      if (
        fact.storeId !== row.request.expectedStoreId ||
        fact.sessionId !== row.sessionId ||
        (fact.target !== null && !equal(fact.target, row.request.input.target))
      )
        fail();
      if (
        fact.phase === 'ready' &&
        (!fact.oldStop.confirmed ||
          !fact.oldStop.execution ||
          fact.oldStop.execution.id !== row.request.input.target.connectionExecutionId ||
          !fact.newOperationRef ||
          fact.newOperationRef.key !==
            `connection/${row.request.input.serverId}/${row.request.input.key}` ||
          !equal(fact.newOperationRef, details.newOperationRef) ||
          fact.newOperationRef.sessionId !== row.sessionId ||
          fact.newOperationRef.originStoreId !== row.request.expectedStoreId ||
          !fact.newConnection ||
          fact.newConnection.id !== fact.newOperationRef.executionId ||
          fact.newConnection.parentExecutionId !== e.id ||
          fact.newConnection.originCommandId !== fact.newOperationRef.commandId ||
          fact.newConnection.originStoreId !== row.request.expectedStoreId ||
          fact.newConnection.sessionId !== row.sessionId ||
          fact.ready?.configDigest !== row.request.input.replacement.expectedConfigDigest ||
          fact.ready.serverId !== row.request.input.serverId ||
          e.status !== 'succeeded')
      )
        fail();
      return {
        ...withExecution,
        phase: fact.phase === 'ready' ? 'completed' : fact.phase,
        fact,
        summary:
          fact.phase === 'ready'
            ? `旧连接停止已确认；新连接${fact.live ? '在线' : '离线'}`
            : undefined,
      };
    }
    if (action === 'mcp.source.approve') {
      const fact = decodeMcpSourceResult(
        await query('builtin.mcp.sources', 'mcp.source.result', { commandId: c.id }),
      );
      projectedCommand(fact.command, c, e);
      if (fact.execution) projectedExecution(fact.execution, e, row);
      if (
        fact.storeId !== row.request.expectedStoreId ||
        fact.sessionId !== row.sessionId ||
        fact.serverId !== row.request.input.serverId ||
        (fact.proof &&
          (fact.proof.storeId !== row.request.expectedStoreId ||
            fact.proof.sessionId !== row.sessionId ||
            fact.proof.subjectId !== row.subjectId)) ||
        (fact.mutation &&
          (fact.mutation.id !== `mcp-source-${e.id}` ||
            fact.mutation.originStoreId !== row.request.expectedStoreId ||
            fact.mutation.subjectId !== row.subjectId))
      )
        fail();
      return {
        ...withExecution,
        phase: fact.phase === 'saved' ? 'completed' : fact.phase,
        fact,
        summary: fact.phase === 'saved' ? `原来源决定已保存：${fact.decision}` : undefined,
      };
    }
    if (action === 'mcp.source.add' || action === 'mcp.source.remove') {
      const fact = decodeMcpSourceMutationResult(
        await query('builtin.mcp.sources', 'mcp.source.mutation.result', { commandId: c.id }),
      );
      sourceMutation(fact, c, e, row);
      const savedPhase =
        e.status === 'succeeded' &&
        (!fact.credentialCleanup ||
          ['not_needed', 'completed'].includes(fact.credentialCleanup.status))
          ? 'completed'
          : 'outcome_unknown';
      return {
        ...withExecution,
        phase: fact.phase === 'saved' ? savedPhase : fact.phase,
        fact,
        summary:
          fact.phase === 'saved'
            ? `原来源${fact.operation === 'add' ? '添加' : '删除'}已保存${fact.credentialCleanup ? `；凭据清理：${fact.credentialCleanup.status}` : ''}`
            : undefined,
      };
    }
    if (action.startsWith('mcp.auth.')) {
      const fact = decodeMcpAuthResult(
        await query('builtin.mcp.sources', 'mcp.auth.result', { commandId: c.id }),
      );
      projectedCommand(fact.command, c, e);
      if (fact.execution) projectedExecution(fact.execution, e, row);
      if (
        fact.storeId !== row.request.expectedStoreId ||
        fact.sessionId !== row.sessionId ||
        !fact.binding ||
        !equal(fact.binding, {
          version: 1,
          executionId: e.id,
          originCommandId: c.id,
          originalStoreId: row.request.expectedStoreId,
          sessionId: row.sessionId,
          workspaceId: row.workspaceId,
          actionId: action,
          serverId: 'serverId' in row.request.input ? row.request.input.serverId : null,
          inputDigest: hash(row.request.input),
        })
      )
        fail();
      return {
        ...withExecution,
        phase: fact.phase,
        fact,
        summary:
          fact.phase === 'completed' ? `原认证结果：${fact.authStatus}；连接需独立请求` : undefined,
      };
    }
    if (
      action === 'mcp.server.select' &&
      e.status === 'succeeded' &&
      result.outcome === 'succeeded'
    ) {
      const input = row.request.input;
      if (
        !closed(details, ['binding', 'mutation']) ||
        !equal(details.binding, {
          executionId: e.id,
          originCommandId: c.id,
          originalStoreId: row.request.expectedStoreId,
          sessionId: row.sessionId,
          serverId: input.serverId,
          enabled: input.enabled,
          scope: input.scope,
        })
      )
        fail();
      await actualMutation(
        client,
        row,
        details.mutation,
        {
          id: `mcp-select-${e.id}`,
          scope: input.scope,
          ifMatch:
            input.scope === 'user'
              ? input.expectedReadSet.userEtag
              : input.expectedReadSet.workspaceEtag,
          requestDigest: hash({ executionId: e.id, inputDigest: hash(input), ...input }),
        },
        signal,
      );
      return { ...withExecution, phase: 'completed', summary: '原范围选择已保存' };
    }
    if (
      action === 'mcp.catalogue.refresh' &&
      e.status === 'succeeded' &&
      result.outcome === 'succeeded'
    ) {
      const input = row.request.input,
        ref = object(details.operationRef),
        metadata = object(details.toolsMetadata);
      const definitions = details.definitions;
      if (
        !closed(details, [
          'originalStoreId',
          'sessionId',
          'executionId',
          'runId',
          'inputDigest',
          'definitionId',
          'definitionVersion',
          'serverId',
          'configDigest',
          'connectionKey',
          'operationRef',
          'originalConnectionRevision',
          'previousGeneration',
          'adapterAttempted',
          'generation',
          'definitions',
          'toolsMetadata',
        ]) ||
        details.originalStoreId !== row.request.expectedStoreId ||
        details.sessionId !== row.sessionId ||
        details.executionId !== e.id ||
        details.runId !== null ||
        details.inputDigest !== hash(input) ||
        details.definitionId !== e.definitionId ||
        details.definitionVersion !== '1' ||
        details.serverId !== input.serverId ||
        details.configDigest !== input.configDigest ||
        details.connectionKey !== input.connectionKey ||
        details.previousGeneration !== input.generation ||
        !Number.isSafeInteger(details.generation) ||
        Number(details.generation) < input.generation ||
        details.adapterAttempted !== true ||
        !Array.isArray(definitions) ||
        definitions.length > 16384 ||
        !definitions.every(
          (definition) =>
            closed(definition, ['id', 'version']) &&
            typeof object(definition).id === 'string' &&
            typeof object(definition).version === 'string',
        ) ||
        typeof details.originalConnectionRevision !== 'string' ||
        !/^[1-9][0-9]{0,18}$/.test(details.originalConnectionRevision) ||
        !closed(ref, [
          'commandId',
          'sessionId',
          'originStoreId',
          'extensionId',
          'key',
          'executionId',
        ]) ||
        ref.originStoreId !== row.request.expectedStoreId ||
        ref.sessionId !== row.sessionId ||
        ref.extensionId !== 'builtin.mcp' ||
        ref.key !== `connection/${input.serverId}/${input.connectionKey}` ||
        ref.executionId !== input.connectionExecutionId ||
        !id(ref.commandId) ||
        !closed(metadata, ['recordKey', 'availability', 'reason']) ||
        metadata.recordKey !== `tools/${mcpSha(e.id)}` ||
        metadata.availability !== 'available' ||
        metadata.reason !== null
      )
        fail();
      return {
        ...withExecution,
        phase: 'completed',
        summary: `原目录已刷新：${(definitions as unknown[]).length} 个工具，代次 ${details.generation}`,
      };
    }
    if (
      action === 'mcp.credential.bind' &&
      e.status === 'succeeded' &&
      result.outcome === 'succeeded'
    ) {
      const input = row.request.input,
        p = object(details.proof);
      if (
        !closed(details, [
          'mutation',
          'recordKey',
          'decision',
          'proof',
          'connectionAttempted',
          'credentialLookupAttempted',
        ]) ||
        details.connectionAttempted !== false ||
        details.credentialLookupAttempted !== false ||
        !['bind', 'revoke'].includes(String(details.decision)) ||
        typeof details.recordKey !== 'string' ||
        !sha(details.recordKey) ||
        !closed(p, [
          'decisionId',
          'storeId',
          'sessionId',
          'interactionId',
          'acceptedRevision',
          'subjectId',
          'requestDigest',
          'recordedAt',
        ]) ||
        p.storeId !== row.request.expectedStoreId ||
        p.sessionId !== row.sessionId ||
        p.subjectId !== row.subjectId ||
        !id(p.interactionId) ||
        typeof p.acceptedRevision !== 'string' ||
        !/^[1-9][0-9]{0,18}$/.test(p.acceptedRevision) ||
        p.decisionId !== `${p.interactionId}@${p.acceptedRevision}` ||
        !sha(p.requestDigest) ||
        !Number.isSafeInteger(p.recordedAt) ||
        Number(p.recordedAt) < 0
      )
        fail();
      const interaction = await client.getInteraction(
        row.sessionId,
        p.interactionId as string,
        { storeId: row.request.expectedStoreId },
        { signal },
      );
      const q = object(interaction.request),
        server = object(q.server);
      if (
        interaction.kind !== 'question' ||
        interaction.state !== 'answered' ||
        interaction.originStoreId !== row.request.expectedStoreId ||
        interaction.sessionId !== row.sessionId ||
        interaction.executionId !== e.id ||
        interaction.runId !== null ||
        interaction.definitionId !== e.definitionId ||
        interaction.definitionVersion !== '1' ||
        interaction.acceptedDecisionRevision !== p.acceptedRevision ||
        hash(q) !== p.requestDigest ||
        !closed(q, [
          'kind',
          'executionId',
          'originalStoreId',
          'sessionId',
          'server',
          'readSet',
          'authProfileDigest',
          'credentialReferenceDigest',
          'expiresAt',
          'choices',
          'instruction',
        ]) ||
        q.kind !== 'mcp_credential_binding' ||
        q.executionId !== e.id ||
        q.originalStoreId !== row.request.expectedStoreId ||
        q.sessionId !== row.sessionId ||
        server.id !== input.serverId ||
        !equal(q.readSet, input.expectedReadSet) ||
        q.expiresAt !== input.expiresAt ||
        !sha(q.authProfileDigest) ||
        !sha(q.credentialReferenceDigest) ||
        !equal(q.choices, ['bind', 'revoke', 'cancel']) ||
        !equal(interaction.answer, { kind: 'question', answers: { decision: details.decision } })
      )
        fail();
      await actualMutation(
        client,
        row,
        details.mutation,
        { id: `mcp-source-${e.id}`, scope: 'user', ifMatch: input.expectedReadSet.bindingEtag },
        signal,
      );
      return {
        ...withExecution,
        phase: 'completed',
        summary: details.decision === 'bind' ? '原凭据绑定元数据已保存' : '原凭据绑定元数据已撤销',
      };
    }
    if (
      ['failed', 'cancelled'].includes(e.status) &&
      result.outcome === e.status &&
      ((closed(details, ['effectAttempted']) && details.effectAttempted === false) ||
        (closed(details, ['code', 'adapterAttempted']) &&
          details.adapterAttempted === false &&
          typeof details.code === 'string' &&
          result.content === details.code))
    )
      return {
        ...withExecution,
        phase: e.status === 'cancelled' ? 'cancelled' : 'failed',
        summary: '原执行已结束，效果未尝试',
      };
    return { ...unknown, executionId: e.id };
  } catch {
    return unknown;
  }
}
