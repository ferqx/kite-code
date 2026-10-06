import { createHash } from 'node:crypto';
import { closeSync, lstatSync, mkdirSync, openSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { isAbsolute, join, parse, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import {
  canonicalFileRecoveryIntent,
  parseFileRecoveryIntent,
} from '@kite-ai/client/file-recovery-intent';
import type {
  NativeCallerRecord,
  NativeCreation,
  NativeDraft,
  NativeRecoveryIntent,
} from '../src/native-bridge';
import {
  assertAnswerRecords,
  type NativeAnswerData,
  type NativeAnswerRecord,
  validateAnswerRecord,
} from './answer-journal';
import { callerCanonical, validateCallerRecord } from './caller-journal';
import {
  type NativeConfigurationData,
  type NativeConfigurationRecord,
  parseConfigurationRecord,
} from './configuration-journal';
import {
  assertFileRecoveryCommands,
  assertFileRecoveryTransition,
  fileRecoveryIntentId,
  fileRecoveryRow,
  type NativeFileRecoveryJournal,
  parseFileRecoveryRow,
} from './file-recovery-journal';
import {
  finishNativeMcpRecord,
  type NativeMcpData,
  type NativeMcpRecord,
  nativeMcpIdentity,
  parseNativeMcpRecord,
} from './mcp-journal';
import {
  attachDesktopProfileAccess,
  type DesktopProfileAccess,
  prepareWindowsPrivateUi,
  verifyWindowsPrivateUi,
} from './profile-access';
import { recoveryPending, validateRecoveryIntent } from './recovery-journal';

export type DraftScope = { storeId: string; workspaceId: string; rootSessionId: string };
export type PrivateData = NativeFileRecoveryJournal &
  NativeAnswerData & {
    read(scope: DraftScope): NativeDraft;
    save(scope: DraftScope, revision: number, content: string): NativeDraft;
    list(after?: string): { drafts: Omit<NativeDraft, 'content'>[]; nextId: string | null };
    readId(id: string): NativeDraft;
    creations(): NativeCreation[];
    begin(input: NativeCreation['input']): { created: boolean; value: NativeCreation };
    finish(commandId: string, phase: NativeCreation['phase'], code?: string): NativeCreation;
    recoveries(): NativeRecoveryIntent[];
    beginRecovery(input: NativeRecoveryIntent): { created: boolean; value: NativeRecoveryIntent };
    finishRecovery(
      commandId: string,
      phase: NativeRecoveryIntent['phase'],
      error?: string,
    ): NativeRecoveryIntent;
    callers(): NativeCallerRecord[];
    beginCaller(input: NativeCallerRecord): { created: boolean; value: NativeCallerRecord };
    finishCaller(commandId: string, phase: NativeCallerRecord['phase']): NativeCallerRecord;
    clearCaller(commandId: string): void;
    close(): void;
  } & NativeConfigurationData &
  NativeMcpData;
const require = createRequire(import.meta.url);
const identity = (scope: DraftScope) =>
  createHash('sha256').update(JSON.stringify(scope)).digest('hex');
function failure(): never {
  throw Error('draft_storage_unavailable');
}

/** Node-only UI user data, never a substitute for Service command authority. */
export function openPrivateData(profilePath: string, access: DesktopProfileAccess): PrivateData {
  const releaseAccess = attachDesktopProfileAccess(access, profilePath);
  let db: DatabaseSync | undefined;
  try {
    if (!isAbsolute(profilePath)) failure();
    let path: string;
    if (process.platform === 'win32') {
      prepareWindowsPrivateUi(access);
      path = join(realpathSync(profilePath), 'desktop-private', 'data.sqlite');
    } else {
      // Walk all ancestors: no attacker-controlled symlink target is accepted as a private path.
      let cursor = parse(profilePath).root;
      for (const part of resolve(profilePath).slice(cursor.length).split('/')) {
        cursor = join(cursor, part);
        if (lstatSync(cursor).isSymbolicLink()) failure();
      }
      const directory = join(realpathSync(profilePath), 'desktop-private');
      try {
        mkdirSync(directory, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      const dir = lstatSync(directory);
      if (
        !dir.isDirectory() ||
        dir.isSymbolicLink() ||
        (dir.mode & 0o077) !== 0 ||
        dir.uid !== process.getuid?.()
      )
        failure();
      path = join(directory, 'data.sqlite');
      try {
        const fd = openSync(path, 'wx', 0o600);
        closeSync(fd);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      for (const suffix of ['', '-wal', '-shm', '-journal']) {
        try {
          const stat = lstatSync(path + suffix);
          if (
            !stat.isFile() ||
            stat.nlink !== 1 ||
            stat.isSymbolicLink() ||
            (stat.mode & 0o077) !== 0 ||
            stat.uid !== process.getuid?.()
          )
            failure();
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      }
    }
    const SQLite = require('node:sqlite') as typeof import('node:sqlite');
    db = new SQLite.DatabaseSync(path);
    db.exec('PRAGMA busy_timeout=1000;');
    const version = (db.prepare('PRAGMA user_version').get() as { user_version: number })
      .user_version;
    if (
      version !== 0 &&
      version !== 1 &&
      version !== 2 &&
      version !== 3 &&
      version !== 4 &&
      version !== 5 &&
      version !== 6 &&
      version !== 7
    )
      failure();
    if (
      version !== 0 &&
      Number(db.prepare('PRAGMA application_id').get()!.application_id) !== 1263888689
    )
      failure();
    if (version === 0) {
      // Existing nonempty databases of another application are never treated as empty UI stores.
      if (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().length) failure();
      db.exec(`BEGIN IMMEDIATE;
        CREATE TABLE drafts(id TEXT PRIMARY KEY, store_id TEXT NOT NULL, workspace_id TEXT NOT NULL, root_session_id TEXT NOT NULL, revision INTEGER NOT NULL, content TEXT NOT NULL);
        CREATE TABLE creations(command_id TEXT PRIMARY KEY, input TEXT NOT NULL, phase TEXT NOT NULL, code TEXT);
        PRAGMA application_id=1263888689; PRAGMA user_version=1; COMMIT;`);
    }
    if (version < 2) {
      db.exec(
        'PRAGMA synchronous=FULL; BEGIN IMMEDIATE; CREATE TABLE recovery_intents(command_id TEXT PRIMARY KEY,state TEXT NOT NULL); PRAGMA user_version=2; COMMIT;',
      );
    }
    if (version < 3)
      db.exec(
        'PRAGMA synchronous=FULL; BEGIN IMMEDIATE; CREATE TABLE caller_intents(command_id TEXT PRIMARY KEY,state TEXT NOT NULL); PRAGMA user_version=3; COMMIT;',
      );
    if (version < 4)
      db.exec(
        'PRAGMA synchronous=FULL; BEGIN IMMEDIATE; CREATE TABLE file_recovery_intents(intent_id TEXT PRIMARY KEY,state TEXT NOT NULL); PRAGMA user_version=4; COMMIT;',
      );
    if (version < 5)
      db.exec(
        'PRAGMA synchronous=FULL; BEGIN IMMEDIATE; CREATE TABLE answer_intents(command_id TEXT PRIMARY KEY,state TEXT NOT NULL); PRAGMA user_version=5; COMMIT;',
      );
    if (version < 6)
      db.exec(
        'PRAGMA synchronous=FULL; BEGIN IMMEDIATE; CREATE TABLE configuration_intents(command_id TEXT PRIMARY KEY,state TEXT NOT NULL); CREATE TABLE model_routes(store_id TEXT NOT NULL,session_id TEXT NOT NULL,model_id TEXT NOT NULL,PRIMARY KEY(store_id,session_id)); PRAGMA user_version=6; COMMIT;',
      );
    if (version < 7)
      db.exec(
        'PRAGMA synchronous=FULL; BEGIN IMMEDIATE; CREATE TABLE mcp_intents(command_id TEXT PRIMARY KEY,state TEXT NOT NULL); PRAGMA user_version=7; COMMIT;',
      );
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all()
      .map((row) => row.name);
    if (
      JSON.stringify(tables) !==
      JSON.stringify([
        'answer_intents',
        'caller_intents',
        'configuration_intents',
        'creations',
        'drafts',
        'file_recovery_intents',
        'mcp_intents',
        'model_routes',
        'recovery_intents',
      ])
    )
      failure();
    if (
      db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='answer_intents'").get()
        ?.sql !== 'CREATE TABLE answer_intents(command_id TEXT PRIMARY KEY,state TEXT NOT NULL)'
    )
      failure();
    const fileSchema = db
      .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='file_recovery_intents'")
      .get();
    if (
      fileSchema?.sql !==
      'CREATE TABLE file_recovery_intents(intent_id TEXT PRIMARY KEY,state TEXT NOT NULL)'
    )
      failure();
    db.prepare('SELECT command_id,state FROM caller_intents LIMIT 0').all();
    if (
      db
        .prepare(
          "SELECT sql FROM sqlite_master WHERE type='table' AND name='configuration_intents'",
        )
        .get()?.sql !==
        'CREATE TABLE configuration_intents(command_id TEXT PRIMARY KEY,state TEXT NOT NULL)' ||
      db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='model_routes'").get()
        ?.sql !==
        'CREATE TABLE model_routes(store_id TEXT NOT NULL,session_id TEXT NOT NULL,model_id TEXT NOT NULL,PRIMARY KEY(store_id,session_id))'
    )
      failure();
    db.prepare('SELECT command_id,state FROM recovery_intents LIMIT 0').all();
    if (
      db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='mcp_intents'").get()
        ?.sql !== 'CREATE TABLE mcp_intents(command_id TEXT PRIMARY KEY,state TEXT NOT NULL)'
    )
      failure();
    db.prepare(
      'SELECT id,store_id,workspace_id,root_session_id,revision,content FROM drafts LIMIT 0',
    ).all();
    db.prepare('SELECT command_id,input,phase,code FROM creations LIMIT 0').all();
    db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;');
    if (process.platform === 'win32') verifyWindowsPrivateUi(access);
  } catch {
    db?.close();
    db = undefined;
    releaseAccess();
  }
  const database = () => db ?? failure();
  function mcpRows(): NativeMcpRecord[] {
    const result: NativeMcpRecord[] = [];
    let bytes = 0;
    for (const row of database()
      .prepare(
        'SELECT command_id,state,hex(CAST(state AS BLOB)) AS state_hex FROM mcp_intents ORDER BY command_id',
      )
      .iterate()) {
      if (typeof row.state !== 'string' || typeof row.state_hex !== 'string')
        throw Error('mcp_storage_unavailable');
      const original = Buffer.from(row.state_hex, 'hex');
      const text = new TextDecoder('utf-8', { fatal: true }).decode(original);
      bytes += original.byteLength;
      if (
        text !== row.state ||
        Buffer.byteLength(text) !== original.byteLength ||
        bytes > 16777216 ||
        result.length >= 128
      )
        throw Error('mcp_storage_unavailable');
      const value = parseNativeMcpRecord(JSON.parse(text));
      if (value.request.commandId !== row.command_id) throw Error('mcp_storage_unavailable');
      result.push(value);
    }
    return result;
  }
  function configurationRows(): NativeConfigurationRecord[] {
    const result: NativeConfigurationRecord[] = [];
    let bytes = 0;
    for (const row of database()
      .prepare(
        'SELECT command_id,state,hex(CAST(state AS BLOB)) AS state_hex FROM configuration_intents ORDER BY command_id',
      )
      .iterate()) {
      if (typeof row.state !== 'string' || typeof row.state_hex !== 'string')
        throw Error('configuration_storage_unavailable');
      const text = new TextDecoder('utf-8', { fatal: true }).decode(
        Buffer.from(row.state_hex, 'hex'),
      );
      bytes += Buffer.byteLength(text);
      if (text !== row.state || bytes > 16777216 || result.length >= 128)
        throw Error('configuration_storage_unavailable');
      const record = parseConfigurationRecord(JSON.parse(text));
      if (
        record.input.commandId !== row.command_id ||
        !['unknown', 'submitting'].includes(record.state.phase)
      )
        throw Error('configuration_storage_unavailable');
      result.push(record);
    }
    return result;
  }
  function callerRows() {
    const rows: NativeCallerRecord[] = [];
    let bytes = 0;
    for (const row of database()
      .prepare('SELECT command_id,state FROM caller_intents ORDER BY command_id')
      .iterate()) {
      if (typeof row.state !== 'string') throw Error('caller_storage_unavailable');
      bytes += Buffer.byteLength(row.state);
      if (bytes > 16777216 || rows.length >= 128) throw Error('caller_capacity_exceeded');
      const value = validateCallerRecord(JSON.parse(row.state));
      if (value.intent.request.commandId !== row.command_id)
        throw Error('caller_storage_unavailable');
      rows.push(value);
    }
    return rows;
  }
  const callerBytes = () =>
    Number(
      database()
        .prepare('SELECT COALESCE(SUM(length(CAST(state AS BLOB))),0) AS n FROM caller_intents')
        .get()!.n,
    );
  function answerRows(): NativeAnswerRecord[] {
    const rows: NativeAnswerRecord[] = [];
    let bytes = 0;
    for (const raw of database()
      .prepare(
        'SELECT command_id,state,hex(CAST(state AS BLOB)) AS state_hex FROM answer_intents ORDER BY command_id',
      )
      .iterate()) {
      if (typeof raw.state !== 'string' || typeof raw.state_hex !== 'string')
        throw Error('answer_storage_unavailable');
      const original = Buffer.from(raw.state_hex, 'hex');
      const text = new TextDecoder('utf-8', { fatal: true }).decode(original);
      bytes += original.length;
      if (
        text !== raw.state ||
        Buffer.byteLength(text) !== original.length ||
        bytes > 16777216 ||
        rows.length >= 128
      )
        throw Error('answer_storage_unavailable');
      const record = validateAnswerRecord(JSON.parse(text));
      if (record.intent.request.commandId !== raw.command_id)
        throw Error('answer_storage_unavailable');
      rows.push(record);
    }
    assertAnswerRecords(rows);
    return rows;
  }
  function fileRows() {
    const rows: Record<string, unknown>[] = [];
    let bytes = 0;
    for (const row of database()
      .prepare(
        'SELECT intent_id,state,hex(CAST(state AS BLOB)) AS state_hex FROM file_recovery_intents ORDER BY intent_id',
      )
      .iterate()) {
      const value = row as Record<string, unknown>;
      bytes += Buffer.byteLength(fileRecoveryRow(value));
      if (rows.length >= 128 || bytes > 16777216) throw Error('file_recovery_capacity_exceeded');
      rows.push(value);
    }
    return rows;
  }
  function transaction<T>(action: () => T): T {
    const current = database();
    try {
      current.exec('BEGIN IMMEDIATE');
      const result = action();
      current.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        current.exec('ROLLBACK');
      } catch {}
      throw error;
    }
  }
  const draft = (row: Record<string, unknown>): NativeDraft => {
    const scope = {
      storeId: row.store_id,
      workspaceId: row.workspace_id,
      rootSessionId: row.root_session_id,
    };
    if (
      Object.values(scope).some(
        (value) => typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value),
      ) ||
      !Number.isSafeInteger(row.revision) ||
      Number(row.revision) < 1 ||
      row.id !== identity(scope as DraftScope)
    )
      failure();
    let content: unknown;
    try {
      content = JSON.parse(String(row.content));
    } catch {
      failure();
    }
    if (typeof content !== 'string' || Buffer.byteLength(content) > 1048576) failure();
    return {
      id: String(row.id),
      ...(scope as DraftScope),
      revision: Number(row.revision),
      content,
    };
  };
  const creation = (row: Record<string, unknown>): NativeCreation => {
    let input: NativeCreation['input'];
    try {
      input = JSON.parse(String(row.input));
    } catch {
      failure();
    }
    if (
      !input ||
      Object.keys(input).sort().join(',') !==
        'commandId,expectedStoreId,sessionId,title,workspaceId' ||
      [input.commandId, input.expectedStoreId, input.workspaceId, input.sessionId].some(
        (value) => typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value),
      ) ||
      input.commandId !== row.command_id ||
      typeof input.title !== 'string' ||
      Buffer.byteLength(input.title) > 8192 ||
      !['pending', 'unknown', 'created', 'rejected'].includes(String(row.phase)) ||
      (row.code !== null &&
        (typeof row.code !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(row.code)))
    )
      failure();
    return {
      input,
      phase: row.phase as NativeCreation['phase'],
      ...(row.code ? { code: String(row.code) } : {}),
    };
  };
  const read = (scope: DraftScope): NativeDraft => {
    const id = identity(scope),
      row = database().prepare('SELECT * FROM drafts WHERE id=?').get(id);
    return row ? draft(row) : { id, ...scope, revision: 0, content: '' };
  };
  const port: PrivateData = {
    configurations: configurationRows,
    saveConfiguration(input) {
      const record = parseConfigurationRecord(input);
      transaction(() => {
        const rows = configurationRows();
        const existing = rows.find((row) => row.input.commandId === record.input.commandId);
        if (
          existing &&
          (existing.kind !== record.kind ||
            JSON.stringify(existing.input) !== JSON.stringify(record.input))
        )
          throw Error('configuration_storage_unavailable');
        if (['applied', 'failed'].includes(record.state.phase)) {
          if (!existing) throw Error('configuration_storage_unavailable');
          database()
            .prepare('DELETE FROM configuration_intents WHERE command_id=?')
            .run(record.input.commandId);
          return;
        }
        const text = JSON.stringify(record);
        if (
          (!existing && rows.length >= 128) ||
          Buffer.byteLength(text) +
            rows.reduce(
              (total, row) =>
                total +
                (row.input.commandId === record.input.commandId
                  ? 0
                  : Buffer.byteLength(JSON.stringify(row))),
              0,
            ) >
            16777216
        )
          throw Error('configuration_storage_unavailable');
        database()
          .prepare(
            'INSERT INTO configuration_intents VALUES(?,?) ON CONFLICT(command_id) DO UPDATE SET state=excluded.state',
          )
          .run(record.input.commandId, text);
      });
    },
    modelRoute(storeId, sessionId) {
      const row = database()
        .prepare('SELECT model_id FROM model_routes WHERE store_id=? AND session_id=?')
        .get(storeId, sessionId);
      if (!row) return undefined;
      if (typeof row.model_id !== 'string' || !/^[A-Za-z0-9_.:/-]{1,128}$/.test(row.model_id))
        throw Error('configuration_storage_unavailable');
      return row.model_id;
    },
    rememberModelRoute(storeId, sessionId, modelId) {
      if (
        [storeId, sessionId].some((value) => !/^[A-Za-z0-9_-]{1,128}$/.test(value)) ||
        !/^[A-Za-z0-9_.:/-]{1,128}$/.test(modelId)
      )
        throw Error('configuration_storage_unavailable');
      database()
        .prepare(
          'INSERT INTO model_routes VALUES(?,?,?) ON CONFLICT(store_id,session_id) DO UPDATE SET model_id=excluded.model_id',
        )
        .run(storeId, sessionId, modelId);
    },
    read,
    save(scope, revision, content) {
      if (Buffer.byteLength(content) > 1048576) throw Error('draft_capacity_exceeded');
      return transaction(() => {
        const previous = read(scope);
        if (previous.revision !== revision) throw Error('draft_revision_conflict');
        if (!Number.isSafeInteger(revision + 1)) throw Error('draft_revision_conflict');
        database()
          .prepare(
            'INSERT INTO drafts VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,content=excluded.content',
          )
          .run(
            previous.id,
            scope.storeId,
            scope.workspaceId,
            scope.rootSessionId,
            revision + 1,
            JSON.stringify(content),
          );
        return { ...previous, content, revision: revision + 1 };
      });
    },
    list(after = '') {
      const rows = database()
        .prepare(
          'SELECT id,store_id,workspace_id,root_session_id,revision,\'""\' AS content FROM drafts WHERE id>? ORDER BY id LIMIT 101',
        )
        .all(after);
      return {
        drafts: rows.slice(0, 100).map((row) => {
          const { content: _content, ...summary } = draft(row);
          return summary;
        }),
        nextId: rows.length > 100 ? String(rows[99]!.id) : null,
      };
    },
    readId(id) {
      const row = database().prepare('SELECT * FROM drafts WHERE id=?').get(id);
      if (!row) throw Error('draft_not_found');
      return draft(row);
    },
    creations() {
      return database()
        .prepare(
          "SELECT * FROM creations WHERE phase IN ('pending','unknown') ORDER BY command_id LIMIT 128",
        )
        .all()
        .map(creation);
    },
    begin(input) {
      return transaction(() => {
        const row = database()
          .prepare('SELECT * FROM creations WHERE command_id=?')
          .get(input.commandId);
        if (row) {
          const value = creation(row);
          if (JSON.stringify(value.input) !== JSON.stringify(input))
            throw Error('creation_intent_conflict');
          return { created: false, value };
        }
        if (
          Number(
            database()
              .prepare("SELECT count(*) AS n FROM creations WHERE phase IN ('pending','unknown')")
              .get()!.n,
          ) >= 128
        )
          throw Error('creation_capacity_exceeded');
        database()
          .prepare('INSERT INTO creations VALUES(?,?,?,NULL)')
          .run(input.commandId, JSON.stringify(input), 'pending');
        return { created: true, value: { input, phase: 'pending' } };
      });
    },
    finish(commandId, phase, code) {
      return transaction(() => {
        const row = database().prepare('SELECT * FROM creations WHERE command_id=?').get(commandId);
        if (!row) throw Error('creation_intent_missing');
        const value = creation(row);
        if (value.phase === 'created' || value.phase === 'rejected') return value;
        database()
          .prepare('UPDATE creations SET phase=?,code=? WHERE command_id=?')
          .run(phase, code ?? null, commandId);
        return { input: value.input, phase, ...(code ? { code } : {}) };
      });
    },
    recoveries() {
      const unresolved: NativeRecoveryIntent[] = [];
      for (const row of database()
        .prepare('SELECT command_id,state FROM recovery_intents ORDER BY command_id')
        .iterate()) {
        const value = validateRecoveryIntent(JSON.parse(String(row.state)));
        if (value.commandId !== row.command_id) throw Error('recovery_storage_unavailable');
        if (recoveryPending(value)) {
          unresolved.push(value);
          if (unresolved.length > 128) throw Error('recovery_capacity_exceeded');
        }
      }
      return unresolved;
    },
    beginRecovery(input) {
      const value = validateRecoveryIntent(input);
      if (value.phase !== 'submitting') throw Error('recovery_intent_conflict');
      return transaction(() => {
        const row = database()
          .prepare('SELECT state FROM recovery_intents WHERE command_id=?')
          .get(value.commandId);
        if (row) {
          const original = validateRecoveryIntent(JSON.parse(String(row.state)));
          if (
            [
              'observationId',
              'storeId',
              'sessionId',
              'kind',
              'targetId',
              'originalCommandId',
              'commandId',
            ].some(
              (key) =>
                original[key as keyof NativeRecoveryIntent] !==
                value[key as keyof NativeRecoveryIntent],
            )
          )
            throw Error('recovery_intent_conflict');
          return { created: false, value: original };
        }
        const pending = database()
          .prepare(
            "SELECT state FROM recovery_intents WHERE json_extract(state,'$.phase') IN ('submitting','accepted','outcome_unknown')",
          )
          .all();
        if (pending.length >= 128) throw Error('recovery_capacity_exceeded');
        for (const row of pending) {
          const old = validateRecoveryIntent(JSON.parse(String(row.state)));
          if (
            old.storeId === value.storeId &&
            old.sessionId === value.sessionId &&
            recoveryPending(old)
          )
            throw Error('recovery_intent_pending');
        }
        database()
          .prepare('INSERT INTO recovery_intents VALUES(?,?)')
          .run(value.commandId, JSON.stringify(value));
        return { created: true, value };
      });
    },
    finishRecovery(commandId, phase, error) {
      return transaction(() => {
        const row = database()
          .prepare('SELECT state FROM recovery_intents WHERE command_id=?')
          .get(commandId);
        if (!row) throw Error('recovery_intent_missing');
        const original = validateRecoveryIntent(JSON.parse(String(row.state)));
        if (!recoveryPending(original)) return original;
        const { error: previousError, ...identity } = original;
        const value = validateRecoveryIntent({ ...identity, phase, ...(error ? { error } : {}) });
        database()
          .prepare('UPDATE recovery_intents SET state=? WHERE command_id=?')
          .run(JSON.stringify(value), commandId);
        return value;
      });
    },
    answers() {
      return answerRows();
    },
    beginAnswer(input) {
      const value = validateAnswerRecord(input);
      if (value.phase !== 'submitting') throw Error('answer_intent_conflict');
      return transaction(() => {
        const rows = answerRows(),
          old = rows.find((row) => row.intent.request.commandId === value.intent.request.commandId);
        if (old) {
          if (callerCanonical(old.intent) !== callerCanonical(value.intent))
            throw Error('answer_intent_conflict');
          return { created: false, value: old };
        }
        assertAnswerRecords([...rows, value]);
        if (
          rows.length >= 128 ||
          rows.reduce((sum, row) => sum + Buffer.byteLength(JSON.stringify(row)), 0) +
            Buffer.byteLength(JSON.stringify(value)) >
            16777216
        )
          throw Error('answer_capacity_exceeded');
        database()
          .prepare('INSERT INTO answer_intents VALUES(?,?)')
          .run(value.intent.request.commandId, JSON.stringify(value));
        return { created: true, value };
      });
    },
    finishAnswer(commandId, phase) {
      return transaction(() => {
        const rows = answerRows(),
          old = rows.find((row) => row.intent.request.commandId === commandId);
        if (!old) throw Error('answer_intent_missing');
        const value = validateAnswerRecord({ ...old, phase });
        if (
          rows.reduce((sum, row) => sum + Buffer.byteLength(JSON.stringify(row)), 0) -
            Buffer.byteLength(JSON.stringify(old)) +
            Buffer.byteLength(JSON.stringify(value)) >
          16777216
        )
          throw Error('answer_capacity_exceeded');
        database()
          .prepare('UPDATE answer_intents SET state=? WHERE command_id=?')
          .run(JSON.stringify(value), commandId);
        return value;
      });
    },
    callers() {
      return callerRows();
    },
    mcps() {
      return mcpRows();
    },
    beginMcp(input) {
      const value = parseNativeMcpRecord(input);
      if (value.phase !== 'submitting') throw Error('mcp_intent_conflict');
      return transaction(() => {
        const rows = mcpRows(),
          old = rows.find((row) => row.request.commandId === value.request.commandId);
        if (old) {
          if (nativeMcpIdentity(old) !== nativeMcpIdentity(value))
            throw Error('mcp_intent_conflict');
          return { created: false, value: old };
        }
        const bytes = database()
          .prepare('SELECT coalesce(sum(length(CAST(state AS BLOB))),0) AS total FROM mcp_intents')
          .get()?.total;
        if (
          rows.length >= 128 ||
          typeof bytes !== 'number' ||
          bytes + Buffer.byteLength(JSON.stringify(value)) > 16777216
        )
          throw Error('mcp_capacity_exceeded');
        database()
          .prepare('INSERT INTO mcp_intents VALUES(?,?)')
          .run(value.request.commandId, JSON.stringify(value));
        return { created: true, value };
      });
    },
    finishMcp(commandId, phase) {
      return transaction(() => {
        const old = mcpRows().find((row) => row.request.commandId === commandId);
        if (!old) throw Error('mcp_intent_missing');
        const value = finishNativeMcpRecord(old, phase);
        const size = database()
          .prepare('SELECT coalesce(sum(length(CAST(state AS BLOB))),0) AS total FROM mcp_intents')
          .get()?.total;
        const previousSize = database()
          .prepare(
            'SELECT length(CAST(state AS BLOB)) AS bytes FROM mcp_intents WHERE command_id=?',
          )
          .get(commandId)?.bytes;
        if (
          typeof size !== 'number' ||
          typeof previousSize !== 'number' ||
          size - previousSize + Buffer.byteLength(JSON.stringify(value)) > 16777216
        )
          throw Error('mcp_capacity_exceeded');
        database()
          .prepare('UPDATE mcp_intents SET state=? WHERE command_id=?')
          .run(JSON.stringify(value), commandId);
        return value;
      });
    },
    clearMcp(commandId) {
      transaction(() => {
        const old = mcpRows().find((row) => row.request.commandId === commandId);
        if (!old || !['completed', 'failed', 'cancelled'].includes(old.phase))
          throw Error('mcp_clear_unconfirmed');
        database().prepare('DELETE FROM mcp_intents WHERE command_id=?').run(commandId);
      });
    },
    beginCaller(input) {
      const value = validateCallerRecord(input);
      if (value.phase !== 'submitting') throw Error('caller_intent_conflict');
      return transaction(() => {
        const rows = callerRows(),
          old = rows.find((r) => r.intent.request.commandId === value.intent.request.commandId);
        if (old) {
          if (callerCanonical(old.intent) !== callerCanonical(value.intent))
            throw Error('caller_intent_conflict');
          return { created: false, value: old };
        }
        if (
          rows.length >= 128 ||
          callerBytes() + Buffer.byteLength(JSON.stringify(value)) > 16777216
        )
          throw Error('caller_capacity_exceeded');
        database()
          .prepare('INSERT INTO caller_intents VALUES(?,?)')
          .run(value.intent.request.commandId, JSON.stringify(value));
        return { created: true, value };
      });
    },
    finishCaller(commandId, phase) {
      return transaction(() => {
        const rows = callerRows(),
          old = rows.find((r) => r.intent.request.commandId === commandId);
        if (!old) throw Error('caller_intent_missing');
        if (['applied', 'rejected'].includes(old.phase)) return old;
        const value = validateCallerRecord({ ...old, phase });
        if (
          callerBytes() -
            Buffer.byteLength(
              String(
                database()
                  .prepare('SELECT state FROM caller_intents WHERE command_id=?')
                  .get(commandId)!.state,
              ),
            ) +
            Buffer.byteLength(JSON.stringify(value)) >
          16777216
        )
          throw Error('caller_capacity_exceeded');
        database()
          .prepare('UPDATE caller_intents SET state=? WHERE command_id=?')
          .run(JSON.stringify(value), commandId);
        return value;
      });
    },
    clearCaller(commandId) {
      transaction(() => {
        const old = callerRows().find((r) => r.intent.request.commandId === commandId);
        if (!old || !['applied', 'rejected'].includes(old.phase))
          throw Error('caller_clear_unconfirmed');
        database().prepare('DELETE FROM caller_intents WHERE command_id=?').run(commandId);
      });
    },
    async fileRecoveries() {
      const rows = fileRows();
      const values = await Promise.all(rows.map(parseFileRecoveryRow));
      assertFileRecoveryCommands(values);
      // Digest work owns no SQL transaction. Close/release during await denies this read.
      database();
      return values;
    },
    async prepareFileRecovery(input) {
      const value = await parseFileRecoveryIntent(input);
      if (
        (value.code?.phase !== undefined && value.code.phase !== 'not_started') ||
        (value.fork?.phase !== undefined && value.fork.phase !== 'not_started')
      )
        throw Error('file_recovery_intent_conflict');
      const rows = fileRows(),
        validated = await Promise.all(rows.map(parseFileRecoveryRow));
      assertFileRecoveryCommands(validated);
      return transaction(() => {
        const current = fileRows();
        if (JSON.stringify(current) !== JSON.stringify(rows))
          throw Error('file_recovery_intent_conflict');
        const id = fileRecoveryIntentId(value),
          old = validated.find((item) => fileRecoveryIntentId(item) === id);
        if (old) {
          if (canonicalFileRecoveryIntent(old) !== canonicalFileRecoveryIntent(value))
            throw Error('file_recovery_intent_conflict');
          return { created: false, value: old };
        }
        assertFileRecoveryCommands([...validated, value]);
        const state = JSON.stringify(value);
        if (
          current.length >= 128 ||
          current.reduce((sum, row) => sum + Buffer.byteLength(fileRecoveryRow(row)), 0) +
            Buffer.byteLength(state) >
            16777216
        )
          throw Error('file_recovery_capacity_exceeded');
        database().prepare('INSERT INTO file_recovery_intents VALUES(?,?)').run(id, state);
        return { created: true, value };
      });
    },
    async updateFileRecovery(input, expected) {
      const value = await parseFileRecoveryIntent(input),
        previous = await parseFileRecoveryIntent(expected);
      assertFileRecoveryTransition(previous, value);
      const id = fileRecoveryIntentId(value),
        rows = fileRows(),
        validated = await Promise.all(rows.map(parseFileRecoveryRow));
      assertFileRecoveryCommands(validated);
      const original = validated.find((item) => fileRecoveryIntentId(item) === id),
        originalRow = rows.find((row) => row.intent_id === id);
      if (!original || !originalRow) throw Error('file_recovery_intent_missing');
      if (
        canonicalFileRecoveryIntent(original) !== canonicalFileRecoveryIntent(previous) ||
        original.code?.phase !== previous.code?.phase ||
        original.fork?.phase !== previous.fork?.phase
      )
        throw Error('file_recovery_phase_conflict');
      return transaction(() => {
        // database() proves the same attached Profile lease is still live; it cannot be closed externally while attached.
        const current = fileRows(),
          found = current.find((row) => row.intent_id === id);
        if (!found || fileRecoveryRow(found) !== fileRecoveryRow(originalRow))
          throw Error('file_recovery_phase_conflict');
        const state = JSON.stringify(value);
        if (
          current.reduce((sum, row) => sum + Buffer.byteLength(fileRecoveryRow(row)), 0) -
            Buffer.byteLength(fileRecoveryRow(found)) +
            Buffer.byteLength(state) >
          16777216
        )
          throw Error('file_recovery_capacity_exceeded');
        database()
          .prepare('UPDATE file_recovery_intents SET state=? WHERE intent_id=?')
          .run(state, id);
        return value;
      });
    },
    close() {
      db?.close();
      db = undefined;
      releaseAccess();
    },
  };
  const localCodes = new Set([
    'mcp_storage_unavailable',
    'mcp_capacity_exceeded',
    'mcp_intent_conflict',
    'mcp_intent_missing',
    'mcp_clear_unconfirmed',
    'configuration_storage_unavailable',
    'file_recovery_intent_invalid',
    'file_recovery_storage_unavailable',
    'file_recovery_capacity_exceeded',
    'file_recovery_intent_conflict',
    'file_recovery_phase_conflict',
    'file_recovery_intent_missing',
    'answer_storage_unavailable',
    'answer_capacity_exceeded',
    'answer_intent_conflict',
    'answer_intent_missing',
    'caller_storage_unavailable',
    'caller_capacity_exceeded',
    'caller_intent_conflict',
    'caller_intent_missing',
    'caller_clear_unconfirmed',
    'draft_storage_unavailable',
    'draft_capacity_exceeded',
    'draft_revision_conflict',
    'draft_not_found',
    'creation_intent_conflict',
    'creation_capacity_exceeded',
    'creation_intent_missing',
    'recovery_storage_unavailable',
    'recovery_intent_conflict',
    'recovery_capacity_exceeded',
    'recovery_intent_pending',
    'recovery_intent_missing',
  ]);
  return new Proxy(port, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        try {
          const result = Reflect.apply(value, target, args);
          return result instanceof Promise
            ? result.catch((error: unknown) => {
                if (error instanceof Error && localCodes.has(error.message)) throw error;
                failure();
              })
            : result;
        } catch (error) {
          if (error instanceof Error && localCodes.has(error.message)) throw error;
          failure();
        }
      };
    },
  });
}
