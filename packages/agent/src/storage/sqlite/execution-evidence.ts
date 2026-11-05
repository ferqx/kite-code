import { createHash } from 'node:crypto';
import type {
  ExecutionEvidencePage,
  ExecutionEvidenceRecord,
} from '../../business/execution-evidence';
import { executionEvidenceToolId } from '../../business/execution-evidence';
import type { PublicExecution } from '../../extensions';
import { canonicalJson } from '../../json';
import type { ExecutionEvidenceStoreInput } from '../port';
import { AgentError, type Json } from '../types';
import type { SqliteOperations } from './operations';

type Row = Record<string, string | number | bigint | null>;
const object = (value: unknown): Record<string, Json> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, Json>)
    : {};
const parse = (value: Row[string] | undefined) =>
  value === null || value === undefined ? null : (JSON.parse(String(value)) as Json);
const digest = (value: Json) => createHash('sha256').update(canonicalJson(value)).digest('hex');
function deny(): never {
  throw new AgentError('execution_evidence_scope_denied');
}
function cursorInvalid(): never {
  throw new AgentError('execution_evidence_cursor_invalid');
}
function sameWork(a: Row, b: Row) {
  return (
    a.origin_store_id === b.origin_store_id &&
    a.root_work_command_id === b.root_work_command_id &&
    String(a.root_work_seq) === String(b.root_work_seq)
  );
}
/** One scoped read of existing SQL facts. No history copying, private Model body or new ledger. */
export function readExecutionEvidence(
  db: SqliteOperations,
  input: ExecutionEvidenceStoreInput,
): ExecutionEvidencePage {
  db.identity(input.expectedStoreId);
  if (
    !Number.isSafeInteger(input.limit) ||
    input.limit < 1 ||
    input.limit > 100 ||
    (input.executionId && input.cursor)
  )
    cursorInvalid();
  const session = db.row(
    'SELECT * FROM session WHERE id=? AND delete_requested=0',
    input.sessionId,
  );
  const run = db.row('SELECT * FROM run WHERE id=? AND session_id=?', input.runId, input.sessionId);
  const caller = db.row(
    'SELECT rowid AS evidence_rowid,* FROM execution WHERE id=?',
    input.callerExecutionId,
  );
  if (
    !session ||
    !run ||
    !caller ||
    caller.kind !== 'tool' ||
    caller.adapter_id !== executionEvidenceToolId ||
    caller.definition_version !== '1' ||
    Number(caller.dispatched) !== 1 ||
    caller.session_id !== session.id ||
    caller.run_id !== run.id ||
    caller.origin_command_id !== run.origin_command_id ||
    caller.root_session_id !== session.root_id ||
    !sameWork(caller, run)
  )
    deny();
  const command = db.row(
    'SELECT * FROM command WHERE id=? AND session_id=?',
    run.origin_command_id!,
    session.id!,
  );
  const root = db.row('SELECT * FROM session WHERE id=? AND parent_id IS NULL', session.root_id!);
  const creator =
    root && db.row("SELECT * FROM command WHERE session_id=? AND kind='session.create'", root.id!);
  const rootWork =
    root &&
    db.row(
      'SELECT * FROM command WHERE id=? AND session_id=?',
      run.root_work_command_id!,
      root.id!,
    );
  if (
    !command ||
    !creator ||
    !rootWork ||
    command.subject_id !== creator.subject_id ||
    rootWork.subject_id !== command.subject_id ||
    !sameWork(command, run) ||
    rootWork.origin_store_id !== run.origin_store_id ||
    String(rootWork.seq) !== String(run.root_work_seq) ||
    digest(parse(command.request_json)) !== command.request_digest
  )
    deny();
  if (session.parent_id !== null) {
    const carrier = db.childCarrier(command, input.runId);
    const origin =
      carrier && db.row('SELECT * FROM command WHERE id=?', carrier.origin_command_id!);
    if (
      !carrier ||
      !origin ||
      carrier.child_session_id !== session.id ||
      carrier.session_id !== session.parent_id ||
      carrier.root_session_id !== session.root_id ||
      !sameWork(carrier, run) ||
      origin.subject_id !== command.subject_id
    )
      deny();
  }
  const configuration = object(parse(run.config_json));
  const registered = (row: Row, namespace: string) =>
    Array.isArray(configuration.tools) &&
    configuration.tools.some((value) => {
      const tool = object(value);
      return (
        tool.id === row.adapter_id &&
        tool.version === row.definition_version &&
        tool.extensionId === namespace
      );
    });
  if (!registered(caller, 'builtin.execution-evidence')) deny();
  const belongs = (row: Row): boolean => {
    if (
      !['tool', 'job'].includes(String(row.kind)) ||
      row.session_id !== session.id ||
      row.root_session_id !== session.root_id ||
      !sameWork(row, run) ||
      row.adapter_id === executionEvidenceToolId
    )
      return false;
    if (row.run_id !== null)
      return row.run_id === run.id && row.origin_command_id === run.origin_command_id;
    if (row.kind !== 'job') return false;
    if (row.child_session_id !== null) {
      const origin = db.row('SELECT * FROM command WHERE id=?', row.origin_command_id!);
      const parent = row.parent_execution_id
        ? db.row('SELECT * FROM execution WHERE id=?', row.parent_execution_id)
        : null;
      const child = db.row('SELECT * FROM session WHERE id=?', row.child_session_id!);
      const start = db.row('SELECT * FROM command WHERE id=?', `child-start-${row.id}`);
      const request = object(parse(origin?.request_json));
      const receipt = object(parse(origin?.receipt_json));
      const startRequest = object(parse(start?.request_json));
      const startReceipt = object(parse(start?.receipt_json));
      const configuration = object(parse(row.child_configuration_json));
      const reference = object(parse(row.reference_json));
      const childRun =
        typeof reference.runId === 'string'
          ? db.row(
              'SELECT * FROM run WHERE id=? AND session_id=?',
              reference.runId,
              row.child_session_id!,
            )
          : null;
      if (
        origin?.kind !== 'operation.agent' ||
        origin.status !== 'applied' ||
        origin.extension_id !== 'builtin.task' ||
        origin.session_id !== session.id ||
        origin.subject_id !== command.subject_id ||
        !sameWork(origin, run) ||
        digest(request) !== origin.request_digest ||
        request.kind !== 'operation.agent' ||
        request.extensionId !== 'builtin.task' ||
        request.parentExecutionId !== row.parent_execution_id ||
        request.definitionId !== row.adapter_id ||
        request.definitionVersion !== row.definition_version ||
        request.configurationId !== configuration.id ||
        row.adapter_id !== `agent/${configuration.id}` ||
        row.definition_version !== configuration.version ||
        canonicalJson(request.childConfiguration ?? null) !== row.child_configuration_json ||
        digest(request.input ?? null) !== digest(parse(row.intent_json)) ||
        receipt.commandId !== origin.id ||
        receipt.executionId !== row.id ||
        receipt.childSessionId !== row.child_session_id ||
        !parent ||
        parent.kind !== 'tool' ||
        parent.run_id !== run.id ||
        parent.origin_command_id !== run.origin_command_id ||
        parent.session_id !== session.id ||
        parent.root_session_id !== session.root_id ||
        !sameWork(parent, run) ||
        Number(parent.dispatched) !== 1 ||
        !['task.spawn', 'task.follow_up'].includes(String(parent.adapter_id)) ||
        parent.definition_version !== '1' ||
        !registered(parent, 'builtin.task') ||
        !child ||
        child.parent_id !== session.id ||
        child.root_id !== session.root_id ||
        child.workspace_id !== session.workspace_id ||
        !start ||
        start.session_id !== child.id ||
        start.subject_id !== command.subject_id ||
        !sameWork(start, run) ||
        digest(startRequest) !== start.request_digest ||
        startRequest.kind !== start.kind ||
        (start.kind === 'child.start' &&
          (startReceipt.executionId !== row.id ||
            startRequest.parentExecutionId !== row.id ||
            startRequest.configurationId !== configuration.id ||
            startRequest.configurationVersion !== configuration.version ||
            digest(startRequest.input ?? null) !== digest(parse(row.intent_json)))) ||
        (start.kind === 'input.follow_up' &&
          (start.agent_carrier_execution_id !== row.id ||
            startRequest.content !== object(parse(row.intent_json)).content)) ||
        (reference.runId !== undefined &&
          (!childRun ||
            startReceipt.runId !== childRun.id ||
            childRun.origin_command_id !== start.id ||
            !sameWork(childRun, run))) ||
        (start.kind !== 'child.start' && start.kind !== 'input.follow_up') ||
        db.childCarrier(start, typeof reference.runId === 'string' ? reference.runId : null)?.id !==
          row.id
      )
        return false;
      return true;
    }
    const validJobOrigin = (job: Row) => {
      const origin = db.row(
        'SELECT * FROM command WHERE id=? AND session_id=?',
        job.origin_command_id!,
        session.id!,
      );
      if (
        origin?.kind !== 'operation.job' ||
        origin.status !== 'applied' ||
        origin.subject_id !== command.subject_id ||
        !sameWork(origin, run) ||
        digest(parse(origin.request_json)) !== origin.request_digest
      )
        return false;
      const request = object(parse(origin.request_json)),
        receipt = object(parse(origin.receipt_json));
      return (
        receipt.executionId === job.id &&
        request.parentExecutionId === job.parent_execution_id &&
        request.definitionId === job.adapter_id &&
        request.definitionVersion === job.definition_version &&
        digest(request.input ?? null) === digest(parse(job.intent_json))
      );
    };
    if (!validJobOrigin(row)) return false;
    const seen = new Set<string>([String(row.id)]);
    let parentId = row.parent_execution_id;
    while (parentId !== null) {
      if (typeof parentId !== 'string' || seen.has(parentId)) return false;
      seen.add(parentId);
      const parent = db.row('SELECT * FROM execution WHERE id=?', parentId);
      if (
        !parent ||
        parent.session_id !== session.id ||
        parent.root_session_id !== session.root_id ||
        !sameWork(parent, run)
      )
        return false;
      if (parent.run_id !== null)
        return (
          parent.run_id === run.id &&
          parent.kind === 'tool' &&
          parent.origin_command_id === run.origin_command_id
        );
      if (parent.kind !== 'job' || !validJobOrigin(parent)) return false;
      parentId = parent.parent_execution_id;
    }
    return false;
  };
  const project = (row: Row): ExecutionEvidenceRecord => {
    const actual = db.execution(row);
    const execution: PublicExecution = {
      id: actual.id,
      sessionId: actual.sessionId,
      runId: actual.runId,
      kind: actual.kind,
      status: actual.status,
      result: actual.result,
      resultRevision: actual.resultRevision,
      originStoreId: actual.originStoreId,
      originCommandId: actual.originCommandId,
      rootWorkCommandId: actual.rootWorkCommandId,
      rootWorkSeq: actual.rootWorkSeq,
      parentExecutionId: actual.parentExecutionId,
      definitionId: actual.definitionId,
      definitionVersion: actual.definitionVersion,
      attempt: actual.attempt,
      inputDigest: digest(actual.input),
      delivery: actual.delivery,
      deliveryReason: actual.deliveryReason,
      resultAcceptance: actual.resultAcceptance,
    };
    const paths: NonNullable<ExecutionEvidenceRecord['paths']>[number][] = [];
    const intent = object(actual.input);
    if (
      actual.kind === 'tool' &&
      registered(row, 'builtin.files') &&
      ['files.write', 'files.edit'].includes(actual.definitionId) &&
      ['2', '3'].includes(actual.definitionVersion) &&
      typeof intent.path === 'string'
    )
      paths.push({ path: intent.path, source: 'files_input' });
    let shellId: string | undefined;
    if (
      actual.kind === 'tool' &&
      registered(row, 'builtin.shell') &&
      ['shell.execute', 'shell.launch'].includes(actual.definitionId) &&
      actual.definitionVersion === '1'
    ) {
      const result = object(actual.result);
      let body: Record<string, Json> = {};
      if (typeof result.content === 'string') {
        try {
          body = object(JSON.parse(result.content));
        } catch (error) {
          if (!(error instanceof SyntaxError)) throw error;
        }
      }
      if (typeof body.shellId === 'string' && body.shellId.length > 0) shellId = body.shellId;
    }
    let checkpoint: ExecutionEvidenceRecord['checkpoint'];
    if (input.executionId && paths.length > 0) {
      const rows = db.rows(
        "SELECT * FROM extension_record WHERE extension_id='builtin.files' AND scope_kind='session' AND scope_id=? AND content_type='builtin.files.checkpoint.file' AND content_version=1 AND origin_store_id=? AND json_extract(json,'$.path')=? AND (json_extract(json,'$.first.source.executionId')=? OR json_extract(json,'$.last.source.executionId')=? OR json_extract(json,'$.pending.source.executionId')=?) LIMIT 2",
        input.sessionId,
        actual.originStoreId,
        paths[0]!.path,
        actual.id,
        actual.id,
        actual.id,
      );
      if (rows.length === 1) {
        const file = object(parse(rows[0]!.json));
        const source = ['first', 'last', 'pending']
          .map((key) => object(object(file[key]).source))
          .find((value) => value.executionId === actual.id);
        const decision = object(actual.decisionSource);
        const point =
          typeof file.checkpointId === 'string' && /^[a-f0-9]{64}$/.test(file.checkpointId)
            ? db.row(
                "SELECT json FROM extension_record WHERE extension_id='builtin.files' AND scope_kind='session' AND scope_id=? AND key=? AND content_type='builtin.files.checkpoint' AND content_version=1 AND origin_store_id=?",
                input.sessionId,
                `checkpoint/${file.checkpointId}/point`,
                actual.originStoreId,
              )
            : null;
        const boundary = object(object(parse(point?.json)).boundary);
        if (
          source &&
          source.runId === actual.runId &&
          source.definitionId === actual.definitionId &&
          source.definitionVersion === actual.definitionVersion &&
          source.attempt === actual.attempt &&
          source.inputDigest === execution.inputDigest &&
          decision.kind === 'model_decision' &&
          source.modelExecutionId === decision.modelExecutionId &&
          boundary.runId === actual.runId &&
          boundary.sessionId === actual.sessionId &&
          boundary.storeId === actual.originStoreId &&
          boundary.workspaceId === session.workspace_id &&
          ['pending', 'captured', 'failed', 'unknown'].includes(String(file.state))
        ) {
          checkpoint = { id: String(file.checkpointId), state: String(file.state) };
        }
      }
    }
    return {
      execution,
      taskRunId: input.runId,
      paths,
      ...(shellId ? { shellId } : {}),
      ...(checkpoint ? { checkpoint } : {}),
    };
  };
  if (input.executionId !== undefined) {
    const row = db.row('SELECT * FROM execution WHERE id=?', input.executionId);
    if (!row) return { items: [], nextCursor: null };
    if (!belongs(row)) deny();
    return { items: [project(row)], nextCursor: null };
  }
  let anchor = caller,
    after = 0n,
    upper = BigInt(caller.evidence_rowid!) - 1n;
  if (input.cursor !== undefined) {
    let cursor: Record<string, Json>;
    try {
      cursor = object(JSON.parse(Buffer.from(input.cursor, 'base64url').toString('utf8')));
    } catch {
      cursorInvalid();
    }
    if (
      cursor.version !== 1 ||
      cursor.storeId !== input.expectedStoreId ||
      cursor.sessionId !== input.sessionId ||
      cursor.runId !== input.runId ||
      typeof cursor.anchorExecutionId !== 'string' ||
      typeof cursor.afterRowid !== 'string' ||
      !/^[1-9][0-9]*$/.test(cursor.afterRowid) ||
      typeof cursor.upperRowid !== 'string' ||
      !/^(0|[1-9][0-9]*)$/.test(cursor.upperRowid)
    )
      cursorInvalid();
    const original = db.row(
      'SELECT rowid AS evidence_rowid,* FROM execution WHERE id=?',
      cursor.anchorExecutionId,
    );
    if (
      original?.kind !== 'tool' ||
      original.adapter_id !== executionEvidenceToolId ||
      original.definition_version !== '1' ||
      original.session_id !== session.id ||
      original.run_id !== run.id ||
      !sameWork(original, run) ||
      original.origin_command_id !== run.origin_command_id ||
      BigInt(original.evidence_rowid!) > BigInt(caller.evidence_rowid!)
    )
      cursorInvalid();
    anchor = original;
    upper = BigInt(original.evidence_rowid!) - 1n;
    after = BigInt(cursor.afterRowid);
    if (BigInt(cursor.upperRowid) !== upper || after > upper) cursorInvalid();
    const previous = db.row('SELECT * FROM execution WHERE rowid=?', after);
    if (!previous || !belongs(previous)) cursorInvalid();
  }
  const selected: Row[] = [];
  let scan = after;
  while (selected.length <= input.limit) {
    const page = db.rows(
      "SELECT rowid AS evidence_rowid,* FROM execution WHERE session_id=? AND kind IN('tool','job') AND (run_id=? OR run_id IS NULL) AND rowid>? AND rowid<=? ORDER BY rowid LIMIT 200",
      input.sessionId,
      input.runId,
      scan,
      upper,
    );
    if (!page.length) break;
    for (const row of page) {
      scan = BigInt(row.evidence_rowid!);
      if (belongs(row)) selected.push(row);
      if (selected.length > input.limit) break;
    }
    if (page.length < 200 || selected.length > input.limit) break;
  }
  const hasMore = selected.length > input.limit;
  const items = selected.slice(0, input.limit);
  return {
    items: items.map(project),
    nextCursor: hasMore
      ? Buffer.from(
          JSON.stringify({
            version: 1,
            storeId: input.expectedStoreId,
            sessionId: input.sessionId,
            runId: input.runId,
            anchorExecutionId: anchor.id,
            upperRowid: upper.toString(),
            afterRowid: String(items.at(-1)!.evidence_rowid),
          }),
        ).toString('base64url')
      : null,
  };
}
