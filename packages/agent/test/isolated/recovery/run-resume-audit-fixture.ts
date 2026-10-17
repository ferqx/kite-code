import { Database } from 'bun:sqlite';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { semanticDigest } from '../../../src/json';
import { openSqliteStore } from '../../../src/sqlite';
import { SqliteOperations } from '../../../src/storage/sqlite/operations';
import type { AuditRow } from '../../../src/storage/sqlite/recovery-audit-validation';
import type { RunResumeState } from '../../../src/storage/types';

export async function auditFixture(history = 4, failed = false, endedChildren = 0) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'kite-resume-audit-')));
  const profile = { dataRoot: join(directory, 'data'), profile: 'test' };
  const path = join(profile.dataRoot, profile.profile, 'core.db');
  const store = await openSqliteStore(profile);
  const expectedStoreId = (await store.getMetadata()).storeId;
  let owner!: NonNullable<Awaited<ReturnType<typeof store.acquireSessionOwner>>>;
  let runId = '';
  const configuration = { model: 'fixed', version: '1' };
  const input = { messages: [], modelId: 'fixed' };
  try {
    await store.createWorkspace({
      expectedStoreId,
      id: 'w',
      rootUri: pathToFileURL(directory).href,
      name: 'audit',
    });
    await store.createSession({
      expectedStoreId,
      sessionId: 's',
      workspaceId: 'w',
      commandId: 'create',
      subjectId: 'owner',
      title: 'audit',
    });
    await store.acceptCommand({
      expectedStoreId,
      sessionId: 's',
      commandId: 'work',
      subjectId: 'owner',
      request: { kind: 'run.start', content: 'audit' },
    });
    owner = (await store.acquireSessionOwner('s', 'original'))!;
    runId = (await store.startRun({ expectedStoreId, owner, commandId: 'work', configuration })).id;
    await store.beginRunRequirementsInitialization({ expectedStoreId, owner, runId });
    await store.registerRunRequirements({
      expectedStoreId,
      owner,
      runId,
      requirements: [],
      initialize: true,
    });
    const model = async (id: string, failure = false) => {
      await store.planExecution({
        expectedStoreId,
        owner,
        sessionId: 's',
        runId,
        executionId: id,
        originCommandId: 'work',
        stepId: id,
        callId: 'model',
        kind: 'model',
        definitionId: 'fixed',
        definitionVersion: '1',
        input,
        decisionSource: { kind: 'fixed' },
      });
      await store.markDispatching({
        expectedStoreId,
        owner,
        executionId: id,
        requirements: [],
        freshness: { checked: true, source: { kind: 'fixed' } },
        authorization: {
          allowed: true,
          revision: '1',
          definitionVersion: '1',
          inputDigest: await semanticDigest(input),
        },
      });
      await store.finishExecution({
        expectedStoreId,
        owner,
        executionId: id,
        status: failure ? 'failed' : 'succeeded',
        result: failure
          ? { incomplete: true, content: 'old partial' }
          : { content: 'old complete', finishReason: 'stop', toolCalls: [] },
      });
    };
    await model('base');
    if (failed) await model('old-failed', true);
  } finally {
    await store.close();
  }
  const native = new Database(path);
  const ops = new SqliteOperations(native, false);
  try {
    // Controlled SQL-volume fixture, not a claim of Provider or Tool effects. Every
    // inserted original row passes the same transaction certificate writer.
    const base = native.query<AuditRow, []>("SELECT * FROM execution WHERE id='base'").get()!;
    const columns = Object.keys(base);
    const insert = native.prepare(
      `INSERT INTO execution(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')})`,
    );
    const insertSession = native.prepare(
      "INSERT INTO session(id,workspace_id,parent_id,root_id,title,context_selection_id) VALUES(?,'w','s','s',?,'old-selection')",
    );
    try {
      ops.tx(() => {
        for (let index = 0; index < history; index++) {
          const row: AuditRow = { ...base, id: `history-${index}`, step_id: `history-${index}` };
          insert.run(...columns.map((column) => row[column] ?? null));
        }
        for (let index = 0; index < endedChildren; index++) {
          const id = `ended-child-${index}`;
          insertSession.run(id, id);
          const row: AuditRow = {
            ...base,
            id: `ended-carrier-${index}`,
            kind: 'job',
            run_id: null,
            child_session_id: id,
            parent_execution_id: 'base',
            step_id: `ended-step-${index}`,
          };
          insert.run(...columns.map((column) => row[column] ?? null));
        }
        if (failed)
          ops.run(
            "UPDATE execution SET decision_source_json=? WHERE id='old-failed'",
            JSON.stringify({ kind: 'model_request', requestId: 'old-failed' }),
          );
      });
    } finally {
      insert.finalize();
      insertSession.finalize();
    }
    ops.call('planExecution', [
      {
        expectedStoreId,
        owner,
        sessionId: 's',
        runId,
        executionId: 'next',
        originCommandId: 'work',
        stepId: 'next',
        callId: 'model',
        kind: 'model',
        definitionId: 'fixed',
        definitionVersion: '1',
        input,
        decisionSource: { kind: 'fixed' },
      },
    ]);
  } finally {
    ops.releaseStatements();
    native.close(true);
  }
  return {
    directory,
    profile,
    path,
    configuration,
    input: {
      expectedStoreId,
      sessionId: 's',
      subjectId: 'owner',
      commandId: 'resume',
      runId,
      expectedOwnerGeneration: owner.generation,
    },
    close: () => rmSync(directory, { recursive: true, force: true }),
  };
}

export function trackedAudit(path: string, readonly = true) {
  const db = new Database(path, { readonly });
  const queries: string[] = [];
  let rows = 0;
  const count = <T>(value: T): T => {
    if (Array.isArray(value)) rows += value.length;
    else if (value !== null && value !== undefined) rows++;
    return value;
  };
  const tracked = new Proxy(db, {
    get(target, property) {
      if (property !== 'query' && property !== 'prepare') {
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      }
      return (sql: string, ...args: unknown[]) => {
        queries.push(sql);
        const statement = Reflect.apply(Reflect.get(target, property, target), target, [
          sql,
          ...args,
        ]);
        return new Proxy(statement, {
          get(stmt, key) {
            const operation = Reflect.get(stmt, key, stmt);
            if (typeof operation !== 'function') return operation;
            if (['get', 'all', 'values'].includes(String(key)))
              return (...values: unknown[]) => count(Reflect.apply(operation, stmt, values));
            if (key === 'iterate')
              return function* (...values: unknown[]) {
                for (const row of Reflect.apply(operation, stmt, values) as Iterable<unknown>)
                  yield count(row);
              };
            return operation.bind(stmt);
          },
        });
      };
    },
  });
  const operations = new SqliteOperations(tracked, readonly);
  operations.releaseStatements();
  queries.length = 0;
  rows = 0;
  return {
    db,
    operations,
    queries,
    rows: () => rows,
    verify(input: Parameters<typeof operations.call>[1][number]) {
      return operations.call('verifyRunResume', [input]) as RunResumeState;
    },
    close() {
      operations.releaseStatements();
      db.close(true);
    },
  };
}
