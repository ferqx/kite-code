import { canonicalJson } from '../../json';
import type { Store } from '../port';
import { AgentError } from '../types';
import type { SqliteOperations } from './operations';

/** Historical qualification only: not delivery to the current route, nor current authority. */
export function readHistoricallyConfirmedImageMembers(
  db: SqliteOperations,
  input: Parameters<Store['readHistoricallyConfirmedImageMembers']>[0],
): Awaited<ReturnType<Store['readHistoricallyConfirmedImageMembers']>> {
  db.db.run('BEGIN');
  try {
    db.identity(input.expectedStoreId);
    if (
      !Array.isArray(input.executionIds) ||
      input.executionIds.length > 128 ||
      input.executionIds.some((id) => typeof id !== 'string' || !id) ||
      new Set(input.executionIds).size !== input.executionIds.length
    )
      throw new AgentError('image_window_scope_invalid');
    const scope = db.row(
      `SELECT r.id FROM run r JOIN session s ON s.id=r.session_id
      JOIN command c ON c.id=r.origin_command_id
      WHERE r.id=? AND r.session_id=? AND c.session_id=r.session_id AND c.subject_id=?
      AND r.origin_store_id=? AND c.origin_store_id=r.origin_store_id
      AND r.context_selection_id=? AND s.context_selection_id=r.context_selection_id`,
      input.runId,
      input.sessionId,
      input.subjectId,
      input.expectedStoreId,
      input.selectionId,
    );
    if (!scope) throw new AgentError('image_window_scope_invalid');
    const found = new Map<
      string,
      { executionId: string; ordinal: number; hash: string; size: number }
    >();
    const rows = db.rows(
      `SELECT e.decision_source_json,e.result_json FROM execution e
      JOIN run r ON r.id=e.run_id JOIN command c ON c.id=e.origin_command_id
      WHERE e.session_id=? AND r.session_id=e.session_id AND c.session_id=e.session_id
      AND c.subject_id=? AND e.origin_store_id=? AND r.origin_store_id=e.origin_store_id
      AND c.origin_store_id=e.origin_store_id AND r.origin_command_id=c.id
      AND r.context_selection_id=? AND e.kind='model' AND e.state='succeeded'
      AND json_valid(e.decision_source_json) AND json_valid(e.result_json)
      AND EXISTS (SELECT 1 FROM json_each(e.decision_source_json,'$.imageWindow.members') m
        JOIN json_each(?) ids ON json_extract(m.value,'$.executionId')=ids.value)`,
      input.sessionId,
      input.subjectId,
      input.expectedStoreId,
      input.selectionId,
      JSON.stringify(input.executionIds),
    );
    for (const row of rows) {
      const source = JSON.parse(String(row.decision_source_json));
      const result = JSON.parse(String(row.result_json));
      const scope = source?.imageWindow;
      if (
        source?.kind !== 'model_request' ||
        !scope ||
        scope.version !== 1 ||
        !['business', 'observation'].includes(scope.kind) ||
        typeof scope.route !== 'string' ||
        !scope.route ||
        !Array.isArray(scope.members) ||
        !scope.members.length ||
        scope.members.length > 128 ||
        canonicalJson(scope) !== canonicalJson(result?.imageWindow ?? null)
      )
        continue;
      if (scope.kind === 'observation') {
        if (
          result.finishReason !== 'stop' ||
          !Array.isArray(result.toolCalls) ||
          result.toolCalls.length ||
          result.observation?.trust !== 'untrusted' ||
          typeof result.observation.note !== 'string' ||
          !result.observation.note ||
          Buffer.byteLength(result.observation.note) > 16384
        )
          continue;
      } else if (!['stop', 'tool_calls'].includes(result.finishReason)) continue;
      const identities = new Set<string>();
      if (
        scope.members.some(
          (m: { executionId: string; ordinal: number; hash: string; size: number }) => {
            const key = JSON.stringify([m?.executionId, m?.ordinal]);
            if (
              !m ||
              typeof m.executionId !== 'string' ||
              !m.executionId ||
              !Number.isSafeInteger(m.ordinal) ||
              m.ordinal < 1 ||
              !Number.isSafeInteger(m.size) ||
              m.size <= 0 ||
              typeof m.hash !== 'string' ||
              !/^[a-f0-9]{64}$/.test(m.hash) ||
              identities.has(key)
            )
              return true;
            identities.add(key);
            return false;
          },
        )
      )
        continue;
      for (const m of scope.members)
        if (input.executionIds.includes(m.executionId)) {
          const member = {
            executionId: m.executionId,
            ordinal: m.ordinal,
            hash: m.hash,
            size: m.size,
          };
          found.set(JSON.stringify(member), member);
        }
    }
    db.db.run('COMMIT');
    return [...found.values()];
  } catch (error) {
    return db.rollback(error);
  }
}
