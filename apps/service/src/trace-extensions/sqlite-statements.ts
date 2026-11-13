import type { Database, SQLQueryBindings, Statement } from '@kite-ai/agent/runtime-sqlite';

function withStatement<Row, Result>(
  db: Database,
  sql: string,
  materialize: (statement: Statement<Row>) => Result,
): Result {
  const statement = db.prepare<Row>(sql);
  try {
    return materialize(statement);
  } finally {
    statement.finalize();
  }
}

/** The long-lived Trace stores only return materialized values from these statements. */
export function readTraceRow<Row>(db: Database, sql: string, ...values: SQLQueryBindings[]) {
  return withStatement<Row, Row | null>(db, sql, (statement) => statement.get(...values));
}

export function readTraceRows<Row>(db: Database, sql: string, ...values: SQLQueryBindings[]) {
  return withStatement<Row, Row[]>(db, sql, (statement) => statement.all(...values));
}

export function writeTraceStatement(db: Database, sql: string, ...values: SQLQueryBindings[]) {
  withStatement(db, sql, (statement) => statement.run(...values));
}
