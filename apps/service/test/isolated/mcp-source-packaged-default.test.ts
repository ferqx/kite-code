import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { McpStdioProcessEvidence } from '@kite-ai/agent/mcp';

async function until<T>(read: () => Promise<T>, done: (value: T) => boolean) {
  const deadline = Date.now() + 12000;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) throw new Error('packaged_source_deadline');
    await Bun.sleep(10);
  }
}
function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test('sealed default process discovers and executes owned stdio sources using persistent SDK policy, then stops without cold respawn', async () => {
  const root = realpathSync(
    mkdtempSync(
      join(process.platform === 'darwin' ? '/private/tmp' : tmpdir(), 'kite-packaged-default-mcp-'),
    ),
  );
  const workspace = join(root, 'workspace');
  const home = join(root, 'home');
  mkdirSync(workspace);
  mkdirSync(home);
  if (process.platform === 'linux' && (!Bun.which('cc') || !Bun.which('bwrap')))
    throw Error('linux_mcp_qualification_dependencies_unavailable');
  const { buildTerminalBundle } = await import('../../../../scripts/release/terminal-bundle');
  const built = await buildTerminalBundle({
    destination: join(root, 'bundle'),
    repositoryRoot: resolve(import.meta.dir, '../../../..'),
    bunExecutable: process.execPath,
  });
  const runtime = join(built.root, built.manifest.entries.runtime);
  for (const asset of [
    built.manifest.entries.service,
    built.manifest.entries.runtime,
    'node_modules/@kite-ai/agent/mcp/stdio-guardian.js',
    'node_modules/@kite-ai/agent/mcp/windows-stdio-guardian.js',
    'node_modules/@kite-ai/agent/storage/worker/main.js',
    ...(process.platform === 'linux' ? ['node_modules/@kite-ai/agent/mcp/linux-stdio-init'] : []),
  ]) {
    expect(built.manifest.files.some((file) => file.path === asset)).toBe(true);
  }
  const { selectProfile } = (await import(
    join(built.root, 'node_modules/@kite-ai/agent/profile.js')
  )) as typeof import('@kite-ai/agent/profile');
  const { launchPairedService } = (await import(
    join(built.root, 'node_modules/@kite-ai/service/paired.js')
  )) as typeof import('../../src/paired');
  const profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'owned' });
  mkdirSync(profile.profilePath, { recursive: true, mode: 0o700 });
  const fixture = await Bun.build({
    entrypoints: [join(import.meta.dir, '../fixtures/mcp-source-packaged-server.ts')],
    outdir: join(root, 'fixture'),
    naming: 'server.js',
    target: 'bun',
  });
  expect(fixture.success).toBe(true);
  const serverPath = fixture.outputs[0]!.path;
  const ledger = join(root, 'owned-rpc');
  const sourcePath = join(profile.profilePath, 'mcp.json');
  writeFileSync(
    sourcePath,
    JSON.stringify({
      mcpServers: {
        owned: {
          type: 'stdio',
          command: runtime,
          args: [serverPath, ledger],
          cwd: workspace,
          env: { PACKAGED_VISIBLE: 'PRIVATE_OWNED_ENV_SENTINEL' },
          auth: { type: 'none' },
          unknown: 'PRIVATE_RAW_SOURCE_SENTINEL',
        },
      },
    }),
  );
  let step = 0;
  let ordinary = false;
  const bodies: Record<string, unknown>[] = [];
  const provider = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as Record<string, unknown>;
      bodies.push(body);
      let call: { name: string; input: unknown } | null = null;
      const n = step++;
      if (!ordinary) {
        if (n === 0) call = { name: 'mcp.sources.list', input: {} };
        else if (n === 1) {
          const id = JSON.stringify(body.messages).match(/mcp-[a-f0-9]{64}/)?.[0];
          expect(id).toBeDefined();
          call = { name: 'mcp.connect', input: { serverId: id, key: 'packaged-owned' } };
        } else if (n === 2) {
          const tools = body.tools as { function: { name: string; parameters: unknown } }[];
          const remote = tools.find((tool) =>
            JSON.stringify(tool.function.parameters).includes('exact'),
          );
          expect(remote).toBeDefined();
          call = { name: remote!.function.name, input: { value: 'exact' } };
        }
      }
      const frame = (delta: unknown, finish_reason: string | null) =>
        `data: ${JSON.stringify({ id: `owned-${bodies.length}`, object: 'chat.completion.chunk', model: 'fixed', choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
      return new Response(
        frame(
          call
            ? {
                tool_calls: [
                  {
                    index: 0,
                    id: `call-${n}`,
                    type: 'function',
                    function: { name: call.name, arguments: JSON.stringify(call.input) },
                  },
                ],
              }
            : { content: 'PACKAGED_DEFAULT_DONE' },
          null,
        ) +
          frame({}, call ? 'tool_calls' : 'stop') +
          'data: [DONE]\n\n',
        { headers: { 'content-type': 'text/event-stream' } },
      );
    },
  });
  writeFileSync(
    join(profile.profilePath, 'config.jsonc'),
    JSON.stringify({
      modelId: 'fixed',
      models: [
        { id: 'fixed', provider: 'compatible', model: 'fixed', baseURL: `${provider.url.href}v1` },
      ],
    }),
  );
  let child: Awaited<ReturnType<typeof launchPairedService>> | undefined;
  let candidateAccess:
    | ReturnType<typeof import('@kite-ai/agent/artifact-access').acquireArtifactAccess>
    | undefined;
  let originalJobId: string | undefined;
  const launch = (id: string) =>
    launchPairedService({
      entrypoint: join(built.root, built.manifest.entries.service),
      executable: runtime,
      profile,
      instanceId: id,
      buildId: built.buildId,
      apiMajor: 1,
      requiredCapabilities: ['commands', 'extension_queries'],
      spawnChild: (argv, options) =>
        Bun.spawn([...argv], {
          cwd: workspace,
          env: {
            ...options.env,
            HOME: home,
            ...(process.platform === 'win32' ? { USERPROFILE: home } : {}),
          },
          stdin: 'pipe',
          stdout: 'pipe',
          stderr: 'pipe',
        }),
    });
  try {
    const { acquireArtifactAccess } = (await import(
      join(built.root, 'node_modules/@kite-ai/agent/artifact-access.js')
    )) as typeof import('@kite-ai/agent/artifact-access');
    candidateAccess = acquireArtifactAccess({ root: built.root, mode: 'shared' });
    child = await launch('packaged-first');
    const client = child.client;
    const expectedStoreId = child.bootstrap.storeId!;
    await client.createWorkspace({
      expectedStoreId,
      id: 'w',
      name: 'owned',
      rootUri: pathToFileURL(workspace).href,
    });
    await client.createSession({
      expectedStoreId,
      commandId: 'create',
      sessionId: 's',
      workspaceId: 'w',
      title: 'packaged default',
    });
    const mode = await client.getPermissionMode('s', { storeId: expectedStoreId });
    expect(
      (
        await client.setPermissionMode('s', {
          expectedStoreId,
          commandId: 'full',
          mode: 'full',
          ifRevision: mode.revision,
          makeDefault: false,
          ifDefaultRevision: mode.defaultRevision,
        })
      ).state,
    ).toBe('applied');
    const trust = await client.getWorkspaceTrust('w', { storeId: expectedStoreId });
    expect(
      (
        await client.setWorkspaceTrust('w', {
          expectedStoreId,
          commandId: 'trust',
          trusted: true,
          canonicalIdentity: trust.canonicalIdentity,
          externalReadScopeDigest: trust.externalReadScopeDigest,
          ifRevision: trust.revision,
        })
      ).state,
    ).toBe('applied');
    const directory = await client.queryExtension('s', 'builtin.mcp.sources', 'mcp.sources', {});
    expect(JSON.stringify(directory)).toContain('owned');
    expect(JSON.stringify(directory)).not.toContain(serverPath);
    expect(existsSync(`${ledger}.pid`)).toBe(false);
    await client.startRun('s', {
      expectedStoreId,
      commandId: 'work',
      kind: 'run.start',
      content: 'owned packaged MCP',
    });
    const view = await until(
      () => client.getView('s'),
      (view) => view.runs.some((run) => run.status === 'completed'),
    );
    expect(
      view.executions.filter(
        (execution) => execution.kind === 'model' && execution.status === 'succeeded',
      ),
    ).toHaveLength(4);
    expect(
      view.executions.some(
        (execution) =>
          execution.definitionId === 'mcp.source.connection' && execution.status === 'running',
      ),
    ).toBe(true);
    expect(readFileSync(`${ledger}.effects`, 'utf8').trim().split('\n')).toHaveLength(1);
    expect(JSON.stringify(bodies)).not.toContain('PRIVATE_RAW_SOURCE_SENTINEL');
    expect(JSON.stringify(bodies)).not.toContain(serverPath);
    expect(JSON.stringify(bodies)).not.toContain('PRIVATE_OWNED_ENV_SENTINEL');
    let owned = JSON.parse(readFileSync(`${ledger}.pid`, 'utf8')) as {
      server: number;
      guardian: number;
      visible: string;
    };
    expect(owned.visible).toBe('PRIVATE_OWNED_ENV_SENTINEL');
    const connectionId = view.executions.find(
      (execution) => execution.definitionId === 'mcp.source.connection',
    )!.id;
    const readyOutput = await client.listExecutionOutput(connectionId);
    const ready = JSON.parse(
      readyOutput.items.find((row) => row.stream === 'progress')!.content,
    ) as { ready: boolean; ownedProcesses: McpStdioProcessEvidence };
    expect(ready.ready).toBe(true);
    if (process.platform === 'linux') {
      if (ready.ownedProcesses.version !== 4)
        throw Error('packaged_linux_namespace_evidence_required');
      const processEvidence = ready.ownedProcesses.process;
      if (!processEvidence.namespace?.root) throw Error('packaged_linux_original_root_required');
      // The server's actual process.pid/ppid are namespace-local; host liveness
      // is anchored only by the port's original SCM credentials and pidfds.
      expect(owned.server).toBe(processEvidence.namespace.root.localPid);
      expect(owned.guardian).toBe(1);
      owned = {
        ...owned,
        server: processEvidence.namespace.root.pid,
        guardian: processEvidence.namespace.init.pid,
      };
      expect(ready.ownedProcesses).toMatchObject({
        version: 4,
        coverage: 'mcp-owned-pid-namespace',
        ownerPid: child.pid,
        binding: { originalStoreId: expectedStoreId, sessionId: 's', executionId: connectionId },
        process: {
          version: 1,
          coverage: 'linux-pid-namespace',
          ownerPid: child.pid,
          admission: { purpose: 'stdio' },
          phase: 'ready',
          fdClosed: false,
          closeUnknown: false,
          wrapper: {
            parentPid: child.pid,
            exit: null,
            closed: false,
            stdoutEof: false,
            stderrEof: false,
          },
          namespace: {
            init: { pid: owned.guardian, localPid: 1, dead: false },
            root: { pid: owned.server, parentPid: owned.guardian, dead: false, waitReceipt: null },
            treeStopped: false,
          },
        },
      });
      expect(processEvidence.wrapper.birth).toMatch(/^[1-9][0-9]*$/);
      expect(processEvidence.namespace.init.birth).toMatch(/^[1-9][0-9]*$/);
      expect(processEvidence.namespace.root.birth).toMatch(/^[1-9][0-9]*$/);
    }
    if (process.platform === 'win32') {
      expect(ready.ownedProcesses).toMatchObject({
        version: 3,
        coverage: 'windows-job-members',
        ownerPid: child.pid,
        binding: { originalStoreId: expectedStoreId, sessionId: 's', executionId: connectionId },
        guardian: {
          pid: owned.guardian,
          parentPid: child.pid,
          exit: null,
          kernelState: 'alive',
          observationClosed: false,
        },
        server: { pid: owned.server, exitCode: null, waitConfirmed: false },
        job: { treeStopped: false },
        closed: false,
        closeUnknown: false,
      });
    }
    await client.cancelSession('s', {
      expectedStoreId,
      commandId: 'stop',
      kind: 'session.cancel',
      includeBackground: true,
    });
    await until(
      async () => [alive(owned.server), alive(owned.guardian)],
      (states) => states.every((state) => !state),
    );
    const stopped = await until(
      () => client.getExecution(connectionId),
      (execution) => execution.status === 'cancelled',
    );
    const terminal = stopped.result as unknown as {
      details: {
        transportStopped: boolean;
        remoteToolStopConfirmed: boolean;
        ownedProcesses: McpStdioProcessEvidence;
      };
    };
    expect(terminal.details.transportStopped).toBe(true);
    expect(terminal.details.remoteToolStopConfirmed).toBe(false);
    expect(terminal.details.ownedProcesses.binding).toEqual(ready.ownedProcesses.binding);
    if (process.platform === 'win32') {
      if (ready.ownedProcesses.version !== 3 || terminal.details.ownedProcesses.version !== 3)
        throw Error('packaged_windows_job_evidence_required');
      expect(terminal.details.ownedProcesses).toMatchObject({
        guardian: {
          pid: owned.guardian,
          creationTime: ready.ownedProcesses.guardian!.creationTime,
          exit: { code: 0, signal: null, reaped: true },
          kernelState: 'dead',
          observationClosed: true,
        },
        server: {
          pid: owned.server,
          creationTime: ready.ownedProcesses.server!.creationTime,
          waitConfirmed: true,
        },
        job: { activeProcesses: 0, treeStopped: true },
        closed: true,
        closeUnknown: false,
      });
    }
    if (process.platform === 'linux') {
      if (ready.ownedProcesses.version !== 4 || terminal.details.ownedProcesses.version !== 4)
        throw Error('packaged_linux_namespace_evidence_required');
      const original = ready.ownedProcesses.process.namespace;
      if (!original?.root) throw Error('packaged_linux_original_root_required');
      expect(terminal.details.ownedProcesses).toMatchObject({
        version: 4,
        coverage: 'mcp-owned-pid-namespace',
        ownerPid: child.pid,
        process: {
          phase: 'terminal',
          fdClosed: true,
          closeUnknown: false,
          wrapper: {
            pid: ready.ownedProcesses.process.wrapper.pid,
            birth: ready.ownedProcesses.process.wrapper.birth,
            exit: { code: 0, signal: null, reaped: true },
            closed: true,
            stdoutEof: true,
            stderrEof: true,
          },
          namespace: {
            dev: original.dev,
            ino: original.ino,
            treeStopped: true,
            init: { pid: original.init.pid, birth: original.init.birth, localPid: 1, dead: true },
            root: {
              pid: original.root.pid,
              birth: original.root.birth,
              parentPid: original.init.pid,
              localPid: original.root.localPid,
              dead: true,
              waitReceipt: { localPid: original.root.localPid, waitConfirmed: true, reaped: true },
            },
          },
        },
      });
    }
    const stoppedOutput = await client.listExecutionOutput(connectionId);
    expect(stoppedOutput).toEqual(readyOutput);
    const originalCommand = await client.getCommand('work');
    await child.close();
    expect(await child.exited).toBe(0);
    expect(alive(child.pid)).toBe(false);
    // Read the actual stopped process database; the public Execution projection deliberately omits input.
    // Select the original candidate engine before this host's first Database, matching the Service.
    const { initializeSqliteEngine } = (await import(
      join(built.root, 'node_modules/@kite-ai/agent/sqlite-engine.js')
    )) as typeof import('@kite-ai/agent/sqlite-engine');
    const coldEngine = initializeSqliteEngine({
      root: join(built.root, 'node_modules/@kite-ai/agent/storage/engine'),
      manifestSha256: built.manifest.sqlite.manifestSha256,
    });
    expect(coldEngine.version).toBe(built.manifest.sqlite.version);
    expect(coldEngine.sourceId).toBe(built.manifest.sqlite.sourceId);
    const database = new Database(profile.databasePath, { readonly: true });
    try {
      const job = database
        .query("SELECT * FROM execution WHERE adapter_id = 'mcp.source.connection'")
        .get() as Record<string, unknown>;
      originalJobId = String(job.id);
      expect(job.origin_store_id).toBe(expectedStoreId);
      expect(job.session_id).toBe('s');
      expect(job.definition_version).toBe('1');
      expect(job.state).toBe('cancelled');
      const input = JSON.parse(String(job.intent_json)) as Record<string, unknown>;
      expect(input.captureDigest).toMatch(/^[a-f0-9]{64}$/);
      expect(input.configDigest).toMatch(/^[a-f0-9]{64}$/);
      expect(input.parentInputDigest).toMatch(/^[a-f0-9]{64}$/);
      expect(input.parentExecutionId).toBe(job.parent_execution_id);
      for (const privateValue of [
        serverPath,
        runtime,
        ledger,
        workspace,
        'PRIVATE_RAW_SOURCE_SENTINEL',
        'PRIVATE_OWNED_ENV_SENTINEL',
      ])
        expect(JSON.stringify(input)).not.toContain(privateValue);
      const originalRun = database
        .query("SELECT config_json FROM run WHERE origin_command_id = 'work'")
        .get() as { config_json: string };
      expect(originalRun.config_json).not.toContain(serverPath);
      expect(originalRun.config_json).not.toContain('PRIVATE_RAW_SOURCE_SENTINEL');
    } finally {
      database.close();
    }
    const stoppedRpc = readFileSync(ledger, 'utf8');
    const stoppedPidLedger = readFileSync(`${ledger}.pid`, 'utf8');
    const providerBeforeCold = bodies.length;
    child = await launch('packaged-cold');
    const coldCursor = (await child.client.getView('s')).snapshotCursor;
    expect(await child.client.getCommand('work')).toEqual(originalCommand);
    expect(await child.client.getExecution(connectionId)).toEqual(stopped);
    expect(await child.client.listExecutionOutput(connectionId)).toEqual(stoppedOutput);
    await child.client.queryExtension('s', 'builtin.mcp.sources', 'mcp.sources', {});
    await child.client.queryExtension('s', 'builtin.mcp', 'mcp.catalogue', {});
    expect((await child.client.getView('s')).snapshotCursor).toBe(coldCursor);
    expect(bodies.length).toBe(providerBeforeCold);
    expect(readFileSync(ledger, 'utf8')).toBe(stoppedRpc);
    expect(readFileSync(`${ledger}.pid`, 'utf8')).toBe(stoppedPidLedger);
    expect(readFileSync(`${ledger}.effects`, 'utf8').trim().split('\n')).toHaveLength(1);
    expect(readFileSync(ledger, 'utf8')).toBe(stoppedRpc);
    expect(readFileSync(`${ledger}.pid`, 'utf8')).toBe(stoppedPidLedger);
    expect(alive(owned.server)).toBe(false);
    writeFileSync(sourcePath, '{ invalid owned source');
    ordinary = true;
    await child.client.startRun('s', {
      expectedStoreId,
      commandId: 'ordinary',
      kind: 'run.start',
      content: 'ordinary chat with unavailable optional source',
    });
    await until(
      () => child!.client.getView('s'),
      (view) => view.runs.filter((run) => run.status === 'completed').length === 2,
    );
    expect(readFileSync(`${ledger}.effects`, 'utf8').trim().split('\n')).toHaveLength(1);
    expect(readFileSync(ledger, 'utf8')).toBe(stoppedRpc);
    expect(readFileSync(`${ledger}.pid`, 'utf8')).toBe(stoppedPidLedger);
    await child.close();
    expect(await child.exited).toBe(0);
    console.log(
      JSON.stringify({
        packagedDefaultProof: true,
        candidateDigest: built.digest,
        engineManifestSha256: coldEngine.selection.manifestSha256,
        engineVersion: coldEngine.version,
        engineSourceId: coldEngine.sourceId,
        storeId: expectedStoreId,
        commandId: 'work',
        runId: view.runs.find((run) => run.originCommandId === 'work')?.id,
        connectionExecutionId: originalJobId,
        provider: bodies.length,
        effects: 1,
        coldRpcSha256: createHash('sha256').update(stoppedRpc).digest('hex'),
        coldPidLedgerSha256: createHash('sha256').update(stoppedPidLedger).digest('hex'),
      }),
    );
  } catch (error) {
    // A closed Client can throw synchronously; diagnostics must not replace the original failure
    // or expose a View, private startup data or Model body.
    const code =
      error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
        ? error.code
        : error instanceof Error
          ? error.message
          : 'packaged_default_unknown';
    console.error('packaged_default_failure', {
      code: /^[A-Za-z0-9_]{1,128}$/.test(code) ? code : 'packaged_default_unknown',
      stack:
        error instanceof Error
          ? error.stack
              ?.split('\n')
              .filter((line) => /^\s+at /u.test(line))
              .slice(0, 8)
          : undefined,
    });
    throw error;
  } finally {
    await child?.close();
    candidateAccess?.release();
    provider.stop(true);
    rmSync(root, { recursive: true, force: true });
    console.log(JSON.stringify({ packagedDefaultCleanup: true, rootRemoved: !existsSync(root) }));
  }
}, 180000);
