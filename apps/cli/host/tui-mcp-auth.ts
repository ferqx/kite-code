import type { AgentClient, QueryResponse } from '@kite-ai/client';
import type {
  TuiCallerIntent,
  TuiCallerPort,
  TuiMcpAuthFact,
  TuiMcpAuthPort,
  TuiMcpAuthStatus,
  TuiMcpSourceApprovalPort,
  TuiMcpSourceSnapshot,
} from '@kite-ai/ui/tui';
import { mcpAuthRequest } from '@kite-ai/ui/tui';
import { callerDigest, callerRequestDigest, parseCallerIntent } from './caller-intents';
import { mcpCanonical, mcpSha } from './mcp-selection-intents';
import {
  parseMcpSourceReadSet,
  sourceClosed,
  sourceId,
  sourceServerId,
  sourceSha,
} from './mcp-source-approval-intents';

const invalid = () => Error('mcp_auth_fact_invalid');
const closed = (value: unknown, keys: string[]) => {
  try {
    return sourceClosed(value, keys);
  } catch {
    throw invalid();
  }
};
const code = (v: unknown) => typeof v === 'string' && /^[a-z][a-z0-9_]{0,127}$/.test(v);
function envelope(result: QueryResponse, type: string) {
  if (
    !Array.isArray(result) ||
    result.length !== 1 ||
    Buffer.byteLength(JSON.stringify(result)) > 16384
  )
    throw invalid();
  const row = closed(result[0], [
    'extensionId',
    'contentType',
    'contentVersion',
    'summary',
    'payload',
    'actions',
    'artifactRefs',
  ]);
  if (
    row.extensionId !== 'builtin.mcp.sources' ||
    row.contentType !== type ||
    row.contentVersion !== 1 ||
    typeof row.summary !== 'string' ||
    row.summary.length > 512 ||
    !Array.isArray(row.actions) ||
    row.actions.length ||
    !Array.isArray(row.artifactRefs) ||
    row.artifactRefs.length
  )
    throw invalid();
  return row.payload;
}
export function decodeMcpAuthStatus(result: QueryResponse): TuiMcpAuthStatus {
  const row = closed(envelope(result, 'builtin.mcp.auth.status'), [
    'serverId',
    'workspaceId',
    'loginAllowed',
    'policy',
    'status',
    'credentialPresent',
  ]);
  if (
    !sourceServerId(row.serverId) ||
    !sourceId(row.workspaceId) ||
    typeof row.loginAllowed !== 'boolean' ||
    typeof row.credentialPresent !== 'boolean' ||
    typeof row.policy !== 'string' ||
    !['oauth', 'auto'].includes(row.policy) ||
    typeof row.status !== 'string' ||
    !['available', 'locked', 'unavailable'].includes(row.status)
  )
    throw invalid();
  return structuredClone(row) as unknown as TuiMcpAuthStatus;
}
export function decodeMcpAuthFact(result: QueryResponse): TuiMcpAuthFact {
  const row = closed(envelope(result, 'builtin.mcp.auth.result'), [
    'storeId',
    'sessionId',
    'command',
    'execution',
    'binding',
    'phase',
    'authStatus',
    'effectAttempted',
    'reason',
  ]);
  if (
    !sourceId(row.storeId) ||
    !sourceId(row.sessionId) ||
    typeof row.phase !== 'string' ||
    !['pending', 'completed', 'failed', 'cancelled', 'outcome_unknown'].includes(row.phase) ||
    typeof row.authStatus !== 'string' ||
    ![
      'authenticated',
      'revoked',
      'not_supported',
      'reauth_required',
      'error',
      'cancelled',
      'unknown',
    ].includes(row.authStatus) ||
    (row.effectAttempted !== null && typeof row.effectAttempted !== 'boolean') ||
    (row.reason !== null && !code(row.reason))
  )
    throw invalid();
  if (row.command !== null) {
    const c = closed(row.command, [
      'id',
      'originStoreId',
      'sessionId',
      'subjectId',
      'requestDigest',
      'status',
      'executionId',
    ]);
    if (
      ![c.id, c.originStoreId, c.sessionId].every(sourceId) ||
      typeof c.subjectId !== 'string' ||
      !c.subjectId ||
      c.subjectId.length > 256 ||
      !sourceSha(c.requestDigest) ||
      typeof c.status !== 'string' ||
      !['accepted', 'applied', 'rejected', 'needs_review'].includes(c.status) ||
      (c.executionId !== null && !sourceId(c.executionId))
    )
      throw invalid();
  }
  if (row.execution !== null) {
    const e = closed(row.execution, [
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
      ![e.id, e.originStoreId, e.sessionId, e.originCommandId].every(sourceId) ||
      e.parentExecutionId !== null ||
      e.kind !== 'job' ||
      typeof e.definitionId !== 'string' ||
      !/^builtin\.mcp\.sources\/mcp\.auth\.(login|refresh|clear|revoke)$/.test(e.definitionId) ||
      e.definitionVersion !== '1' ||
      !sourceSha(e.inputDigest) ||
      typeof e.status !== 'string' ||
      ![
        'planned',
        'dispatching',
        'running',
        'succeeded',
        'failed',
        'cancelled',
        'outcome_unknown',
      ].includes(e.status)
    )
      throw invalid();
  }
  if (row.binding !== null) {
    const b = closed(row.binding, [
      'version',
      'executionId',
      'originCommandId',
      'originalStoreId',
      'sessionId',
      'workspaceId',
      'actionId',
      'serverId',
      'inputDigest',
    ]);
    if (
      b.version !== 1 ||
      ![b.executionId, b.originCommandId, b.originalStoreId, b.sessionId, b.workspaceId].every(
        sourceId,
      ) ||
      !sourceServerId(b.serverId) ||
      !sourceSha(b.inputDigest) ||
      typeof b.actionId !== 'string' ||
      !['mcp.auth.login', 'mcp.auth.refresh', 'mcp.auth.clear', 'mcp.auth.revoke'].includes(
        b.actionId,
      )
    )
      throw invalid();
  }
  return structuredClone(row) as unknown as TuiMcpAuthFact;
}
export function createTuiMcpAuthPort(input: {
  client: Pick<AgentClient, 'serverInfo' | 'queryExtension'>;
  storeId: string;
  callers: TuiCallerPort;
  sources: TuiMcpSourceApprovalPort;
}): TuiMcpAuthPort {
  const terminal = new Set<string>(),
    prepared = new WeakSet<TuiCallerIntent>();
  const admit = (intent: TuiCallerIntent) => {
    const request = mcpAuthRequest(intent),
      info = input.client.serverInfo;
    if (
      !request ||
      !info ||
      info.storeId !== input.storeId ||
      intent.scope.storeId !== info.storeId ||
      request.expectedStoreId !== info.storeId ||
      intent.subjectId !== info.subjectId ||
      callerDigest(request) !== intent.bodyDigest ||
      callerRequestDigest(request) !== intent.requestDigest
    )
      throw invalid();
    return request;
  };
  const fresh = async (observed: TuiMcpSourceSnapshot, serverId: string, signal: AbortSignal) => {
    if (
      input.client.serverInfo?.storeId !== input.storeId ||
      !input.client.serverInfo.subjectId ||
      observed.storeId !== input.storeId ||
      !sourceServerId(serverId) ||
      !observed.readSet ||
      !observed.items.some((x) => x.id === serverId && x.transport === 'http')
    )
      throw invalid();
    const actual = await input.sources.read(observed.sessionId, signal);
    signal.throwIfAborted();
    if (mcpCanonical(actual) !== mcpCanonical(observed)) throw Error('mcp_auth_source_changed');
    parseMcpSourceReadSet(actual.readSet);
    return actual;
  };
  return {
    async read(observed, serverId, signal) {
      await fresh(observed, serverId, signal);
      const readSet = JSON.parse(JSON.stringify(observed.readSet));
      const result = decodeMcpAuthStatus(
        await input.client.queryExtension(
          observed.sessionId,
          'builtin.mcp.sources',
          'mcp.auth.status',
          { serverId, expectedReadSet: readSet },
          { signal },
        ),
      );
      signal.throwIfAborted();
      if (result.serverId !== serverId || result.workspaceId !== observed.workspaceId)
        throw invalid();
      return result;
    },
    async prepare(request, observed) {
      if (
        request.kind !== 'extension.invoke' ||
        !['mcp.auth.login', 'mcp.auth.refresh', 'mcp.auth.clear', 'mcp.auth.revoke'].includes(
          request.actionId,
        )
      )
        throw invalid();
      const serverId = request.input.serverId;
      if (
        typeof serverId !== 'string' ||
        mcpCanonical(request.input.expectedReadSet) !== mcpCanonical(observed.readSet)
      )
        throw invalid();
      await fresh(observed, serverId, new AbortController().signal);
      const rows = await input.callers.list();
      const ids = new Set(rows.map((row) => row.intent.request.commandId));
      for (const id of terminal) if (!ids.has(id)) terminal.delete(id);
      if (
        rows.some((row) => {
          const r = mcpAuthRequest(row.intent);
          return (
            r &&
            row.intent.scope.storeId === input.storeId &&
            row.intent.scope.sessionId === observed.sessionId &&
            r.input.serverId === serverId &&
            !terminal.has(row.intent.request.commandId)
          );
        })
      )
        throw Error('mcp_auth_original_unverified');
      const intent = await input.callers.prepare(
        {
          storeId: observed.storeId,
          sessionId: observed.sessionId,
          workspaceId: observed.workspaceId,
        },
        request,
      );
      admit(intent);
      prepared.add(intent);
      return intent;
    },
    async submit(intent) {
      admit(intent);
      if (!prepared.delete(intent))
        return input.callers.lookup(intent, new AbortController().signal);
      return input.callers.submit(intent);
    },
    async lookup(raw, signal) {
      const intent = parseCallerIntent(raw),
        unknown = { intent, phase: 'outcome_unknown' as const };
      try {
        const request = admit(intent),
          caller = await input.callers.lookup(intent, signal);
        signal.throwIfAborted();
        admit(intent);
        const c = caller.command;
        if (
          !c ||
          c.id !== request.commandId ||
          c.originStoreId !== intent.scope.storeId ||
          c.sessionId !== intent.scope.sessionId ||
          c.subjectId !== intent.subjectId ||
          c.kind !== 'extension.invoke' ||
          c.requestDigest !== intent.requestDigest
        )
          return unknown;
        const fact = decodeMcpAuthFact(
          await input.client.queryExtension(
            intent.scope.sessionId,
            'builtin.mcp.sources',
            'mcp.auth.result',
            { commandId: request.commandId },
            { signal },
          ),
        );
        signal.throwIfAborted();
        admit(intent);
        const receipt =
          c.receipt !== null && typeof c.receipt === 'object' && !Array.isArray(c.receipt)
            ? c.receipt
            : undefined;
        const fc = fact.command,
          e = fact.execution,
          b = fact.binding;
        if (
          fact.storeId !== intent.scope.storeId ||
          fact.sessionId !== intent.scope.sessionId ||
          !fc ||
          fc.id !== c.id ||
          fc.originStoreId !== c.originStoreId ||
          fc.sessionId !== c.sessionId ||
          fc.subjectId !== intent.subjectId ||
          fc.requestDigest !== intent.requestDigest ||
          fc.status !== c.status
        )
          return unknown;
        if (e) {
          if (
            !b ||
            e.id !== fc.executionId ||
            e.id !== receipt?.executionId ||
            e.originStoreId !== intent.scope.storeId ||
            e.sessionId !== intent.scope.sessionId ||
            e.originCommandId !== request.commandId ||
            e.definitionId !== `builtin.mcp.sources/${request.actionId}` ||
            e.inputDigest !== mcpSha(request.input) ||
            mcpCanonical(b) !==
              mcpCanonical({
                version: 1,
                executionId: e.id,
                originCommandId: request.commandId,
                originalStoreId: intent.scope.storeId,
                sessionId: intent.scope.sessionId,
                workspaceId: intent.scope.workspaceId,
                actionId: request.actionId,
                serverId: request.input.serverId,
                inputDigest: mcpSha(request.input),
              })
          )
            return unknown;
        }
        if (fact.phase === 'pending') {
          if (
            (!e && c.status !== 'accepted') ||
            (e && !['planned', 'dispatching', 'running'].includes(e.status)) ||
            fact.authStatus !== 'unknown' ||
            fact.effectAttempted !== null ||
            fact.reason !== null
          )
            return unknown;
        } else if (fact.phase !== 'outcome_unknown') {
          if (
            !e ||
            !b ||
            c.status !== 'applied' ||
            receipt?.status !== e.status ||
            receipt?.preparingNextAttempt !== false ||
            !sourceSha(receipt?.finalizationDigest) ||
            !code(fact.reason)
          )
            return unknown;
          if (fact.phase === 'completed') {
            const login = ['mcp.auth.login', 'mcp.auth.refresh'].includes(request.actionId);
            if (
              e.status !== 'succeeded' ||
              fact.effectAttempted !== true ||
              (login
                ? fact.authStatus !== 'authenticated' || fact.reason !== 'mcp_oauth_authenticated'
                : fact.authStatus === 'revoked'
                  ? fact.reason !== 'mcp_oauth_credentials_cleared'
                  : request.actionId !== 'mcp.auth.revoke' ||
                    fact.authStatus !== 'not_supported' ||
                    fact.reason !== 'mcp_oauth_revocation_not_supported')
            )
              return unknown;
          } else if (
            e.status !== fact.phase ||
            !['reauth_required', 'error', 'cancelled', 'unknown'].includes(fact.authStatus) ||
            typeof fact.effectAttempted !== 'boolean'
          )
            return unknown;
          terminal.add(request.commandId);
        }
        return { intent, phase: fact.phase, fact, caller };
      } catch {
        return unknown;
      }
    },
  };
}
