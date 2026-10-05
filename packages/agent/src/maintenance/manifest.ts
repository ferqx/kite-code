import { closeSync, fstatSync, readSync } from 'node:fs';
import { canonicalJson } from '../json';
import { decimal, openPrivate } from './files';
import { type BackupManifest, MaintenanceError } from './types';

export const excluded = [
  'credentials',
  'credential_vault',
  'uncollected_host_private_files',
  'coordination',
  'locks',
] as const satisfies BackupManifest['excluded'];
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new MaintenanceError('backup_invalid_manifest');
  const row = value as Record<string, unknown>;
  if (
    Object.keys(row).length !== keys.length ||
    Object.keys(row).some((key) => !keys.includes(key))
  )
    throw new MaintenanceError('backup_invalid_manifest');
  return row;
}
function string(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value || value.length > 4096)
    throw new MaintenanceError('backup_invalid_manifest');
}
function hash(value: unknown): void {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value))
    throw new MaintenanceError('backup_invalid_manifest');
}
export function parseManifest(value: unknown): BackupManifest {
  const row = object(value, [
    'version',
    'kind',
    'createdAt',
    'source',
    'engine',
    'database',
    'media',
    'consistency',
    'assets',
    'excluded',
  ]);
  if (
    (row.version !== 2 &&
      row.version !== 3 &&
      row.version !== 4 &&
      row.version !== 5 &&
      row.version !== 6 &&
      row.version !== 7 &&
      row.version !== 8 &&
      row.version !== 9 &&
      row.version !== 10) ||
    row.kind !== 'profile_backup' ||
    row.consistency !== 'sqlite_snapshot_with_verified_media_and_separate_assets' ||
    canonicalJson(row.excluded as never) !== canonicalJson([...excluded])
  )
    throw new MaintenanceError('backup_invalid_manifest');
  string(row.createdAt);
  if (!Number.isFinite(Date.parse(row.createdAt)))
    throw new MaintenanceError('backup_invalid_manifest');
  const source = object(row.source, [
    'storeId',
    'formatMajor',
    'snapshotCursor',
    'profileAccessKey',
    'migrationChecksum',
  ]);
  string(source.storeId);
  if (source.formatMajor !== 1) throw new MaintenanceError('backup_invalid_manifest');
  decimal(source.snapshotCursor);
  hash(source.profileAccessKey);
  hash(source.migrationChecksum);
  const engine = object(row.engine, ['version', 'sourceId']);
  string(engine.version);
  string(engine.sourceId);
  const database = object(row.database, ['path', 'sha256', 'byteLength']);
  if (database.path !== 'core.db') throw new MaintenanceError('backup_invalid_manifest');
  hash(database.sha256);
  decimal(database.byteLength);
  const media = object(row.media, [
    'inventory',
    'sha256',
    'byteLength',
    'blobCount',
    'referenceCount',
  ]);
  if (media.inventory !== 'media.jsonl') throw new MaintenanceError('backup_invalid_manifest');
  hash(media.sha256);
  decimal(media.byteLength);
  decimal(media.blobCount);
  decimal(media.referenceCount);
  const assets = object(row.assets, [
    'configuration',
    'skillWorkflowConfiguration',
    'desktopUi',
    'tuiUi',
    'tuiPreferences',
    ...(row.version === 3 ||
    row.version === 4 ||
    row.version === 5 ||
    row.version === 6 ||
    row.version === 7 ||
    row.version === 8 ||
    row.version === 9 ||
    row.version === 10
      ? ['tuiRecovery']
      : []),
    ...(row.version === 4 ||
    row.version === 5 ||
    row.version === 6 ||
    row.version === 7 ||
    row.version === 8 ||
    row.version === 9 ||
    row.version === 10
      ? ['callerIntents']
      : []),
    ...(row.version === 6 ||
    row.version === 7 ||
    row.version === 8 ||
    row.version === 9 ||
    row.version === 10
      ? ['fileRecoveryIntents']
      : []),
    ...(row.version === 8 || row.version === 9 || row.version === 10
      ? ['mcpSelectionIntents']
      : []),
    ...(row.version === 9 || row.version === 10 ? ['mcpConnectionIntents'] : []),
    ...(row.version === 10 ? ['mcpSourceApprovalIntents'] : []),
    'vaultExcluded',
    'configurationMayContainSensitiveContent',
  ]);
  if (assets.vaultExcluded !== true || assets.configurationMayContainSensitiveContent !== true)
    throw new MaintenanceError('backup_invalid_manifest');
  for (const [key, path] of [
    ['configuration', 'config.jsonc'],
    ['skillWorkflowConfiguration', 'skill-workflow.jsonc'],
    ['desktopUi', 'desktop-private/data.sqlite'],
    ['tuiUi', 'ui/tui.json'],
    ['tuiPreferences', 'ui/preferences.jsonc'],
    ...(row.version === 3 ||
    row.version === 4 ||
    row.version === 5 ||
    row.version === 6 ||
    row.version === 7 ||
    row.version === 8 ||
    row.version === 9 ||
    row.version === 10
      ? [['tuiRecovery', 'ui/recovery.json'] as const]
      : []),
    ...(row.version === 4 ||
    row.version === 5 ||
    row.version === 6 ||
    row.version === 7 ||
    row.version === 8 ||
    row.version === 9 ||
    row.version === 10
      ? [['callerIntents', 'ui/caller-intents.json'] as const]
      : []),
    ...(row.version === 6 ||
    row.version === 7 ||
    row.version === 8 ||
    row.version === 9 ||
    row.version === 10
      ? [['fileRecoveryIntents', 'ui/file-recovery-intents.json'] as const]
      : []),
    ...(row.version === 8 || row.version === 9 || row.version === 10
      ? [['mcpSelectionIntents', 'ui/mcp-selection-intents.json'] as const]
      : []),
    ...(row.version === 9 || row.version === 10
      ? [['mcpConnectionIntents', 'ui/mcp-connection-intents.json'] as const]
      : []),
    ...(row.version === 10
      ? [['mcpSourceApprovalIntents', 'ui/mcp-source-approval-intents.json'] as const]
      : []),
  ] as const) {
    const asset = object(assets[key], [
      'path',
      'capturedAt',
      'present',
      'proof',
      ...([
        'desktopUi',
        'tuiUi',
        'tuiRecovery',
        'callerIntents',
        'fileRecoveryIntents',
        'mcpSelectionIntents',
        'mcpConnectionIntents',
        'mcpSourceApprovalIntents',
      ].includes(key)
        ? ['format']
        : []),
    ]);
    if (asset.path !== path || typeof asset.present !== 'boolean')
      throw new MaintenanceError('backup_invalid_manifest');
    string(asset.capturedAt);
    if (!Number.isFinite(Date.parse(asset.capturedAt)))
      throw new MaintenanceError('backup_invalid_manifest');
    if (key === 'desktopUi') {
      if (asset.present) {
        const format = object(asset.format, ['applicationId', 'userVersion']);
        if (
          format.applicationId !== 1263888689 ||
          (format.userVersion !== 1 &&
            !(
              (row.version === 3 ||
                row.version === 4 ||
                row.version === 5 ||
                row.version === 6 ||
                row.version === 7 ||
                row.version === 8 ||
                row.version === 9 ||
                row.version === 10) &&
              format.userVersion === 2
            ) &&
            !(
              (row.version === 5 ||
                row.version === 6 ||
                row.version === 7 ||
                row.version === 8 ||
                row.version === 9 ||
                row.version === 10) &&
              format.userVersion === 3
            ) &&
            !(
              (row.version === 6 ||
                row.version === 7 ||
                row.version === 8 ||
                row.version === 9 ||
                row.version === 10) &&
              format.userVersion === 4
            ) &&
            !(
              (row.version === 7 || row.version === 8 || row.version === 9 || row.version === 10) &&
              format.userVersion === 5
            ))
        )
          throw new MaintenanceError('backup_invalid_manifest');
      } else if (asset.format !== null) throw new MaintenanceError('backup_invalid_manifest');
    }
    if (
      key === 'tuiUi' ||
      key === 'tuiRecovery' ||
      key === 'callerIntents' ||
      key === 'fileRecoveryIntents' ||
      key === 'mcpSelectionIntents' ||
      key === 'mcpConnectionIntents' ||
      key === 'mcpSourceApprovalIntents'
    ) {
      if (asset.present) {
        if (object(asset.format, ['version']).version !== 1)
          throw new MaintenanceError('backup_invalid_manifest');
      } else if (asset.format !== null) throw new MaintenanceError('backup_invalid_manifest');
    }
    if (asset.present) {
      const proof = object(asset.proof, ['sha256', 'byteLength']);
      hash(proof.sha256);
      decimal(proof.byteLength);
    } else if (asset.proof !== null) throw new MaintenanceError('backup_invalid_manifest');
  }
  return value as BackupManifest;
}
export function readManifest(path: string): BackupManifest {
  const fd = openPrivate(path);
  try {
    const size = fstatSync(fd).size;
    if (size > 16384) throw new MaintenanceError('backup_invalid_manifest');
    const bytes = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
      const read = readSync(fd, bytes, offset, size - offset, null);
      if (!read) throw new MaintenanceError('backup_invalid_manifest');
      offset += read;
    }
    return parseManifest(JSON.parse(bytes.toString('utf8')));
  } finally {
    closeSync(fd);
  }
}
export function parseMediaLine(line: string) {
  const row = object(JSON.parse(line), ['hash', 'size', 'referenceCount']);
  hash(row.hash);
  decimal(row.size);
  decimal(row.referenceCount);
  if (row.referenceCount === '0') throw new MaintenanceError('backup_invalid_manifest');
  return row as unknown as { hash: string; size: string; referenceCount: string };
}
/** The inventory has short closed records, not arbitrary large caller JSON. */
export function* mediaLines(path: string) {
  const fd = openPrivate(path);
  try {
    const before = fstatSync(fd, { bigint: true });
    let pending = '';
    const bytes = Buffer.alloc(65536);
    for (;;) {
      const length = readSync(fd, bytes, 0, bytes.length, null);
      if (!length) break;
      // The closed format is entirely ASCII; no split UTF-8 state can be hidden in a field.
      for (const byte of bytes.subarray(0, length)) {
        if (byte === 10) {
          yield parseMediaLine(pending);
          pending = '';
        } else {
          if (byte < 32 || byte > 126 || pending.length >= 512)
            throw new MaintenanceError('backup_invalid_manifest');
          pending += String.fromCharCode(byte);
        }
      }
    }
    const after = fstatSync(fd, { bigint: true });
    if (pending || before.size !== after.size || before.ctimeNs !== after.ctimeNs)
      throw new MaintenanceError('backup_content_changed');
  } finally {
    closeSync(fd);
  }
}
