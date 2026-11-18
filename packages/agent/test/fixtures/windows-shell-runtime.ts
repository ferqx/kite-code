import { join, resolve } from 'node:path';
import { captureWindowsGitBashRuntime, stageWindowsGitBash } from '../../src/jobs/windows-git-bash';

/** Isolated native-test profile. Tests never create OS accounts implicitly. */
export async function windowsShellFixture() {
  const stateRoot = resolve(
    import.meta.dir,
    '../../../../.cache/windows-shell-tests/git-bash-runtime',
  );
  const built = resolve(import.meta.dir, '../../dist/platform/process/windows-shell');
  const staged = await stageWindowsGitBash(stateRoot, join(built, 'ktipc.dll'));
  const { git, fullGit } = await captureWindowsGitBashRuntime(staged.shell, staged.fullShell);
  return {
    built,
    runner: join(built, 'kite-windows-runner.exe'),
    ...staged,
    git,
    fullGit,
  };
}
