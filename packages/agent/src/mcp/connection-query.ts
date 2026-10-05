import { createHash } from 'node:crypto';
import type { Json, PublicExecution, ReadContext } from '../extensions';
import { canonicalJson } from '../json';
import { proveConnectionParent } from './reconnection-proof';

const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const sha = (v: unknown) =>
  createHash('sha256')
    .update(canonicalJson(v as Json))
    .digest('hex');
const id = (v: unknown, max = 128) =>
  typeof v === 'string' && new RegExp(`^[A-Za-z0-9_-]{1,${max}}$`).test(v);
function projection(e: PublicExecution, input = true) {
  return {
    id: e.id,
    originStoreId: e.originStoreId ?? null,
    sessionId: e.sessionId,
    originCommandId: e.originCommandId ?? null,
    parentExecutionId: e.parentExecutionId ?? null,
    kind: e.kind,
    definitionId: e.definitionId ?? null,
    definitionVersion: e.definitionVersion ?? null,
    ...(input ? { inputDigest: e.inputDigest ?? null } : {}),
    status: e.status,
  };
}
export async function readConnection(
  context: ReadContext,
  input: { executionId: string; serverId: string; key: string },
  current: (
    originStoreId: string,
    serverId: string,
    executionId: string,
    configDigest: string,
  ) => { live: boolean; generation: number | null },
) {
  if (!context.readExecutionGroupSafety) throw Error('mcp_connection_scope_unavailable');
  const safety = await context.readExecutionGroupSafety();
  const e = await context.getExecution(input.executionId);
  if (
    !e ||
    e.sessionId !== context.sessionId ||
    e.kind !== 'job' ||
    e.runId !== null ||
    e.definitionId !== 'builtin.mcp/mcp.connect' ||
    e.definitionVersion !== '1' ||
    !e.originStoreId ||
    !id(e.originCommandId) ||
    e.inputDigest !== sha({ serverId: input.serverId, key: input.key })
  )
    throw Error('mcp_connection_scope_unavailable');
  const details = obj(obj(e.result).details);
  const raw = details.operationRef;
  let operationRef: Record<string, unknown> | null = null;
  let connection: PublicExecution | null = null;
  let ready: Record<string, unknown> | null = null;
  let live = false,
    currentGeneration: number | null = null,
    created: boolean | null = null;
  let phase = ['planned', 'dispatching', 'running'].includes(e.status)
    ? 'pending'
    : 'outcome_unknown';
  let reason: string | null = phase === 'pending' ? null : 'mcp_connection_unconfirmed';
  if (raw !== undefined) {
    const r = obj(raw),
      keys = Object.keys(r);
    if (
      keys.length === 6 + (r.childSessionId === undefined ? 0 : 1) &&
      keys.every((k) =>
        [
          'commandId',
          'sessionId',
          'originStoreId',
          'extensionId',
          'key',
          'executionId',
          'childSessionId',
        ].includes(k),
      ) &&
      id(r.commandId) &&
      r.sessionId === context.sessionId &&
      r.originStoreId === e.originStoreId &&
      r.extensionId === 'builtin.mcp' &&
      id(r.executionId) &&
      r.childSessionId === undefined &&
      typeof r.key === 'string' &&
      r.key.startsWith(`connection/${input.serverId}/`) &&
      id(r.key.slice(`connection/${input.serverId}/`.length), 64)
    ) {
      const c = await context.getExecution(r.executionId as string);
      const config = details.configDigest;
      let parentValid = false;
      if (c && typeof config === 'string') {
        try {
          await proveConnectionParent(context, c, r, input.serverId, config);
          parentValid = true;
        } catch {
          /* Exact parent proof failed. */
        }
      }
      if (
        c &&
        parentValid &&
        c.kind === 'job' &&
        c.sessionId === context.sessionId &&
        c.originStoreId === e.originStoreId &&
        c.originCommandId === r.commandId &&
        typeof config === 'string' &&
        /^[a-f0-9]{64}$/.test(config) &&
        ((c.definitionId === 'mcp.source.connection' && c.definitionVersion === '1') ||
          (c.definitionId === `mcp.connection.${input.serverId}` && c.definitionVersion === config))
      ) {
        operationRef = { ...r };
        connection = c;
        created =
          r.key === `connection/${input.serverId}/${input.key}` && c.parentExecutionId === e.id;
        if (
          e.status === 'succeeded' &&
          obj(e.result).outcome === 'succeeded' &&
          details.originalStoreId === e.originStoreId &&
          details.serverId === input.serverId &&
          Number.isSafeInteger(details.generation) &&
          Number(details.generation) > 0 &&
          Array.isArray(details.definitions) &&
          details.definitions.length <= 16384 &&
          details.definitions.every((definition) => {
            const d = obj(definition);
            return (
              Object.keys(d).length === 2 &&
              typeof d.id === 'string' &&
              typeof d.version === 'string' &&
              d.id.length > 0 &&
              d.version.length > 0
            );
          })
        ) {
          ready = {
            serverId: input.serverId,
            configDigest: config,
            generation: details.generation,
            toolCount: details.definitions.length,
          };
          phase = 'ready';
          reason = null;
          const now = current(e.originStoreId, input.serverId, c.id, config);
          live = now.live;
          currentGeneration = now.generation;
        }
      }
    }
  } else if (
    ['failed', 'cancelled'].includes(e.status) &&
    details.adapterAttempted === false &&
    (obj(e.result).outcome === 'failed' || obj(e.result).outcome === 'cancelled')
  ) {
    phase = 'failed';
    reason = 'mcp_connection_not_attempted';
  }
  return {
    storeId: safety.originStoreId,
    sessionId: context.sessionId,
    execution: projection(e),
    phase,
    operationRef,
    connection: connection ? projection(connection, false) : null,
    ready,
    live,
    currentGeneration,
    created,
    reason,
  };
}
