import { createHash } from 'node:crypto';
import { canonicalJson } from '../../json';
import type {
  OutputCollection,
  OutputFileRecord,
  OutputFileSummary,
  OutputFilesPage,
  OutputScope,
} from '../../output-files';
import { outputCollectionLimits } from '../../output-files';
import type { Store } from '../port';
import { AgentError, type Json } from '../types';
import { artifactReferenceInTransaction, assertArtifactSessionScope } from './artifact-operations';
import { forkSourceProjection } from './fork-readonly-sources';
import type { SqliteOperations } from './operations';

const namespace = 'builtin.files';
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const json = (value: unknown) => canonicalJson(value as Json);
const seq = (value: string) => {
  if (!/^[0-9]+$/.test(value) || BigInt(value) > 9223372036854775807n)
    throw new AgentError('output_source_invalid');
  return BigInt(value).toString().padStart(20, '0');
};
function scope(db: SqliteOperations, input: OutputScope) {
  db.identity(input.expectedStoreId);
  try {
    assertArtifactSessionScope(db, input);
  } catch (error) {
    if (error instanceof AgentError && error.code === 'artifact_scope_denied')
      throw new AgentError('output_scope_denied');
    throw error;
  }
}
function get(db: SqliteOperations, sessionId: string, key: string) {
  return db.row(
    "SELECT * FROM extension_record WHERE extension_id=? AND scope_kind='session' AND scope_id=? AND key=?",
    namespace,
    sessionId,
    key,
  );
}
function readCollection(
  db: SqliteOperations,
  sessionId: string,
  id: string,
): OutputCollection | null {
  if (!/^collection\/[0-9]{20}\/[A-Za-z0-9_.:-]+$/.test(id))
    throw new AgentError('output_collection_invalid');
  const row = get(db, sessionId, id);
  if (!row) return null;
  if (row.fork_provenance_json) throw new AgentError('output_collection_inherited');
  return { ...JSON.parse(String(row.json)), revision: String(row.revision) };
}
function write(
  db: SqliteOperations,
  sessionId: string,
  key: string,
  type: string,
  value: unknown,
  storeId: string,
) {
  const prior = get(db, sessionId, key);
  const revision = prior ? BigInt(prior.revision!) + 1n : 1n;
  db.run(
    "INSERT INTO extension_record(extension_id,scope_kind,scope_id,key,revision,content_type,content_version,origin_store_id,json) VALUES(?,'session',?,?,?,?,1,?,?) ON CONFLICT(extension_id,scope_kind,scope_id,key) DO UPDATE SET revision=excluded.revision,json=excluded.json",
    namespace,
    sessionId,
    key,
    revision,
    type,
    storeId,
    json(value),
  );
  db.event(sessionId, `${namespace}/${key}`, 'extension.record_updated');
  return String(revision);
}
function save(db: SqliteOperations, value: OutputCollection) {
  value.revision = write(
    db,
    value.source.sessionId,
    value.key,
    'builtin.files.collection',
    value,
    value.source.storeId,
  );
  return value;
}
function start(db: SqliteOperations, c: OutputCollection) {
  c.startCommandId = `output-collect-${hash([c.source.storeId, c.id, c.attempt])}`;
  const request = {
    kind: 'extension.invoke',
    extensionId: namespace,
    actionId: 'collect-outputs',
    definitionVersion: '1',
    input: { collectionId: c.id, attempt: c.attempt },
  };
  db.insertCommand(
    {
      expectedStoreId: c.source.storeId,
      commandId: c.startCommandId,
      sessionId: c.source.sessionId,
      subjectId: c.source.subjectId,
    },
    request as Json,
    createHash('sha256').update(json(request)).digest('hex'),
    'accepted',
    { commandId: c.startCommandId },
  );
  db.event(c.source.sessionId, c.startCommandId, 'command.accepted');
}
export function registerOutputCollectionAtTerminal(db: SqliteOperations, executionId: string) {
  const e = db.row('SELECT * FROM execution WHERE id=?', executionId);
  if (e?.kind !== 'job') return;
  if (settleUndispatchedCollector(db, e)) return;
  if (
    e.adapter_id === 'builtin.files/collect-outputs' &&
    ['failed', 'cancelled'].includes(String(e.state))
  ) {
    const collection = outputCollectionActionEffect(db, e);
    if (
      collection?.state === 'pending' &&
      collection.collectorExecutionId === null &&
      !db.row(
        "SELECT id FROM execution WHERE parent_execution_id=? AND adapter_id='builtin.files/collect'",
        e.id!,
      )
    ) {
      collection.state = 'failed';
      collection.errorCode =
        e.state === 'cancelled' ? 'output_collection_cancelled' : 'output_collection_start_failed';
      collection.retryUntil = new Date(Date.now() + 7 * 86400000).toISOString();
      save(db, collection);
    }
    return;
  }
  // Exact allocation key is attached before process launch, never accepted from stdout.
  const mapping = get(db, String(e.session_id), `allocation/${executionId}`);
  if (!mapping) return;
  const c = readCollection(db, String(e.session_id), JSON.parse(String(mapping.json)).collectionId);
  if (c?.state !== 'allocated') return;
  if (e.origin_store_id !== c.source.storeId) throw new AgentError('output_source_invalid');
  c.source.producerResultRevision = String(e.result_revision);
  if (e.state === 'succeeded') {
    c.state = 'pending';
    start(db, c);
  } else {
    c.state = 'failed';
    c.errorCode = e.state === 'outcome_unknown' ? 'producer_stop_unknown' : 'producer_failed';
    c.retryUntil = null;
  }
  save(db, c);
}
export function outputCollectionOperation(
  db: SqliteOperations,
  method: string,
  raw: unknown,
): unknown {
  // Private Store dispatch has already selected one method; use its combined host-only shape.
  const input = raw as Parameters<Store['allocateOutputCollection']>[0] &
    Parameters<Store['mutateOutputCollection']>[0] &
    Parameters<Store['queryOutputFiles']>[0] &
    Parameters<Store['resolveOutputFile']>[0] &
    Parameters<Store['retryOutputCollection']>[0] &
    Parameters<Store['getOutputCollectorAuthorization']>[0];
  const work = () => {
    scope(db, input);
    if (method === 'allocateOutputCollection') {
      db.owner(input.owner, input.sessionId);
      const e = db.row(
        'SELECT e.*,c.subject_id FROM execution e JOIN command c ON c.id=e.origin_command_id WHERE e.id=?',
        input.producerExecutionId,
      );
      if (
        e?.kind !== 'job' ||
        e.adapter_id !== 'shell.command' ||
        e.session_id !== input.sessionId ||
        e.origin_store_id !== input.expectedStoreId ||
        e.subject_id !== input.subjectId ||
        !['dispatching', 'running'].includes(String(e.state))
      )
        throw new AgentError('output_producer_invalid');
      let ancestor = e;
      let toolId = '';
      const visited = new Set<string>();
      while (ancestor.run_id === null) {
        if (!ancestor.parent_execution_id || visited.size >= 32 || visited.has(String(ancestor.id)))
          throw new AgentError('output_source_invalid');
        visited.add(String(ancestor.id));
        const parent = db.row('SELECT * FROM execution WHERE id=?', ancestor.parent_execution_id);
        if (
          !parent ||
          parent.session_id !== e.session_id ||
          parent.root_work_command_id !== e.root_work_command_id ||
          parent.root_work_seq !== e.root_work_seq ||
          parent.origin_store_id !== e.origin_store_id
        )
          throw new AgentError('output_source_invalid');
        ancestor = parent;
        if (parent.kind === 'tool') toolId = String(parent.id);
      }
      const run = db.row(
        'SELECT r.*,c.seq AS origin_seq FROM run r JOIN command c ON c.id=r.origin_command_id WHERE r.id=?',
        ancestor.run_id!,
      );
      if (!run || run.session_id !== e.session_id || run.origin_store_id !== e.origin_store_id)
        throw new AgentError('output_source_invalid');
      const key = `collection/${seq(String(run.origin_seq))}/${e.id}`;
      const prior = readCollection(db, input.sessionId, key);
      if (prior) {
        if (
          json(prior.allocation.identity) !== json(input.identity) ||
          json(prior.allocation.outputIdentity) !== json(input.outputIdentity)
        )
          throw new AgentError('output_allocation_conflict');
        return prior;
      }
      const c: OutputCollection = {
        id: key,
        key,
        revision: '0',
        source: {
          storeId: input.expectedStoreId,
          sessionId: input.sessionId,
          subjectId: input.subjectId,
          runId: String(run.id),
          runOriginSeq: String(run.origin_seq),
          producerExecutionId: String(e.id),
          producerToolExecutionId: toolId || String(ancestor.id),
          producerResultRevision: null,
        },
        allocation: {
          identity: input.identity,
          outputIdentity: input.outputIdentity,
          outputRelativePath: 'out',
        },
        state: 'allocated',
        attempt: 1,
        startCommandId: null,
        collectorExecutionId: null,
        expectedFiles: null,
        publishedCount: 0,
        errorCode: null,
        errors: [],
        retryUntil: null,
      };
      write(
        db,
        input.sessionId,
        `allocation/${e.id}`,
        'builtin.files.allocation',
        { collectionId: key },
        input.expectedStoreId,
      );
      return save(db, c);
    }
    if (method === 'getOutputCollectorAuthorization') {
      const e = db.row('SELECT * FROM execution WHERE id=?', input.executionId);
      if (
        !e ||
        e.session_id !== input.sessionId ||
        e.origin_store_id !== input.expectedStoreId ||
        !['planned', 'dispatching', 'running'].includes(String(e.state)) ||
        e.cancel_requested
      )
        return null;
      const c = outputCollectorEffect(db, e);
      if (
        !c ||
        c.source.subjectId !== input.subjectId ||
        !currentCollectorAttempt(c, e) ||
        json(input.input) !== json(JSON.parse(String(e.intent_json)))
      )
        return null;
      return {
        revision: hash([
          c.source,
          c.id,
          c.revision,
          c.attempt,
          c.startCommandId,
          e.id,
          e.origin_command_id,
          e.parent_execution_id,
          e.intent_json,
          e.decision_source_json,
          e.root_work_command_id,
          String(e.root_work_seq),
        ]),
      };
    }
    if (method === 'getOutputCollection')
      return readCollection(db, input.sessionId, input.collectionId);
    if (method === 'retryOutputCollection') {
      const c = readCollection(db, input.sessionId, input.collectionId);
      if (!c || c.revision !== input.expectedRevision)
        throw new AgentError('record_revision_conflict');
      if (c.state !== 'failed' || !c.retryUntil || Date.parse(c.retryUntil) < Date.now())
        throw new AgentError('output_retry_unavailable');
      if (c.collectorExecutionId) {
        const prior = db.row('SELECT state FROM execution WHERE id=?', c.collectorExecutionId);
        if (prior && !['failed', 'succeeded', 'cancelled'].includes(String(prior.state)))
          throw new AgentError('output_collector_unsettled');
      }
      c.attempt++;
      c.state = 'pending';
      c.collectorExecutionId = null;
      c.errorCode = null;
      c.errors = [];
      delete c.cleanupAfter;
      start(db, c);
      return save(db, c);
    }
    if (method === 'mutateOutputCollection') {
      db.owner(input.owner, input.sessionId);
      const m = input.mutation;
      const c = readCollection(db, input.sessionId, m.collectionId);
      if (!c || c.source.storeId !== input.expectedStoreId)
        throw new AgentError('output_collection_invalid');
      const e = db.row('SELECT * FROM execution WHERE id=?', input.collectorExecutionId);
      const command = e && db.row('SELECT * FROM command WHERE id=?', e.origin_command_id!);
      const parent = e?.parent_execution_id
        ? db.row('SELECT * FROM execution WHERE id=?', e.parent_execution_id)
        : null;
      const root = parent
        ? db.row('SELECT * FROM command WHERE id=?', parent.origin_command_id!)
        : null;
      const request = root && JSON.parse(String(root.request_json));
      if (
        e?.kind !== 'job' ||
        e.adapter_id !== 'builtin.files/collect' ||
        e.session_id !== input.sessionId ||
        e.origin_store_id !== input.expectedStoreId ||
        !['dispatching', 'running'].includes(String(e.state)) ||
        !command ||
        command.operation_key !== `collect/${c.id}/${c.attempt}` ||
        root?.id !== c.startCommandId ||
        request?.extensionId !== namespace ||
        request?.actionId !== 'collect-outputs' ||
        request?.input?.collectionId !== c.id ||
        request?.input?.attempt !== c.attempt
      )
        throw new AgentError('output_collector_invalid');
      if (m.kind === 'bind') {
        if (
          c.state !== 'pending' ||
          m.attempt !== c.attempt ||
          (c.collectorExecutionId && c.collectorExecutionId !== e.id)
        )
          throw new AgentError('output_collector_conflict');
        c.collectorExecutionId = String(e.id);
        return save(db, c);
      }
      if (c.collectorExecutionId !== e.id || c.state !== 'pending')
        throw new AgentError('output_collector_conflict');
      if ('expectedRevision' in m && m.expectedRevision !== c.revision)
        throw new AgentError('record_revision_conflict');
      if (m.kind === 'freeze') {
        if (c.expectedFiles !== null) {
          if (json(c.expectedFiles) !== json(m.entries))
            throw new AgentError('output_set_conflict');
          return c;
        }
        const seen = new Set<string>();
        let total = 0n;
        if (m.entries.length > outputCollectionLimits.files)
          throw new AgentError('output_file_limit');
        for (const entry of m.entries) {
          const p = entry.relativePath;
          if (
            typeof p !== 'string' ||
            !p ||
            p.includes('\\') ||
            p.startsWith('/') ||
            p.split('/').some((s: string) => !s || s === '.' || s === '..') ||
            p.split('/').length > outputCollectionLimits.depth ||
            seen.has(p)
          )
            throw new AgentError('output_path_invalid');
          seen.add(p);
          const size = BigInt(entry.sourceIdentity.size);
          if (size < 0n || size > BigInt(outputCollectionLimits.fileBytes))
            throw new AgentError('output_size_limit');
          total += size;
        }
        if (total > BigInt(outputCollectionLimits.batchBytes))
          throw new AgentError('output_batch_limit');
        c.expectedFiles = m.entries;
        return save(db, c);
      }
      if (m.kind === 'commit') {
        if (
          c.expectedFiles?.find((entry) => entry.relativePath === m.relativePath)?.sourceIdentity
            .size !== m.reference.size
        )
          throw new AgentError('output_size_conflict');
        if (!c.expectedFiles?.some((f) => f.relativePath === m.relativePath))
          throw new AgentError('output_file_unexpected');
        const fileId = hash([c.source.storeId, c.source.sessionId, c.id, m.relativePath]);
        const reference = artifactReferenceInTransaction(db, {
          expectedStoreId: input.expectedStoreId,
          sessionId: input.sessionId,
          subjectId: input.subjectId,
          refId: `output-file-${fileId}`,
          scope: { kind: 'session', id: input.sessionId },
        });
        if (!reference || json(reference) !== json(m.reference))
          throw new AgentError('output_reference_invalid');
        const key = `delivery/${seq(c.source.runOriginSeq)}/${c.source.producerExecutionId}/${fileId}`;
        const prior = get(db, input.sessionId, key);
        if (prior) {
          if (json(JSON.parse(String(prior.json)).reference) !== json(reference))
            throw new AgentError('output_file_conflict');
          return c;
        }
        const ref = m.reference;
        const record: OutputFileRecord = {
          fileId,
          collectionId: c.id,
          sourceRunId: c.source.runId,
          sourceExecutionId: c.source.producerExecutionId,
          name: m.relativePath.split('/').at(-1)!,
          relativePath: m.relativePath,
          mediaType: ref.mediaType,
          size: ref.size,
          reference: ref,
          publishedAt: new Date().toISOString(),
        };
        write(db, input.sessionId, key, 'builtin.files.delivery', record, input.expectedStoreId);
        c.publishedCount++;
        return save(db, c);
      }
      if (m.kind === 'settle') {
        c.errors = m.errors;
        c.state =
          c.expectedFiles !== null &&
          c.publishedCount === c.expectedFiles.length &&
          m.errors.length === 0
            ? 'ready'
            : 'failed';
        c.errorCode =
          c.state === 'failed' ? (m.errors[0]?.code ?? 'output_collection_incomplete') : null;
        c.retryUntil =
          c.state === 'failed' ? new Date(Date.now() + 7 * 86400000).toISOString() : null;
        return save(db, c);
      }
    }
    if (method === 'resolveOutputFile') {
      const t = input.target;
      if (t.locator?.kind === 'legacy-inherited') {
        if (t.storeId !== input.expectedStoreId || t.sessionId !== input.sessionId)
          throw new AgentError('output_target_invalid');
        const legacy = legacyInherited(db, input, t.locator.key);
        if (!legacy || legacy.fileId !== t.fileId) throw new AgentError('output_target_invalid');
        return legacy;
      }
      if (t.locator?.kind === 'legacy-operation') {
        if (t.storeId !== input.expectedStoreId || t.sessionId !== input.sessionId)
          throw new AgentError('output_target_invalid');
        const legacy = legacyOutput(db, input, t.locator.executionId);
        if (!legacy || legacy.fileId !== t.fileId) throw new AgentError('output_target_invalid');
        return legacy;
      }
      if (
        t.storeId !== input.expectedStoreId ||
        t.sessionId !== input.sessionId ||
        t.locator.kind !== 'delivery' ||
        !/^delivery\/[0-9]{20}\/[A-Za-z0-9_.:-]+\/[a-f0-9]{64}$/.test(t.locator.key)
      )
        throw new AgentError('output_target_invalid');
      const row = get(db, input.sessionId, t.locator.key);
      if (!row) throw new AgentError('output_file_not_found');
      const record = JSON.parse(String(row.json)) as OutputFileRecord;
      if (record.fileId !== t.fileId) throw new AgentError('output_target_invalid');
      if (row.fork_provenance_json) {
        const proof = forkSourceProjection(db, {
          ...input,
          extensionId: namespace,
          localKey: t.locator.key,
        });
        if (
          !proof.proof.sources.some(
            (source) =>
              source.executionId === record.sourceExecutionId &&
              source.artifactRefs.some((ref) => json(ref) === json(record.reference)),
          )
        )
          throw new AgentError('output_reference_invalid');
        return record;
      }
      const reference = artifactReferenceInTransaction(db, {
        expectedStoreId: input.expectedStoreId,
        sessionId: input.sessionId,
        subjectId: input.subjectId,
        refId: record.reference.id,
        scope: record.reference.scope,
      });
      if (!reference || json(reference) !== json(record.reference))
        throw new AgentError('output_reference_invalid');
      return record;
    }
    if (method === 'queryOutputFiles') {
      let suffix = '';
      if (input.runId) {
        const run = db.row(
          'SELECT r.*,c.seq AS origin_seq FROM run r JOIN command c ON c.id=r.origin_command_id WHERE r.id=? AND r.session_id=?',
          input.runId,
          input.sessionId,
        );
        if (!run) throw new AgentError('output_run_invalid');
        suffix = `${seq(String(run.origin_seq))}/`;
      }
      const prefix = `delivery/${suffix}`;
      const limit = input.limit ?? 50;
      if (!Number.isInteger(limit) || limit < 1 || limit > 50)
        throw new AgentError('output_page_invalid');
      const runLegacyPrefix = `legacy-run/${input.runId}/`;
      const legacyRunPage = !!input.beforeKey?.startsWith('legacy-run/');
      if (
        legacyRunPage &&
        (!input.runId ||
          !input.beforeKey!.startsWith(runLegacyPrefix) ||
          !/^[A-Za-z0-9_.:-]*$/.test(input.beforeKey!.slice(runLegacyPrefix.length)))
      )
        throw new AgentError('output_cursor_invalid');
      const legacyPage = !!input.beforeKey?.startsWith('legacy/');
      if (
        legacyPage &&
        (input.runId ||
          !/^legacy\/(?:output(?:-inherited)?\/[a-f0-9]{64})?$/.test(input.beforeKey!))
      )
        throw new AgentError('output_cursor_invalid');
      if (input.beforeKey && !legacyPage && !legacyRunPage && !input.beforeKey.startsWith(prefix))
        throw new AgentError('output_cursor_invalid');
      if (
        input.beforeKey &&
        !legacyPage &&
        !legacyRunPage &&
        !get(db, input.sessionId, input.beforeKey)
      )
        throw new AgentError('output_cursor_invalid');
      const rows =
        legacyPage || legacyRunPage
          ? []
          : db.rows(
              "SELECT key,json FROM extension_record WHERE extension_id=? AND scope_kind='session' AND scope_id=? AND key>=? AND key<? AND key<? ORDER BY key DESC LIMIT ?",
              namespace,
              input.sessionId,
              prefix,
              `${prefix}\uffff`,
              input.beforeKey ?? `${prefix}\uffff`,
              limit + 1,
            );
      const items = rows.slice(0, limit).map((row) => {
        const r = JSON.parse(String(row.json)) as OutputFileRecord;
        return {
          storeId: input.expectedStoreId,
          sessionId: input.sessionId,
          fileId: r.fileId,
          locator: { kind: 'delivery' as const, key: String(row.key) },
          ownerRunId: r.sourceRunId,
          name: r.name,
          mediaType: r.mediaType,
          size: r.size,
          publishedAt: r.publishedAt,
        } satisfies OutputFileSummary;
      });
      let nextCursor = rows.length > limit ? String(rows[limit - 1]!.key) : undefined;
      if (input.runId && !nextCursor) {
        const after = legacyRunPage ? input.beforeKey!.slice(runLegacyPrefix.length) : '';
        const executions = db.rows(
          "SELECT e.id FROM execution e WHERE e.session_id=? AND e.run_id=? AND e.id>? AND e.kind='tool' AND e.state='succeeded' AND e.adapter_id IN('files.write','files.edit') ORDER BY e.id LIMIT 51",
          input.sessionId,
          input.runId,
          after,
        );
        let last = after;
        for (const execution of executions.slice(0, 50)) {
          if (items.length >= limit) {
            nextCursor = `${runLegacyPrefix}${last}`;
            break;
          }
          last = String(execution.id);
          const r = legacyOutput(db, input, last);
          if (
            !r ||
            get(db, input.sessionId, `${prefix}${r.sourceExecutionId}/${r.fileId}`) ||
            items.some((item) => item.fileId === r.fileId)
          )
            continue;
          (items as OutputFileSummary[]).push({
            storeId: input.expectedStoreId,
            sessionId: input.sessionId,
            fileId: r.fileId,
            locator: { kind: 'legacy-operation', executionId: last },
            ownerRunId: r.sourceRunId,
            name: r.name,
            mediaType: r.mediaType,
            size: r.size,
            publishedAt: r.publishedAt,
          });
        }
        if (!nextCursor && executions.length > 50) nextCursor = `${runLegacyPrefix}${last}`;
      }
      if (!input.runId && !nextCursor) {
        const after = legacyPage ? input.beforeKey!.slice('legacy/'.length) : '';
        const heads = db.rows(
          "SELECT key,json FROM extension_record WHERE extension_id=? AND scope_kind='session' AND scope_id=? AND key>? AND ((key>='output/' AND key<'output0') OR (key>='output-inherited/' AND key<'output-inherited0')) ORDER BY key LIMIT 51",
          namespace,
          input.sessionId,
          after,
        );
        let last = after;
        for (const row of heads.slice(0, 50)) {
          if (items.length >= limit) {
            nextCursor = `legacy/${last}`;
            break;
          }
          last = String(row.key);
          const inherited = String(row.key).startsWith('output-inherited/');
          const v = JSON.parse(String(row.json));
          const r = inherited
            ? legacyInherited(db, input, String(row.key))
            : legacyOutput(db, input, v.executionId);
          if (!r || items.some((item) => item.fileId === r.fileId)) continue;
          if (!inherited) {
            const run = db.row(
              'SELECT c.seq FROM run r JOIN command c ON c.id=r.origin_command_id WHERE r.id=?',
              r.sourceRunId,
            );
            if (
              run &&
              get(
                db,
                input.sessionId,
                `delivery/${seq(String(run.seq))}/${r.sourceExecutionId}/${r.fileId}`,
              )
            )
              continue;
          }
          (items as OutputFileSummary[]).push({
            storeId: input.expectedStoreId,
            sessionId: input.sessionId,
            fileId: r.fileId,
            locator: inherited
              ? { kind: 'legacy-inherited', key: String(row.key) }
              : { kind: 'legacy-operation', executionId: r.sourceExecutionId },
            ownerRunId: r.sourceRunId,
            name: r.name,
            mediaType: r.mediaType,
            size: r.size,
            publishedAt: r.publishedAt,
          });
        }
        if (!nextCursor && heads.length > 50) nextCursor = `legacy/${last}`;
      }
      const cp = `collection/${suffix}`;
      if (
        input.collectionBeforeKey &&
        (!input.collectionBeforeKey.startsWith(cp) ||
          !get(db, input.sessionId, input.collectionBeforeKey))
      )
        throw new AgentError('output_cursor_invalid');
      const collectionRows = db.rows(
        "SELECT key,json,revision FROM extension_record WHERE extension_id=? AND scope_kind='session' AND scope_id=? AND key>=? AND key<? AND key<? AND json_extract(json,'$.state')<>'allocated' AND (json_extract(json,'$.errorCode') IS NOT NULL OR json_array_length(json_extract(json,'$.expectedFiles'))>0) ORDER BY key DESC LIMIT 51",
        namespace,
        input.sessionId,
        cp,
        `${cp}\uffff`,
        input.collectionBeforeKey ?? `${cp}\uffff`,
      );
      const collections = collectionRows.slice(0, 50).flatMap((row) => {
        const c = JSON.parse(String(row.json)) as OutputCollection;
        return c.state === 'allocated' || (!c.errorCode && !c.expectedFiles?.length)
          ? []
          : [
              {
                collectionId: c.id,
                revision: String(row.revision),
                ownerRunId: c.source.runId,
                state: c.state,
                expectedCount: c.expectedFiles?.length ?? null,
                publishedCount: c.publishedCount,
                ...(c.errorCode
                  ? {
                      errorCode:
                        c.retryUntil && Date.parse(c.retryUntil) <= Date.now()
                          ? 'output_staging_expired'
                          : c.errorCode,
                    }
                  : {}),
                ...(c.retryUntil ? { retryUntil: c.retryUntil } : {}),
              },
            ];
      });
      return {
        scope: { storeId: input.expectedStoreId, sessionId: input.sessionId },
        revision: db.metadata().lastChangeCursor,
        items,
        collections,
        ...(nextCursor ? { nextCursor } : {}),
        ...(collectionRows.length > 50
          ? { nextCollectionCursor: String(collectionRows[49]!.key) }
          : {}),
      } satisfies OutputFilesPage;
    }
    throw new AgentError('output_operation_invalid');
  };
  if (
    [
      'queryOutputFiles',
      'resolveOutputFile',
      'getOutputCollection',
      'getOutputCollectorAuthorization',
    ].includes(method)
  ) {
    db.db.run('BEGIN');
    try {
      const result = work();
      db.db.run('COMMIT');
      return result;
    } catch (error) {
      return db.rollback(error);
    }
  }
  return db.tx(work);
}

/** Full original command/operation/allocation proof, not a Job-name exemption. */
export function outputCollectorEffect(
  db: SqliteOperations,
  e: Record<string, string | number | bigint | null>,
): OutputCollection | null {
  if (
    e.kind !== 'job' ||
    e.adapter_id !== 'builtin.files/collect' ||
    e.definition_version !== '1' ||
    e.run_id !== null ||
    e.cancel_with_parent ||
    e.child_session_id !== null ||
    e.requirements_json !== '[]'
  )
    return null;
  const operation = db.row('SELECT * FROM command WHERE id=?', e.origin_command_id!);
  const action = e.parent_execution_id
    ? db.row('SELECT * FROM execution WHERE id=?', e.parent_execution_id)
    : null;
  const command = action
    ? db.row('SELECT * FROM command WHERE id=?', action.origin_command_id!)
    : null;
  if (
    !operation ||
    !action ||
    !command ||
    action.adapter_id !== 'builtin.files/collect-outputs' ||
    action.kind !== 'job' ||
    action.definition_version !== '1' ||
    action.parent_execution_id !== null ||
    !outputCollectionActionEffect(db, action) ||
    command.kind !== 'extension.invoke' ||
    operation.kind !== 'operation.job' ||
    operation.extension_id !== namespace ||
    operation.scope_id !== e.session_id ||
    operation.scope_kind !== 'session' ||
    operation.status !== 'applied'
  )
    return null;
  const request = JSON.parse(String(command.request_json));
  if (
    request.extensionId !== namespace ||
    request.actionId !== 'collect-outputs' ||
    request.definitionVersion !== '1' ||
    typeof request.input?.collectionId !== 'string' ||
    !Number.isSafeInteger(request.input.attempt) ||
    request.input.attempt < 1
  )
    return null;
  let c: OutputCollection | null;
  try {
    c = readCollection(db, String(e.session_id), request.input.collectionId);
  } catch {
    return null;
  }
  if (!c) return null;
  const operationRequest = JSON.parse(String(operation.request_json));
  if (
    json(JSON.parse(String(e.intent_json))) !== json(request.input) ||
    json(JSON.parse(String(e.decision_source_json))) !==
      json(JSON.parse(String(action.decision_source_json))) ||
    json(operationRequest) !==
      json({
        kind: 'operation.job',
        extensionId: namespace,
        operationKey: `collect/${c.id}/${request.input.attempt}`,
        parentExecutionId: action.id,
        cancellation: 'detached',
        definitionId: 'builtin.files/collect',
        definitionVersion: '1',
        input: request.input,
      })
  )
    return null;
  if (
    command.id !== `output-collect-${hash([c.source.storeId, c.id, request.input.attempt])}` ||
    operation.operation_key !== `collect/${c.id}/${request.input.attempt}` ||
    [e, action, operation, command].some(
      (row) => row.origin_store_id !== c!.source.storeId || row.session_id !== c!.source.sessionId,
    ) ||
    operation.subject_id !== c.source.subjectId ||
    command.subject_id !== c.source.subjectId ||
    e.root_work_command_id !== command.id ||
    e.root_work_seq !== command.seq ||
    action.root_work_command_id !== command.id ||
    operation.root_work_command_id !== command.id ||
    action.root_work_seq !== command.seq ||
    operation.root_work_seq !== command.seq
  )
    return null;
  const producer = db.row('SELECT * FROM execution WHERE id=?', c.source.producerExecutionId);
  const allocation = get(db, c.source.sessionId, `allocation/${c.source.producerExecutionId}`);
  if (
    producer?.state !== 'succeeded' ||
    String(producer.result_revision) !== c.source.producerResultRevision ||
    producer.origin_store_id !== c.source.storeId ||
    producer.session_id !== c.source.sessionId ||
    !allocation ||
    JSON.parse(String(allocation.json)).collectionId !== c.id
  )
    return null;
  if (
    JSON.parse(String(operation.receipt_json)).executionId !== e.id ||
    JSON.parse(String(command.receipt_json)).executionId !== action.id
  )
    return null;
  return c;
}
/** Historical proofs remain valid, but only the current attempt may authorize or settle. */
function currentCollectorAttempt(
  c: OutputCollection,
  e: Record<string, string | number | bigint | null>,
) {
  const input = JSON.parse(String(e.intent_json));
  return (
    c.state === 'pending' &&
    c.attempt === input.attempt &&
    c.id === input.collectionId &&
    c.startCommandId === e.root_work_command_id &&
    (c.collectorExecutionId === null || c.collectorExecutionId === e.id)
  );
}
/** Known zero-adapter failures only: preserve the denial and never schedule replacement work. */
function settleUndispatchedCollector(
  db: SqliteOperations,
  e: Record<string, string | number | bigint | null>,
): boolean {
  if (!['failed', 'cancelled'].includes(String(e.state)) || e.dispatched !== 0n) return false;
  const result = JSON.parse(String(e.result_json));
  if (result?.details?.adapterAttempted !== false) return false;
  const c = outputCollectorEffect(db, e);
  if (!c || !currentCollectorAttempt(c, e)) return false;
  c.collectorExecutionId = String(e.id);
  c.state = 'failed';
  c.errorCode =
    result.details.code === 'permission_denied'
      ? 'output_collection_permission_denied'
      : e.state === 'cancelled'
        ? 'output_collection_cancelled'
        : 'output_collection_start_failed';
  c.errors = [{ code: c.errorCode }];
  // A policy refusal is not a retryable I/O failure. Neither the UI nor the Store
  // may offer a normal retry that repeats this rejected invocation.
  c.cleanupAfter = new Date(Date.now() + 7 * 86400000).toISOString();
  c.retryUntil = result.details.code === 'permission_denied' ? null : c.cleanupAfter;
  save(db, c);
  return true;
}
/** Only invoked after the physical owner lock excludes the former process. */
export function recoverOutputCollections(db: SqliteOperations, rootId: string): void {
  let after = '';
  for (;;) {
    const rows = db.rows(
      "SELECT e.* FROM execution e WHERE e.root_session_id=? AND e.id>? AND e.adapter_id='builtin.files/collect' AND e.state IN('planned','dispatching','running','outcome_unknown','failed','cancelled') ORDER BY e.id LIMIT 50",
      rootId,
      after,
    );
    if (!rows.length) break;
    for (const e of rows) {
      if (['failed', 'cancelled'].includes(String(e.state))) {
        settleUndispatchedCollector(db, e);
        continue;
      }
      const c = outputCollectorEffect(db, e);
      if (!c) continue;
      if (c.collectorExecutionId !== e.id && c.collectorExecutionId !== null) continue;
      // Host-only collector has no external process. Its former owner cannot still publish.
      const cancelled =
        !!e.cancel_requested ||
        !!db.row('SELECT cancelled FROM command WHERE id=?', e.origin_command_id!)?.cancelled;
      db.run(
        "UPDATE execution SET state='cancelled',result_json=?,result_revision=result_revision+1 WHERE id=?",
        json({ outcome: 'cancelled', content: 'output_collector_owner_lost' }),
        e.id!,
      );
      db.event(String(e.session_id), String(e.id), 'execution.completed');
      if (c.state === 'pending') {
        if (cancelled) {
          c.state = 'failed';
          c.errorCode = 'output_collection_cancelled';
          c.retryUntil = new Date(Date.now() + 7 * 86400000).toISOString();
        } else {
          c.attempt++;
          c.collectorExecutionId = null;
          start(db, c);
        }
        save(db, c);
      }
    }
    after = String(rows.at(-1)!.id);
    if (rows.length < 50) break;
  }
  let afterKey = '';
  for (;;) {
    const rows = db.rows(
      "SELECT r.key,r.scope_id,r.json FROM extension_record r JOIN session s ON s.id=r.scope_id WHERE r.extension_id='builtin.files' AND r.scope_kind='session' AND r.content_type='builtin.files.collection' AND r.fork_provenance_json IS NULL AND s.root_id=? AND r.key>? ORDER BY r.key LIMIT 50",
      rootId,
      afterKey,
    );
    for (const row of rows) {
      const c = readCollection(db, String(row.scope_id), String(row.key))!;
      const producer = db.row('SELECT * FROM execution WHERE id=?', c.source.producerExecutionId);
      if (
        c.state === 'allocated' &&
        producer &&
        ['failed', 'cancelled'].includes(String(producer.state))
      ) {
        c.state = 'failed';
        c.errorCode = 'producer_failed';
        save(db, c);
        continue;
      }
      if (
        c.state !== 'pending' ||
        c.collectorExecutionId !== null ||
        !producer ||
        producer.state !== 'succeeded' ||
        String(producer.result_revision) !== c.source.producerResultRevision ||
        producer.session_id !== c.source.sessionId ||
        producer.origin_store_id !== c.source.storeId
      )
        continue;
      const command = db.row('SELECT * FROM command WHERE id=?', c.startCommandId!);
      if (
        !command ||
        command.id !== `output-collect-${hash([c.source.storeId, c.id, c.attempt])}` ||
        command.session_id !== c.source.sessionId ||
        command.subject_id !== c.source.subjectId ||
        command.origin_store_id !== c.source.storeId
      )
        continue;
      if (command.cancelled || command.status === 'rejected') {
        c.state = 'failed';
        c.errorCode = 'output_collection_cancelled';
        c.retryUntil = new Date(Date.now() + 7 * 86400000).toISOString();
        save(db, c);
        continue;
      }
      if (command.status === 'accepted') continue;
      const request = JSON.parse(String(command.request_json));
      if (
        request.extensionId !== namespace ||
        request.actionId !== 'collect-outputs' ||
        request.input?.collectionId !== c.id ||
        request.input?.attempt !== c.attempt
      )
        continue;
      const receipt = JSON.parse(String(command.receipt_json));
      const action = receipt.executionId
        ? db.row('SELECT * FROM execution WHERE id=?', receipt.executionId)
        : null;
      if (
        !action ||
        action.origin_command_id !== command.id ||
        action.adapter_id !== 'builtin.files/collect-outputs' ||
        action.parent_execution_id !== null ||
        action.origin_store_id !== c.source.storeId ||
        action.session_id !== c.source.sessionId ||
        !['planned', 'dispatching', 'running', 'outcome_unknown', 'failed', 'cancelled'].includes(
          String(action.state),
        )
      )
        continue;
      db.run(
        "UPDATE execution SET state='cancelled',result_json=?,result_revision=result_revision+1 WHERE id=?",
        json({ outcome: 'cancelled', content: 'output_action_owner_lost' }),
        action.id!,
      );
      if (
        action.cancel_requested ||
        command.cancelled ||
        ['failed', 'cancelled'].includes(String(action.state))
      ) {
        c.state = 'failed';
        c.errorCode = 'output_collection_cancelled';
        c.retryUntil = new Date(Date.now() + 7 * 86400000).toISOString();
      } else {
        c.attempt++;
        start(db, c);
      }
      save(db, c);
    }
    if (rows.length < 50) break;
    afterKey = String(rows.at(-1)!.key);
  }
}

/** Admit only a published Shell delivery's original session ref to the existing Fork proof. */
export function outputArtifactForExecution(
  db: SqliteOperations,
  sessionId: string,
  executionId: string,
  refId: string,
): boolean {
  if (!/^output-file-[a-f0-9]{64}$/.test(refId)) return false;
  const allocation = get(db, sessionId, `allocation/${executionId}`);
  if (!allocation) return false;
  let c: OutputCollection | null;
  try {
    c = readCollection(db, sessionId, JSON.parse(String(allocation.json)).collectionId);
  } catch {
    return false;
  }
  if (!c || c.source.producerExecutionId !== executionId) return false;
  const row = get(
    db,
    sessionId,
    `delivery/${seq(c.source.runOriginSeq)}/${executionId}/${refId.slice('output-file-'.length)}`,
  );
  if (!row) return false;
  const r = JSON.parse(String(row.json)) as OutputFileRecord;
  return (
    r.reference.id === refId &&
    r.sourceExecutionId === executionId &&
    r.collectionId === c.id &&
    r.reference.scope.kind === 'session' &&
    r.reference.scope.id === sessionId
  );
}

function legacyOutput(
  db: SqliteOperations,
  input: OutputScope,
  executionId: string,
): OutputFileRecord | null {
  const row = get(db, input.sessionId, `output-operation/${executionId}`);
  if (!row || row.fork_provenance_json) return null;
  const value = JSON.parse(String(row.json));
  const e = db.row(
    'SELECT * FROM execution WHERE id=? AND session_id=?',
    executionId,
    input.sessionId,
  );
  if (
    e?.kind !== 'tool' ||
    e.state !== 'succeeded' ||
    !['files.write', 'files.edit'].includes(String(e.adapter_id)) ||
    value.state !== 'saved' ||
    value.executionId !== e.id
  )
    return null;
  const result = JSON.parse(String(e.result_json));
  const ref = value.snapshot;
  if (ref?.scope?.kind !== 'execution' || ref.scope.id !== executionId) return null;
  if (
    !ref ||
    json(result.details?.fileOutput?.snapshot) !== json(ref) ||
    !result.artifactRefs?.some((r: unknown) => json(r) === json(ref))
  )
    return null;
  const actual = artifactReferenceInTransaction(db, { ...input, refId: ref.id, scope: ref.scope });
  if (!actual || json(actual) !== json(ref)) return null;
  const fileId = hash([input.expectedStoreId, input.sessionId, executionId, ref.id]);
  return {
    fileId,
    collectionId: null,
    sourceRunId: String(e.run_id),
    sourceExecutionId: executionId,
    name: value.name,
    relativePath: value.name,
    mediaType: ref.mediaType,
    size: ref.size,
    reference: ref,
    publishedAt: '',
  };
}
export function registerTextOutputAtTerminal(db: SqliteOperations, executionId: string): void {
  const e = db.row(
    'SELECT e.*,c.subject_id FROM execution e JOIN command c ON c.id=e.origin_command_id WHERE e.id=?',
    executionId,
  );
  if (
    e?.kind !== 'tool' ||
    e.state !== 'succeeded' ||
    e.run_id === null ||
    !['files.write', 'files.edit'].includes(String(e.adapter_id))
  )
    return;
  const input = {
    expectedStoreId: String(e.origin_store_id),
    sessionId: String(e.session_id),
    subjectId: String(e.subject_id),
  };
  const r = legacyOutput(db, input, executionId);
  if (!r) return;
  const run = db.row(
    'SELECT c.seq FROM run r JOIN command c ON c.id=r.origin_command_id WHERE r.id=?',
    e.run_id!,
  );
  if (!run) return;
  const key = `delivery/${seq(String(run.seq))}/${executionId}/${r.fileId}`;
  if (!get(db, input.sessionId, key))
    write(
      db,
      input.sessionId,
      key,
      'builtin.files.delivery',
      { ...r, publishedAt: new Date().toISOString() },
      input.expectedStoreId,
    );
}

function legacyInherited(
  db: SqliteOperations,
  input: OutputScope,
  key: string,
): OutputFileRecord | null {
  if (!/^output-inherited\/[a-f0-9]{64}$/.test(key)) throw new AgentError('output_target_invalid');
  const row = get(db, input.sessionId, key);
  if (!row?.fork_provenance_json) return null;
  const value = JSON.parse(String(row.json));
  if (value.state !== 'inherited') return null;
  const proof = forkSourceProjection(db, { ...input, extensionId: namespace, localKey: key });
  const source = proof.proof.sources.find(
    (source) =>
      source.executionId === value.executionId &&
      source.artifactRefs.some((ref) => json(ref) === json(value.snapshot)),
  );
  if (!source) return null;
  const ref = value.snapshot;
  return {
    fileId: hash([input.expectedStoreId, input.sessionId, value.executionId, ref.id]),
    collectionId: null,
    sourceRunId: source.runId ?? '',
    sourceExecutionId: value.executionId,
    name: value.name,
    relativePath: value.name,
    mediaType: ref.mediaType,
    size: ref.size,
    reference: ref,
    publishedAt: '',
  };
}

export function outputCollectionActionEffect(
  db: SqliteOperations,
  e: Record<string, string | number | bigint | null>,
): OutputCollection | null {
  if (
    e.kind !== 'job' ||
    e.adapter_id !== 'builtin.files/collect-outputs' ||
    e.definition_version !== '1' ||
    e.run_id !== null ||
    e.parent_execution_id !== null ||
    e.child_session_id !== null
  )
    return null;
  const command = db.row('SELECT * FROM command WHERE id=?', e.origin_command_id!);
  if (
    command?.kind !== 'extension.invoke' ||
    command.session_id !== e.session_id ||
    command.origin_store_id !== e.origin_store_id ||
    command.root_work_command_id !== command.id ||
    command.root_work_seq !== command.seq ||
    e.root_work_command_id !== command.id ||
    e.root_work_seq !== command.seq
  )
    return null;
  const request = JSON.parse(String(command.request_json));
  if (
    request.extensionId !== namespace ||
    request.actionId !== 'collect-outputs' ||
    request.definitionVersion !== '1' ||
    typeof request.input?.collectionId !== 'string' ||
    !Number.isSafeInteger(request.input.attempt)
  )
    return null;
  let c: OutputCollection | null;
  try {
    c = readCollection(db, String(e.session_id), request.input.collectionId);
  } catch {
    return null;
  }
  if (
    !c ||
    c.source.storeId !== e.origin_store_id ||
    c.source.subjectId !== command.subject_id ||
    command.id !== `output-collect-${hash([c.source.storeId, c.id, request.input.attempt])}` ||
    json(JSON.parse(String(e.intent_json))) !== json(request.input) ||
    JSON.parse(String(command.receipt_json)).executionId !== e.id
  )
    return null;
  const source = JSON.parse(String(e.decision_source_json));
  if (
    source.kind !== 'action_decision' ||
    source.commandId !== command.id ||
    source.extensionId !== namespace ||
    source.actionId !== 'collect-outputs' ||
    source.definitionVersion !== '1' ||
    source.preparedDigest !== createHash('sha256').update(json(request.input)).digest('hex')
  )
    return null;
  const producer = db.row('SELECT * FROM execution WHERE id=?', c.source.producerExecutionId);
  const allocation = get(db, c.source.sessionId, `allocation/${c.source.producerExecutionId}`);
  if (
    producer?.state !== 'succeeded' ||
    producer.origin_store_id !== c.source.storeId ||
    producer.session_id !== c.source.sessionId ||
    String(producer.result_revision) !== c.source.producerResultRevision ||
    !allocation ||
    JSON.parse(String(allocation.json)).collectionId !== c.id
  )
    return null;
  return c;
}

/** Called in the existing command cancellation transaction; never starts replacement work. */
export function cancelOutputCollectionCommand(db: SqliteOperations, commandId: string): void {
  const command = db.row('SELECT * FROM command WHERE id=?', commandId);
  if (command?.kind !== 'extension.invoke') return;
  const request = JSON.parse(String(command.request_json));
  if (
    request.extensionId !== namespace ||
    request.actionId !== 'collect-outputs' ||
    typeof request.input?.collectionId !== 'string'
  )
    return;
  let c: OutputCollection | null;
  try {
    c = readCollection(db, String(command.session_id), request.input.collectionId);
  } catch {
    return;
  }
  if (
    c?.state !== 'pending' ||
    c.collectorExecutionId !== null ||
    c.startCommandId !== command.id ||
    command.id !== `output-collect-${hash([c.source.storeId, c.id, c.attempt])}` ||
    command.origin_store_id !== c.source.storeId ||
    command.subject_id !== c.source.subjectId
  )
    return;
  if (
    db.row(
      "SELECT e.id FROM execution e JOIN execution parent ON parent.id=e.parent_execution_id WHERE parent.origin_command_id=? AND e.adapter_id='builtin.files/collect'",
      commandId,
    )
  )
    return;
  c.state = 'failed';
  c.errorCode = 'output_collection_cancelled';
  c.retryUntil = new Date(Date.now() + 7 * 86400000).toISOString();
  save(db, c);
}
