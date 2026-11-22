import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRuntime } from '@kite-ai/agent';
import { createArtifactStore } from '@kite-ai/agent/artifacts';
import type { Json } from '@kite-ai/agent/extensions';
import { createMcpLifecycle } from '@kite-ai/agent/mcp';
import { selectProfile } from '@kite-ai/agent/profile';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { privateDirectory } from '../../../../tests/fixtures/test-filesystem';
import { createMcpSourceConfiguration } from '../../src/mcp-source-configuration';

const name = 'owned-old';
const serverId = `mcp-${createHash('sha256').update(JSON.stringify({ name })).digest('hex')}`;
const marker = 'exact-owned-mcp-result';
const descriptor = {
  name: 'owned_echo',
  inputSchema: { type: 'object', additionalProperties: false },
  outputSchema: {
    type: 'object',
    required: ['marker'],
    properties: { marker: { const: marker } },
    additionalProperties: false,
  },
};

type Change =
  | 'none'
  | 'unrelated'
  | 'target'
  | 'disabled'
  | 'shadowed'
  | 'unreadable'
  | 'binding'
  | 'bad-output'
  | 'before-wire';

async function settleOwnedCall(change: Change) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-mcp-owned-receipt-')));
  const workspace = join(root, 'workspace');
  const profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'owned' });
  mkdirSync(workspace);
  privateDirectory(profile.profilePath);
  const file = join(profile.profilePath, 'mcp.json');
  // Declarations are processed by the real Service. The injected transport never starts them.
  const declaration = { type: 'stdio', command: process.execPath, cwd: workspace };
  const write = (servers: Record<string, unknown>) =>
    writeFileSync(file, JSON.stringify({ mcpServers: servers }), { mode: 0o600 });
  write({ [name]: declaration });
  const store = await openSqliteStore(profile);
  const expectedStoreId = (await store.getMetadata()).storeId;
  const scope = { expectedStoreId, sessionId: 'owned', subjectId: 'owner' };
  const commandId = 'owned-start';
  const permission = Promise.withResolvers<void>();
  const wireStarted = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let runtime: ReturnType<typeof createRuntime> | undefined;
  let disabled = false;
  let opens = 0;
  let calls = 0;
  let replies = 0;
  let captureInput!: Parameters<ReturnType<typeof createMcpSourceConfiguration>['capture']>[0];
  let currentSource:
    | Awaited<ReturnType<ReturnType<typeof createMcpSourceConfiguration>['sourcePort']['resolve']>>
    | undefined;
  const sources = createMcpSourceConfiguration({
    profile,
    runtime: () => runtime!,
    credentialVault: {
      async resolve() {
        throw Error('owned fixture unexpectedly resolved a credential');
      },
    },
    selection: () => ({
      present: false,
      configurations: [],
      disabledUserServerIds: disabled ? [serverId] : [],
    }),
    stdio: {
      guardianPath: join(root, 'never-executable-fixture.js'),
      bunExecutable: process.execPath,
    },
  });
  const lifecycle = createMcpLifecycle({
    servers: [],
    scopedSources: {
      ...sources.sourcePort,
      async resolve(input, options) {
        const resolved = await sources.sourcePort.resolve(input, options);
        currentSource = resolved;
        return {
          ...resolved,
          transportPort: {
            async open(binding) {
              expect(binding.serverId).toBe(serverId);
              opens++;
              const stopped = Promise.withResolvers<{ supervision: 'ended' }>();
              const transport: Transport = {
                async start() {},
                async close() {
                  transport.onclose?.();
                  stopped.resolve({ supervision: 'ended' });
                },
                async send(request) {
                  if (!('method' in request) || !('id' in request)) return;
                  if (request.method === 'tools/call') {
                    expect(request.params).toEqual({ name: descriptor.name, arguments: {} });
                    calls++;
                    wireStarted.resolve();
                    void release.promise.then(() => {
                      replies++;
                      transport.onmessage?.({
                        jsonrpc: '2.0',
                        id: request.id,
                        result: {
                          content: [{ type: 'text', text: marker }],
                          structuredContent: {
                            marker: change === 'bad-output' ? 'incorrect' : marker,
                          },
                        },
                      });
                    });
                    return;
                  }
                  expect(['initialize', 'tools/list']).toContain(request.method);
                  const result =
                    request.method === 'initialize'
                      ? {
                          protocolVersion: '2024-11-05',
                          serverInfo: { name: 'owned-in-process', version: '1' },
                          capabilities: { tools: {} },
                        }
                      : { tools: [descriptor] };
                  queueMicrotask(() =>
                    transport.onmessage?.({ jsonrpc: '2.0', id: request.id, result }),
                  );
                },
              };
              return {
                transport,
                stopped: stopped.promise,
                async stop() {
                  await transport.close();
                  return { status: 'stopped' };
                },
              };
            },
          },
        };
      },
    },
  });
  const continuation: string[] = [];
  let initialReadSet: unknown;
  try {
    runtime = createRuntime({
      store,
      artifacts: createArtifactStore({ profile, store }),
      extensions: [sources.extension, lifecycle.extension],
      permissions: {
        async authorize(request) {
          const business =
            request.kind === 'tool' && request.definitionId.startsWith(`mcp.${serverId}.`);
          if (change === 'before-wire' && business) {
            permission.resolve();
            await release.promise;
          }
          return {
            allowed:
              business ||
              request.kind === 'model' ||
              request.definitionId === 'mcp.connect' ||
              request.definitionId === 'mcp.source.connection',
            revision: 'exact-owned-receipt-fixture',
          };
        },
      },
      async resolveRunConfiguration(input) {
        captureInput = input;
        const capture = await sources.capture(input);
        const selected = sources.select(capture, { present: false, configurations: [] });
        expect(selected.snapshot.selection.serverIds).toEqual([serverId]);
        initialReadSet = selected.snapshot.readSet;
        const toolIds = ['mcp.connect', 'mcp.sources.list'];
        let step = 0;
        return {
          modelId: 'fixed',
          toolIds,
          snapshot: { mcp: { sources: selected.snapshot } } as unknown as Json,
          sources: selected.sources,
          async readStepCapabilities(input) {
            const value = await lifecycle.readStepCapabilities({
              ...input,
              selectedServerIds: selected.snapshot.selection.serverIds,
            });
            return { ...value, toolIds: [...toolIds, ...value.toolIds] };
          },
          model: {
            async *stream(request) {
              const usage = { inputTokens: 0, outputTokens: 0 };
              if (step++ === 0) {
                expect(request.tools.some((tool) => tool.id === 'connect_mcp_server')).toBe(true);
                yield {
                  type: 'tool_call',
                  id: 'original-connect',
                  name: 'connect_mcp_server',
                  arguments: JSON.stringify({ server_id: serverId }),
                };
              } else if (step === 2) {
                const tool = request.tools.find((entry) => /^mcp_.*owned_echo_/.test(entry.id));
                expect(tool).toBeDefined();
                yield {
                  type: 'tool_call',
                  id: 'original-business',
                  name: tool!.id,
                  arguments: '{}',
                };
              } else {
                continuation.push(
                  ...request.messages
                    .filter(
                      (message) =>
                        message.role === 'tool' && message.toolCallId === 'original-business',
                    )
                    .map((message) => message.content),
                );
                yield { type: 'text_delta', text: 'fixture complete' };
                yield { type: 'finish', reason: 'stop', usage };
                return;
              }
              yield { type: 'finish', reason: 'tool_calls', usage };
            },
          },
        };
      },
    });
    await runtime.createWorkspace({
      expectedStoreId,
      id: 'workspace',
      name: 'Owned',
      rootUri: pathToFileURL(workspace).href,
    });
    await runtime.createSession({
      ...scope,
      commandId: 'owned-session',
      workspaceId: 'workspace',
      title: 'Owned',
    });
    await runtime.submitCommand({
      ...scope,
      commandId,
      request: { kind: 'run.start', content: 'Run the owned test once.' },
    });
    const timeout = setTimeout(async () => {
      const evidence = (await store.listExecutions(scope.sessionId)).map(
        ({ kind, status, definitionId, result }) => ({ kind, status, definitionId, result }),
      );
      const error = Error(`owned fixture never reached its gate: ${JSON.stringify(evidence)}`);
      if (change === 'before-wire') permission.reject(error);
      else wireStarted.reject(error);
    }, 3000);
    await (change === 'before-wire' ? permission.promise : wireStarted.promise).finally(() =>
      clearTimeout(timeout),
    );
    const before = await sources.capture(captureInput);
    expect(initialReadSet).toEqual(before.readSet);
    expect(opens).toBe(1);
    expect(calls).toBe(change === 'before-wire' ? 0 : 1);
    expect(replies).toBe(0);
    if (change === 'unrelated' || change === 'before-wire' || change === 'disabled')
      write({ [name]: declaration, unrelated: declaration });
    else if (change === 'target') write({ [name]: { ...declaration, timeout: 5000 } });
    else if (change === 'unreadable') writeFileSync(file, '{');
    else if (change === 'binding')
      writeFileSync(join(profile.profilePath, 'mcp-auth-bindings.json'), '{}', { mode: 0o600 });
    else if (change === 'shadowed') {
      mkdirSync(join(workspace, '.kite-code'));
      writeFileSync(
        join(workspace, '.kite-code', 'mcp.json'),
        JSON.stringify({ mcpServers: { [name]: declaration } }),
      );
    }
    if (change === 'disabled') disabled = true;
    if (change === 'unrelated' || change === 'before-wire') {
      const after = await sources.capture(captureInput);
      expect(after.servers.find((entry) => entry.id === serverId)).toEqual(
        before.servers.find((entry) => entry.id === serverId),
      );
      expect(after.readSet.user.etag).not.toBe(before.readSet.user.etag);
      expect({
        ...after.readSet,
        user: { ...after.readSet.user, etag: before.readSet.user.etag },
      }).toEqual(before.readSet);
      expect(() => currentSource!.assertFresh({ signal: new AbortController().signal })).toThrow(
        'mcp_source_stale',
      );
    }
    release.resolve();
    const command = await runtime.waitForCommand(commandId, { timeoutMs: 3000 });
    const executions = await store.listExecutions(scope.sessionId);
    const tool = executions.filter(
      (entry) => entry.kind === 'tool' && entry.definitionId.startsWith(`mcp.${serverId}.`),
    );
    expect(tool).toHaveLength(1);
    expect(tool[0]!.runId).toBe((command.receipt as { runId: string }).runId);
    expect(opens).toBe(1);
    expect(calls).toBe(change === 'before-wire' ? 0 : 1);
    expect(replies).toBe(calls);
    expect((await store.getRun(tool[0]!.runId!))?.status).toBe('completed');
    expect((await store.getRun(tool[0]!.runId!))?.configuration).toMatchObject({
      snapshot: {
        mcp: { sources: { readSet: initialReadSet, selection: { serverIds: [serverId] } } },
      },
    });
    return { tool: tool[0]!, continuation };
  } finally {
    release.resolve();
    try {
      await (runtime?.close() ?? store.close());
    } finally {
      await lifecycle.close();
      rmSync(root, { recursive: true, force: true });
    }
  }
}

test.each([
  'none',
  'unrelated',
] as const)('published User STDIO Tool confirms its one original reply after %s, without rebinding the Run', async (change) => {
  const { tool, continuation } = await settleOwnedCall(change);
  expect(tool.status).toBe('succeeded');
  expect((tool.result as { details: unknown }).details).toMatchObject({
    structuredContent: { marker },
  });
  expect(continuation).toHaveLength(1);
  expect(continuation[0]).toContain(marker);
}, 10000);

test.each([
  'target',
  'disabled',
  'shadowed',
  'unreadable',
  'binding',
  'bad-output',
] as const)('published User STDIO Tool cannot confirm a reply with %s', async (change) => {
  const { tool, continuation } = await settleOwnedCall(change);
  expect(tool.status).toBe('outcome_unknown');
  expect(tool.result).toMatchObject({
    details: { code: change === 'bad-output' ? 'mcp_output_invalid' : 'mcp_call_unconfirmed' },
  });
  expect(continuation).toHaveLength(1);
  if (change !== 'bad-output') expect(continuation[0]).not.toContain(marker);
}, 10000);

test('an unrelated save before permission finishes still denies stale business dispatch with zero wire', async () => {
  const { tool, continuation } = await settleOwnedCall('before-wire');
  expect(tool.status).toBe('failed');
  expect(continuation).toHaveLength(1);
  expect(continuation[0]).not.toContain(marker);
}, 10000);
