import { Database, constants as sqlConstants } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
import { chmodSync, closeSync, existsSync, fstatSync, lstatSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { canonicalJson } from '../json';
import { initializeDefaultSqliteEngine } from '../sqlite-engine';
import { verifyCallerIntentsDocument } from './caller-intents';
import { verifyDesktopAnswerRows } from './desktop-answers';
import { verifyDesktopCallerRows } from './desktop-callers';
import {
  verifyDesktopFileRecoveryRows,
  verifyFileRecoveryIntentsDocument,
} from './file-recovery-intents';
import {
  copyAssetFile,
  fingerprint,
  openPrivate,
  privateDirectory,
  syncDirectory,
  syncFile,
  withPrivateDatabaseSnapshot,
} from './files';
import { verifyMcpConnectionIntentsDocument } from './mcp-connection-intents';
import { verifyMcpReconnectionIntentsDocument } from './mcp-reconnection-intents';
import { verifyMcpSelectionIntentsDocument } from './mcp-selection-intents';
import { verifyMcpSourceApprovalIntentsDocument } from './mcp-source-approval-intents';
import { verifyMcpSourceMutationIntentsDocument } from './mcp-source-mutation-intents';
import { verifyTuiDocument } from './tui';
import { type BackupManifest, type CapturedAsset, MaintenanceError } from './types';

const uiSchema = [
  [
    'creations',
    'CREATE TABLE creations(command_id TEXT PRIMARY KEY, input TEXT NOT NULL, phase TEXT NOT NULL, code TEXT)',
  ],
  [
    'drafts',
    'CREATE TABLE drafts(id TEXT PRIMARY KEY, store_id TEXT NOT NULL, workspace_id TEXT NOT NULL, root_session_id TEXT NOT NULL, revision INTEGER NOT NULL, content TEXT NOT NULL)',
  ],
] as const;
const recoverySchema = [
  'recovery_intents',
  'CREATE TABLE recovery_intents(command_id TEXT PRIMARY KEY,state TEXT NOT NULL)',
] as const;
const callerSchema = [
  'caller_intents',
  'CREATE TABLE caller_intents(command_id TEXT PRIMARY KEY,state TEXT NOT NULL)',
] as const;
const fileRecoverySchema = [
  'file_recovery_intents',
  'CREATE TABLE file_recovery_intents(intent_id TEXT PRIMARY KEY,state TEXT NOT NULL)',
] as const;
const answerSchema = [
  'answer_intents',
  'CREATE TABLE answer_intents(command_id TEXT PRIMARY KEY,state TEXT NOT NULL)',
] as const;
function verifyRecoveryRows(db: Database) {
  let pending = 0;
  const scopes = new Set<string>();
  const id = (value: unknown) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
  for (const row of db
    .query<{ command_id: string; state: string }, []>(
      'SELECT command_id,state FROM recovery_intents',
    )
    .iterate()) {
    try {
      if (typeof row.state !== 'string' || Buffer.byteLength(row.state) > 8192) throw Error();
      const value = JSON.parse(row.state);
      if (
        !value ||
        typeof value !== 'object' ||
        Array.isArray(value) ||
        Object.keys(value).some(
          (key) =>
            ![
              'observationId',
              'storeId',
              'sessionId',
              'kind',
              'targetId',
              'originalCommandId',
              'commandId',
              'phase',
              'error',
            ].includes(key),
        ) ||
        !Number.isSafeInteger(value.observationId) ||
        value.observationId < 1 ||
        ![value.storeId, value.sessionId, value.commandId].every(id) ||
        value.commandId !== row.command_id ||
        !['run', 'report', 'interrupt'].includes(value.kind) ||
        ![
          'submitting',
          'accepted',
          'resumed',
          'interrupted',
          'suppressed',
          'failed',
          'outcome_unknown',
        ].includes(value.phase) ||
        (value.error !== undefined &&
          (typeof value.error !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(value.error))) ||
        (value.kind === 'interrupt'
          ? value.targetId !== undefined || value.originalCommandId !== undefined
          : !id(value.targetId) ||
            !id(value.originalCommandId) ||
            (value.kind === 'report' && value.originalCommandId !== value.targetId))
      )
        throw Error();
      if (['submitting', 'accepted', 'outcome_unknown'].includes(value.phase)) {
        const scope = JSON.stringify([value.storeId, value.sessionId]);
        if (++pending > 128 || scopes.has(scope)) throw Error();
        scopes.add(scope);
      }
    } catch {
      throw new MaintenanceError('backup_ui_invalid');
    }
  }
}
const compact = (sql: string) => sql.replace(/\s/g, '').toLowerCase();
function present(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') return false;
    throw error;
  }
}
function uiFiles(path: string, signal?: AbortSignal) {
  return ['', '-wal'].map((suffix) =>
    present(path + suffix) ? fingerprint(path + suffix, signal) : null,
  );
}
export function openUiDatabase(path: string): Database {
  privateDirectory(dirname(path));
  closeSync(openPrivate(path));
  for (const suffix of ['-wal', '-shm'])
    if (present(path + suffix)) closeSync(openPrivate(path + suffix));
  if (present(`${path}-journal`)) throw new MaintenanceError('backup_ui_journal_present');
  initializeDefaultSqliteEngine();
  const db = new Database(
    path,
    sqlConstants.SQLITE_OPEN_READONLY | sqlConstants.SQLITE_OPEN_NOFOLLOW,
  );
  try {
    db.run('PRAGMA busy_timeout=100');
    const actual = db
      .query<{ name: string; sql: string }, []>(
        "SELECT name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all();
    const version = db
      .query<{ user_version: number }, []>('PRAGMA user_version')
      .get()?.user_version;
    const schema =
      version === 5
        ? [answerSchema, callerSchema, ...uiSchema, fileRecoverySchema, recoverySchema]
        : version === 4
          ? [callerSchema, ...uiSchema, fileRecoverySchema, recoverySchema]
          : version === 3
            ? [callerSchema, ...uiSchema, recoverySchema]
            : version === 2
              ? [...uiSchema, recoverySchema]
              : uiSchema;
    if (
      db.query<{ application_id: number }, []>('PRAGMA application_id').get()?.application_id !==
        1263888689 ||
      (version !== 1 && version !== 2 && version !== 3 && version !== 4 && version !== 5) ||
      actual.length !== schema.length ||
      actual.some(
        (row, i) =>
          row.name !== schema[i]![0] ||
          typeof row.sql !== 'string' ||
          compact(row.sql) !== compact(schema[i]![1]),
      )
    )
      throw new MaintenanceError('backup_ui_incompatible');
    if (
      db.query<{ integrity_check: string }, []>('PRAGMA integrity_check(1)').get()
        ?.integrity_check !== 'ok' ||
      db.query('SELECT * FROM pragma_foreign_key_check LIMIT 1').get()
    )
      throw new MaintenanceError('backup_ui_invalid');
    if (version === 2 || version === 3 || version === 4 || version === 5) verifyRecoveryRows(db);
    if (version === 3 || version === 4 || version === 5) verifyDesktopCallerRows(db);
    if (version === 4 || version === 5) verifyDesktopFileRecoveryRows(db);
    if (version === 5) verifyDesktopAnswerRows(db);
    return db;
  } catch (error) {
    db.close(true);
    throw error;
  }
}
/** Frozen caller metadata v1; original Store/Session associations are not execution authority. */
export function verifyRecoveryDocument(path: string) {
  privateDirectory(dirname(path));
  const fd = openPrivate(path);
  try {
    if (fstatSync(fd).size > 262144) throw Error();
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(fd)));
    const closed = (value: unknown, keys: string[]): value is Record<string, unknown> =>
      !!value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      Object.keys(value).sort().join(',') === keys.sort().join(',');
    const id = (value: unknown) =>
      typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
    if (
      !closed(value, ['version', 'records']) ||
      value.version !== 1 ||
      !Array.isArray(value.records) ||
      value.records.length > 128
    )
      throw Error();
    const ids = new Set<unknown>();
    for (const row of value.records) {
      if (
        !closed(row, ['intent', 'phase']) ||
        typeof row.phase !== 'string' ||
        ![
          'submitting',
          'accepted',
          'resumed',
          'interrupted',
          'suppressed',
          'failed',
          'outcome_unknown',
        ].includes(row.phase as string)
      )
        throw Error();
      const intent = row.intent;
      if (!intent || typeof intent !== 'object' || Array.isArray(intent)) throw Error();
      const kind = (intent as Record<string, unknown>).kind;
      if (
        typeof kind !== 'string' ||
        !['run', 'report', 'interrupt'].includes(kind) ||
        !closed(
          intent,
          kind === 'report'
            ? ['kind', 'sessionId', 'reportCommandId', 'request']
            : ['kind', 'sessionId', 'request'],
        ) ||
        !id(intent.sessionId) ||
        (kind === 'report' && !id(intent.reportCommandId))
      )
        throw Error();
      const request = intent.request;
      if (
        !closed(
          request,
          kind === 'report'
            ? ['expectedStoreId', 'commandId']
            : kind === 'run'
              ? ['kind', 'expectedStoreId', 'commandId', 'runId']
              : ['kind', 'expectedStoreId', 'commandId', 'decision'],
        ) ||
        !id(request.expectedStoreId) ||
        !id(request.commandId) ||
        ids.has(request.commandId) ||
        (kind === 'run' && (request.kind !== 'run.resume' || !id(request.runId))) ||
        (kind === 'interrupt' &&
          (request.kind !== 'session.recover' || request.decision !== 'interrupt'))
      )
        throw Error();
      ids.add(request.commandId);
    }
  } catch (error) {
    if (error instanceof MaintenanceError) throw error;
    throw new MaintenanceError('backup_recovery_invalid');
  } finally {
    closeSync(fd);
  }
}
export async function captureAssets(
  source: string,
  target: string,
  signal?: AbortSignal,
): Promise<BackupManifest['assets']> {
  const capture = async (path: CapturedAsset['path'], ui: boolean): Promise<CapturedAsset> => {
    const capturedAt = new Date().toISOString(),
      original = join(source, path);
    if (!present(original)) return { path, capturedAt, present: false, proof: null };
    const destination = join(target, path);
    if (!ui) {
      if (path === 'ui/tui.json') verifyTuiDocument(original);
      if (path === 'ui/recovery.json') verifyRecoveryDocument(original);
      if (path === 'ui/caller-intents.json') verifyCallerIntentsDocument(original);
      if (path === 'ui/file-recovery-intents.json') verifyFileRecoveryIntentsDocument(original);
      if (path === 'ui/mcp-selection-intents.json') verifyMcpSelectionIntentsDocument(original);
      if (path === 'ui/mcp-connection-intents.json') verifyMcpConnectionIntentsDocument(original);
      if (path === 'ui/mcp-source-approval-intents.json')
        verifyMcpSourceApprovalIntentsDocument(original);
      if (path === 'ui/mcp-reconnection-intents.json')
        verifyMcpReconnectionIntentsDocument(original);
      const asset = {
        path,
        capturedAt,
        present: true,
        proof: await copyAssetFile(original, destination, signal),
      };
      if (path === 'ui/tui.json') verifyTuiDocument(destination);
      if (path === 'ui/recovery.json') verifyRecoveryDocument(destination);
      if (path === 'ui/caller-intents.json') verifyCallerIntentsDocument(destination);
      if (path === 'ui/file-recovery-intents.json') verifyFileRecoveryIntentsDocument(destination);
      if (path === 'ui/mcp-selection-intents.json') verifyMcpSelectionIntentsDocument(destination);
      if (path === 'ui/mcp-connection-intents.json')
        verifyMcpConnectionIntentsDocument(destination);
      if (path === 'ui/mcp-reconnection-intents.json')
        verifyMcpReconnectionIntentsDocument(destination);
      return asset;
    }
    privateDirectory(dirname(original));
    const before = uiFiles(original, signal);
    for (const suffix of ['-wal', '-shm'])
      if (present(original + suffix)) closeSync(openPrivate(original + suffix));
    if (present(`${original}-journal`)) throw new MaintenanceError('backup_ui_journal_present');
    privateDirectory(dirname(destination), true);
    await withPrivateDatabaseSnapshot(
      original,
      join(target, `.ui-source-${randomUUID()}`),
      (databasePath) => {
        const db = openUiDatabase(databasePath);
        try {
          db.query('VACUUM INTO ?').run(destination);
        } finally {
          db.close(true);
        }
      },
      signal,
    );
    chmodSync(destination, 0o600);
    initializeDefaultSqliteEngine();
    const normalize = new Database(
      destination,
      sqlConstants.SQLITE_OPEN_READWRITE | sqlConstants.SQLITE_OPEN_NOFOLLOW,
    );
    try {
      if (
        normalize.query<{ journal_mode: string }, []>('PRAGMA journal_mode=DELETE').get()
          ?.journal_mode !== 'delete'
      )
        throw new MaintenanceError('backup_ui_invalid');
    } finally {
      normalize.close(true);
    }
    const candidate = openUiDatabase(destination);
    candidate.close(true);
    if (canonicalJson(uiFiles(original, signal)) !== canonicalJson(before))
      throw new MaintenanceError('backup_content_changed');
    syncFile(destination);
    syncDirectory(dirname(destination));
    return { path, capturedAt, present: true, proof: fingerprint(destination, signal) };
  };
  const desktopUi = await capture('desktop-private/data.sqlite', true);
  const tuiUi = await capture('ui/tui.json', false);
  const tuiRecovery = await capture('ui/recovery.json', false);
  const callerIntents = await capture('ui/caller-intents.json', false);
  const fileRecoveryIntents = await capture('ui/file-recovery-intents.json', false);
  const mcpSourceMutationIntents = await capture('ui/mcp-source-mutation-intents.json', false);
  const mcpReconnectionIntents = await capture('ui/mcp-reconnection-intents.json', false);
  const mcpSourceApprovalIntents = await capture('ui/mcp-source-approval-intents.json', false);
  const mcpConnectionIntents = await capture('ui/mcp-connection-intents.json', false);
  const mcpSelectionIntents = await capture('ui/mcp-selection-intents.json', false);
  let uiVersion: 1 | 2 | 3 | 4 | 5 | undefined;
  if (desktopUi.present) {
    const db = openUiDatabase(join(target, desktopUi.path));
    try {
      uiVersion = db
        .query<{ user_version: 1 | 2 | 3 | 4 | 5 }, []>('PRAGMA user_version')
        .get()!.user_version;
    } finally {
      db.close(true);
    }
  }
  return {
    configuration: await capture('config.jsonc', false),
    skillWorkflowConfiguration: await capture('skill-workflow.jsonc', false),
    desktopUi: {
      ...desktopUi,
      format: desktopUi.present ? { applicationId: 1263888689, userVersion: uiVersion! } : null,
    },
    tuiUi: { ...tuiUi, format: tuiUi.present ? { version: 1 } : null },
    tuiRecovery: { ...tuiRecovery, format: tuiRecovery.present ? { version: 1 } : null },
    callerIntents: { ...callerIntents, format: callerIntents.present ? { version: 1 } : null },
    ...(fileRecoveryIntents.present ||
    mcpSelectionIntents.present ||
    mcpConnectionIntents.present ||
    mcpSourceApprovalIntents.present ||
    mcpReconnectionIntents.present ||
    mcpSourceMutationIntents.present ||
    uiVersion === 4 ||
    uiVersion === 5
      ? {
          fileRecoveryIntents: {
            ...fileRecoveryIntents,
            format: fileRecoveryIntents.present ? { version: 1 as const } : null,
          },
        }
      : {}),
    ...(mcpSourceApprovalIntents.present ||
    mcpReconnectionIntents.present ||
    mcpSourceMutationIntents.present
      ? {
          mcpSourceApprovalIntents: {
            ...mcpSourceApprovalIntents,
            format: mcpSourceApprovalIntents.present ? { version: 1 as const } : null,
          },
        }
      : {}),
    ...(mcpReconnectionIntents.present || mcpSourceMutationIntents.present
      ? {
          mcpReconnectionIntents: {
            ...mcpReconnectionIntents,
            format: mcpReconnectionIntents.present ? { version: 1 as const } : null,
          },
        }
      : {}),
    ...(mcpConnectionIntents.present ||
    mcpSourceApprovalIntents.present ||
    mcpReconnectionIntents.present ||
    mcpSourceMutationIntents.present
      ? {
          mcpConnectionIntents: {
            ...mcpConnectionIntents,
            format: mcpConnectionIntents.present ? { version: 1 as const } : null,
          },
        }
      : {}),
    ...(mcpSelectionIntents.present ||
    mcpConnectionIntents.present ||
    mcpSourceApprovalIntents.present ||
    mcpReconnectionIntents.present ||
    mcpSourceMutationIntents.present
      ? {
          mcpSelectionIntents: {
            ...mcpSelectionIntents,
            format: mcpSelectionIntents.present ? { version: 1 as const } : null,
          },
        }
      : {}),
    ...(mcpSourceMutationIntents.present
      ? {
          mcpSourceMutationIntents: {
            ...mcpSourceMutationIntents,
            format: { version: 1 as const },
          },
        }
      : {}),
    tuiPreferences: await capture('ui/preferences.jsonc', false),
    vaultExcluded: true,
    configurationMayContainSensitiveContent: true,
  };
}
export function verifyAssets(
  directory: string,
  assets: BackupManifest['assets'],
  signal?: AbortSignal,
) {
  for (const asset of [
    assets.configuration,
    assets.skillWorkflowConfiguration,
    assets.desktopUi,
    assets.tuiUi,
    assets.tuiPreferences,
    ...(assets.tuiRecovery ? [assets.tuiRecovery] : []),
    ...(assets.callerIntents ? [assets.callerIntents] : []),
    ...(assets.fileRecoveryIntents ? [assets.fileRecoveryIntents] : []),
    ...(assets.mcpSelectionIntents ? [assets.mcpSelectionIntents] : []),
    ...(assets.mcpConnectionIntents ? [assets.mcpConnectionIntents] : []),
    ...(assets.mcpSourceApprovalIntents ? [assets.mcpSourceApprovalIntents] : []),
    ...(assets.mcpReconnectionIntents ? [assets.mcpReconnectionIntents] : []),
    ...(assets.mcpSourceMutationIntents ? [assets.mcpSourceMutationIntents] : []),
  ]) {
    const path = join(directory, asset.path);
    if (present(path) !== asset.present) throw new MaintenanceError('backup_asset_missing');
    if (asset.present && canonicalJson(fingerprint(path, signal)) !== canonicalJson(asset.proof))
      throw new MaintenanceError('backup_asset_mismatch');
  }
  if (assets.desktopUi.present) {
    const db = openUiDatabase(join(directory, assets.desktopUi.path));
    try {
      if (
        db.query<{ user_version: number }, []>('PRAGMA user_version').get()?.user_version !==
        assets.desktopUi.format?.userVersion
      )
        throw new MaintenanceError('backup_asset_mismatch');
    } finally {
      db.close(true);
    }
    if (
      canonicalJson(fingerprint(join(directory, assets.desktopUi.path), signal)) !==
      canonicalJson(assets.desktopUi.proof)
    )
      throw new MaintenanceError('backup_asset_mismatch');
  }
  if (assets.tuiUi.present) {
    verifyTuiDocument(join(directory, assets.tuiUi.path));
    if (
      canonicalJson(fingerprint(join(directory, assets.tuiUi.path), signal)) !==
      canonicalJson(assets.tuiUi.proof)
    )
      throw new MaintenanceError('backup_asset_mismatch');
  }
  if (assets.tuiRecovery?.present) {
    verifyRecoveryDocument(join(directory, assets.tuiRecovery.path));
    if (
      canonicalJson(fingerprint(join(directory, assets.tuiRecovery.path), signal)) !==
      canonicalJson(assets.tuiRecovery.proof)
    )
      throw new MaintenanceError('backup_asset_mismatch');
  }
  if (assets.callerIntents?.present) {
    verifyCallerIntentsDocument(join(directory, assets.callerIntents.path));
    if (
      canonicalJson(fingerprint(join(directory, assets.callerIntents.path), signal)) !==
      canonicalJson(assets.callerIntents.proof)
    )
      throw new MaintenanceError('backup_asset_mismatch');
  }
  if (assets.fileRecoveryIntents?.present) {
    verifyFileRecoveryIntentsDocument(join(directory, assets.fileRecoveryIntents.path));
    if (
      canonicalJson(fingerprint(join(directory, assets.fileRecoveryIntents.path), signal)) !==
      canonicalJson(assets.fileRecoveryIntents.proof)
    )
      throw new MaintenanceError('backup_asset_mismatch');
  }
  if (assets.mcpSourceMutationIntents?.present) {
    verifyMcpSourceMutationIntentsDocument(join(directory, assets.mcpSourceMutationIntents.path));
    if (
      canonicalJson(fingerprint(join(directory, assets.mcpSourceMutationIntents.path), signal)) !==
      canonicalJson(assets.mcpSourceMutationIntents.proof)
    )
      throw new MaintenanceError('backup_asset_mismatch');
  }
  if (assets.mcpReconnectionIntents?.present) {
    verifyMcpReconnectionIntentsDocument(join(directory, assets.mcpReconnectionIntents.path));
    if (
      canonicalJson(fingerprint(join(directory, assets.mcpReconnectionIntents.path), signal)) !==
      canonicalJson(assets.mcpReconnectionIntents.proof)
    )
      throw new MaintenanceError('backup_asset_mismatch');
  }
  if (assets.mcpSourceApprovalIntents?.present) {
    verifyMcpSourceApprovalIntentsDocument(join(directory, assets.mcpSourceApprovalIntents.path));
    if (
      canonicalJson(fingerprint(join(directory, assets.mcpSourceApprovalIntents.path), signal)) !==
      canonicalJson(assets.mcpSourceApprovalIntents.proof)
    )
      throw new MaintenanceError('backup_asset_mismatch');
  }
  if (assets.mcpConnectionIntents?.present) {
    verifyMcpConnectionIntentsDocument(join(directory, assets.mcpConnectionIntents.path));
    if (
      canonicalJson(fingerprint(join(directory, assets.mcpConnectionIntents.path), signal)) !==
      canonicalJson(assets.mcpConnectionIntents.proof)
    )
      throw new MaintenanceError('backup_asset_mismatch');
  }
  if (assets.mcpSelectionIntents?.present) {
    verifyMcpSelectionIntentsDocument(join(directory, assets.mcpSelectionIntents.path));
    if (
      canonicalJson(fingerprint(join(directory, assets.mcpSelectionIntents.path), signal)) !==
      canonicalJson(assets.mcpSelectionIntents.proof)
    )
      throw new MaintenanceError('backup_asset_mismatch');
  }
  if (
    present(join(directory, 'ui')) &&
    !assets.tuiUi.present &&
    !assets.tuiPreferences.present &&
    !assets.tuiRecovery?.present &&
    !assets.callerIntents?.present &&
    !assets.fileRecoveryIntents?.present &&
    !assets.mcpSelectionIntents?.present &&
    !assets.mcpConnectionIntents?.present &&
    !assets.mcpSourceApprovalIntents?.present &&
    !assets.mcpReconnectionIntents?.present &&
    !assets.mcpSourceMutationIntents?.present
  )
    throw new MaintenanceError('backup_unexpected_asset');
  const ui = join(directory, 'desktop-private');
  if (existsSync(ui) && !assets.desktopUi.present)
    throw new MaintenanceError('backup_unexpected_asset');
}
export async function restoreAssets(
  source: string,
  target: string,
  assets: BackupManifest['assets'],
  signal?: AbortSignal,
) {
  for (const asset of [
    assets.configuration,
    assets.skillWorkflowConfiguration,
    assets.desktopUi,
    assets.tuiUi,
    assets.tuiPreferences,
    ...(assets.tuiRecovery ? [assets.tuiRecovery] : []),
    ...(assets.callerIntents ? [assets.callerIntents] : []),
    ...(assets.fileRecoveryIntents ? [assets.fileRecoveryIntents] : []),
    ...(assets.mcpSelectionIntents ? [assets.mcpSelectionIntents] : []),
    ...(assets.mcpConnectionIntents ? [assets.mcpConnectionIntents] : []),
    ...(assets.mcpSourceApprovalIntents ? [assets.mcpSourceApprovalIntents] : []),
    ...(assets.mcpReconnectionIntents ? [assets.mcpReconnectionIntents] : []),
    ...(assets.mcpSourceMutationIntents ? [assets.mcpSourceMutationIntents] : []),
  ])
    if (asset.present)
      await copyAssetFile(join(source, asset.path), join(target, asset.path), signal);
  verifyAssets(target, assets, signal);
}
