import type { ReadContext } from '../extensions';
import {
  closed,
  confirmedStop,
  decodeOperationRef,
  decodeResultDetails,
  decodeStage,
  equal,
  object,
  projectExecution,
  proveCarrier,
  proveConnectionParent,
  savedReconnection,
  stoppedOrUnopened,
} from './reconnection-proof';

export async function readReconnection(
  context: ReadContext,
  executionId: string,
  current: (
    storeId: string,
    serverId: string,
    executionId: string,
    configDigest: string,
  ) =>
    | { live: boolean; generation: number | null }
    | Promise<{ live: boolean; generation: number | null }>,
) {
  if (!context.readExecutionGroupSafety) throw Error('mcp_reconnection_scope_unavailable');
  const safety = await context.readExecutionGroupSafety(),
    e = await context.getExecution(executionId);
  if (
    e?.kind !== 'job' ||
    e.definitionId !== 'builtin.mcp/mcp.reconnect' ||
    e.definitionVersion !== '1' ||
    e.sessionId !== context.sessionId ||
    e.originStoreId !== safety.originStoreId ||
    !e.inputDigest
  )
    throw Error('mcp_reconnection_scope_unavailable');
  let phase = 'outcome_unknown',
    reason: string | null = 'mcp_reconnection_unconfirmed';
  let target: unknown = null,
    oldExecution: (ReturnType<typeof projectExecution> & { resultRevision: string }) | null = null;
  let newOperationRef: unknown = null,
    newConnection: ReturnType<typeof projectExecution> | null = null,
    ready: unknown = null,
    live = false,
    currentGeneration: number | null = null;
  const record = await context.records.get(`reconnection/${e.id}`);
  if (!record) {
    if (['planned', 'dispatching', 'running'].includes(e.status)) {
      phase = 'pending';
      reason = null;
    } else {
      const result = object(e.result),
        details = object(result.details);
      try {
        closed(result, ['outcome', 'content', 'details']);
        closed(details, ['code', 'adapterAttempted']);
        if (
          e.status === 'failed' &&
          result.outcome === 'failed' &&
          details.adapterAttempted === false &&
          typeof details.code === 'string' &&
          ['approval_denied', 'permission_denied'].includes(details.code) &&
          result.content === details.code
        ) {
          phase = 'failed';
          reason = String(details.code);
        }
      } catch {
        /* No closed zero-adapter proof means unknown. */
      }
    }
  } else {
    const stage = decodeStage(record, e),
      input = stage.input;
    target = input.target;
    const old = await proveCarrier(
      context,
      input.target.carrierExecutionId,
      input.target.carrierKey,
      input.serverId,
    );
    if (
      old.record.revision !== stage.targetRecordRevision ||
      !equal(old.ref, input.target.operationRef) ||
      old.connection.id !== input.target.connectionExecutionId ||
      old.catalogue.configDigest !== input.target.configDigest
    )
      throw Error('mcp_reconnection_scope_unavailable');
    const stopped = await confirmedStop(context, input, stage.oldStop);
    if (stopped)
      oldExecution = { ...projectExecution(stopped), resultRevision: stopped.resultRevision };
    if (stage.newOperationRef) {
      const ref = decodeOperationRef(stage.newOperationRef),
        n = await context.getExecution(ref.executionId);
      if (
        !n ||
        ref.key !== `connection/${input.serverId}/${input.key}` ||
        ref.originStoreId !== e.originStoreId ||
        ref.sessionId !== context.sessionId ||
        n.id !== ref.executionId ||
        n.originCommandId !== ref.commandId ||
        n.parentExecutionId !== e.id ||
        n.sessionId !== e.sessionId ||
        n.originStoreId !== e.originStoreId ||
        n.rootWorkCommandId !== e.rootWorkCommandId ||
        n.rootWorkSeq !== e.rootWorkSeq ||
        n.kind !== 'job' ||
        n.definitionId !==
          (input.replacement.kind === 'source'
            ? 'mcp.source.connection'
            : `mcp.connection.${input.serverId}`) ||
        n.definitionVersion !==
          (input.replacement.kind === 'source' ? '1' : input.replacement.expectedConfigDigest)
      )
        throw Error('mcp_reconnection_scope_unavailable');
      newOperationRef = ref;
      newConnection = projectExecution(n);
    }
    if (['planned', 'dispatching', 'running'].includes(e.status)) {
      phase = 'pending';
      reason = null;
    } else if (e.status === 'succeeded') {
      const saved = await savedReconnection(context, e),
        c = saved.catalogue,
        r = decodeOperationRef(c.operationRef),
        n = await context.getExecution(r.executionId);
      const catalogueRecord = await context.records.get(
        `connection/${input.serverId}/${input.key}`,
      );
      if (
        !n ||
        !catalogueRecord ||
        catalogueRecord.forkProvenance ||
        catalogueRecord.contentType !== 'builtin.mcp.catalogue' ||
        catalogueRecord.contentVersion !== 1 ||
        catalogueRecord.originStoreId !== e.originStoreId ||
        catalogueRecord.sessionId !== e.sessionId ||
        !equal(catalogueRecord.value, c) ||
        n.parentExecutionId !== e.id
      )
        throw Error('mcp_reconnection_scope_unavailable');
      await proveConnectionParent(context, n, r, input.serverId, String(c.configDigest));
      ready = {
        serverId: input.serverId,
        configDigest: c.configDigest,
        generation: c.generation,
        toolCount: (c.definitions as unknown[]).length,
      };
      const now = await current(e.originStoreId!, input.serverId, n.id, String(c.configDigest));
      live = now.live;
      currentGeneration = now.live ? now.generation : null;
      phase = 'ready';
      reason = null;
    } else {
      try {
        const d = decodeResultDetails(e),
          result = object(e.result);
        if (
          d.originalStoreId !== e.originStoreId ||
          d.serverId !== input.serverId ||
          !equal(d.target, input.target) ||
          !equal(d.oldStop, stage.oldStop) ||
          !equal(d.newOperationRef, stage.newOperationRef) ||
          !equal(d.catalogue, stage.catalogue)
        )
          throw Error('mcp_reconnection_scope_unavailable');
        const newTerminal = stage.newOperationRef
          ? await context.getExecution(stage.newOperationRef.executionId)
          : null;
        const noNew =
          (d.newConnectionAttempted === false && stage.newOperationRef === null) ||
          (d.newConnectionAttempted === true && !!newTerminal && stoppedOrUnopened(newTerminal));
        if (
          e.status === 'failed' &&
          result.outcome === e.status &&
          noNew &&
          d.catalogue === null &&
          (d.stopAttempted === false || stopped)
        ) {
          phase = e.status;
          reason = 'mcp_reconnection_not_established';
        }
        // A local aborted signal is not a durable user cancellation proof.
      } catch {
        /* Partial or malformed result stays unknown. */
      }
    }
  }
  return {
    storeId: safety.originStoreId,
    sessionId: context.sessionId,
    execution: projectExecution(e, true),
    phase,
    target,
    oldStop: { confirmed: oldExecution !== null, execution: oldExecution },
    newOperationRef,
    newConnection,
    ready,
    live,
    currentGeneration,
    reason,
  };
}
