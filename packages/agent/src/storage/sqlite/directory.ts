import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalJson } from '../../json';
import {
  decodeWorkerRequest,
  digest,
  jsonObject,
  parseGitWorktreeInput,
  resolveDefaultWorktreeTarget,
  validateFrame,
  validatePlan,
  validateResolvedWorktreeTarget,
} from '../../tools/git-worktree/protocol';
import type { Store } from '../port';
import { AgentError, type Json, type SessionDirectoryActivity } from '../types';
import type { SqliteOperations } from './operations';

function sequence(value: unknown, fallback: string): string {
  if (value === undefined) return fallback;
  if (
    typeof value !== 'string' ||
    !/^(0|[1-9][0-9]*)$/.test(value) ||
    BigInt(value) > 9223372036854775807n
  )
    throw new AgentError('invalid_page');
  return value;
}
function eventTime(value: unknown): number | null {
  if (typeof value !== 'bigint' && typeof value !== 'number') return null;
  const time = Number(value);
  return Number.isSafeInteger(time) && time >= 0 && time <= 8640000000000000 ? time : null;
}
function workspacePath(rootUri: unknown): string | undefined {
  try {
    if (typeof rootUri !== 'string') return;
    const uri = new URL(rootUri);
    if (
      uri.protocol !== 'file:' ||
      (uri.hostname && uri.hostname !== 'localhost') ||
      uri.username ||
      uri.password ||
      uri.search ||
      uri.hash
    )
      return;
    const path = fileURLToPath(uri);
    return isAbsolute(path) && resolve(path) === path && !path.includes('\0') ? path : undefined;
  } catch {
    return;
  }
}
/** Historical navigation provenance only. No filesystem probes or execution authority. */
function worktreeSources(
  db: SqliteOperations,
  workspaceIds: string[],
  storeId: string,
  subjectId: string,
): Map<string, { sessionId: string; workspaceId: string }> {
  const targets = new Map<string, string[]>();
  if (!workspaceIds.length) return new Map();
  for (const row of db.rows(
    `SELECT id,root_uri FROM workspace WHERE id IN (${workspaceIds.map(() => '?').join(',')}) AND json_type(metadata_json,'$.removal') IS NULL`,
    ...workspaceIds,
  )) {
    const path = workspacePath(row.root_uri);
    if (path) targets.set(path, [...(targets.get(path) ?? []), String(row.id)]);
  }
  if (!targets.size) return new Map();
  const rows = db.rows(
    `SELECT x.key AS record_key,x.json AS record_json,s.id AS source_session,s.workspace_id AS source_workspace,
      w.root_uri AS source_uri,o.id AS owner_id,o.intent_json AS owner_input,o.result_json AS owner_result,
      j.id AS job_id,j.origin_command_id AS job_command,j.intent_json AS job_input,j.result_json AS job_result,
      c.operation_key AS job_key,r.id AS run_id,r.config_json AS run_config
    FROM extension_record x
    JOIN session s ON s.id=x.scope_id AND s.parent_id IS NULL AND s.delete_requested=0 AND s.deleted_at IS NULL
    JOIN workspace w ON w.id=s.workspace_id AND json_type(w.metadata_json,'$.removal') IS NULL
    JOIN execution o ON o.id=CASE WHEN json_valid(x.json) THEN json_extract(x.json,'$.ownerExecutionId') END
      AND o.session_id=s.id AND o.root_session_id=s.id AND o.origin_store_id=x.origin_store_id
      AND o.kind='tool' AND o.adapter_id='git.worktree' AND o.definition_version='1' AND o.state='succeeded' AND o.dispatched=1
    JOIN run r ON r.id=o.run_id AND r.session_id=s.id AND r.origin_store_id=o.origin_store_id
      AND r.origin_command_id=o.origin_command_id AND r.root_work_command_id=o.root_work_command_id AND r.root_work_seq=o.root_work_seq
    JOIN execution j ON j.id=CASE WHEN json_valid(x.json) THEN json_extract(x.json,'$.steps.mutation.ref.executionId') END
      AND j.parent_execution_id=o.id AND j.session_id=s.id AND j.root_session_id=s.id AND j.origin_store_id=o.origin_store_id
      AND j.root_work_command_id=o.root_work_command_id AND j.root_work_seq=o.root_work_seq
      AND (j.run_id IS NULL OR j.run_id=o.run_id) AND j.kind='job' AND j.adapter_id='shell.command'
      AND j.definition_version='1' AND j.state='succeeded' AND j.dispatched=1
    JOIN command c ON c.id=j.origin_command_id AND c.session_id=s.id AND c.origin_store_id=j.origin_store_id
      AND c.kind='operation.job' AND c.extension_id='builtin.shell' AND c.scope_kind='session' AND c.scope_id=s.id
    WHERE x.extension_id='builtin.shell' AND x.scope_kind='session' AND x.content_type='application/vnd.kite.git-worktree-operation+json'
      AND x.content_version=1 AND x.origin_store_id=? AND x.fork_provenance_json IS NULL
      AND EXISTS(SELECT 1 FROM command creator WHERE creator.session_id=s.id AND creator.kind='session.create' AND creator.subject_id=?)
      AND CASE WHEN json_valid(x.json) THEN json_extract(x.json,'$.plan.targetPath') IN (${[...targets.keys()].map(() => '?').join(',')}) ELSE 0 END`,
    storeId,
    subjectId,
    ...targets.keys(),
  );
  const sources = new Map<string, Map<string, { sessionId: string; workspaceId: string }>>();
  const registrations = new Map<string, boolean>();
  for (const row of rows) {
    // Optional malformed/old records never block the original directory page.
    try {
      const value: unknown = JSON.parse(String(row.record_json));
      if (!jsonObject(value)) continue;
      const request = parseGitWorktreeInput(value.request);
      const plan = value.plan;
      const stable = value.stableResult;
      const steps = value.steps;
      if (
        value.schemaVersion !== 1 ||
        value.phase !== 'completed' ||
        typeof value.ownerExecutionId !== 'string' ||
        value.ownerExecutionId !== row.owner_id ||
        typeof value.configurationIdentity !== 'string' ||
        !/^[a-f0-9]{64}$/.test(value.configurationIdentity) ||
        !request ||
        request.action !== 'create' ||
        row.record_key !== `git-worktree/${request.key}` ||
        canonicalJson(request as unknown as Json) !== canonicalJson(value.request!) ||
        !validatePlan(plan) ||
        plan.action !== 'create' ||
        workspacePath(row.source_uri) !== plan.sourceCwd ||
        value.planDigest !== digest(plan) ||
        value.requestDigest !== digest({ input: request, sourceCwd: plan.sourceCwd }) ||
        (request.path !== undefined
          ? resolve(request.path) !== plan.targetPath || value.resolvedTarget !== undefined
          : !validateResolvedWorktreeTarget(value.resolvedTarget) ||
            value.resolvedTarget.path !== plan.targetPath ||
            value.resolvedTarget.path !==
              resolveDefaultWorktreeTarget({
                defaultRoot: value.resolvedTarget.defaultRoot,
                sourceCwd: plan.sourceCwd,
                sessionId: String(row.source_session),
                key: request.key,
              })) ||
        !jsonObject(stable) ||
        stable.outcome !== 'succeeded' ||
        typeof stable.content !== 'string' ||
        !jsonObject(stable.details) ||
        !jsonObject(steps) ||
        !jsonObject(steps.mutation)
      )
        continue;
      const details = stable.details;
      const operation = details.operation;
      const step = steps.mutation;
      const ref = step.ref;
      const token = digest({
        sessionId: row.source_session,
        executionId: row.owner_id,
        key: row.record_key,
        requestDigest: value.requestDigest,
      });
      const frameDetails = { ...details };
      delete frameDetails.key;
      delete frameDetails.operation;
      delete frameDetails.replayed;
      if (
        !validateFrame(
          {
            protocolVersion: 1,
            operationToken: token,
            phase: 'create',
            businessOutcome: 'succeeded',
            details: frameDetails,
          },
          { operationToken: token, phase: 'create' },
        ) ||
        details.action !== 'create' ||
        details.key !== request.key ||
        details.path !== plan.targetPath ||
        details.mutation !== 'completed' ||
        details.cwdChanged !== false ||
        !jsonObject(operation) ||
        operation.ownerExecutionId !== row.owner_id ||
        !jsonObject(ref) ||
        ref.extensionId !== 'builtin.shell' ||
        ref.originStoreId !== storeId ||
        ref.sessionId !== row.source_session ||
        ref.executionId !== row.job_id ||
        ref.commandId !== row.job_command ||
        ref.key !== row.job_key ||
        step.operationKey !== ref.key ||
        step.operationKey !== `git-worktree-${digest({ token, kind: 'mutation' })}` ||
        canonicalJson(operation.ref!) !== canonicalJson(ref) ||
        !jsonObject(step.input) ||
        step.inputDigest !== digest(step.input) ||
        typeof step.input.command !== 'string'
      )
        continue;
      const encoded = step.input.command.match(/ '([A-Za-z0-9_-]+)'$/)?.[1];
      const worker = encoded ? decodeWorkerRequest(encoded) : undefined;
      const jobResult: unknown = JSON.parse(String(row.job_result));
      if (
        worker?.phase !== 'create' ||
        worker.operationToken !== token ||
        worker.sourceCwd !== plan.sourceCwd ||
        worker.planDigest !== value.planDigest ||
        canonicalJson(worker.plan as unknown as Json) !== canonicalJson(plan as unknown as Json) ||
        canonicalJson(step.request!) !== canonicalJson(worker as unknown as Json) ||
        canonicalJson(JSON.parse(String(row.job_input))) !== canonicalJson(step.input) ||
        !jsonObject(jobResult) ||
        jobResult.outcome !== 'succeeded'
      )
        continue;
      const originalInput = parseGitWorktreeInput(JSON.parse(String(row.owner_input)));
      const originalResult: unknown = JSON.parse(String(row.owner_result));
      if (
        !originalInput ||
        canonicalJson(originalInput as unknown as Json) !==
          canonicalJson(request as unknown as Json) ||
        !jsonObject(originalResult) ||
        originalResult.outcome !== 'succeeded' ||
        !jsonObject(originalResult.details)
      )
        continue;
      const originalDetails = originalResult.details;
      if (
        [
          'action',
          'key',
          'path',
          'mutation',
          'cwdChanged',
          'operation',
          'head',
          'baseCommit',
          'branch',
          'detached',
        ].some(
          (field) =>
            canonicalJson(originalDetails[field] ?? null) !== canonicalJson(details[field] ?? null),
        )
      )
        continue;
      const runId = String(row.run_id);
      if (!registrations.has(runId)) {
        const config: unknown = JSON.parse(String(row.run_config));
        const tools =
          jsonObject(config) && Array.isArray(config.tools)
            ? config.tools.filter(
                (tool) => jsonObject(tool) && tool.id === 'git.worktree' && tool.version === '1',
              )
            : [];
        const extensions =
          jsonObject(config) && Array.isArray(config.extensions)
            ? config.extensions.filter((entry) => jsonObject(entry) && entry.id === 'builtin.shell')
            : [];
        registrations.set(
          runId,
          tools.length === 1 &&
            jsonObject(tools[0]) &&
            tools[0].extensionId === 'builtin.shell' &&
            extensions.length === 1 &&
            jsonObject(extensions[0]) &&
            extensions[0].version === '1',
        );
      }
      if (!registrations.get(runId)) continue;
      const source = {
        sessionId: String(row.source_session),
        workspaceId: String(row.source_workspace),
      };
      const bySource = sources.get(plan.targetPath) ?? new Map();
      bySource.set(JSON.stringify(source), source);
      sources.set(plan.targetPath, bySource);
    } catch {
      /* An optional provenance failure preserves ordinary history. */
    }
  }
  const result = new Map<string, { sessionId: string; workspaceId: string }>();
  for (const [path, candidates] of sources) {
    if (candidates.size !== 1) continue;
    const source = candidates.values().next().value!;
    for (const workspaceId of targets.get(path) ?? []) result.set(workspaceId, source);
  }
  return result;
}
/** Short read-only snapshot; rowid is the original persistent allocation order, never a JS number. */
export function readDirectory(
  db: SqliteOperations,
  kind: 'session' | 'workspace',
  input:
    | Parameters<Store['listSessionDirectory']>[0]
    | Parameters<Store['listWorkspaceDirectory']>[0],
) {
  const allowed =
    kind === 'session'
      ? [
          'expectedStoreId',
          'subjectId',
          'workspaceId',
          'afterSeq',
          'upperSeq',
          'snapshotCursor',
          'limit',
        ]
      : ['expectedStoreId', 'afterSeq', 'upperSeq', 'limit'];
  if (!input || Object.keys(input).some((key) => !allowed.includes(key)))
    throw new AgentError('invalid_page');
  db.identity(input.expectedStoreId);
  const limit = input.limit ?? 200;
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new AgentError('invalid_page');
  db.db.run('BEGIN');
  try {
    const snapshotCursor = db.metadata().lastChangeCursor;
    const sessionInput = input as Parameters<Store['listSessionDirectory']>[0];
    if (
      kind === 'session' &&
      sessionInput.snapshotCursor !== undefined &&
      sequence(sessionInput.snapshotCursor, snapshotCursor) !== snapshotCursor
    )
      throw new AgentError('directory_changed');
    const highWaterSeq = String(
      db.row(`SELECT CAST(COALESCE(MAX(rowid),0) AS TEXT) AS seq FROM ${kind}`)!.seq,
    );
    const upperSeq = sequence(input.upperSeq, highWaterSeq),
      afterSeq = sequence(input.afterSeq, '0');
    if (BigInt(upperSeq) > BigInt(highWaterSeq) || BigInt(afterSeq) > BigInt(upperSeq))
      throw new AgentError('invalid_page');
    if (
      kind === 'session' &&
      (typeof sessionInput.subjectId !== 'string' || !sessionInput.subjectId)
    )
      throw new AgentError('directory_scope_denied');
    const rows =
      kind === 'workspace'
        ? db.rows(
            "SELECT *,CAST(rowid AS TEXT) AS directory_seq FROM workspace WHERE rowid>? AND rowid<=? AND json_type(metadata_json,'$.removal') IS NULL ORDER BY rowid LIMIT ?",
            afterSeq,
            upperSeq,
            limit + 1,
          )
        : db.rows(
            `WITH roots AS (
              SELECT s.*,CAST(s.rowid AS TEXT) AS directory_seq FROM session s
              WHERE s.rowid>? AND s.rowid<=? AND s.parent_id IS NULL AND s.delete_requested=0
              AND (? IS NULL OR s.workspace_id=?)
              AND EXISTS(SELECT 1 FROM command c WHERE c.session_id=s.id AND c.kind='session.create' AND c.subject_id=?)
              ORDER BY s.rowid LIMIT ?
            ), latest_message_change AS (
              SELECT e.scope_session_id,MAX(e.cursor) AS cursor FROM change_event e
              JOIN roots s ON s.id=e.scope_session_id
              WHERE e.type='message.updated' GROUP BY e.scope_session_id
            ) SELECT s.*,r.id AS activity_run_id,r.status AS activity_run_status,r.is_active AS activity_run_active,
              r.cancel_requested AS activity_run_cancel_requested,
              EXISTS(SELECT 1 FROM command c WHERE c.session_id=s.id AND c.status='accepted' AND c.cancelled=0 AND c.root_work_seq>s.stop_boundary
                AND c.kind IN ('run.start','input.follow_up')) AS activity_queued,
              (SELECT COUNT(*) FROM interaction i WHERE i.presentation_session_id=s.id
                AND i.subject_id=? AND i.origin_store_id=? AND i.state='pending') AS activity_pending,
              EXISTS(SELECT 1 FROM extension_record x
                WHERE x.extension_id='builtin.shell' AND x.scope_kind='session' AND x.scope_id=s.id
                  AND x.content_type='application/vnd.kite.git-worktree-operation+json'
                  AND x.content_version=1 AND x.fork_provenance_json IS NULL AND x.origin_store_id IS NOT NULL AND x.origin_store_id<>''
                  AND CASE WHEN json_valid(x.json) THEN
                    json_extract(x.json,'$.schemaVersion')=1
                    AND json_type(x.json,'$.schemaVersion')='integer'
                    AND json_extract(x.json,'$.phase')='completed'
                    AND json_extract(x.json,'$.request.action')='create'
                    AND json_type(x.json,'$.request.key')='text'
                    AND length(json_extract(x.json,'$.request.key'))>0
                    AND json_type(x.json,'$.ownerExecutionId')='text'
                    AND length(json_extract(x.json,'$.ownerExecutionId'))>0
                    AND x.key='git-worktree/'||json_extract(x.json,'$.request.key')
                    AND json_extract(x.json,'$.stableResult.outcome')='succeeded'
                    AND json_extract(x.json,'$.stableResult.details.action')='create'
                    AND json_extract(x.json,'$.stableResult.details.key')=json_extract(x.json,'$.request.key')
                    AND json_extract(x.json,'$.stableResult.details.mutation')='completed'
                    AND json_type(x.json,'$.stableResult.details.cwdChanged')='false'
                    AND json_extract(x.json,'$.stableResult.details.operation.ownerExecutionId')=json_extract(x.json,'$.ownerExecutionId')
                  ELSE 0 END) AS activity_created_worktree,
              CASE WHEN json_valid(e.payload_json) THEN
                CASE WHEN json_extract(e.payload_json,'$.format')='kite.session-log'
                  AND json_extract(e.payload_json,'$.version')=1
                  AND json_type(e.payload_json,'$.version')='integer'
                  AND json_type(e.payload_json,'$.occurredAt')='integer'
                  THEN json_extract(e.payload_json,'$.occurredAt') END
                END AS activity_updated_at
            FROM roots s
            LEFT JOIN run r ON r.rowid=(SELECT rowid FROM run WHERE session_id=s.id ORDER BY is_active DESC,rowid DESC LIMIT 1)
            LEFT JOIN latest_message_change c ON c.scope_session_id=s.id
            LEFT JOIN change_event e ON e.cursor=c.cursor
            ORDER BY CAST(s.directory_seq AS INTEGER)`,
            afterSeq,
            upperSeq,
            sessionInput.workspaceId ?? null,
            sessionInput.workspaceId ?? null,
            sessionInput.subjectId,
            limit + 1,
            sessionInput.subjectId,
            input.expectedStoreId,
          );
    const pageRows = rows.slice(0, limit);
    const sources =
      kind === 'session'
        ? worktreeSources(
            db,
            [...new Set(pageRows.map((row) => String(row.workspace_id)))],
            input.expectedStoreId,
            sessionInput.subjectId,
          )
        : new Map();
    const items = pageRows.map((row) =>
      kind === 'workspace'
        ? {
            seq: String(row.directory_seq),
            workspace: {
              id: String(row.id),
              name: String(row.name),
              rootUri: String(row.root_uri),
            },
          }
        : {
            seq: String(row.directory_seq),
            session: db.session(row),
            ...(sources.has(String(row.workspace_id))
              ? { worktreeSource: sources.get(String(row.workspace_id)) }
              : {}),
            activity: {
              updatedAt: eventTime(row.activity_updated_at),
              ...(row.activity_created_worktree ? { hasCreatedWorktree: true } : {}),
              run:
                row.activity_run_id === null
                  ? null
                  : {
                      id: String(row.activity_run_id),
                      status: db.runStatus(
                        row.activity_run_status as NonNullable<
                          SessionDirectoryActivity['run']
                        >['status'],
                        !!row.activity_run_active,
                        !!row.activity_run_cancel_requested,
                      ),
                      isActive: !!row.activity_run_active,
                    },
              queued: !!row.activity_queued,
              pendingInteractions: Number(row.activity_pending),
            },
          },
    );
    const result = {
      storeId: input.expectedStoreId,
      items,
      highWaterSeq,
      upperSeq,
      nextAfterSeq: rows.length > limit ? items.at(-1)!.seq : null,
      snapshotCursor,
    };
    db.db.run('COMMIT');
    return result;
  } catch (error) {
    return db.rollback(error);
  }
}
