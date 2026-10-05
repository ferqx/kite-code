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
import { createServer } from 'node:http';
import type { Socket } from 'node:net';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Json } from '@kite-ai/agent/extensions';
import { selectProfile } from '@kite-ai/agent/profile';
import type { openSqliteStore } from '@kite-ai/agent/sqlite';
import type { AgentClient } from '@kite-ai/client';
import { launchPairedService } from '@kite-ai/service/paired';
import { verifyTerminalBundle } from '../../../cli/host/terminal-artifact';

const repo = resolve(import.meta.dir, '../../../..');
const obj = (value: unknown) => value as Record<string, Json>;
const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
test('actual cold Service needs a new explicit MCP connection and independent approvals; old facts never reconnect or acquire new authority', async () => {
  const root = realpathSync(mkdtempSync('/private/tmp/kite-mcp-cold-reconnect-'));
  const evidence = `/private/tmp/kite-mcp-cold-reconnect-evidence-${randomUUID()}`;
  mkdirSync(evidence, { mode: 0o700 });
  const workspace = join(root, 'workspace');
  mkdirSync(workspace, { mode: 0o700 });
  const profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'owned' });
  mkdirSync(profile.profilePath, { recursive: true, mode: 0o700 });
  const sourcePath = join(profile.profilePath, 'mcp.json');
  const configPath = join(profile.profilePath, 'config.jsonc');
  let phase: 'warm' | 'cold' = 'warm';
  const sockets = new Set<Socket>();
  const socketAttempts: { phase: string }[] = [];
  const wire: { phase: string; method: string; params?: unknown }[] = [];
  const effects: { phase: string; params: unknown }[] = [];
  const modelBodies: { phase: string; body: Record<string, unknown> }[] = [];
  const http: { phase: string; method: string; path: string; body?: unknown }[] = [];
  const owned: Bun.Subprocess<'pipe', 'pipe', 'pipe'>[] = [];
  const pairs: Awaited<ReturnType<typeof launchPairedService>>[] = [];
  const facts: unknown[] = [];
  const modelSteps = { warm: 0, cold: 0 };
  let network: ReturnType<typeof createServer> | undefined;
  let provider: ReturnType<typeof Bun.serve> | undefined;
  const originalFetch = globalThis.fetch;
  let success = false;
  let cleanupError: unknown;
  let failure: unknown;
  let reader: Awaited<ReturnType<typeof openSqliteStore>> | undefined;
  let closing = false;
  const businessWork = new Set<Promise<unknown>>();
  function assertOpen() {
    if (closing) throw Error('cold_reconnect_fixture_closing');
  }
  function record(value: unknown) {
    assertOpen();
    facts.push(value);
  }
  async function until<T>(label: string, read: () => Promise<T | undefined>): Promise<T> {
    const deadline = performance.now() + 10000;
    for (;;) {
      assertOpen();
      const value = await read();
      assertOpen();
      if (value !== undefined) return value;
      if (performance.now() >= deadline) throw Error(`cold_reconnect_business_deadline:${label}`);
      await Bun.sleep(10);
    }
  }
  // Cleanup waits use the same 30s bound but never enter their own business-work tracker.
  async function bounded<T>(label: string, work: Promise<T>, onTimeout?: () => void): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        work,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            onTimeout?.();
            reject(Error(`cold_reconnect_stage_deadline:${label}`));
          }, 30000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  async function stage<T>(label: string, work: () => Promise<T>): Promise<T> {
    assertOpen();
    const pending = Promise.resolve().then(() => {
      assertOpen();
      return work();
    });
    businessWork.add(pending);
    void pending.then(
      () => businessWork.delete(pending),
      () => businessWork.delete(pending),
    );
    const value = await bounded(label, pending, () => {
      closing = true;
    });
    assertOpen();
    return value;
  }
  const readLog = (name: string): unknown[] =>
    existsSync(join(root, name))
      ? readFileSync(join(root, name), 'utf8')
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line))
      : [];
  try {
    network = createServer(async (request, response) => {
      if (request.method !== 'POST') {
        response.writeHead(405).end();
        return;
      }
      const parts: Buffer[] = [];
      for await (const part of request) parts.push(Buffer.from(part));
      const rpc = JSON.parse(Buffer.concat(parts).toString()) as {
        id?: number | string;
        method: string;
        params?: unknown;
      };
      // Record the real received request before routing or constructing a success result.
      wire.push({ phase, method: rpc.method, params: rpc.params });
      if (rpc.id === undefined) {
        response.writeHead(202).end();
        return;
      }
      let result: unknown;
      if (rpc.method === 'initialize')
        result = {
          protocolVersion: '2024-11-05',
          serverInfo: { name: 'owned', version: '1' },
          capabilities: { tools: {} },
        };
      else if (rpc.method === 'tools/list')
        result = {
          tools: [
            {
              name: 'effect',
              description: `actual ${phase} schema`,
              inputSchema: {
                type: 'object',
                properties: { phase: { type: 'string', enum: [phase] } },
                required: ['phase'],
                additionalProperties: false,
              },
            },
          ],
        };
      else if (rpc.method === 'tools/call') {
        expect(obj(obj(rpc.params).arguments).phase).toBe(phase);
        effects.push({ phase, params: rpc.params });
        result = { content: [{ type: 'text', text: `actual ${phase} effect ${effects.length}` }] };
      } else throw Error(`owned_unexpected_rpc:${rpc.method}`);
      response
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }));
    });
    network.on('connection', (socket) => {
      socketAttempts.push({ phase });
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
    });
    await new Promise<void>((resolve) => network!.listen(0, '127.0.0.1', resolve));
    const address = network.address();
    if (!address || typeof address === 'string') throw Error('owned_http_address_missing');
    const url = `http://127.0.0.1:${address.port}/mcp`;
    provider = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        const body = (await request.json()) as Record<string, unknown>;
        modelBodies.push({ phase, body });
        const tools = body.tools as { function: { name: string; parameters: unknown } }[];
        const remote = tools.find((tool) =>
          JSON.stringify(tool.function.parameters).includes(`"enum":["${phase}"]`),
        );
        expect(remote).toBeDefined();
        const call =
          modelSteps[phase]++ === 0 ? { name: remote!.function.name, input: { phase } } : null;
        const chunk = (delta: unknown, finish_reason: string | null) =>
          `data: ${JSON.stringify({ id: `owned-${modelBodies.length}`, object: 'chat.completion.chunk', model: 'fixed', choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
        return new Response(
          chunk(
            call
              ? {
                  tool_calls: [
                    {
                      index: 0,
                      id: `effect-${phase}`,
                      type: 'function',
                      function: { name: call.name, arguments: JSON.stringify(call.input) },
                    },
                  ],
                }
              : { content: 'original effect completed' },
            null,
          ) +
            chunk({}, call ? 'tool_calls' : 'stop') +
            'data: [DONE]\n\n',
          { headers: { 'content-type': 'text/event-stream' } },
        );
      },
    });
    writeFileSync(
      sourcePath,
      JSON.stringify({ mcpServers: { owned: { type: 'http', url, auth: { type: 'none' } } } }),
      { mode: 0o600 },
    );
    writeFileSync(
      configPath,
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
    const build = Bun.spawn(
      [
        process.execPath,
        join(repo, 'scripts/release/terminal.ts'),
        'build',
        '--directory',
        join(root, 'candidate'),
      ],
      { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
    );
    owned.push(build);
    const [out, err, exit] = await stage('build', () =>
      Promise.all([
        new Response(build.stdout).text(),
        new Response(build.stderr).text(),
        build.exited,
      ]),
    );
    writeFileSync(join(evidence, 'build.log'), out + err);
    expect(exit).toBe(0);
    assertOpen();
    const candidate = verifyTerminalBundle(join(root, 'candidate'));
    symlinkSync(join(candidate.root, 'node_modules'), join(root, 'node_modules'));
    const built = await Bun.build({
      entrypoints: [join(import.meta.dir, '../fixtures/mcp-cold-reconnect.ts')],
      outdir: root,
      naming: 'host.js',
      target: 'bun',
      packages: 'external',
    });
    expect(built.success).toBe(true);
    assertOpen();
    const hostBytes = readFileSync(join(root, 'host.js'));
    writeFileSync(join(evidence, 'host.js'), hostBytes);
    record({
      hostSha256: sha(hostBytes),
      executableSha256: candidate.artifact.executableSha256,
    });
    globalThis.fetch = Object.assign(
      async (...args: Parameters<typeof fetch>) => {
        const path = new URL(String(args[0])).pathname;
        http.push({
          phase,
          path,
          method: args[1]?.method ?? 'GET',
          ...(typeof args[1]?.body === 'string' ? { body: JSON.parse(args[1].body) } : {}),
        });
        return originalFetch(...args);
      },
      { preconnect: originalFetch.preconnect },
    );
    const launch = async () => {
      assertOpen();
      writeFileSync(join(root, 'settings.json'), JSON.stringify({ root, phase }), { mode: 0o600 });
      const pair = await launchPairedService({
        profile,
        executable: candidate.artifact.executable,
        entrypoint: join(root, 'host.js'),
        instanceId: randomUUID(),
        buildId: `cold-reconnect-${phase}`,
        apiMajor: 1,
        requiredCapabilities: [
          'commands',
          'extensions_actions',
          'extension_queries',
          'interactions',
        ],
        startupTimeoutMs: 10000,
        shutdownTimeoutMs: 10000,
        spawnChild: (argv, options) => {
          assertOpen();
          const child = Bun.spawn([...argv], {
            cwd: root,
            env: { ...options.env, HOME: root, KITE_CODE_HOME: join(root, 'owned-home') },
            stdin: 'pipe',
            stdout: 'pipe',
            stderr: 'pipe',
          });
          owned.push(child);
          return child;
        },
      });
      pairs.push(pair);
      assertOpen();
      return pair;
    };
    const warm = await stage('warm-launch', launch);
    const storeId = warm.bootstrap.storeId!;
    const subjectId = warm.bootstrap.subjectId;
    assertOpen();
    await warm.client.createWorkspace({
      expectedStoreId: storeId,
      id: 'w',
      name: 'owned',
      rootUri: pathToFileURL(workspace).href,
    });
    for (const sessionId of ['s', 'd']) {
      assertOpen();
      await warm.client.createSession({
        expectedStoreId: storeId,
        commandId: `create-${sessionId}`,
        sessionId,
        workspaceId: 'w',
        title: sessionId,
      });
    }
    const query = async (client: AgentClient, sessionId = 's') =>
      obj((await client.queryExtension(sessionId, 'builtin.mcp', 'mcp.catalogue', {}))[0]!.payload)
        .items as Record<string, Json>[];
    const sources = obj(
      (await warm.client.queryExtension('s', 'builtin.mcp.sources', 'mcp.sources', {}))[0]!.payload,
    ).items as Record<string, Json>[];
    expect(sources).toHaveLength(1);
    const serverId = String(sources[0]!.id);
    async function invoke(
      client: AgentClient,
      sessionId: string,
      commandId: string,
      actionId: string,
      input: Json,
    ) {
      assertOpen();
      await client.invokeExtension(sessionId, {
        kind: 'extension.invoke',
        expectedStoreId: storeId,
        commandId,
        extensionId: 'builtin.mcp',
        actionId,
        definitionVersion: '1',
        input,
      });
      const command = await until(commandId, async () => {
        const row = await client.getCommand(commandId);
        return row.status === 'applied' ? row : undefined;
      });
      return String(obj(command.receipt).executionId);
    }
    async function approve(client: AgentClient, sessionId: string, executionId: string) {
      const card = await until(`card:${executionId}`, async () =>
        (await client.listInteractions(sessionId, { storeId, state: 'pending' })).interactions.find(
          (row) => row.executionId === executionId,
        ),
      );
      expect(card.kind).toBe('approval');
      assertOpen();
      await client.answerInteraction(sessionId, card.id, {
        expectedStoreId: storeId,
        commandId: `approve-${card.id}`,
        expectedRevision: card.revision,
        answer: { kind: 'approval', decision: 'approve', grant: 'approve_once' },
      });
      record({ card, executionId });
      return card;
    }
    async function terminal(client: AgentClient, executionId: string) {
      return until(`execution:${executionId}`, async () => {
        const row = await client.getExecution(executionId);
        return ['succeeded', 'failed', 'cancelled', 'outcome_unknown'].includes(row.status)
          ? row
          : undefined;
      });
    }
    async function pendingJob(client: AgentClient, sessionId: string, action: string) {
      const card = await until('connection_job_card', async () =>
        (await client.listInteractions(sessionId, { storeId, state: 'pending' })).interactions.find(
          (row) => row.definitionId === 'mcp.source.connection',
        ),
      );
      const job = await client.getExecution(card.executionId);
      expect(job.parentExecutionId).toBe(action);
      return job;
    }
    async function connect(client: AgentClient, key: string) {
      const before = {
        sockets: socketAttempts.length,
        wire: wire.length,
        resolutions: readLog('resolution.jsonl').length,
      };
      const action = await invoke(client, 's', `connect-${key}`, 'mcp.connect', { serverId, key });
      await approve(client, 's', action);
      const job = await pendingJob(client, 's', action);
      expect({
        sockets: socketAttempts.length,
        wire: wire.length,
        resolutions: readLog('resolution.jsonl').length,
      }).toEqual(before);
      await approve(client, 's', job.id);
      const completed = await terminal(client, action);
      expect(completed.status).toBe('succeeded');
      const row = (await query(client)).find((row) => row.key === `connection/${serverId}/${key}`)!;
      expect(row.live).toBe(true);
      expect(obj(obj(row.record).operationRef).executionId).toBe(job.id);
      record({
        phase,
        action: completed,
        job: await client.getExecution(job.id),
        catalogue: row,
      });
      return row;
    }
    async function effect(client: AgentClient, commandId: string) {
      const before = effects.length;
      assertOpen();
      await client.startRun('s', {
        expectedStoreId: storeId,
        commandId,
        kind: 'run.start',
        content: commandId,
      });
      const run = await until(commandId, async () =>
        (await client.getView('s')).runs.find(
          (row) => row.originCommandId === commandId && !row.isActive,
        ),
      );
      expect(run.status).toBe('completed');
      expect(effects.length).toBe(before + 1);
      const view = await client.getView('s');
      const remote = view.executions.find(
        (row) => row.runId === run.id && row.definitionId?.startsWith(`mcp.${serverId}.`),
      )!;
      expect(remote.status).toBe('succeeded');
      expect(remote.originStoreId).toBe(storeId);
      record({ phase, run, remote });
      return remote;
    }
    const original = await stage('warm', async () => {
      const row = await connect(warm.client, 'original');
      const tool = await effect(warm.client, 'warm-effect');
      await warm.close();
      expect(await warm.exited).toBe(0);
      expect(() => process.kill(warm.pid, 0)).toThrow();
      return { row, tool, recordSha: sha(JSON.stringify(row.record)) };
    });
    phase = 'cold';
    const cold = await stage('cold-launch', launch);
    expect(cold.bootstrap.storeId).toBe(storeId);
    expect(cold.bootstrap.subjectId).toBe(subjectId);
    await stage('cold-history', async () => {
      const before = {
        sockets: socketAttempts.length,
        wire: wire.length,
        models: modelBodies.length,
        resolutions: readLog('resolution.jsonl').length,
        http: http.length,
      };
      const old = (await query(cold.client)).find((row) => row.key === original.row.key)!;
      expect(old).toMatchObject({ live: false, currentCatalogue: null });
      expect(sha(JSON.stringify(old.record))).toBe(original.recordSha);
      expect(await cold.client.getExecution(original.tool.id)).toEqual(original.tool);
      expect((await cold.client.getView('s')).session.workspaceId).toBe('w');
      expect((await cold.client.getCommand('warm-effect')).receipt).toMatchObject({
        runId: original.tool.runId,
      });
      expect({
        sockets: socketAttempts.length,
        wire: wire.length,
        models: modelBodies.length,
        resolutions: readLog('resolution.jsonl').length,
      }).toEqual({
        sockets: before.sockets,
        wire: before.wire,
        models: before.models,
        resolutions: before.resolutions,
      });
      expect(http.slice(before.http).every((row) => row.method === 'GET')).toBe(true);
      record({
        coldHistory: {
          before,
          after: {
            sockets: socketAttempts.length,
            wire: wire.length,
            models: modelBodies.length,
            resolutions: readLog('resolution.jsonl').length,
          },
          http: http.slice(before.http),
        },
      });
    });
    await stage('old-identities-refuse', async () => {
      const before = wire.length;
      const repeated = await invoke(cold.client, 's', 'cold-old-key', 'mcp.connect', {
        serverId,
        key: 'original',
      });
      await approve(cold.client, 's', repeated);
      const oldKey = await terminal(cold.client, repeated);
      expect(oldKey).toMatchObject({
        status: 'failed',
        result: { content: 'mcp_historical_connection_unavailable' },
      });
      const saved = obj(original.row.record);
      const refresh = await invoke(cold.client, 's', 'cold-old-refresh', 'mcp.catalogue.refresh', {
        serverId,
        connectionKey: 'original',
        connectionExecutionId: obj(saved.operationRef).executionId!,
        configDigest: saved.configDigest!,
        generation: saved.generation!,
      });
      await approve(cold.client, 's', refresh);
      const oldRefresh = await terminal(cold.client, refresh);
      expect(oldRefresh.status).toBe('failed');
      expect(wire.length).toBe(before);
      record({ oldKey, oldRefresh, wireBefore: before, wireAfter: wire.length });
    });
    await stage('cold-new-explicit', async () => {
      const replacement = await connect(cold.client, 'replacement');
      expect(obj(obj(replacement.record).operationRef).executionId).not.toBe(
        obj(obj(original.row.record).operationRef).executionId,
      );
      const tool = await effect(cold.client, 'cold-effect');
      expect(tool.definitionVersion).not.toBe(original.tool.definitionVersion);
      expect(effects).toHaveLength(2);
      const old = (await query(cold.client)).find((row) => row.key === original.row.key)!;
      expect(old).toMatchObject({ live: false, currentCatalogue: null });
      expect(sha(JSON.stringify(old.record))).toBe(original.recordSha);
    });
    await stage('source-drift', async () => {
      const action = await invoke(cold.client, 'd', 'drift-new-connection', 'mcp.connect', {
        serverId,
        key: 'drift',
      });
      await approve(cold.client, 'd', action);
      const job = await pendingJob(cold.client, 'd', action);
      const before = {
        sockets: socketAttempts.length,
        wire: wire.length,
        effects: effects.length,
        resolutions: readLog('resolution.jsonl').length,
      };
      const bytes = readFileSync(sourcePath);
      assertOpen();
      writeFileSync(sourcePath, Buffer.concat([bytes, Buffer.from('\n')]), { mode: 0o600 });
      await approve(cold.client, 'd', job.id);
      expect((await terminal(cold.client, job.id)).status).toBe('failed');
      expect((await terminal(cold.client, action)).status).toBe('failed');
      expect({
        sockets: socketAttempts.length,
        wire: wire.length,
        effects: effects.length,
        resolutions: readLog('resolution.jsonl').length,
      }).toEqual(before);
      record({
        phase,
        driftJob: await cold.client.getExecution(job.id),
        driftAction: await cold.client.getExecution(action),
        before,
        after: {
          sockets: socketAttempts.length,
          wire: wire.length,
          effects: effects.length,
          resolutions: readLog('resolution.jsonl').length,
        },
      });
    });
    expect(readLog('credential.jsonl')).toHaveLength(0);
    assertOpen();
    await cold.close();
    expect(await cold.exited).toBe(0);
    expect(() => process.kill(cold.pid, 0)).toThrow();
    const sqlite = (await import(
      join(candidate.root, 'node_modules/@kite-ai/agent/sqlite.js')
    )) as { openSqliteStore: typeof openSqliteStore };
    assertOpen();
    reader = await sqlite.openSqliteStore({ dataRoot: profile.dataRoot, profile: profile.profile });
    expect((await reader.getMetadata()).storeId).toBe(storeId);
    const originalTool = await reader.getExecution(original.tool.id);
    expect(originalTool).toMatchObject({
      originStoreId: storeId,
      runId: original.tool.runId,
      rootWorkCommandId: 'warm-effect',
      status: 'succeeded',
    });
    const executions = await reader.listExecutions('s');
    const replacementTool = executions.find(
      (row) =>
        row.rootWorkCommandId === 'cold-effect' && row.definitionId.startsWith(`mcp.${serverId}.`),
    )!;
    expect(replacementTool).toMatchObject({ originStoreId: storeId, status: 'succeeded' });
    const oldRecord = await reader.getExtensionRecord({
      sessionId: 's',
      extensionId: 'builtin.mcp',
      key: String(original.row.key),
    });
    expect(sha(JSON.stringify(oldRecord!.value))).toBe(original.recordSha);
    record({
      sqlOriginalTool: originalTool,
      sqlReplacementTool: replacementTool,
      sqlOriginalRecord: oldRecord,
    });
    await reader.close();
    reader = undefined;
    record({
      originalRecordSha: original.recordSha,
      original,
      storeId,
      subjectId,
      candidateManifestSha: candidate.digest,
      deadlines: { businessMs: 10000, stageMs: 30000, testMs: 180000 },
    });
    success = true;
  } catch (error) {
    failure = error;
  } finally {
    closing = true;
    const errors: unknown[] = [];
    let businessSettled = false;
    const collect = async (work: () => Promise<unknown>) => {
      try {
        await work();
      } catch (error) {
        errors.push(error);
      }
    };
    const closePairs = async () => {
      for (const pair of pairs) await collect(() => pair.close());
    };
    try {
      if (reader) await collect(() => reader!.close());
      await closePairs();
      for (const child of owned)
        await collect(async () => {
          if (child.exitCode === null) child.kill('SIGKILL');
          await bounded('owned-process-exit', child.exited);
        });
      // Shutdown the owned processes before waiting for in-flight business continuations.
      // This promise is not added to businessWork, so cleanup cannot wait on itself.
      const settlement = Promise.allSettled([...businessWork]);
      await collect(async () => {
        await bounded('business-settle', settlement);
        businessSettled = businessWork.size === 0;
        if (!businessSettled) throw Error('business_cleanup_unconfirmed');
      });
      if (businessSettled) {
        // A launch already in flight can have published a pair during the first close pass.
        await closePairs();
        globalThis.fetch = originalFetch;
      } else {
        // Retain the ledger if settlement is still unknown. Restore only after it is confirmed.
        void settlement.then(() => {
          if (businessWork.size === 0) globalThis.fetch = originalFetch;
        });
      }
    } catch (error) {
      errors.push(error);
    } finally {
      try {
        await collect(async () => {
          await provider?.stop(true);
        });
      } finally {
        try {
          await collect(async () => {
            for (const socket of sockets) socket.destroy();
            if (network)
              await bounded(
                'network-close',
                new Promise<void>((resolve, reject) =>
                  network!.close((error) => (error ? reject(error) : resolve())),
                ),
              );
          });
        } finally {
          cleanupError = errors.length
            ? new AggregateError(errors, 'owned_cleanup_unconfirmed')
            : undefined;
          try {
            for (const name of [
              'permission.jsonl',
              'resolution.jsonl',
              'credential.jsonl',
              'settings.json',
            ]) {
              try {
                if (existsSync(join(root, name)))
                  writeFileSync(join(evidence, name), readFileSync(join(root, name)));
              } catch (error) {
                errors.push(error);
              }
            }
          } finally {
            let credentials: unknown[] = [];
            let resolutions: unknown[] = [];
            try {
              credentials = readLog('credential.jsonl');
              resolutions = readLog('resolution.jsonl');
            } catch (error) {
              errors.push(error);
            }
            let rootRemovalAttempted = false;
            if (success && businessSettled && errors.length === 0) {
              try {
                rootRemovalAttempted = true;
                rmSync(root, { recursive: true, force: true });
                if (existsSync(root)) errors.push(Error('owned_root_removal_unconfirmed'));
              } catch (error) {
                errors.push(error);
              }
            }
            // Capture the actual outcome before publishing the final cleanup claim.
            const rootExists = existsSync(root);
            const rootRemoved = rootRemovalAttempted && !rootExists;
            cleanupError = errors.length
              ? new AggregateError(errors, 'owned_cleanup_unconfirmed')
              : undefined;
            try {
              writeFileSync(
                join(evidence, 'packet.json'),
                JSON.stringify(
                  {
                    success,
                    ...(failure === undefined ? {} : { failure: String(failure) }),
                    facts,
                    http,
                    wire,
                    effects,
                    socketAttempts,
                    modelBodies,
                    credentials,
                    resolutions,
                    owned: owned.map((child) => ({ pid: child.pid, exitCode: child.exitCode })),
                    businessSettled,
                    cleanupConfirmed: businessSettled && cleanupError === undefined,
                    ...(cleanupError === undefined
                      ? {}
                      : { cleanupError: String(cleanupError), cleanupErrors: errors.map(String) }),
                    rootRemoved,
                    rootExists,
                    retainedRoot: rootExists ? root : null,
                  },
                  null,
                  2,
                ),
              );
            } catch (error) {
              errors.push(error);
              cleanupError = new AggregateError(errors, 'evidence_or_cleanup_unconfirmed');
            } finally {
              console.error(
                JSON.stringify({
                  evidence,
                  success,
                  businessSettled,
                  cleanupConfirmed: businessSettled && cleanupError === undefined,
                  ...(failure === undefined ? {} : { failure: String(failure) }),
                  ...(cleanupError === undefined
                    ? {}
                    : { cleanupError: String(cleanupError), cleanupErrors: errors.map(String) }),
                  rootRemoved,
                  rootExists,
                  retainedRoot: rootExists ? root : null,
                }),
              );
            }
          }
        }
      }
    }
  }
  if (cleanupError !== undefined) throw cleanupError;
  if (failure !== undefined) throw failure;
}, 180000);
