import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseSqliteReleaseIdentity } from '../../apps/service/src/sqlite-release-assets';
import { prepareDevelopmentBrowserAssets } from '../../packages/agent/scripts/prepare-browser-assets';
import { compileSqlite, sqliteLibraryBasename } from '../release/compile-sqlite';
import {
  cachedNodeDistribution,
  extractNodeDistribution,
  extractReviewedSqlite,
  prepareNodeBuildInputs,
} from '../release/node-inputs';
import { spawnSync as spawnProcessSync } from '../tooling/process';
import { initializeDesktopBuildEnvironment } from './windows-desktop-environment';

const digest = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');

function nativeRuntimeSourceDigest(repository: string) {
  const source = join(repository, 'packages/agent/native/runtime');
  const inputs = readdirSync(source)
    .filter((name) => /\.(?:cc|h)$/u.test(name))
    .sort()
    .map((name) => [name, digest(readFileSync(join(source, name)))]);
  return digest(JSON.stringify([process.platform, process.arch, inputs]));
}

function preparedAddonMatches(out: string, sourceDigest: string) {
  try {
    const built = readFileSync(join(out, 'runtime-native-development.sha256'), 'utf8');
    const addon = readFileSync(join(out, 'runtime-native.node'));
    return built === `${sourceDigest} ${digest(addon)}\n`;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/** Prepare the checkout's runtime assets before invoking source tests or development hosts. */
export async function prepareDevelopmentRuntime(repository: string) {
  if (process.platform === 'win32') initializeDesktopBuildEnvironment();
  const executable = await prepareNodeBuildInputs(repository);
  const agent = join(repository, 'packages/agent');
  const out = join(agent, 'dist');
  mkdirSync(out, { recursive: true });
  prepareDevelopmentBrowserAssets(agent);
  const work = mkdtempSync(join(repository, '.cache/kite-development-node-'));
  try {
    const distribution = extractNodeDistribution(
      repository,
      cachedNodeDistribution(repository),
      work,
    );
    const sqlite = extractReviewedSqlite(repository, work);
    const env = {
      ...process.env,
      KITE_RELEASE_NODE_HEADERS: distribution.headers,
      KITE_RELEASE_SQLITE_HEADERS: sqlite,
      ...(distribution.library ? { KITE_RELEASE_NODE_LIBRARY: distribution.library } : {}),
    };
    const sourceDigest = nativeRuntimeSourceDigest(repository);
    if (!preparedAddonMatches(out, sourceDigest)) {
      const flags = process.versions.bun
        ? ['--no-config', '--no-env-file', '--no-install']
        : ['--import', join(repository, 'scripts/tooling/register.mjs')];
      const addon = spawnProcessSync(
        [process.execPath, ...flags, join(agent, 'scripts/build-node-runtime.ts'), out],
        {
          env,
          stdout: 'inherit',
          stderr: 'inherit',
        },
      );
      if (addon.exitCode !== 0) throw Error('development_runtime_addon_build_failed');
      const built = readFileSync(join(out, 'runtime-native.node'));
      if (nativeRuntimeSourceDigest(repository) !== sourceDigest)
        throw Error('development_runtime_addon_source_changed');
      writeFileSync(
        join(out, 'runtime-native-development.sha256'),
        `${sourceDigest} ${digest(built)}\n`,
      );
    }
    const library = sqliteLibraryBasename(process.platform);
    const source = compileSqlite(sqlite, join(work, library));
    const loader = join(repository, 'scripts/development/node-loader.mjs');
    const adapter = pathToFileURL(join(agent, 'src/runtime-sqlite.ts')).href;
    const script = `
      import { Database } from ${JSON.stringify(adapter)};
      if (!Database.setCustomSQLite(process.argv[1])) throw Error('development_sqlite_selection_failed');
      const db = new Database(':memory:');
      try { process.stdout.write(JSON.stringify(db.query('SELECT sqlite_version() AS version, sqlite_source_id() AS sourceId').get())); }
      finally { db.close(true); }
    `;
    const probe = spawnProcessSync(
      [
        executable,
        '--no-global-search-paths',
        '--import',
        loader,
        '--input-type=module',
        '--eval',
        script,
        realpathSync.native(source),
      ],
      {
        stdout: 'pipe',
        stderr: 'inherit',
      },
    );
    if (probe.exitCode !== 0) throw Error('development_sqlite_probe_failed');
    const identity = parseSqliteReleaseIdentity({
      driver: 'node-api:sqlite',
      linkage: 'dynamic',
      ...JSON.parse(probe.stdout.toString()),
    });
    const bytes = readFileSync(source);
    const manifest =
      JSON.stringify({
        version: 1,
        driver: identity.driver,
        target: { platform: process.platform, arch: process.arch },
        library,
        size: bytes.length,
        sha256: digest(bytes),
        sqlite: { version: identity.version, sourceId: identity.sourceId },
      }) + '\n';
    const engine = join(out, 'storage/engine');
    mkdirSync(engine, { recursive: true });
    copyFileSync(source, join(engine, library));
    writeFileSync(join(engine, 'engine-manifest.json'), manifest);
    writeFileSync(
      join(engine, 'engine-selection.json'),
      JSON.stringify({
        version: 1,
        manifestSha256: digest(manifest),
      }) + '\n',
    );
    return executable;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const root = resolve(import.meta.dirname, '../..');
  const agent = join(root, 'packages/agent');
  const out = join(agent, 'dist');
  const selection = join(agent, 'dist/storage/engine/engine-selection.json');
  if (
    process.argv.includes('--if-missing') &&
    existsSync(selection) &&
    preparedAddonMatches(out, nativeRuntimeSourceDigest(root))
  )
    prepareDevelopmentBrowserAssets(agent);
  else console.log(await prepareDevelopmentRuntime(root));
}
