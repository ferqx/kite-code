import { createHash, randomUUID } from 'node:crypto';
import { constants, copyFileSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

/** Pin compiler caches before a child receives an isolated application HOME. */
export function testToolchainEnvironment(env: NodeJS.ProcessEnv = process.env) {
  const home = homedir();
  return {
    CARGO_HOME: resolve(env.CARGO_HOME ?? join(home, '.cargo')),
    RUSTUP_HOME: resolve(env.RUSTUP_HOME ?? join(home, '.rustup')),
  };
}

/** Test entry points can use an owned runtime without changing the installed Bun or its ACL. */
export async function withTestRuntime(
  entry: string,
  args: readonly string[],
  run: () => Promise<number>,
): Promise<number> {
  if (process.platform !== 'win32') return run();
  const { retainWindowsCandidateFiles } = await import(
    '../packages/agent/src/platform/windows-candidate-files'
  );
  const { privateDirectory } = await import('../packages/agent/src/platform/windows-path-security');
  let current: ReturnType<typeof retainWindowsCandidateFiles> | undefined;
  let qualified = true;
  try {
    current = retainWindowsCandidateFiles(dirname(process.execPath), [basename(process.execPath)]);
    current.verify();
  } catch (error) {
    if (!(error instanceof Error) || error.message !== 'artifact_scope_denied') throw error;
    qualified = false;
  } finally {
    // A failed close is unknown ownership, not permission to create a new owner.
    current?.release();
  }
  if (qualified) return run();
  const parent = realpathSync.native(tmpdir());
  const root = join(parent, `kite-test-runtime-${randomUUID()}`);
  privateDirectory(root);
  const bin = join(root, 'bin');
  privateDirectory(bin);
  const runtime = join(bin, 'bun.exe');
  const digest = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
  const expected = digest(process.execPath);
  copyFileSync(process.execPath, runtime, constants.COPYFILE_EXCL);
  if (digest(runtime) !== expected || digest(process.execPath) !== expected)
    throw Error('test_runtime_copy_changed');
  const pin = retainWindowsCandidateFiles(bin, ['bun.exe']);
  let code: number;
  try {
    pin.verify();
    const child = Bun.spawn([runtime, entry, ...args], {
      env: {
        ...process.env,
        ...testToolchainEnvironment(),
        PATH: `${bin};${process.env.PATH ?? ''}`,
      },
      stdin: 'inherit',
      stdout: 'inherit',
      stderr: 'inherit',
    });
    code = await child.exited;
    pin.verify();
  } finally {
    pin.release();
  }
  if (code === 0) {
    if (resolve(root) !== root || dirname(root) !== parent || realpathSync.native(root) !== root)
      throw Error('test_runtime_cleanup_scope_changed');
    rmSync(root, { recursive: true });
  } else console.error(`[test-runtime] retained after failure: ${root}`);
  return code;
}
