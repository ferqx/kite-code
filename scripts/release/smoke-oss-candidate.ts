import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRuntimeHostMcpStdioProcessPort, parseMcpStdioJsonLine } from '@kite-ai/runtime-host';
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

let smokeFailure: unknown;
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
        'service-companion',
        'mcp-stdio-authenticated-wrapper',
        'upgrade',
        'rollback',
        'uninstall',
      ],
    }),
  );
} catch (error) {
  smokeFailure = error;
} finally {
  try {
    if (existsSync(smokeRoot)) {
      // Windows can retain a just-exited native executable briefly. Keep the
      // cleanup bounded, but do not let that transient lock hide the actual
      // smoke failure that caused this path to run.
      rmSync(smokeRoot, {
        recursive: true,
        force: true,
        maxRetries: process.platform === 'win32' ? 50 : 0,
        retryDelay: 100,
      });
    }
  } catch (cleanupError) {
    smokeFailure = smokeFailure
      ? new AggregateError([smokeFailure, cleanupError], 'Release smoke and cleanup both failed')
      : cleanupError;
  }
}
if (smokeFailure) throw smokeFailure;

async function runInstalledSmokes(prefix: string, windows: boolean): Promise<void> {
  const suffix = windows ? '.exe' : '';
  const cli = join(prefix, 'bin', `kite${suffix}`);
  const tui = join(prefix, 'bin', `kite-tui${suffix}`);
  const service = join(prefix, 'bin', `kite-service${suffix}`);
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
  await runInstalledMcpStdioWrapperSmoke(service);
  await runInstalledTuiStartupSmoke(tui);
}

async function runInstalledMcpStdioWrapperSmoke(executablePath: string): Promise<void> {
  const port = createRuntimeHostMcpStdioProcessPort({
    wrapperExecutablePath: executablePath,
  });
  const handle = await port.spawn({
    command: process.execPath,
    args: [resolve('tests/fixtures/mcp-governance-server.ts')],
    cwd: resolve('.'),
  });
  const stderrDiagnostic = collectBoundedStreamDiagnostic(handle.stderr);
  const reader = handle.stdout.getReader();
  let failure: unknown;
  try {
    await handle.ready;
    await handle.write(
      new TextEncoder().encode(
        `${JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-11-25',
            capabilities: {},
            clientInfo: { name: 'release-smoke', version: '1' },
          },
        })}\n`,
      ),
    );
    const response = await reader.read();
    if (response.done || !response.value) {
      throw new Error('Installed MCP stdio wrapper closed before initialize response.');
    }
    const line = new TextDecoder().decode(response.value).split('\n', 1)[0];
    const decoded = parseMcpStdioJsonLine(line) as { id?: unknown };
    if (decoded.id !== 1) throw new Error('Installed MCP stdio wrapper response identity drifted.');
  } catch (error) {
    failure = error;
  }
  reader.releaseLock();
  await handle.closeInput().catch(() => undefined);
  try {
    await handle.terminal;
  } catch (error) {
    failure ??= error;
  }
  try {
    const cleanup = await handle.cleanup();
    if (!cleanup.confirmedExited || !cleanup.terminalReceived || cleanup.unconfirmedProcessCount) {
      failure ??= new Error('Installed MCP stdio wrapper cleanup was not confirmed.');
    }
  } catch (error) {
    failure ??= error;
  }
  const stderr = await stderrDiagnostic.catch(() => 'diagnostic_unavailable');
  if (failure) {
    const wrapperExitCode = await handle.exited.catch(() => null);
    const exitDiagnostic = `wrapper_exit=${wrapperExitCode ?? 'unknown'}`;
    if (!stderr) {
      throw new Error(`Installed MCP stdio wrapper failed (${exitDiagnostic}).`, {
        cause: failure,
      });
    }
    throw new Error(`Installed MCP stdio wrapper failed (${exitDiagnostic}): ${stderr}`, {
      cause: failure,
    });
  }
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

async function collectBoundedStreamDiagnostic(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let diagnostic = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (diagnostic.length < 240) {
        diagnostic += decoder.decode(value, { stream: true }).slice(0, 240 - diagnostic.length);
      }
    }
    if (diagnostic.length < 240) diagnostic += decoder.decode().slice(0, 240 - diagnostic.length);
  } finally {
    reader.releaseLock();
  }
  return diagnostic.replace(/[^\x20-\x7e\r\n\t]/g, '?');
}
