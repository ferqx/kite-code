import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanupTuiSystemFixtures } from '../../tests/tui-system/harness/fixture-lifecycle';
import { createMockModelServer } from '../../tests/tui-system/harness/fixtures';
import { spawnReadyTui } from '../../tests/tui-system/harness/pty-process';
import { createTestWorkspace } from '../../tests/tui-system/harness/test-workspace';
import {
  installOssCandidate,
  readInstallStatus,
  rollbackOssCandidate,
  uninstallOssCandidate,
} from './install-oss-candidate';
import {
  createSmokeVariantCandidate,
  currentOssReleaseTarget,
  defaultOssCandidateArchivePath,
  verifyOssCandidate,
} from './oss-candidate';

const archiveIndex = process.argv.indexOf('--archive');
const archivePath =
  archiveIndex >= 0
    ? process.argv[archiveIndex + 1]
    : defaultOssCandidateArchivePath(currentOssReleaseTarget());
if (!archivePath) throw new Error('--archive requires a path.');

const verified = await verifyOssCandidate(archivePath, currentOssReleaseTarget().id);
const smokeRoot = mkdtempSync(join(tmpdir(), 'kite-code-release-smoke-'));
const prefix = join(smokeRoot, 'install');
const variantPath = join(smokeRoot, 'variant.tar.gz');

try {
  await installOssCandidate({ archivePath: verified.archivePath, prefix });
  await runInstalledSmokes(prefix, verified.manifest.target.os === 'win32');
  const variant = await createSmokeVariantCandidate(verified, variantPath);
  await installOssCandidate({ archivePath: variant.archivePath, prefix });
  const afterSecondInstall = readInstallStatus(prefix);
  if (
    afterSecondInstall.currentCandidateId !== variant.candidateId ||
    afterSecondInstall.previousCandidateId !== verified.candidateId
  ) {
    throw new Error('Second install did not preserve the previous candidate.');
  }
  const rolledBack = rollbackOssCandidate(prefix);
  if (rolledBack.currentCandidateId !== verified.candidateId) {
    throw new Error('Rollback did not restore the original candidate.');
  }
  await runInstalledSmokes(prefix, verified.manifest.target.os === 'win32');
  uninstallOssCandidate(prefix);
  if (existsSync(prefix)) throw new Error('Uninstall left the managed install root behind.');
  console.log(
    JSON.stringify({
      status: 'passed',
      target: verified.manifest.target.id,
      candidateId: verified.candidateId,
      checks: [
        'verify',
        'install',
        'cli-help-version',
        'tui-version-pty-startup',
        'upgrade',
        'rollback',
        'uninstall',
      ],
    }),
  );
} finally {
  if (existsSync(smokeRoot)) rmSync(smokeRoot, { recursive: true, force: true });
}

async function runInstalledSmokes(prefix: string, windows: boolean): Promise<void> {
  const suffix = windows ? '.exe' : '';
  const cli = join(prefix, 'bin', `kite${suffix}`);
  const tui = join(prefix, 'bin', `kite-tui${suffix}`);
  const help = Bun.spawnSync([cli, '--help'], { stdout: 'pipe', stderr: 'pipe' });
  if (help.exitCode !== 0 || !help.stdout.toString().includes('Usage:')) {
    throw installedSmokeError('CLI help', help);
  }
  const cliVersion = Bun.spawnSync([cli, '--version'], { stdout: 'pipe', stderr: 'pipe' });
  if (cliVersion.exitCode !== 0 || !cliVersion.stdout.toString().startsWith('Kite Code ')) {
    throw installedSmokeError('CLI version', cliVersion);
  }
  const tuiVersion = Bun.spawnSync([tui, '--version'], { stdout: 'pipe', stderr: 'pipe' });
  if (tuiVersion.exitCode !== 0 || !tuiVersion.stdout.toString().startsWith('Kite Code TUI ')) {
    throw installedSmokeError('TUI version', tuiVersion);
  }
  await runInstalledTuiStartupSmoke(tui);
}

async function runInstalledTuiStartupSmoke(executablePath: string): Promise<void> {
  const server = createMockModelServer();
  // This is a standalone startup smoke, not Windows managed-network
  // onboarding coverage. Keep its fixture independent from any local account
  // setup that a packaged native runner now makes discoverable.
  const workspace = createTestWorkspace({ configOverrides: { sandbox: { enabled: false } } });
  workspace.env.CI = 'true';
  server.setResponses([]);
  let tui: Awaited<ReturnType<typeof spawnReadyTui>> | undefined;
  try {
    tui = await spawnReadyTui({
      cols: 120,
      rows: 40,
      executablePath,
      mockServer: server,
      workspace,
    });
    if (!tui.viewport().includes('Kite Code')) {
      throw new Error('Installed TUI startup did not render Kite Code branding.');
    }
  } finally {
    await cleanupTuiSystemFixtures({
      tuis: [tui],
      mockServers: [server],
      workspaces: [workspace],
    });
  }
}

function installedSmokeError(
  check: string,
  result: { exitCode: number; stdout: Uint8Array; stderr: Uint8Array },
): Error {
  return new Error(
    `${check} smoke failed: ${JSON.stringify({
      exitCode: result.exitCode,
      stdout: boundedStartupDiagnostic(result.stdout),
      stderr: boundedStartupDiagnostic(result.stderr),
    })}`,
  );
}

function boundedStartupDiagnostic(value: Uint8Array): string {
  return new TextDecoder()
    .decode(value)
    .slice(0, 240)
    .replace(/[^\x20-\x7e\r\n\t]/g, '?');
}
