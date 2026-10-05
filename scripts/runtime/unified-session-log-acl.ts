import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';

type Store = Awaited<ReturnType<typeof import('@kite-ai/agent/sqlite').openSqliteStore>>;
type NativeSecurity = NonNullable<
  ReturnType<typeof import('@kite-ai/agent/windows-path-security').defaultWindowsPathSecurity>
>;

export function parseSessionLogAclArgs(args: readonly string[]): string | null {
  if (
    args.length > 1 ||
    (args[0] !== undefined &&
      (!args[0].startsWith('--output=') || !isAbsolute(args[0].slice(9)) || args[0].length > 4105))
  )
    throw Error('unified_acl_arguments_invalid');
  return args[0]?.slice(9) ?? null;
}
export async function writeAclEvidence(path: string, evidence: unknown) {
  const serialized = `${JSON.stringify(evidence)}\n`;
  if (Buffer.byteLength(serialized) > 512 * 1024) throw Error('unified_smoke_evidence_limit');
  if (process.platform === 'win32') {
    const { defaultWindowsPathSecurity } = await import('@kite-ai/agent/windows-path-security');
    defaultWindowsPathSecurity()!.writePrivateFile(path, Buffer.from(serialized));
    return;
  }
  const fd = openSync(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  try {
    writeFileSync(fd, serialized);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
function privatePath(path: string, directory: boolean, native?: NativeSecurity) {
  const stat = lstatSync(path);
  if (process.platform === 'win32') {
    if (!native) throw Error('unified_acl_native_backend_missing');
    const before = lstatSync(path, { bigint: true });
    if (directory) native.verifyDirectory(path);
    else native.verifyFile(path);
    const after = lstatSync(path, { bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino || before.nlink !== after.nlink)
      throw Error('unified_acl_native_identity_changed');
    return {
      driver: 'native_windows_path_security',
      kind: directory ? 'directory' : 'file',
      policy: 'current_sid_only_full_control',
      identity: { device: String(after.dev), inode: String(after.ino), nlink: String(after.nlink) },
    };
  }
  if (
    stat.isSymbolicLink() ||
    (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1) ||
    (stat.mode & 0o777) !== (directory ? 0o700 : 0o600) ||
    (process.getuid && stat.uid !== process.getuid())
  )
    throw Error('unified_acl_private_path_failed');
  return {
    driver: 'posix_owner_mode',
    kind: directory ? 'directory' : 'file',
    mode: (stat.mode & 0o777).toString(8),
    uid: stat.uid,
    nlink: stat.nlink,
  };
}
async function rejects(operation: () => Promise<unknown>) {
  try {
    await operation();
  } catch {
    return;
  }
  throw Error('unified_acl_unsafe_path_accepted');
}
export async function runUnifiedSessionLogAcl(): Promise<{
  status: string;
  qualified: boolean;
  driver: string;
  cleanup: string;
  sqlite?: {
    version: string;
    sourceId: string;
    manifestSha256: string | null;
    linkage: string | null;
  };
  objectIds?: string[];
  checks?: string[];
  [key: string]: unknown;
}> {
  const scriptSha256 = createHash('sha256')
    .update(readFileSync(import.meta.path))
    .digest('hex');
  const binding = {
    workflow: process.env.GITHUB_WORKFLOW ?? null,
    runId: process.env.GITHUB_RUN_ID ?? null,
    runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
    repository: process.env.GITHUB_REPOSITORY ?? null,
    commit: process.env.GITHUB_SHA ?? null,
  };
  const base = {
    version: 1,
    scriptSha256,
    binding,
    platform: process.platform,
    arch: process.arch,
    bunVersion: Bun.version,
    driver: 'bun:sqlite',
    runtimeSha256: createHash('sha256').update(readFileSync(process.execPath)).digest('hex'),
  };
  if (
    !['darwin', 'linux', 'win32'].includes(process.platform) ||
    (process.platform === 'win32' && process.arch !== 'x64')
  )
    return {
      ...base,
      status: 'unsupported',
      qualified: false,
      reason: 'native_path_security_platform_unsupported',
      cleanup: 'not_started',
    };
  const { openSqliteStore, resolveProfile, acquireProfileAccess } = await import(
    '@kite-ai/agent/sqlite'
  );
  const { Database } = await import('bun:sqlite');
  const { getLoadedSqliteEngine } = await import('@kite-ai/agent/sqlite-engine');
  let native: NativeSecurity | undefined;
  try {
    const { defaultWindowsPathSecurity } = await import('@kite-ai/agent/windows-path-security');
    native = defaultWindowsPathSecurity();
  } catch (error) {
    return {
      ...base,
      status: 'failed',
      qualified: false,
      cleanup: 'not_started',
      reason: error instanceof Error ? error.message : 'native_backend_failed',
    };
  }
  const container = realpathSync(mkdtempSync(join(tmpdir(), 'kite-unified-log-acl-')));
  const root = native ? join(container, 'private') : container;
  const home = join(root, 'home');
  const options = { dataRoot: join(home, 'data'), profile: 'owned' };
  let store: Store | undefined;
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  let cleanup = 'confirmed';
  let evidence: Awaited<ReturnType<typeof runUnifiedSessionLogAcl>>;
  try {
    if (native) {
      native.createDirectory(root);
      native.createDirectory(home);
    } else {
      chmodSync(root, 0o700);
      mkdirSync(home, { mode: 0o700 });
    }
    store = await openSqliteStore(options);
    const storeId = (await store.getMetadata()).storeId;
    await store.createWorkspace({
      expectedStoreId: storeId,
      id: 'w',
      rootUri: pathToFileURL(root).href,
      name: 'private workspace',
    });
    await store.createSession({
      expectedStoreId: storeId,
      subjectId: 'acl-owner',
      commandId: 'create-original',
      sessionId: 'original',
      workspaceId: 'w',
      title: 'PRIVATE_TITLE_NOT_LOGGED',
    });
    await store.acceptCommand({
      expectedStoreId: storeId,
      subjectId: 'acl-owner',
      commandId: 'original-work',
      sessionId: 'original',
      request: { kind: 'run.start', content: 'PRIVATE_BODY_NOT_LOGGED' },
    });
    const input = {
      expectedStoreId: storeId,
      subjectId: 'acl-owner',
      sessionId: 'original',
      afterCursor: '0',
    };
    const page = await store.getSessionLogs(input);
    if (
      !page.entries.some(
        (e) => e.objectId === 'original-work' && e.recordedStatus === 'accepted',
      ) ||
      !page.complete ||
      JSON.stringify(page).includes('PRIVATE_')
    )
      throw Error('unified_acl_log_facts_invalid');
    const paths = resolveProfile(options);
    const security = [
      root,
      home,
      paths.dataRoot,
      join(paths.dataRoot, '.coordination'),
      paths.coordinationPath,
      paths.profilePath,
    ].map((path) => privatePath(path, true, native));
    for (const path of [
      join(paths.coordinationPath, 'profile-use.lock'),
      paths.databasePath,
      `${paths.databasePath}-wal`,
      `${paths.databasePath}-shm`,
    ])
      security.push(privatePath(path, false, native));
    const access = acquireProfileAccess(options);
    let sqlite: {
      version: string;
      sourceId: string;
      manifestSha256: string | null;
      linkage: string | null;
    };
    try {
      const db = new Database(paths.databasePath, { readonly: true });
      try {
        const actual = db
          .query('SELECT sqlite_version() AS version, sqlite_source_id() AS sourceId')
          .get() as { version: string; sourceId: string };
        const loaded = getLoadedSqliteEngine();
        if (loaded && (loaded.version !== actual.version || loaded.sourceId !== actual.sourceId))
          throw Error('unified_acl_sqlite_selection_mismatch');
        sqlite = {
          ...actual,
          manifestSha256: loaded?.selection.manifestSha256 ?? null,
          linkage: loaded?.linkage ?? null,
        };
      } finally {
        db.close();
      }
    } finally {
      access.lock.release();
    }
    await store.close();
    store = undefined;
    const hashBefore = createHash('sha256').update(readFileSync(paths.databasePath)).digest('hex');
    linkSync(paths.databasePath, join(root, 'hardlink'));
    try {
      await rejects(async () => {
        const unsafe = await openSqliteStore({ ...options, mode: 'readonly' });
        await unsafe.close();
      });
      if (lstatSync(paths.databasePath).nlink !== 2) throw Error('unified_acl_hardlink_repaired');
    } finally {
      unlinkSync(join(root, 'hardlink'));
    }
    symlinkSync(paths.profilePath, join(paths.dataRoot, 'linked'), native ? 'junction' : 'dir');
    try {
      await rejects(async () => {
        const unsafe = await openSqliteStore({ ...options, profile: 'linked', mode: 'readonly' });
        await unsafe.close();
      });
      if (!lstatSync(join(paths.dataRoot, 'linked')).isSymbolicLink())
        throw Error('unified_acl_link_repaired');
    } finally {
      unlinkSync(join(paths.dataRoot, 'linked'));
    }
    function acl(args: string[]) {
      const result = spawnSync('icacls.exe', args, {
        encoding: 'utf8',
        timeout: 10000,
        windowsHide: true,
      });
      if (result.status !== 0 || result.error) throw Error('unified_acl_icacls_failed');
      return result.stdout;
    }
    if (native) acl([paths.databasePath, '/grant', '*S-1-1-0:(F)']);
    else chmodSync(paths.databasePath, 0o644);
    const unsafeAcl = native ? acl([paths.databasePath]) : null;
    try {
      await rejects(async () => {
        const unsafe = await openSqliteStore({ ...options, mode: 'readonly' });
        await unsafe.close();
      });
      if (native) {
        await rejects(async () => native.verifyFile(paths.databasePath));
        await rejects(async () => native.secureFile(paths.databasePath));
        if (acl([paths.databasePath]) !== unsafeAcl) throw Error('unified_acl_silently_repaired');
      } else if ((lstatSync(paths.databasePath).mode & 0o777) !== 0o644)
        throw Error('unified_acl_silently_repaired');
      if (
        hashBefore !== createHash('sha256').update(readFileSync(paths.databasePath)).digest('hex')
      )
        throw Error('unified_acl_unsafe_bytes_changed');
    } finally {
      // Only undo the test's own injected broad ACE; rejected opens must not repair it.
      if (native) {
        acl([paths.databasePath, '/remove:g', '*S-1-1-0']);
        native.verifyFile(paths.databasePath);
      } else chmodSync(paths.databasePath, 0o600);
    }
    const cold = await openSqliteStore({ ...options, mode: 'readonly' });
    store = cold;
    const before = (await cold.getMetadata()).lastChangeCursor;
    const observed = await cold.getSessionLogs({ ...input, upperCursor: page.upperCursor });
    await rejects(() => cold.getSessionLogs({ ...input, expectedStoreId: 'foreign-store' }));
    await rejects(() => cold.getSessionLogs({ ...input, subjectId: 'foreign-subject' }));
    const after = (await cold.getMetadata()).lastChangeCursor;
    if (
      JSON.stringify(observed.entries) !== JSON.stringify(page.entries) ||
      before !== after ||
      hashBefore !== createHash('sha256').update(readFileSync(paths.databasePath)).digest('hex')
    )
      throw Error('unified_acl_cold_facts_changed');
    await cold.close();
    store = undefined;
    evidence = {
      ...base,
      status: 'passed',
      qualified: true,
      cleanup,
      sqlite,
      storeId,
      sessionId: 'original',
      upperCursor: page.upperCursor,
      cursor: after,
      objectIds: page.entries.map((e) => e.objectId),
      security,
      checks: [
        'actual_session_event_metadata',
        native ? 'private_native_windows_owner_dacl_identity' : 'private_posix_owner_modes',
        'hardlink_rejected',
        native ? 'profile_junction_rejected' : 'profile_symlink_rejected',
        native ? 'broadened_dacl_rejected_without_repair' : 'public_mode_rejected_without_repair',
        'cold_original_ids_fixed_upper',
        'zero_cold_business_writes',
        'foreign_store_and_subject_rejected',
      ],
    };
  } catch (error) {
    evidence = {
      ...base,
      status: 'failed',
      qualified: false,
      reason: error instanceof Error ? error.message.slice(0, 512) : 'unified_acl_failed',
      cleanup,
    };
  } finally {
    try {
      await store?.close();
    } catch {
      cleanup = 'unconfirmed';
    }
    if (cleanup === 'confirmed') {
      try {
        rmSync(container, { recursive: true, force: true });
      } catch {
        cleanup = 'unconfirmed';
      }
    }
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
  return cleanup === 'confirmed'
    ? evidence
    : {
        ...evidence,
        status: 'failed',
        qualified: false,
        reason: 'unified_acl_cleanup_unconfirmed',
        cleanup,
      };
}
if (import.meta.main) {
  const output = parseSessionLogAclArgs(process.argv.slice(2));
  const evidence = await runUnifiedSessionLogAcl();
  if (output) await writeAclEvidence(output, evidence);
  console.log(JSON.stringify(evidence));
  if (!evidence.qualified) process.exitCode = 1;
}
