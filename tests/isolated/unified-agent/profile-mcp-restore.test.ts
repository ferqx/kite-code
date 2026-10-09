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
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { acquireArtifactAccess } from '@kite-ai/agent/artifact-access';
import type { McpStdioProcessEvidence } from '@kite-ai/agent/mcp';
import { selectProfile } from '@kite-ai/agent/profile';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { initializeSqliteEngine } from '@kite-ai/agent/sqlite-engine';
import type { createClient, ExtensionCommandRequest, Json } from '@kite-ai/client';
import { launchPairedService } from '@kite-ai/service/paired';
import {
  buildTerminalBundle,
  installTerminalBundle,
  uninstallTerminalBundle,
} from '../../../scripts/release/terminal-bundle';
import { observeNativeProcess } from '../../../scripts/runtime/unified-soak-native';

const repositoryRoot = resolve(import.meta.dir, '../../..');
const files = [
  ['mcpConfiguration', 'mcp.json'],
  ['mcpApprovals', 'mcp-approvals.json'],
  ['mcpAuthBindings', 'mcp-auth-bindings.json'],
] as const;
const hash = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const credentialRef = 'credential:01234567-1234-1234-1234-012345678901';
type Client = ReturnType<typeof createClient>;
type Source = {
  id: string;
  name: string;
  admitted: boolean;
  reason?: string;
  source: { kind: string; rootIdentity: string };
  rawEntryDigest: string;
  transportDigest: string;
};
type Directory = { items: Source[]; readSet: Json; registryRevision: string };
async function until<T>(label: string, read: () => Promise<T | undefined>) {
  const end = performance.now() + 10000;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (performance.now() > end) throw Error(`mcp_restore_deadline:${label}`);
    await Bun.sleep(10);
  }
}
function questions(path: string, ids: string[]) {
  const db = new Database(path, { readonly: true });
  try {
    return ids.map((id) => db.query('SELECT * FROM interaction WHERE id=?').get(id));
  } finally {
    db.close(true);
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
async function execute(argv: string[], cwd: string, home: string) {
  const child = Bun.spawn(argv, {
    cwd,
    env: { PATH: '/usr/bin:/bin', HOME: home, LANG: 'C.UTF-8' },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const timeout = setTimeout(() => child.kill('SIGKILL'), 30000);
  try {
    const [exit, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    if (exit !== 0) throw Error(`mcp_restore_cli_failed:${exit}:${stderr.slice(-3000)}`);
    expect(stderr).toBe('');
    return JSON.parse(stdout);
  } finally {
    clearTimeout(timeout);
    if (child.exitCode === null) {
      child.kill('SIGKILL');
      await child.exited;
    }
  }
}
async function directory(client: Client): Promise<Directory> {
  return (await client.queryExtension('s', 'builtin.mcp.sources', 'mcp.sources', {}))[0]!
    .payload as unknown as Directory;
}
async function completed(client: Client, commandId: string) {
  return until(commandId, async () => {
    const command = await client.getCommand(commandId),
      executionId = (command.receipt as { executionId?: string }).executionId;
    if (!executionId) return undefined;
    const execution = await client.getExecution(executionId);
    return ['succeeded', 'failed', 'cancelled'].includes(execution.status) ? execution : undefined;
  });
}
async function decision(
  client: Client,
  storeId: string,
  name: string,
  actionId: 'mcp.source.approve' | 'mcp.credential.bind',
  commandId: string,
) {
  const catalogue = await directory(client),
    server = catalogue.items.find((item) => item.name === name)!;
  const request: ExtensionCommandRequest = {
    kind: 'extension.invoke',
    commandId,
    expectedStoreId: storeId,
    extensionId: 'builtin.mcp.sources',
    actionId,
    definitionVersion: '1',
    input: {
      serverId: server.id,
      expectedReadSet: catalogue.readSet,
      ...(actionId === 'mcp.credential.bind' ? { expiresAt: Date.now() + 3600000 } : {}),
    },
  };
  await client.invokeExtension('s', request);
  const card = await until(`${commandId}-question`, async () =>
    (await client.listInteractions('s', { storeId, state: 'pending' })).interactions.find(
      (value) => value.kind === 'question',
    ),
  );
  expect(card.originStoreId).toBe(storeId);
  expect(card.definitionId).toBe(`builtin.mcp.sources/${actionId}`);
  const answer = await client.answerInteraction(card.presentationSessionId, card.id, {
    expectedStoreId: storeId,
    commandId: `answer-${commandId}`,
    expectedRevision: card.revision,
    answer: {
      kind: 'question',
      answers: { decision: actionId === 'mcp.source.approve' ? 'approved' : 'bind' },
    },
  });
  expect(answer.originStoreId).toBe(storeId);
  const execution = await completed(client, commandId);
  expect(execution.status).toBe('succeeded');
  expect(execution.originStoreId).toBe(storeId);
  expect((await client.getCommand(commandId)).status).toBe('applied');
  return { request, card, execution };
}
async function full(client: Client, storeId: string, phase: string, workspace: string) {
  const mode = await client.getPermissionMode('s', { storeId });
  expect(
    (
      await client.setPermissionMode('s', {
        expectedStoreId: storeId,
        commandId: `${phase}-full`,
        mode: 'full',
        ifRevision: mode.revision,
        makeDefault: false,
        ifDefaultRevision: mode.defaultRevision,
      })
    ).state,
  ).toBe('applied');
  const trust = await client.getWorkspaceTrust('w', { storeId });
  expect(trust.canonicalIdentity).toBeDefined();
  expect(
    (
      await client.setWorkspaceTrust('w', {
        expectedStoreId: storeId,
        commandId: `${phase}-trust`,
        trusted: true,
        canonicalIdentity: trust.canonicalIdentity,
        externalReadScopeDigest: trust.externalReadScopeDigest,
        ifRevision: trust.revision,
      })
    ).state,
  ).toBe('applied');
  expect((await client.listWorkspaces()).find((item) => item.id === 'w')?.rootUri).toBe(
    pathToFileURL(workspace).href,
  );
}

test('installed maintenance restores raw MCP configuration into a new Store; cold default Service preserves user trust and requires current project/credential Questions', async () => {
  const root = realpathSync(mkdtempSync('/private/tmp/kite-profile-mcp-restore-'));
  const home = join(root, 'home'),
    workspace = join(root, 'workspace');
  for (const path of [home, workspace, join(workspace, '.kite-code')])
    mkdirSync(path, { mode: 0o700 });
  const profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'owned' });
  mkdirSync(profile.profilePath, { recursive: true, mode: 0o700 });
  let child: Awaited<ReturnType<typeof launchPairedService>> | undefined,
    access: ReturnType<typeof acquireArtifactAccess> | undefined,
    reader: Awaited<ReturnType<typeof openSqliteStore>> | undefined;
  let succeeded = false,
    modelCalls = 0;
  const wire: { method: string; path: string }[] = [],
    parentFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(
    async (...args: Parameters<typeof fetch>) => {
      const value = args[0],
        url = new URL(value instanceof Request ? value.url : String(value));
      wire.push({
        method: args[1]?.method ?? (value instanceof Request ? value.method : 'GET'),
        path: url.pathname,
      });
      return parentFetch(...args);
    },
    { preconnect: parentFetch.preconnect },
  );
  const provider = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch() {
      modelCalls++;
      return new Response('owned_model_forbidden', { status: 500 });
    },
  });
  try {
    const built = await buildTerminalBundle({
      destination: join(root, 'candidate'),
      repositoryRoot,
      bunExecutable: process.execPath,
    });
    const installed = installTerminalBundle({
      bundleRoot: built.root,
      prefix: join(root, 'installed'),
    });
    rmSync(built.root, { recursive: true });
    expect(existsSync(built.root)).toBe(false);
    access = acquireArtifactAccess({ root: installed.releaseRoot, mode: 'shared' });
    const runtime = join(installed.releaseRoot, built.manifest.entries.runtime),
      service = join(installed.releaseRoot, built.manifest.entries.service),
      cli = join(installed.root, 'bin/kite');
    initializeSqliteEngine({
      root: join(installed.releaseRoot, 'node_modules/@kite-ai/agent/storage/engine'),
      manifestSha256: built.manifest.sqlite.manifestSha256,
    });
    const compiled = await Bun.build({
      entrypoints: [
        join(repositoryRoot, 'apps/service/test/fixtures/mcp-source-packaged-server.ts'),
      ],
      target: 'bun',
      packages: 'external',
      outdir: join(root, 'fixture'),
      naming: 'peer.js',
    });
    expect(compiled.success).toBe(true);
    const ledger = join(root, 'owned-rpc'),
      peerPath = compiled.outputs[0]!.path,
      entry = {
        type: 'stdio',
        command: runtime,
        args: [peerPath, ledger],
        cwd: workspace,
        auth: { type: 'none' },
        unknown: 'RAW_PRIVATE_SOURCE_SENTINEL',
      };
    const sourceBytes = Buffer.from(
      '// complete original user source 原文🔐\r\n' +
        JSON.stringify(
          {
            mcpServers: {
              user: entry,
              manual: {
                type: 'http',
                url: 'https://owned.invalid/mcp',
                auth: { type: 'credential', credentialRef, profile: 'owned-manual' },
                unknown: 'PRIVATE_MANUAL_SENTINEL',
              },
            },
            unknown: { original: 'unchanged' },
          },
          null,
          2,
        ) +
        '\r\n',
    );
    writeFileSync(join(profile.profilePath, 'mcp.json'), sourceBytes, { mode: 0o600 });
    const projectPath = join(workspace, '.kite-code/mcp.json'),
      projectBytes = Buffer.from(
        '// original project remains outside Profile backup\n' +
          JSON.stringify({ mcpServers: { project: entry } }, null, 2) +
          '\n',
      );
    writeFileSync(projectPath, projectBytes, { mode: 0o600 });
    writeFileSync(
      join(profile.profilePath, 'config.jsonc'),
      JSON.stringify({
        modelId: 'fixed',
        models: [
          {
            id: 'fixed',
            provider: 'compatible',
            model: 'fixed',
            baseURL: `${provider.url.href}v1`,
          },
        ],
      }),
      { mode: 0o600 },
    );
    const instances: { pid: number; storeId: string }[] = [];
    const launch = async (phase: string) => {
      const instance = await launchPairedService({
        entrypoint: service,
        executable: runtime,
        profile,
        instanceId: phase,
        buildId: built.buildId,
        apiMajor: 1,
        requiredCapabilities: [
          'commands',
          'interactions',
          'extension_queries',
          'extensions_actions',
        ],
        spawnChild: (argv, options) =>
          Bun.spawn([...argv], {
            cwd: workspace,
            env: { ...options.env, HOME: home },
            stdin: 'pipe',
            stdout: 'pipe',
            stderr: 'pipe',
          }),
      });
      instances.push({ pid: instance.pid, storeId: instance.bootstrap.storeId! });
      return instance;
    };
    child = await launch('mcp-original-A');
    const storeA = child.bootstrap.storeId!;
    await child.client.createWorkspace({
      expectedStoreId: storeA,
      id: 'w',
      name: 'owned',
      rootUri: pathToFileURL(workspace).href,
    });
    await child.client.createSession({
      expectedStoreId: storeA,
      commandId: 'create',
      sessionId: 's',
      workspaceId: 'w',
      title: 'original MCP recovery',
    });
    await full(child.client, storeA, 'A', workspace);
    let current = await directory(child.client);
    expect(current.items.find((item) => item.name === 'user')?.admitted).toBe(true);
    expect(current.items.find((item) => item.name === 'project')?.reason).toBe(
      'mcp_project_approval_pending',
    );
    expect(current.items.find((item) => item.name === 'manual')?.reason).toBe(
      'mcp_credential_binding_required',
    );
    const oldApproval = await decision(
        child.client,
        storeA,
        'project',
        'mcp.source.approve',
        'A-project',
      ),
      oldBinding = await decision(
        child.client,
        storeA,
        'manual',
        'mcp.credential.bind',
        'A-binding',
      );
    current = await directory(child.client);
    expect(current.items.every((item) => item.admitted)).toBe(true);
    expect(existsSync(ledger)).toBe(false);
    expect(modelCalls).toBe(0);
    const originals = files.map(([, path]) => readFileSync(join(profile.profilePath, path)));
    expect(originals[0]).toEqual(sourceBytes);
    expect(originals[1]!.toString()).toContain(oldApproval.card.id);
    expect(originals[2]!.toString()).toContain(oldBinding.card.id);
    expect(originals[2]!.toString()).toContain(credentialRef);
    await child.close();
    expect(await child.exited).toBe(0);
    expect(alive(child.pid)).toBe(false);
    child = undefined;
    const scope = ['--data-root', profile.dataRoot, '--profile', profile.profile];
    const backup = (
      await execute(
        [cli, 'maintenance', 'backup', ...scope, '--destination', join(root, 'backups')],
        workspace,
        home,
      )
    ).backup;
    expect(backup.manifest.version).toBe(16);
    expect(backup.manifest.assets.desktopUi.present).toBe(false);
    expect(backup.manifest.source.storeId).toBe(storeA);
    const originalQuestions = questions(join(backup.directory, 'core.db'), [
      oldApproval.card.id,
      oldBinding.card.id,
    ]);
    for (const card of originalQuestions)
      expect(card).toMatchObject({ origin_store_id: storeA, state: 'answered' });
    for (const [index, [key, path]] of files.entries()) {
      expect(backup.manifest.assets[key]).toMatchObject({
        present: true,
        path,
        proof: { sha256: hash(originals[index]!), byteLength: String(originals[index]!.length) },
      });
      expect(readFileSync(join(backup.directory, path))).toEqual(originals[index]!);
    }
    expect(existsSync(join(backup.directory, '.kite-code'))).toBe(false);
    expect(existsSync(join(backup.directory, 'credentials'))).toBe(false);
    expect(
      (await execute([cli, 'maintenance', 'inspect', backup.directory], workspace, home)).backup
        .manifest,
    ).toEqual(backup.manifest);
    for (const [, path] of files)
      writeFileSync(join(profile.profilePath, path), `later private original ${path}`, {
        mode: 0o600,
      });
    const restored = await execute(
        [
          cli,
          'maintenance',
          'restore',
          backup.directory,
          ...scope,
          '--expected-store',
          storeA,
          '--confirm-data-loss',
        ],
        workspace,
        home,
      ),
      storeB = restored.storeId as string;
    expect(storeB).not.toBe(storeA);
    for (const [index, [, path]] of files.entries()) {
      expect(readFileSync(join(profile.profilePath, path))).toEqual(originals[index]!);
      expect(readFileSync(join(restored.preservedDirectory, path), 'utf8')).toBe(
        `later private original ${path}`,
      );
    }
    expect(readFileSync(projectPath)).toEqual(projectBytes);
    child = await launch('mcp-restored-B');
    expect(child.bootstrap.storeId).toBe(storeB);
    reader = await openSqliteStore({
      dataRoot: profile.dataRoot,
      profile: profile.profile,
      mode: 'readonly',
    });
    const before = await reader.getMetadata(),
      beforeView = await child.client.getView('s'),
      start = wire.length;
    const cold = await directory(child.client);
    expect(cold.items.find((item) => item.name === 'user')?.admitted).toBe(true);
    expect(cold.items.find((item) => item.name === 'project')?.reason).toBe(
      'mcp_project_approval_pending',
    );
    expect(cold.items.find((item) => item.name === 'manual')?.reason).toBe(
      'mcp_credential_binding_required',
    );
    for (const item of cold.items) {
      const old = current.items.find((value) => value.name === item.name)!;
      expect(item.id).toBe(old.id);
      expect(item.rawEntryDigest).toBe(old.rawEntryDigest);
      expect(item.transportDigest).toBe(old.transportDigest);
    }
    const coldJSON = JSON.stringify(cold);
    for (const privateValue of [
      credentialRef,
      peerPath,
      ledger,
      'RAW_PRIVATE_SOURCE_SENTINEL',
      'PRIVATE_MANUAL_SENTINEL',
    ])
      expect(coldJSON).not.toContain(privateValue);
    for (const old of [oldApproval, oldBinding]) {
      expect((await child.client.getCommand(old.request.commandId)).originStoreId).toBe(storeA);
      expect((await child.client.getExecution(old.execution.id)).originStoreId).toBe(storeA);
    }
    expect(
      (
        await child.client.listInteractions('s', { storeId: storeB, state: 'answered' })
      ).interactions
        .filter((card) => card.kind === 'question')
        .map((card) => card.originStoreId),
    ).toEqual([]);
    expect(questions(profile.databasePath, [oldApproval.card.id, oldBinding.card.id])).toEqual(
      originalQuestions,
    );
    expect(await child.client.getView('s')).toEqual(beforeView);
    expect(await reader.getMetadata()).toEqual(before);
    const coldReads = wire.slice(start);
    expect(coldReads.every((row) => row.method === 'GET')).toBe(true);
    expect(existsSync(ledger)).toBe(false);
    expect(modelCalls).toBe(0);
    for (const [index, [, path]] of files.entries())
      expect(readFileSync(join(profile.profilePath, path))).toEqual(originals[index]!);
    const cursor = (await reader.getMetadata()).lastChangeCursor;
    await expect(child.client.invokeExtension('s', oldApproval.request)).rejects.toMatchObject({
      code: 'store_identity_mismatch',
    });
    expect((await reader.getMetadata()).lastChangeCursor).toBe(cursor);
    await full(child.client, storeB, 'B', workspace);
    const newApproval = await decision(
        child.client,
        storeB,
        'project',
        'mcp.source.approve',
        'B-project',
      ),
      newBinding = await decision(
        child.client,
        storeB,
        'manual',
        'mcp.credential.bind',
        'B-binding',
      );
    expect(newApproval.card.id).not.toBe(oldApproval.card.id);
    expect(newBinding.card.id).not.toBe(oldBinding.card.id);
    expect((await directory(child.client)).items.every((item) => item.admitted)).toBe(true);
    for (const [key, path] of files.slice(1)) {
      const records = JSON.parse(readFileSync(join(profile.profilePath, path), 'utf8'))
        .records as Record<string, { proof: { storeId: string } }>;
      const old = JSON.parse(originals[key === 'mcpApprovals' ? 1 : 2]!.toString())
        .records as typeof records;
      for (const [recordId, original] of Object.entries(old))
        expect(records[recordId]).toEqual(original);
      expect(
        Object.values(records)
          .map((record) => record.proof.storeId)
          .sort(),
      ).toEqual([storeA, storeB].sort());
    }
    expect(existsSync(ledger)).toBe(false);
    expect(modelCalls).toBe(0);
    const user = (await directory(child.client)).items.find((item) => item.name === 'user')!;
    await child.client.invokeExtension('s', {
      kind: 'extension.invoke',
      expectedStoreId: storeB,
      commandId: 'B-connect-user',
      extensionId: 'builtin.mcp',
      actionId: 'mcp.connect',
      definitionVersion: '1',
      input: { serverId: user.id, key: 'B-explicit-connection' },
    });
    expect((await completed(child.client, 'B-connect-user')).status).toBe('succeeded');
    const connected = await completed(child.client, 'B-connect-user');
    const rpc = readFileSync(ledger, 'utf8');
    expect(rpc).toContain('initialize');
    expect(rpc).toContain('tools/list');
    expect(existsSync(`${ledger}.effects`)).toBe(false);
    const owned = JSON.parse(readFileSync(`${ledger}.pid`, 'utf8')) as {
      server: number;
      guardian: number;
    };
    const connectionRecord = (await reader.getExtensionRecord({
      sessionId: 's',
      extensionId: 'builtin.mcp',
      key: `connection/${user.id}/B-explicit-connection`,
    }))!.value as { operationRef: { executionId: string }; configDigest: string };
    const connectionId = connectionRecord.operationRef.executionId;
    const connection = await child.client.getExecution(connectionId);
    expect(connection).toMatchObject({
      originStoreId: storeB,
      sessionId: 's',
      parentExecutionId: connected.id,
      definitionId: 'mcp.source.connection',
      definitionVersion: '1',
      status: 'running',
    });
    const readyOutput = await until('owned birth persisted', async () => {
      const page = await child!.client.listExecutionOutput(connectionId);
      return page.items.some((row) => row.stream === 'progress') ? page : undefined;
    });
    const ready = JSON.parse(
      readyOutput.items.find((row) => row.stream === 'progress')!.content,
    ) as { ready: boolean; ownedProcesses: McpStdioProcessEvidence };
    expect(ready.ready).toBe(true);
    expect(ready.ownedProcesses).toMatchObject({
      version: 2,
      coverage: 'mcp-owned-coalition',
      ownerPid: child.pid,
      binding: {
        originalStoreId: storeB,
        sessionId: 's',
        executionId: connectionId,
        serverId: user.id,
        scopeId: JSON.stringify([storeB, 's', user.id]),
        configDigest: connectionRecord.configDigest,
      },
      broker: { parentPid: child.pid, exit: null, unavailable: [] },
      guardian: { pid: owned.guardian, parentPid: 1, exit: null, unavailable: [] },
      server: { pid: owned.server, parentPid: owned.guardian, exit: null, unavailable: [] },
    });
    if (ready.ownedProcesses.version !== 2) throw Error('mcp_coalition_ready_required');
    expect(ready.ownedProcesses.coalition).toMatchObject({
      claimTaskCount: 1,
      terminalTaskCount: null,
      processTreeStopped: false,
      registrationRemoved: false,
    });
    for (const identity of [
      ready.ownedProcesses.broker!,
      ready.ownedProcesses.guardian!,
      ready.ownedProcesses.server!,
    ]) {
      const native = observeNativeProcess(identity.pid);
      expect(native.unavailable).toEqual([]);
      expect(native.parentPid).toBe(identity.parentPid);
      expect(native.startIdentity?.value).toBe(
        `${identity.birth!.seconds}:${identity.birth!.microseconds}`,
      );
    }
    await child.client.cancelSession('s', {
      expectedStoreId: storeB,
      commandId: 'B-stop',
      kind: 'session.cancel',
      includeBackground: true,
    });
    await until('owned peers stopped', async () =>
      !alive(owned.server) && !alive(owned.guardian) ? true : undefined,
    );
    const stopped = await until('owned terminal persisted', async () => {
      const fact = await child!.client.getExecution(connectionId);
      return fact.status === 'cancelled' ? fact : undefined;
    });
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
    if (terminal.details.ownedProcesses.version !== 2)
      throw Error('mcp_coalition_terminal_required');
    for (const [before, after] of [
      [ready.ownedProcesses.broker!, terminal.details.ownedProcesses.broker!],
      [ready.ownedProcesses.server!, terminal.details.ownedProcesses.server!],
    ]) {
      expect(after).toMatchObject({
        pid: before!.pid,
        parentPid: before!.parentPid,
        birth: before!.birth,
        kernelState: 'absent',
        exit: { reaped: true },
      });
    }
    expect(terminal.details.ownedProcesses.broker!.exit).toEqual({
      code: 0,
      signal: null,
      reaped: true,
    });
    expect(terminal.details.ownedProcesses.guardian).toMatchObject({
      pid: ready.ownedProcesses.guardian!.pid,
      parentPid: ready.ownedProcesses.guardian!.parentPid,
      birth: ready.ownedProcesses.guardian!.birth,
      exit: null,
      kernelState: 'absent',
    });
    expect(terminal.details.ownedProcesses.coalition).toMatchObject({
      id: ready.ownedProcesses.coalition!.id,
      guardianUniqueId: ready.ownedProcesses.coalition!.guardianUniqueId,
      guardianPidVersion: ready.ownedProcesses.coalition!.guardianPidVersion,
      label: ready.ownedProcesses.coalition!.label,
      domain: ready.ownedProcesses.coalition!.domain,
      claimTaskCount: 1,
      terminalTaskCount: 1,
      processTreeStopped: true,
      registrationRemoved: true,
    });
    const stoppedOutput = await child.client.listExecutionOutput(connectionId);
    expect(stoppedOutput).toEqual(readyOutput);
    const stoppedRecord = await reader.getExecution(connectionId);
    expect(stoppedRecord!.result).toEqual(stopped.result);
    await reader.close();
    reader = undefined;
    await child.close();
    expect(await child.exited).toBe(0);
    expect(alive(child.pid)).toBe(false);
    child = undefined;
    reader = await openSqliteStore({ ...profile, mode: 'readonly' });
    const stoppedCursor = (await reader.getMetadata()).lastChangeCursor;
    expect(await reader.getExecution(connectionId)).toEqual(stoppedRecord);
    child = await launch('mcp-restored-B-cold');
    const coldStart = wire.length;
    expect(await child.client.getExecution(connectionId)).toEqual(stopped);
    expect(await child.client.listExecutionOutput(connectionId)).toEqual(stoppedOutput);
    expect((await directory(child.client)).items.every((item) => item.admitted)).toBe(true);
    expect(readFileSync(ledger, 'utf8')).toBe(rpc);
    expect(alive(owned.server)).toBe(false);
    expect(alive(owned.guardian)).toBe(false);
    expect(modelCalls).toBe(0);
    expect(wire.slice(coldStart).every((row) => row.method === 'GET')).toBe(true);
    expect((await reader.getMetadata()).lastChangeCursor).toBe(stoppedCursor);
    await reader.close();
    reader = undefined;
    await child.close();
    expect(await child.exited).toBe(0);
    expect(alive(child.pid)).toBe(false);
    child = undefined;
    access.release();
    access = undefined;
    uninstallTerminalBundle(installed.root);
    expect(readFileSync(join(profile.profilePath, 'mcp.json'))).toEqual(sourceBytes);
    console.log(
      JSON.stringify({
        stage: 'profile_mcp_restore',
        candidateDigest: built.digest,
        storeA,
        storeB,
        instances,
        assets: files.map(([key, path]) => ({
          key,
          path,
          proof: backup.manifest.assets[key].proof,
        })),
        originalQuestions: [oldApproval.card.id, oldBinding.card.id],
        currentQuestions: [newApproval.card.id, newBinding.card.id],
        coldMethods: coldReads.map((row) => row.method),
        providerCalls: modelCalls,
        originalRawBytesPreserved: true,
        projectUnchanged: true,
        vaultExcluded: true,
        credentialTransportNotDispatched: true,
        ownedPeersStopped: true,
        ownedProcessBinding: terminal.details.ownedProcesses.binding,
        ownedProcessReady: ready.ownedProcesses,
        ownedProcessTerminal: terminal.details.ownedProcesses,
        ownedProcessColdPreserved: true,
      }),
    );
    succeeded = true;
  } finally {
    await reader?.close();
    await child?.close();
    access?.release();
    globalThis.fetch = parentFetch;
    provider.stop(true);
    if (succeeded) rmSync(root, { recursive: true, force: true });
    else console.error(JSON.stringify({ stage: 'profile_mcp_restore_failure_retained', root }));
  }
}, 180000);
