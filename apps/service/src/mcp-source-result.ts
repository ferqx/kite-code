import { createHash } from 'node:crypto';
import { AgentError, type AgentRuntime } from '@kite-ai/agent';
import { mcpCanonical } from '@kite-ai/agent/config';
import type { Json, QueryDefinition } from '@kite-ai/agent/extensions';

const hash = (value: unknown) => createHash('sha256').update(mcpCanonical(value)).digest('hex');
const object = (value: unknown): Record<string, Json> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, Json>)
    : {};
const closed = (v: Record<string, Json>, keys: string[]) =>
  Object.keys(v).length === keys.length && keys.every((k) => Object.hasOwn(v, k));
const equal = (a: unknown, b: unknown) => mcpCanonical(a) === mcpCanonical(b);
const hex = (v: Json | undefined) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
export function validMcpSourceReadSet(value: unknown): boolean {
  const v = object(value);
  const read = (x: unknown, kind: string) => {
    const r = object(x),
      i = object(r.identity);
    return (
      closed(r, ['identity', 'etag', 'error']) &&
      closed(i, ['kind', 'pathDigest', 'rootIdentity']) &&
      i.kind === kind &&
      hex(i.pathDigest) &&
      hex(i.rootIdentity) &&
      (r.etag === null || hex(r.etag)) &&
      (r.error === null || typeof r.error === 'string')
    );
  };
  return (
    closed(v, [
      'scopeDigest',
      'user',
      'workspace',
      'approvalEtag',
      'bindingEtag',
      'variablesDigest',
    ]) &&
    hex(v.scopeDigest) &&
    hex(v.variablesDigest) &&
    read(v.user, 'user') &&
    (v.workspace === null || read(v.workspace, 'workspace')) &&
    (v.approvalEtag === null || hex(v.approvalEtag)) &&
    (v.bindingEtag === null || hex(v.bindingEtag))
  );
}
type Host = Pick<
  AgentRuntime,
  | 'getMetadata'
  | 'getSession'
  | 'getCommand'
  | 'getExecution'
  | 'getInteraction'
  | 'getHostMutation'
>;
/** History only: never resolves current source files, Workspace paths, transports or credentials. */
export function createMcpSourceResultQuery(options: {
  runtime(): Host;
  profileAccessKey: string;
  observerSubjectId?: string;
}): QueryDefinition {
  const subjectId = options.observerSubjectId;
  return {
    id: 'mcp.source.result',
    version: '1',
    description: 'Read one original source decision proof without publishing or connecting',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['commandId'],
      properties: { commandId: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,128}$' } },
    },
    outputSchema: { type: 'array' },
    async execute(input, context) {
      if (!context.readExecutionGroupSafety) throw new AgentError('source_observer_unavailable');
      const admission = await context.readExecutionGroupSafety();
      const host = options.runtime();
      const metadata = await host.getMetadata();
      if (admission.originStoreId !== metadata.storeId)
        throw new AgentError('operation_unverifiable');
      const payload: Record<string, Json> = {
        storeId: metadata.storeId,
        sessionId: context.sessionId,
        command: null,
        execution: null,
        serverId: null,
        phase: 'outcome_unknown',
        decision: null,
        proof: null,
        mutation: null,
        recordKey: null,
        reason: 'original_proof_unavailable',
      };
      const display = () => {
        const value = [
          {
            extensionId: 'builtin.mcp.sources',
            contentType: 'builtin.mcp.source.result',
            contentVersion: 1,
            summary: 'Original source decision; no connection or Tool permission',
            payload,
            artifactRefs: [],
            actions: [],
          },
        ];
        if (Buffer.byteLength(JSON.stringify(value)) > 16384)
          throw new AgentError('source_result_limit');
        return value;
      };
      if (!subjectId || subjectId.length > 256) {
        payload.reason = 'source_observer_unavailable';
        return display();
      }
      const command = await host.getCommand(String(object(input).commandId));
      if (!command) return display();
      if (
        command.sessionId !== context.sessionId ||
        command.originStoreId !== metadata.storeId ||
        command.subjectId !== subjectId
      ) {
        payload.reason = 'source_observer_denied';
        return display();
      }
      if (command.id !== String(object(input).commandId) || command.kind !== 'extension.invoke')
        return display();
      const request = object(command.request),
        ownInput = object(request.input),
        receipt = object(command.receipt);
      if (
        !closed(request, ['kind', 'extensionId', 'actionId', 'definitionVersion', 'input']) ||
        !validMcpSourceReadSet(ownInput.expectedReadSet) ||
        request.kind !== 'extension.invoke' ||
        request.extensionId !== 'builtin.mcp.sources' ||
        request.actionId !== 'mcp.source.approve' ||
        request.definitionVersion !== '1' ||
        hash(command.request) !== command.requestDigest ||
        !closed(ownInput, ['serverId', 'expectedReadSet']) ||
        typeof ownInput.serverId !== 'string' ||
        !/^mcp-[a-f0-9]{64}$/.test(ownInput.serverId)
      )
        throw new AgentError('operation_unverifiable');
      payload.serverId = ownInput.serverId;
      payload.command = {
        id: command.id,
        originStoreId: command.originStoreId,
        sessionId: command.sessionId,
        subjectId: command.subjectId,
        kind: 'extension.invoke',
        requestDigest: command.requestDigest,
        status: command.status,
        executionId: typeof receipt.executionId === 'string' ? receipt.executionId : null,
      };
      if (typeof receipt.executionId !== 'string') {
        if (command.status === 'accepted') {
          payload.phase = 'pending';
          payload.reason = null;
        }
        return display();
      }
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(receipt.executionId)) return display();
      payload.reason = 'execution_scope_unavailable';
      const execution = await host.getExecution(receipt.executionId);
      if (
        !execution ||
        execution.originStoreId !== metadata.storeId ||
        execution.sessionId !== context.sessionId ||
        execution.originCommandId !== command.id ||
        execution.parentExecutionId !== null ||
        execution.runId !== null ||
        execution.kind !== 'job' ||
        execution.definitionId !== 'builtin.mcp.sources/mcp.source.approve' ||
        execution.definitionVersion !== '1' ||
        execution.rootWorkCommandId !== command.rootWorkCommandId ||
        execution.rootWorkSeq !== command.rootWorkSeq ||
        !equal(execution.input, request.input)
      )
        return display();
      payload.execution = {
        id: execution.id,
        originStoreId: execution.originStoreId,
        sessionId: execution.sessionId,
        originCommandId: execution.originCommandId,
        parentExecutionId: null,
        kind: 'job',
        definitionId: execution.definitionId,
        definitionVersion: execution.definitionVersion,
        inputDigest: hash(execution.input),
        status: execution.status,
      };
      const mutation = await host.getHostMutation({
        expectedStoreId: metadata.storeId,
        subjectId,
        commandId: `mcp-source-${execution.id}`,
      });
      const mutationReceipt = object(mutation?.receipt);
      if (
        mutation &&
        (mutation.id !== `mcp-source-${execution.id}` ||
          mutation.originStoreId !== metadata.storeId ||
          mutation.subjectId !== subjectId ||
          mutation.kind !== 'config.user.write' ||
          mutation.scope !== 'user')
      )
        return display();
      if (mutation)
        payload.mutation = {
          id: mutation.id,
          originStoreId: mutation.originStoreId,
          subjectId: mutation.subjectId,
          kind: mutation.kind,
          scope: mutation.scope,
          requestDigest: mutation.requestDigest,
          state: mutation.state,
          etag: typeof mutationReceipt.etag === 'string' ? mutationReceipt.etag : null,
        };
      if (['planned', 'dispatching', 'running'].includes(execution.status)) {
        if (mutation) {
          payload.reason = 'partial_mutation_unverifiable';
          return display();
        }
        payload.phase = 'pending';
        payload.reason = null;
        return display();
      }
      payload.reason = 'action_receipt_unverifiable';
      if (receipt.status !== execution.status || receipt.preparingNextAttempt === true)
        return display();
      if (
        receipt.finalizationDigest !==
        hash({
          status: execution.status,
          preparingNextAttempt: false,
          result: execution.result,
          writes: [],
          message: null,
        })
      )
        return display();
      const result = object(execution.result),
        details = object(result.details);
      const code = details.code;
      if (
        !mutation &&
        ['failed', 'cancelled'].includes(execution.status) &&
        result.outcome === execution.status &&
        closed(result, ['outcome', 'content', 'details']) &&
        closed(details, ['code', 'adapterAttempted']) &&
        details.adapterAttempted === false &&
        typeof code === 'string' &&
        result.content === code &&
        [
          'approval_denied',
          'permission_denied',
          'cancelled_before_dispatch',
          'cancel_requested',
          'execution_cancel_requested',
        ].includes(code) &&
        (execution.status !== 'cancelled' ||
          command.cancelRequestedAt !== null ||
          execution.cancelRequestedAt !== null)
      ) {
        payload.phase = execution.status;
        payload.reason = code;
        return display();
      }
      payload.reason = 'decision_proof_unavailable';
      const proof = object(details.proof);
      if (
        !closed(proof, [
          'decisionId',
          'storeId',
          'sessionId',
          'interactionId',
          'acceptedRevision',
          'subjectId',
          'requestDigest',
          'recordedAt',
        ])
      ) {
        if (
          !mutation &&
          execution.status === 'failed' &&
          result.outcome === 'failed' &&
          closed(result, ['outcome', 'content', 'details']) &&
          closed(details, ['effectAttempted']) &&
          typeof result.content === 'string' &&
          /^[a-z][a-z0-9_]{0,127}$/.test(result.content) &&
          details.effectAttempted === false
        ) {
          payload.phase = 'failed';
          payload.reason = 'source_not_published';
        }
        return display();
      }
      if (
        typeof proof.interactionId !== 'string' ||
        typeof proof.acceptedRevision !== 'string' ||
        !/^[1-9][0-9]{0,255}$/.test(proof.acceptedRevision) ||
        typeof proof.recordedAt !== 'number' ||
        !Number.isSafeInteger(proof.recordedAt) ||
        proof.recordedAt <= 0 ||
        proof.storeId !== metadata.storeId ||
        proof.sessionId !== context.sessionId ||
        proof.subjectId !== subjectId ||
        proof.decisionId !== `${proof.interactionId}@${proof.acceptedRevision}`
      )
        return display();
      payload.reason = 'question_proof_unverifiable';
      const actual = await host.getInteraction({
        expectedStoreId: metadata.storeId,
        sessionId: context.sessionId,
        interactionId: proof.interactionId,
      });
      const question = object(actual?.request),
        answer = object(object(actual?.answer).answers),
        readSet = object(question.readSet),
        server = object(question.server);
      if (
        !actual ||
        actual.originStoreId !== metadata.storeId ||
        actual.sessionId !== context.sessionId ||
        actual.subjectId !== subjectId ||
        actual.executionId !== execution.id ||
        actual.runId !== null ||
        actual.kind !== 'question' ||
        actual.state !== 'answered' ||
        actual.definitionId !== execution.definitionId ||
        actual.definitionVersion !== '1' ||
        actual.acceptedDecisionRevision !== proof.acceptedRevision ||
        hash(actual.request) !== proof.requestDigest ||
        !closed(question, [
          'kind',
          'executionId',
          'originalStoreId',
          'sessionId',
          'server',
          'readSet',
          'choices',
          'instruction',
          ...(Object.hasOwn(question, 'schema') ? ['schema'] : []),
        ]) ||
        !equal(question.choices, ['approved', 'rejected', 'cancel']) ||
        !closed(object(server.source), ['kind', 'pathDigest', 'rootIdentity']) ||
        object(server.source).kind !== 'workspace' ||
        !hex(object(server.source).pathDigest) ||
        !hex(object(server.source).rootIdentity) ||
        !hex(server.rawEntryDigest) ||
        !hex(server.transportDigest) ||
        question.kind !== 'mcp_source_approval' ||
        question.executionId !== execution.id ||
        question.originalStoreId !== metadata.storeId ||
        question.sessionId !== context.sessionId ||
        server.id !== ownInput.serverId ||
        !equal(readSet, ownInput.expectedReadSet) ||
        object(actual.answer).kind !== 'question' ||
        !closed(answer, ['decision']) ||
        answer.decision !== details.decision
      )
        return display();
      const session = await host.getSession(context.sessionId);
      if (
        !session ||
        session.id !== context.sessionId ||
        typeof session.workspaceId !== 'string' ||
        !/^[A-Za-z0-9_-]{1,128}$/.test(session.workspaceId)
      )
        return display();
      const persistentScopeDigest = hash({
        profileId: options.profileAccessKey,
        storeId: metadata.storeId,
        workspaceId: session?.workspaceId,
        profile: object(object(readSet.user).identity).rootIdentity,
        workspace:
          readSet.workspace === null
            ? null
            : object(object(readSet.workspace).identity).rootIdentity,
      });
      if (
        !session ||
        readSet.scopeDigest !== hash({ persistentScopeDigest, sessionId: context.sessionId })
      )
        return display();
      if (
        details.decision === 'cancel' &&
        !mutation &&
        execution.status === 'cancelled' &&
        result.outcome === 'cancelled' &&
        details.effectAttempted === false &&
        closed(result, ['outcome', 'content', 'details']) &&
        typeof result.content === 'string' &&
        closed(details, ['effectAttempted', 'decision', 'proof'])
      ) {
        payload.phase = 'cancelled';
        payload.decision = 'cancel';
        payload.proof = proof;
        payload.reason = null;
        return display();
      }
      if (
        !mutation ||
        execution.status !== 'succeeded' ||
        result.outcome !== 'succeeded' ||
        (details.decision !== 'approved' && details.decision !== 'rejected')
      )
        return display();
      payload.reason = 'saved_mutation_unverifiable';
      const binding = {
        scopeDigest: persistentScopeDigest,
        sourceDigest: hash(server.source),
        serverId: server.id,
        rawEntryDigest: server.rawEntryDigest,
        transportDigest: server.transportDigest,
      };
      const recordKey = hash(binding),
        value = { ...binding, kind: 'mcp_source_approval', decision: details.decision, proof };
      if (
        !session ||
        readSet.scopeDigest !== hash({ persistentScopeDigest, sessionId: context.sessionId }) ||
        !closed(result, ['outcome', 'content', 'details']) ||
        typeof result.content !== 'string' ||
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
        details.recordKey !== recordKey ||
        mutation.kind !== 'config.user.write' ||
        mutation.scope !== 'user' ||
        mutation.state !== 'applied' ||
        mutation.requestDigest !==
          hash({ executionId: execution.id, inputDigest: hash(execution.input), value }) ||
        !equal(mutation.safeRequest, {
          scope: 'user',
          ifMatch: readSet.approvalEtag,
          operationCount: 1,
        }) ||
        mutationReceipt.status !== 'applied' ||
        !closed(mutationReceipt, ['status', 'etag']) ||
        !hex(mutationReceipt.etag) ||
        !equal(details.mutation, mutation)
      )
        return display();
      payload.phase = 'saved';
      payload.decision = details.decision!;
      payload.proof = proof;
      payload.recordKey = recordKey;
      payload.reason = null;
      return display();
    },
  };
}
