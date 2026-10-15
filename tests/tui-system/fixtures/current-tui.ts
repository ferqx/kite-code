/** Original terminal journeys, composed with the current ordinary TUI and Service. */
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, realpathSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { selectProfile } from '@kite-ai/agent/profile';
import { launchPairedService } from '@kite-ai/service/paired';
import { connectSharedService } from '../../../apps/cli/host/shared-service';
import { runTUIProcess } from '../../../apps/cli/host/tui-main';
import { waitForTuiProfileAccess } from '../../../apps/cli/host/tui-startup-wait';
import { buildOwnedDaemon } from '../../../apps/cli/test/fixtures/daemon-host-build';

const args = process.argv.slice(2);
const value = (name: string) => {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
};
const dataRoot = value('--data-root');
const server = value('--server');
const workspace = value('--workspace') ?? process.cwd();
if (!dataRoot) throw Error('original_tui_fixture_data_root_missing');
const profile = selectProfile({ dataRoot, profile: 'development' });
const artifactRoot = join(resolve(dataRoot, '..'), `current-service-artifact-${randomUUID()}`);
const exit = new AbortController();
const stop = () => exit.abort();
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
async function main() {
  if (server && process.env.KITE_TUI_SYSTEM_TEMPORARY_CREDENTIALS === '1')
    throw Error('temporary_credentials_require_owned_service');
  if (!server) {
    await buildOwnedDaemon(artifactRoot);
    // Explicit test composition only: credential tests never touch the host OS vault.
    if (process.env.KITE_TUI_SYSTEM_TEMPORARY_CREDENTIALS === '1') {
      const built = await Bun.build({
        entrypoints: [join(import.meta.dir, 'temporary-credential-service.ts')],
        target: 'bun',
        packages: 'external',
        outdir: join(artifactRoot, 'node_modules/@kite-ai/service'),
        naming: 'main.js',
      });
      if (!built.success)
        throw new AggregateError(built.logs, 'temporary_credential_fixture_build_failed');
    }
  }
  exit.signal.throwIfAborted();
  const entrypoint = join(artifactRoot, 'node_modules/@kite-ai/service/main.js');
  const executable = realpathSync(process.execPath);
  const sha = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
  const artifact = server
    ? undefined
    : {
        entrypoint,
        entrypointSha256: sha(entrypoint),
        executable,
        executableSha256: sha(executable),
        apiMajor: 1,
        buildId: 'original-tui-current-service',
      };

  // This is test-owned setup through the same public contract as the client.
  // Production has no environment trust bypass. Gate journeys omit this fixture flag.
  if (process.env.KITE_TUI_SYSTEM_PRETRUST === '1') {
    const access = await waitForTuiProfileAccess(profile, {
      signal: exit.signal,
      onWait: () => process.stdout.write('会话数据正在维护，正在自动重试；超时后请按提示重试。\n'),
    });
    let prepared:
      | Awaited<ReturnType<typeof launchPairedService>>
      | Awaited<ReturnType<typeof connectSharedService>>
      | undefined;
    try {
      exit.signal.throwIfAborted();
      prepared = server
        ? await connectSharedService({
            profile,
            server,
            workspace,
            requiredCapabilities: ['sessions', 'permission_controls'],
            signal: exit.signal,
          })
        : await launchPairedService({
            profile,
            entrypoint: artifact!.entrypoint,
            executable: artifact!.executable,
            buildId: artifact!.buildId,
            instanceId: randomUUID(),
            apiMajor: 1,
            requiredCapabilities: ['sessions', 'permission_controls'],
          });
      exit.signal.throwIfAborted();
      const storeId = prepared.bootstrap.storeId!;
      const rootUri = pathToFileURL(realpathSync(workspace)).href;
      let target = (await prepared.client.listAllWorkspaces()).find((w) => w.rootUri === rootUri);
      target ??= await prepared.client.createWorkspace({
        expectedStoreId: storeId,
        id: randomUUID(),
        name: 'Original TUI test workspace',
        rootUri,
      });
      const trust = await prepared.client.getWorkspaceTrust(target.id, { storeId });
      if (!trust.trusted)
        await prepared.client.setWorkspaceTrust(target.id, {
          expectedStoreId: storeId,
          commandId: randomUUID(),
          trusted: true,
          canonicalIdentity: trust.canonicalIdentity,
          externalReadScopeDigest: trust.externalReadScopeDigest,
          ifRevision: trust.revision,
        });
      const mode = process.env.KITE_TUI_SYSTEM_PERMISSION_MODE;
      if (mode === 'accept_edits' || mode === 'auto' || mode === 'full') {
        const setup = await prepared.client.createSession({
          expectedStoreId: storeId,
          commandId: randomUUID(),
          sessionId: randomUUID(),
          workspaceId: target.id,
          title: 'Test configuration setup',
        });
        try {
          const permission = await prepared.client.getPermissionMode(setup.id, { storeId });
          // A restart must retain a user's later default selection.
          if (permission.defaultRevision === '0')
            await prepared.client.setPermissionMode(setup.id, {
              expectedStoreId: storeId,
              commandId: randomUUID(),
              mode,
              ifRevision: permission.revision,
              makeDefault: true,
              ifDefaultRevision: permission.defaultRevision,
            });
        } finally {
          const current = (await prepared.client.getView(setup.id)).session;
          await prepared.client.deleteSession(setup.id, {
            expectedStoreId: storeId,
            commandId: randomUUID(),
            ifRevision: current.controlRevision,
          });
        }
      }
    } finally {
      await prepared?.close();
      access.lock.release();
    }
  }
  exit.signal.throwIfAborted();
  return await runTUIProcess({ argv: args, artifact, dataRoot, profile: 'development' });
}
try {
  process.exitCode = await main();
} catch (error) {
  if (!exit.signal.aborted) throw error;
  process.exitCode = 0;
} finally {
  process.removeListener('SIGINT', stop);
  process.removeListener('SIGTERM', stop);
  rmSync(artifactRoot, { recursive: true, force: true });
}
