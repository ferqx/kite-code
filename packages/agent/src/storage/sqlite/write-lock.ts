/** Core-only proof that no transaction callback has run for this Worker request. */
export class UnstartedSqliteWrite extends Error {
  constructor(cause: unknown) {
    super('sqlite_writer_wait', { cause });
  }
}
