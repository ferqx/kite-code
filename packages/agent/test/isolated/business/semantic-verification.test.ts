import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ModelAdapter, ModelEvent } from '@kite-ai/ai';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createPlanningValidation, planningExtensionId } from '../../../src/business/planning';
import type { Json } from '../../../src/extensions';
import { createShellJob } from '../../../src/jobs/shell';
import { canonicalJson } from '../../../src/json';
import { createMcpLifecycle } from '../../../src/mcp';
import { createRuntime } from '../../../src/runtime';
import { openSqliteStore } from '../../../src/sqlite';

const finish: ModelEvent = {
  type: 'finish',
  reason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1 },
};
const call = (name: string, input: Json): ModelEvent[] => [
  { type: 'tool_call', id: crypto.randomUUID(), name, arguments: JSON.stringify(input) },
  { ...finish, reason: 'tool_calls' },
];
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
function temporary() {
  return realpathSync(mkdtempSync(join(tmpdir(), 'kite-semantic-check-')));
}

async function commandFixture(
  command: (ledger: string) => string,
  expectedExitCode: number,
  deny = false,
) {
  const root = temporary();
  const ledger = join(root, 'effects');
  const built = await Bun.build({
    entrypoints: [join(import.meta.dir, '../../../src/platform/process/shell-supervisor.ts')],
    outdir: join(root, 'assets'),
    naming: 'shell-supervisor.js',
    target: 'bun',
  });
  if (!built.success) throw new Error('test_guardian_build_failed');
  const store = await openSqliteStore({ dataRoot: join(root, 'data'), profile: 'new' });
  const expectedStoreId = (await store.getMetadata()).storeId;
  const business = createPlanningValidation({
    requiredValidation: true,
    commandChecker: { definitionId: 'shell.command', definitionVersion: '1' },
  });
  let steps = 0,
    starts = 0;
  const shell = createShellJob({
    cwd: root,
    env: { PATH: '/usr/bin:/bin' },
    supervisorPath: built.outputs[0]!.path,
    bunExecutable: process.execPath,
    shellExecutable: '/bin/sh',
  });
  const model: ModelAdapter = {
    async *stream() {
      const runId = (await store.listExecutions('s')).find((entry) => entry.kind === 'model')!
        .runId!;
      const response =
        steps++ === 0
          ? call('validation.define', {
              runId,
              checks: [{ kind: 'command', input: { command: command(ledger) }, expectedExitCode }],
            })
          : steps === 2
            ? call('validation.check', { runId })
            : [finish];
      yield* response;
    },
  };
  const permissions: string[] = [];
  const runtime = createRuntime({
    store,
    model,
    modelId: 'fixed',
    extensions: [
      business.extension,
      {
        id: 'fixture.shell',
        version: '1',
        apiMajor: 1,
        jobs: [
          {
            ...shell,
            async start(input, context) {
              starts++;
              expect((await store.getExecution(context.executionId))?.status).toBe('dispatching');
              return shell.start(input, context);
            },
          },
        ],
      },
    ],
    conditions: business.conditions,
    initializeRunRequirements: business.initializeRequirements,
    permissions: {
      async authorize(request) {
        permissions.push(`${request.kind}:${request.definitionId}`);
        return { allowed: !(deny && request.kind === 'job'), revision: 'trusted-test' };
      },
    },
  });
  const base = { expectedStoreId, sessionId: 's', subjectId: 'user' };
  await runtime.createWorkspace({
    expectedStoreId,
    id: 'w',
    rootUri: `file://${root}`,
    name: 'private',
  });
  await runtime.createSession({
    ...base,
    commandId: 'create',
    workspaceId: 'w',
    title: 'semantic',
  });
  return {
    root,
    ledger,
    store,
    runtime,
    base,
    permissions,
    get starts() {
      return starts;
    },
    async run() {
      await runtime.submitCommand({
        ...base,
        commandId: 'work',
        request: { kind: 'run.start', content: 'verify exact command' },
      });
      const command = await runtime.waitForCommand('work', { timeoutMs: 10000 });
      return (await store.getRun((command.receipt as { runId: string }).runId))!;
    },
    async close() {
      await runtime.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

const posix = process.platform === 'darwin' ? test : test.skip;
posix(
  'actual Shell Job exit semantics are checked after durable dispatch; text success and wrong exit cannot complete required validation',
  async () => {
    for (const expected of [0, 7]) {
      const f = await commandFixture(
        (ledger) => `printf effect >> ${quote(ledger)}; exit 7`,
        expected,
      );
      try {
        const run = await f.run();
        expect(run.status).toBe(expected === 7 ? 'completed' : 'failed');
        expect(readFileSync(f.ledger, 'utf8')).toBe('effect');
        expect(f.starts).toBe(1);
        expect(f.permissions).toContain('job:shell.command');
        const job = (await f.store.listExecutions('s')).find(
          (entry) => entry.definitionId === 'shell.command',
        )!;
        expect(job.status).toBe('failed');
        expect((job.result as { details: { groupStopped: boolean } }).details.groupStopped).toBe(
          true,
        );
        const records = await f.store.listExtensionRecords({
          sessionId: 's',
          extensionId: planningExtensionId,
        });
        const attempt = records.find((entry) => entry.key.includes('/validation.attempt/'))!
          .value as { checks: { target: { executionId: string }; outcome: string }[] };
        expect(attempt.checks[0]!.target.executionId).toBe(job.id);
        expect(attempt.checks[0]!.outcome).toBe(expected === 7 ? 'passed' : 'failed');
      } finally {
        await f.close();
      }
    }
  },
  25000,
);

posix(
  'command checker Job remains independently authorized: denied Job has no physical effect and no successful proof',
  async () => {
    const f = await commandFixture((ledger) => `printf forbidden >> ${quote(ledger)}`, 0, true);
    try {
      expect((await f.run()).status).toBe('failed');
      expect(f.starts).toBe(0);
      expect(existsSync(f.ledger)).toBe(false);
      expect(f.permissions).toContain('tool:validation.check');
      expect(f.permissions).toContain('job:shell.command');
    } finally {
      await f.close();
    }
  },
  15000,
);

async function mcpScenario(mode: 'repair' | 'bad_shape' | 'wrong_version' | 'wrong_source') {
  const root = temporary();
  const store = await openSqliteStore({ dataRoot: join(root, 'data'), profile: 'new' });
  const expectedStoreId = (await store.getMetadata()).storeId;
  let value = 0,
    calls = 0,
    connections = 0,
    steps = 0;
  const network = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      if (request.method !== 'POST') return new Response(null, { status: 405 });
      const rpc = (await request.json()) as { id?: number; method: string };
      if (rpc.id === undefined) return new Response(null, { status: 202 });
      let result: unknown;
      if (rpc.method === 'initialize') {
        connections++;
        result = {
          protocolVersion: '2024-11-05',
          serverInfo: { name: 'fixture', version: '1' },
          capabilities: { tools: {} },
        };
      } else if (rpc.method === 'tools/list')
        result = { tools: [{ name: 'read', inputSchema: { type: 'object' } }] };
      else {
        calls++;
        result = {
          content: [{ type: 'text', text: 'success' }],
          ...(mode === 'bad_shape' ? {} : { structuredContent: { value } }),
        };
      }
      return Response.json({ jsonrpc: '2.0', id: rpc.id, result });
    },
  });
  const lifecycle = createMcpLifecycle({
    servers: [{ id: 'local', transport: { type: 'http', url: network.url.href } }],
    transportPort: {
      async open(binding) {
        expect((await store.getExecution(binding.executionId))?.status).toBe('dispatching');
        let ended!: (value: { supervision: 'ended' }) => void;
        const stopped = new Promise<{ supervision: 'ended' }>((resolve) => {
          ended = resolve;
        });
        const transport = new StreamableHTTPClientTransport(network.url);
        return {
          transport,
          stopped,
          async stop() {
            await transport.close();
            ended({ supervision: 'ended' });
            return { status: 'stopped' };
          },
        };
      },
    },
  });
  const model: ModelAdapter = {
    async *stream() {
      const executions = await store.listExecutions('s');
      const runId = executions.find((entry) => entry.kind === 'model')!.runId!;
      const target = async () => {
        const entry = executions.filter((entry) => entry.definitionId === 'fixture.write').at(-1)!;
        return {
          executionId: entry.id,
          attempt: entry.attempt,
          definitionId: entry.definitionId,
          definitionVersion: entry.definitionVersion,
          inputDigest: Array.from(
            new Uint8Array(
              await crypto.subtle.digest(
                'SHA-256',
                new TextEncoder().encode(canonicalJson(entry.input)),
              ),
            ),
            (byte) => byte.toString(16).padStart(2, '0'),
          ).join(''),
          resultRevision: entry.resultRevision,
        };
      };
      const step = steps++;
      if (mode !== 'repair' && step >= 3) {
        yield finish;
        return;
      }
      yield* step === 0
        ? call('fixture.write', { value: 1 })
        : step === 1
          ? call('validation.define', {
              runId,
              checks: [
                {
                  kind: 'mcp',
                  checkerId: 'read',
                  input: {},
                  target: await target(),
                  schema: {
                    type: 'object',
                    required: ['value'],
                    properties: { value: { const: 2 } },
                    additionalProperties: false,
                  },
                },
              ],
            })
          : step === 2 || step === 5
            ? call('validation.check', { runId })
            : step === 3
              ? call('fixture.write', { value: 2 })
              : step === 4
                ? call('validation.rebind', {
                    runId,
                    expectedRevision: null,
                    bindings: [{ index: 0, target: await target() }],
                  })
                : [finish];
    },
  };
  const runtime = createRuntime({
    store,
    model,
    modelId: 'fixed',
    extensions: [
      lifecycle.extension,
      {
        id: 'fixture',
        version: '1',
        apiMajor: 1,
        tools: [
          {
            id: 'fixture.write',
            version: '1',
            description: 'Harmless actual source write',
            inputSchema: { type: 'object' },
            async execute(input) {
              value = (input as { value: number }).value;
              return { outcome: 'succeeded', content: 'source written' };
            },
          },
        ],
      },
    ],
    permissions: {
      async authorize() {
        return { allowed: true, revision: 'trusted-test' };
      },
    },
    async resolveRunConfiguration() {
      const capabilities = await lifecycle.readStepCapabilities({
        session: { id: 's' },
        command: { originStoreId: expectedStoreId },
      });
      const remote = capabilities.extensions![0]!.tools![0]!;
      const business = createPlanningValidation({
        requiredValidation: true,
        mcpCheckers: [
          {
            id: 'read',
            definitionId: remote.id,
            definitionVersion:
              mode === 'wrong_version' ? `${remote.version}-different` : remote.version,
            sourceDefinitionId: 'fixture.write',
            sourceDefinitionVersion: mode === 'wrong_source' ? '2' : '1',
          },
        ],
      });
      return {
        modelId: 'fixed',
        model,
        snapshot: {},
        extensions: [business.extension],
        conditions: business.conditions,
        initializeRequirements: business.initializeRequirements,
        readStepCapabilities: async () => {
          const current = await lifecycle.readStepCapabilities({
            session: { id: 's' },
            command: { originStoreId: expectedStoreId },
          });
          return {
            ...current,
            extensions: [business.extension, ...current.extensions],
            toolIds: [
              'fixture.write',
              ...business.extension.tools!.map((tool) => tool.id),
              ...current.toolIds,
            ],
          };
        },
      };
    },
  });
  const base = { expectedStoreId, sessionId: 's', subjectId: 'user' };
  try {
    await runtime.createWorkspace({
      expectedStoreId,
      id: 'w',
      rootUri: `file://${root}`,
      name: 'private',
    });
    await runtime.createSession({
      ...base,
      commandId: 'create',
      workspaceId: 'w',
      title: 'MCP proof',
    });
    await runtime.submitCommand({
      ...base,
      commandId: 'connect',
      request: {
        kind: 'extension.invoke',
        extensionId: lifecycle.extension.id,
        actionId: 'mcp.connect',
        definitionVersion: '1',
        input: { serverId: 'local', key: 'approved-connection' },
      },
    });
    await runtime.waitForCommand('connect', { timeoutMs: 5000 });
    expect(connections).toBe(1);
    expect(steps).toBe(0);
    await runtime.submitCommand({
      ...base,
      commandId: 'work',
      request: { kind: 'run.start', content: 'verify real source value' },
    });
    const completed = await runtime.waitForCommand('work', { timeoutMs: 10000 });
    expect((await store.getRun((completed.receipt as { runId: string }).runId))!.status).toBe(
      mode === 'repair' ? 'completed' : 'failed',
    );
    expect(calls).toBe(mode === 'repair' ? 2 : mode === 'bad_shape' ? 1 : 0);
    const records = await store.listExtensionRecords({
      sessionId: 's',
      extensionId: planningExtensionId,
    });
    const attempts = records.filter((entry) => entry.key.includes('/validation.attempt/'));
    expect(attempts).toHaveLength(mode === 'repair' ? 2 : 1);
    expect(
      attempts
        .map((entry) => (entry.value as { checks: { outcome: string }[] }).checks[0]!.outcome)
        .sort(),
    ).toEqual(mode === 'repair' ? ['failed', 'passed'] : ['inconclusive']);
    expect(records.filter((entry) => entry.key.endsWith('/validation.spec'))).toHaveLength(1);
    expect(records.filter((entry) => entry.key.includes('/validation.binding/'))).toHaveLength(
      mode === 'repair' ? 1 : 0,
    );
  } finally {
    await runtime.close();
    await lifecycle.close();
    network.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
}

test('actual MCP read-after-write uses exact cached definition and source receipt; failed schema proof is retained through same-spec repair', async () => {
  await mcpScenario('repair');
}, 20000);

test('actual MCP text success without structured result cannot pass; different checker or source version makes zero remote calls', async () => {
  await mcpScenario('bad_shape');
  await mcpScenario('wrong_version');
  await mcpScenario('wrong_source');
}, 20000);
