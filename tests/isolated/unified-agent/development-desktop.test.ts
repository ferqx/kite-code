import { Database } from 'bun:sqlite';
import { expect, spyOn, test } from 'bun:test';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { acquireProfileAccess } from '@kite-ai/agent/profile-access';
import { openSqliteStore, preflightSqliteStore, sqliteStorageAssets } from '@kite-ai/agent/sqlite';
import { defaultWindowsPathSecurity, privateDirectory } from '@kite-ai/agent/windows-path-security';
import { ownedUserConfiguration } from '../../../apps/service/test/fixtures/user-configuration-fixture';
import {
  createDevelopmentDesktopDirectory,
  prepareDevelopmentDesktopProfile,
} from '../../../scripts/development/unified-desktop';
import {
  initializeDesktopBuildEnvironment,
  type WindowsDesktopBuildTools,
} from '../../../scripts/development/windows-desktop-environment';
import { fixturePermissions, temporaryDirectory } from '../../fixtures/test-filesystem';

const visualStudio = 'C:\\Program Files\\开发工具\\Visual Studio',
  compilerEnvironment = {
    PATH: 'C:\\编译工具;C:\\用户工具',
    INCLUDE: 'C:\\头文件',
    LIB: 'C:\\库',
    LIBPATH: 'C:\\库路径',
    VCToolsInstallDir: `${visualStudio}\\VC\\Tools\\MSVC\\14.51.36231\\`,
    VCToolsVersion: '14.51.36231',
    WindowsSdkDir: 'C:\\Program Files (x86)\\Windows Kits\\10\\',
    WindowsSDKVersion: '10.0.26100.0\\',
    VSCMD_ARG_HOST_ARCH: 'x64',
    VSCMD_ARG_TGT_ARCH: 'x64',
  };
const compilerOutput = (values = compilerEnvironment) =>
  Object.entries(values)
    .map(([key, value]) => `${key}=${value}`)
    .join('\r\n');
function buildToolsFixture(options: { output?: string; missing?: RegExp } = {}) {
  const calls: { executable: string; args: string[]; unicode?: boolean; verbatim?: boolean }[] = [];
  const file = (path: string) => {
    if (options.missing?.test(path)) throw Error('windows_desktop_build_tools_unavailable');
    return win32.normalize(path);
  };
  const tools: WindowsDesktopBuildTools = {
    file,
    directory: (path) => win32.normalize(path),
    run(executable, args, settings) {
      calls.push({ executable, args, unicode: settings.unicode, verbatim: settings.verbatim });
      expect(settings.env.CL).toBe('');
      expect(settings.env._CL_).toBe('');
      expect('cl' in settings.env).toBe(false);
      return executable.endsWith('vswhere.exe')
        ? `${visualStudio}\r\n`
        : (options.output ?? `${compilerOutput()}\r\nCL=/injected\r\nUNRELATED=changed\r\n`);
    },
  };
  return { tools, calls };
}
const ordinaryWindowsEnvironment = () => ({
  'ProgramFiles(x86)': 'C:\\Program Files (x86)',
  SystemRoot: 'C:\\Windows',
  Path: 'C:\\用户工具',
  CL: '/inherited',
  cl: '/also-inherited',
  _CL_: '/inherited',
  UNRELATED: 'preserved',
});

test('ordinary Windows shell gets installed x64 compiler/SDK environment without importing unrelated tool output', () => {
  const env: Record<string, string | undefined> = ordinaryWindowsEnvironment(),
    fixture = buildToolsFixture();
  initializeDesktopBuildEnvironment({ env, platform: 'win32', arch: 'x64', tools: fixture.tools });
  expect(fixture.calls).toHaveLength(2);
  expect(fixture.calls[0]!.executable).toBe(
    'C:\\Program Files (x86)\\Microsoft Visual Studio\\Installer\\vswhere.exe',
  );
  expect(fixture.calls[0]!.args).toContain('Microsoft.VisualStudio.Component.VC.Tools.x86.x64');
  expect(fixture.calls[1]!.executable).toBe('C:\\Windows\\System32\\cmd.exe');
  expect(fixture.calls[1]!.args.at(-1)).toContain('-arch=x64 -host_arch=x64');
  expect(fixture.calls[1]!.unicode).toBe(true);
  expect(fixture.calls[1]!.verbatim).toBe(true);
  expect(env.PATH).toBe(compilerEnvironment.PATH);
  expect('Path' in env).toBe(false);
  expect(env.KITE_WINDOWS_MSVC).toBe(
    win32.join(compilerEnvironment.VCToolsInstallDir, 'bin/Hostx64/x64/cl.exe'),
  );
  expect(env.INCLUDE).toBe(compilerEnvironment.INCLUDE);
  expect(env.LIB).toBe(compilerEnvironment.LIB);
  expect(env.CL).toBe('');
  expect('cl' in env).toBe(false);
  expect(env._CL_).toBe('');
  expect(env.UNRELATED).toBe('preserved');
});

test('initialized x64 environment reuses an explicit compiler and other platforms do no tool discovery or mutation', () => {
  const fixture = buildToolsFixture(),
    env = { ...compilerEnvironment, KITE_WINDOWS_MSVC: 'C:\\自选工具\\cl.exe' };
  initializeDesktopBuildEnvironment({ env, platform: 'win32', arch: 'x64', tools: fixture.tools });
  expect(fixture.calls).toEqual([]);
  expect(env.KITE_WINDOWS_MSVC).toBe('C:\\自选工具\\cl.exe');
  for (const platform of ['darwin', 'linux'] as const) {
    const other = ordinaryWindowsEnvironment(),
      original = { ...other };
    initializeDesktopBuildEnvironment({ env: other, platform, arch: 'x64', tools: fixture.tools });
    expect(other).toEqual(original);
    expect(fixture.calls).toEqual([]);
  }
});

test('incomplete and x86 developer environments are initialized for x64 rather than reused', () => {
  for (const initial of [
    { ...compilerEnvironment, LIB: undefined },
    { ...compilerEnvironment, VSCMD_ARG_TGT_ARCH: 'x86' },
  ]) {
    const env: Record<string, string | undefined> = {
        ...ordinaryWindowsEnvironment(),
        ...initial,
      },
      fixture = buildToolsFixture();
    initializeDesktopBuildEnvironment({
      env,
      platform: 'win32',
      arch: 'x64',
      tools: fixture.tools,
    });
    expect(fixture.calls).toHaveLength(2);
    expect(env.LIB).toBe(compilerEnvironment.LIB);
    expect(env.VSCMD_ARG_TGT_ARCH).toBe('x64');
  }
});

test('missing tools/SDK, invalid overrides and failed x64 initialization fail before publishing environment changes', () => {
  for (const missing of [/vswhere\.exe$/, /bcrypt\.lib$/]) {
    const env = ordinaryWindowsEnvironment(),
      original = { ...env },
      fixture = buildToolsFixture({ missing });
    expect(() =>
      initializeDesktopBuildEnvironment({
        env,
        platform: 'win32',
        arch: 'x64',
        tools: fixture.tools,
      }),
    ).toThrow('windows_desktop_build_tools_unavailable');
    expect(env).toEqual(original);
  }
  for (const output of [
    '',
    compilerOutput({ ...compilerEnvironment, VSCMD_ARG_TGT_ARCH: 'x86' }),
    compilerOutput({ ...compilerEnvironment, VCToolsInstallDir: 'C:\\unrelated-toolset\\' }),
    `${compilerOutput()}\r\nLIB=C:\\different`,
  ]) {
    const env = ordinaryWindowsEnvironment(),
      original = { ...env },
      fixture = buildToolsFixture({ output });
    expect(() =>
      initializeDesktopBuildEnvironment({
        env,
        platform: 'win32',
        arch: 'x64',
        tools: fixture.tools,
      }),
    ).toThrow('windows_desktop_build_environment_failed');
    expect(env).toEqual(original);
  }
  const env = { ...ordinaryWindowsEnvironment(), KITE_WINDOWS_MSVC: 'relative\\cl.exe' },
    fixture = buildToolsFixture();
  expect(() =>
    initializeDesktopBuildEnvironment({
      env,
      platform: 'win32',
      arch: 'x64',
      tools: fixture.tools,
    }),
  ).toThrow('windows_desktop_compiler_override_invalid');
  expect(fixture.calls).toEqual([]);
  expect(() =>
    initializeDesktopBuildEnvironment({
      env,
      platform: 'win32',
      arch: 'arm64',
      tools: fixture.tools,
    }),
  ).toThrow('windows_desktop_build_platform_unsupported');
});

test('desktop development application directories are private and independent of existing cache contents', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-development-desktop-directory-')));
  try {
    const cache = join(root, '.cache');
    mkdirSync(cache);
    const existing = join(cache, 'existing-cache');
    writeFileSync(existing, 'preserved');
    const first = createDevelopmentDesktopDirectory(root);
    const second = createDevelopmentDesktopDirectory(root);
    expect(first).not.toBe(second);
    for (const directory of [first, second]) {
      expect(readdirSync(directory)).toEqual([]);
      if (process.platform === 'win32')
        expect(() => defaultWindowsPathSecurity()!.verifyDirectory(directory)).not.toThrow();
      else expect(statSync(directory).mode & 0o777).toBe(0o700);
    }
    expect(readFileSync(existing, 'utf8')).toBe('preserved');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('desktop development pure help and missing built Service never build, launch or write a checkout/profile', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-development-desktop-')));
  const entry = pathToFileURL(
    join(import.meta.dir, '../../../scripts/development/unified-desktop.ts'),
  ).href;
  const execute = async (argv: readonly string[]) => {
    const program = `import {runDevelopmentDesktop} from ${JSON.stringify(entry)};try{process.exitCode=await runDevelopmentDesktop({argv:${JSON.stringify(argv)},root:${JSON.stringify(root)},executable:'/absent-development-runtime'});}catch(error){console.error(error.code??error.message);process.exitCode=1;}`;
    const child = Bun.spawn([process.execPath, '-e', program], {
      cwd: root,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const timeout = setTimeout(() => child.kill('SIGKILL'), 5000);
    try {
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      return { code, stdout, stderr };
    } finally {
      clearTimeout(timeout);
      if (child.exitCode === null) {
        child.kill('SIGKILL');
        await child.exited;
      }
    }
  };
  try {
    const help = await execute(['--help']);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain('Kite desktop development');
    expect(help.stdout).toContain('~/.kite-code/development');
    expect(help.stderr).toBe('');
    expect(readdirSync(root)).toEqual([]);
    const missing = await execute([]);
    expect(missing).toEqual({
      code: 1,
      stdout: '',
      stderr: 'development_service_asset_unavailable\n',
    });
    expect(readdirSync(root)).toEqual([]);
    const invalid = await execute(['--help', '--watch']);
    expect(invalid.stderr).toBe('desktop_development_arguments_invalid\n');
    expect(invalid.code).toBe(1);
    expect(readdirSync(root)).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 15000);

for (const { formatMajor, currentChecksum, label } of [
  { formatMajor: 1, currentChecksum: false, label: 'same-major legacy schema' },
  { formatMajor: 1, currentChecksum: true, label: 'old schema behind a forged current header' },
  { formatMajor: 2, currentChecksum: false, label: 'unsupported major 2' },
])
  test(`desktop development requires confirmation for ${label} before preparing Electron or changing data`, async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-development-old-profile-')));
    const home = join(root, 'home');
    const userConfiguration = ownedUserConfiguration(home);
    const profile = join(home, '.kite-code', 'development');
    privateDirectory(profile);
    const manifest = join(profile, 'profile.json');
    const database = join(profile, 'core.db');
    const security = defaultWindowsPathSecurity();
    const writePrivate = (path: string, bytes: Uint8Array) => {
      if (security) security.writePrivateFile(path, bytes);
      else writeFileSync(path, bytes, { mode: 0o600 });
    };
    const header = {
      formatMajor,
      ...(currentChecksum
        ? {
            schemaChecksum: createHash('sha256')
              .update(
                readFileSync(
                  join(
                    import.meta.dir,
                    '../../../packages/agent/src/storage/migrations/0001-baseline.sql',
                  ),
                ),
              )
              .digest('hex'),
          }
        : {}),
    };
    writePrivate(manifest, Buffer.from(`${JSON.stringify(header)}\n`));
    writePrivate(database, Buffer.alloc(0));
    const db = new Database(database, { create: true });
    db.exec(
      `CREATE TABLE storage_meta(format_major INTEGER NOT NULL); INSERT INTO storage_meta VALUES(${formatMajor}); CREATE TABLE legacy_marker(value TEXT NOT NULL); INSERT INTO legacy_marker VALUES('original legacy schema data');`,
    );
    db.close(true);
    const originalManifest = readFileSync(manifest);
    const originalDatabase = readFileSync(database);
    const service = join(root, 'apps', 'service', 'dist');
    mkdirSync(service, { recursive: true });
    writeFileSync(
      join(service, 'main.js'),
      '// Exact selected Service asset; startup must not execute it.',
    );
    const launchMarker = join(root, 'unexpected-launch');
    const entry = pathToFileURL(
      join(import.meta.dir, '../../../scripts/development/unified-desktop.ts'),
    ).href;
    const program = `import {writeFileSync} from 'node:fs';import {runDevelopmentDesktop} from ${JSON.stringify(entry)};try{process.exitCode=await runDevelopmentDesktop({argv:[],root:${JSON.stringify(root)},executable:process.execPath,spawnElectron(){writeFileSync(${JSON.stringify(launchMarker)},'launched');throw Error('unexpected_electron_launch');}});}catch(error){console.error(error.code??error.message);process.exitCode=1;}`;
    const child = Bun.spawn([process.execPath, '-e', program], {
      cwd: root,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, ...userConfiguration.homeEnvironment },
    });
    const timeout = setTimeout(() => child.kill('SIGKILL'), 5000);
    try {
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect({ code, stderr, stdout }).toEqual({
        code: 1,
        stderr: 'development_profile_confirmation_required\n',
        stdout: '',
      });
      const backups = readdirSync(join(home, '.kite-code')).filter((name) =>
        name.startsWith('development-backup-'),
      );
      expect(backups).toHaveLength(0);
      expect(existsSync(join(root, 'apps', 'desktop'))).toBe(false);
      expect(existsSync(join(root, '.cache'))).toBe(false);
      expect(existsSync(launchMarker)).toBe(false);
      expect(readFileSync(manifest)).toEqual(originalManifest);
      expect(readFileSync(database)).toEqual(originalDatabase);
      expect(readdirSync(profile).sort()).toEqual(['core.db', 'profile.json']);
      expect(existsSync(`${database}-wal`)).toBe(false);
      expect(existsSync(`${database}-shm`)).toBe(false);
      const reader = new Database(database, { readonly: true });
      try {
        expect(reader.query('SELECT value FROM legacy_marker').get()).toEqual({
          value: 'original legacy schema data',
        });
        expect(reader.query('SELECT format_major FROM storage_meta').get()).toEqual({
          format_major: formatMajor,
        });
      } finally {
        reader.close(true);
      }
      expect(readFileSync(database)).toEqual(originalDatabase);
    } finally {
      clearTimeout(timeout);
      if (child.exitCode === null) {
        child.kill('SIGKILL');
        await child.exited;
      }
      rmSync(root, { recursive: true, force: true });
    }
  }, 10000);

test('development recovery preserves the whole old directory and global configuration; fresh and compatible profiles are reused', async () => {
  const dataRoot = temporaryDirectory('kite-development-profile-recovery-');
  const options = { dataRoot, profile: 'development' };
  const profile = join(dataRoot, options.profile);
  const security = defaultWindowsPathSecurity();
  const writePrivate = (path: string, value: string) => {
    if (security) security.writePrivateFile(path, Buffer.from(value));
    else writeFileSync(path, value, { mode: 0o600 });
  };
  try {
    expect(await prepareDevelopmentDesktopProfile(dataRoot)).toBeUndefined();
    expect(existsSync(profile)).toBe(false);
    privateDirectory(join(profile, 'blobs'));
    writePrivate(join(profile, 'profile.json'), '{"formatMajor":1}');
    writePrivate(join(profile, 'core.db'), 'old database bytes');
    writePrivate(join(profile, 'core.db-wal'), 'old WAL bytes');
    writePrivate(join(profile, 'core.db-shm'), 'old SHM bytes');
    writePrivate(join(profile, 'blobs', 'original'), 'original attachment');
    writePrivate(join(dataRoot, 'kite-code.jsonc'), 'original model configuration');
    const snapshot = [
      'profile.json',
      'core.db',
      'core.db-wal',
      'core.db-shm',
      'blobs/original',
    ].map((name) => [name, readFileSync(join(profile, name))] as const);
    let confirmations = 0;
    await expect(
      prepareDevelopmentDesktopProfile(dataRoot, async (backup) => {
        confirmations++;
        expect(backup.startsWith(join(dataRoot, 'development-backup-'))).toBe(true);
        for (const [name, bytes] of snapshot)
          expect(readFileSync(join(profile, name))).toEqual(bytes);
        expect(existsSync(backup)).toBe(false);
        return false;
      }),
    ).rejects.toThrow('development_profile_reset_cancelled');
    expect(confirmations).toBe(1);
    expect(readdirSync(dataRoot).filter((name) => name.startsWith('development-backup-'))).toEqual(
      [],
    );
    const backup = await prepareDevelopmentDesktopProfile(dataRoot, async () => {
      confirmations++;
      return true;
    });
    expect(confirmations).toBe(2);
    expect(backup).toBeDefined();
    expect(existsSync(profile)).toBe(false);
    for (const [name, bytes] of snapshot) expect(readFileSync(join(backup!, name))).toEqual(bytes);
    expect(readFileSync(join(dataRoot, 'kite-code.jsonc'), 'utf8')).toBe(
      'original model configuration',
    );
    expect(await prepareDevelopmentDesktopProfile(dataRoot)).toBeUndefined();
    const store = await openSqliteStore(options);
    const metadata = await store.getMetadata();
    await store.close();
    const database = readFileSync(join(profile, 'core.db'));
    const header = readFileSync(join(profile, 'profile.json'));
    expect(await prepareDevelopmentDesktopProfile(dataRoot)).toBeUndefined();
    expect(await preflightSqliteStore(options)).toMatchObject({
      status: 'compatible',
      storeId: metadata.storeId,
    });
    expect(readFileSync(join(profile, 'core.db'))).toEqual(database);
    expect(readFileSync(join(profile, 'profile.json'))).toEqual(header);
    fixturePermissions(join(profile, 'core.db'), 0o644);
    try {
      await expect(
        prepareDevelopmentDesktopProfile(dataRoot, async () => {
          throw Error('access_denial_must_not_request_profile_reset');
        }),
      ).rejects.toMatchObject({ code: 'store_access_denied' });
      expect(readFileSync(join(profile, 'core.db'))).toEqual(database);
    } finally {
      fixturePermissions(join(profile, 'core.db'), 0o600);
    }
    expect(await prepareDevelopmentDesktopProfile(dataRoot)).toBeUndefined();
    expect(
      readdirSync(dataRoot).filter((name) => name.startsWith('development-backup-')),
    ).toHaveLength(1);
  } finally {
    expect(realpathSync(dataRoot)).toBe(dataRoot);
    rmSync(dataRoot, { recursive: true });
  }
});

for (const target of ['manifest', 'baseline'] as const)
  for (const code of ['EACCES', 'EIO'] as const)
    for (const failureAt of [1, 2])
      test(`development recovery stops on ${target} ${code} at preflight ${failureAt} without prompting or moving healthy data`, async () => {
        const dataRoot = temporaryDirectory('kite-development-profile-read-failure-');
        const options = { dataRoot, profile: 'development' };
        const profile = join(dataRoot, options.profile);
        try {
          const store = await openSqliteStore(options);
          const metadata = await store.getMetadata();
          await store.close();
          const manifest = join(profile, 'profile.json');
          const database = readFileSync(join(profile, 'core.db'));
          const header = readFileSync(manifest);
          const failedPath =
            target === 'manifest' ? manifest : fileURLToPath(sqliteStorageAssets().baseline);
          const originalRead = fs.readFileSync;
          let reads = 0;
          let confirmations = 0;
          const read = spyOn(fs, 'readFileSync').mockImplementation(((path, ...args) => {
            const name = path instanceof URL ? fileURLToPath(path) : String(path);
            if (name === failedPath) {
              if (++reads >= failureAt)
                throw Object.assign(new Error('fixture_read_failed'), { code });
              // The first observation can be incompatible while a peer repairs
              // the profile before EX admission. Only the second read then fails.
              return target === 'manifest' ? '{"formatMajor":2}' : Buffer.from('old baseline');
            }
            return (originalRead as (...args: unknown[]) => unknown)(path, ...args);
          }) as typeof fs.readFileSync);
          try {
            await expect(
              prepareDevelopmentDesktopProfile(dataRoot, async () => {
                confirmations++;
                return true;
              }),
            ).rejects.toMatchObject({
              code:
                failureAt === 2
                  ? code
                  : code === 'EACCES'
                    ? 'store_access_denied'
                    : 'store_preflight_failed',
            });
          } finally {
            read.mockRestore();
          }
          expect(reads).toBe(failureAt);
          expect(confirmations).toBe(0);
          expect(
            readdirSync(dataRoot).filter((name) => name.startsWith('development-backup-')),
          ).toEqual([]);
          expect(readFileSync(join(profile, 'core.db'))).toEqual(database);
          expect(readFileSync(manifest)).toEqual(header);
          expect(await preflightSqliteStore(options)).toMatchObject({
            status: 'compatible',
            storeId: metadata.storeId,
          });
        } finally {
          expect(realpathSync(dataRoot)).toBe(dataRoot);
          rmSync(dataRoot, { recursive: true });
        }
      });

test('development recovery refuses active profile use and pending restore without moving old data', async () => {
  const dataRoot = temporaryDirectory('kite-development-profile-busy-');
  const options = { dataRoot, profile: 'development' };
  const profile = join(dataRoot, options.profile);
  try {
    privateDirectory(profile);
    const header = join(profile, 'profile.json');
    const security = defaultWindowsPathSecurity();
    if (security) security.writePrivateFile(header, Buffer.from('{"formatMajor":1}'));
    else writeFileSync(header, '{"formatMajor":1}', { mode: 0o600 });
    const original = readFileSync(header);
    const access = acquireProfileAccess(options);
    try {
      await expect(prepareDevelopmentDesktopProfile(dataRoot)).rejects.toMatchObject({
        code: 'owner_busy',
      });
    } finally {
      access.lock.release();
    }
    expect(readFileSync(header)).toEqual(original);
    expect(readdirSync(dataRoot).filter((name) => name.startsWith('development-backup-'))).toEqual(
      [],
    );
    const journal = join(access.coordinationPath, 'restore-journal.json');
    if (security) security.writePrivateFile(journal, Buffer.from('{}'));
    else writeFileSync(journal, '{}', { mode: 0o600 });
    await expect(prepareDevelopmentDesktopProfile(dataRoot)).rejects.toMatchObject({
      code: 'restore_reconciliation_required',
    });
    expect(readFileSync(header)).toEqual(original);
    expect(readFileSync(journal, 'utf8')).toBe('{}');
    expect(readdirSync(dataRoot).filter((name) => name.startsWith('development-backup-'))).toEqual(
      [],
    );
  } finally {
    expect(realpathSync(dataRoot)).toBe(dataRoot);
    rmSync(dataRoot, { recursive: true });
  }
});

test.skipIf(process.platform !== 'darwin')(
  'real development Main reports Service admission failure, waits for readiness and drains its owned process',
  async () => {
    const repository = realpathSync(join(import.meta.dir, '../../..'));
    const cache = join(repository, '.cache');
    mkdirSync(cache, { recursive: true });
    const root = realpathSync(mkdtempSync(join(cache, 'desktop-startup-')));
    const userConfiguration = ownedUserConfiguration(join(root, 'home'));
    const source = join(root, 'apps/service/src');
    const desktop = join(root, 'apps/desktop');
    const electronPackage = join(desktop, 'node_modules/electron');
    const shell = join(root, 'packages/agent/dist/jobs');
    const dependency = join(root, 'node_modules/@kite-ai/startup-fixture');
    const client = join(root, 'packages/client/src');
    for (const directory of [
      source,
      electronPackage,
      shell,
      dependency,
      client,
      join(root, 'apps/service/dist'),
    ])
      mkdirSync(directory, { recursive: true });
    writeFileSync(join(dependency, 'package.json'), '{"type":"module","main":"index.ts"}');
    writeFileSync(
      join(dependency, 'index.ts'),
      "export * from '../../../packages/client/src/observation.ts';",
    );
    writeFileSync(join(client, 'known.ts'), 'export const available = 1;');
    writeFileSync(join(root, 'apps/service/dist/main.js'), '// selected development asset');
    writeFileSync(join(desktop, 'package.json'), '{"type":"module"}');
    writeFileSync(join(electronPackage, 'package.json'), '{"main":"index.cjs"}');
    writeFileSync(
      join(electronPackage, 'index.cjs'),
      `module.exports=require(${JSON.stringify(join(repository, 'apps/desktop/node_modules/electron'))});`,
    );
    writeFileSync(
      join(desktop, 'index.html'),
      '<html><body><main>Isolated development startup</main></body></html>',
    );
    writeFileSync(
      join(shell, 'shell.js'),
      `export * from ${JSON.stringify(pathToFileURL(join(repository, 'packages/agent/dist/jobs/shell.js')).href)};`,
    );
    const driver = join(root, 'driver.ts');
    const observeService =
      "const cp=require('node:child_process');const spawn=cp.spawn;cp.spawn=function(...args){const child=spawn.apply(this,args);if(String(args[1]?.[0]).endsWith('/main.js'))process.stdout.write('SERVICE_PID='+child.pid+'\\n');return child;};";
    writeFileSync(
      driver,
      `import {mkdirSync,writeFileSync} from 'node:fs';import {join} from 'node:path';import {runDevelopmentDesktop} from ${JSON.stringify(pathToFileURL(join(repository, 'scripts/development/unified-desktop.ts')).href)};
try { const code=await runDevelopmentDesktop({root:${JSON.stringify(root)},spawnElectron(executable,outdir,env){if(process.platform==='darwin'&&process.arch==='arm64'&&executable!==join(outdir,'electron/Electron.app/Contents/MacOS/Electron'))throw Error('development_resize_runtime_not_selected');const data=join(outdir,'isolated-electron-data');mkdirSync(data,{mode:0o700});writeFileSync(join(outdir,'isolated-main.cjs'),${JSON.stringify(observeService)}+\`const {app}=require('electron');app.setPath('userData',\${JSON.stringify(data)});app.setPath('sessionData',\${JSON.stringify(data)});require('./main.cjs');if(process.platform==='darwin'&&process.arch==='arm64'&&!app.commandLine.getSwitchValue('enable-features').split(',').includes('CATransactionV2'))throw Error('development_resize_policy_not_selected');\`);writeFileSync(join(outdir,'package.json'),JSON.stringify({main:'isolated-main.cjs'}));const child=Bun.spawn([executable,outdir],{cwd:${JSON.stringify(root)},env,stdin:'pipe',stdout:'pipe',stderr:'inherit'});void(async()=>{for await(const chunk of child.stdout)process.stdout.write(chunk);})();process.stdout.write('ELECTRON_PID='+child.pid+'\\n');return child;}});process.stdout.write('DEVELOPMENT_EXIT='+code+'\\n');process.exitCode=code; }
catch(error){console.error(error);process.exitCode=1;}`,
    );
    try {
      for (const scenario of ['load-failed', 'failed', 'ready'] as const) {
        const observation = join(client, 'observation.ts');
        const invalid =
          "import {missingObservation} from './known';export const observation=missingObservation();";
        writeFileSync(
          observation,
          scenario === 'load-failed' ? invalid : 'export const observation = 1;',
        );
        writeFileSync(
          join(source, 'main.ts'),
          scenario === 'failed'
            ? "if(import.meta.main) throw Error('isolated_service_startup_failure');"
            : `import {observation} from '@kite-ai/startup-fixture';export {observation};import {runServiceProcess} from ${JSON.stringify(join(repository, 'apps/service/src/main.ts'))};if(import.meta.main)await runServiceProcess();`,
        );
        const child = Bun.spawn([process.execPath, driver], {
          cwd: root,
          stdin: 'ignore',
          stdout: 'pipe',
          stderr: 'pipe',
          env: {
            ...process.env,
            ...userConfiguration.homeEnvironment,
            BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0',
          },
        });
        let stdout = '';
        let requestedReload = false,
          repaired = false,
          stopped = false,
          oldServiceAlive = false;
        const output = (async () => {
          for await (const chunk of child.stdout) {
            stdout += new TextDecoder().decode(chunk);
            if (
              scenario === 'ready' &&
              !requestedReload &&
              stdout.includes('[desktop:dev] Service ready;')
            ) {
              requestedReload = true;
              writeFileSync(observation, invalid);
            }
            if (
              scenario === 'ready' &&
              !stopped &&
              stdout.includes('[desktop:dev] Service updated;')
            ) {
              stopped = true;
              child.kill('SIGTERM');
            }
          }
        })();
        const errors = (async () => {
          let stderr = '';
          for await (const chunk of child.stderr) {
            stderr += new TextDecoder().decode(chunk);
            if (
              scenario === 'ready' &&
              !repaired &&
              stderr.includes('development_service_load_failed') &&
              stderr.includes('missingObservation')
            ) {
              repaired = true;
              const original = Number(/SERVICE_PID=(\d+)/.exec(stdout)?.[1]);
              try {
                process.kill(original, 0);
                oldServiceAlive = [...stdout.matchAll(/SERVICE_PID=(\d+)/g)].length === 1;
              } catch {
                /* Assert the original owner below. */
              }
              writeFileSync(observation, 'export const observation = 2;');
            }
          }
          return stderr;
        })();
        const timeout = setTimeout(() => child.kill('SIGKILL'), 30000);
        try {
          const [code, , stderr] = await Promise.all([child.exited, output, errors]);
          if (code !== (scenario === 'ready' ? 143 : 1))
            console.error({ scenario, code, stdout, stderr });
          expect(code).toBe(scenario === 'ready' ? 143 : 1);
          expect(stdout.includes('[desktop:dev] Service ready;')).toBe(scenario === 'ready');
          if (scenario === 'failed') expect(stderr).toContain('bootstrap_channel_closed');
          if (scenario === 'load-failed') {
            expect(stderr).toContain('development_service_load_failed');
            expect(stderr).toContain('missingObservation');
            expect(stdout).not.toContain('ELECTRON_PID=');
          } else {
            const pids = [...stdout.matchAll(/(?:ELECTRON|SERVICE)_PID=(\d+)/g)].map((match) =>
              Number(match[1]),
            );
            expect(pids.length).toBe(scenario === 'ready' ? 3 : 2);
            for (const pid of pids) {
              expect(pid).toBeGreaterThan(0);
              expect(() => process.kill(pid, 0)).toThrow();
            }
          }
          if (scenario === 'ready') {
            expect(stdout).toContain('DEVELOPMENT_EXIT=143');
            expect(oldServiceAlive).toBe(true);
            expect(repaired).toBe(true);
            expect(stdout.match(/Service updated;/g)).toHaveLength(1);
            expect(existsSync(join(root, 'home', '.kite-code', 'development', 'core.db'))).toBe(
              true,
            );
            expect(
              existsSync(join(root, 'home', '.kite-code', 'development', 'development', 'core.db')),
            ).toBe(false);
          }
          expect(existsSync(join(root, '.kite-code'))).toBe(false);
          expect(readdirSync(join(root, '.cache'))).toEqual([]);
        } finally {
          clearTimeout(timeout);
          if (child.exitCode === null) {
            child.kill('SIGKILL');
            await child.exited;
          }
        }
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
  65000,
);
