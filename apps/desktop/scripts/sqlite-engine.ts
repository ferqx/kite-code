import { randomUUID } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { privateDirectory } from '@kite-ai/agent/windows-path-security';
import {
  parseSqliteReleaseIdentity,
  type SqliteReleaseIdentity,
} from '@kite-ai/service/sqlite-release-assets';

type ProbeChild = Bun.Subprocess<'ignore', 'pipe', 'pipe'>;
const pendingProbes = new Set<{ child: ProbeChild; scratch: string; exitConfirmed: boolean }>();
/** Measure the copied Electron, independently of the shell's Node and the paired Bun. */
export async function probeNativeSqliteEngine(
  input: {
    executable: string;
    root: string;
    electronVersion: string;
  },
  spawnChild: typeof Bun.spawn = Bun.spawn,
): Promise<SqliteReleaseIdentity & { driver: 'node:sqlite'; linkage: 'builtin' }> {
  let scratch: string;
  if (process.platform === 'win32') {
    const path = join(realpathSync(tmpdir()), `kite-native-sqlite-probe-${randomUUID()}`);
    privateDirectory(path);
    scratch = realpathSync(path);
  } else scratch = realpathSync(mkdtempSync(join(tmpdir(), 'kite-native-sqlite-probe-')));
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let owner: { child: ProbeChild; scratch: string; exitConfirmed: boolean } | undefined;
  let exited: Promise<number> | undefined;
  let failed = false,
    failure: unknown;
  let result: (SqliteReleaseIdentity & { driver: 'node:sqlite'; linkage: 'builtin' }) | undefined;
  const signalErrors: unknown[] = [];
  try {
    const child = spawnChild(
      [
        input.executable,
        '-e',
        "const {DatabaseSync}=require('node:sqlite'); const db=new DatabaseSync(':memory:');try{console.log(JSON.stringify({electron:process.versions.electron,sqlite:db.prepare('SELECT sqlite_version() AS version,sqlite_source_id() AS sourceId').get()}));}finally{db.close();}",
      ],
      {
        cwd: input.root,
        env: {
          HOME: scratch,
          TMPDIR: scratch,
          PATH: process.env.PATH ?? '',
          LANG: 'en_US.UTF-8',
          ELECTRON_RUN_AS_NODE: '1',
        },
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );
    owner = { child, scratch, exitConfirmed: false };
    pendingProbes.add(owner);
    const actualOwner = owner;
    exited = child.exited.then((code) => {
      actualOwner.exitConfirmed = true;
      return code;
    });
    let forced = false;
    const deadline = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        forced = true;
        try {
          child.kill('SIGKILL');
        } catch (error) {
          signalErrors.push(error);
        }
        reject(Error('native_sqlite_probe_failed'));
      }, 15_000);
    });
    const [code, stdout, stderr] = await Promise.race([
      Promise.all([exited, new Response(child.stdout).text(), new Response(child.stderr).text()]),
      deadline,
    ]);
    if (forced || code !== 0 || stdout.length > 16_384 || stderr.length > 65_536)
      throw Error('native_sqlite_probe_failed');
    const actual = JSON.parse(stdout);
    if (actual.electron !== input.electronVersion) throw Error('native_sqlite_runtime_mismatch');
    const identity = parseSqliteReleaseIdentity({
      driver: 'node:sqlite',
      linkage: 'builtin',
      ...actual.sqlite,
    });
    result = Object.freeze({ ...identity, driver: 'node:sqlite', linkage: 'builtin' });
  } catch (error) {
    failed = true;
    failure = error;
  }
  if (timeout) clearTimeout(timeout);
  if (owner && !owner.exitConfirmed) {
    try {
      owner.child.kill('SIGKILL');
    } catch (error) {
      signalErrors.push(error);
    }
    let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        exited!.then(
          () => {},
          () => {},
        ),
        new Promise<void>((resolve) => {
          cleanupTimer = setTimeout(resolve, 5000);
        }),
      ]);
    } finally {
      if (cleanupTimer) clearTimeout(cleanupTimer);
    }
  }
  if (owner && !owner.exitConfirmed)
    throw new AggregateError(
      [...(failed ? [failure] : []), ...signalErrors],
      'native_sqlite_probe_close_unknown',
    );
  if (owner) pendingProbes.delete(owner);
  try {
    rmSync(scratch, { recursive: true, force: true });
  } catch (cleanup) {
    throw new AggregateError(
      [...(failed ? [failure] : []), cleanup],
      'native_sqlite_probe_cleanup_failed',
    );
  }
  if (failed) throw failure;
  return result!;
}
