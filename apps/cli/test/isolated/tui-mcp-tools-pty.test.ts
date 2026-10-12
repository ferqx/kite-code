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
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { selectProfile } from '@kite-ai/agent/profile';
import {
  createClient,
  decodeMcpToolsSnapshots,
  requiresInteractionAttachment,
} from '@kite-ai/client';
import { launchPairedService } from '@kite-ai/service/paired';
import type { CLIServiceArtifact } from '../../host';
import { verifyTerminalBundle } from '../../host/terminal-artifact';

const repo = resolve(import.meta.dir, '../../../..');
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
async function until<T>(
  label: string,
  work: () => Promise<T | undefined>,
  signal?: AbortSignal,
): Promise<T> {
  const deadline = performance.now() + 10000;
  for (;;) {
    signal?.throwIfAborted();
    const value = await work();
    signal?.throwIfAborted();
    if (value !== undefined) return value;
    if (performance.now() >= deadline) throw Error(`owned_tools_deadline:${label}`);
    await Bun.sleep(10);
  }
}
type HttpRow = {
  phase: string;
  pid: number;
  method: string;
  path: string;
  body?: { kind?: string };
};

test('80x24 TUI reads later complete MCP Tool schemas in warm and cold original generations without restoring authority', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-tui-mcp-tools-')));
  const evidence = join(tmpdir(), `kite-tui-mcp-tools-evidence-${randomUUID()}`);
  mkdirSync(evidence, { mode: 0o700 });
  const workspace = join(root, 'workspace');
  mkdirSync(workspace, { mode: 0o700 });
  const profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'development' });
  let phase: 'warm' | 'cold' = 'warm',
    remoteVersion = 1;
  const rpc: { phase: string; version: number; method: string }[] = [];
  const facts: unknown[] = [];
  let modelCalls = 0,
    success = false,
    cleanupConfirmed = false;
  let driver: Bun.Subprocess<'ignore', 'pipe', 'pipe'> | undefined;
  let build: Bun.Subprocess<'ignore', 'pipe', 'pipe'> | undefined;
  let observer: ReturnType<typeof createClient> | undefined;
  let seed: Awaited<ReturnType<typeof launchPairedService>> | undefined;
  let control: ReturnType<typeof Bun.serve> | undefined;
  let artifact: CLIServiceArtifact | undefined;
  let storeId = '',
    subjectId: string | undefined,
    failure: unknown,
    cleanupError: unknown;
  const businessAbort = new AbortController(),
    controlWork = new Set<Promise<Response>>();
  const ledger = (name: string): unknown[] =>
    existsSync(join(root, name))
      ? readFileSync(join(root, name), 'utf8')
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line))
      : [];
  const http = () => ledger('ui-http.jsonl') as HttpRow[];
  const model = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch() {
      modelCalls++;
      return new Response('owned_model_forbidden', { status: 500 });
    },
  });
  const peer = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      if (request.method !== 'POST') return new Response(null, { status: 405 });
      const row = (await request.json()) as { id?: number | string; method: string };
      rpc.push({ phase, version: remoteVersion, method: row.method });
      if (row.id === undefined) return new Response(null, { status: 202 });
      const tools = Array.from({ length: 40 }, (_, index) => ({
        name: index === 32 ? `tool-33-${'完整😀'.repeat(60)}` : `tool-${index + 1}`,
        description: `Original Tool description generation ${remoteVersion}`,
        inputSchema: {
          type: 'object',
          properties: {
            payload: {
              type: 'string',
              description:
                index === 32
                  ? `${'x'.repeat(64000)}${'α😀终'.repeat(50000)}${'x'.repeat(200000)}INPUT_SCHEMA_TAIL_V${remoteVersion}_终点😀`
                  : 'finite',
            },
          },
        },
        outputSchema: { type: 'object', properties: { confirmed: { type: 'boolean' } } },
        annotations: { readOnlyHint: false, destructiveHint: true },
        title: `FULL_METADATA_TAIL_V${remoteVersion}_终点😀`,
        _meta: { original: `metadata-${remoteVersion}` },
      }));
      const result =
        row.method === 'initialize'
          ? {
              protocolVersion: '2024-11-05',
              serverInfo: { name: 'owned-tools', version: '1' },
              capabilities: { tools: {} },
            }
          : row.method === 'tools/list'
            ? { tools }
            : undefined;
      if (result === undefined) {
        facts.push({ unexpectedRpc: row.method });
        return Response.json({
          jsonrpc: '2.0',
          id: row.id,
          error: { code: -32601, message: 'owned_unexpected_rpc' },
        });
      }
      return Response.json({ jsonrpc: '2.0', id: row.id, result });
    },
  });
  try {
    build = Bun.spawn(
      [
        process.execPath,
        join(repo, 'scripts/release/terminal.ts'),
        'build',
        '--directory',
        join(root, 'candidate'),
      ],
      { stdout: 'pipe', stderr: 'pipe' },
    );
    const [out, err, code] = await Promise.all([
      new Response(build.stdout).text(),
      new Response(build.stderr).text(),
      build.exited,
    ]);
    writeFileSync(join(evidence, 'build.log'), out + err);
    expect(code).toBe(0);
    const candidate = verifyTerminalBundle(join(root, 'candidate'));
    writeFileSync(
      join(evidence, 'candidate.json'),
      JSON.stringify(
        {
          digest: candidate.digest,
          candidateId: candidate.candidateId,
          buildId: candidate.buildId,
          manifest: candidate.manifest,
        },
        null,
        2,
      ),
    );
    symlinkSync(
      join(candidate.root, 'node_modules'),
      join(root, 'node_modules'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const bundled = await Bun.build({
      entrypoints: [join(import.meta.dir, '../fixtures/tui-mcp-tools.ts')],
      outdir: root,
      naming: 'host.js',
      target: 'bun',
      packages: 'external',
    });
    expect(bundled.success).toBe(true);
    artifact = {
      executable: candidate.artifact.executable,
      executableSha256: candidate.artifact.executableSha256,
      entrypoint: join(root, 'host.js'),
      entrypointSha256: sha(readFileSync(join(root, 'host.js'))),
      buildId: 'owned-tools',
      apiMajor: 1,
    };
    writeFileSync(join(evidence, 'host.js'), readFileSync(artifact.entrypoint));
    const settings = () =>
      writeFileSync(
        join(root, 'settings.json'),
        JSON.stringify({
          root,
          workspace,
          dataRoot: profile.dataRoot,
          mcpUrl: `${peer.url.href}mcp`,
          artifact,
          phase,
        }),
        { mode: 0o600 },
      );
    settings();
    mkdirSync(profile.profilePath, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(profile.profilePath, 'mcp.json'),
      JSON.stringify({
        mcpServers: { owned: { type: 'http', url: `${peer.url.href}mcp`, auth: { type: 'none' } } },
      }),
      { mode: 0o600 },
    );
    seed = await launchPairedService({
      ...artifact,
      profile,
      instanceId: randomUUID(),
      requiredCapabilities: ['sessions', 'commands', 'interactions'],
    });
    storeId = seed.bootstrap.storeId!;
    subjectId = seed.bootstrap.subjectId;
    await seed.client.createWorkspace({
      expectedStoreId: storeId,
      id: 'w',
      name: 'owned',
      rootUri: pathToFileURL(workspace).href,
    });
    await seed.client.createSession({
      expectedStoreId: storeId,
      commandId: 'create',
      sessionId: 'a',
      workspaceId: 'w',
      title: 'Owned MCP Tools',
    });
    mkdirSync(join(profile.profilePath, 'ui'), { mode: 0o700 });
    writeFileSync(join(profile.profilePath, 'ui/preferences.jsonc'), '{"language":"en-US"}', {
      mode: 0o600,
    });
    writeFileSync(
      join(profile.profilePath, 'config.jsonc'),
      JSON.stringify({
        modelId: 'forbidden',
        models: [
          {
            id: 'forbidden',
            provider: 'compatible',
            model: 'forbidden',
            baseURL: `${model.url.href}v1`,
          },
        ],
      }),
      { mode: 0o600 },
    );
    await seed.close();
    expect(await seed.exited).toBe(0);
    seed = undefined;
    async function connected() {
      businessAbort.signal.throwIfAborted();
      if (observer) return observer;
      const privateInfo = await until(
        'observer',
        async () =>
          existsSync(join(root, 'observer-private.json'))
            ? (JSON.parse(readFileSync(join(root, 'observer-private.json'), 'utf8')) as {
                endpoint: string;
                token: string;
              })
            : undefined,
        businessAbort.signal,
      );
      observer = createClient({
        endpoint: privateInfo.endpoint,
        token: privateInfo.token,
        expected: {
          profile: {
            dataRoot: profile.dataRoot,
            name: profile.profile,
            accessKey: profile.profileAccessKey,
          },
          apiMajor: 1,
          requiredCapabilities: ['sessions', 'commands', 'interactions'],
        },
      });
      await observer.connect();
      businessAbort.signal.throwIfAborted();
      expect(observer.serverInfo!.storeId).toBe(storeId);
      expect(observer.serverInfo!.subjectId).toBe(subjectId);
      return observer;
    }
    async function approve(executionId: string) {
      businessAbort.signal.throwIfAborted();
      const client = await connected();
      const card = await until(
        `approval:${executionId}`,
        async () =>
          (await client.listInteractions('a', { storeId, state: 'pending' })).interactions.find(
            (row) => row.executionId === executionId,
          ),
        businessAbort.signal,
      );
      if (requiresInteractionAttachment(card)) await client.readInteractionAttachment(card);
      businessAbort.signal.throwIfAborted();
      await client.answerInteraction('a', card.id, {
        expectedStoreId: storeId,
        commandId: `approve-${card.id}`,
        expectedRevision: card.revision,
        answer: { kind: 'approval', decision: 'approve', grant: 'approve_once' },
      });
      facts.push({ card });
    }
    async function invoke(
      commandId: string,
      actionId: string,
      input: Record<string, string | number>,
    ) {
      businessAbort.signal.throwIfAborted();
      const client = await connected();
      businessAbort.signal.throwIfAborted();
      await client.invokeExtension('a', {
        expectedStoreId: storeId,
        commandId,
        kind: 'extension.invoke',
        extensionId: 'builtin.mcp',
        actionId,
        definitionVersion: '1',
        input,
      });
      const command = await until(
        commandId,
        async () => {
          const row = await client.getCommand(commandId);
          return row.status === 'applied' ? row : undefined;
        },
        businessAbort.signal,
      );
      const executionId = (command.receipt as { executionId: string }).executionId;
      await approve(executionId);
      if (actionId === 'mcp.connect') {
        const job = await until(
          'connection-approval',
          async () =>
            (await client.listInteractions('a', { storeId, state: 'pending' })).interactions.find(
              (row) => row.definitionId === 'mcp.source.connection',
            ),
          businessAbort.signal,
        );
        expect((await client.getExecution(job.executionId)).parentExecutionId).toBe(executionId);
        await approve(job.executionId);
      }
      const execution = await until(
        'action-terminal',
        async () => {
          const row = await client.getExecution(executionId);
          return row.status === 'succeeded' ? row : undefined;
        },
        businessAbort.signal,
      );
      facts.push({ command, execution });
      return execution;
    }
    let warmBaseline = 0,
      readyExecutionId = '';
    const controlRequest = async (request: Request) => {
      try {
        businessAbort.signal.throwIfAborted();
        const path = new URL(request.url).pathname;
        if (path === '/seed') {
          const sourceResponse = await (await connected()).queryExtension(
            'a',
            'builtin.mcp.sources',
            'mcp.sources',
            {},
          );
          const sources = (sourceResponse[0]!.payload as { items: { id: string }[] }).items;
          expect(sources).toHaveLength(1);
          const serverId = sources[0]!.id;
          const original = await invoke('original-connect', 'mcp.connect', {
            serverId,
            key: 'original',
          });
          const details = (
            original.result as {
              details: {
                configDigest: string;
                generation: number;
                operationRef: { executionId: string };
              };
            }
          ).details;
          remoteVersion = 2;
          const refreshed = await invoke('original-refresh', 'mcp.catalogue.refresh', {
            serverId,
            connectionKey: 'original',
            connectionExecutionId: details.operationRef.executionId,
            configDigest: details.configDigest,
            generation: details.generation,
          });
          readyExecutionId = refreshed.id;
          warmBaseline = rpc.length;
        } else if (path === '/cold') {
          observer?.disposeNetwork();
          observer = undefined;
          phase = 'cold';
          rmSync(join(profile.profilePath, 'mcp.json'));
          settings();
          rmSync(join(root, 'observer-private.json'), { force: true });
          return Response.json({ phase, rpc: rpc.length });
        }
        const client = await connected();
        const snapshots = decodeMcpToolsSnapshots(
          await client.queryExtension('a', 'builtin.mcp', 'mcp.tools.snapshots', {}),
        );
        businessAbort.signal.throwIfAborted();
        const view = await client.getView('a');
        businessAbort.signal.throwIfAborted();
        expect(view.runs).toHaveLength(0);
        expect(snapshots.items).toHaveLength(2);
        expect(snapshots.items.every((row) => row.availability === 'available')).toBe(true);
        expect(modelCalls).toBe(0);
        expect(ledger('credentials.jsonl')).toHaveLength(0);
        if (path !== '/seed') expect(rpc.length).toBe(warmBaseline);
        facts.push({ phase, snapshots, runs: view.runs, session: view.session, rpc: rpc.length });
        return Response.json({
          indices: [1, 2].map((generation) =>
            snapshots.items.findIndex((row) => row.origin.generation === generation),
          ),
          rpc: rpc.length,
          readyExecutionId,
        });
      } catch (error) {
        if (!businessAbort.signal.aborted) facts.push({ controlFailure: String(error) });
        return Response.json({ error: String(error) }, { status: 500 });
      }
    };
    control = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(request) {
        const pending = controlRequest(request);
        controlWork.add(pending);
        void pending.then(
          () => controlWork.delete(pending),
          () => controlWork.delete(pending),
        );
        return pending;
      },
    });
    driver = Bun.spawn(
      [
        process.execPath,
        '--no-install',
        fileURLToPath(new URL('../fixtures/tui-mcp-tools-pty.ts', import.meta.url)),
        JSON.stringify({
          root,
          evidence,
          controlURL: control.url.href,
          runner: join(root, 'host.js'),
        }),
      ],
      { stdout: 'pipe', stderr: 'pipe', ...(process.platform === 'win32' ? { ipc() {} } : {}) },
    );
    const [pythonOut, pythonErr, pythonExit] = await Promise.all([
      new Response(driver.stdout).text(),
      new Response(driver.stderr).text(),
      driver.exited,
    ]);
    writeFileSync(join(evidence, 'pty.log'), pythonOut + pythonErr);
    expect(pythonExit).toBe(0);
    expect(pythonOut).toContain('ORIGINAL_TOOLS_WARM_COLD_COMPLETE');
    expect(http().every((row) => row.method === 'GET')).toBe(true);
    expect(http().some((row) => row.phase === 'cold' && row.path.includes('/artifacts/'))).toBe(
      true,
    );
    expect(rpc).toHaveLength(warmBaseline);
    expect(modelCalls).toBe(0);
    expect(
      facts.some((row) => typeof row === 'object' && row !== null && 'unexpectedRpc' in row),
    ).toBe(false);
    expect(
      (ledger('permissions.jsonl') as { kind: string }[]).filter((row) => row.kind === 'model'),
    ).toHaveLength(0);
    expect(ledger('credentials.jsonl')).toHaveLength(0);
    for (const row of ledger('owned-services.jsonl') as { servicePid: number }[])
      expect(() => process.kill(row.servicePid, 0)).toThrow();
    success = true;
  } catch (error) {
    failure = error;
  } finally {
    businessAbort.abort(Error('owned_tools_closing'));
    const errors: unknown[] = [];
    const collect = async (work: () => Promise<unknown>) => {
      try {
        await work();
      } catch (error) {
        errors.push(error);
      }
    };
    const boundedExit = async (work: Promise<unknown>, milliseconds: number, label: string) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          work,
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(Error(label)), milliseconds);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    };
    try {
      observer?.disposeNetwork();
      await collect(async () => {
        if (driver?.exitCode === null) {
          if (process.platform === 'win32') driver.send('mcp-tools-driver-stop');
          else driver.kill('SIGINT');
          await boundedExit(driver.exited, 9000, 'owned_tools_driver_exit_unconfirmed');
        }
      });
      await collect(async () => {
        if (build?.exitCode === null) {
          build.kill('SIGKILL');
          await boundedExit(build.exited, 9000, 'owned_build_exit_unconfirmed');
        }
      });
      await collect(async () => {
        if (seed) await seed.close();
      });
      await collect(async () => {
        await boundedExit(
          Promise.allSettled([...controlWork]),
          12000,
          'owned_control_work_unconfirmed',
        );
        if (controlWork.size) throw Error('owned_control_work_unconfirmed');
      });
      await collect(async () => {
        for (const row of ledger('owned-services.jsonl') as { servicePid: number }[]) {
          try {
            process.kill(row.servicePid, 0);
            throw Error('owned_service_exit_unconfirmed');
          } catch (error) {
            if ((error as { code?: string }).code !== 'ESRCH') throw error;
          }
        }
      });
      cleanupConfirmed = (driver === undefined || driver.exitCode !== null) && errors.length === 0;
    } catch (error) {
      errors.push(error);
    } finally {
      observer?.disposeNetwork();
      try {
        await control?.stop(true);
      } catch (error) {
        errors.push(error);
      }
      try {
        await peer.stop(true);
      } catch (error) {
        errors.push(error);
      }
      try {
        await model.stop(true);
      } catch (error) {
        errors.push(error);
      }
      for (const name of [
        'ui-http.jsonl',
        'owned-services.jsonl',
        'permissions.jsonl',
        'admissions.jsonl',
        'resolutions.jsonl',
        'credentials.jsonl',
      ]) {
        try {
          if (existsSync(join(root, name)))
            writeFileSync(join(evidence, name), readFileSync(join(root, name)));
        } catch (error) {
          errors.push(error);
        }
      }
      if (success && cleanupConfirmed && errors.length === 0) {
        try {
          rmSync(root, { recursive: true, force: true });
          if (existsSync(root)) errors.push(Error('owned_tools_root_unconfirmed'));
        } catch (error) {
          errors.push(error);
        }
      }
      cleanupError = errors.length
        ? new AggregateError(errors, 'owned_tools_cleanup_unconfirmed')
        : undefined;
      cleanupConfirmed = cleanupConfirmed && errors.length === 0;
      writeFileSync(
        join(evidence, 'packet.json'),
        JSON.stringify(
          {
            success,
            cleanupConfirmed,
            retainedRoot: existsSync(root) ? root : null,
            ...(failure ? { failure: String(failure) } : {}),
            ...(cleanupError ? { cleanupError: String(cleanupError) } : {}),
            storeId,
            subjectId,
            artifact,
            rpc,
            modelCalls,
            facts,
            deadlines: {
              stepMs: 10000,
              controlMs: 12000,
              exitMs: 6000,
              exitWaitMs: 3000,
              testMs: 180000,
            },
          },
          null,
          2,
        ),
      );
      console.error(
        JSON.stringify({
          evidence,
          success,
          cleanupConfirmed,
          retainedRoot: existsSync(root) ? root : null,
        }),
      );
    }
  }
  if (cleanupError) throw cleanupError;
  if (failure) throw failure;
}, 180000);
