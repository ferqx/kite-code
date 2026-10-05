import { canonicalJson } from '../../json';
import type { Store } from '../port';
import { AgentError, type ExtensionRecord, type Json } from '../types';
import type { SqliteOperations } from './operations';

/** Metadata only, before the first execution. The actual Run manifest fixes its namespace. */
export function initializeRunRecord(
  db: SqliteOperations,
  input: Parameters<Store['initializeRunRecord']>[0],
): ExtensionRecord {
  return db.tx(() => {
    db.identity(input.expectedStoreId);
    const run = db.row('SELECT * FROM run WHERE id=?', input.runId);
    if (!run) throw new AgentError('run_not_found');
    db.active(input.owner, String(run.origin_command_id), input.runId);
    if (run.origin_store_id !== input.expectedStoreId)
      throw new AgentError('operation_unverifiable');
    if (db.row('SELECT id FROM execution WHERE run_id=? LIMIT 1', input.runId))
      throw new AgentError('run_initialization_closed');
    const configuration = JSON.parse(String(run.config_json)) as {
      extensions?: { id: string; version: string }[];
    };
    if (!configuration.extensions?.some((extension) => extension.id === input.extensionId))
      throw new AgentError('extension_namespace_mismatch');
    const value = input.write;
    const prefix = `run/${input.runId}/`;
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      Object.keys(value).some(
        (key) => !['key', 'contentType', 'contentVersion', 'value'].includes(key),
      ) ||
      typeof value.key !== 'string' ||
      !value.key.startsWith(prefix) ||
      value.key.length <= prefix.length ||
      value.key.length > 256 ||
      typeof value.contentType !== 'string' ||
      value.contentType.length < 1 ||
      value.contentType.length > 256 ||
      !Number.isSafeInteger(value.contentVersion) ||
      value.contentVersion < 1 ||
      Buffer.byteLength(canonicalJson(value.value)) > 32 * 1024
    )
      throw new AgentError('invalid_extension_record');
    const original = db.row(
      "SELECT * FROM extension_record WHERE extension_id=? AND scope_kind='session' AND scope_id=? AND key=?",
      input.extensionId,
      run.session_id!,
      value.key,
    );
    if (original) {
      if (
        original.origin_store_id !== input.expectedStoreId ||
        original.content_type !== value.contentType ||
        Number(original.content_version) !== value.contentVersion ||
        original.json !== canonicalJson(value.value)
      )
        throw new AgentError('record_revision_conflict');
    } else {
      const count = db.row(
        "SELECT count(*) AS n FROM extension_record WHERE scope_kind='session' AND scope_id=? AND substr(key,1,?)=?",
        run.session_id!,
        prefix.length,
        prefix,
      );
      if (BigInt(count!.n!) >= 64n) throw new AgentError('requirement_limit');
      db.run(
        "INSERT INTO extension_record(extension_id,scope_kind,scope_id,key,revision,content_type,content_version,origin_store_id,json) VALUES(?,'session',?,?,1,?,?,?,?)",
        input.extensionId,
        run.session_id!,
        value.key,
        value.contentType,
        value.contentVersion,
        input.expectedStoreId,
        canonicalJson(value.value),
      );
      db.event(
        String(run.session_id),
        `${input.extensionId}/${value.key}`,
        'extension.record_updated',
      );
    }
    return {
      extensionId: input.extensionId,
      sessionId: String(run.session_id),
      key: value.key,
      revision: original ? String(original.revision) : '1',
      contentType: value.contentType,
      contentVersion: value.contentVersion,
      originStoreId: input.expectedStoreId,
      forkProvenance: original?.fork_provenance_json
        ? (JSON.parse(String(original.fork_provenance_json)) as Json)
        : null,
      value: JSON.parse(canonicalJson(value.value)) as Json,
    };
  });
}
