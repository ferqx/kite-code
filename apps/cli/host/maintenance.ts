import type { MaintenanceCLIArguments } from '../src/arguments';

export const maintenanceHelp = [
  'Development offline maintenance (DB/media + separate raw config/Desktop UI/TUI drafts; vault excluded):',
  'maintenance backup --data-root <absolute> --profile <name> --destination <absolute>',
  'maintenance inspect <absolute-backup-directory>',
  'maintenance status --data-root <absolute> --profile <name>',
  'maintenance restore <absolute-backup-directory> --data-root <absolute> --profile <name> --expected-store <observed-id> --confirm-data-loss',
  'maintenance reconcile --data-root <absolute> --profile <name> --restore-id <observed-id> --journal-digest <observed-sha256> --decision complete|rollback --confirm-data-loss',
  'Restore preserves the current directory separately; uncollected private files are omitted; raw configuration may contain sensitive content. This is not complete W19 qualification.',
].join('\n');

/** Offline host leaf: no Service, Client connection, Provider or automatic reconciliation. */
export async function runSelectedMaintenance(input: {
  arguments: MaintenanceCLIArguments;
  write: (line: string) => void;
  signal?: AbortSignal;
}): Promise<number> {
  const args = input.arguments;
  input.signal?.throwIfAborted();
  const {
    createProfileBackup,
    inspectProfileBackup,
    inspectProfileRestore,
    restoreProfileBackup,
    reconcileProfileRestore,
  } = await import('@kite-ai/agent/maintenance');
  const coverage = {
    included: [
      'sqlite_database',
      'referenced_immutable_media',
      'raw_profile_configuration',
      'desktop_private_sqlite',
      'tui_recovery_intents',
      'caller_intents',
      'file_recovery_intents',
      'mcp_selection_intents',
      'mcp_connection_intents',
      'mcp_source_approval_intents',
      'mcp_reconnection_intents',
      'mcp_source_mutation_intents',
      'tui_private_drafts',
      'tui_display_preferences',
      'skill_workflow_configuration',
    ],
    excluded: [
      'credential_vault',
      'credentials',
      'uncollected_host_private_files',
      'coordination',
      'locks',
    ],
    profileComplete: false,
    desktopUi: { path: 'desktop-private/data.sqlite', supportedUserVersions: [1, 2, 3, 4, 5] },
    tuiRecovery: { path: 'ui/recovery.json', format: { version: 1 } },
    callerIntents: { path: 'ui/caller-intents.json', format: { version: 1 } },
    fileRecoveryIntents: { path: 'ui/file-recovery-intents.json', format: { version: 1 } },
    mcpSelectionIntents: { path: 'ui/mcp-selection-intents.json', format: { version: 1 } },
    mcpConnectionIntents: { path: 'ui/mcp-connection-intents.json', format: { version: 1 } },
    mcpSourceApprovalIntents: {
      path: 'ui/mcp-source-approval-intents.json',
      format: { version: 1 },
    },
    mcpSourceMutationIntents: {
      path: 'ui/mcp-source-mutation-intents.json',
      format: { version: 1 },
    },
    mcpReconnectionIntents: { path: 'ui/mcp-reconnection-intents.json', format: { version: 1 } },
    tuiUi: { path: 'ui/tui.json', format: { version: 1 } },
    tuiPreferences: { path: 'ui/preferences.jsonc', rawBytes: true },
    skillWorkflowConfiguration: { path: 'skill-workflow.jsonc', rawBytes: true },
    configurationMayContainSensitiveContent: true,
  };
  const emit = (result: Record<string, unknown>) =>
    input.write(
      JSON.stringify({ kind: 'offline_maintenance', action: args.action, coverage, ...result }),
    );
  if (args.action === 'inspect') {
    const backup = await inspectProfileBackup({
      directory: args.directory,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    emit({ status: 'verified', backup });
    return 0;
  }
  const profile = { dataRoot: args.dataRoot, profile: args.profile };
  if (args.action === 'status') {
    emit({ status: 'observed', restore: inspectProfileRestore({ profile }) });
    return 0;
  }
  if (args.action === 'backup') {
    const backup = await createProfileBackup({
      profile,
      destinationRoot: args.destinationRoot,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    emit({ status: 'verified', backup });
    return 0;
  }
  if (args.action === 'restore') {
    // This immutable inspected proof binds the user's selected path before any publication.
    const backup = await inspectProfileBackup({
      directory: args.directory,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    const restored = await restoreProfileBackup({
      profile,
      expectedStoreId: args.expectedStoreId,
      backup,
      intent: 'replace_with_selected_backup',
      ...(input.signal ? { signal: input.signal } : {}),
    });
    emit({
      status: restored.outcome,
      ...restored,
      newProfileOmits: ['credentials', 'credential_vault', 'uncollected_host_private_files'],
      previousDirectoryPreserved: true,
    });
    return 0;
  }
  const restored = await reconcileProfileRestore({
    profile,
    restoreId: args.restoreId,
    expectedJournalDigest: args.journalDigest,
    decision: args.decision,
  });
  emit({
    status: restored.outcome,
    ...restored,
    preservedDirectoryRole:
      restored.outcome === 'restored' ? 'previous_profile' : 'restore_candidate',
  });
  return 0;
}
