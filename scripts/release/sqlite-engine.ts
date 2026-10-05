import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
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
import type { SqliteEngineManifest } from '@kite-ai/agent/sqlite-engine';
import type { TerminalBundleManifest } from '@kite-ai/service/runtime-assets';
import {
  parseSqliteReleaseIdentity,
  type SqliteReleaseIdentity,
  terminalSqliteEngineRoot,
} from '@kite-ai/service/sqlite-release-assets';

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
async function probe(executable: string, args: string[], cwd: string) {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'kite-sqlite-release-probe-')));
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let forced = false;
  try {
    const child = Bun.spawn([executable, ...args], {
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

const memoryProbe = `
const {Database}=require('bun:sqlite');
if(process.argv.length>1 && !Database.setCustomSQLite(process.argv[1]))throw Error('sqlite_release_load_failed');
const db=new Database(':memory:');
try{process.stdout.write(JSON.stringify(db.query('SELECT sqlite_version() AS version, sqlite_source_id() AS sourceId').get())+'\\n');}
finally{db.close(true);}
`;

/** Build input is a trusted host dependency. The installed runtime never searches Homebrew/system libraries. */
export async function buildTerminalSqliteEngine(input: {
  root: string;
  executable: string;
  library?: string;
}): Promise<TerminalBundleManifest['sqlite']> {
  const engineRoot = join(input.root, terminalSqliteEngineRoot);
  mkdirSync(engineRoot, { recursive: true, mode: 0o700 });
  let manifest: SqliteEngineManifest;
  let identity: SqliteReleaseIdentity;
  if (process.platform === 'darwin') {
    const selected =
      input.library ??
      [
        '/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib',
        '/usr/local/opt/sqlite/lib/libsqlite3.dylib',
      ].find((path) => existsSync(path));
    if (!selected) throw Error('sqlite_release_library_required');
    const source = realpathSync(selected),
      stat = lstatSync(source);
    if (!stat.isFile() || stat.size < 1 || stat.size > 64 * 1024 * 1024)
      throw Error('sqlite_release_library_invalid');
    const dependencyLines = (await probe('/usr/bin/otool', ['-L', source], input.root)).split('\n');
    // The first dependency is the dylib's own install name. Additional libraries must be OS assets.
    if (
      dependencyLines.slice(2).some((line) => {
        const name = line.trim().split(/\s+/)[0];
        return name && !name.startsWith('/usr/lib/') && !name.startsWith('/System/Library/');
      })
    )
      throw Error('sqlite_release_library_dependency_unsupported');
    const library = join(engineRoot, 'libsqlite3.dylib');
    copyFileSync(source, library);
    chmodSync(library, 0o644);
    const bytes = readFileSync(library);
    if (sha(bytes) !== sha(readFileSync(source))) throw Error('sqlite_release_library_changed');
    const actual = JSON.parse(
      await probe(input.executable, ['-e', memoryProbe, '--', library], input.root),
    );
    identity = parseSqliteReleaseIdentity({ driver: 'bun:sqlite', linkage: 'dynamic', ...actual });
    manifest = {
      version: 1,
      driver: 'bun:sqlite',
      target: { platform: process.platform, arch: process.arch },
      library: 'libsqlite3.dylib',
      size: bytes.length,
      sha256: sha(bytes),
      sqlite: { version: identity.version, sourceId: identity.sourceId },
    };
  } else {
    if (input.library) throw Error('sqlite_release_library_platform_unsupported');
    const actual = JSON.parse(await probe(input.executable, ['-e', memoryProbe], input.root));
    identity = parseSqliteReleaseIdentity({ driver: 'bun:sqlite', linkage: 'builtin', ...actual });
    manifest = {
      version: 1,
      driver: 'bun:sqlite',
      target: { platform: process.platform, arch: process.arch },
      linkage: 'builtin',
      sqlite: { version: identity.version, sourceId: identity.sourceId },
    };
  }
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
        '-e',
        "import {initializeDefaultSqliteEngine} from '@kite-ai/agent/sqlite-engine'; process.stdout.write(JSON.stringify(initializeDefaultSqliteEngine())+'\\n');",
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
  return Object.freeze({ ...identity, driver: 'bun:sqlite', manifestSha256 });
}
