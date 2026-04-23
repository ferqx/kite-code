import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { RunnableConfig } from "@langchain/core/runnables";
import {
  BaseCheckpointSaver,
  TASKS,
  copyCheckpoint,
  maxChannelVersion,
  type Checkpoint,
  type CheckpointListOptions,
  type CheckpointMetadata,
  type CheckpointTuple,
  type PendingWrite,
} from "@langchain/langgraph-checkpoint";

interface CheckpointRow {
  thread_id: string;
  checkpoint_ns: string;
  checkpoint_id: string;
  parent_checkpoint_id: string | null;
  type: string | null;
  checkpoint: string | Uint8Array;
  metadata: string | Uint8Array;
}

interface PendingWriteRow {
  task_id: string;
  channel: string;
  type: string | null;
  value: string | Uint8Array | null;
}

interface PendingSendRow {
  type: string | null;
  value: string | Uint8Array | null;
}

export class BunSqliteSaver extends BaseCheckpointSaver {
  private readonly db: Database;
  private isSetup = false;

  constructor(private readonly dbPath: string) {
    super();
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
  }

  setup(): void {
    if (this.isSetup) {
      return;
    }

    this.db.run("pragma journal_mode = wal");
    this.db.run(`
      create table if not exists checkpoints (
        thread_id text not null,
        checkpoint_ns text not null default '',
        checkpoint_id text not null,
        parent_checkpoint_id text,
        type text,
        checkpoint text,
        metadata text,
        primary key (thread_id, checkpoint_ns, checkpoint_id)
      )
    `);
    this.db.run(`
      create table if not exists writes (
        thread_id text not null,
        checkpoint_ns text not null default '',
        checkpoint_id text not null,
        task_id text not null,
        idx integer not null,
        channel text not null,
        type text,
        value text,
        primary key (thread_id, checkpoint_ns, checkpoint_id, task_id, idx)
      )
    `);
    this.isSetup = true;
  }

  async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    this.setup();
    const threadId = config.configurable?.thread_id;
    const checkpointNs = String(config.configurable?.checkpoint_ns ?? "");
    const checkpointId = config.configurable?.checkpoint_id;
    if (!threadId) {
      return undefined;
    }

    const row = checkpointId
      ? this.db
          .query<CheckpointRow, [string, string, string]>(selectCheckpointSql(true))
          .get(String(threadId), checkpointNs, String(checkpointId))
      : this.db
          .query<CheckpointRow, [string, string]>(selectCheckpointSql(false))
          .get(String(threadId), checkpointNs);

    if (!row) {
      return undefined;
    }

    const finalConfig = checkpointId
      ? config
      : {
          configurable: {
            thread_id: row.thread_id,
            checkpoint_ns: checkpointNs,
            checkpoint_id: row.checkpoint_id,
          },
        };

    const checkpoint = await this.serde.loadsTyped(
      row.type ?? "json",
      row.checkpoint,
    );
    if (checkpoint.v < 4 && row.parent_checkpoint_id != null) {
      await this.migratePendingSends(checkpoint, row.thread_id, row.parent_checkpoint_id);
    }

    return {
      checkpoint,
      config: finalConfig,
      metadata: await this.serde.loadsTyped(row.type ?? "json", row.metadata),
      parentConfig: row.parent_checkpoint_id
        ? {
            configurable: {
              thread_id: row.thread_id,
              checkpoint_ns: checkpointNs,
              checkpoint_id: row.parent_checkpoint_id,
            },
          }
        : undefined,
      pendingWrites: await this.getPendingWrites(
        row.thread_id,
        checkpointNs,
        row.checkpoint_id,
      ),
    };
  }

  async *list(
    config: RunnableConfig,
    options: CheckpointListOptions = {},
  ): AsyncGenerator<CheckpointTuple> {
    this.setup();
    const threadId = config.configurable?.thread_id;
    const checkpointNs = config.configurable?.checkpoint_ns;
    const clauses: string[] = [];
    const args: string[] = [];

    if (threadId) {
      clauses.push("thread_id = ?");
      args.push(String(threadId));
    }
    if (checkpointNs !== undefined && checkpointNs !== null) {
      clauses.push("checkpoint_ns = ?");
      args.push(String(checkpointNs));
    }
    if (options.before?.configurable?.checkpoint_id) {
      clauses.push("checkpoint_id < ?");
      args.push(String(options.before.configurable.checkpoint_id));
    }

    const where = clauses.length > 0 ? `where ${clauses.join(" and ")}` : "";
    const limit = options.limit ? ` limit ${Math.trunc(options.limit)}` : "";
    const rows = this.db
      .query<CheckpointRow, string[]>(
        `${selectCheckpointColumns()} from checkpoints ${where} order by checkpoint_id desc${limit}`,
      )
      .all(...args);

    for (const row of rows) {
      const checkpoint = await this.serde.loadsTyped(
        row.type ?? "json",
        row.checkpoint,
      );
      yield {
        config: {
          configurable: {
            thread_id: row.thread_id,
            checkpoint_ns: row.checkpoint_ns,
            checkpoint_id: row.checkpoint_id,
          },
        },
        checkpoint,
        metadata: await this.serde.loadsTyped(row.type ?? "json", row.metadata),
        parentConfig: row.parent_checkpoint_id
          ? {
              configurable: {
                thread_id: row.thread_id,
                checkpoint_ns: row.checkpoint_ns,
                checkpoint_id: row.parent_checkpoint_id,
              },
            }
          : undefined,
        pendingWrites: await this.getPendingWrites(
          row.thread_id,
          row.checkpoint_ns,
          row.checkpoint_id,
        ),
      };
    }
  }

  async put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata,
  ): Promise<RunnableConfig> {
    this.setup();
    const threadId = config.configurable?.thread_id;
    if (!threadId) {
      throw new Error('Missing "thread_id" field in config.configurable');
    }

    const checkpointNs = String(config.configurable?.checkpoint_ns ?? "");
    const parentCheckpointId = config.configurable?.checkpoint_id
      ? String(config.configurable.checkpoint_id)
      : null;
    const [[checkpointType, serializedCheckpoint], [metadataType, serializedMetadata]] =
      await Promise.all([
        this.serde.dumpsTyped(copyCheckpoint(checkpoint)),
        this.serde.dumpsTyped(metadata),
      ]);
    if (checkpointType !== metadataType) {
      throw new Error("Checkpoint and metadata serialized to different types");
    }

    this.db
      .query(
        `insert or replace into checkpoints
         (thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id, type, checkpoint, metadata)
         values (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        String(threadId),
        checkpointNs,
        checkpoint.id,
        parentCheckpointId,
        checkpointType,
        serializedCheckpoint,
        serializedMetadata,
      );

    return {
      configurable: {
        thread_id: threadId,
        checkpoint_ns: checkpointNs,
        checkpoint_id: checkpoint.id,
      },
    };
  }

  async putWrites(
    config: RunnableConfig,
    writes: PendingWrite[],
    taskId: string,
  ): Promise<void> {
    this.setup();
    const threadId = config.configurable?.thread_id;
    const checkpointId = config.configurable?.checkpoint_id;
    if (!threadId || !checkpointId) {
      throw new Error("Missing thread_id or checkpoint_id in config.configurable");
    }

    const checkpointNs = String(config.configurable?.checkpoint_ns ?? "");
    const insert = this.db.query(
      `insert or replace into writes
       (thread_id, checkpoint_ns, checkpoint_id, task_id, idx, channel, type, value)
       values (?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    const rows = await Promise.all(
      writes.map(async (write, index) => {
        const [type, serializedWrite] = await this.serde.dumpsTyped(write[1]);
        return [
          String(threadId),
          checkpointNs,
          String(checkpointId),
          taskId,
          index,
          write[0],
          type,
          serializedWrite,
        ] as const;
      }),
    );
    this.db.transaction(() => {
      for (const row of rows) {
        insert.run(...row);
      }
    })();
  }

  async deleteThread(threadId: string): Promise<void> {
    this.setup();
    this.db.transaction(() => {
      this.db.query("delete from checkpoints where thread_id = ?").run(threadId);
      this.db.query("delete from writes where thread_id = ?").run(threadId);
    })();
  }

  close(): void {
    this.db.close();
  }

  private async getPendingWrites(
    threadId: string,
    checkpointNs: string,
    checkpointId: string,
  ): Promise<[string, string, unknown][]> {
    const writes = this.db
      .query<PendingWriteRow, [string, string, string]>(
        `select task_id, channel, type, value
         from writes
         where thread_id = ? and checkpoint_ns = ? and checkpoint_id = ?
         order by idx`,
      )
      .all(threadId, checkpointNs, checkpointId);
    const parsed = await Promise.all(
      writes.map(async (write) => [
        write.task_id,
        write.channel,
        await this.serde.loadsTyped(write.type ?? "json", write.value ?? ""),
      ]),
    );
    return parsed as [string, string, unknown][];
  }

  private async migratePendingSends(
    checkpoint: Checkpoint,
    threadId: string,
    parentCheckpointId: string,
  ): Promise<void> {
    const sends = this.db
      .query<PendingSendRow, [string, string, string]>(
        `select type, value
         from writes
         where thread_id = ? and checkpoint_id = ? and channel = ?
         order by idx`,
      )
      .all(threadId, parentCheckpointId, TASKS);
    checkpoint.channel_values ??= {};
    checkpoint.channel_values[TASKS] = await Promise.all(
      sends.map((send) => this.serde.loadsTyped(send.type ?? "json", send.value ?? "")),
    );
    checkpoint.channel_versions[TASKS] =
      Object.keys(checkpoint.channel_versions).length > 0
        ? maxChannelVersion(...Object.values(checkpoint.channel_versions))
        : this.getNextVersion(undefined);
  }
}

function selectCheckpointSql(withCheckpointId: boolean): string {
  return `${selectCheckpointColumns()} from checkpoints
    where thread_id = ? and checkpoint_ns = ?
    ${withCheckpointId ? "and checkpoint_id = ?" : "order by checkpoint_id desc limit 1"}`;
}

function selectCheckpointColumns(): string {
  return `
    select
      thread_id,
      checkpoint_ns,
      checkpoint_id,
      parent_checkpoint_id,
      type,
      checkpoint,
      metadata`;
}
