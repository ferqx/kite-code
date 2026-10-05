import { expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { selectProfile } from '@kite-ai/agent/profile';
import { launchPairedService } from '@kite-ai/service/paired';
import type { TuiMcpIntent } from '@kite-ai/ui/tui';
import { verifyTerminalBundle } from '../../host/terminal-artifact';
import { createTuiMcpPort } from '../../host/tui-mcp';

const repo = resolve(import.meta.dir, '../../../..');
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
async function until<T>(read: () => Promise<T | undefined>): Promise<T> {
  const deadline = performance.now() + 10000;
  for (;;) {
    const result = await read();
    if (result !== undefined) return result;
    if (performance.now() > deadline) throw Error('owned_mcp_cold_deadline');
    await Bun.sleep(20);
  }
}
test('source-free original MCP prepare and physical first GET loss survive caller SIGKILL with GET-only cold lookup; shared stays and paired drains', async () => {
  const root = realpathSync(mkdtempSync('/private/tmp/kite-mcp-cold-')),
    evidence = `/private/tmp/kite-mcp-cold-evidence-${randomUUID()}`;
  mkdirSync(evidence, { mode: 0o700 });
  const workspace = join(root, 'workspace');
  mkdirSync(workspace, { mode: 0o700 });
  const projectPath = join(workspace, 'kite-agent.jsonc');
  writeFileSync(
    projectPath,
    '// PROJECT COMMENT\n{"unknown":{"keep":true},"mcp":[{"id":"owned-server","enabled":true}]}\n',
    { mode: 0o600 },
  );
  const dataRoot = join(root, 'data'),
    profile = selectProfile({ dataRoot, profile: 'owned' });
  mkdirSync(profile.profilePath, { recursive: true, mode: 0o700 });
  const configPath = join(profile.profilePath, 'config.jsonc');
  writeFileSync(
    configPath,
    '// USER COMMENT\n{"unknown":{"keep":true},"mcp":[{"id":"owned-server","enabled":true}]}\n',
    { mode: 0o600 },
  );
  let rpc = 0,
    posts = 0,
    physicalDropped = false;
  const remote = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch() {
      rpc++;
      return new Response('forbidden', { status: 500 });
    },
  });
  let service: Awaited<ReturnType<typeof launchPairedService>> | undefined,
    child: Bun.Subprocess<'ignore', 'pipe', 'pipe'> | undefined,
    relay: ReturnType<typeof Bun.serve> | undefined;
  const receipts: Record<string, unknown>[] = [];
  try {
    const build = Bun.spawn(
      [
        process.execPath,
        join(repo, 'scripts/release/terminal.ts'),
        'build',
        '--directory',
        join(root, 'candidate'),
      ],
      { stdout: 'pipe', stderr: 'pipe' },
    );
    const [out, err, exit] = await Promise.all([
      new Response(build.stdout).text(),
      new Response(build.stderr).text(),
      build.exited,
    ]);
    writeFileSync(join(evidence, 'candidate-build.log'), out + err);
    expect(exit).toBe(0);
    const candidate = verifyTerminalBundle(join(root, 'candidate'));
    symlinkSync(join(candidate.root, 'node_modules'), join(root, 'node_modules'));
    const built = await Bun.build({
      entrypoints: [join(repo, 'apps/cli/test/fixtures/tui-mcp-cold.ts')],
      target: 'bun',
      packages: 'external',
      outdir: root,
    });
    expect(built.success).toBe(true);
    const entrypoint = join(root, 'tui-mcp-cold.js'),
      artifact = {
        executable: candidate.artifact.executable,
        executableSha256: candidate.artifact.executableSha256,
        apiMajor: 1,
        entrypoint,
        entrypointSha256: sha(readFileSync(entrypoint)),
        buildId: `owned-mcp-cold-${randomUUID()}`,
      };
    const settings: Record<string, unknown> = { root, dataRoot, mcpUrl: remote.url.href, artifact };
    const publish = () =>
      writeFileSync(join(root, 'settings.json'), JSON.stringify(settings), { mode: 0o600 });
    publish();
    service = await launchPairedService({
      profile,
      ...artifact,
      instanceId: randomUUID(),
      requiredCapabilities: ['sessions', 'commands'],
    });
    const client = service.client,
      storeId = service.bootstrap.storeId;
    if (!storeId) throw Error('store_missing');
    await client.createWorkspace({
      expectedStoreId: storeId,
      id: 'w',
      rootUri: `file://${workspace}`,
      name: 'owned',
    });
    await client.createSession({
      expectedStoreId: storeId,
      commandId: 'session',
      sessionId: 's',
      workspaceId: 'w',
      title: 'cold',
    });
    const facts = await createTuiMcpPort(client, storeId).read('s', new AbortController().signal);
    const make = (commandId: string): TuiMcpIntent => ({
      sessionId: 's',
      workspaceId: 'w',
      workspaceIdentity: facts.workspaceIdentity,
      request: {
        expectedStoreId: storeId,
        commandId,
        kind: 'extension.invoke',
        extensionId: 'builtin.mcp.management',
        actionId: 'mcp.server.select',
        definitionVersion: '1',
        input: {
          serverId: 'owned-server',
          enabled: false,
          scope: 'workspace',
          expectedReadSet: facts.readSet,
        },
      },
    });
    settings.endpoint = service.bootstrap.endpoint;
    settings.token = service.bootstrap.token;
    const spawn = (mode: string, intent: TuiMcpIntent) => {
      settings.mode = mode;
      settings.intent = intent;
      publish();
      rmSync(join(root, 'caller-stage'), { force: true });
      child = Bun.spawn([candidate.artifact.executable, entrypoint, 'caller'], {
        stdout: 'pipe',
        stderr: 'pipe',
      });
      return child;
    };
    const kill = async () => {
      child!.kill('SIGKILL');
      await child!.exited;
      expect(() => process.kill(child!.pid, 0)).toThrow();
    };
    const cold = async (intent: TuiMcpIntent) => {
      const p = spawn('lookup', intent);
      const [stdout, stderr, code] = await Promise.all([
        new Response(p.stdout).text(),
        new Response(p.stderr).text(),
        p.exited,
      ]);
      writeFileSync(join(evidence, `${intent.request.commandId}-cold-stderr.log`), stderr);
      expect(code).toBe(0);
      expect(stdout).toBe('');
      expect(stderr).toBe('');
      return JSON.parse(readFileSync(join(root, 'cold-result.json'), 'utf8'));
    };
    const preWorkspace = join(root, 'pre-workspace');
    mkdirSync(preWorkspace, { mode: 0o700 });
    await client.createWorkspace({
      expectedStoreId: storeId,
      id: 'wpre',
      rootUri: `file://${preWorkspace}`,
      name: 'pre',
    });
    await client.createSession({
      expectedStoreId: storeId,
      commandId: 'pre-session',
      sessionId: 'spre',
      workspaceId: 'wpre',
      title: 'pre',
    });
    const preFacts = await createTuiMcpPort(client, storeId).read(
      'spre',
      new AbortController().signal,
    );
    const prepared = {
      ...make('prepared-original'),
      sessionId: 'spre',
      workspaceId: 'wpre',
      workspaceIdentity: preFacts.workspaceIdentity,
    };
    prepared.request.input.expectedReadSet = preFacts.readSet;
    spawn('prepared', prepared);
    await until(async () => (existsSync(join(root, 'caller-stage')) ? true : undefined));
    await kill();
    expect((await cold(prepared)).phase).toBe('outcome_unknown');
    expect(readFileSync(configPath, 'utf8')).toContain('"enabled":true');
    receipts.push({
      stage: 'prepared_cold',
      commandId: prepared.request.commandId,
      status: 'outcome_unknown',
    });
    relay = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        const url = new URL(request.url),
          method = request.method;
        writeFileSync(
          join(root, 'relay-stage'),
          JSON.stringify({ stage: 'received', method, path: url.pathname }),
        );
        const body = method === 'GET' ? undefined : await request.arrayBuffer();
        if (method === 'POST' && url.pathname.endsWith('/commands')) posts++;
        const response = await fetch(
          new URL(url.pathname + url.search, service!.bootstrap.endpoint),
          {
            method,
            headers: {
              authorization: request.headers.get('authorization') ?? '',
              ...(request.headers.has('content-type')
                ? { 'content-type': request.headers.get('content-type')! }
                : {}),
            },
            body,
          },
        );
        writeFileSync(
          join(root, 'relay-stage'),
          JSON.stringify({
            stage: 'upstream',
            method,
            path: url.pathname,
            status: response.status,
          }),
        );
        if (method === 'GET' && url.pathname === '/v1/commands/submitted-original') {
          await response.arrayBuffer();
          physicalDropped = true;
          writeFileSync(
            join(root, 'physical-drop'),
            JSON.stringify({ method, path: url.pathname, upstreamStatus: response.status }),
          );
          void relay!.stop(true);
          return await new Promise<Response>(() => {});
        }
        return new Response(response.body, { status: response.status, headers: response.headers });
      },
    });
    settings.endpoint = relay.url.origin;
    const submitted = make('submitted-original');
    spawn('post', submitted);
    await until(async () => (existsSync(join(root, 'caller-stage')) ? true : undefined));
    expect(JSON.parse(readFileSync(join(root, 'caller-stage'), 'utf8')).phase).toBe(
      'outcome_unknown',
    );
    expect(physicalDropped).toBe(true);
    await kill();
    expect(() => process.kill(service!.pid, 0)).not.toThrow();
    await until(async () => {
      const command = await client.getCommand(submitted.request.commandId);
      if (command.status !== 'applied') return undefined;
      const id = (command.receipt as { executionId?: string }).executionId;
      if (!id) return undefined;
      const execution = await client.getExecution(id);
      return execution.status === 'succeeded' ? execution : undefined;
    });
    settings.endpoint = service.bootstrap.endpoint;
    const result = await cold(submitted);
    expect(result.phase).toBe('applied');
    expect(posts).toBe(1);
    expect(result.intent).toEqual(submitted);
    const originalView = await client.getView('s');
    expect(originalView.runs).toHaveLength(0);
    expect(originalView.executions.filter((row) => row.id === result.execution.id)).toHaveLength(1);
    expect(readFileSync(configPath, 'utf8')).toContain('// USER COMMENT');
    expect(readFileSync(configPath, 'utf8')).toContain('"keep":true');
    expect(readFileSync(configPath, 'utf8')).toContain('"enabled":true');
    expect(readFileSync(projectPath, 'utf8')).toContain('// PROJECT COMMENT');
    expect(readFileSync(projectPath, 'utf8')).toContain('"keep":true');
    expect(readFileSync(projectPath, 'utf8')).toContain('"enabled":false');
    receipts.push({
      stage: 'submitted_cold',
      storeId,
      command: result.command,
      execution: result.execution,
      posts,
      rpc,
      physicalDropped,
      sharedServicePid: service.pid,
      sharedServiceStayed: true,
    });
    await service.close();
    service = undefined;
    const paired = make('paired-prepared');
    spawn('paired', paired);
    await until(async () => (existsSync(join(root, 'caller-stage')) ? true : undefined));
    const pairedPid = Number(readFileSync(join(root, 'paired-service-pid'), 'utf8'));
    await kill();
    await until(async () => {
      try {
        process.kill(pairedPid, 0);
        return undefined;
      } catch {
        return true;
      }
    });
    receipts.push({
      stage: 'paired_owner_loss',
      pairedServicePid: pairedPid,
      drained: true,
      preparedCommand: paired.request.commandId,
    });
    expect(rpc).toBe(0);
    expect(existsSync(join(root, 'credential-io'))).toBe(false);
    expect(existsSync(join(root, 'mcp-admit'))).toBe(false);
    const ledger = readFileSync(join(root, 'caller-http.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((row) => JSON.parse(row));
    expect(ledger.filter((row) => row.method === 'POST')).toHaveLength(1);
    writeFileSync(
      join(evidence, 'receipts.json'),
      JSON.stringify(
        {
          candidateId: candidate.candidateId,
          helperSha256: artifact.entrypointSha256,
          receipts,
          ledger,
          cleanupConfirmed: true,
        },
        null,
        2,
      ),
    );
    writeFileSync(join(evidence, 'helper.js'), readFileSync(entrypoint));
    console.log(
      JSON.stringify({
        case: 'mcp_cold',
        evidence,
        storeId,
        posts,
        rpc,
        helperSha256: artifact.entrypointSha256,
      }),
    );
  } finally {
    writeFileSync(join(evidence, 'stage-receipts.json'), JSON.stringify(receipts, null, 2));
    if (existsSync(join(root, 'caller-http.jsonl')))
      writeFileSync(
        join(evidence, 'caller-http.jsonl'),
        readFileSync(join(root, 'caller-http.jsonl')),
      );
    if (child?.exitCode === null) {
      child.kill('SIGKILL');
      await child.exited;
    }
    if (child) {
      writeFileSync(
        join(evidence, 'last-caller-stderr.log'),
        await new Response(child.stderr).text(),
      );
    }
    for (const name of ['physical-drop', 'caller-stage', 'caller-startup', 'relay-stage'])
      if (existsSync(join(root, name)))
        writeFileSync(join(evidence, name), readFileSync(join(root, name)));
    const journalPath = join(profile.profilePath, 'ui/mcp-selection-intents.json');
    if (existsSync(journalPath))
      writeFileSync(join(evidence, 'journal.json'), readFileSync(journalPath), { mode: 0o600 });
    writeFileSync(join(evidence, 'config.jsonc'), readFileSync(configPath));
    writeFileSync(join(evidence, 'project.jsonc'), readFileSync(projectPath));
    await service?.close();
    await relay?.stop(true);
    await remote.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
}, 180000);
