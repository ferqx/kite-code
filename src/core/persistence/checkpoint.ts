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

/** checkpoint 表行数据类型 / Checkpoint table row data type */
interface CheckpointRow {
  /** 线程 ID / Thread ID */
  thread_id: string;
  /** 检查点命名空间 / Checkpoint namespace */
  checkpoint_ns: string;
  /** 检查点 ID / Checkpoint ID */
  checkpoint_id: string;
  /** 父检查点 ID / Parent checkpoint ID */
  parent_checkpoint_id: string | null;
  /** 序列化类型 / Serialization type */
  type: string | null;
  /** 序列化的检查点数据 / Serialized checkpoint data */
  checkpoint: string | Uint8Array;
  /** 序列化的元数据 / Serialized metadata */
  metadata: string | Uint8Array;
  /** 创建时间（用于排序 sessions）/ Creation timestamp (for session sorting) */
  created_at: string;
}

/** 待写入表行数据类型 / Pending write table row data type */
interface PendingWriteRow {
  /** 任务 ID / Task ID */
  task_id: string;
  /** 通道名称 / Channel name */
  channel: string;
  /** 序列化类型 / Serialization type */
  type: string | null;
  /** 序列化的值 / Serialized value */
  value: string | Uint8Array | null;
}

/** 待发送表行数据类型 / Pending send table row data type */
interface PendingSendRow {
  /** 序列化类型 / Serialization type */
  type: string | null;
  /** 序列化的值 / Serialized value */
  value: string | Uint8Array | null;
}

/** 检查点摘要条目 / Checkpoint summary entry for UI listing */
export interface CheckpointEntry {
  checkpointId: string;
  parentCheckpointId: string | null;
  createdAt: string;
  firstUserMessage: string;
}

/** 基于 Bun SQLite 的 LangGraph Checkpoint 持久化器 / LangGraph checkpoint persistence using Bun SQLite */
export class BunSqliteSaver extends BaseCheckpointSaver {
  /** 数据库实例 / Database instance */
  private readonly db: Database;
  /** 是否已初始化表结构 / Whether tables have been set up */
  private isSetup = false;
  /** 是否已关闭 / Whether the database has been closed */
  private isClosed = false;

  /** 创建实例并初始化数据库 / Create instance and initialize database */
  constructor(private readonly dbPath: string) {
    super();
    if (dbPath !== ":memory:") {
      mkdirSync(dirname(dbPath), { recursive: true });
    }
    this.db = new Database(dbPath);
  }

  /** 创建 checkpoint 和 writes 表，开启 WAL 模式 / Create checkpoint and writes tables, enable WAL mode */
  setup(): void {
    if (this.isClosed) return; // silently skip — graph has been aborted
    // 已初始化则跳过 / Skip if already set up
    if (this.isSetup) {
      return;
    }

    // WAL 模式提升并发读写性能 / WAL mode improves concurrent read/write performance
    this.db.run("pragma journal_mode = wal");
    // 多会话并发写入时避免 SQLITE_BUSY / Avoid SQLITE_BUSY under concurrent multi-session writes
    this.db.run("pragma busy_timeout = 5000");
    this.db.run(`
      create table if not exists checkpoints (
        thread_id text not null,
        checkpoint_ns text not null default '',
        checkpoint_id text not null,
        parent_checkpoint_id text,
        type text,
        checkpoint text,
        metadata text,
        created_at text not null default (datetime('now')),
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

    // 新增 created_at 列用于排序 sessions / Add created_at column for session sorting
    // 使用 PRAGMA table_info 检查列是否存在，避免依赖 SQLite 错误消息文本
    // Use PRAGMA table_info to check column existence instead of relying on error message text
    const columns = this.db.query("PRAGMA table_info(checkpoints)").all() as { name: string }[];
    const hasCreatedAt = columns.some((c) => c.name === "created_at");
    if (!hasCreatedAt) {
      this.db.exec("ALTER TABLE checkpoints ADD COLUMN created_at TEXT");
    }

    // 存量行回填 created_at：迁移前的行该列为 NULL，必须填充否则 listSessions 会排除它们
    // Backfill created_at: pre-migration rows have NULL, which would be excluded from listSessions
    this.db.run(
      "UPDATE checkpoints SET created_at = datetime('now') WHERE created_at IS NULL",
    );

    // 会话列表查询索引：加速 WHERE checkpoint_ns='' + ORDER BY created_at DESC
    // Session listing index: speeds up WHERE checkpoint_ns='' + ORDER BY created_at DESC
    this.db.run(
      "CREATE INDEX IF NOT EXISTS idx_checkpoints_ns_created ON checkpoints(checkpoint_ns, created_at)",
    );

    this.isSetup = true;
  }

  /** 获取单个检查点元组 / Get single checkpoint tuple */
  async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    this.setup();
    const threadId = config.configurable?.thread_id;
    const checkpointNs = String(config.configurable?.checkpoint_ns ?? "");
    const checkpointId = config.configurable?.checkpoint_id;
    if (!threadId) {
      return undefined;
    }

    // 指定 checkpoint_id 则精确查询，否则取最新 / Query by checkpoint_id if specified, otherwise get latest
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

    // 未指定 checkpoint_id 时回退为查询结果中的最新记录 / Fallback to latest when checkpoint_id not specified
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
    // v3 到 v4 待发送数据迁移 / Migrate pending sends from v3 to v4
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

  /** 枚举线程最近 N 个 checkpoint 及首条用户消息摘要 / List recent checkpoints with first user message summary */
  async listCheckpoints(
    threadId: string,
    limit: number = 20,
  ): Promise<CheckpointEntry[]> {
    this.setup();
    const rows = this.db
      .query<CheckpointRow, [string, number]>(
        `select checkpoint_id, parent_checkpoint_id, type, checkpoint, created_at
         from checkpoints
         where thread_id = ? and checkpoint_ns = ''
         order by checkpoint_id desc
         limit ?`,
      )
      .all(threadId, limit);

    const entries: CheckpointEntry[] = [];
    for (const row of rows) {
      let firstUserMessage = "";
      try {
        const checkpoint = await this.serde.loadsTyped(row.type ?? "json", row.checkpoint);
        const messages = checkpoint.channel_values?.messages as Array<{ lc_id?: string[]; id?: string[]; content?: unknown }> | undefined;
        if (Array.isArray(messages)) {
          for (const msg of messages) {
            const type = msg.lc_id?.[2] ?? msg.id?.[2] ?? "";
            if (type === "HumanMessage") {
              const content = typeof msg.content === "string" ? msg.content : "";
              firstUserMessage = content;
              break;
            }
          }
        }
      } catch { /* skip unparseable checkpoints */ }

      entries.push({
        checkpointId: row.checkpoint_id,
        parentCheckpointId: row.parent_checkpoint_id,
        createdAt: row.created_at ?? "",
        firstUserMessage,
      });
    }
    return entries;
  }

  async getCheckpointState(
    threadId: string,
    checkpointId: string,
  ): Promise<Partial<import("@/core/harness/state").CodeAgentState> | null> {
    this.setup();
    const tuple = await this.getTuple({
      configurable: { thread_id: threadId, checkpoint_id: checkpointId },
    });
    if (!tuple || !tuple.checkpoint?.channel_values) return null;

    const cv = tuple.checkpoint.channel_values;
    return {
      messages: (cv.messages as import("@langchain/core/messages").BaseMessage[]) ?? [],
      workspaceAccess: cv.workspaceAccess as import("@/core/harness/state").CodeAgentState["workspaceAccess"] ?? "write",
      phase: cv.phase as import("@/core/harness/state").CodeAgentState["phase"] ?? "building",
      plan: (cv.plan as import("@/core/harness/state").CodeAgentState["plan"]) ?? null,
      authorization: cv.authorization as import("@/core/harness/state").CodeAgentState["authorization"],
    };
  }

  /** 列出检查点，支持分页和过滤 / List checkpoints with pagination and filtering */
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
    const hasLimit = options.limit != null && Number.isFinite(options.limit);
    const limitClause = hasLimit ? " limit ?" : "";
    if (hasLimit) {
      args.push(String(Math.trunc(options.limit!)));
    }
    const rows = this.db
      .query<CheckpointRow, string[]>(
        `${selectCheckpointColumns()} from checkpoints ${where} order by checkpoint_id desc${limitClause}`,
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

  /** 存储检查点和元数据 / Store checkpoint and metadata */
  async put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata,
  ): Promise<RunnableConfig> {
    if (this.isClosed) return config; // silently skip — graph has been aborted
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

    try {
      this.db
        .query(
          `insert or replace into checkpoints
           (thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id, type, checkpoint, metadata, created_at)
           values (?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
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
    } catch (e) {
      throw new Error(
        `Failed to persist checkpoint for thread ${String(threadId)}, checkpoint ${checkpoint.id}: ${e instanceof Error ? e.message : String(e)}`,
        { cause: e },
      );
    }

    return {
      configurable: {
        thread_id: threadId,
        checkpoint_ns: checkpointNs,
        checkpoint_id: checkpoint.id,
      },
    };
  }

  /** 存储待写入数据 / Store pending writes */
  async putWrites(
    config: RunnableConfig,
    writes: PendingWrite[],
    taskId: string,
  ): Promise<void> {
    if (this.isClosed) return; // silently skip — graph has been aborted
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
    try {
      this.db.transaction(() => {
        for (const row of rows) {
          insert.run(...row);
        }
      })();
    } catch (e) {
      throw new Error(
        `Failed to persist writes for thread ${String(threadId)}, checkpoint ${String(checkpointId)}: ${e instanceof Error ? e.message : String(e)}`,
        { cause: e },
      );
    }
  }

  /** 删除整个线程的检查点 / Delete all checkpoints for a thread */
  async deleteThread(threadId: string): Promise<void> {
    this.setup();
    this.db.transaction(() => {
      this.db.query("delete from checkpoints where thread_id = ?").run(threadId);
      this.db.query("delete from writes where thread_id = ?").run(threadId);
    })();
  }

  /** 获取底层数据库实例（供 sessions 等模块直接查询）/ Get underlying database instance for direct queries */
  getDb(): Database {
    if (this.isClosed) throw new Error("Database is closed");
    this.setup();
    return this.db;
  }

  /** 关闭数据库连接 / Close database connection */
  close(): void {
    if (this.isClosed) return;
    this.isClosed = true;
    // WAL checkpoint 将 -wal 文件内容合并回主 DB，防止 WAL 无限增长
    // Merge WAL back into main DB to prevent unbounded WAL file growth
    try { this.db.run("PRAGMA wal_checkpoint(TRUNCATE)"); } catch { /* best-effort */ }
    this.db.close();
  }

  /** 获取检查点的待写入数据 / Get pending writes for a checkpoint */
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

  /** v3 到 v4 待发送数据迁移 / v3 to v4 pending sends migration */
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

/** 构建 checkpoint 查询 SQL / Build checkpoint query SQL */
function selectCheckpointSql(withCheckpointId: boolean): string {
  return `${selectCheckpointColumns()} from checkpoints
    where thread_id = ? and checkpoint_ns = ?
    ${withCheckpointId ? "and checkpoint_id = ?" : "order by checkpoint_id desc limit 1"}`;
}

/** 构建 checkpoint 查询列名 / Build checkpoint query column names */
function selectCheckpointColumns(): string {
  return `
    select
      thread_id,
      checkpoint_ns,
      checkpoint_id,
      parent_checkpoint_id,
      type,
      checkpoint,
      metadata,
      created_at`;
}
