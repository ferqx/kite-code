import type { SqliteOperations } from './operations';

/** Existing causal visibility rule, evaluated by the writer, never by normal indexed reads. */
export function projectOutputDeliveries(
  db: SqliteOperations,
  sessionId: string,
  prefix = 'delivery/',
  beforeKey = `${prefix}\uffff`,
  limit = -1,
) {
  return db.rows(
    `WITH deliveries AS (
                SELECT d.key,d.json,
                  json_extract(d.json,'$.sourceRunId') AS run_id,
                  json_extract(d.json,'$.relativePath') AS path,
                  json_extract(d.json,'$.reference.hash') AS content_hash,
                  CASE WHEN json_extract(d.json,'$.collectionId') IS NULL THEN 'files' ELSE 'shell' END AS producer_kind,
                  CASE WHEN c.fork_provenance_json IS NULL AND d.fork_provenance_json IS NULL
                    AND json_extract(c.json,'$.state')='ready'
                    AND owner_run.status IN ('completed','failed','cancelled') AND owner_run.is_active=0
                    AND json_extract(c.json,'$.source.producerExecutionId')=e.id
                    AND json_extract(c.json,'$.source.runId')=json_extract(d.json,'$.sourceRunId')
                    AND e.state='succeeded' AND e.origin_store_id=d.origin_store_id
                    AND c.origin_store_id=d.origin_store_id
                    AND t.run_id=json_extract(d.json,'$.sourceRunId')
                    AND CAST(json_extract(c.json,'$.source.producerResultRevision') AS TEXT)=CAST(e.result_revision AS TEXT)
                    AND e.session_id=d.scope_id AND t.session_id=d.scope_id
                    AND t.origin_store_id=d.origin_store_id
                    THEN tp.cursor
                    WHEN json_extract(d.json,'$.collectionId') IS NULL
                    AND d.fork_provenance_json IS NULL AND op.fork_provenance_json IS NULL
                    AND owner_run.status IN ('completed','failed','cancelled') AND owner_run.is_active=0
                    AND e.kind='tool' AND e.adapter_id IN ('files.write','files.edit') AND e.state='succeeded'
                    AND e.session_id=d.scope_id AND e.origin_store_id=d.origin_store_id
                    AND e.run_id=json_extract(d.json,'$.sourceRunId')
                    AND op.origin_store_id=d.origin_store_id
                    AND json_extract(op.json,'$.state')='saved'
                    AND json_extract(op.json,'$.executionId')=e.id
                    AND json_extract(op.json,'$.snapshot.id')=json_extract(d.json,'$.reference.id')
                    AND json_extract(op.json,'$.name')=json_extract(d.json,'$.relativePath')
                    THEN ep.cursor END AS tool_order,
                  ep.cursor AS producer_order, e.completed_cursor AS completed_order
                FROM extension_record d
                LEFT JOIN extension_record c ON c.extension_id=d.extension_id
                  AND c.scope_kind=d.scope_kind AND c.scope_id=d.scope_id
                  AND c.key=json_extract(d.json,'$.collectionId')
                LEFT JOIN extension_record op ON op.extension_id=d.extension_id
                  AND op.scope_kind=d.scope_kind AND op.scope_id=d.scope_id
                  AND op.key='output-operation/' || json_extract(d.json,'$.sourceExecutionId')
                LEFT JOIN run owner_run ON owner_run.id=json_extract(d.json,'$.sourceRunId')
                  AND owner_run.session_id=d.scope_id AND owner_run.origin_store_id=d.origin_store_id
                LEFT JOIN execution e ON e.id=json_extract(d.json,'$.sourceExecutionId')
                LEFT JOIN execution t ON t.id=json_extract(c.json,'$.source.producerToolExecutionId')
                LEFT JOIN change_event tp ON tp.object_id=t.id AND tp.type='execution.planned'
                  AND tp.scope_session_id=d.scope_id
                LEFT JOIN change_event ep ON ep.object_id=e.id AND ep.type='execution.planned'
                  AND ep.scope_session_id=d.scope_id
                WHERE d.extension_id=? AND d.scope_kind='session' AND d.scope_id=?
                  AND d.key>=? AND d.key<?
              )
              SELECT old.key,old.json FROM deliveries old
              WHERE old.key<? AND NOT EXISTS (
                SELECT 1 FROM deliveries newer
                WHERE old.tool_order IS NOT NULL AND old.producer_order IS NOT NULL
                  AND newer.tool_order IS NOT NULL AND newer.producer_order IS NOT NULL
                  AND newer.run_id=old.run_id AND newer.path=old.path
                  AND (newer.producer_kind=old.producer_kind OR
                    (old.content_hash IS NOT NULL AND newer.content_hash=old.content_hash))
                  AND old.completed_order IS NOT NULL AND newer.tool_order>old.completed_order
                  AND (newer.tool_order>old.tool_order OR
                    (newer.tool_order=old.tool_order AND newer.producer_order>old.producer_order))
              ) ORDER BY old.key DESC LIMIT ?`,
    'builtin.files',
    sessionId,
    prefix,
    `${prefix}\uffff`,
    beforeKey,
    limit,
  );
}
