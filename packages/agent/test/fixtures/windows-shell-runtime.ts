import { join, resolve } from 'node:path';
import { stageWindowsGitBash } from '../../src/jobs/windows-git-bash';

/** Isolated native-test profile. Tests never create OS accounts implicitly. */
export async function windowsShellFixture() {
  const stateRoot = resolve(
    import.meta.dir,
    '../../../../.cache/windows-shell-tests/git-bash-runtime',
  );
  const built = resolve(import.meta.dir, '../../dist/platform/process/windows-shell');
  return {
    built,
    runner: join(built, 'kite-windows-runner.exe'),
    ...(await stageWindowsGitBash(stateRoot, join(built, 'ktipc.dll'))),
  };
}
