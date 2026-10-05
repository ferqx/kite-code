import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseSqliteReleaseIdentity,
  type SqliteReleaseIdentity,
} from '@kite-ai/service/sqlite-release-assets';

/** Measure the copied Electron, independently of the shell's Node and the paired Bun. */
export async function probeNativeSqliteEngine(input: {
  executable: string;
  root: string;
  electronVersion: string;
}): Promise<SqliteReleaseIdentity & { driver: 'node:sqlite'; linkage: 'builtin' }> {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'kite-native-sqlite-probe-')));
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const child = Bun.spawn(
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
    let forced = false;
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
      throw Error('native_sqlite_probe_failed');
    const actual = JSON.parse(stdout);
    if (actual.electron !== input.electronVersion) throw Error('native_sqlite_runtime_mismatch');
    const identity = parseSqliteReleaseIdentity({
      driver: 'node:sqlite',
      linkage: 'builtin',
      ...actual.sqlite,
    });
    return Object.freeze({ ...identity, driver: 'node:sqlite', linkage: 'builtin' });
  } finally {
    if (timeout) clearTimeout(timeout);
    rmSync(scratch, { recursive: true, force: true });
  }
}
