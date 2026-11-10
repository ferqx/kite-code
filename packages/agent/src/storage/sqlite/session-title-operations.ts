import {
  type AutomaticTitleAttempt,
  automaticTitleIdentity,
  automaticTitleRecord,
  titleDigest,
} from '../../business/session-title/state';
import { fallbackSessionTitle } from '../../business/session-title/title';
import { canonicalJson } from '../../json';
import type { Store } from '../port';
import { AgentError, type Json } from '../types';
import type { SqliteOperations } from './operations';
import { readTitleClaim, titleHash } from './session-title-proof';

/** Shared write inside the caller's metadata transaction; events retain their caller's order. */
export function writeAutomaticTitleMetadata(
  db: SqliteOperations,
  input: {
    expectedStoreId: string;
    sessionId: string;
    subjectId: string;
    commandId: string;
    operationKey: string;
    title: string;
  },
) {
  db.run('UPDATE session SET title=? WHERE id=?', input.title, input.sessionId);
  db.allocateSessionSequence(input.sessionId);
  const session = db.session(db.row('SELECT * FROM session WHERE id=?', input.sessionId)!);
  const request: Json = {
    kind: 'session.rename',
    ifRevision: session.controlRevision,
    title: input.title,
  };
  const receipt: Json = { outcome: 'renamed', session: session as unknown as Json };
  db.run(
    "INSERT INTO command(id,session_id,seq,kind,subject_id,request_digest,request_json,status,receipt_json,origin_store_id,root_work_command_id,root_work_seq,extension_id,scope_kind,scope_id,operation_key) VALUES(?,?,?,'session.rename',?,?,?,'applied',?,?,?,?,?,'session',?,?)",
    input.commandId,
    input.sessionId,
    session.nextSeq,
    input.subjectId,
    titleHash(request),
    canonicalJson(request),
    canonicalJson(receipt),
    input.expectedStoreId,
    input.commandId,
    session.nextSeq,
    automaticTitleRecord.extensionId,
    input.sessionId,
    input.operationKey,
  );
  return session;
}

/** Host-only first-input metadata transaction; never acquires execution authority. */
export function claimAutomaticSessionTitle(
  db: SqliteOperations,
  input: Parameters<Store['claimAutomaticSessionTitle']>[0],
) {
  return db.tx(() => {
    db.identity(input.expectedStoreId);
    const session = db.row('SELECT * FROM session WHERE id=?', input.sessionId);
    if (!session) throw new AgentError('session_not_found');
    if (session.parent_id !== null || session.delete_requested) return null;
    const source = db.row('SELECT * FROM command WHERE id=?', input.sourceCommandId);
    if (
      !source ||
      source.session_id !== input.sessionId ||
      source.origin_store_id !== input.expectedStoreId ||
      source.subject_id !== input.subjectId ||
      !['run.start', 'input.follow_up'].includes(String(source.kind))
    )
      throw new AgentError('session_title_source_invalid');
    const request = JSON.parse(String(source.request_json)) as Record<string, Json>;
    if (typeof request.content !== 'string' || titleHash(request) !== source.request_digest)
      throw new AgentError('session_title_source_invalid');
    const creator = db.row(
      "SELECT subject_id FROM command WHERE session_id=? AND kind='session.create'",
      input.sessionId,
    );
    if (creator?.subject_id !== input.subjectId) throw new AgentError('permission_denied');
    const identity = automaticTitleIdentity(
      input.expectedStoreId,
      input.sessionId,
      input.sourceCommandId,
    );
    const scope = {
      extensionId: automaticTitleRecord.extensionId,
      sessionId: input.sessionId,
      key: automaticTitleRecord.key,
    };
    const prior = db.call('getExtensionRecord', [scope]) as Awaited<
      ReturnType<Store['getExtensionRecord']>
    >;
    if (prior) {
      const claim = readTitleClaim(db, input);
      return claim
        ? {
            record: claim.record,
            command: db.command(claim.fallback),
            session: db.session(claim.session),
          }
        : null;
    }
    if (db.row('SELECT id FROM command WHERE id=?', identity.fallbackCommandId))
      throw new AgentError('command_conflict');
    // No adoption of legacy history, an existing Run, a later input or an explicit name.
    if (
      source.cancelled ||
      !['accepted', 'applied'].includes(String(source.status)) ||
      session.title !== '' ||
      db.row('SELECT id FROM run WHERE session_id=? LIMIT 1', input.sessionId) ||
      db.row('SELECT id FROM message WHERE session_id=? LIMIT 1', input.sessionId) ||
      db.row(
        "SELECT key FROM extension_record WHERE extension_id=? AND scope_kind='session' AND scope_id=? AND key='automatic-title'",
        automaticTitleRecord.extensionId,
        input.sessionId,
      ) ||
      db.row(
        "SELECT id FROM command WHERE session_id=? AND kind='session.rename' LIMIT 1",
        input.sessionId,
      ) ||
      db.row(
        "SELECT id FROM command WHERE session_id=? AND kind IN('run.start','input.follow_up') ORDER BY seq LIMIT 1",
        input.sessionId,
      )?.id !== source.id
    )
      return null;
    const title = fallbackSessionTitle(request.content);
    const attempt: AutomaticTitleAttempt = {
      sourceCommandId: input.sourceCommandId,
      fallbackDigest: titleDigest(title),
      manualRenameCommandId: null,
      jobExecutionId: null,
      sourceRunId: null,
      modelExecutionId: null,
      publication: 'pending',
      publicationCommandId: null,
      closedReason: null,
    };
    const current = writeAutomaticTitleMetadata(db, {
      ...input,
      commandId: identity.fallbackCommandId,
      operationKey: `fallback/${identity.operationKey.slice(9)}`,
      title,
    });
    db.run(
      "INSERT INTO extension_record(extension_id,scope_kind,scope_id,key,revision,content_type,content_version,origin_store_id,json) VALUES(?,'session',?,?,1,?,1,?,?)",
      automaticTitleRecord.extensionId,
      input.sessionId,
      automaticTitleRecord.key,
      automaticTitleRecord.contentType,
      input.expectedStoreId,
      canonicalJson(attempt as unknown as Json),
    );
    db.event(input.sessionId, input.sessionId, 'session.renamed', {
      controlRevision: current.controlRevision,
    });
    db.event(
      input.sessionId,
      `${automaticTitleRecord.extensionId}/${automaticTitleRecord.key}`,
      'extension.record_updated',
    );
    return {
      record: db.call('getExtensionRecord', [scope]) as NonNullable<typeof prior>,
      command: db.command(db.row('SELECT * FROM command WHERE id=?', identity.fallbackCommandId)!),
      session: current,
    };
  });
}
