import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { selectProfile } from '@kite-ai/agent/profile';
import { launchPairedService } from '@kite-ai/service/paired';
import { type CLIServiceArtifact, parseCLIServiceArtifact } from '../../../apps/cli/host';
import { runTUIProcess } from '../../../apps/cli/host/tui-main';
import { waitForTuiProfileAccess } from '../../../apps/cli/host/tui-startup-wait';
import { buildOwnedDaemon } from '../../../apps/cli/test/fixtures/daemon-host-build';
export type SpecialFixture =
  | 'cancel-successor'
  | 'presentation-race'
  | 'deferred-sandbox'
  | 'unavailable-sandbox'
  | 'four-subagents'
  | 'mcp-management'
  | 'mcp-project'
  | 'mcp-auth';
export async function runSpecialFixture(mode: SpecialFixture) {
  const argv = process.argv.slice(2);
  const argument = (name: string) => {
    const index = argv.indexOf(name);
    return index < 0 ? undefined : argv[index + 1];
  };
  const dataRoot = argument('--data-root');
  if (!dataRoot) throw Error('special_fixture_data_root_missing');
  const workspace = argument('--workspace') ?? process.cwd();
  const profile = selectProfile({ dataRoot, profile: 'development' });
  let controlledMcpUrl: string | undefined;
  let controlledMcpTool: string | undefined;
  let projectMarker: string | undefined;
  const manifest = join(profile.profilePath, 'mcp.json');
  if (mode === 'mcp-auth' && existsSync(manifest)) {
    const document = JSON.parse(readFileSync(manifest, 'utf8'));
    const entry = document.mcpServers?.recoverable;
    if (entry?.trust !== undefined || entry?.tools !== undefined) {
      const expected = {
        echo: {
          effects: { filesystem: 'none', network: 'none', externalState: 'read' },
          minimumApproval: 'none',
          retry: 'never',
        },
      };
      // These exact legacy declarations belong to this controlled server, never production source policy.
      if (entry.trust !== 'trusted' || JSON.stringify(entry.tools) !== JSON.stringify(expected))
        throw Error('fixture_mcp_policy_unmapped');
      const url = new URL(entry.url);
      if (
        entry.type !== 'http' ||
        url.protocol !== 'http:' ||
        url.hostname !== '127.0.0.1' ||
        !url.port ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        url.pathname !== '/mcp'
      )
        throw Error('fixture_mcp_endpoint_unowned');
      controlledMcpUrl = url.href;
      controlledMcpTool = 'echo';
      delete entry.trust;
      delete entry.tools;
      writeFileSync(manifest, JSON.stringify(document, null, 2), { mode: 0o600 });
    }
  }
  if (mode === 'mcp-management' && existsSync(manifest)) {
    const document = JSON.parse(readFileSync(manifest, 'utf8'));
    const definitions = { closed: 'remote echo', docs: 'search documentation / latest' };
    for (const [name, toolName] of Object.entries(definitions)) {
      const entry = document.mcpServers?.[name];
      if (!entry) continue;
      const expected = {
        [toolName]: {
          effects: { filesystem: 'none', network: 'read', externalState: 'read' },
          minimumApproval: 'none',
          retry: 'never',
        },
      };
      if (JSON.stringify(entry.tools) !== JSON.stringify(expected) || entry.trust !== undefined)
        throw Error('fixture_mcp_policy_unmapped');
      const url = new URL(entry.url);
      if (
        entry.type !== 'http' ||
        url.protocol !== 'http:' ||
        url.hostname !== '127.0.0.1' ||
        !url.port ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        url.pathname !== '/mcp'
      )
        throw Error('fixture_mcp_endpoint_unowned');
      controlledMcpUrl = url.href;
      controlledMcpTool = toolName;
      delete entry.tools;
    }
    writeFileSync(manifest, JSON.stringify(document, null, 2), { mode: 0o600 });
  }
  if (mode === 'mcp-project') {
    const path = join(workspace, '.kite-code', 'mcp.json');
    const document = JSON.parse(readFileSync(path, 'utf8'));
    const entry = document.mcpServers?.project_stdio;
    if (
      entry?.trust !== 'trusted' ||
      JSON.stringify(entry.tools) !==
        JSON.stringify({ authenticated_echo: { minimumApproval: 'none', retry: 'safe_read' } })
    )
      throw Error('fixture_project_policy_unmapped');
    delete entry.trust;
    delete entry.tools;
    if (entry.env?.MCP_AUTH_TOKEN !== 'valid' || entry.env?.MCP_EXPECTED_TOKEN !== 'valid')
      throw Error('fixture_project_credentials_unmapped');
    // Raw secret environment declarations are retired; source approval never starts this auth program.
    delete entry.env.MCP_AUTH_TOKEN;
    delete entry.env.MCP_EXPECTED_TOKEN;
    writeFileSync(path, JSON.stringify(document, null, 2), { mode: 0o600 });
    projectMarker = process.env.MCP_STARTUP_MARKER;
    if (
      !projectMarker ||
      basename(projectMarker) !== 'project-mcp-started' ||
      realpathSync(dirname(projectMarker)) !== realpathSync(workspace)
    )
      throw Error('fixture_project_marker_unowned');
  }
  const artifactRoot = join(resolve(dataRoot, '..'), `special-service-artifact-${randomUUID()}`);
  try {
    await buildOwnedDaemon(artifactRoot);
    const executable = realpathSync(process.execPath);
    const baseEntry = join(artifactRoot, 'node_modules/@kite-ai/service/main.js');
    const sha = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
    const base = {
      entrypoint: baseEntry,
      entrypointSha256: sha(baseEntry),
      executable,
      executableSha256: sha(executable),
      apiMajor: 1 as const,
    };
    const entry = join(import.meta.dir, 'new-service-special.ts');
    const digest = createHash('sha256')
      .update(readFileSync(entry))
      .update(base.entrypointSha256)
      .update(mode)
      .update(controlledMcpUrl ?? '')
      .update(controlledMcpTool ?? '')
      .update(projectMarker ?? '')
      .digest('hex');
    const outdir = join(artifactRoot, 'fixture');
    mkdirSync(outdir, { recursive: true });
    const build = await Bun.build({
      entrypoints: [entry],
      outdir,
      target: 'bun',
      packages: 'external',
      naming: 'main.js',
      define: {
        'process.env.KITE_TUI_FIXTURE_BASE_SERVICE': JSON.stringify(base.entrypoint),
        'process.env.KITE_TUI_FIXTURE_BASE_SHA': JSON.stringify(base.entrypointSha256),
        'process.env.KITE_TUI_SPECIAL_FIXTURE': JSON.stringify(mode),
        'process.env.KITE_TUI_CONTROLLED_MCP_URL': JSON.stringify(controlledMcpUrl ?? ''),
        'process.env.KITE_TUI_CONTROLLED_MCP_TOOL': JSON.stringify(controlledMcpTool ?? ''),
        'process.env.KITE_TUI_PROJECT_MCP_MARKER': JSON.stringify(projectMarker ?? ''),
      },
    });
    if (!build.success)
      throw new AggregateError(build.logs, 'special_fixture_service_build_failed');
    const entrypoint = join(outdir, 'main.js');
    const artifact: CLIServiceArtifact = parseCLIServiceArtifact({
      ...base,
      entrypoint,
      entrypointSha256: createHash('sha256').update(readFileSync(entrypoint)).digest('hex'),
      buildId: `tui-system-${digest}`,
    });
    if (process.env.KITE_TUI_SYSTEM_PRETRUST === '1') {
      const access = await waitForTuiProfileAccess(profile, {
        onWait: () =>
          process.stdout.write('会话数据正在维护，正在自动重试；超时后请按提示重试。\n'),
      });
      let prepared: Awaited<ReturnType<typeof launchPairedService>> | undefined;
      try {
        prepared = await launchPairedService({
          profile,
          entrypoint: artifact.entrypoint,
          executable: artifact.executable,
          buildId: artifact.buildId,
          instanceId: randomUUID(),
          apiMajor: 1,
          requiredCapabilities: ['sessions', 'permission_controls'],
        });
        const storeId = prepared.bootstrap.storeId!;
        const rootUri = pathToFileURL(realpathSync(workspace)).href;
        let selected = (await prepared.client.listAllWorkspaces()).find(
          (value) => value.rootUri === rootUri,
        );
        selected ??= await prepared.client.createWorkspace({
          expectedStoreId: storeId,
          id: randomUUID(),
          name: 'Original TUI test workspace',
          rootUri,
        });
        const trust = await prepared.client.getWorkspaceTrust(selected.id, { storeId });
        if (!trust.trusted)
          await prepared.client.setWorkspaceTrust(selected.id, {
            expectedStoreId: storeId,
            commandId: randomUUID(),
            trusted: true,
            canonicalIdentity: trust.canonicalIdentity,
            externalReadScopeDigest: trust.externalReadScopeDigest,
            ifRevision: trust.revision,
          });
        const mode = process.env.KITE_TUI_SYSTEM_PERMISSION_MODE ?? 'accept_edits';
        if (mode === 'accept_edits' || mode === 'auto' || mode === 'full') {
          const setup = await prepared.client.createSession({
            expectedStoreId: storeId,
            commandId: randomUUID(),
            sessionId: randomUUID(),
            workspaceId: selected.id,
            title: 'Test configuration setup',
          });
          try {
            const permission = await prepared.client.getPermissionMode(setup.id, { storeId });
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
        try {
          await prepared?.close();
        } finally {
          access.lock.release();
        }
      }
    }
    process.exitCode = await runTUIProcess({ argv, artifact, dataRoot, profile: 'development' });
  } finally {
    rmSync(artifactRoot, { recursive: true, force: true });
  }
}
