import { nativeRuntime } from './runtime-native';
import { initializeDefaultSqliteEngine } from './sqlite-engine';

type Binding = string | bigint | ArrayBufferLike | ArrayBufferView | number | boolean | null;
export type SQLQueryBindings = Binding | Record<string, Binding>;
export const constants = Object.freeze({
  SQLITE_OPEN_READONLY: 1,
  SQLITE_OPEN_READWRITE: 2,
  SQLITE_OPEN_CREATE: 4,
  SQLITE_OPEN_URI: 0x40,
  SQLITE_OPEN_NOFOLLOW: 0x01000000,
});
type DatabaseOptions = {
  readonly?: boolean;
  create?: boolean;
  readwrite?: boolean;
  safeIntegers?: boolean;
  strict?: boolean;
};
const { SQLITE_OPEN_READONLY, SQLITE_OPEN_READWRITE, SQLITE_OPEN_CREATE } = constants;

function openFlags(options?: number | DatabaseOptions): number {
  if (typeof options === 'number') return options;
  if (options?.readonly || options?.readwrite === false) {
    if (options?.create || options?.readwrite) throw TypeError('native_sqlite_flags_invalid');
    return SQLITE_OPEN_READONLY;
  }
  const create = options?.create ?? options?.readwrite !== true;
  return SQLITE_OPEN_READWRITE | (create ? SQLITE_OPEN_CREATE : 0);
}

function bindings(values: unknown[]): { data: unknown; named: boolean } {
  const normalized = (input: unknown) =>
    input instanceof SharedArrayBuffer ? new Uint8Array(input) : input;
  if (!values.length) return { data: null, named: false };
  if (values.length === 1) {
    const input = values[0];
    if (Array.isArray(input)) return { data: input.map(normalized), named: false };
    if (
      input &&
      typeof input === 'object' &&
      !ArrayBuffer.isView(input) &&
      !(input instanceof ArrayBuffer) &&
      !(input instanceof SharedArrayBuffer)
    )
      return {
        data: Object.fromEntries(
          Object.entries(input).map(([key, value]) => [key, normalized(value)]),
        ),
        named: true,
      };
  }
  return { data: values.map(normalized), named: false };
}

export class Statement<Row = unknown, Params extends SQLQueryBindings[] = SQLQueryBindings[]> {
  private active = false;
  private readonly connection: object;
  private readonly statement: object;
  private integers: boolean;
  private readonly strict: boolean;
  constructor(connection: object, statement: object, integers: boolean, strict: boolean) {
    this.connection = connection;
    this.statement = statement;
    this.integers = integers;
    this.strict = strict;
  }

  safeIntegers(enabled: boolean): this {
    this.integers = enabled;
    return this;
  }

  finalize(): void {
    nativeRuntime().sqliteFinalize(this.statement);
  }

  private *rows(arguments_: unknown[], values: boolean, skip: boolean): IterableIterator<Row> {
    if (this.active) throw Error('native_sqlite_statement_in_use');
    const native = nativeRuntime();
    const { data, named } = bindings(arguments_);
    native.sqliteStart(this.statement, data, named, this.strict);
    this.active = true;
    try {
      for (;;) {
        const row = native.sqliteNext(this.statement, this.integers, values, skip);
        if (row === null) return;
        yield row as Row;
      }
    } finally {
      this.active = false;
      native.sqliteReset(this.statement);
    }
  }

  get(...values: Params): Row | null {
    const rows = this.rows(values, false, false);
    try {
      const result = rows.next();
      return result.done ? null : result.value;
    } finally {
      rows.return?.();
    }
  }

  all(...values: Params): Row[] {
    return [...this.rows(values, false, false)];
  }

  iterate(...values: Params): IterableIterator<Row> {
    return this.rows(values, false, false);
  }

  values(...arguments_: Params): unknown[][] {
    return [...this.rows(arguments_, true, false)] as unknown as unknown[][];
  }

  run(...values: Params) {
    for (const _ of this.rows(values, false, true)) {
      // Materialize no rows for run(), while draining RETURNING and pragmas.
    }
    return nativeRuntime().sqliteChanges(this.connection);
  }
}

export class Database {
  readonly filename: string;
  private readonly connection: object;
  private readonly options: DatabaseOptions | undefined;
  private savepoint = 0;
  constructor(path = ':memory:', options?: number | DatabaseOptions) {
    const native = nativeRuntime();
    // Source tests use the same addon with a library explicitly prepared by the test runner.
    // A built package must initialize its authenticated engine before opening any database.
    if (import.meta.url.endsWith('.ts') && !native.sqliteIsSelected()) {
      initializeDefaultSqliteEngine();
    }
    this.connection = native.sqliteOpen(path, openFlags(options));
    this.filename = path;
    this.options = typeof options === 'object' ? { ...options } : undefined;
  }

  static setCustomSQLite(path: string): boolean {
    return nativeRuntime().sqliteSelect(path);
  }

  get inTransaction(): boolean {
    return nativeRuntime().sqliteInTransaction(this.connection);
  }

  prepare<Row = unknown, Params extends SQLQueryBindings[] = SQLQueryBindings[]>(
    sql: string,
  ): Statement<Row, Params> {
    return new Statement(
      this.connection,
      nativeRuntime().sqlitePrepare(this.connection, sql),
      this.options?.safeIntegers ?? false,
      this.options?.strict ?? false,
    );
  }

  query<Row = unknown, Params extends SQLQueryBindings[] = SQLQueryBindings[]>(
    sql: string,
  ): Statement<Row, Params> {
    return this.prepare<Row, Params>(sql);
  }

  exec(sql: string): void {
    nativeRuntime().sqliteExec(this.connection, sql);
  }

  run(sql: string, ...arguments_: SQLQueryBindings[] | [SQLQueryBindings[]]) {
    if (
      !arguments_.length ||
      (arguments_.length === 1 && Array.isArray(arguments_[0]) && !arguments_[0].length)
    ) {
      this.exec(sql);
      return nativeRuntime().sqliteChanges(this.connection);
    }
    const statement = this.prepare(sql);
    try {
      return statement.run(...(arguments_ as SQLQueryBindings[]));
    } finally {
      statement.finalize();
    }
  }

  close(_throwOnError?: boolean): void {
    nativeRuntime().sqliteClose(this.connection);
  }

  transaction<Args extends unknown[], Result>(operation: (...args: Args) => Result) {
    const wrap =
      (mode: 'DEFERRED' | 'IMMEDIATE' | 'EXCLUSIVE') =>
      (...args: Args) => {
        const nested = this.inTransaction;
        const marker = `kite_nested_${++this.savepoint}`;
        this.exec(nested ? `SAVEPOINT ${marker}` : `BEGIN ${mode}`);
        try {
          const result = operation(...args);
          this.exec(nested ? `RELEASE ${marker}` : 'COMMIT');
          return result;
        } catch (error) {
          if (!this.inTransaction) throw error;
          try {
            this.exec(nested ? `ROLLBACK TO ${marker}; RELEASE ${marker}` : 'ROLLBACK');
          } catch (cleanup) {
            throw new AggregateError([error, cleanup], 'native_sqlite_transaction_cleanup_failed', {
              cause: error,
            });
          }
          throw error;
        }
      };
    const deferred = wrap('DEFERRED');
    return Object.assign(deferred, {
      deferred,
      immediate: wrap('IMMEDIATE'),
      exclusive: wrap('EXCLUSIVE'),
    });
  }
}
