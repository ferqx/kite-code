import type { Database } from 'bun:sqlite';

interface TreeRow {
  session_id: string;
  workspace_id: string;
  depth: number;
}

const PRIVATE_ARTIFACT_TABLES = [
  'model_artifacts',
  'plan_artifacts',
  'capability_artifacts',
  'filesystem_preimage_artifacts',
  'sandbox_preparation_artifacts',
  'subagent_task_artifacts',
  'subagent_lifecycle_artifacts',
  'subagent_continuation_artifacts',
  'subagent_checkpoint_artifacts',
  'agent_followup_admission_artifacts',
  'agent_followup_grant_artifacts',
] as const;

interface ArtifactToDelete {
  table: string;
  artifactId: string;
}

export interface KiteWorkspaceSessionDeletionSet {
  readonly rootSessionIds: readonly string[];
  readonly sessionIds: readonly string[];
}

export class KiteSessionTreeDeletionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KiteSessionTreeDeletionError';
  }
}

/** Called only inside the fenced, receipt-bearing root deletion transaction. */
export function prepareKiteSessionTreeDeletion(
  database: Database,
  rootSessionId: string,
  workspaceId: string,
): readonly string[] {
  const rows = database
    .query<TreeRow, [string]>(
      `WITH RECURSIVE tree(session_id, workspace_id, depth) AS (
         SELECT session_id, workspace_id, 0 FROM runtime_sessions WHERE session_id = ?
         UNION ALL
         SELECT child.session_id, child.workspace_id, tree.depth + 1
           FROM runtime_sessions AS child JOIN tree ON child.parent_session_id = tree.session_id
       ) SELECT session_id, workspace_id, depth FROM tree ORDER BY depth DESC, session_id`,
    )
    .all(rootSessionId);
  if (!rows.length || rows.at(-1)?.session_id !== rootSessionId)
    throw new KiteSessionTreeDeletionError('Runtime Session deletion target is unavailable.');
  if (rows.some((row) => row.workspace_id !== workspaceId))
    throw new KiteSessionTreeDeletionError('Internal child Session crossed its parent Workspace.');
  stageKiteSessionDeletionIds(
    database,
    rows.map((row) => row.session_id),
  );
  return rows.map((row) => row.session_id);
}

/** Stage every Session in one Workspace for one atomic data-only deletion. */
export function prepareKiteWorkspaceSessionDeletion(
  database: Database,
  workspaceId: string,
): KiteWorkspaceSessionDeletionSet {
  const rows = database
    .query<{ session_id: string; parent_session_id: string | null }, [string]>(
      `SELECT session_id, parent_session_id FROM runtime_sessions
        WHERE workspace_id = ? ORDER BY session_id`,
    )
    .all(workspaceId);
  if (!rows.length) return { rootSessionIds: [], sessionIds: [] };
  const ids = new Set(rows.map((row) => row.session_id));
  if (rows.some((row) => row.parent_session_id && !ids.has(row.parent_session_id)))
    throw new KiteSessionTreeDeletionError('Internal child Session crossed its parent Workspace.');
  const roots = rows.filter((row) => row.parent_session_id === null).map((row) => row.session_id);
  if (!roots.length)
    throw new KiteSessionTreeDeletionError('Workspace Session lineage has no root.');
  stageKiteSessionDeletionIds(
    database,
    rows.map((row) => row.session_id),
  );
  return {
    rootSessionIds: roots,
    sessionIds: rows.map((row) => row.session_id),
  };
}

function stageKiteSessionDeletionIds(database: Database, sessionIds: readonly string[]): void {
  // A TEMP table avoids an unbounded SQL parameter list for large descendant trees.
  database.run(
    'CREATE TEMP TABLE IF NOT EXISTS kite_delete_tree_ids (session_id TEXT PRIMARY KEY)',
  );
  database.run('DELETE FROM temp.kite_delete_tree_ids');
  const insert = database.query('INSERT INTO temp.kite_delete_tree_ids(session_id) VALUES (?)');
  for (const sessionId of sessionIds) insert.run(sessionId);

  // SQLite validates the whole tree when the transaction commits. A table may
  // reference another tree-owned table as well as runtime_sessions, so delete
  // order is not an authority or correctness assumption.
  database.run('PRAGMA defer_foreign_keys = ON');
  const externalChild = database
    .query<{ present: number }, []>(
      `SELECT 1 AS present FROM runtime_sessions
        WHERE parent_session_id IN (SELECT session_id FROM temp.kite_delete_tree_ids)
          AND session_id NOT IN (SELECT session_id FROM temp.kite_delete_tree_ids)
        LIMIT 1`,
    )
    .get();
  if (externalChild)
    throw new KiteSessionTreeDeletionError('Runtime Session deletion has an external child.');
  const tables = database
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
    )
    .all();
  for (const { name } of tables) {
    if (name === 'runtime_sessions') continue;
    const quotedTable = quoteIdentifier(name);
    const columns = [
      ...new Set(
        database
          .query<{ table: string; from: string }, []>(`PRAGMA foreign_key_list(${quotedTable})`)
          .all()
          .filter((key) => key.table === 'runtime_sessions')
          .map((key) => key.from),
      ),
    ];
    if (!columns.length) continue;
    const touchesTree = columns
      .map(
        (column) =>
          `${quoteIdentifier(column)} IN (SELECT session_id FROM temp.kite_delete_tree_ids)`,
      )
      .join(' OR ');
    const pointsOutside = columns
      .map(
        (column) =>
          `(${quoteIdentifier(column)} IS NOT NULL AND ${quoteIdentifier(column)} NOT IN (SELECT session_id FROM temp.kite_delete_tree_ids))`,
      )
      .join(' OR ');
    const outside = database
      .query<{ present: number }, []>(
        `SELECT 1 AS present FROM ${quotedTable} WHERE (${touchesTree}) AND (${pointsOutside}) LIMIT 1`,
      )
      .get();
    if (outside)
      throw new KiteSessionTreeDeletionError(
        `Runtime Session deletion has an external dependency in ${name}.`,
      );
  }
}

export function removeKiteSessionTreeReferences(database: Database): void {
  const tables = database
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
    )
    .all();
  for (const { name } of tables) {
    if (name === 'runtime_sessions') continue;
    const quotedTable = quoteIdentifier(name);
    const columns = [
      ...new Set(
        database
          .query<{ table: string; from: string }, []>(`PRAGMA foreign_key_list(${quotedTable})`)
          .all()
          .filter((key) => key.table === 'runtime_sessions')
          .map((key) => key.from),
      ),
    ];
    if (!columns.length) continue;
    const touchesTree = columns
      .map(
        (column) =>
          `${quoteIdentifier(column)} IN (SELECT session_id FROM temp.kite_delete_tree_ids)`,
      )
      .join(' OR ');
    database.run(`DELETE FROM ${quotedTable} WHERE ${touchesTree}`);
  }
}

/** Capture only typed refs present in rows owned by the tree, before those rows disappear. */
export function prepareKiteSessionTreeArtifactDeletion(
  database: Database,
): readonly ArtifactToDelete[] {
  const artifactTables = new Set(
    database
      .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((row) => row.name)
      .filter((name) =>
        PRIVATE_ARTIFACT_TABLES.includes(name as (typeof PRIVATE_ARTIFACT_TABLES)[number]),
      ),
  );
  const referenced = new Set<string>();
  for (const table of sessionOwnedTables(database)) {
    const rows = database.query<Record<string, unknown>, []>(
      `SELECT * FROM ${quoteIdentifier(table.name)} WHERE ${table.match}`,
    );
    for (const row of rows.iterate()) {
      for (const [column, value] of Object.entries(row)) {
        if (typeof value !== 'string') continue;
        if (isArtifactIdField(column)) referenced.add(value);
        if (column.endsWith('_json')) {
          try {
            collectArtifactRefs(JSON.parse(value), referenced);
          } catch {
            // A malformed unrelated JSON field cannot authorize Artifact deletion.
          }
        }
      }
    }
  }
  const candidates: ArtifactToDelete[] = [];
  for (const table of artifactTables) {
    const lookup = database.query<{ artifact_id: string }, [string]>(
      `SELECT artifact_id FROM ${quoteIdentifier(table)} WHERE artifact_id=?`,
    );
    for (const artifactId of referenced) {
      if (lookup.get(artifactId)) candidates.push({ table, artifactId });
    }
  }
  return candidates;
}

/** Run after Session row deletion, in the same transaction and before its receipt commits. */
export function removeUnreferencedKiteSessionTreeArtifacts(
  database: Database,
  candidates: readonly ArtifactToDelete[],
): void {
  if (!candidates.length) return;
  // Preserve the old deletion order. A candidate row can be the only remaining
  // reference to a later candidate, so a single pre-delete boolean is not
  // enough: record which candidate row supplied each match and simulate the
  // ordered deletes before issuing them.
  const byId = new Map<string, number[]>();
  const byTable = new Map<string, Map<string, number>>();
  for (const [index, candidate] of candidates.entries()) {
    const idMatches = byId.get(candidate.artifactId) ?? [];
    idMatches.push(index);
    byId.set(candidate.artifactId, idMatches);
    const tableMatches = byTable.get(candidate.table) ?? new Map<string, number>();
    tableMatches.set(candidate.artifactId, index);
    byTable.set(candidate.table, tableMatches);
  }
  const matcher = new ArtifactIdMatcher([...byId.keys()]);
  const permanentlyRetained = Array.from({ length: candidates.length }, () => false);
  const candidateSupporters = Array.from({ length: candidates.length }, () => new Set<number>());
  const tables = database
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
    )
    .all();
  const sqliteInstr = database.query<
    { present: number },
    [string | number | bigint | Uint8Array, string]
  >('SELECT instr(?, ?) > 0 AS present');
  try {
    for (const { name } of tables) {
      const textColumns = database
        .query<{ name: string; type: string }, []>(`PRAGMA table_info(${quoteIdentifier(name)})`)
        .all()
        .filter((column) => column.type.toUpperCase() === 'TEXT')
        .map((column) => column.name);
      if (!textColumns.length) continue;
      const rows = database.query<Record<string, unknown>, []>(
        `SELECT ${textColumns.map(quoteIdentifier).join(', ')} FROM ${quoteIdentifier(name)}`,
      );
      try {
        for (const row of rows.iterate()) {
          const source = byTable.get(name)?.get(row.artifact_id as string);
          const matched = new Set<number>();
          for (const column of textColumns) {
            const value = row[column];
            if (typeof value === 'string') matcher.match(value, matched);
            else if (value !== null && value !== undefined) {
              // SQLite permits BLOBs in non-STRICT TEXT columns. Keep instr's
              // exact coercion for these rare rows instead of silently dropping
              // a raw reference.
              for (const [idIndex, id] of matcher.ids.entries()) {
                if (sqliteInstr.get(value as number | bigint | Uint8Array, id)?.present)
                  matched.add(idIndex);
              }
            }
          }
          for (const idIndex of matched) {
            const id = matcher.ids[idIndex]!;
            for (const target of byId.get(id) ?? []) {
              if (source === target) continue;
              if (source === undefined) permanentlyRetained[target] = true;
              else candidateSupporters[target]!.add(source);
            }
          }
        }
      } finally {
        rows.finalize();
      }
    }
  } finally {
    sqliteInstr.finalize();
  }
  const alive = Array.from({ length: candidates.length }, () => true);
  for (const [index, candidate] of candidates.entries()) {
    if (
      !permanentlyRetained[index] &&
      ![...candidateSupporters[index]!].some((source) => alive[source])
    ) {
      alive[index] = false;
      database
        .query(`DELETE FROM ${quoteIdentifier(candidate.table)} WHERE artifact_id=?`)
        .run(candidate.artifactId);
    }
  }
}

/** Aho-Corasick matching keeps the text scan linear in bytes plus actual hits. */
class ArtifactIdMatcher {
  readonly ids: readonly string[];
  readonly #nodes: Array<{
    next: Map<string, number>;
    fail: number;
    outputs: number[];
  }> = [{ next: new Map(), fail: 0, outputs: [] }];

  constructor(ids: readonly string[]) {
    this.ids = ids;
    for (const [idIndex, id] of ids.entries()) {
      let node = 0;
      for (const character of id) {
        let next = this.#nodes[node]!.next.get(character);
        if (next === undefined) {
          next = this.#nodes.length;
          this.#nodes[node]!.next.set(character, next);
          this.#nodes.push({ next: new Map(), fail: 0, outputs: [] });
        }
        node = next;
      }
      this.#nodes[node]!.outputs.push(idIndex);
    }
    const queue = [...this.#nodes[0]!.next.values()];
    for (let index = 0; index < queue.length; index++) {
      const parent = queue[index]!;
      for (const [character, child] of this.#nodes[parent]!.next) {
        queue.push(child);
        let fallback = this.#nodes[parent]!.fail;
        while (fallback && !this.#nodes[fallback]!.next.has(character))
          fallback = this.#nodes[fallback]!.fail;
        this.#nodes[child]!.fail = this.#nodes[fallback]!.next.get(character) ?? 0;
        this.#nodes[child]!.outputs.push(...this.#nodes[this.#nodes[child]!.fail]!.outputs);
      }
    }
  }

  match(value: string, matched: Set<number>): void {
    let node = 0;
    for (const idIndex of this.#nodes[0]!.outputs) matched.add(idIndex);
    for (const character of value) {
      while (node && !this.#nodes[node]!.next.has(character)) node = this.#nodes[node]!.fail;
      node = this.#nodes[node]!.next.get(character) ?? 0;
      for (const idIndex of this.#nodes[node]!.outputs) matched.add(idIndex);
    }
  }
}

function sessionOwnedTables(database: Database): readonly { name: string; match: string }[] {
  const tables = database
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
    )
    .all();
  return tables.flatMap(({ name }) => {
    const columns = [
      ...new Set(
        database
          .query<{ table: string; from: string }, []>(
            `PRAGMA foreign_key_list(${quoteIdentifier(name)})`,
          )
          .all()
          .filter((key) => key.table === 'runtime_sessions')
          .map((key) => key.from),
      ),
    ];
    if (!columns.length) return [];
    return [
      {
        name,
        match: columns
          .map(
            (column) =>
              `${quoteIdentifier(column)} IN (SELECT session_id FROM temp.kite_delete_tree_ids)`,
          )
          .join(' OR '),
      },
    ];
  });
}

function isArtifactIdField(key: string): boolean {
  return key === 'artifactId' || key === 'artifact_id' || key.endsWith('_artifact_id');
}

function collectArtifactRefs(value: unknown, refs: Set<string>): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) collectArtifactRefs(item, refs);
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    if (isArtifactIdField(key) && typeof item === 'string') refs.add(item);
    else collectArtifactRefs(item, refs);
  }
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}
