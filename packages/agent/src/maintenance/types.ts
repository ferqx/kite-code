import type { ProfileOptions } from '../platform/profile';

/** An explicit offline operation. It cannot use an already-open Store's shared authority. */
export interface CreateProfileBackupInput {
  profile: ProfileOptions;
  destinationRoot: string;
  signal?: AbortSignal;
}
export interface InspectProfileBackupInput {
  directory: string;
  signal?: AbortSignal;
}
export interface CapturedAsset {
  path:
    | 'config.jsonc'
    | 'skill-workflow.jsonc'
    | 'mcp.json'
    | 'mcp-approvals.json'
    | 'mcp-auth-bindings.json'
    | 'desktop-private/data.sqlite'
    | 'ui/tui.json'
    | 'ui/preferences.jsonc'
    | 'ui/recovery.json'
    | 'ui/caller-intents.json'
    | 'ui/file-recovery-intents.json'
    | 'ui/mcp-selection-intents.json'
    | 'ui/mcp-connection-intents.json'
    | 'ui/mcp-source-approval-intents.json'
    | 'ui/mcp-reconnection-intents.json'
    | 'ui/mcp-source-mutation-intents.json';
  capturedAt: string;
  present: boolean;
  proof: { sha256: string; byteLength: string } | null;
}
export interface BackupManifest {
  version: 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15 | 16 | 17;
  kind: 'profile_backup';
  createdAt: string;
  source: {
    storeId: string;
    formatMajor: number;
    snapshotCursor: string;
    profileAccessKey: string;
    migrationChecksum: string;
  };
  engine: { version: string; sourceId: string };
  database: { path: 'core.db'; sha256: string; byteLength: string };
  media: {
    inventory: 'media.jsonl';
    sha256: string;
    byteLength: string;
    blobCount: string;
    referenceCount: string;
  };
  assets: {
    configuration: CapturedAsset;
    skillWorkflowConfiguration: CapturedAsset;
    mcpConfiguration?: CapturedAsset;
    mcpApprovals?: CapturedAsset;
    mcpAuthBindings?: CapturedAsset;
    desktopUi: CapturedAsset & {
      format: { applicationId: 1263888689; userVersion: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 } | null;
    };
    tuiUi: CapturedAsset & { format: { version: 1 } | null };
    tuiPreferences: CapturedAsset;
    callerIntents?: CapturedAsset & { format: { version: 1 } | null };
    mcpSourceMutationIntents?: CapturedAsset & { format: { version: 1 } | null };
    mcpReconnectionIntents?: CapturedAsset & { format: { version: 1 } | null };
    mcpSourceApprovalIntents?: CapturedAsset & { format: { version: 1 } | null };
    mcpConnectionIntents?: CapturedAsset & { format: { version: 1 } | null };
    mcpSelectionIntents?: CapturedAsset & { format: { version: 1 } | null };
    fileRecoveryIntents?: CapturedAsset & { format: { version: 1 } | null };
    tuiRecovery?: CapturedAsset & { format: { version: 1 } | null };
    vaultExcluded: true;
    configurationMayContainSensitiveContent: true;
  };
  consistency: 'sqlite_snapshot_with_verified_media_and_separate_assets';
  excluded: readonly [
    'credentials',
    'credential_vault',
    'uncollected_host_private_files',
    'coordination',
    'locks',
  ];
}
export interface ProfileBackup {
  directory: string;
  manifest: BackupManifest;
}
export class MaintenanceError extends Error {
  readonly code: string;
  constructor(code: string, message = code) {
    super(message);
    this.name = 'MaintenanceError';
    this.code = code;
  }
}

export interface RestoreProfileBackupInput {
  profile: ProfileOptions;
  expectedStoreId: string;
  backup: ProfileBackup;
  intent: 'replace_with_selected_backup';
  signal?: AbortSignal;
}
export interface ProfileRestoreJournal {
  version: 1;
  restoreId: string;
  profileAccessKey: string;
  phase: 'prepared' | 'old_moved' | 'published' | 'verified';
  expectedStoreId: string;
  newStoreId: string;
  backupManifest: BackupManifest;
  stagingName: string;
  preservedName: string;
  originalDigest: string;
  candidateDigest: string;
}
export interface ProfileRestoreResult {
  restoreId: string;
  storeId: string;
  preservedDirectory: string;
  outcome: 'restored' | 'rolled_back';
}
