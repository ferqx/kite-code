import { realpathSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  which as findFixtureExecutable,
  spawn as spawnFixtureProcess,
} from '../../scripts/tooling/process';
import { testNodeCommand } from '../../scripts/tooling/test-command';

/** Build children use the installed toolchain; runtime children keep their isolated HOME. */
export function hostBuildEnvironment(): NodeJS.ProcessEnv {
  const cargo = findFixtureExecutable('cargo');
  const standardRustupHome =
    cargo &&
    basename(dirname(cargo)) === 'bin' &&
    basename(dirname(dirname(cargo))) === '.cargo' &&
    /^rustup(?:\.exe)?$/.test(basename(realpathSync(cargo)))
      ? dirname(dirname(dirname(cargo)))
      : undefined;
  return {
    ...process.env,
    ...(standardRustupHome
      ? {
          CARGO_HOME: process.env.CARGO_HOME ?? join(standardRustupHome, '.cargo'),
          RUSTUP_HOME: process.env.RUSTUP_HOME ?? join(standardRustupHome, '.rustup'),
        }
      : {}),
  };
}

/** Run the real native build in a child without changing the test process environment. */
export async function buildNativeFilesFixture(outdir: string): Promise<void> {
  const child = spawnFixtureProcess(
    testNodeCommand(
      fileURLToPath(new URL('../../packages/agent/scripts/build-native-files.ts', import.meta.url)),
      [outdir],
    ),
    { env: hostBuildEnvironment(), stdout: 'pipe', stderr: 'pipe' },
  );
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    if (code !== 0) throw Error(`native_files_fixture_build_failed:${code}\n${stdout}\n${stderr}`);
  } finally {
    if (child.exitCode === null) {
      child.kill('SIGKILL');
      await child.exited;
    }
  }
}
