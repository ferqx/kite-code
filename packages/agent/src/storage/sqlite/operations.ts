import type { Database, Statement } from 'bun:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { canonicalJson } from '../../json';
import { bodyReference } from '../../model-body';
import type {
  AcceptCommandInput,
  CancelCommandInput,
  DispatchInput,
  FinishExecutionInput,
  OwnedWrite,
  PlanExecutionInput,
  Store,
} from '../port';
import {
  AgentError,
  type CommandRecord,
  type ExecutionRecord,
  type Json,
  type MessageRecord,
  type OwnerRef,
  type RequirementEvaluation,
  type RequirementRef,
  type RunRecord,
  type SessionRecord,
} from '../types';
import { acceptAgentInput, interruptAgent } from './agent-input-operations';
import {
  getAgentMessage,
  listAgentMessages,
  queueAgentMessage,
  readAgentMessageTarget,
  receiveAgentMessages,
  settleAgentMessages,
} from './agent-mail-operations';
import { callArtifact } from './artifact-operations';
import {
  ensureAuthorizationReview,
  executionAuthorizationObservation,
  getAuthorizationReview,
  verifyAuthorizationReviewDispatch,
} from './authorization-review';
import { readBackgroundExecutions } from './background-directory';
import { cancel } from './cancel-operations';
import { activateChildRun, ensureAgent } from './child-operations';
import { getAgentSummary, listAgentSummaries } from './child-query-operations';
import {
  beginCompression,
  commitCompression,
  getCompressionOrigin,
  resetCompression,
  verifyCompressionModel,
} from './compression-operations';
import { callContextSelection } from './context-selection-operations';
import { readDirectory } from './directory';
import { assertDispatchReadSet } from './dispatch-read-set';
import {
  assertNoExecutionGroupFence,
  readExecutionGroupSafetySnapshot,
} from './execution-group-safety';
import { callExtension } from './extension-operations';
import { readForkNamespacePage } from './fork-namespaces';
import { forkSession, getMessageOrigin } from './fork-operations';
import {
  prepareForkReadonlySources,
  readForkSourceMessage,
  readForkSourceProjection,
} from './fork-readonly-sources';
import { readForkRecordSources } from './fork-record-sources';
import { verifyHostControlDispatch } from './host-control-dispatch';
import { callHostMutation } from './host-mutation-operations';
import {
  applyInput,
  assertInputBoundary,
  listPendingInputs,
  validateInputAdmission,
} from './input-operations';
import { callInteraction, verifyInteractionDispatch } from './interaction-operations';
import { callJob, finishJobDelivery } from './job-operations';
import { callJobReconciliation } from './job-reconcile-operations';
import {
  applyJobReport,
  childReportCarrier,
  listPendingJobReports,
  registerJobReport,
  verifyJobReportRecovery,
} from './job-report-operations';
import { verifyModelBody } from './model-body';
import { getModelInputSnapshot, listModelInputs } from './model-input-operations';
import { getModelOutputSnapshot, modelOutputOf, verifyModelOutput } from './model-output';
import {
  assertMutationIntent,
  commitMutationCheck,
  listMutationFacts,
  registerMutationIntent,
  settleMutation,
} from './mutation-operations';
import { callPermissionGrant, verifyPermissionGrantDispatch } from './permission-grants';
import { recoverSession } from './recovery-operations';
import { initializeRunRecord } from './requirement-initialization';
import { registerRunRequirements } from './requirement-operations';
import { assertRequirementReadSet } from './requirement-read-set';
import { readRunExecutionSafetySnapshot } from './run-execution-safety';
import { callRunResume } from './run-resume-operations';
import { storageMeta } from './schema';
import { callSessionExport } from './session-export';
import { getSessionLogs, sessionLogEnvelope, unwrapChangePayload } from './session-logs';
import { manageSession } from './session-management-operations';
import {
  readWorkspaceRemoval,
  removeWorkspace,
  sessionHistoryCollectedAt,
  workspaceRemoval,
} from './workspace-removal';

type Input = { modelOutput?: import('../../model-output').ModelOutputReference } & OwnedWrite &
  AcceptCommandInput &
  PlanExecutionInput &
  Omit<DispatchInput, 'requirements'> &
  Omit<FinishExecutionInput, 'status'> &
  CancelCommandInput & {
    id: string;
    rootUri: string;
    name: string;
    workspaceId: string;
    title: string;
    reason: string;
    needsReview?: boolean;
    configuration: Json;
    requirements: RequirementRef[] & RequirementEvaluation[];
    runId: string | null;
    after: string;
    limit?: number;
    afterId?: string;
    sessionIds?: string[];
    content: string;
    status: ExecutionRecord['status'] | RunRecord['status'];
  };
type Row = Record<string, string | number | bigint | null>;
export class SqliteOperations {
  readonly db: Database;
  readonly readonly: boolean;
  private readonly statements = new Set<Statement>();
  constructor(db: Database, readOnly: boolean) {
    this.db = this.timedDatabase(db);
    this.readonly = readOnly;
  }
  private sqlDurationMs = 0;
  private commitMs: number | undefined;
  resetTiming(): void {
    this.sqlDurationMs = 0;
    this.commitMs = undefined;
  }
  getTiming(): { sqlDurationMs: number; commitMs?: number } {
    return {
      sqlDurationMs: this.sqlDurationMs,
      ...(this.commitMs === undefined ? {} : { commitMs: this.commitMs }),
    };
  }
  /** Worker operations return materialized values; no native statement crosses an ACK. */
  releaseStatements(): void {
    for (const statement of this.statements) {
      statement.finalize();
      this.statements.delete(statement);
    }
  }
  private timedDatabase(database: Database): Database {
    const measure = <T>(sql: string, work: () => T): T => {
      const began = performance.now();
      try {
        return work();
      } finally {
        const elapsed = performance.now() - began;
        if (/^COMMIT\b/i.test(sql)) this.commitMs = (this.commitMs ?? 0) + elapsed;
        else this.sqlDurationMs += elapsed;
      }
    };
    return new Proxy(database, {
      get: (target, key) => {
        const value = Reflect.get(target, key, target) as unknown;
        if (typeof value !== 'function') return value;
        if (key === 'run' || key === 'exec')
          return (...args: unknown[]) =>
            measure(String(args[0]), () => Reflect.apply(value, target, args));
        if (key === 'query' || key === 'prepare')
          return (...args: unknown[]) => {
            const statement = measure(String(args[0]), () =>
              Reflect.apply(value, target, args),
            ) as Statement;
            this.statements.add(statement);
            return new Proxy(statement, {
              get: (stmt, property) => {
                const operation = Reflect.get(stmt, property, stmt) as unknown;
                if (typeof operation !== 'function') return operation;
                if (['get', 'all', 'values', 'run'].includes(String(property)))
                  return (...values: unknown[]) =>
                    measure(String(args[0]), () => Reflect.apply(operation, stmt, values));
                if (property === 'iterate')
                  return (...values: unknown[]) => {
                    const iterator = Reflect.apply(
                      operation,
                      stmt,
                      values,
                    ) as IterableIterator<unknown>;
                    const timed: IterableIterator<unknown> = {
                      next: (value?: unknown) =>
                        measure(String(args[0]), () => iterator.next(value)),
                      return: (value?: unknown) =>
                        measure(String(args[0]), () =>
                          iterator.return ? iterator.return(value) : { done: true, value },
                        ),
                      [Symbol.iterator]: () => timed,
                    };
                    return timed;
                  };
                return operation.bind(stmt);
              },
            });
          };
        return value.bind(target);
      },
    });
  }
  row(sql: string, ...args: (string | number | bigint | null)[]): Row | null {
    const query = this.db.query<Row, (string | number | bigint | null)[]>(sql);
    (query as typeof query & { safeIntegers(value: boolean): typeof query }).safeIntegers(true);
    return query.get(...args);
  }
  rows(sql: string, ...args: (string | number | bigint | null)[]): Row[] {
    const query = this.db.query<Row, (string | number | bigint | null)[]>(sql);
    (query as typeof query & { safeIntegers(value: boolean): typeof query }).safeIntegers(true);
    return query.all(...args);
  }
  run(sql: string, ...args: (string | number | bigint | null | undefined)[]): void {
    this.db.run(
      sql,
      args.map((value) => value ?? null),
    );
  }
  tx<T>(work: () => T): T {
    if (this.readonly) throw new AgentError('read_only');
    this.db.run('BEGIN IMMEDIATE');
    try {
      const value = work();
      this.db.run('COMMIT');
      return value;
    } catch (error) {
      try {
        this.db.run('ROLLBACK');
      } catch {}
      throw error;
    }
  }
  identity(expected: string): string {
    const id = String(this.row('SELECT store_id FROM storage_meta WHERE singleton=1')!.store_id);
    if (id !== expected) throw new AgentError('store_identity_mismatch');
    return id;
  }
  owner(owner: OwnerRef, sessionId: string = owner.sessionId): Row {
    const root = this.row('SELECT * FROM session WHERE id=?', owner.sessionId);
    if (
      !root ||
      root.parent_id !== null ||
      root.root_id !== root.id ||
      root.owner_instance !== owner.instanceId ||
      String(root.owner_generation) !== owner.generation
    )
      throw new AgentError('owner_changed');
    const target =
      sessionId === owner.sessionId
        ? root
        : this.row('SELECT * FROM session WHERE id=? AND root_id=?', sessionId, owner.sessionId);
    if (!target) throw new AgentError('owner_changed');
    return target;
  }
  /** Carrier identity follows the exact Run/start command, never Session insertion order. */
  childCarrier(command: Row, runId?: string | null): Row | null {
    const session = this.row('SELECT * FROM session WHERE id=?', command.session_id!);
    if (!session || session.parent_id === null) return null;
    let start: Row | null = null;
    if (runId) {
      const run = this.row('SELECT * FROM run WHERE id=? AND session_id=?', runId, session.id!);
      start = run && this.row('SELECT * FROM command WHERE id=?', run.origin_command_id!);
    } else if (
      command.agent_carrier_execution_id !== null &&
      command.agent_carrier_execution_id !== undefined
    ) {
      return this.row(
        'SELECT * FROM execution WHERE id=? AND child_session_id=?',
        command.agent_carrier_execution_id,
        session.id!,
      );
    } else if (command.kind === 'child.start' || command.kind === 'job.report') start = command;
    else {
      const request = parse(command.request_json) as Record<string, Json>;
      let parentId =
        typeof request.parentExecutionId === 'string' ? request.parentExecutionId : null;
      const visited = new Set<string>();
      while (parentId) {
        if (visited.has(parentId) || visited.size >= 32)
          throw new AgentError('invalid_operation_parent');
        visited.add(parentId);
        const parent = this.row(
          'SELECT * FROM execution WHERE id=? AND session_id=?',
          parentId,
          session.id!,
        );
        if (!parent) throw new AgentError('invalid_operation_parent');
        if (parent.run_id !== null) {
          const run = this.row(
            'SELECT * FROM run WHERE id=? AND session_id=?',
            parent.run_id!,
            session.id!,
          );
          start = run && this.row('SELECT * FROM command WHERE id=?', run.origin_command_id!);
          break;
        }
        parentId = parent.parent_execution_id === null ? null : String(parent.parent_execution_id);
      }
      if (!start && !visited.size) {
        const run = this.row('SELECT * FROM run WHERE session_id=? AND is_active=1', session.id!);
        start = run && this.row('SELECT * FROM command WHERE id=?', run.origin_command_id!);
      }
    }
    if (!start) return null;
    if (start.kind === 'job.report') return childReportCarrier(this, start);
    if (start.agent_carrier_execution_id !== null && start.agent_carrier_execution_id !== undefined)
      return this.row(
        'SELECT * FROM execution WHERE id=? AND child_session_id=?',
        start.agent_carrier_execution_id,
        session.id!,
      );
    const body = parse(start.request_json) as Record<string, Json>;
    if (
      start.kind !== 'child.start' ||
      typeof body.parentExecutionId !== 'string' ||
      start.id !== `child-start-${body.parentExecutionId}`
    )
      throw new AgentError('operation_unverifiable');
    return this.row(
      'SELECT * FROM execution WHERE id=? AND child_session_id=?',
      body.parentExecutionId,
      session.id!,
    );
  }
  active(
    owner: OwnerRef,
    commandId: string,
    runId?: string | null,
    independentActivatedChild = false,
  ): Row {
    const command = this.row('SELECT * FROM command WHERE id=?', commandId);
    if (!command) throw new AgentError('cancelled_before_dispatch');
    const session = this.owner(owner, String(command.session_id));
    if (command.cancelled) throw new AgentError('cancelled_before_dispatch');
    if (session.parent_id !== null) {
      const carrier = this.childCarrier(command, runId);
      const deadline = carrier?.report_command_id
        ? { deadline_at: carrier.report_deadline_at }
        : carrier &&
          this.row(
            'SELECT deadline_at FROM run WHERE origin_command_id=? AND session_id=?',
            `child-start-${carrier.id}`,
            session.id!,
          );
      if (
        !independentActivatedChild &&
        deadline &&
        (deadline.deadline_at === null || BigInt(deadline.deadline_at!) <= BigInt(Date.now()))
      )
        throw new AgentError('child_deadline_exceeded');
      if (
        !carrier ||
        carrier.origin_store_id !== this.metadata().storeId ||
        String(carrier.owner_generation) !== owner.generation ||
        (!independentActivatedChild &&
          (carrier.cancel_requested ||
            (!carrier.report_command_id &&
              !['dispatching', 'running'].includes(String(carrier.state)))))
      )
        throw new AgentError('child_not_active');
    }
    if (command.origin_store_id !== this.metadata().storeId)
      throw new AgentError('operation_unverifiable');
    let current: Row | null = session;
    const visited = new Set<string>();
    while (current) {
      if (visited.has(String(current.id)) || visited.size >= 64)
        throw new AgentError('invalid_cancel_relation');
      visited.add(String(current.id));
      if (
        current.delete_requested ||
        BigInt(command.root_work_seq!) <= BigInt(current.stop_boundary!)
      )
        throw new AgentError('cancelled_before_dispatch');
      current =
        current.parent_id === null
          ? null
          : this.row(
              'SELECT * FROM session WHERE id=? AND root_id=?',
              current.parent_id!,
              owner.sessionId,
            );
    }
    if (runId) {
      const run = this.row(
        'SELECT * FROM run WHERE id=? AND session_id=?',
        runId,
        command.session_id!,
      );
      if (!run || run.origin_command_id !== commandId || !run.is_active || run.cancel_requested)
        throw new AgentError('run_not_active');
    }
    return command;
  }
  ancestors(owner: OwnerRef, id: string): void {
    const visited = new Set<string>();
    let current: string | null = id;
    while (current) {
      if (visited.has(current) || visited.size >= 64)
        throw new AgentError('invalid_cancel_relation');
      visited.add(current);
      const execution = this.row('SELECT * FROM execution WHERE id=?', current);
      if (!execution || String(execution.owner_generation) !== owner.generation)
        throw new AgentError('invalid_operation_parent');
      this.owner(owner, String(execution.session_id));
      if (execution.origin_store_id !== this.metadata().storeId)
        throw new AgentError('operation_unverifiable');
      const independentChild =
        execution.child_session_id !== null &&
        !execution.cancel_with_parent &&
        Boolean(execution.dispatched) &&
        Boolean(
          this.row(
            'SELECT id FROM run WHERE session_id=? AND origin_command_id=?',
            execution.child_session_id!,
            `child-start-${execution.id}`,
          ),
        );
      // An independently activated child has its own carrier and deadline. The
      // original parent remains provenance, not a liveness dependency after its
      // foreground Run/carrier settles. Group stop/delete and Store fencing stay.
      this.active(owner, String(execution.origin_command_id), undefined, independentChild);
      if (execution.cancel_requested) throw new AgentError('cancelled_before_dispatch');
      if (
        execution.run_id !== null &&
        this.row(
          'SELECT cancel_requested FROM run WHERE id=? AND session_id=?',
          execution.run_id!,
          execution.session_id!,
        )?.cancel_requested
      )
        throw new AgentError('run_not_active');
      current =
        execution.cancel_with_parent && execution.parent_execution_id !== null
          ? String(execution.parent_execution_id)
          : null;
    }
  }
  event(session: string | null, object: string, type: string, payload: Json = null): void {
    if (
      BigInt(
        this.row('SELECT last_change_cursor FROM storage_meta WHERE singleton=1')!
          .last_change_cursor!,
      ) >= 9223372036854775807n
    )
      throw new AgentError('sequence_exhausted');
    this.run('UPDATE storage_meta SET last_change_cursor=last_change_cursor+1 WHERE singleton=1');
    this.run(
      'INSERT INTO change_event SELECT last_change_cursor,?,?,0,?,? FROM storage_meta WHERE singleton=1',
      session,
      object,
      type,
      canonicalJson(sessionLogEnvelope(this, session, object, type, payload)),
    );
  }
  metadata() {
    const selected = drizzle(this.db)
      .select()
      .from(storageMeta)
      .where(eq(storageMeta.singleton, 1))
      .get()!;
    const row = this.row('SELECT * FROM storage_meta WHERE singleton=1')!;
    if (selected.storeId !== row.store_id) throw new AgentError('metadata_conflict');
    const engine = this.row('SELECT sqlite_version() AS version,sqlite_source_id() AS source')!;
    return {
      storeId: String(row.store_id),
      formatMajor: Number(row.format_major),
      replayFloor: String(row.replay_floor),
      lastChangeCursor: String(row.last_change_cursor),
      engine: { version: String(engine.version), sourceId: String(engine.source) },
    };
  }
  session(row: Row): SessionRecord {
    const authority =
      row.parent_id === null ? row : this.row('SELECT * FROM session WHERE id=?', row.root_id!)!;
    const historyPurgedAt = row.delete_requested
      ? sessionHistoryCollectedAt(
          this.row('SELECT metadata_json FROM workspace WHERE id=?', row.workspace_id!)!
            .metadata_json,
          String(row.root_id),
        )
      : null;
    return {
      id: String(row.id),
      workspaceId: String(row.workspace_id),
      parentSessionId: row.parent_id === null ? null : String(row.parent_id),
      rootSessionId: String(row.root_id),
      title: String(row.title),
      controlRevision: String(row.control_revision),
      contextSelectionId: String(row.context_selection_id),
      ownerInstanceId: authority.owner_instance === null ? null : String(authority.owner_instance),
      ownerGeneration: String(authority.owner_generation),
      nextSeq: String(row.next_seq),
      deletedAt: row.delete_requested
        ? row.deleted_at === null
          ? 0
          : Number(row.deleted_at)
        : null,
      ...(historyPurgedAt === null ? {} : { historyPurgedAt }),
    };
  }
  command(row: Row): CommandRecord {
    return {
      id: String(row.id),
      sessionId: String(row.session_id),
      seq: String(row.seq),
      originStoreId: String(row.origin_store_id),
      rootWorkCommandId: String(row.root_work_command_id),
      rootWorkSeq: String(row.root_work_seq),
      subjectId: String(row.subject_id),
      request: parse(row.request_json),
      requestDigest: String(row.request_digest),
      kind: String(row.kind),
      status: row.status as CommandRecord['status'],
      receipt: parse(row.receipt_json),
      cancelRequestedAt: row.cancel_requested_at === null ? null : Number(row.cancel_requested_at),
    };
  }
  runRecord(row: Row): RunRecord {
    return {
      contextSelectionId: String(row.context_selection_id),
      waitingForResults: parse(row.waiting_results_json) as string[],
      id: String(row.id),
      sessionId: String(row.session_id),
      originCommandId: String(row.origin_command_id),
      originStoreId: String(row.origin_store_id),
      rootWorkCommandId: String(row.root_work_command_id),
      rootWorkSeq: String(row.root_work_seq),
      status: row.status as RunRecord['status'],
      isActive: Boolean(row.is_active),
      configuration: parse(row.config_json),
      requirements: parse(row.requirements_json) as unknown as RequirementRef[],
      createdAt: Number(row.started_at),
      deadlineAt: row.deadline_at === null ? null : Number(row.deadline_at),
      finishedAt: row.finished_at === null ? null : Number(row.finished_at),
      reason: row.reason === null ? null : String(row.reason),
    };
  }
  execution(row: Row): ExecutionRecord {
    const accepted = this.row(
      "SELECT c.* FROM context_snapshot c JOIN session s ON s.id=c.session_id WHERE c.kind='result_ref' AND c.execution_id=? AND c.result_revision=? AND c.selection_id=s.context_selection_id AND COALESCE(json_extract(c.request_json,'$.diagnostic'),0)=0 AND COALESCE(json_extract(c.request_json,'$.pendingInput'),0)=0 ORDER BY c.seq LIMIT 1",
      row.id!,
      row.result_revision!,
    );
    const proof = accepted ? (parse(accepted.request_json) as Record<string, Json>) : null;
    const authorization = executionAuthorizationObservation(this, row);
    return {
      resultAcceptance: accepted
        ? {
            runId: typeof proof?.targetRunId === 'string' ? proof.targetRunId : null,
            selectionId: String(accepted.selection_id),
            sourceId: String(accepted.id),
            resultRevision: String(accepted.result_revision),
          }
        : null,
      interactionBinding: parse(
        row.interaction_binding_json,
      ) as ExecutionRecord['interactionBinding'],
      childSessionId: row.child_session_id === null ? null : String(row.child_session_id),
      afterTurn: parse(row.after_turn_json),
      childConfiguration:
        row.child_configuration_json === null
          ? null
          : (parse(
              row.child_configuration_json,
            ) as unknown as import('../types').ChildConfiguration),
      id: String(row.id),
      sessionId: String(row.session_id),
      runId: row.run_id === null ? null : String(row.run_id),
      originCommandId: String(row.origin_command_id),
      originStoreId: String(row.origin_store_id),
      rootWorkCommandId: String(row.root_work_command_id),
      rootWorkSeq: String(row.root_work_seq),
      parentExecutionId: row.parent_execution_id === null ? null : String(row.parent_execution_id),
      cancelWithParent: Boolean(row.cancel_with_parent),
      stepId: String(row.step_id),
      callId: String(row.call_id),
      attempt: Number(row.attempt),
      kind: row.kind as ExecutionRecord['kind'],
      definitionId: String(row.adapter_id),
      definitionVersion: String(row.definition_version),
      status: row.state as ExecutionRecord['status'],
      input: parse(row.intent_json),
      decisionSource: parse(row.decision_source_json),
      result: parse(row.result_json),
      ownerGeneration: String(row.owner_generation),
      cancelRequestedAt: row.cancel_requested_at === null ? null : Number(row.cancel_requested_at),
      resultRevision: String(row.result_revision),
      reference: parse(row.reference_json),
      ...(authorization ? { authorization } : {}),
      recoveryManifest: parse(row.recovery_manifest_json),
      requirements: parse(row.requirements_json) as unknown as RequirementRef[],
      delivery: row.delivery as ExecutionRecord['delivery'],
      deliveryReason: row.delivery_reason === null ? null : String(row.delivery_reason),
      deliveryTargetSessionId:
        row.delivery_target_session_id === null ? null : String(row.delivery_target_session_id),
      contextSelectionId:
        row.context_selection_id === null ? null : String(row.context_selection_id),
    };
  }
  message(row: Row): MessageRecord {
    const source = parse(row.source_json) as Record<string, Json>;
    return {
      id: String(row.id),
      sessionId: String(row.session_id),
      runId: row.run_id === null ? null : String(row.run_id),
      seq: String(row.seq),
      status: row.status as MessageRecord['status'],
      role: row.role as MessageRecord['role'],
      content: String(source.content ?? ''),
      ...(source.modelOutput
        ? { modelOutput: source.modelOutput as unknown as MessageRecord['modelOutput'] }
        : {}),
      ...(source.toolCalls
        ? { toolCalls: source.toolCalls as unknown as MessageRecord['toolCalls'] }
        : {}),
      ...(source.toolCallId ? { toolCallId: String(source.toolCallId) } : {}),
      ...(source.sourceIds ? { sourceIds: source.sourceIds as string[] } : {}),
      ...(source.contextSelectionId
        ? { contextSelectionId: String(source.contextSelectionId) }
        : {}),
      ...(source.originCommandId ? { originCommandId: String(source.originCommandId) } : {}),
      ...(source.inputKind ? { inputKind: source.inputKind as MessageRecord['inputKind'] } : {}),
    };
  }
  appendMessage(
    sessionId: string,
    runId: string | null,
    content: Json,
    role: string,
    status = 'complete',
    id: string = randomUUID(),
  ): string {
    this.allocateSessionSequence(sessionId);
    this.run(
      'INSERT INTO message(id,session_id,run_id,seq,role,status,source_json) SELECT ?,id,?,next_seq,?,?,? FROM session WHERE id=?',
      id,
      runId,
      role,
      status,
      canonicalJson(content),
      sessionId,
    );
    this.run('INSERT INTO message_part VALUES(?,0,?,1,0,?)', id, 'text', canonicalJson(content));
    this.event(sessionId, id, 'message.updated');
    return id;
  }
  requirements(
    refs: RequirementRef[],
    evaluations: RequirementEvaluation[],
    phase: 'dispatch' | 'completion',
    boundaryExecutionId?: string,
  ): void {
    for (const ref of refs.filter((r) => r.phase === phase || r.phase === 'both')) {
      const evaluation = evaluations.find(
        (e) =>
          canonicalJson(e.requirement as unknown as Json) === canonicalJson(ref as unknown as Json),
      );
      const record = this.row(
        'SELECT revision,origin_store_id FROM extension_record WHERE fork_provenance_json IS NULL AND extension_id=? AND scope_kind=? AND scope_id=? AND key=?',
        ref.extensionId,
        'session',
        ref.sessionId,
        ref.recordKey,
      );
      if (
        !evaluation ||
        !record ||
        String(record.revision) !== evaluation.recordRevision ||
        evaluation.recordRevision !== ref.revision ||
        !['satisfied', 'waived'].includes(evaluation.outcome) ||
        ref.originStoreId !== this.metadata().storeId ||
        record.origin_store_id !== ref.originStoreId
      )
        throw new AgentError('requirement_not_satisfied');
      assertRequirementReadSet(this, evaluation, phase, boundaryExecutionId);
    }
  }
  call(method: string, args: unknown[]): unknown {
    const input = args[0] as Input;
    switch (method) {
      case 'getModelOutputSnapshot':
        return getModelOutputSnapshot(
          this,
          args[0] as Parameters<Store['getModelOutputSnapshot']>[0],
        );
      case 'getModelInputSnapshot':
        return getModelInputSnapshot(
          this,
          args[0] as Parameters<Store['getModelInputSnapshot']>[0],
        );
      case 'readForkNamespacePage':
        return readForkNamespacePage(
          this,
          args[0] as Parameters<Store['readForkNamespacePage']>[0],
        );
      case 'readSessionExportText':
      case 'beginSessionExport':
      case 'readSessionExportPage':
      case 'verifySessionExport':
        return callSessionExport(
          this,
          method,
          args[0] as Parameters<Store['readSessionExportPage']>[0],
        );
      case 'listModelInputs':
        return listModelInputs(this, args[0] as Parameters<Store['listModelInputs']>[0]);
      case 'initializeRunRecord':
        return initializeRunRecord(this, args[0] as Parameters<Store['initializeRunRecord']>[0]);
      case 'verifyRunResume':
      case 'readRunResumeExecutionPage':
      case 'beginRunResume':
      case 'commitRunResume':
      case 'releaseRunResumeLease':
      case 'beginRunRequirementsInitialization':
        return callRunResume(this, method, args[0]);
      case 'registerRunRequirements':
        return registerRunRequirements(
          this,
          args[0] as Parameters<Store['registerRunRequirements']>[0],
        );
      case 'beginHostMutation':
      case 'finishHostMutation':
      case 'readHostControl':
      case 'getHostMutation':
        return callHostMutation(this, method, args);
      case 'ensureAuthorizationReview':
        return ensureAuthorizationReview(
          this,
          args[0] as Parameters<Store['ensureAuthorizationReview']>[0],
        );
      case 'getAuthorizationReview':
        return getAuthorizationReview(
          this,
          args[0] as Parameters<Store['getAuthorizationReview']>[0],
        );
      case 'activateChildRun':
        return activateChildRun(this, args[0] as Parameters<Store['activateChildRun']>[0]);
      case 'registerArtifact':
      case 'getArtifactReference':
        return callArtifact(this, method, args);
      case 'getExtensionRecord':
      case 'listExtensionRecords':
      case 'writeExtensionRecord':
      case 'ensureOperation':
      case 'getOperation':
      case 'planAction':
      case 'applyExtensionAction':
      case 'stopActionPreparation':
        return callExtension(this, method, args);
      case 'recoverSession':
        return recoverSession(this, args[0] as Parameters<Store['recoverSession']>[0]);
      case 'markRunning':
      case 'appendExecutionOutput':
      case 'listExecutionOutput':
        return callJob(this, method, args);
      case 'readRunExecutionSafety':
        return readRunExecutionSafetySnapshot(
          this,
          args[0] as Parameters<Store['readRunExecutionSafety']>[0],
        );
      case 'readExecutionGroupSafety':
        return readExecutionGroupSafetySnapshot(
          this,
          args[0] as Parameters<Store['readExecutionGroupSafety']>[0],
        );
      case 'getMetadata':
        return this.metadata();
      case 'getWorkspace': {
        const row = this.row('SELECT * FROM workspace WHERE id=?', String(args[0]));
        return !row || workspaceRemoval(row.metadata_json)
          ? null
          : { id: String(row.id), rootUri: String(row.root_uri), name: String(row.name) };
      }
      case 'removeWorkspace':
        return removeWorkspace(this, args[0] as Parameters<Store['removeWorkspace']>[0]);
      case 'getWorkspaceRemoval':
        return readWorkspaceRemoval(this, args[0] as Parameters<Store['getWorkspaceRemoval']>[0]);
      case 'listWorkspaceDirectory':
        return readDirectory(
          this,
          'workspace',
          args[0] as Parameters<Store['listWorkspaceDirectory']>[0],
        );
      case 'listBackgroundExecutions':
        return readBackgroundExecutions(
          this,
          args[0] as Parameters<Store['listBackgroundExecutions']>[0],
        );
      case 'listSessionDirectory':
        return readDirectory(
          this,
          'session',
          args[0] as Parameters<Store['listSessionDirectory']>[0],
        );
      case 'listWorkspaces':
        return this.rows(
          "SELECT id,root_uri,name FROM workspace WHERE id>? AND json_type(metadata_json,'$.removal') IS NULL ORDER BY id LIMIT ?",
          input?.afterId ?? '',
          limit(input?.limit),
        ).map((row) => ({
          id: String(row.id),
          rootUri: String(row.root_uri),
          name: String(row.name),
        }));
      case 'createWorkspace':
        return this.tx(() => {
          this.identity(input.expectedStoreId);
          const prior = this.row('SELECT * FROM workspace WHERE id=?', input.id);
          if (prior && workspaceRemoval(prior.metadata_json))
            throw new AgentError('workspace_removed');
          if (prior && (prior.root_uri !== input.rootUri || prior.name !== input.name))
            throw new AgentError('identity_conflict');
          if (!prior) {
            this.run(
              'INSERT INTO workspace(id,root_uri,name) VALUES(?,?,?)',
              input.id,
              input.rootUri,
              input.name,
            );
            this.event(null, input.id, 'workspace.created');
          }
          return { id: input.id, rootUri: input.rootUri, name: input.name };
        });
      case 'createSession':
        return this.tx(() => {
          this.identity(input.expectedStoreId);
          const request = {
            kind: 'session.create',
            workspaceId: input.workspaceId,
            title: input.title,
          };
          const digest = hash(request);
          const prior = this.row('SELECT * FROM command WHERE id=?', input.commandId);
          if (prior) {
            if (
              prior.request_digest !== digest ||
              prior.session_id !== input.sessionId ||
              prior.subject_id !== input.subjectId
            )
              throw new AgentError('command_conflict');
            return this.session(this.row('SELECT * FROM session WHERE id=?', input.sessionId)!);
          }
          const workspace = this.row(
            'SELECT metadata_json FROM workspace WHERE id=?',
            input.workspaceId,
          );
          if (!workspace) throw new AgentError('workspace_not_found');
          if (workspaceRemoval(workspace.metadata_json)) throw new AgentError('workspace_removed');
          this.run(
            'INSERT INTO session(id,workspace_id,root_id,title,context_selection_id) VALUES(?,?,?,?,?)',
            input.sessionId,
            input.workspaceId,
            input.sessionId,
            input.title,
            randomUUID(),
          );
          this.insertCommand(input, request, digest, 'applied', { sessionId: input.sessionId });
          this.event(input.sessionId, input.sessionId, 'session.created');
          return this.session(this.row('SELECT * FROM session WHERE id=?', input.sessionId)!);
        });
      case 'getSession': {
        const row = this.row('SELECT * FROM session WHERE id=?', String(args[0]));
        return row ? this.session(row) : null;
      }
      case 'listSessions':
        return this.rows(
          'SELECT * FROM session WHERE id>? AND delete_requested=0 AND parent_id IS NULL ORDER BY id LIMIT ?',
          input?.afterId ?? '',
          limit(input?.limit),
        ).map((row) => this.session(row));
      case 'ensureAgentFollowUp':
        return ensureAgent(
          this,
          args[0] as Parameters<Store['ensureAgentFollowUp']>[0],
          false,
          args[0] as Parameters<Store['ensureAgentFollowUp']>[0],
        );
      case 'getAgentSummary':
        return getAgentSummary(this, args[0] as Parameters<Store['getAgentSummary']>[0]);
      case 'listAgentSummaries':
        return listAgentSummaries(this, args[0] as Parameters<Store['listAgentSummaries']>[0]);
      case 'interruptAgent':
        return interruptAgent(this, args[0] as Parameters<Store['interruptAgent']>[0]);
      case 'acceptAgentInput':
        return acceptAgentInput(this, args[0] as Parameters<Store['acceptAgentInput']>[0]);
      case 'queueAgentMessage':
        return queueAgentMessage(this, args[0] as Parameters<Store['queueAgentMessage']>[0]);
      case 'readAgentMessageTarget':
        return readAgentMessageTarget(
          this,
          args[0] as Parameters<Store['readAgentMessageTarget']>[0],
        );
      case 'receiveAgentMessages':
        return receiveAgentMessages(this, args[0] as Parameters<Store['receiveAgentMessages']>[0]);
      case 'getAgentMessage':
        return getAgentMessage(this, args[0] as Parameters<Store['getAgentMessage']>[0]);
      case 'listAgentMessages':
        return listAgentMessages(this, args[0] as Parameters<Store['listAgentMessages']>[0]);
      case 'acceptCommand':
        return this.tx(() => {
          this.identity(input.expectedStoreId);
          const digest = hash(input.request as unknown as Json);
          const prior = this.row('SELECT * FROM command WHERE id=?', input.commandId);
          if (prior) {
            if (
              prior.request_digest !== digest ||
              prior.session_id !== input.sessionId ||
              prior.subject_id !== input.subjectId
            )
              throw new AgentError('command_conflict');
            return this.command(prior);
          }
          const session = this.row('SELECT * FROM session WHERE id=?', input.sessionId);
          if (!session || session.delete_requested) throw new AgentError('session_not_found');
          const inputBinding = validateInputAdmission(this, input);
          this.insertCommand(input, input.request as unknown as Json, digest, 'accepted', {
            commandId: input.commandId,
          });
          if (!inputBinding)
            this.run(
              'UPDATE command SET input_context_selection_id=? WHERE id=?',
              session.context_selection_id,
              input.commandId,
            );
          if (inputBinding)
            this.run(
              'UPDATE command SET input_target_run_id=?,input_context_selection_id=?,after_run_id=?,root_work_command_id=COALESCE(?,root_work_command_id),root_work_seq=COALESCE(?,root_work_seq) WHERE id=?',
              inputBinding.targetRunId,
              inputBinding.contextSelectionId,
              inputBinding.afterRunId,
              inputBinding.rootWorkCommandId,
              inputBinding.rootWorkSeq,
              input.commandId,
            );
          if (session.parent_id !== null) {
            const actual = this.childCarrier(
              this.row('SELECT * FROM command WHERE id=?', input.commandId)!,
            );
            const carrier =
              actual &&
              this.row(
                'SELECT e.*,c.subject_id FROM execution e JOIN command c ON c.id=e.origin_command_id WHERE e.id=?',
                actual.id!,
              );
            if (
              !carrier ||
              carrier.subject_id !== input.subjectId ||
              carrier.origin_store_id !== input.expectedStoreId ||
              carrier.cancel_requested ||
              !['dispatching', 'running'].includes(String(carrier.state))
            )
              throw new AgentError('child_not_active');
            this.run(
              'UPDATE command SET root_work_command_id=?,root_work_seq=? WHERE id=?',
              carrier.root_work_command_id,
              carrier.root_work_seq,
              input.commandId,
            );
          }
          this.event(input.sessionId, input.commandId, 'command.accepted');
          return this.command(this.row('SELECT * FROM command WHERE id=?', input.commandId)!);
        });
      case 'getCommand': {
        const row = this.row('SELECT * FROM command WHERE id=?', String(args[0]));
        return row ? this.command(row) : null;
      }
      case 'listAcceptedCommands':
        return this.rows(
          "SELECT * FROM command WHERE session_id=? AND status='accepted' AND kind NOT IN('job.reconcile','run.resume') ORDER BY seq LIMIT ?",
          String(args[0]),
          limit(args[1]),
        ).map((row) => this.command(row));
      case 'rejectCommand':
        return this.tx(() => {
          this.identity(input.expectedStoreId);
          const command = this.row('SELECT * FROM command WHERE id=?', input.commandId);
          if (!command) throw new AgentError('command_not_found');
          this.owner(input.owner, String(command.session_id));
          this.run(
            "UPDATE command SET status=?,receipt_json=? WHERE id=? AND session_id=? AND status='accepted'",
            input.needsReview ? 'needs_review' : 'rejected',
            canonicalJson({ reason: input.reason }),
            input.commandId,
            String(command.session_id),
          );
          this.event(
            String(command.session_id),
            input.commandId,
            input.needsReview ? 'command.needs_review' : 'command.rejected',
          );
          return this.command(this.row('SELECT * FROM command WHERE id=?', input.commandId)!);
        });
      case 'startRun':
        return this.tx(() => {
          this.identity(input.expectedStoreId);
          const command = this.active(input.owner, input.commandId);
          if (command.status === 'applied') {
            const row = this.row('SELECT * FROM run WHERE origin_command_id=?', input.commandId);
            if (!row) throw new AgentError('command_already_applied');
            return this.runRecord(row);
          }
          assertNoExecutionGroupFence(this, String(command.session_id));
          if (
            command.input_context_selection_id !== null &&
            command.input_context_selection_id !==
              this.row(
                'SELECT context_selection_id FROM session WHERE id=?',
                String(command.session_id),
              )?.context_selection_id
          )
            throw new AgentError('context_rewound');
          if (
            !['run.start', 'context.compress', 'context.compression.reset'].includes(
              String(command.kind),
            )
          )
            throw new AgentError('command_not_startable');
          if (command.status !== 'accepted') throw new AgentError('command_not_accepted');
          if (
            this.row(
              'SELECT id FROM run WHERE session_id=? AND is_active=1',
              String(command.session_id),
            )
          )
            throw new AgentError('session_busy');
          if (
            this.row(
              "SELECT id FROM command WHERE session_id=? AND kind='input.follow_up' AND status='accepted' AND cancelled=0 AND seq<? LIMIT 1",
              String(command.session_id),
              command.seq!,
            )
          )
            throw new AgentError('input_order_conflict');
          const id = randomUUID();
          this.run(
            'INSERT INTO run(id,session_id,origin_command_id,origin_store_id,root_work_command_id,root_work_seq,status,is_active,config_json,requirements_json,started_at,context_selection_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
            id,
            String(command.session_id),
            input.commandId,
            command.origin_store_id,
            command.root_work_command_id,
            command.root_work_seq,
            'running',
            1,
            canonicalJson(input.configuration),
            canonicalJson((input.requirements ?? []) as unknown as Json),
            Date.now(),
            this.row('SELECT context_selection_id FROM session WHERE id=?', command.session_id!)!
              .context_selection_id,
          );
          this.run(
            "UPDATE command SET status='applied',receipt_json=? WHERE id=?",
            canonicalJson({ runId: id }),
            input.commandId,
          );
          const request = parse(command.request_json) as Record<string, Json>;
          if (!['context.compress', 'context.compression.reset'].includes(String(command.kind)))
            this.appendMessage(
              String(command.session_id),
              id,
              { content: request.content ?? '', sourceIds: [input.commandId] },
              'user',
            );
          this.event(String(command.session_id), id, 'run.started');
          return this.runRecord(this.row('SELECT * FROM run WHERE id=?', id)!);
        });
      case 'getRun': {
        const row = this.row('SELECT * FROM run WHERE id=?', String(args[0]));
        return row ? this.runRecord(row) : null;
      }
      case 'planExecution':
        return this.tx(() => {
          this.identity(input.expectedStoreId);
          const command = this.active(input.owner, input.originCommandId, input.runId);
          assertNoExecutionGroupFence(this, String(command.session_id));
          if (input.sessionId !== command.session_id)
            throw new AgentError('execution_scope_mismatch');
          if (input.runId === null) {
            if (
              !['tool', 'job'].includes(input.kind) ||
              ![
                `operation.${input.kind}`,
                ...(input.kind === 'job' ? ['operation.agent', 'authorization.review'] : []),
              ].includes(String(command.kind)) ||
              !input.parentExecutionId
            )
              throw new AgentError('invalid_runless_execution');
            this.ancestors(
              input.owner,
              input.kind === 'job' ? input.executionId : input.parentExecutionId,
            );
            const request = parse(command.request_json) as Record<string, Json>;
            if (
              request.parentExecutionId !== input.parentExecutionId ||
              request.definitionId !== input.definitionId ||
              request.definitionVersion !== input.definitionVersion ||
              (request.cancellation === 'detached') !== (input.cancelWithParent === false) ||
              canonicalJson(request.input!) !== canonicalJson(input.input) ||
              canonicalJson(input.decisionSource) !==
                this.row(
                  'SELECT decision_source_json FROM execution WHERE id=?',
                  input.parentExecutionId,
                )?.decision_source_json
            )
              throw new AgentError('operation_conflict');
          } else if (input.kind === 'job') throw new AgentError('unsupported_job_plan');
          const childJob = input.runId === null ? null : this.childCarrier(command, input.runId);
          const parentId = input.parentExecutionId ?? (childJob ? String(childJob.id) : null);
          if (
            childJob &&
            input.parentExecutionId !== undefined &&
            input.parentExecutionId !== childJob.id
          )
            throw new AgentError('execution_scope_mismatch');
          if (parentId) {
            const parent = this.row('SELECT session_id FROM execution WHERE id=?', parentId);
            if (!parent) throw new AgentError('invalid_operation_parent');
            this.owner(input.owner, String(parent.session_id));
          }
          if (input.kind === 'model')
            verifyModelBody(this, input.input, {
              origin_command_id: input.originCommandId,
              origin_store_id: input.expectedStoreId,
              session_id: input.sessionId,
            });
          if (input.modelMetadata !== undefined) {
            if (input.kind !== 'model') throw new AgentError('model_snapshot_scope_denied');
            verifyModelBody(this, input.modelMetadata, {
              origin_command_id: input.originCommandId,
              origin_store_id: input.expectedStoreId,
              session_id: input.sessionId,
            });
          }
          verifyModelBody(this, input.decisionSource, {
            origin_command_id: input.originCommandId,
            origin_store_id: input.expectedStoreId,
            session_id: input.sessionId,
          });
          const prior = this.row('SELECT * FROM execution WHERE id=?', input.executionId);
          if (prior) {
            if (
              prior.model_snapshot_json !==
                (input.modelMetadata === undefined ? null : canonicalJson(input.modelMetadata)) ||
              prior.intent_json !== canonicalJson(input.input) ||
              prior.run_id !== input.runId ||
              prior.adapter_id !== input.definitionId ||
              prior.definition_version !== input.definitionVersion ||
              prior.origin_command_id !== input.originCommandId ||
              prior.kind !== input.kind ||
              prior.parent_execution_id !== parentId ||
              prior.decision_source_json !== canonicalJson(input.decisionSource) ||
              prior.step_id !== input.stepId ||
              prior.call_id !== input.callId ||
              Boolean(prior.cancel_with_parent) !== (input.cancelWithParent ?? true)
            )
              throw new AgentError('execution_conflict');
            return this.execution(prior);
          }
          if (input.kind === 'model') verifyCompressionModel(this, input);
          this.run(
            'INSERT INTO execution(id,session_id,run_id,kind,origin_command_id,origin_store_id,root_work_command_id,root_work_seq,root_session_id,step_id,call_id,attempt,adapter_id,definition_version,state,intent_json,decision_source_json,owner_generation,parent_execution_id,cancel_with_parent,model_snapshot_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
            input.executionId,
            input.sessionId,
            input.runId,
            input.kind,
            input.originCommandId,
            command.origin_store_id,
            command.root_work_command_id,
            command.root_work_seq,
            input.owner.sessionId,
            input.stepId,
            input.callId,
            1,
            input.definitionId,
            input.definitionVersion,
            'planned',
            canonicalJson(input.input),
            canonicalJson(input.decisionSource),
            input.owner.generation,
            parentId,
            input.cancelWithParent === false ? 0 : 1,
            input.modelMetadata === undefined ? null : canonicalJson(input.modelMetadata),
          );
          if (command.kind === 'operation.tool')
            this.run(
              "UPDATE command SET status='applied',receipt_json=? WHERE id=?",
              canonicalJson({ executionId: input.executionId }),
              input.originCommandId,
            );
          this.event(input.sessionId, input.executionId, 'execution.planned');
          return this.execution(this.row('SELECT * FROM execution WHERE id=?', input.executionId)!);
        });
      case 'selectContext':
      case 'consumeJobResult':
      case 'includeResult':
      case 'getModelContext':
      case 'getExpandedContext':
      case 'getSelectedContext':
      case 'readOriginalRunSelection':
      case 'listPendingJobResults':
        return callContextSelection(this, method, args);
      case 'getCompressionOrigin':
        return getCompressionOrigin(this, args[0] as Parameters<Store['getCompressionOrigin']>[0]);
      case 'beginCompression':
        return beginCompression(this, args[0] as Parameters<Store['beginCompression']>[0]);
      case 'resetCompression':
        return resetCompression(this, args[0] as Parameters<Store['resetCompression']>[0]);
      case 'commitCompression':
        return commitCompression(this, args[0] as Parameters<Store['commitCompression']>[0]);
      case 'renameSession':
      case 'deleteSession':
        return manageSession(this, method, args[0] as Parameters<Store['renameSession']>[0]);
      case 'forkSession':
        return forkSession(this, args[0] as Parameters<Store['forkSession']>[0]);
      case 'prepareForkReadonlySources':
        return prepareForkReadonlySources(
          this,
          args[0] as Parameters<Store['prepareForkReadonlySources']>[0],
        );
      case 'readForkSourceMessage':
        return readForkSourceMessage(
          this,
          args[0] as Parameters<Store['readForkSourceMessage']>[0],
        );
      case 'readForkSourceProjection':
        return readForkSourceProjection(
          this,
          args[0] as Parameters<Store['readForkSourceProjection']>[0],
        );
      case 'readForkRecordSources':
        return readForkRecordSources(
          this,
          args[0] as Parameters<Store['readForkRecordSources']>[0],
        );
      case 'getMessageOrigin':
        return getMessageOrigin(this, args[0] as Parameters<Store['getMessageOrigin']>[0]);
      case 'applyInput':
        return applyInput(this, args[0] as Parameters<Store['applyInput']>[0]);
      case 'listPendingInputs':
        return listPendingInputs(this, args[0] as Parameters<Store['listPendingInputs']>[0]);
      case 'requestInteraction':
      case 'answerInteraction':
      case 'acceptInteractionDecision':
      case 'getInteraction':
      case 'listInteractions':
        return callInteraction(this, method, args);
      case 'getPermissionGrant':
      case 'listPermissionGrants':
      case 'clearPermissionGrants':
        return callPermissionGrant(this, method, args);
      case 'markDispatching':
        return this.tx(() => {
          this.identity(input.expectedStoreId);
          const execution = this.row('SELECT * FROM execution WHERE id=?', input.executionId);
          if (!execution) throw new AgentError('execution_not_found');
          assertNoExecutionGroupFence(this, String(execution.session_id), String(execution.id));
          this.active(
            input.owner,
            String(execution.origin_command_id),
            execution.run_id === null ? null : String(execution.run_id),
          );
          this.ancestors(input.owner, input.executionId);
          if (execution.kind === 'model') {
            verifyModelBody(this, parse(execution.intent_json), execution);
            verifyModelBody(this, parse(execution.model_snapshot_json), execution);
          }
          verifyModelBody(this, parse(execution.decision_source_json), execution);
          if (
            execution.state !== 'planned' ||
            execution.cancel_requested ||
            String(execution.owner_generation) !== input.owner.generation
          )
            throw new AgentError('execution_not_dispatchable');
          if (
            !input.authorization.allowed ||
            input.authorization.definitionVersion !== execution.definition_version ||
            input.authorization.inputDigest !== hash(parse(execution.intent_json))
          )
            throw new AgentError('permission_denied');
          if (
            !input.freshness.checked ||
            canonicalJson(input.freshness.source) !== execution.decision_source_json
          )
            throw new AgentError('context_refresh_required');
          const run =
            execution.run_id === null
              ? null
              : this.row('SELECT * FROM run WHERE id=?', String(execution.run_id));
          this.requirements(
            parse(
              run?.requirements_json ?? execution.requirements_json,
            ) as unknown as RequirementRef[],
            input.requirements,
            'dispatch',
            String(execution.id),
          );
          if (execution.run_id !== null) assertInputBoundary(this, String(execution.run_id));
          assertMutationIntent(this, execution);
          verifyPermissionGrantDispatch(this, input);
          verifyInteractionDispatch(this, execution, input);
          verifyHostControlDispatch(this, execution, input);
          verifyAuthorizationReviewDispatch(this, input);
          assertDispatchReadSet(this, execution, input);
          this.run(
            "UPDATE execution SET state='dispatching',dispatched=1,dispatch_authorization_json=? WHERE id=?",
            canonicalJson(input.authorization as unknown as Json),
            input.executionId,
          );
          this.event(String(execution.session_id), input.executionId, 'execution.dispatching');
          return this.execution(this.row('SELECT * FROM execution WHERE id=?', input.executionId)!);
        });
      case 'registerMutationIntent':
        return registerMutationIntent(
          this,
          args[0] as Parameters<Store['registerMutationIntent']>[0],
        );
      case 'listMutationFacts':
        return listMutationFacts(this, args[0] as Parameters<Store['listMutationFacts']>[0]);
      case 'commitMutationCheck':
        return commitMutationCheck(this, args[0] as Parameters<Store['commitMutationCheck']>[0]);
      case 'sealJobRecoveryManifest':
      case 'getJobReconciliationReceipt':
      case 'beginJobReconciliation':
      case 'markJobReconciliationDispatch':
      case 'finishJobReconciliation':
      case 'releaseJobRecoveryLease':
        return callJobReconciliation(this, method, args[0]);
      case 'applyJobReport':
        return applyJobReport(this, args[0] as Parameters<Store['applyJobReport']>[0]);
      case 'verifyJobReportRecovery':
        return verifyJobReportRecovery(
          this,
          args[0] as Parameters<Store['verifyJobReportRecovery']>[0],
        );
      case 'listPendingJobReports':
        return listPendingJobReports(
          this,
          args[0] as Parameters<Store['listPendingJobReports']>[0],
        );
      case 'finishExecution':
        return this.tx(() => {
          this.identity(input.expectedStoreId);
          this.owner(input.owner);
          const execution = this.row('SELECT * FROM execution WHERE id=?', input.executionId);
          if (execution) this.owner(input.owner, String(execution.session_id));
          if (!execution || String(execution.owner_generation) !== input.owner.generation)
            throw new AgentError('owner_changed');
          if (execution.origin_store_id !== input.expectedStoreId)
            throw new AgentError('operation_unverifiable');
          let status = input.status;
          let result = input.result;
          if (execution.child_session_id !== null && status !== 'outcome_unknown') {
            // The carrier cannot turn an attached unknown effect into a known Run failure.
            // Independent detached Jobs/children retain their separate supervision domain.
            const unsettled = this.row(
              `WITH RECURSIVE domain(id,depth) AS (
              SELECT id,0 FROM execution WHERE id=?
              UNION ALL SELECT child.id,domain.depth+1 FROM execution child JOIN domain ON child.parent_execution_id=domain.id
              WHERE child.cancel_with_parent=1 AND domain.depth<32
            ) SELECT e.*,domain.depth AS traversal_depth FROM execution e JOIN domain ON domain.id=e.id WHERE
              (domain.depth=32 AND EXISTS(SELECT 1 FROM execution child WHERE child.parent_execution_id=e.id AND child.cancel_with_parent=1)) OR
              (e.id<>? AND (e.state='outcome_unknown' OR e.origin_store_id<>? OR e.root_session_id<>? OR e.root_work_command_id<>? OR e.root_work_seq<>?)) LIMIT 1`,
              execution.id!,
              execution.id!,
              execution.origin_store_id!,
              execution.root_session_id!,
              execution.root_work_command_id!,
              execution.root_work_seq!,
            );
            if (unsettled) {
              if (
                unsettled.origin_store_id !== execution.origin_store_id ||
                unsettled.root_session_id !== execution.root_session_id ||
                unsettled.root_work_command_id !== execution.root_work_command_id ||
                unsettled.root_work_seq !== execution.root_work_seq
              )
                throw new AgentError('operation_unverifiable');
              status = 'outcome_unknown';
              const value =
                result && typeof result === 'object' && !Array.isArray(result)
                  ? (result as Record<string, Json>)
                  : {};
              const details =
                value.details && typeof value.details === 'object' && !Array.isArray(value.details)
                  ? (value.details as Record<string, Json>)
                  : {};
              result = {
                ...value,
                outcome: 'outcome_unknown',
                details: {
                  ...details,
                  originalOutcome: input.status,
                  childSettlement:
                    unsettled.state === 'outcome_unknown'
                      ? 'attached_effect_unknown'
                      : 'attached_domain_unverifiable',
                },
              };
            }
          }
          if (
            ['succeeded', 'failed', 'cancelled', 'outcome_unknown'].includes(
              String(execution.state),
            )
          ) {
            if (execution.state !== status || execution.result_json !== canonicalJson(result))
              throw new AgentError('terminal_conflict');
            return this.execution(execution);
          }
          const outputValue = modelOutputOf(result);
          if (outputValue !== undefined) {
            const output = verifyModelOutput(this, outputValue, execution);
            if (output.complete !== (status === 'succeeded'))
              throw new AgentError('model_output_invalid');
            const partial = this.row(
              'SELECT source_json FROM message WHERE id=? AND session_id=?',
              `partial_${input.executionId}`,
              execution.session_id!,
            );
            const checkpoint = partial ? modelOutputOf(parse(partial.source_json)) : undefined;
            if (
              checkpoint === undefined ||
              canonicalJson({ ...output, complete: false } as unknown as Json) !==
                canonicalJson(checkpoint as Json)
            )
              throw new AgentError('model_output_conflict');
            if (
              input.message &&
              canonicalJson(input.message.modelOutput as unknown as Json) !==
                canonicalJson(output as unknown as Json)
            )
              throw new AgentError('model_output_invalid');
          } else if (input.message?.modelOutput !== undefined)
            throw new AgentError('model_output_invalid');
          if (execution.kind === 'model' && status === 'succeeded') {
            const intent = parse(execution.intent_json) as Record<string, Json>;
            const body = bodyReference(intent.body);
            if (body) {
              verifyModelBody(this, intent, execution);
              if (
                !result ||
                typeof result !== 'object' ||
                Array.isArray(result) ||
                result.modelInputBodyHash !== body.reference.hash
              )
                throw new AgentError('model_body_receipt_invalid');
            }
          }
          if (execution.state === 'planned' && !['failed', 'cancelled'].includes(status))
            throw new AgentError('execution_not_dispatched');
          if (
            execution.child_session_id !== null &&
            status === 'succeeded' &&
            (this.row(
              'SELECT id FROM run WHERE session_id=? AND is_active=1',
              execution.child_session_id!,
            ) ||
              this.row(
                // Detached Jobs retain independent supervision after their child Run completes.
                // Unsettled Models, Tools and attached Jobs still prevent a successful carrier.
                "SELECT id FROM execution WHERE session_id=? AND state IN ('planned','dispatching','running','outcome_unknown') AND NOT (kind='job' AND cancel_with_parent=0)",
                execution.child_session_id!,
              ))
          )
            throw new AgentError('child_execution_unsettled');
          if (execution.kind === 'job' && status === 'succeeded')
            this.requirements(
              parse(execution.requirements_json) as unknown as RequirementRef[],
              input.requirements ?? [],
              'completion',
              String(execution.id),
            );
          if (BigInt(execution.result_revision!) >= 9223372036854775807n)
            throw new AgentError('sequence_exhausted');
          this.run(
            'UPDATE execution SET state=?,result_json=?,result_revision=result_revision+1 WHERE id=?',
            status,
            canonicalJson(result),
            input.executionId,
          );
          settleMutation(this, this.row('SELECT * FROM execution WHERE id=?', input.executionId)!);
          settleAgentMessages(
            this,
            this.row('SELECT * FROM execution WHERE id=?', input.executionId)!,
          );
          if (execution.child_session_id !== null) {
            const startId = `child-start-${execution.id}`;
            const pending = this.row(
              "SELECT id FROM command WHERE id=? AND session_id=? AND status='accepted'",
              startId,
              execution.child_session_id!,
            );
            if (pending) {
              this.run(
                'UPDATE command SET status=?,receipt_json=? WHERE id=?',
                status === 'outcome_unknown'
                  ? 'needs_review'
                  : status === 'cancelled'
                    ? 'cancelled'
                    : 'rejected',
                canonicalJson({
                  outcome: 'not_activated',
                  executionId: input.executionId,
                  reason: 'child_carrier_ended',
                }),
                startId,
              );
              this.event(String(execution.child_session_id), startId, 'command.settled');
            }
          }
          finishJobDelivery(this, execution);
          if (input.message) {
            const partial =
              execution.kind === 'model' && status === 'succeeded'
                ? this.row(
                    "SELECT id FROM message WHERE id=? AND session_id=? AND run_id=? AND role='assistant' AND status='incomplete'",
                    `partial_${input.executionId}`,
                    execution.session_id!,
                    execution.run_id!,
                  )
                : undefined;
            if (partial) {
              const body = canonicalJson(input.message as unknown as Json);
              this.run(
                "UPDATE message SET source_json=?,status='complete' WHERE id=?",
                body,
                partial.id!,
              );
              this.run(
                'UPDATE message_part SET json=?,revision=revision+1 WHERE message_id=?',
                body,
                partial.id!,
              );
              this.event(String(execution.session_id), String(partial.id), 'message.updated');
            } else
              this.appendMessage(
                String(execution.session_id),
                execution.run_id === null ? null : String(execution.run_id),
                input.message as unknown as Json,
                input.message.role,
              );
          }
          this.event(String(execution.session_id), input.executionId, 'execution.finished');
          this.run(
            'UPDATE execution SET completed_cursor=(SELECT last_change_cursor FROM storage_meta WHERE singleton=1) WHERE id=?',
            input.executionId,
          );
          registerJobReport(this, input.executionId);
          return this.execution(this.row('SELECT * FROM execution WHERE id=?', input.executionId)!);
        });
      case 'getExecution': {
        const row = this.row('SELECT * FROM execution WHERE id=?', String(args[0]));
        return row ? this.execution(row) : null;
      }
      case 'listExecutions':
        return this.rows(
          'SELECT * FROM execution WHERE session_id=? ORDER BY rowid LIMIT ?',
          String(args[0]),
          limit(args[1]),
        ).map((row) => this.execution(row));
      case 'persistModelPartial':
        return this.tx(() => {
          this.identity(input.expectedStoreId);
          this.owner(input.owner);
          const execution = this.row(
            "SELECT * FROM execution WHERE id=? AND kind='model' AND state IN ('dispatching','running','cancelled','failed','outcome_unknown')",
            input.executionId,
          );
          if (!execution) throw new AgentError('execution_not_active');
          this.owner(input.owner, String(execution.session_id));
          if (String(execution.owner_generation) !== input.owner.generation)
            throw new AgentError('owner_changed');
          if (input.modelOutput !== undefined) {
            const output = verifyModelOutput(this, input.modelOutput, execution);
            if (output.complete) throw new AgentError('model_output_invalid');
          }
          const messageBody = {
            content: input.content,
            sourceIds: [input.executionId],
            ...(input.modelOutput === undefined ? {} : { modelOutput: input.modelOutput }),
          } as unknown as Json;
          const id = `partial_${input.executionId}`;
          const prior = this.row('SELECT * FROM message WHERE id=?', id);
          if (input.modelOutput !== undefined && prior) {
            const oldValue = modelOutputOf(parse(prior.source_json));
            if (oldValue !== undefined) {
              const oldOutput = verifyModelOutput(this, oldValue, execution),
                next = input.modelOutput;
              if (BigInt(next.seq) === BigInt(oldOutput.seq)) {
                if (
                  canonicalJson(next as unknown as Json) !==
                  canonicalJson(oldOutput as unknown as Json)
                )
                  throw new AgentError('model_output_conflict');
              } else if (
                BigInt(next.seq) !== BigInt(oldOutput.seq) + 1n ||
                BigInt(next.contentBytes) < BigInt(oldOutput.contentBytes) ||
                BigInt(next.reasoningBytes) < BigInt(oldOutput.reasoningBytes) ||
                next.toolCallCount < oldOutput.toolCallCount ||
                next.head.id === oldOutput.head.id
              )
                throw new AgentError('model_output_conflict');
            } else if (input.modelOutput.seq !== '1') throw new AgentError('model_output_conflict');
          } else if (input.modelOutput !== undefined && input.modelOutput.seq !== '1')
            throw new AgentError('model_output_conflict');
          if (!prior)
            this.appendMessage(
              String(execution.session_id),
              String(execution.run_id),
              messageBody,
              'assistant',
              'incomplete',
              id,
            );
          else {
            this.run('UPDATE message SET source_json=? WHERE id=?', canonicalJson(messageBody), id);
            this.run(
              'UPDATE message_part SET json=?,revision=revision+1 WHERE message_id=?',
              canonicalJson(messageBody),
              id,
            );
            this.event(String(execution.session_id), id, 'message.updated');
          }
        });
      case 'listMessages':
        return this.rows(
          'SELECT * FROM message WHERE session_id=? AND seq>? AND seq<=? ORDER BY seq LIMIT ?',
          String(args[0]),
          String(
            (args[1] as { afterSeq?: string; upperSeq?: string; limit?: number } | undefined)
              ?.afterSeq ?? '0',
          ),
          String(
            (args[1] as { afterSeq?: string; upperSeq?: string; limit?: number } | undefined)
              ?.upperSeq ?? '9223372036854775807',
          ),
          limit(
            (args[1] as { afterSeq?: string; upperSeq?: string; limit?: number } | undefined)
              ?.limit,
          ),
        ).map((row) => this.message(row));
      case 'getView': {
        this.db.run('BEGIN');
        try {
          const id = String(args[0]);
          const session = this.row('SELECT * FROM session WHERE id=?', id);
          if (!session) throw new AgentError('session_not_found');
          const meta = this.metadata();
          const value = {
            session: this.session(session),
            // A bounded history must not hide current work after a long conversation.
            // Union identities once, then preserve chronological display order.
            runs: this.rows(
              `SELECT * FROM run WHERE rowid IN (
                SELECT rowid FROM run WHERE session_id=? AND is_active=1
                UNION SELECT rowid FROM (
                  SELECT rowid FROM run WHERE session_id=? ORDER BY rowid DESC LIMIT 200
                )
              ) ORDER BY rowid`,
              id,
              id,
            ).map((row) => this.runRecord(row)),
            executions: this.rows(
              `SELECT * FROM execution WHERE rowid IN (
                SELECT rowid FROM execution WHERE session_id=? AND state IN ('planned','dispatching','running','outcome_unknown')
                UNION SELECT rowid FROM (
                  SELECT rowid FROM execution WHERE session_id=? ORDER BY rowid DESC LIMIT 200
                )
              ) ORDER BY rowid`,
              id,
              id,
            ).map((row) => this.execution(row)),
            messages: this.rows(
              'SELECT * FROM message WHERE session_id=? ORDER BY seq LIMIT 200',
              id,
            ).map((row) => this.message(row)),
            snapshotCursor: meta.lastChangeCursor,
            storeId: meta.storeId,
          };
          this.db.run('COMMIT');
          return value;
        } catch (error) {
          this.db.run('ROLLBACK');
          throw error;
        }
      }
      case 'setRunResultWait':
        return this.tx(() => {
          this.identity(input.expectedStoreId);
          const ids = (args[0] as Parameters<Store['setRunResultWait']>[0]).executionIds;
          if (
            !Array.isArray(ids) ||
            ids.length > 64 ||
            new Set(ids).size !== ids.length ||
            ids.some((id) => typeof id !== 'string' || !id || id.length > 256)
          )
            throw new AgentError('invalid_wait_targets');
          const run = this.row('SELECT * FROM run WHERE id=?', input.runId);
          if (!run?.is_active) throw new AgentError('run_not_active');
          this.active(input.owner, String(run.origin_command_id), String(run.id));
          const refs = parse(run.requirements_json) as unknown as RequirementRef[];
          for (const id of ids) {
            const execution = this.row(
              'SELECT * FROM execution WHERE id=? AND session_id=?',
              id,
              run.session_id!,
            );
            const parent =
              execution?.parent_execution_id &&
              this.row('SELECT * FROM execution WHERE id=?', execution.parent_execution_id);
            if (
              execution?.kind !== 'job' ||
              !parent ||
              parent.run_id !== run.id ||
              execution.origin_store_id !== input.expectedStoreId ||
              execution.root_work_command_id !== run.root_work_command_id ||
              String(execution.root_work_seq) !== String(run.root_work_seq) ||
              !['planned', 'dispatching', 'running'].includes(String(execution.state))
            )
              throw new AgentError('result_wait_changed');
            const session = this.row(
              'SELECT context_selection_id FROM session WHERE id=?',
              run.session_id!,
            );
            if (execution.context_selection_id !== session?.context_selection_id)
              throw new AgentError('context_rewound');
            const match = refs.some((ref) => {
              if (
                ref.runId !== run.id ||
                ref.phase === 'dispatch' ||
                ref.originStoreId !== input.expectedStoreId
              )
                return false;
              const record = this.row(
                "SELECT * FROM extension_record WHERE extension_id=? AND scope_kind='session' AND scope_id=? AND key=?",
                ref.extensionId,
                ref.sessionId,
                ref.recordKey,
              );
              if (
                !record ||
                String(record.revision) !== ref.revision ||
                record.origin_store_id !== input.expectedStoreId
              )
                return false;
              const value = parse(record.json) as Record<string, Json>;
              return (
                value.kind === 'operation_result' &&
                value.executionId === id &&
                value.runId === run.id &&
                value.sessionId === run.session_id &&
                value.originStoreId === input.expectedStoreId &&
                value.originCommandId === execution.origin_command_id &&
                value.parentExecutionId === execution.parent_execution_id &&
                value.rootWorkCommandId === execution.root_work_command_id &&
                value.rootWorkSeq === String(execution.root_work_seq) &&
                this.row(
                  'SELECT extension_id FROM command WHERE id=?',
                  execution.origin_command_id!,
                )?.extension_id === ref.extensionId &&
                value.contextSelectionId === session?.context_selection_id
              );
            });
            if (!match) throw new AgentError('required_result_unverifiable');
          }
          const json = canonicalJson(ids);
          if (run.waiting_results_json !== json) {
            this.run(
              "UPDATE run SET waiting_results_json=?,status=CASE WHEN ?<>'[]' THEN 'waiting_execution' WHEN status='waiting_execution' THEN 'running' ELSE status END WHERE id=?",
              json,
              json,
              run.id!,
            );
            this.event(String(run.session_id), String(run.id), 'run.result_wait_changed');
          }
          return this.runRecord(this.row('SELECT * FROM run WHERE id=?', run.id!)!);
        });
      case 'finishRun':
        return this.tx(() => this.finishRun(input as Parameters<Store['finishRun']>[0]));
      case 'cancelCommand':
      case 'cancelWork':
        return cancel(
          this,
          args[0] as Parameters<Store['cancelCommand']>[0] | Parameters<Store['cancelWork']>[0],
        );
      case 'getSessionLogs':
        return getSessionLogs(this, args[0] as Parameters<Store['getSessionLogs']>[0]);
      case 'getChanges': {
        this.db.run('BEGIN');
        try {
          const meta = this.metadata();
          const after = String(input.after);
          if (!/^(0|[1-9][0-9]*)$/.test(after) || BigInt(after) > 9223372036854775807n)
            throw new AgentError('invalid_cursor');
          if (BigInt(after) > BigInt(meta.lastChangeCursor)) throw new AgentError('cursor_ahead');
          if (BigInt(after) < BigInt(meta.replayFloor)) throw new AgentError('cursor_expired');
          const scopes = input.sessionIds as string[] | undefined;
          const filter = scopes
            ? ` AND scope_session_id IN (${scopes.map(() => '?').join(',') || 'NULL'})`
            : '';
          const events = this.rows(
            `SELECT * FROM change_event WHERE cursor>?${filter} ORDER BY cursor LIMIT ?`,
            after,
            ...(scopes ?? []),
            limit(input.limit),
          ).map((row) => ({
            cursor: String(row.cursor),
            sessionId: row.scope_session_id === null ? null : String(row.scope_session_id),
            objectId: String(row.object_id),
            revision: String(row.revision),
            type: String(row.type),
            payload: unwrapChangePayload(parse(row.payload_json)),
          }));
          this.db.run('COMMIT');
          return { metadata: meta, events };
        } catch (error) {
          this.db.run('ROLLBACK');
          throw error;
        }
      }

      default:
        throw new AgentError('unsupported_store_operation');
    }
  }
  finishRun(input: Parameters<Store['finishRun']>[0]): RunRecord {
    this.identity(input.expectedStoreId);
    this.owner(input.owner);
    const run = this.row('SELECT * FROM run WHERE id=?', input.runId);
    if (!run) throw new AgentError('run_not_found');
    this.owner(input.owner, String(run.session_id));
    const command = this.row(
      'SELECT cancelled FROM command WHERE id=?',
      String(run.origin_command_id),
    );
    const status =
      input.status === 'failed' && (run.cancel_requested || command?.cancelled)
        ? 'cancelled'
        : input.status;
    if (!run.is_active) {
      if (run.status !== status) throw new AgentError('terminal_conflict');
      return this.runRecord(run);
    }
    if (input.status === 'completed') {
      assertInputBoundary(this, String(input.runId));
      this.active(input.owner, String(run.origin_command_id), input.runId);
      if (
        this.row(
          "SELECT id FROM execution WHERE run_id=? AND state IN ('planned','dispatching','running','outcome_unknown')",
          input.runId,
        )
      )
        throw new AgentError('execution_unsettled');
      this.requirements(
        parse(run.requirements_json) as unknown as RequirementRef[],
        input.requirements,
        'completion',
      );
    }
    this.run(
      "UPDATE run SET status=?,is_active=0,finished_at=?,reason=?,waiting_results_json='[]' WHERE id=?",
      status,
      Date.now(),
      input.reason ?? null,
      input.runId,
    );
    this.event(String(run.session_id), String(input.runId), 'run.finished');
    return this.runRecord(this.row('SELECT * FROM run WHERE id=?', input.runId)!);
  }
  allocateSessionSequence(id: string): void {
    if (
      BigInt(this.row('SELECT next_seq FROM session WHERE id=?', id)!.next_seq!) >=
      9223372036854775807n
    )
      throw new AgentError('sequence_exhausted');
    this.run('UPDATE session SET next_seq=next_seq+1 WHERE id=?', id);
  }
  insertCommand(
    input: Pick<AcceptCommandInput, 'expectedStoreId' | 'commandId' | 'sessionId' | 'subjectId'>,
    request: Json,
    digest: string,
    status: string,
    receipt: Json,
  ): void {
    this.allocateSessionSequence(input.sessionId);
    const session = this.row('SELECT * FROM session WHERE id=?', input.sessionId);
    if (!session) throw new AgentError('session_not_found');
    this.run(
      'INSERT INTO command(id,session_id,seq,kind,subject_id,request_digest,request_json,status,receipt_json,origin_store_id,root_work_command_id,root_work_seq,target_command_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',
      input.commandId,
      input.sessionId,
      session.next_seq,
      (request as { kind: string }).kind,
      input.subjectId,
      digest,
      canonicalJson(request),
      status,
      canonicalJson(receipt),
      this.metadata().storeId,
      input.commandId,
      session.next_seq,
      (request as { targetCommandId?: string }).targetCommandId ?? null,
    );
  }
}
function parse(value: string | number | bigint | null | undefined): Json {
  return value === null || value === undefined ? null : (JSON.parse(String(value)) as Json);
}
function hash(value: Json): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}
function limit(value: unknown): number {
  return Math.min(200, Math.max(1, Number(value) || 100));
}
export type StoreMethod = Exclude<
  keyof Store,
  'close' | 'acquireSessionOwner' | 'releaseSessionOwner' | 'inspectOwnerDispatch'
>;
