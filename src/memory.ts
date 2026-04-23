import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface MemoryRecord {
  namespace: string;
  key: string;
  value: string;
}

export interface PutMemoryInput extends MemoryRecord {
  userId: string;
}

export class SqliteLongTermMemory {
  private readonly db: Database;

  constructor(private readonly dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.run(`
      create table if not exists memories (
        user_id text not null,
        namespace text not null,
        key text not null,
        value text not null,
        updated_at text not null default current_timestamp,
        primary key (user_id, namespace, key)
      )
    `);
  }

  put(input: PutMemoryInput): void {
    this.db
      .query(
        `insert into memories (user_id, namespace, key, value, updated_at)
         values ($userId, $namespace, $key, $value, current_timestamp)
         on conflict(user_id, namespace, key)
         do update set value = excluded.value, updated_at = current_timestamp`,
      )
      .run({
        $userId: input.userId,
        $namespace: input.namespace,
        $key: input.key,
        $value: input.value,
      });
  }

  list(userId: string, namespace?: string): MemoryRecord[] {
    const sql = namespace
      ? `select namespace, key, value from memories where user_id = $userId and namespace = $namespace order by namespace, key`
      : `select namespace, key, value from memories where user_id = $userId order by namespace, key`;
    return this.db.query<MemoryRecord, Record<string, string>>(sql).all({
      $userId: userId,
      ...(namespace ? { $namespace: namespace } : {}),
    });
  }

  recallText(userId: string): string {
    return this.list(userId)
      .map((record) => `[${record.namespace}] ${record.key}: ${record.value}`)
      .join("\n");
  }

  close(): void {
    this.db.close();
  }
}
