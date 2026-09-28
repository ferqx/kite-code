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
  // A TEMP table avoids an unbounded SQL parameter list for large descendant trees.
  database.run(
    'CREATE TEMP TABLE IF NOT EXISTS kite_delete_tree_ids (session_id TEXT PRIMARY KEY)',
  );
  database.run('DELETE FROM temp.kite_delete_tree_ids');
  const insert = database.query('INSERT INTO temp.kite_delete_tree_ids(session_id) VALUES (?)');
  for (const row of rows) insert.run(row.session_id);

  // SQLite validates the whole tree when the transaction commits. A table may
  // reference another tree-owned table as well as runtime_sessions, so delete
  // order is not an authority or correctness assumption.
  database.run('PRAGMA defer_foreign_keys = ON');
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
  return rows.map((row) => row.session_id);
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
  const tables = database
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
    )
    .all();
  for (const candidate of candidates) {
    let retained = false;
    for (const { name } of tables) {
      const textColumns = database
        .query<{ name: string; type: string }, []>(`PRAGMA table_info(${quoteIdentifier(name)})`)
        .all()
        .filter((column) => column.type.toUpperCase() === 'TEXT')
        .map((column) => column.name);
      if (!textColumns.length) continue;
      const match = textColumns
        .map((column) => `instr(${quoteIdentifier(column)}, ?) > 0`)
        .join(' OR ');
      const excludeSelf = name === candidate.table ? ' AND artifact_id <> ?' : '';
      const args = textColumns.map(() => candidate.artifactId);
      if (excludeSelf) args.push(candidate.artifactId);
      const present = database
        .query<{ present: number }, string[]>(
          `SELECT 1 AS present FROM ${quoteIdentifier(name)} WHERE (${match})${excludeSelf} LIMIT 1`,
        )
        .get(...args);
      if (present) {
        retained = true;
        break;
      }
    }
    if (!retained)
      database
        .query(`DELETE FROM ${quoteIdentifier(candidate.table)} WHERE artifact_id=?`)
        .run(candidate.artifactId);
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
