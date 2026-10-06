import { expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { acquireArtifactAccess } from '@kite-ai/agent/artifact-access';
import {
  createProfileBackup,
  inspectProfileBackup,
  restoreProfileBackup,
} from '@kite-ai/agent/maintenance';
import { selectProfile } from '@kite-ai/agent/profile';
import { getLoadedSqliteEngine, initializeSqliteEngine } from '@kite-ai/agent/sqlite-engine';
import { ClientError, createClient, requiresInteractionAttachment } from '@kite-ai/client';
import { launchPairedService } from '@kite-ai/service/paired';
import type { TuiMcpReconnectionFact } from '@kite-ai/ui/tui';
import type { CLIServiceArtifact } from '../../host';
import { parseMcpConnectionRecord } from '../../host/mcp-connection-intents';
import { parseMcpReconnectionRecord } from '../../host/mcp-reconnection-intents';
import { verifyTerminalBundle } from '../../host/terminal-artifact';
import { createTuiMcpPort } from '../../host/tui-mcp';
import { decodeMcpReconnectionFact } from '../../host/tui-mcp-reconnection';

const repo = resolve(import.meta.dir, '../../../..');
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const privateFile = (path: string, value: unknown) =>
  writeFileSync(path, JSON.stringify(value, null, 2), { mode: 0o600, flag: 'wx' });
async function until<T>(
  label: string,
  read: () => Promise<T | undefined>,
  signal: AbortSignal,
): Promise<T> {
  const end = performance.now() + 10000;
  for (;;) {
    signal.throwIfAborted();
    const value = await read();
    signal.throwIfAborted();
    if (value !== undefined) return value;
    if (performance.now() > end) throw Error(`reconnection_pty_deadline:${label}`);
    await Bun.sleep(10);
  }
}
type Wire = {
  phase: string;
  pid: number;
  method: string;
  path: string;
  body?: {
    kind?: string;
    commandId?: string;
    extensionId?: string;
    actionId?: string;
    requestSha256?: string;
    answerKind?: string;
    decision?: string;
  };
};
function installed(name: string, owner: string) {
  for (const search of createRequire(join(owner, 'package.json')).resolve.paths(
    `${name}/package.json`,
  ) ?? []) {
    const path = join(search, name, 'package.json');
    if (existsSync(path)) return JSON.parse(readFileSync(path, 'utf8')) as { version: string };
  }
  throw Error('owned_declared_dependency_missing');
}

test('80x24 forced warm reconnect targets original warm carrier, independently rejects replacement Job, and cold/foreign original checks preserve identity', async () => {
  const root = realpathSync(mkdtempSync('/private/tmp/kite-tui-mcp-reconnection-'));
  const evidence = `/private/tmp/kite-tui-mcp-reconnection-evidence-${randomUUID()}`;
  mkdirSync(evidence, { mode: 0o700 });
  const workspace = join(root, 'workspace');
  mkdirSync(workspace, { mode: 0o700 });
  mkdirSync(join(workspace, '.kite-code'), { mode: 0o700 });
  const profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'development' });
  const ledger = (name: string): Record<string, unknown>[] =>
    existsSync(join(root, name))
      ? readFileSync(join(root, name), 'utf8')
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line))
      : [];
  const wire = () => ledger('ui-http.jsonl') as Wire[];
  const posts = () =>
    wire().filter((row) => row.method === 'POST' && row.body?.kind === 'extension.invoke');
  const reconnectPosts = () => posts().filter((row) => row.body?.actionId === 'mcp.reconnect');
  const facts: unknown[] = [];
  const connections: {
    commandId: string;
    executionId: string;
    input: { serverId: string; key: string };
    fact: Record<string, unknown>;
  }[] = [];
  let readyOriginal:
    | { commandId: string; executionId: string; key: string; fact: TuiMcpReconnectionFact }
    | undefined;
  let original:
    | { commandId: string; executionId: string; fact: TuiMcpReconnectionFact }
    | undefined;
  let phase = 'warm',
    storeId = '',
    currentStoreId = '',
    subjectId: string | undefined,
    sourceId = '',
    modelCalls = 0,
    peerCalls = 0,
    rpc: string[] = [],
    success = false,
    cleanupConfirmed = false;
  let build: Bun.Subprocess<'ignore', 'pipe', 'pipe'> | undefined,
    python: Bun.Subprocess<'ignore', 'pipe', 'pipe'> | undefined,
    seed: Awaited<ReturnType<typeof launchPairedService>> | undefined,
    observer: ReturnType<typeof createClient> | undefined,
    artifact: CLIServiceArtifact | undefined,
    control: ReturnType<typeof Bun.serve> | undefined;
  let failure: unknown;
  let candidateAccess: ReturnType<typeof acquireArtifactAccess> | undefined;
  const cleanupErrors: unknown[] = [],
    closing = new AbortController(),
    controlWork = new Set<Promise<Response>>();
  let model: ReturnType<typeof Bun.serve> | undefined,
    peer: ReturnType<typeof Bun.serve> | undefined;
  const parentFetch = globalThis.fetch,
    observerHttp: { phase: string; method: string; path: string }[] = [];
  globalThis.fetch = Object.assign(
    async (...args: Parameters<typeof fetch>) => {
      const request = args[0],
        url = new URL(request instanceof Request ? request.url : String(request));
      observerHttp.push({
        phase,
        method: args[1]?.method ?? (request instanceof Request ? request.method : 'GET'),
        path: url.pathname,
      });
      return parentFetch(...args);
    },
    { preconnect: parentFetch.preconnect },
  );
  const settings = () =>
    writeFileSync(
      join(root, 'settings.json'),
      JSON.stringify({ root, workspace, dataRoot: profile.dataRoot, phase, artifact }),
      { mode: 0o600 },
    );
  try {
    model = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch() {
        modelCalls++;
        return new Response('owned_model_forbidden', { status: 500 });
      },
    });
    peer = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        peerCalls++;
        if (request.method !== 'POST') return new Response(null, { status: 405 });
        const body = (await request.json()) as { id?: number | string; method: string };
        if (body.id === undefined) return new Response(null, { status: 202 });
        rpc.push(body.method);
        if (!['initialize', 'tools/list'].includes(body.method))
          throw Error('owned_reconnection_tool_rpc_forbidden');
        return Response.json({
          jsonrpc: '2.0',
          id: body.id,
          result:
            body.method === 'initialize'
              ? {
                  protocolVersion: '2024-11-05',
                  serverInfo: { name: 'owned', version: '1' },
                  capabilities: { tools: {} },
                }
              : { tools: [{ name: 'original', inputSchema: { type: 'object' } }] },
        });
      },
    });
    // Public builder reads real Git provenance and copies installed owner resolution; no source aliases or installs.
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
    let setupTimer: ReturnType<typeof setTimeout> | undefined;
    const [out, err, code] = await (async () => {
      try {
        return await Promise.race([
          Promise.all([
            new Response(build!.stdout).text(),
            new Response(build!.stderr).text(),
            build!.exited,
          ]),
          new Promise<never>((_resolve, reject) => {
            setupTimer = setTimeout(
              () => reject(Error('owned_reconnection_setup_deadline')),
              60000,
            );
          }),
        ]);
      } finally {
        clearTimeout(setupTimer);
      }
    })();
    writeFileSync(join(evidence, 'build.log'), out + err, { mode: 0o600, flag: 'wx' });
    expect(code).toBe(0);
    const initialCandidate = verifyTerminalBundle(join(root, 'candidate'));
    candidateAccess = acquireArtifactAccess({ root: initialCandidate.root, mode: 'shared' });
    const candidate = verifyTerminalBundle(initialCandidate.root);
    expect(candidate.digest).toBe(initialCandidate.digest);
    // Parent maintenance must use the same verified engine as the independently built caller.
    const engineSelection = {
      root: join(candidate.root, 'node_modules/@kite-ai/agent/storage/engine'),
      manifestSha256: candidate.manifest.sqlite.manifestSha256,
    };
    const engine = initializeSqliteEngine(engineSelection);
    expect(engine.version).toBe(candidate.manifest.sqlite.version);
    expect(engine.version).toBe('3.51.3');
    expect(engine.sourceId).toBe(candidate.manifest.sqlite.sourceId);
    expect(engine.selection).toEqual(engineSelection);
    expect(getLoadedSqliteEngine()).toEqual(engine);
    facts.push({ stage: 'candidate_parent_engine', engine: getLoadedSqliteEngine() });
    privateFile(join(evidence, 'candidate.json'), {
      digest: candidate.digest,
      candidateId: candidate.candidateId,
      manifest: candidate.manifest,
    });
    const serviceOwner = join(repo, 'apps/service'),
      serviceBuilt = join(candidate.root, 'node_modules/@kite-ai/service');
    const declared = JSON.parse(readFileSync(join(serviceOwner, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
    };
    const dependencyVersions: Record<string, string> = {};
    for (const [name, range] of Object.entries(declared.dependencies ?? {})) {
      if (range.startsWith('workspace:')) continue;
      const expected = installed(name, serviceOwner).version;
      expect(installed(name, serviceBuilt).version).toBe(expected);
      dependencyVersions[name] = expected;
    }
    privateFile(join(evidence, 'service-dependencies.json'), dependencyVersions);
    symlinkSync(join(candidate.root, 'node_modules'), join(root, 'node_modules'));
    const compiled = await Bun.build({
      entrypoints: [join(import.meta.dir, '../fixtures/tui-mcp-reconnection-pty.ts')],
      outdir: root,
      naming: 'host.js',
      target: 'bun',
      packages: 'external',
    });
    expect(compiled.success).toBe(true);
    artifact = {
      executable: candidate.artifact.executable,
      executableSha256: candidate.artifact.executableSha256,
      entrypoint: join(root, 'host.js'),
      entrypointSha256: sha(readFileSync(join(root, 'host.js'))),
      buildId: 'owned-reconnection',
      apiMajor: 1,
    };
    privateFile(join(evidence, 'helper.json'), {
      sourcePath: 'apps/cli/test/fixtures/tui-mcp-reconnection-pty.ts',
      sourceSha256: sha(
        readFileSync(join(import.meta.dir, '../fixtures/tui-mcp-reconnection-pty.ts')),
      ),
      compiledSha256: artifact.entrypointSha256,
      candidateDigest: candidate.digest,
    });
    settings();
    mkdirSync(profile.profilePath, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(profile.profilePath, 'mcp.json'),
      JSON.stringify({
        mcpServers: {
          target: { type: 'http', url: `${peer.url.href}mcp`, auth: { type: 'none' } },
        },
      }),
      { mode: 0o600 },
    );
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
    seed = await launchPairedService({
      ...artifact,
      profile,
      instanceId: randomUUID(),
      requiredCapabilities: ['sessions', 'commands', 'interactions'],
    });
    appendFileSync(
      join(root, 'owned-services.jsonl'),
      `${JSON.stringify({ phase, servicePid: seed.pid, owner: 'seed' })}\n`,
      { mode: 0o600 },
    );
    storeId = seed.bootstrap.storeId!;
    currentStoreId = storeId;
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
      title: 'Owned Source decisions',
    });
    const directory = await createTuiMcpPort(seed.client, storeId).read('a', closing.signal);
    expect(directory.items).toHaveLength(1);
    sourceId = directory.items[0]!.id;
    expect(directory.items[0]!.admitted).toBe(true);
    const config = JSON.parse(readFileSync(join(profile.profilePath, 'config.jsonc'), 'utf8'));
    config.mcp = [{ id: sourceId, enabled: true }];
    writeFileSync(join(profile.profilePath, 'config.jsonc'), JSON.stringify(config), {
      mode: 0o600,
    });
    const seedPid = seed.pid;
    await seed.close();
    expect(await seed.exited).toBe(0);
    seed = undefined;
    facts.push({ seedPid, storeId, subjectId, sourceId });
    async function connected() {
      if (observer) return observer;
      const secret = await until(
        'observer',
        async () =>
          existsSync(join(root, 'observer-private.json'))
            ? (JSON.parse(readFileSync(join(root, 'observer-private.json'), 'utf8')) as {
                endpoint: string;
                token: string;
              })
            : undefined,
        closing.signal,
      );
      observer = createClient({
        endpoint: secret.endpoint,
        token: secret.token,
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
      closing.signal.throwIfAborted();
      expect(observer.serverInfo!.storeId).toBe(currentStoreId);
      expect(observer.serverInfo!.subjectId).toBe(subjectId);
      return observer;
    }
    const journalPath = join(profile.profilePath, 'ui/mcp-reconnection-intents.json');
    let journalBytes: Buffer<ArrayBuffer> | undefined,
      journalHash = '',
      cursorBaseline = '',
      selectedBaseline = 0,
      warmRpc = 0,
      warmPeer = 0,
      warmResolution = 0;
    async function submitted(n: number) {
      return until(
        'original submission',
        async () => {
          const all = posts();
          if (all.length < n) return undefined;
          if (all.length !== n) throw Error('owned_reconnection_duplicate_post');
          const id = all[n - 1]!.body!.commandId!;
          try {
            const command = await (await connected()).getCommand(id);
            const executionId = (command.receipt as { executionId?: string }).executionId;
            if (!executionId) return undefined;
            const reconnect = all[n - 1]!.body!.actionId === 'mcp.reconnect';
            const document = JSON.parse(
              readFileSync(
                join(
                  profile.profilePath,
                  `ui/mcp-${reconnect ? 'reconnection' : 'connection'}-intents.json`,
                ),
                'utf8',
              ),
            ) as { records: unknown[] };
            const record = document.records
              .map((row) =>
                reconnect ? parseMcpReconnectionRecord(row) : parseMcpConnectionRecord(row),
              )
              .find((row) => row.intent.request.commandId === id);
            expect(record).toBeDefined();
            expect(command.originStoreId).toBe(storeId);
            expect(command.subjectId).toBe(subjectId);
            expect(command.sessionId).toBe('a');
            expect(command.requestDigest).toBe(record!.requestSha256);
            return { command, executionId, request: record!.intent.request };
          } catch (error) {
            if (
              error instanceof ClientError &&
              error.status === 404 &&
              error.code === 'command_not_found'
            )
              return undefined;
            throw error;
          }
        },
        closing.signal,
      );
    }
    async function answer(executionId: string, decision: 'approve' | 'deny') {
      const client = await connected();
      const card = await until(
        'original approval',
        async () =>
          (await client.listInteractions('a', { storeId, state: 'pending' })).interactions.find(
            (row) => row.executionId === executionId && row.kind === 'approval',
          ),
        closing.signal,
      );
      expect(card.originStoreId).toBe(storeId);
      expect(card.sessionId).toBe('a');
      expect(card.definitionVersion).toBe('1');
      if (requiresInteractionAttachment(card)) await client.readInteractionAttachment(card);
      closing.signal.throwIfAborted();
      await client.answerInteraction('a', card.id, {
        expectedStoreId: storeId,
        commandId: `answer-${card.id}`,
        expectedRevision: card.revision,
        answer: {
          kind: 'approval',
          decision,
          ...(decision === 'approve' ? { grant: 'approve_once' as const } : {}),
        },
      });
      facts.push({
        stage: 'explicit-control-approval',
        executionId,
        interactionId: card.id,
        revision: card.revision,
        decision,
        definitionId: card.definitionId,
      });
      return card;
    }
    const query = async (executionId: string) =>
      decodeMcpReconnectionFact(
        await (await connected()).queryExtension('a', 'builtin.mcp', 'mcp.reconnection', {
          executionId,
        }),
      );
    const originalGets = () =>
      wire().filter(
        (row) =>
          row.phase === phase &&
          (row.path.includes('mcp.reconnection') ||
            (original &&
              (row.path.includes(original.commandId) || row.path.includes(original.executionId))) ||
            (readyOriginal &&
              (row.path.includes(readyOriginal.commandId) ||
                row.path.includes(readyOriginal.executionId)))),
      ).length;
    async function safeWindow(stage: string) {
      const view = await (await connected()).getView('a');
      expect(view.runs).toHaveLength(0);
      expect(modelCalls).toBe(0);
      expect(ledger('credentials.jsonl')).toHaveLength(0);
      expect(wire().filter((row) => row.body?.kind === 'command.cancel')).toHaveLength(0);
      facts.push({
        stage,
        phase,
        storeId: currentStoreId,
        cursor: view.snapshotCursor,
        runCount: view.runs.length,
        uiPost: wire().filter((row) => row.phase === phase && row.method === 'POST').length,
        originalGet: originalGets(),
        observerGet: observerHttp.filter((row) => row.phase === phase && row.method === 'GET')
          .length,
        observerPost: observerHttp.filter((row) => row.phase === phase && row.method === 'POST')
          .length,
        modelCalls,
        rpc: rpc.length,
        peerCalls,
        resolutions: ledger('resolutions.jsonl').length,
        credentials: ledger('credentials.jsonl').length,
      });
      return view;
    }
    async function priorClosed(expected: number) {
      await until(
        'prior paired Services closed',
        async () => {
          const owned = ledger('owned-services.jsonl'),
            exits = ledger('service-exits.jsonl');
          return owned.length === expected &&
            owned.every((row) => {
              const matches = exits.filter(
                (e) => e.pid === row.servicePid && e.phase === row.phase,
              );
              return (
                matches.length === 1 &&
                matches[0]!.exitCode === 0 &&
                matches[0]!.returnedAfterCleanup === true
              );
            })
            ? true
            : undefined;
        },
        closing.signal,
      );
    }
    async function controlRequest(request: Request): Promise<Response> {
      const path = new URL(request.url).pathname;
      let maintenanceStage = 'not_started';
      try {
        closing.signal.throwIfAborted();
        if (path === '/approve-a' || path === '/approve-b') {
          const n = path === '/approve-a' ? 1 : 2,
            { command, executionId, request: originalRequest } = await submitted(n),
            client = await connected();
          expect((originalRequest as { actionId: string }).actionId).toBe('mcp.connect');
          const baseline = rpc.length;
          await answer(executionId, 'approve');
          if (n === 1) {
            const child = await until(
              'independent first Job approval',
              async () => {
                for (const row of (
                  await client.listInteractions('a', { storeId, state: 'pending' })
                ).interactions) {
                  if (
                    row.definitionId === 'mcp.source.connection' &&
                    (await client.getExecution(row.executionId)).parentExecutionId === executionId
                  )
                    return row;
                }
                return undefined;
              },
              closing.signal,
            );
            expect(rpc.length).toBe(baseline);
            expect((await client.getExecution(child.executionId)).parentExecutionId).toBe(
              executionId,
            );
            await answer(child.executionId, 'approve');
          }
          await until(
            'connection ready',
            async () => {
              const e = await client.getExecution(executionId);
              return e.status === 'succeeded' ? e : undefined;
            },
            closing.signal,
          );
          const input = (originalRequest as { input: { serverId: string; key: string } }).input;
          const fact = (
            await client.queryExtension('a', 'builtin.mcp', 'mcp.connection', {
              executionId,
              ...input,
            })
          )[0]!.payload as Record<string, unknown>;
          expect(fact.phase).toBe('ready');
          expect(fact.live).toBe(true);
          expect(fact.created).toBe(n === 1);
          if (n === 2) {
            expect(fact.operationRef).toEqual(connections[0]!.fact.operationRef);
            expect(rpc.length).toBe(baseline);
          }
          connections.push({ commandId: command.id, executionId, input, fact });
          facts.push({ stage: path, commandId: command.id, executionId, fact });
          await safeWindow(path);
          return Response.json({ commandId: command.id });
        }
        if (path === '/before-confirm') {
          expect(reconnectPosts()).toHaveLength(0);
          expect(posts()).toHaveLength(2);
          expect(connections[1]!.fact.operationRef).toEqual(connections[0]!.fact.operationRef);
          await safeWindow(path);
          return Response.json({ checked: true });
        }
        if (path === '/before-second-confirm') {
          expect(reconnectPosts()).toHaveLength(1);
          expect(posts()).toHaveLength(3);
          expect(readyOriginal!.fact.phase).toBe('ready');
          await safeWindow(path);
          return Response.json({ checked: true });
        }
        if (path === '/approve-replacement' || path === '/deny-replacement') {
          const completing = path === '/approve-replacement';
          const {
              command,
              executionId,
              request: originalRequest,
            } = await submitted(completing ? 3 : 4),
            client = await connected();
          const input = (
            originalRequest as {
              actionId: string;
              input: {
                target: {
                  carrierExecutionId: string;
                  carrierKey: string;
                  operationRef: unknown;
                  connectionExecutionId: string;
                  configDigest: string;
                  currentGeneration: number;
                };
                key: string;
              };
            }
          ).input;
          expect((originalRequest as { actionId: string }).actionId).toBe('mcp.reconnect');
          expect(input.target.carrierExecutionId).toBe(
            completing ? connections[1]!.executionId : readyOriginal!.executionId,
          );
          expect(input.target.carrierKey).toBe(
            completing ? connections[1]!.input.key : readyOriginal!.key,
          );
          expect(input.target.operationRef).toEqual(
            completing ? connections[0]!.fact.operationRef : readyOriginal!.fact.newOperationRef,
          );
          expect(input.target.connectionExecutionId).toBe(
            completing
              ? (connections[0]!.fact.connection as { id: string }).id
              : readyOriginal!.fact.newConnection!.id,
          );
          expect(input.target.configDigest).toBe(
            completing
              ? (connections[1]!.fact.ready as { configDigest: string }).configDigest
              : readyOriginal!.fact.ready!.configDigest,
          );
          const expectedGeneration = completing
            ? connections[1]!.fact.currentGeneration
            : readyOriginal!.fact.currentGeneration;
          if (typeof expectedGeneration !== 'number')
            throw Error('owned_reconnection_target_generation_missing');
          expect(input.target.currentGeneration).toBe(expectedGeneration);
          expect(input.key).not.toBe(input.target.carrierKey);
          const baseline = rpc.length;
          await answer(executionId, 'approve');
          const child = await until(
            'replacement Job approval',
            async () => {
              const cards = (await client.listInteractions('a', { storeId, state: 'pending' }))
                .interactions;
              for (const row of cards) {
                if (
                  row.definitionId === 'mcp.source.connection' &&
                  (await client.getExecution(row.executionId)).parentExecutionId === executionId
                )
                  return row;
              }
              return undefined;
            },
            closing.signal,
          );
          const old = await client.getExecution(input.target.connectionExecutionId);
          expect(['cancelled', 'failed', 'succeeded']).toContain(old.status);
          expect(old.result).toMatchObject({
            details: { transportStopped: true, remoteToolStopConfirmed: false },
          });
          expect(rpc.length).toBe(baseline);
          const planned = await query(executionId);
          expect(planned.oldStop.confirmed).toBe(true);
          expect(planned.newConnection!.id).toBe(child.executionId);
          expect(planned.ready).toBeNull();
          facts.push({
            stage: 'old-terminal-before-new-open',
            commandId: command.id,
            executionId,
            oldExecutionId: old.id,
            oldStatus: old.status,
            oldResult: old.result,
            rpcCount: baseline,
            newExecutionId: child.executionId,
          });
          await answer(child.executionId, completing ? 'approve' : 'deny');
          const fact = await until(
            'stopped old and terminal replacement',
            async () => {
              const f = await query(executionId);
              return f.phase === (completing ? 'ready' : 'failed') ? f : undefined;
            },
            closing.signal,
          );
          expect(fact.oldStop.confirmed).toBe(true);
          expect(fact.newConnection!.status).toBe(completing ? 'running' : 'failed');
          if (completing) {
            expect(fact.ready).not.toBeNull();
            expect(fact.live).toBe(true);
            expect(fact.currentGeneration).toBe(fact.ready!.generation);
            expect(fact.newOperationRef!.commandId).toBe(fact.newConnection!.originCommandId);
            expect(fact.newOperationRef!.executionId).toBe(child.executionId);
            expect(fact.newConnection!.parentExecutionId).toBe(executionId);
            expect(rpc.slice(baseline)).toEqual(['initialize', 'tools/list']);
            readyOriginal = { commandId: command.id, executionId, key: input.key, fact };
          } else {
            expect(fact.ready).toBeNull();
            expect(fact.live).toBe(false);
            expect(fact.currentGeneration).toBeNull();
            expect(rpc.length).toBe(baseline);
            original = { commandId: command.id, executionId, fact };
          }
          facts.push({
            stage: path,
            commandId: command.id,
            executionId,
            target: fact.target,
            oldStop: fact.oldStop,
            newOperationRef: fact.newOperationRef,
            newConnection: fact.newConnection,
          });
          await safeWindow(path);
          return Response.json({ commandId: command.id });
        }
        if (path === '/warm-complete') {
          expect(original).toBeDefined();
          journalBytes = Buffer.from(readFileSync(journalPath));
          journalHash = sha(journalBytes);
          const records = (
            JSON.parse(journalBytes.toString()) as {
              records: {
                intent: { request: { commandId: string }; targetRequest: { commandId: string } };
                phase: string;
              }[];
            }
          ).records;
          expect(records).toHaveLength(2);
          const first = records.find(
            (r) => r.intent.request.commandId === readyOriginal!.commandId,
          )!;
          const second = records.find((r) => r.intent.request.commandId === original!.commandId)!;
          expect(first.intent.targetRequest.commandId).toBe(connections[1]!.commandId);
          expect(first.phase).toBe('ready');
          expect(second.intent.targetRequest.commandId).toBe(readyOriginal!.commandId);
          expect(second.phase).toBe('failed');
          warmRpc = rpc.length;
          warmPeer = peerCalls;
          warmResolution = ledger('resolutions.jsonl').length;
          await safeWindow(path);
          return Response.json({ checked: true });
        }
        if (path === '/cold-removed') {
          await priorClosed(2);
          closing.signal.throwIfAborted();
          observer?.disposeNetwork();
          observer = undefined;
          rmSync(join(profile.profilePath, 'mcp.json'));
          renameSync(workspace, join(root, 'removed-workspace'));
          phase = 'cold-removed';
          rmSync(join(root, 'observer-private.json'), { force: true });
          settings();
          return Response.json({ phase });
        }
        if (path === '/cold-foreign') {
          await priorClosed(3);
          closing.signal.throwIfAborted();
          observer?.disposeNetwork();
          observer = undefined;
          expect(readFileSync(journalPath)).toEqual(journalBytes!);
          maintenanceStage = 'create';
          const backup = await createProfileBackup({
            profile,
            destinationRoot: join(root, 'reconnection-backups'),
            signal: closing.signal,
          });
          closing.signal.throwIfAborted();
          expect(backup.manifest.version).toBe(11);
          expect(backup.manifest.assets.mcpReconnectionIntents).toMatchObject({
            present: true,
            path: 'ui/mcp-reconnection-intents.json',
            format: { version: 1 },
            proof: { sha256: journalHash },
          });
          maintenanceStage = 'inspect';
          expect((await inspectProfileBackup(backup)).manifest).toEqual(backup.manifest);
          expect(readFileSync(join(backup.directory, 'ui/mcp-reconnection-intents.json'))).toEqual(
            journalBytes!,
          );
          maintenanceStage = 'restore';
          const restored = await restoreProfileBackup({
            profile,
            expectedStoreId: storeId,
            backup,
            intent: 'replace_with_selected_backup',
            signal: closing.signal,
          });
          closing.signal.throwIfAborted();
          currentStoreId = restored.storeId;
          expect(currentStoreId).not.toBe(storeId);
          expect(readFileSync(journalPath)).toEqual(journalBytes!);
          phase = 'cold-foreign';
          rmSync(join(root, 'observer-private.json'), { force: true });
          settings();
          facts.push({
            stage: path,
            storeA: storeId,
            storeB: currentStoreId,
            backupVersion: backup.manifest.version,
            journalHash,
          });
          return Response.json({ phase });
        }
        if (path === '/selection-baseline') {
          selectedBaseline = originalGets();
          cursorBaseline = (await safeWindow(path)).snapshotCursor;
          return Response.json({ checked: true });
        }
        if (path === '/cold-selected' || path === '/foreign-selected') {
          expect(originalGets()).toBe(selectedBaseline);
          expect(wire().filter((row) => row.phase === phase && row.method === 'POST')).toHaveLength(
            0,
          );
          expect((await safeWindow(path)).snapshotCursor).toBe(cursorBaseline);
          return Response.json({ checked: true });
        }
        if (path === '/cold-lookup' || path === '/foreign-lookup') {
          if (path === '/cold-lookup') {
            expect(originalGets()).toBeGreaterThan(selectedBaseline);
            const fact = await query(original!.executionId);
            expect(fact).toEqual(original!.fact);
          } else {
            expect(currentStoreId).not.toBe(storeId);
            expect(originalGets()).toBe(0);
          }
          expect(wire().filter((row) => row.phase === phase && row.method === 'POST')).toHaveLength(
            0,
          );
          expect(readFileSync(journalPath)).toEqual(journalBytes!);
          expect(sha(readFileSync(journalPath))).toBe(journalHash);
          expect(rpc.length).toBe(warmRpc);
          expect(peerCalls).toBe(warmPeer);
          expect(ledger('resolutions.jsonl')).toHaveLength(warmResolution);
          expect((await safeWindow(path)).snapshotCursor).toBe(cursorBaseline);
          facts.push({
            stage: path,
            commandId: original!.commandId,
            originalStoreId: storeId,
            currentStoreId,
            originalLookupHttp: originalGets(),
            fixtureConfirmedForeign: path === '/foreign-lookup',
            publicReason: null,
            journalHash,
          });
          return Response.json({ checked: true });
        }
        await safeWindow(path);
        return Response.json({ checked: true });
      } catch (error) {
        facts.push({
          stage: 'control-failure',
          path,
          maintenanceStage,
          name: error instanceof Error ? error.name : 'unknown',
          message: error instanceof Error ? error.message.slice(0, 4096) : null,
        });
        return Response.json({ error: 'owned_reconnection_control_failed' }, { status: 500 });
      }
    }
    control = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(request) {
        const work = controlRequest(request);
        controlWork.add(work);
        void work.finally(() => controlWork.delete(work));
        return work;
      },
    });
    writeFileSync(join(evidence, 'pty-owned.jsonl'), '', { mode: 0o600, flag: 'wx' });
    const program = `import os,pty,subprocess,select,time,signal,re,fcntl,termios,struct,json,urllib.request,codecs,threading
p=None;master=None;buffer='';decoder=codecs.getincrementaldecoder('utf-8')('strict');exits=[];cleanup=False;trace=[];failure=None

def note(kind,**values):
 trace.append(dict(kind=kind,time=time.monotonic(),**values))
 if len(trace)>512:del trace[0]

def control(path):
 note('control',path=path,frame=normalized()[-32768:])
 # A pending control reply must not stop PTY reads and backpressure the actual Host.
 result={}
 def request():
  try:
   with urllib.request.urlopen(${JSON.stringify(control.url.href)}+path,timeout=12) as response:result['reply']=json.load(response)
  except BaseException as error:result['error']=error
 worker=threading.Thread(target=request,daemon=True);worker.start()
 deadline=time.monotonic()+12
 while worker.is_alive():
  if time.monotonic()>deadline:raise RuntimeError('owned_control_deadline:'+path)
  if master is None:worker.join(.01)
  else:receive(.01);drain(deadline)
 worker.join()
 if 'error' in result:raise result['error']
 return result['reply']
def normalized():
 frames=buffer.split('\\x1b[?2026h')
 complete=next((frame.split('\\x1b[?2026l')[0] for frame in reversed(frames[1:]) if '\\x1b[?2026l' in frame),'')
 return re.sub(r'\\s+',' ',re.sub(r'\\x1b\\[[0-?]*[ -/]*[@-~]','',complete))
def receive(timeout=.05):
 global buffer
 if select.select([master],[],[],timeout)[0]:
  chunk=os.read(master,65536)
  if not chunk:raise RuntimeError('owned_pty_eof')
  buffer=(buffer+decoder.decode(chunk))[-1048576:]
def drain(deadline=None):
 reads=0
 while select.select([master],[],[],0)[0]:
  if reads>=16:raise RuntimeError('owned_frame_drain_limit')
  if deadline is not None and time.monotonic()>deadline:raise RuntimeError('owned_frame_drain_deadline')
  receive(0);reads+=1
def wait(text,compact=False):
 deadline=time.monotonic()+10
 while True:
  drain(deadline)
  if text in (normalized().replace(' ','') if compact else normalized()):
   note('matched',text=text,frame=normalized()[-32768:]);return
  if time.monotonic()>deadline:raise RuntimeError('owned_frame_deadline:'+text)
  receive()
def wait_idle():
 # API completion can precede the selected Session refresh; wait for its live composer.
 deadline=time.monotonic()+10
 while True:
  drain(deadline)
  frame=normalized()
  if 'New Run >' in frame and ' · Loading ' not in frame:
   note('composer-ready',frame=frame[-32768:]);return
  if time.monotonic()>deadline:raise RuntimeError('owned_composer_deadline')
  receive()
def wait_new_reconnection(previous):
 # Keep reading while submission completes; older menu and detail IDs are not this request.
 deadline=time.monotonic()+10
 while True:
  drain(deadline)
  original=next((match.group(1) for match in re.finditer(r'Originalforcedreconnect:([a-f0-9-]{36})',normalized().replace(' ','')) if match.group(1) not in previous),None)
  if original:
   note('new-reconnection',commandId=original,frame=normalized()[-32768:]);return original
  if time.monotonic()>deadline:raise RuntimeError('owned_new_reconnection_deadline')
  receive()
def key(value,preserveSelectedFrame=False):
 global buffer
 if not value:return
 drain()
 note('key',hex=value.hex(),preserveSelectedFrame=preserveSelectedFrame,frame=normalized()[-32768:])
 if not preserveSelectedFrame:buffer=''
 os.write(master,value)
def selected(command_id):
 # Only the outcome detail has the original Session suffix; list labels do not.
 detail='Originalforcedreconnect:'+command_id+'·OriginalStore:'+${JSON.stringify(storeId)}+'·Sessiona'
 wait(detail,True)
def start(phase):
 global p,master,buffer,decoder
 master,slave=pty.openpty();fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',24,80,0,0))
 decoder=codecs.getincrementaldecoder('utf-8')('strict')
 p=subprocess.Popen([${JSON.stringify(process.execPath)},${JSON.stringify(join(root, 'host.js'))}],stdin=slave,stdout=slave,stderr=slave,start_new_session=True,env=dict(os.environ,HOME=${JSON.stringify(root)},KITE_CODE_HOME=${JSON.stringify(join(root, 'owned-home'))}))
 os.close(slave);buffer=''
 with open(${JSON.stringify(join(evidence, 'pty-owned.jsonl'))},'a') as log:log.write(json.dumps({'phase':phase,'pid':p.pid})+'\\n');log.flush();os.fsync(log.fileno())
 wait('New Run >')
def choose(label,top='Project sources'):
 deadline=time.monotonic()+10
 if ('› '+label) in normalized():return
 if ('› '+top) not in normalized():
  key(b'\\x1b[A'*64)
  while ('› '+top) not in normalized():
   drain(deadline)
   if time.monotonic()>deadline:raise RuntimeError('owned_navigation_top_deadline:'+top)
   receive()
 while True:
  drain(deadline)
  if ('› '+label) in normalized():return
  if time.monotonic()>deadline:raise RuntimeError('owned_navigation_deadline:'+label)
  key(b'\\x1b[B')
  while not normalized():
   if time.monotonic()>deadline:raise RuntimeError('owned_navigation_frame_deadline:'+label)
   receive()
def select_original(command_id,top):
 choose('Original forced reconnect: '+command_id,top)
 known=('Originalforcedreconnect:'+command_id+'·OriginalStore:'+${JSON.stringify(storeId)}+'·Sessiona') in normalized().replace(' ','')
 note('select-original-key',commandId=command_id,retainedKnownDetail=known)
 key(b'\\r',preserveSelectedFrame=known);selected(command_id)
def mcp():
 wait_idle();key(b'/mcp');wait('New Run > /mcp');key(b'\\r');wait('Project sources')
def request_connection():
 mcp();wait('Server list ready');choose(${JSON.stringify(sourceId)}+' · enabled · available');key(b'\\r');wait('Server:');choose('Request connection');key(b'\\r');wait('Confirm connection request:');key(b'\\r');wait('Original connection:')
def check_connection():
 choose('Check original connection');key(b'\\r');wait('Original catalogue ready')
def reconnections():
 mcp();choose('Forced reconnects');key(b'\\r');wait('Selecting an original ID does not query, reconnect or authorize tools.')
def leave_reconnections(pending=False,parentTitle='MCP · w'):
 # Child close only returns to the real parent MCP panel; observe that frame before a second close.
 key(b'\\x03');wait(parentTitle);note('parent-mcp-after-child-close',expectedTitle=parentTitle,frame=normalized()[-32768:]);key(b'\\x03');wait('Ctrl+B pending cards' if pending else 'New Run >');note('main-after-parent-close',pending=pending,frame=normalized()[-32768:])
def close(phase):
 global master,p
 key(b'\\x11');deadline=time.monotonic()+6
 while p.poll() is None and time.monotonic()<deadline:
  if select.select([master],[],[],.05)[0]:
   try:os.read(master,65536)
   except OSError:break
 p.wait(timeout=3)
 exits.append({'phase':phase,'pid':p.pid,'exitCode':p.returncode,'normalCtrlQ':True})
 assert p.returncode==0
 os.close(master);master=None;p=None
try:
 start('warm');request_connection();first=control('approve-a')['commandId'];check_connection();choose('Request connection');key(b'\\r');wait('Confirm connection request:');key(b'\\r');wait('Original connection:');second=control('approve-b')['commandId'];check_connection();wait('Reused original connection');choose('Review forced reconnect');key(b'\\r');wait('Confirm forced reconnect:');wait('Original carrier: '+second);wait('› Confirm forced reconnect');control('before-confirm');key(b'\\r');submitted_ready=wait_new_reconnection([]);leave_reconnections(pending=True);ready=control('approve-replacement')['commandId'];assert ready==submitted_ready;wait('New Run >');reconnections();select_original(ready,'Check original forced reconnect');choose('Check original forced reconnect','Check original forced reconnect');key(b'\\r');wait('Replacement catalogue ready');wait('Live replacement observed');choose('Review forced reconnect','Check original forced reconnect');key(b'\\r');wait('Confirm forced reconnect:');wait('Original carrier: '+ready);wait('› Confirm forced reconnect');control('before-second-confirm');key(b'\\r');submitted_denied=wait_new_reconnection([ready]);leave_reconnections(pending=True);original=control('deny-replacement')['commandId'];assert original==submitted_denied;wait('New Run >');reconnections();select_original(original,'Check original forced reconnect');choose('Check original forced reconnect','Check original forced reconnect');key(b'\\r');wait('Forced reconnect failed');wait('Original connection stop confirmed');wait('Live replacement not confirmed');control('warm-complete');leave_reconnections();close('warm')
 control('cold-removed');start('cold-removed');reconnections();control('selection-baseline');select_original(original,'Original forced reconnect: '+ready);control('cold-selected');choose('Check original forced reconnect','Check original forced reconnect');key(b'\\r');wait('Forced reconnect failed');wait('Original connection stop confirmed');control('cold-lookup');leave_reconnections(parentTitle='MCP · unavailable');close('cold-removed')
 control('cold-foreign');start('cold-foreign');reconnections();control('selection-baseline');select_original(original,'Original forced reconnect: '+ready);wait('Forced reconnect outcome unknown; Check original');control('foreign-selected');choose('Check original forced reconnect','Check original forced reconnect');note('foreign-check-key',commandId=original,observation='retained identical known unknown detail; no new frame or server receipt');key(b'\\r',preserveSelectedFrame=True);selected(original);wait('Forced reconnect outcome unknown; Check original');control('foreign-lookup');leave_reconnections(parentTitle='MCP · unavailable');close('cold-foreign')
 cleanup=True;print('RECONNECTION_WARM_COLD_FOREIGN_COMPLETE')
except BaseException as error:
 failure={'type':type(error).__name__,'message':str(error)[:4096],'frame':normalized()[-32768:]}
 raise
finally:
 try:
  if p is not None:
   if p.poll() is None:
    p.terminate()
    try:p.wait(timeout=6)
    except subprocess.TimeoutExpired:p.kill();p.wait(timeout=3)
   exits.append({'phase':'cleanup','pid':p.pid,'exitCode':p.returncode,'normalCtrlQ':False});p=None
 finally:
  if master is not None:os.close(master);master=None
  with os.fdopen(os.open(${JSON.stringify(join(evidence, 'pty-trace.json'))},os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600),'w') as log:json.dump({'failure':failure,'latestCompleteFrame':normalized()[-32768:],'trace':trace},log);log.flush();os.fsync(log.fileno())
  with os.fdopen(os.open(${JSON.stringify(join(evidence, 'pty-exits.json'))},os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600),'w') as log:json.dump({'normalComplete':cleanup,'exits':exits},log);log.flush();os.fsync(log.fileno())
`;
    python = Bun.spawn(['python3', '-c', program], { stdout: 'pipe', stderr: 'pipe' });
    const [ptyOut, ptyErr, ptyCode] = await Promise.all([
      new Response(python.stdout).text(),
      new Response(python.stderr).text(),
      python.exited,
    ]);
    writeFileSync(join(evidence, 'pty.log'), ptyOut + ptyErr, { mode: 0o600, flag: 'wx' });
    expect(ptyCode).toBe(0);
    expect(ptyOut).toContain('RECONNECTION_WARM_COLD_FOREIGN_COMPLETE');
    expect(posts()).toHaveLength(4);
    expect(reconnectPosts()).toHaveLength(2);
    expect(new Set(posts().map((row) => row.body!.commandId)).size).toBe(4);
    expect(wire().filter((row) => row.phase !== 'warm' && row.method === 'POST')).toHaveLength(0);
    expect(modelCalls).toBe(0);
    expect(rpc).toEqual(['initialize', 'tools/list', 'initialize', 'tools/list']);
    expect(ledger('credentials.jsonl')).toHaveLength(0);
    const ptyExits = JSON.parse(readFileSync(join(evidence, 'pty-exits.json'), 'utf8')) as {
      normalComplete: boolean;
      exits: { exitCode: number; normalCtrlQ: boolean }[];
    };
    expect(ptyExits.normalComplete).toBe(true);
    expect(ptyExits.exits).toHaveLength(3);
    expect(ptyExits.exits.every((row) => row.exitCode === 0 && row.normalCtrlQ)).toBe(true);
    expect(ledger('owned-services.jsonl')).toHaveLength(4);
    expect(ledger('service-exits.jsonl')).toHaveLength(4);
    expect(
      ledger('service-exits.jsonl').every(
        (row) => row.exitCode === 0 && row.returnedAfterCleanup === true,
      ),
    ).toBe(true);
    success = true;
    facts.push({ journalHash, journalBytes: journalBytes?.length, sourceId });
  } catch (error) {
    failure = error;
  } finally {
    closing.abort(Error('owned_reconnection_pty_closing'));
    const collect = async (work: () => Promise<unknown>) => {
      try {
        await work();
      } catch (error) {
        cleanupErrors.push(error);
      }
    };
    async function bounded(work: Promise<unknown>, ms: number) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          work,
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(Error('owned_reconnection_cleanup_unconfirmed')), ms);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    }
    try {
      await collect(async () => observer?.disposeNetwork());
      await collect(async () => {
        if (python?.exitCode === null) {
          python.kill('SIGINT');
          await bounded(python.exited, 9000);
        }
      });
      await collect(async () => {
        if (build?.exitCode === null) {
          build.kill('SIGTERM');
          await bounded(build.exited, 9000);
        }
      });
      await collect(async () => {
        if (seed) {
          await seed.close();
          expect(await seed.exited).toBe(0);
        }
      });
      await collect(async () => {
        await control?.stop(true);
      });
      await collect(async () => {
        await bounded(Promise.allSettled([...controlWork]), 12000);
        if (controlWork.size) throw Error('owned_control_unconfirmed');
      });
      await collect(async () => {
        await peer?.stop(true);
      });
      await collect(async () => {
        await model?.stop(true);
      });
    } finally {
      try {
        const owned = ledger('owned-services.jsonl'),
          exits = ledger('service-exits.jsonl');
        const ownedSettled = owned.every((row) =>
          exits.some(
            (e) =>
              e.pid === row.servicePid &&
              e.phase === row.phase &&
              e.exitCode === 0 &&
              e.returnedAfterCleanup === true,
          ),
        );
        if (controlWork.size !== 0 || python?.exitCode === null || !ownedSettled)
          cleanupErrors.push(Error('owned_candidate_lease_retained_for_unconfirmed_work'));
        else {
          candidateAccess?.release();
          candidateAccess = undefined;
        }
      } catch (error) {
        cleanupErrors.push(error);
      }
      try {
        observer?.disposeNetwork();
      } catch (error) {
        cleanupErrors.push(error);
      }
      const serviceCleanupReceipts: { phase: unknown; servicePid: unknown; confirmed: boolean }[] =
        [];
      try {
        const owned = ledger('owned-services.jsonl'),
          exits = ledger('service-exits.jsonl');
        for (const row of owned) {
          const matches = exits.filter(
            (receipt) => receipt.pid === row.servicePid && receipt.phase === row.phase,
          );
          const confirmed =
            Number.isSafeInteger(row.servicePid) &&
            Number(row.servicePid) > 0 &&
            matches.length === 1 &&
            matches[0]!.exitCode === 0 &&
            matches[0]!.returnedAfterCleanup === true;
          serviceCleanupReceipts.push({ phase: row.phase, servicePid: row.servicePid, confirmed });
          if (!confirmed) cleanupErrors.push(Error('owned_service_cleanup_unconfirmed'));
        }
        if (new Set(owned.map((row) => `${row.phase}:${row.servicePid}`)).size !== owned.length)
          cleanupErrors.push(Error('owned_service_identity_duplicate'));
      } catch (error) {
        cleanupErrors.push(error);
      }
      for (const name of [
        'ui-http.jsonl',
        'permissions.jsonl',
        'credentials.jsonl',
        'resolutions.jsonl',
        'owned-services.jsonl',
        'service-exits.jsonl',
      ]) {
        try {
          if (existsSync(join(root, name)))
            writeFileSync(join(evidence, name), readFileSync(join(root, name)), {
              mode: 0o600,
              flag: 'wx',
            });
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
      if (controlWork.size === 0) globalThis.fetch = parentFetch;
      cleanupConfirmed =
        (python === undefined || python.exitCode !== null) &&
        (build === undefined || build.exitCode !== null) &&
        controlWork.size === 0 &&
        cleanupErrors.length === 0;
      if (success && cleanupConfirmed) {
        try {
          rmSync(root, { recursive: true, force: true });
          if (existsSync(root)) {
            cleanupErrors.push(Error('owned_root_delete_unconfirmed'));
            cleanupConfirmed = false;
          }
        } catch (error) {
          cleanupErrors.push(error);
          cleanupConfirmed = false;
        }
      }
      try {
        privateFile(join(evidence, 'packet.json'), {
          success,
          cleanupConfirmed,
          candidateLeaseRetained: candidateAccess !== undefined,
          serviceCleanupReceipts,
          retainedRoot: existsSync(root) ? root : null,
          failure:
            failure instanceof Error
              ? { name: failure.name, message: failure.message }
              : failure
                ? { name: 'unknown' }
                : null,
          cleanupErrors: cleanupErrors.map((error) =>
            error instanceof Error ? error.name : 'unknown',
          ),
          storeId,
          subjectId,
          currentStoreId,
          sourceId,
          peerCalls,
          rpc,
          modelCalls,
          observerHttp,
          facts,
          deadlines: {
            setupMs: 60000,
            stepMs: 10000,
            controlMs: 12000,
            normalExitMs: 6000,
            exitWaitMs: 3000,
            testMs: 180000,
          },
          limits: {
            foreignRestore:
              'Public v11 A→B; terminal original ID lookup rejects foreign Store before original lookup HTTP',
            cursorUnchanged: success,
            windows: false,
            linux: false,
            faultCleanup: false,
          },
        });
      } catch (error) {
        cleanupErrors.push(error);
        cleanupConfirmed = false;
      }
      console.error(
        JSON.stringify({
          evidence,
          originalFailure: failure instanceof Error ? failure.name : failure ? 'unknown' : null,
          publicationOrCleanupFailure: cleanupErrors.map((error) =>
            error instanceof Error ? error.name : 'unknown',
          ),
          success,
          cleanupConfirmed,
          candidateLeaseRetained: candidateAccess !== undefined,
          serviceCleanupReceipts,
          retainedRoot: existsSync(root) ? root : null,
        }),
      );
    }
  }
  if (cleanupErrors.length)
    throw new AggregateError(cleanupErrors, 'owned_reconnection_cleanup_failed');
  if (failure) throw failure;
}, 180000);
