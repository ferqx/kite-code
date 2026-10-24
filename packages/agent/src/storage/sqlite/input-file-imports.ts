import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { artifactPath } from '../../artifacts-files';
import { inputFileReferences } from '../../input-files';
import { canonicalJson } from '../../json';
import type { InputFileImport, InputFileImportScope } from '../input-file-imports';
import type { Store } from '../port';
import { AgentError, type ArtifactReference, type Json } from '../types';
import { lookupArtifactReference } from './artifact-operations';
import type { SqliteOperations } from './operations';

function scope(ops: SqliteOperations, input: InputFileImportScope, write: boolean) {
  ops.identity(input.expectedStoreId);
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(input.id)) throw new AgentError('input_file_invalid');
  const session = ops.row(
    `SELECT s.delete_requested,c.subject_id FROM session s JOIN command c
     ON c.session_id=s.id AND c.kind='session.create' WHERE s.id=?`,
    input.sessionId,
  );
  if (!session || session.subject_id !== input.subjectId || (write && session.delete_requested))
    throw new AgentError('input_file_scope_denied');
  if (!ops.row("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='input_file_import'"))
    throw new AgentError('input_files_unavailable');
}

function read(ops: SqliteOperations, input: InputFileImportScope): InputFileImport | null {
  const row = ops.row(
    'SELECT * FROM input_file_import WHERE id=? AND session_id=? AND subject_id=?',
    input.id,
    input.sessionId,
    input.subjectId,
  );
  if (!row) return null;
  const reference = JSON.parse(String(row.reference_json)) as ArtifactReference;
  const actual = lookupArtifactReference(ops, {
    ...input,
    refId: reference.id,
    scope: reference.scope,
  });
  if (
    !actual ||
    canonicalJson(actual as unknown as Json) !== canonicalJson(reference as unknown as Json)
  )
    throw new AgentError('input_file_scope_denied');
  return {
    id: String(row.id),
    sessionId: String(row.session_id),
    subjectId: String(row.subject_id),
    originStoreId: String(row.origin_store_id),
    name: String(row.name),
    reference,
    uri: pathToFileURL(artifactPath(dirname(ops.db.filename), actual.hash)).href,
    state: String(row.state) as InputFileImport['state'],
    boundCommandId: row.bound_command_id === null ? null : String(row.bound_command_id),
    createdAt: Number(row.created_at),
  };
}

export function getInputFileImport(
  ops: SqliteOperations,
  input: InputFileImportScope,
): InputFileImport | null {
  // Keep the connection identity, creator and import in the same read snapshot.
  ops.db.run('BEGIN');
  try {
    scope(ops, input, false);
    const result = read(ops, input);
    ops.db.run('COMMIT');
    return result;
  } catch (error) {
    return ops.rollback(error);
  }
}

export function registerInputFileImport(
  ops: SqliteOperations,
  input: Parameters<Store['registerInputFileImport']>[0],
): InputFileImport {
  return ops.tx(() => {
    scope(ops, input, true);
    if (typeof input.name !== 'string' || !input.name || input.name.length > 512)
      throw new AgentError('input_file_invalid');
    const reference = input.reference;
    if (
      !reference ||
      reference.id !== `input-file-${input.id}` ||
      reference.storeId !== input.expectedStoreId ||
      reference.sessionId !== input.sessionId ||
      reference.subjectId !== input.subjectId ||
      reference.scope.kind !== 'session' ||
      reference.scope.id !== input.sessionId
    )
      throw new AgentError('input_file_scope_denied');
    const old = read(ops, input);
    if (old) {
      if (old.state === 'released') throw new AgentError('input_file_released');
      if (
        old.originStoreId !== input.expectedStoreId ||
        old.name !== input.name ||
        canonicalJson(old.reference as unknown as Json) !==
          canonicalJson(reference as unknown as Json)
      )
        throw new AgentError('input_file_import_conflict');
    }
    const registered = lookupArtifactReference(ops, {
      ...input,
      refId: reference.id,
      scope: reference.scope,
    });
    if (
      !registered ||
      canonicalJson(registered as unknown as Json) !== canonicalJson(reference as unknown as Json)
    )
      throw new AgentError('input_file_scope_denied');
    if (old) return old;
    if (ops.row('SELECT 1 FROM input_file_import WHERE id=?', input.id))
      throw new AgentError('input_file_import_conflict');
    ops.run(
      `INSERT INTO input_file_import(id,session_id,subject_id,origin_store_id,name,reference_id,
       reference_json,state,bound_command_id,created_at) VALUES(?,?,?,?,?,?,?,'prepared',NULL,?)`,
      input.id,
      input.sessionId,
      input.subjectId,
      input.expectedStoreId,
      input.name,
      reference.id,
      canonicalJson(reference as unknown as Json),
      Date.now(),
    );
    ops.event(input.sessionId, input.id, 'input_file.prepared');
    return read(ops, input)!;
  });
}

export function releaseInputFileImport(
  ops: SqliteOperations,
  input: InputFileImportScope,
): InputFileImport {
  return ops.tx(() => {
    scope(ops, input, true);
    const file = read(ops, input);
    if (!file) throw new AgentError('input_file_not_found');
    if (file.originStoreId !== input.expectedStoreId)
      throw new AgentError('input_file_scope_denied');
    if (file.state === 'bound') throw new AgentError('input_file_already_bound');
    if (file.state === 'released') return file;
    // Binding and release serialize through the same Store transaction. Keep a tombstone
    // so a lost release reply cannot allow the same import ID to be used again.
    ops.run("UPDATE input_file_import SET state='released' WHERE id=?", file.id);
    // Other Artifact consumers can hold this reference. Release revokes admission;
    // physical reclamation belongs to history GC, which proves all dependencies dead.
    ops.event(input.sessionId, input.id, 'input_file.released');
    return read(ops, input)!;
  });
}

/** Runs inside the original command admission/insert transaction, never a second bind command. */
export function admitInputFiles(
  ops: SqliteOperations,
  input: InputFileImportScope | { expectedStoreId: string; sessionId: string; subjectId: string },
  files: unknown,
  commandId?: string,
): void {
  for (const file of inputFileReferences(files)) {
    if (!file.reference) continue;
    const target = { ...input, id: file.reference.id.slice('input-file-'.length) };
    scope(ops, target, true);
    const imported = read(ops, target);
    if (
      !imported ||
      imported.originStoreId !== input.expectedStoreId ||
      imported.state === 'released' ||
      imported.name !== file.name ||
      canonicalJson(imported.reference as unknown as Json) !==
        canonicalJson(file.reference as unknown as Json)
    )
      throw new AgentError('input_file_scope_denied');
    const actual = lookupArtifactReference(ops, {
      ...input,
      refId: file.reference.id,
      scope: file.reference.scope,
    });
    if (
      !actual ||
      canonicalJson(actual as unknown as Json) !== canonicalJson(file.reference as unknown as Json)
    )
      throw new AgentError('input_file_scope_denied');
    if (commandId && imported.state === 'prepared') {
      ops.run(
        "UPDATE input_file_import SET state='bound',bound_command_id=? WHERE id=? AND state='prepared'",
        commandId,
        imported.id,
      );
      ops.event(input.sessionId, imported.id, 'input_file.bound');
    }
  }
}
