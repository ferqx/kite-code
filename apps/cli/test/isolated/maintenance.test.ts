import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { inspectProfileBackup, type RestoreProfileBackupInput } from '@kite-ai/agent/maintenance';
import { selectProfile } from '@kite-ai/agent/profile';
import { openSqliteStore } from '@kite-ai/agent/sqlite';

const repository = new URL('../../../../', import.meta.url).pathname;
// Internal seams belong only to source fixtures; consumer processes use built public entries.
const { copyTerminalDependencies } = (await import(
  join(repository, 'scripts/release/terminal-dependencies.ts')
)) as {
  copyTerminalDependencies(input: {
    repositoryRoot: string;
    destination: string;
    workspacePackages: readonly { name: string; source: string; destination: string }[];
  }): unknown;
};
const { acquireProfileAccess } = (await import(
  join(repository, 'packages/agent/src/platform/profile.ts')
)) as {
  acquireProfileAccess(profile: { dataRoot: string; profile: string }): {
    lock: { release(): void };
  };
};
const { runProfileRestore } = (await import(
  join(repository, 'packages/agent/src/maintenance/restore.ts')
)) as {
  runProfileRestore(
    input: RestoreProfileBackupInput,
    observe: (phase: string) => Promise<void>,
  ): Promise<unknown>;
};
const { seedAssets, nodeAssets, configBytes, tuiText } = (await import(
  join(repository, 'packages/agent/test/isolated/maintenance/assets-fixture.ts')
)) as {
  seedAssets(
    root: string,
    profile: { dataRoot: string; profile: string },
    storeId: string,
  ): Promise<unknown>;
  nodeAssets(
    root: string,
    profile: { dataRoot: string; profile: string },
    storeId: string,
    action: 'read',
  ): Promise<{ count: number; creations: { input: { expectedStoreId: string }; phase: string }[] }>;
  configBytes: Buffer;
  tuiText: string;
};
async function built(root: string) {
  const definitions = [
    {
      name: 'cli',
      workspace: 'apps/cli',
      source: '.',
      entries: ['host/main.ts'],
      exports: { './main': './host/main.js' },
    },
    {
      name: 'agent',
      workspace: 'packages/agent',
      source: 'src',
      entries: [
        'maintenance/index.ts',
        'profile.ts',
        'profile-access.ts',
        'artifact-access.ts',
        'sqlite-engine.ts',
        'platform/windows-path-security.ts',
      ],
      exports: {
        './maintenance': './maintenance/index.js',
        './profile': './profile.js',
        './profile-access': './profile-access.js',
        './artifact-access': './artifact-access.js',
        './sqlite-engine': './sqlite-engine.js',
        './windows-path-security': './platform/windows-path-security.js',
      },
    },
    {
      name: 'client',
      workspace: 'packages/client',
      source: 'src',
      entries: ['index.ts', 'file-recovery-intent.ts'],
      exports: { '.': './index.js', './file-recovery-intent': './file-recovery-intent.js' },
    },
    {
      name: 'service',
      workspace: 'apps/service',
      source: 'src',
      entries: [
        'paired.ts',
        'runtime-protection.ts',
        'runtime-assets.ts',
        'native-runtime-assets.ts',
      ],
      exports: {
        './paired': './paired.js',
        './runtime-protection': './runtime-protection.js',
        './runtime-assets': './runtime-assets.js',
        './native-runtime-assets': './native-runtime-assets.js',
      },
    },
    {
      name: 'ai',
      workspace: 'packages/ai',
      source: 'src',
      entries: ['index.ts', 'sdk.ts'],
      exports: { '.': './index.js', './sdk': './sdk.js' },
    },
    {
      name: 'ui',
      workspace: 'packages/ui',
      source: 'src',
      entries: ['index.tsx', 'tui/index.tsx'],
      exports: { '.': './index.js', './tui': './tui/index.js' },
    },
  ];
  for (const definition of definitions) {
    const packageRoot = join(root, 'node_modules', '@kite-ai', definition.name),
      source = join(repository, definition.workspace, definition.source);
    const result = await Bun.build({
      entrypoints: definition.entries.map((entry) => join(source, entry)),
      root: source,
      outdir: packageRoot,
      target: 'bun',
      packages: 'external',
    });
    if (!result.success)
      throw new AggregateError(result.logs, `offline ${definition.name} build failed`);
    writeFileSync(
      join(packageRoot, 'package.json'),
      JSON.stringify({
        name: `@kite-ai/${definition.name}`,
        type: 'module',
        exports: definition.exports,
      }),
    );
  }
  // Same installed npm graph copier as the formal terminal builder: real package
  // entrypoints, optional peers remain optional, and no source-tree aliases.
  copyTerminalDependencies({
    repositoryRoot: repository,
    destination: join(root, 'node_modules'),
    workspacePackages: definitions.map((definition) => ({
      name: `@kite-ai/${definition.name}`,
      source: join(repository, definition.workspace),
      destination: join(root, 'node_modules', '@kite-ai', definition.name),
    })),
  });
  const migration = join(root, 'node_modules', '@kite-ai', 'agent', 'storage', 'migrations');
  mkdirSync(migration, { recursive: true });
  copyFileSync(
    join(repository, 'packages/agent/src/storage/migrations/0001-baseline.sql'),
    join(migration, '0001-baseline.sql'),
  );
  return join(root, 'node_modules', '@kite-ai', 'cli', 'host', 'main.js');
}
async function argv(entry: string, args: string[]) {
  const child = Bun.spawn([process.execPath, entry, ...args], {
    cwd: dirname(entry),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [exit, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exit !== 0) {
    const diagnostic = stderr.split('\n').find((line) => /^error:|^Error:|^[a-z_]+$/.test(line));
    if (diagnostic) console.error(`owned maintenance argv failure: ${diagnostic.slice(0, 240)}`);
  }
  return { exit, stdout, stderr };
}
async function fixture() {
  const directory = mkdtempSync('/private/tmp/kite-cli-maintenance-'),
    profile = { dataRoot: join(directory, 'data'), profile: 'selected' };
  let store: Awaited<ReturnType<typeof openSqliteStore>> | undefined;
  try {
    store = await openSqliteStore(profile);
    const storeId = (await store.getMetadata()).storeId;
    await store.createWorkspace({
      expectedStoreId: storeId,
      id: 'w',
      rootUri: 'file:///fixture',
      name: 'w',
    });
    await store.createSession({
      expectedStoreId: storeId,
      sessionId: 's',
      workspaceId: 'w',
      commandId: 'create',
      subjectId: 'owner',
      title: 'backup title',
    });
    await store.close();
    await seedAssets(directory, profile, storeId);
    const entry = await built(join(directory, 'distribution')),
      scope = ['--data-root', profile.dataRoot, '--profile', profile.profile],
      selected = selectProfile(profile);
    return {
      directory,
      profile,
      storeId,
      entry,
      scope,
      selected,
      close() {
        rmSync(directory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    try {
      await store?.close();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        `owned fixture cleanup unconfirmed: ${directory}`,
      );
    }
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}
test('built offline maintenance argv create/inspect/restore is independent of Service and retains original identities', async () => {
  const f = await fixture();
  try {
    const mcpAssets = [
      [
        'mcpConfiguration',
        'mcp.json',
        '// exact raw source\r\n{"mcpServers":{},"unknown":"原文🔐"}\r\n',
      ],
      [
        'mcpApprovals',
        'mcp-approvals.json',
        '// original source decisions\n{"version":1,"records":{}}\n',
      ],
      [
        'mcpAuthBindings',
        'mcp-auth-bindings.json',
        '// opaque refs are raw configuration\n{"version":1,"records":{}}\n',
      ],
    ] as const;
    for (const [, path, bytes] of mcpAssets)
      writeFileSync(join(f.selected.profilePath, path), bytes, { mode: 0o600 });
    const before = readFileSync(f.selected.databasePath),
      created = await argv(f.entry, [
        'maintenance',
        'backup',
        ...f.scope,
        '--destination',
        join(f.directory, 'backups'),
      ]);
    expect(created.exit).toBe(0);
    expect(created.stderr).toBe('');
    const result = JSON.parse(created.stdout);
    expect(result.coverage.profileComplete).toBe(false);
    expect(result.coverage.tuiRecovery).toEqual({
      path: 'ui/recovery.json',
      format: { version: 1 },
    });
    expect(result.coverage.included).toContain('tui_recovery_intents');
    expect(result.coverage.included).toContain('caller_intents');
    expect(result.coverage.callerIntents).toEqual({
      path: 'ui/caller-intents.json',
      format: { version: 1 },
    });
    expect(result.coverage.desktopUi).toEqual({
      path: 'desktop-private/data.sqlite',
      supportedUserVersions: [1, 2, 3, 4, 5, 6, 7, 8, 9],
    });
    expect(result.backup.manifest.version).toBe(16);
    for (const [key, path, text] of mcpAssets) {
      const bytes = Buffer.from(text);
      expect(result.coverage[key]).toEqual({ path, rawBytes: true });
      expect(result.backup.manifest.assets[key]).toMatchObject({
        path,
        present: true,
        proof: {
          sha256: createHash('sha256').update(bytes).digest('hex'),
          byteLength: String(bytes.length),
        },
      });
      expect(readFileSync(join(result.backup.directory, path))).toEqual(bytes);
    }
    expect(result.coverage.included).toContain('mcp_selection_intents');
    expect(result.coverage.mcpSelectionIntents).toEqual({
      path: 'ui/mcp-selection-intents.json',
      format: { version: 1 },
    });
    expect(result.coverage.included).toContain('mcp_source_mutation_intents');
    expect(result.coverage.mcpSourceMutationIntents).toEqual({
      path: 'ui/mcp-source-mutation-intents.json',
      format: { version: 1 },
    });
    expect(result.coverage.excluded).toContain('credentials');
    expect(result.backup.manifest.source.storeId).toBe(f.storeId);
    expect(result.backup.manifest.assets.desktopUi.present).toBe(true);
    expect(result.backup.manifest.assets.configuration.present).toBe(true);
    const tuiBytes = readFileSync(join(f.selected.profilePath, 'ui', 'tui.json'));
    expect(result.backup.manifest.assets.tuiUi).toMatchObject({
      path: 'ui/tui.json',
      present: true,
      format: { version: 1 },
      proof: {
        sha256: createHash('sha256').update(tuiBytes).digest('hex'),
        byteLength: String(tuiBytes.length),
      },
    });
    expect(result.coverage.included).toContain('tui_private_drafts');
    expect(readFileSync(join(result.backup.directory, 'ui', 'tui.json'))).toEqual(tuiBytes);
    expect(result.coverage.included).toContain('raw_profile_configuration');
    expect(result.coverage.configurationMayContainSensitiveContent).toBe(true);
    expect(readFileSync(f.selected.databasePath)).toEqual(before);
    const inspected = await argv(f.entry, ['maintenance', 'inspect', result.backup.directory]);
    expect(inspected.exit).toBe(0);
    expect(JSON.parse(inspected.stdout).backup.manifest).toEqual(result.backup.manifest);
    const db = new Database(f.selected.databasePath);
    db.run("UPDATE session SET title='later current title'");
    db.close(true);
    const wrongStore = await argv(f.entry, [
      'maintenance',
      'restore',
      result.backup.directory,
      ...f.scope,
      '--expected-store',
      'wrong-observed-store',
      '--confirm-data-loss',
    ]);
    expect(wrongStore.exit).toBe(1);
    expect(wrongStore.stderr).toBe('store_identity_mismatch\n');
    const unchanged = new Database(f.selected.databasePath, { readonly: true });
    try {
      expect(unchanged.query('SELECT title FROM session WHERE id=?').get('s')).toEqual({
        title: 'later current title',
      });
    } finally {
      unchanged.close(true);
    }
    const restored = await argv(f.entry, [
      'maintenance',
      'restore',
      result.backup.directory,
      ...f.scope,
      '--expected-store',
      f.storeId,
      '--confirm-data-loss',
    ]);
    expect(restored.exit).toBe(0);
    const receipt = JSON.parse(restored.stdout);
    expect(receipt.storeId).not.toBe(f.storeId);
    expect(receipt.previousDirectoryPreserved).toBe(true);
    expect(existsSync(join(receipt.preservedDirectory, 'core.db'))).toBe(true);
    expect(receipt.newProfileOmits).toContain('credential_vault');
    for (const [, path, bytes] of mcpAssets)
      expect(readFileSync(join(f.selected.profilePath, path))).toEqual(Buffer.from(bytes));
    expect(readFileSync(join(f.selected.profilePath, 'config.jsonc'))).toEqual(
      Buffer.from(configBytes),
    );
    const ui = await nodeAssets(f.directory, f.profile, f.storeId, 'read');
    expect(ui.count).toBe(133);
    expect(ui.creations[0]?.input.expectedStoreId).toBe(f.storeId);
    expect(ui.creations[0]?.phase).toBe('unknown');
    expect(readFileSync(join(f.selected.profilePath, 'ui', 'tui.json'))).toEqual(tuiBytes);
    const tui = JSON.parse(tuiBytes.toString());
    expect(tui.drafts[0].storeId).toBe(f.storeId);
    expect(tui.drafts[0].text).toBe(tuiText);
    const status = await argv(f.entry, ['maintenance', 'status', ...f.scope]);
    expect(status.exit).toBe(0);
    expect(JSON.parse(status.stdout).restore).toBeNull();
    const store = await openSqliteStore(f.profile);
    try {
      expect((await store.getSession('s'))?.title).toBe('backup title');
      expect((await store.getCommand('create'))?.originStoreId).toBe(f.storeId);
      const cold = new Database(f.selected.databasePath, { readonly: true });
      try {
        expect(cold.query('SELECT count(*) AS count FROM run').get()).toEqual({ count: 0 });
      } finally {
        cold.close(true);
      }
      expect(await store.listExecutions('s')).toEqual([]);
      let rejected: unknown;
      try {
        await store.acceptCommand({
          expectedStoreId: f.storeId,
          sessionId: 's',
          commandId: 'old-write',
          subjectId: 'owner',
          request: { kind: 'run.start', content: 'must not execute' },
        });
      } catch (error) {
        rejected = error;
      }
      expect((rejected as { code: string }).code).toBe('store_identity_mismatch');
    } finally {
      await store.close();
    }
  } finally {
    f.close();
  }
}, 30000);
test('built help, invalid argv and readonly status never create a profile; busy preserves data', async () => {
  const f = await fixture();
  try {
    const missing = join(f.directory, 'missing'),
      scope = ['--data-root', missing, '--profile', 'missing'];
    const help = await argv(f.entry, ['maintenance', '--help']);
    expect(help.exit).toBe(0);
    expect(help.stdout).toContain('--confirm-data-loss');
    for (const args of [
      ['maintenance', 'restore', '/not-selected', ...scope, '--expected-store', 'old'],
      ['maintenance', 'backup', ...scope, '--destination', 'relative'],
      ['maintenance', 'status', ...scope, '--unknown'],
    ]) {
      const failure = await argv(f.entry, args);
      expect(failure.exit).toBe(1);
      expect(failure.stderr).toBe('invalid_cli_arguments\n');
      expect(existsSync(missing)).toBe(false);
    }
    const status = await argv(f.entry, ['maintenance', 'status', ...scope]);
    expect(status.exit).toBe(0);
    expect(JSON.parse(status.stdout).restore).toBeNull();
    expect(existsSync(missing)).toBe(false);
    const before = readFileSync(f.selected.databasePath),
      held = acquireProfileAccess(f.profile);
    try {
      const busy = await argv(f.entry, [
        'maintenance',
        'backup',
        ...f.scope,
        '--destination',
        join(f.directory, 'busy-backups'),
      ]);
      expect(busy.exit).toBe(1);
      expect(busy.stderr).toBe('owner_busy\n');
      expect(existsSync(join(f.directory, 'busy-backups'))).toBe(false);
    } finally {
      held.lock.release();
    }
    expect(readFileSync(f.selected.databasePath)).toEqual(before);
    const missingRestore = await argv(f.entry, [
      'maintenance',
      'restore',
      join(f.directory, 'absent-backup'),
      ...scope,
      '--expected-store',
      'old',
      '--confirm-data-loss',
    ]);
    expect(missingRestore.exit).toBe(1);
    expect(existsSync(missing)).toBe(false);
  } finally {
    f.close();
  }
}, 30000);
for (const decision of ['complete', 'rollback'] as const)
  test(`built status and explicit ${decision} reconcile bind the actual original journal observation`, async () => {
    const f = await fixture();
    try {
      const made = JSON.parse(
          (
            await argv(f.entry, [
              'maintenance',
              'backup',
              ...f.scope,
              '--destination',
              join(f.directory, 'backups'),
            ])
          ).stdout,
        ),
        backup = await inspectProfileBackup({ directory: made.backup.directory });
      try {
        await runProfileRestore(
          {
            profile: f.profile,
            expectedStoreId: f.storeId,
            backup,
            intent: 'replace_with_selected_backup',
          },
          async (phase) => {
            if (phase === 'old_moved') throw new Error('owned fixture pause');
          },
        );
      } catch (error) {
        expect((error as Error).message).toBe('owned fixture pause');
      }
      const status = JSON.parse(
          (await argv(f.entry, ['maintenance', 'status', ...f.scope])).stdout,
        ),
        observation = status.restore;
      expect(observation.journal.phase).toBe('old_moved');
      expect(existsSync(f.selected.profilePath)).toBe(false);
      const wrong = await argv(f.entry, [
        'maintenance',
        'reconcile',
        ...f.scope,
        '--restore-id',
        observation.journal.restoreId,
        '--journal-digest',
        '0'.repeat(64),
        '--decision',
        'complete',
        '--confirm-data-loss',
      ]);
      expect(wrong.exit).toBe(1);
      expect(wrong.stderr).toBe('restore_journal_mismatch\n');
      expect(existsSync(f.selected.profilePath)).toBe(false);
      const finished = await argv(f.entry, [
        'maintenance',
        'reconcile',
        ...f.scope,
        '--restore-id',
        observation.journal.restoreId,
        '--journal-digest',
        observation.digest,
        '--decision',
        decision,
        '--confirm-data-loss',
      ]);
      expect(finished.exit).toBe(0);
      expect(JSON.parse(finished.stdout).status).toBe(
        decision === 'complete' ? 'restored' : 'rolled_back',
      );
      expect(JSON.parse(finished.stdout).preservedDirectoryRole).toBe(
        decision === 'complete' ? 'previous_profile' : 'restore_candidate',
      );
      const cold = new Database(f.selected.databasePath, { readonly: true });
      try {
        const metadata = cold.query('SELECT store_id FROM storage_meta').get() as {
          store_id: string;
        };
        expect(metadata.store_id === f.storeId).toBe(decision === 'rollback');
      } finally {
        cold.close(true);
      }
      expect(
        JSON.parse((await argv(f.entry, ['maintenance', 'status', ...f.scope])).stdout).restore,
      ).toBeNull();
    } finally {
      f.close();
    }
  }, 30000);
