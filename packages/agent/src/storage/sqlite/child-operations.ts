import { createHash, randomUUID } from 'node:crypto';
import { canonicalJson } from '../../json';
import type { EnsureAgentFollowUpInput, EnsureOperationInput, Store } from '../port';
import {
  AgentError,
  type ChildRunActivation,
  type Json,
  type OperationRef,
  type RequirementRef,
} from '../types';
import { assertNoExecutionGroupFence } from './execution-group-safety';
import { record as extensionRecord, verifyNamespace } from './extension-operations';
import { applyInputWork } from './input-operations';
import { sealAfterTurn } from './job-report-operations';
import type { SqliteOperations } from './operations';
import { prepareResultRequirement, sealResultRequirement } from './result-requirements';

const digest = (value: Json) => createHash('sha256').update(canonicalJson(value)).digest('hex');
/** Rechecked inside the carrier and activation transactions, from trusted captured metadata. */
function assertConfigurationReads(
  db: SqliteOperations,
  configuration: import('../types').ChildConfiguration,
  parent: Record<string, string | number | bigint | null>,
  storeId: string,
): void {
  const reads = configuration.recordReads;
  if (reads === undefined) return;
  if (
    !Array.isArray(reads) ||
    reads.length > 64 ||
    Buffer.byteLength(canonicalJson(reads as unknown as Json)) > 32 * 1024
  )
    throw new AgentError('child_configuration_read_limit');
  // An empty trusted observation set confers no namespace read authority.
  if (reads.length === 0) return;
  let ancestor = parent;
  const visited = new Set<string>();
  for (let depth = 0; ancestor.run_id === null && depth < 32; depth++) {
    if (!ancestor.parent_execution_id || visited.has(String(ancestor.id)))
      throw new AgentError('child_configuration_read_scope_denied');
    visited.add(String(ancestor.id));
    const next = db.row('SELECT * FROM execution WHERE id=?', ancestor.parent_execution_id);
    if (
      !next ||
      next.session_id !== parent.session_id ||
      next.origin_store_id !== storeId ||
      next.root_work_command_id !== parent.root_work_command_id ||
      String(next.root_work_seq) !== String(parent.root_work_seq)
    )
      throw new AgentError('child_configuration_read_scope_denied');
    ancestor = next;
  }
  const run =
    ancestor.run_id &&
    db.row('SELECT * FROM run WHERE id=? AND session_id=?', ancestor.run_id, parent.session_id!);
  const sealed = run
    ? (JSON.parse(String(run.config_json)) as { extensions?: { id: string }[] })
    : null;
  const keys = new Set<string>();
  for (const read of reads) {
    if (
      !read ||
      Object.keys(read).some(
        (key) => !['extensionId', 'key', 'revision', 'originStoreId', 'digest'].includes(key),
      ) ||
      !run ||
      run.origin_store_id !== storeId ||
      typeof read.extensionId !== 'string' ||
      !sealed?.extensions?.some((item) => item.id === read.extensionId) ||
      typeof read.key !== 'string' ||
      !read.key ||
      read.key.length > 256 ||
      typeof read.digest !== 'string' ||
      !/^[a-f0-9]{64}$/.test(read.digest) ||
      (read.revision === null
        ? read.originStoreId !== null
        : typeof read.revision !== 'string' ||
          !/^[1-9][0-9]*$/.test(read.revision) ||
          read.originStoreId !== storeId)
    )
      throw new AgentError('child_configuration_read_scope_denied');
    const key = JSON.stringify([read.extensionId, read.key]);
    if (keys.has(key)) throw new AgentError('child_configuration_read_scope_denied');
    keys.add(key);
    const row = db.row(
      "SELECT * FROM extension_record WHERE extension_id=? AND scope_kind='session' AND scope_id=? AND key=?",
      read.extensionId,
      parent.session_id!,
      read.key,
    );
    const current = row ? extensionRecord(row) : null;
    if (
      (current && (current.originStoreId !== storeId || current.forkProvenance)) ||
      (current?.revision ?? null) !== read.revision ||
      digest(current as unknown as Json) !== read.digest
    )
      throw new AgentError('context_refresh_required');
  }
}
export function ensureAgent(
  db: SqliteOperations,
  input: EnsureOperationInput,
  authorizationReview = false,
  continuation?: EnsureAgentFollowUpInput,
): OperationRef {
  prepareResultRequirement(input);
  const work = (): OperationRef => {
    db.identity(input.expectedStoreId);
    db.owner(input.owner, input.sessionId);
    assertNoExecutionGroupFence(db, input.sessionId);
    if (
      input.request.kind !== 'agent' ||
      !input.childConfiguration ||
      input.childConfiguration.id !== input.request.configurationId ||
      !/^[A-Za-z0-9_.-]{1,128}$/.test(input.childConfiguration.id) ||
      !input.childConfiguration.version ||
      input.childConfiguration.version.length > 128 ||
      !input.operationKey ||
      input.operationKey.length > 256 ||
      !['attached', 'detached'].includes(input.cancellation ?? 'attached')
    )
      throw new AgentError('invalid_child_configuration');
    const configuration = input.childConfiguration;
    const origin = db.active(input.owner, input.originCommandId);
    if (origin.session_id !== input.sessionId) throw new AgentError('invalid_extension_scope');
    const parent = db.row(
      'SELECT * FROM execution WHERE id=? AND session_id=?',
      input.parentExecutionId,
      input.sessionId,
    );
    if (
      !parent ||
      parent.origin_command_id !== input.originCommandId ||
      !['tool', 'job'].includes(String(parent.kind)) ||
      String(parent.owner_generation) !== input.owner.generation
    )
      throw new AgentError('invalid_operation_parent');
    if (!authorizationReview)
      verifyNamespace(db, input.extensionId, origin, input.parentExecutionId);
    let reusedChild: Record<string, string | number | bigint | null> | null = null;
    let previousCarrier: Record<string, string | number | bigint | null> | null = null;
    if (continuation) {
      if (
        authorizationReview ||
        parent.kind !== 'tool' ||
        continuation.previous.extensionId !== input.extensionId ||
        continuation.previous.sessionId !== input.sessionId ||
        continuation.previous.originStoreId !== input.expectedStoreId
      )
        throw new AgentError('permission_denied');
      const previous = db.row(
        'SELECT * FROM command WHERE id=? AND session_id=? AND extension_id=? AND operation_key=?',
        continuation.previous.commandId,
        input.sessionId,
        input.extensionId,
        continuation.previous.key,
      );
      previousCarrier = continuation.previous.executionId
        ? db.row(
            'SELECT * FROM execution WHERE id=? AND origin_command_id=?',
            continuation.previous.executionId,
            continuation.previous.commandId,
          )
        : null;
      if (
        !previous ||
        !previousCarrier?.child_session_id ||
        previous.subject_id !== origin.subject_id ||
        previousCarrier.origin_store_id !== input.expectedStoreId ||
        (continuation.previous.childSessionId !== undefined &&
          continuation.previous.childSessionId !== previousCarrier.child_session_id)
      )
        throw new AgentError('operation_unverifiable');
      const oldConfiguration = JSON.parse(String(previousCarrier.child_configuration_json)) as {
        id: string;
      };
      if (oldConfiguration.id !== configuration.id)
        throw new AgentError('child_configuration_conflict');
      reusedChild = db.row(
        'SELECT * FROM session WHERE id=? AND parent_id=? AND root_id=? AND delete_requested=0',
        previousCarrier.child_session_id!,
        input.sessionId,
        input.owner.sessionId,
      );
      const predecessor = db.row(
        'SELECT * FROM run WHERE id=? AND session_id=? AND origin_command_id=?',
        continuation.afterRunId,
        previousCarrier.child_session_id!,
        `child-start-${previousCarrier.id}`,
      );
      if (
        !reusedChild ||
        !predecessor ||
        predecessor.origin_store_id !== input.expectedStoreId ||
        reusedChild.context_selection_id !== continuation.contextSelectionId
      )
        throw new AgentError('input_target_changed');
      if (
        previousCarrier.state === 'outcome_unknown' ||
        predecessor.status === 'interrupted' ||
        db.row(
          "SELECT id FROM execution WHERE session_id=? AND state='outcome_unknown' LIMIT 1",
          reusedChild.id!,
        )
      )
        throw new AgentError('operation_needs_review');
    }
    let originStoreId = String(origin.origin_store_id);
    if (input.planRecordKey) {
      const plan = db.row(
        "SELECT origin_store_id FROM extension_record WHERE fork_provenance_json IS NULL AND extension_id=? AND scope_kind='session' AND scope_id=? AND key=?",
        input.extensionId,
        input.sessionId,
        input.planRecordKey,
      );
      if (!plan || plan.origin_store_id === null) throw new AgentError('operation_unverifiable');
      originStoreId = String(plan.origin_store_id);
    }
    const afterTurn = authorizationReview
      ? null
      : sealAfterTurn(db, parent, input, configuration as unknown as Json);
    const request: Json = {
      afterTurn,
      kind: authorizationReview ? 'authorization.review' : 'operation.agent',
      definitionId: `agent/${configuration.id}`,
      definitionVersion: configuration.version,
      configurationId: configuration.id,
      childConfiguration: configuration as unknown as Json,
      input: input.request.input,
      parentExecutionId: input.parentExecutionId,
      extensionId: input.extensionId,
      operationKey: input.operationKey,
      cancellation: input.cancellation ?? 'attached',
      resultRequirement: (input.resultRequirement ?? null) as unknown as Json,
      resultRequirementSchema: input.resultRequirementSchema ?? null,
      ...(continuation
        ? {
            followUp: {
              previousCommandId: continuation.previous.commandId,
              previousExecutionId: String(previousCarrier!.id),
              childSessionId: String(reusedChild!.id),
              afterRunId: continuation.afterRunId,
              contextSelectionId: continuation.contextSelectionId,
            },
          }
        : {}),
    };
    const prior = db.row(
      "SELECT * FROM command WHERE origin_store_id=? AND extension_id=? AND scope_kind='session' AND scope_id=? AND operation_key=?",
      originStoreId,
      input.extensionId,
      input.sessionId,
      input.operationKey,
    );
    if (prior) {
      if (prior.request_digest !== digest(request) || prior.subject_id !== origin.subject_id)
        throw new AgentError('operation_conflict');
      const receipt = JSON.parse(String(prior.receipt_json)) as {
        executionId: string;
        childSessionId: string;
      };
      if (originStoreId !== input.expectedStoreId) {
        const execution = db.row('SELECT state FROM execution WHERE id=?', receipt.executionId);
        if (
          !execution ||
          !['succeeded', 'failed', 'cancelled', 'outcome_unknown'].includes(String(execution.state))
        )
          throw new AgentError('operation_unverifiable');
      }
      return {
        commandId: String(prior.id),
        sessionId: input.sessionId,
        originStoreId,
        extensionId: input.extensionId,
        key: input.operationKey,
        executionId: receipt.executionId,
        childSessionId: receipt.childSessionId,
      };
    }
    if (originStoreId !== input.expectedStoreId) throw new AgentError('operation_unverifiable');
    assertConfigurationReads(db, configuration, parent, input.expectedStoreId);
    db.ancestors(input.owner, input.parentExecutionId);
    if (
      !(authorizationReview
        ? parent.state === 'planned' && !parent.dispatched
        : ['dispatching', 'running'].includes(String(parent.state)))
    )
      throw new AgentError('invalid_operation_parent');
    if (
      !continuation &&
      Number(
        db.row('SELECT count(*) AS n FROM session WHERE root_id=?', input.owner.sessionId)!.n,
      ) >= 256
    )
      throw new AgentError('child_scope_too_large');
    const commandId = randomUUID(),
      executionId = randomUUID(),
      childSessionId = reusedChild ? String(reusedChild.id) : randomUUID(),
      createId = `child-create-${executionId}`,
      startId = `child-start-${executionId}`;
    const current = db.row('SELECT * FROM session WHERE id=?', input.sessionId)!;
    const refs = authorizationReview
      ? '[]'
      : parent.run_id === null
        ? parent.requirements_json
        : db.row(
            'SELECT requirements_json FROM run WHERE id=? AND session_id=?',
            parent.run_id!,
            input.sessionId,
          )?.requirements_json;
    db.allocateSessionSequence(input.sessionId);
    const seq = db.row('SELECT next_seq FROM session WHERE id=?', input.sessionId)!.next_seq;
    db.run(
      "INSERT INTO command(id,session_id,seq,kind,subject_id,request_digest,request_json,status,receipt_json,origin_store_id,root_work_command_id,root_work_seq,extension_id,scope_kind,scope_id,operation_key) VALUES(?,?,?,?,?,?,?,'applied',?,?,?,?,?,'session',?,?)",
      commandId,
      input.sessionId,
      seq,
      authorizationReview ? 'authorization.review' : 'operation.agent',
      origin.subject_id,
      digest(request),
      canonicalJson(request),
      canonicalJson({ commandId, executionId, childSessionId }),
      originStoreId,
      origin.root_work_command_id,
      origin.root_work_seq,
      input.extensionId,
      input.sessionId,
      input.operationKey,
    );
    if (!reusedChild) {
      db.run(
        'INSERT INTO session(id,workspace_id,parent_id,root_id,title,context_selection_id,next_seq) VALUES(?,?,?,?,?,?,2)',
        childSessionId,
        current.workspace_id,
        input.sessionId,
        input.owner.sessionId,
        `Child ${configuration.id}`,
        randomUUID(),
      );
    }
    const create: Json = {
      kind: 'session.create',
      parentSessionId: input.sessionId,
      originExecutionId: executionId,
    };
    const payload = input.request.input;
    if (
      continuation &&
      (!payload ||
        typeof payload !== 'object' ||
        Array.isArray(payload) ||
        typeof payload.content !== 'string' ||
        !payload.content.trim() ||
        Buffer.byteLength(payload.content) > 1024 * 1024)
    )
      throw new AgentError('invalid_input_request');
    const start: Json = continuation
      ? {
          kind: 'input.follow_up',
          afterRunId: continuation.afterRunId,
          contextSelectionId: continuation.contextSelectionId,
          content: (payload as Record<string, Json>).content!,
        }
      : {
          kind: 'child.start',
          parentExecutionId: executionId,
          configurationId: configuration.id,
          configurationVersion: configuration.version,
          input: payload,
        };
    if (reusedChild) db.allocateSessionSequence(childSessionId);
    const localStartSeq = reusedChild
      ? db.row('SELECT next_seq FROM session WHERE id=?', childSessionId)!.next_seq
      : 2;
    for (const [id, localSeq, body, status] of [
      ...(!reusedChild ? [[createId, 1, create, 'applied'] as const] : []),
      [startId, localStartSeq, start, 'accepted'] as const,
    ])
      db.run(
        'INSERT INTO command(id,session_id,seq,kind,subject_id,request_digest,request_json,status,receipt_json,origin_store_id,root_work_command_id,root_work_seq) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
        id,
        childSessionId,
        localSeq,
        (body as { [key: string]: Json }).kind as string,
        origin.subject_id,
        digest(body),
        canonicalJson(body),
        status,
        canonicalJson({ sessionId: childSessionId, executionId }),
        originStoreId,
        origin.root_work_command_id,
        origin.root_work_seq,
      );
    db.run(
      "INSERT INTO execution(id,session_id,run_id,kind,origin_command_id,origin_store_id,root_work_command_id,root_work_seq,parent_execution_id,cancel_with_parent,root_session_id,step_id,call_id,attempt,adapter_id,definition_version,child_session_id,child_configuration_json,state,intent_json,decision_source_json,owner_generation,delivery_target_session_id,context_selection_id,requirements_json) VALUES(?,?,NULL,'job',?,?,?,?,?,?,?,?,?,1,?,?,?,?,'planned',?,?,?,?,?,?)",
      executionId,
      input.sessionId,
      commandId,
      originStoreId,
      origin.root_work_command_id,
      origin.root_work_seq,
      input.parentExecutionId,
      input.cancellation === 'detached' ? 0 : 1,
      input.owner.sessionId,
      `operation-${commandId}`,
      commandId,
      `agent/${configuration.id}`,
      configuration.version,
      childSessionId,
      canonicalJson(configuration as unknown as Json),
      canonicalJson(input.request.input),
      parent.decision_source_json,
      input.owner.generation,
      input.sessionId,
      current.context_selection_id,
      refs ?? '[]',
    );
    if (afterTurn)
      db.run(
        'UPDATE execution SET after_turn_json=? WHERE id=?',
        canonicalJson(afterTurn),
        executionId,
      );
    if (continuation) {
      db.run(
        'UPDATE command SET after_run_id=?,input_context_selection_id=?,agent_source_execution_id=?,agent_carrier_execution_id=? WHERE id=?',
        continuation.afterRunId,
        continuation.contextSelectionId,
        input.parentExecutionId,
        executionId,
        startId,
      );
      db.run(
        'UPDATE execution SET predecessor_execution_id=? WHERE id=?',
        previousCarrier!.id,
        executionId,
      );
    }
    if (continuation) {
      // Freeze membership without enumerating all queued bodies or changing their intent.
      const upper = db.row(
        "SELECT COALESCE(MAX(rowid),0) AS seq FROM command WHERE kind='agent.message' AND mail_target_session_id=? AND subject_id=?",
        childSessionId,
        origin.subject_id!,
      )!.seq;
      db.run(
        'UPDATE command SET mail_adoption_upper_seq=?,mail_adoption_cursor=? WHERE id=?',
        upper!,
        BigInt(db.metadata().lastChangeCursor),
        startId,
      );
    }
    sealResultRequirement(db, input, executionId);
    db.event(input.sessionId, executionId, 'execution.planned');
    if (!continuation) db.event(childSessionId, childSessionId, 'session.created');
    db.event(childSessionId, startId, 'command.accepted');
    db.event(input.sessionId, commandId, 'operation.accepted');
    return {
      commandId,
      sessionId: input.sessionId,
      originStoreId,
      extensionId: input.extensionId,
      key: input.operationKey,
      executionId,
      childSessionId,
    };
  };
  return authorizationReview ? work() : db.tx(work);
}
export function activateChildRun(
  db: SqliteOperations,
  input: Parameters<Store['activateChildRun']>[0],
): ChildRunActivation {
  return db.tx(() => {
    db.identity(input.expectedStoreId);
    const job = db.row('SELECT * FROM execution WHERE id=?', input.executionId);
    if (
      job?.kind !== 'job' ||
      job.child_session_id === null ||
      job.child_configuration_json === null ||
      String(job.owner_generation) !== input.owner.generation
    )
      throw new AgentError('invalid_child_execution');
    db.owner(input.owner, String(job.session_id));
    assertNoExecutionGroupFence(db, String(job.session_id), String(job.id));
    db.active(input.owner, String(job.origin_command_id));
    db.ancestors(input.owner, input.executionId);
    if (job.origin_store_id !== input.expectedStoreId)
      throw new AgentError('operation_unverifiable');
    if (job.dispatched !== 1n || !['dispatching', 'running'].includes(String(job.state)))
      throw new AgentError('child_not_dispatchable');
    const configuration = JSON.parse(
      String(job.child_configuration_json),
    ) as import('../types').ChildConfiguration;
    const parent =
      job.parent_execution_id &&
      db.row('SELECT * FROM execution WHERE id=?', job.parent_execution_id);
    if (!parent) throw new AgentError('invalid_operation_parent');
    assertConfigurationReads(db, configuration, parent, input.expectedStoreId);
    if (canonicalJson(configuration.snapshot) !== canonicalJson(input.configuration))
      throw new AgentError('child_configuration_conflict');
    if (
      !input.freshness.checked ||
      canonicalJson(input.freshness.source) !== job.decision_source_json
    )
      throw new AgentError('context_refresh_required');
    const child = db.owner(input.owner, String(job.child_session_id));
    const command = db.row(
      'SELECT * FROM command WHERE session_id=? AND id=?',
      job.child_session_id!,
      `child-start-${job.id}`,
    )!;
    db.active(input.owner, String(command.id));
    const inherited = JSON.parse(String(job.requirements_json)) as RequirementRef[];
    const refs = [...inherited];
    for (const ref of input.requirements ?? [])
      if (
        !refs.some(
          (old) => canonicalJson(old as unknown as Json) === canonicalJson(ref as unknown as Json),
        )
      )
        refs.push(ref);
    db.requirements(refs, input.requirementEvaluations, 'dispatch');
    if (command.kind === 'input.follow_up') {
      const previous =
        job.predecessor_execution_id !== null &&
        db.row(
          'SELECT * FROM execution WHERE id=? AND child_session_id=?',
          job.predecessor_execution_id!,
          child.id!,
        );
      if (
        !previous ||
        !['succeeded', 'failed', 'cancelled'].includes(String(previous.state)) ||
        db.row(
          "SELECT id FROM execution WHERE session_id=? AND state='outcome_unknown' LIMIT 1",
          child.id!,
        )
      )
        throw new AgentError('operation_needs_review');
      const applied = applyInputWork(db, {
        expectedStoreId: input.expectedStoreId,
        owner: input.owner,
        commandId: String(command.id),
        kind: 'follow_up',
        configuration: input.configuration,
        requirements: refs,
      });
      return { command: applied.command, session: db.session(child), run: applied.run };
    }
    const existing = db.row('SELECT * FROM run WHERE origin_command_id=?', command.id!);
    if (existing) {
      if (
        existing.config_json !== canonicalJson(input.configuration) ||
        existing.requirements_json !== canonicalJson(refs as unknown as Json)
      )
        throw new AgentError('child_configuration_conflict');
      return {
        command: db.command(command),
        session: db.session(child),
        run: db.runRecord(existing),
      };
    }
    if (
      command.status !== 'accepted' ||
      db.row('SELECT id FROM run WHERE session_id=? AND is_active=1', job.child_session_id!)
    )
      throw new AgentError('session_busy');
    const runId = randomUUID();
    const activatedAt = Date.now();
    if (!Number.isSafeInteger(activatedAt + 30 * 60 * 1000)) throw new AgentError('invalid_clock');
    db.run(
      "INSERT INTO run(id,session_id,origin_command_id,origin_store_id,root_work_command_id,root_work_seq,status,is_active,config_json,requirements_json,started_at,deadline_at,context_selection_id) VALUES(?,?,?,?,?,?,'running',1,?,?,?,?,?)",
      runId,
      job.child_session_id,
      command.id,
      job.origin_store_id,
      job.root_work_command_id,
      job.root_work_seq,
      canonicalJson(input.configuration),
      canonicalJson(refs as unknown as Json),
      activatedAt,
      activatedAt + 30 * 60 * 1000,
      db.row('SELECT context_selection_id FROM session WHERE id=?', job.child_session_id!)!
        .context_selection_id,
    );
    db.run(
      "UPDATE command SET status='applied',receipt_json=? WHERE id=?",
      canonicalJson({
        runId,
        executionId: input.executionId,
        childSessionId: String(job.child_session_id),
      }),
      command.id,
    );
    const start = JSON.parse(String(command.request_json)) as { input: Json };
    db.appendMessage(
      String(job.child_session_id),
      runId,
      {
        content: typeof start.input === 'string' ? start.input : canonicalJson(start.input),
        sourceIds: [String(command.id), input.executionId],
      },
      'user',
    );
    db.event(String(job.child_session_id), runId, 'run.started');
    return {
      command: db.command(db.row('SELECT * FROM command WHERE id=?', command.id!)!),
      session: db.session(db.row('SELECT * FROM session WHERE id=?', child.id!)!),
      run: db.runRecord(db.row('SELECT * FROM run WHERE id=?', runId)!),
    };
  });
}
