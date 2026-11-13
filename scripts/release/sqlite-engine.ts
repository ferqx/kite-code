import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { SqliteEngineManifest } from '@kite-ai/agent/sqlite-engine';
import type { TerminalBundleManifest } from '@kite-ai/service/runtime-assets';
import {
  desktopSqliteEngineRoot,
  parseSqliteReleaseIdentity,
  type SqliteReleaseIdentity,
  terminalSqliteEngineRoot,
} from '@kite-ai/service/sqlite-release-assets';
import { spawn as spawnProcess } from '../tooling/process';
import { sqliteLibraryBasename } from './compile-sqlite';
import type { MacosTerminalSigning } from './macos-dmg/terminal-signing';

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
async function probe(executable: string, args: string[], cwd: string) {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'kite-sqlite-release-probe-')));
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let forced = false;
  try {
    const child = spawnProcess([executable, ...args], {
      cwd,
      env: {
        HOME: scratch,
        TMPDIR: scratch,
        PATH: process.env.PATH ?? '',
        LANG: 'en_US.UTF-8',
      },
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    timeout = setTimeout(() => {
      forced = true;
      child.kill('SIGKILL');
    }, 15_000);
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    if (forced || code !== 0 || stdout.length > 16_384 || stderr.length > 65_536)
      throw Error('sqlite_release_probe_failed');
    return stdout.trim();
  } finally {
    if (timeout) clearTimeout(timeout);
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** The installed runtime uses the selected, measured library in its own artifact. */
export async function buildTerminalSqliteEngine(input: {
  root: string;
  executable: string;
  library: string;
  desktopOnly?: true;
  macosSigning?: MacosTerminalSigning;
}): Promise<TerminalBundleManifest['sqlite']> {
  const engineRoot = join(
    input.root,
    input.desktopOnly ? desktopSqliteEngineRoot : terminalSqliteEngineRoot,
  );
  mkdirSync(engineRoot, { recursive: true, mode: 0o700 });
  const driver = 'node-api:sqlite';
  const source = realpathSync.native(input.library);
  const stat = lstatSync(source);
  if (!stat.isFile() || stat.size < 1 || stat.size > 64 * 1024 * 1024)
    throw Error('sqlite_release_library_invalid');
  if (process.platform === 'darwin') {
    const dependencyLines = (await probe('/usr/bin/otool', ['-L', source], input.root)).split('\n');
    // The first dependency is the dylib's own install name. Additional libraries must be OS assets.
    if (
      dependencyLines.slice(2).some((line) => {
        const name = line.trim().split(/\s+/)[0];
        return name && !name.startsWith('/usr/lib/') && !name.startsWith('/System/Library/');
      })
    )
      throw Error('sqlite_release_library_dependency_unsupported');
  }
  const name = sqliteLibraryBasename(process.platform);
  const library = join(engineRoot, name);
  copyFileSync(source, library);
  chmodSync(library, 0o644);
  if (sha(readFileSync(library)) !== sha(readFileSync(source)))
    throw Error('sqlite_release_library_changed');
  input.macosSigning?.sign(library, 'code');
  const engineBytes = readFileSync(library);
  const selectedProbe = `
    import { Database } from ${JSON.stringify(
      input.desktopOnly
        ? pathToFileURL(join(input.root, 'code/@kite-ai/agent/runtime-sqlite.js')).href
        : '@kite-ai/agent/runtime-sqlite',
    )};
    if (!Database.setCustomSQLite(process.argv[1])) throw Error('sqlite_release_load_failed');
    const db = new Database(':memory:');
    try { process.stdout.write(JSON.stringify(db.query('SELECT sqlite_version() AS version, sqlite_source_id() AS sourceId').get())); }
    finally { db.close(true); }
  `;
  const actual = JSON.parse(
    await probe(
      input.executable,
      ['--input-type=module', '--eval', selectedProbe, '--', library],
      input.root,
    ),
  );
  const identity: SqliteReleaseIdentity = parseSqliteReleaseIdentity({
    driver,
    linkage: 'dynamic',
    ...actual,
  });
  const manifest: SqliteEngineManifest = {
    version: 1,
    driver,
    target: { platform: process.platform, arch: process.arch },
    library: name,
    size: engineBytes.length,
    sha256: sha(engineBytes),
    sqlite: { version: identity.version, sourceId: identity.sourceId },
  };
  const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`),
    manifestSha256 = sha(bytes);
  writeFileSync(join(engineRoot, 'engine-manifest.json'), bytes, { mode: 0o644, flag: 'wx' });
  writeFileSync(
    join(engineRoot, 'engine-selection.json'),
    `${JSON.stringify({ version: 1, manifestSha256 })}\n`,
    { mode: 0o644, flag: 'wx' },
  );
  const initialized = JSON.parse(
    await probe(
      input.executable,
      [
        '--input-type=module',
        '-e',
        `import {initializeDefaultSqliteEngine} from ${JSON.stringify(
          input.desktopOnly
            ? pathToFileURL(join(input.root, 'code/@kite-ai/agent/sqlite-engine.js')).href
            : '@kite-ai/agent/sqlite-engine',
        )}; process.stdout.write(JSON.stringify(initializeDefaultSqliteEngine())+'\\n');`,
      ],
      input.root,
    ),
  );
  if (
    initialized.qualification !== 'selected' ||
    initialized.linkage !== identity.linkage ||
    initialized.version !== identity.version ||
    initialized.sourceId !== identity.sourceId ||
    initialized.selection?.manifestSha256 !== manifestSha256 ||
    initialized.selection?.root !== engineRoot
  )
    throw Error('sqlite_release_initializer_mismatch');
  return Object.freeze({ ...identity, driver, manifestSha256 });
}
