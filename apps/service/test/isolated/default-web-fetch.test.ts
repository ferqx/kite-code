import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRuntime } from '@kite-ai/agent';
import { createArtifactStore } from '@kite-ai/agent/artifacts';
import { selectProfile } from '@kite-ai/agent/profile';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { createClient } from '@kite-ai/client';
import { privateDirectory } from '../../../../tests/fixtures/test-filesystem';
import { startService } from '../../src';
import { createDefaultProcessConfiguration } from '../../src/configuration';
import { createPermissionManagement } from '../../src/permission-management';

const fullBody = `complete-default-web-BEGIN\n${'actual public Tool body. '.repeat(5000)}\ncomplete-default-web-END`;
async function fixture(off = false) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-default-web-')));
  const workspace = join(root, 'workspace');
  mkdirSync(workspace);
  const profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'new' });
  privateDirectory(profile.profilePath);
  const store = await openSqliteStore({ dataRoot: profile.dataRoot, profile: profile.profile });
  const expectedStoreId = (await store.getMetadata()).storeId;
  const webRequests: string[] = [];
  const wireAudits: boolean[] = [];
  const admissions: { allowed: boolean; revision: string }[] = [];
  let dns = 0,
    admitted = true;
  const web = createServer(async (request, response) => {
    webRequests.push(`${request.headers.host}${request.url}`);
    const audit = await store.listExtensionRecords({
      extensionId: 'builtin.web',
      sessionId: 's',
      limit: 200,
    });
    wireAudits.push(audit.length >= webRequests.length);
    if (request.url === '/robots.txt') {
      response.end('User-agent: *');
      return;
    }
    if (request.url === '/redirect') {
      response.writeHead(302, { location: '/second' }).end();
      return;
    }
    if (request.url === '/second') {
      response.writeHead(307, { location: '/complete?unlogged-query=secret-fixture' }).end();
      return;
    }
    if (request.url === '/policy-escape') {
      response
        .writeHead(302, { location: `http://added-after-capture.test:${webPort}/complete` })
        .end();
      return;
    }
    response.writeHead(200, { 'content-type': 'text/plain' }).end(fullBody);
  });
  await new Promise<void>((resolve) => web.listen(0, '127.0.0.1', resolve));
  const webPort = (web.address() as { port: number }).port;
  const url = `http://fixture.test:${webPort}`;
  let target = `${url}/redirect`;
  let currentInput = 'work-1';
  const requests: {
    messages: { role: string; content: string }[];
    tools?: { function: { name: string } }[];
  }[] = [];
  const provider = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as (typeof requests)[number];
      requests.push(body);
      const last = body.messages.reduce(
        (index, message, i) =>
          message.role === 'user' && message.content === currentInput ? i : index,
        -1,
      );
      const hasResult = body.messages.slice(last + 1).some((message) => message.role === 'tool');
      const chunk = (delta: unknown, reason: string | null) =>
        `data: ${JSON.stringify({ id: 'local-web', object: 'chat.completion.chunk', created: 1, model: 'local', choices: [{ index: 0, delta, finish_reason: reason }] })}\n\n`;
      return new Response(
        chunk(
          hasResult
            ? { content: 'saved Web facts' }
            : {
                tool_calls: [
                  {
                    index: 0,
                    id: `call-${requests.length}`,
                    type: 'function',
                    function: { name: 'web_fetch', arguments: JSON.stringify({ url: target }) },
                  },
                ],
              },
          null,
        ) +
          chunk({}, hasResult ? 'stop' : 'tool_calls') +
          'data: [DONE]\n\n',
        { headers: { 'content-type': 'text/event-stream' } },
      );
    },
  });
  const configuration: { modelId: string; models: unknown[]; tools: Record<string, unknown>[] } = {
    modelId: 'local',
    models: [
      {
        id: 'local',
        provider: 'compatible',
        model: 'local',
        baseURL: `http://127.0.0.1:${provider.port}/v1`,
      },
    ],
    tools: [{ id: 'web_fetch', definitionVersion: '1' }],
  };
  const configPath = join(profile.profilePath, 'config.jsonc');
  const save = () => writeFileSync(configPath, JSON.stringify(configuration));
  save();
  const policy = off
    ? { mode: 'off' as const }
    : { mode: 'allowlist' as const, hosts: ['fixture.test'] };
  const host = createDefaultProcessConfiguration({
    userConfigurationPath: `${profile.profilePath}/config.jsonc`,
    profile,
    webFetch: {
      network: {
        policy,
        allowLoopbackForTests: true,
        resolveAddresses: async () => {
          dns++;
          return [{ address: '127.0.0.1', family: 4 }];
        },
        admitHop: async () => {
          const decision = {
            allowed: admitted,
            revision: admitted ? 'resources-current-1' : 'resources-revoked-2',
          };
          admissions.push(decision);
          return decision;
        },
      },
    },
    permissions: {
      authorize: async () => ({
        allowed: true,
        revision: 'explicit-current-tool-and-model-permission',
      }),
    },
  });
  const runtime = createRuntime({
    store,
    artifacts: createArtifactStore({ profile, store }),
    permissions: host.permissions!,
    extensions: host.extensions,
    resolveRunConfiguration: host.resolveRunConfiguration,
  });
  host.permissionManagement?.(runtime);
  const serverProfile = {
    dataRoot: profile.dataRoot,
    name: profile.profile,
    accessKey: profile.profileAccessKey,
  };
  const service = await startService({
    runtime,
    profile: serverProfile,
    subjectId: 'owner',
    buildId: 'default-web-test',
  });
  const client = createClient({
    endpoint: service.endpoint,
    token: service.bootstrap.token,
    bootstrap: service.bootstrap,
    expected: {
      profile: serverProfile,
      apiMajor: 1,
      requiredCapabilities: ['commands', 'sessions'],
    },
  });
  await client.connect();
  await client.createWorkspace({
    expectedStoreId,
    id: 'w',
    rootUri: pathToFileURL(workspace).href,
    name: 'temporary',
  });
  await client.createSession({
    expectedStoreId,
    commandId: 'create',
    sessionId: 's',
    workspaceId: 'w',
    title: 'default Web',
  });
  const controls = createPermissionManagement({ runtime, profile });
  const scope = { expectedStoreId, subjectId: 'owner' };
  const mode = await controls.readMode({ ...scope, sessionId: 's' });
  expect(
    (
      await controls.setMode({
        ...scope,
        sessionId: 's',
        commandId: 'fixture-mode',
        mode: 'full',
        ifRevision: mode.revision,
        ifDefaultRevision: mode.defaultRevision,
        makeDefault: false,
      })
    ).state,
  ).toBe('applied');
  const trust = await controls.readTrust({ ...scope, workspaceId: 'w' });
  expect(
    (
      await controls.setTrust({
        ...scope,
        workspaceId: 'w',
        commandId: 'fixture-trust',
        trusted: true,
        ifRevision: trust.revision,
        canonicalIdentity: trust.canonicalIdentity,
        externalReadScopeDigest: trust.externalReadScopeDigest,
      })
    ).state,
  ).toBe('applied');
  const currentMode = await controls.readMode({ ...scope, sessionId: 's' });
  const currentTrust = await controls.readTrust({ ...scope, workspaceId: 'w' });
  expect(currentMode).toMatchObject({ mode: 'full', scopeSessionId: 's' });
  expect(currentMode.revision).not.toBe(mode.revision);
  expect(currentTrust.trusted).toBe(true);
  expect(currentTrust.revision).not.toBe(trust.revision);
  let id = 0;
  return {
    root,
    store,
    runtime,
    client,
    policy,
    configuration,
    save,
    requests,
    webRequests,
    wireAudits,
    admissions,
    expectedStoreId,
    counts: () => ({ dns, network: webRequests.length, provider: requests.length }),
    setAdmitted: (value: boolean) => {
      admitted = value;
    },
    async run(path = '/redirect') {
      target = url + path;
      const commandId = `work-${++id}`;
      currentInput = id === 1 ? commandId : `New task: ${commandId}`;
      await client.startRun('s', {
        expectedStoreId,
        commandId,
        kind: 'run.start',
        content: currentInput,
      });
      const command = await runtime.waitForCommand(commandId, { timeoutMs: 8000 });
      const publicCommand = await client.getCommand(commandId);
      const receipt = command.receipt as {
        runId?: string;
        businessCommandId?: string;
        humanInputCommandId?: string;
      } | null;
      const businessId = receipt?.businessCommandId ?? commandId;
      const execution = (await store.listExecutions('s', 200)).find(
        (row) => row.kind === 'tool' && row.originCommandId === businessId,
      );
      if (receipt?.runId) {
        const run = await store.getRun(receipt.runId);
        expect(run).toMatchObject({ originCommandId: businessId, rootWorkCommandId: commandId });
        const models = (await store.listExecutions('s', 200)).filter(
          (row) => row.kind === 'model' && row.runId === receipt.runId,
        );
        expect(models).toHaveLength(2);
        const input = await runtime.readModelInput({
          expectedStoreId,
          sessionId: 's',
          subjectId: 'owner',
          executionId: models[0]!.id,
        });
        expect(input.confirmation).toBe('succeeded');
        expect(
          input.request.messages.find((message) => message.sourceIds?.includes(businessId)),
        ).toMatchObject({ content: currentInput, sourceIds: [businessId] });
        if (id > 1) {
          expect(command.status).toBe('applied');
          expect(businessId).toBe(commandId);
          expect(receipt).not.toHaveProperty('humanInputCommandId');
          expect(command.request).toMatchObject({ content: currentInput });
          expect(await store.getCommand(commandId)).toMatchObject({
            status: 'applied',
            receipt: { runId: run!.id },
          });
        }
      }
      return {
        command,
        publicCommand,
        execution,
        run: receipt?.runId ? await client.getRun(receipt.runId) : null,
      };
    },
    async close() {
      await service.close();
      provider.stop(true);
      web.closeAllConnections();
      await new Promise<void>((resolve) => web.close(() => resolve()));
      rmSync(root, { recursive: true, force: true });
    },
  };
}
test('default Service Web selection uses ordinary Tool, complete scoped Artifact and captured host policy; reads create no effects', async () => {
  const f = await fixture();
  try {
    expect(f.counts()).toEqual({ dns: 0, network: 0, provider: 0 });
    if (f.policy.mode === 'allowlist') f.policy.hosts.push('added-after-capture.test');
    const result = await f.run();
    expect(result.execution?.status).toBe('succeeded');
    expect(f.webRequests).toHaveLength(4);
    expect(f.wireAudits).toEqual([true, true, true, true]);
    expect(f.requests[0]?.tools?.some((tool) => tool.function.name === 'web_fetch')).toBe(true);
    expect(
      f.requests[1]?.messages
        .slice()
        .reverse()
        .find((message) => message.role === 'tool')?.content,
    ).toContain(`Complete artifact body:\n${fullBody}`);
    const artifact = (
      result.execution?.result as {
        artifactRefs: { id: string; scope: { kind: 'execution'; id: string } }[];
      }
    ).artifactRefs[0]!;
    expect(artifact.scope).toEqual({ kind: 'execution', id: result.execution!.id });
    const before = f.counts();
    const cursorBeforeRead = (await f.store.getMetadata()).lastChangeCursor;
    const binary = await f.client.readArtifact('s', {
      expectedStoreId: f.expectedStoreId,
      refId: artifact.id,
      scope: artifact.scope,
    });
    expect(new TextDecoder().decode(binary.content)).toBe(fullBody);
    await f.client.getView('s');
    await f.client.getExecution(result.execution!.id);
    expect(f.counts()).toEqual(before);
    expect((await f.store.getMetadata()).lastChangeCursor).toBe(cursorBeforeRead);
    const audit = await f.store.listExtensionRecords({
      extensionId: 'builtin.web',
      sessionId: 's',
      limit: 200,
    });
    expect(JSON.stringify(audit)).not.toContain('unlogged-query');
    expect(
      (result.run?.configuration as { snapshot: { web: { policy: unknown } } }).snapshot.web.policy,
    ).toEqual({
      mode: 'allowlist',
      hosts: ['fixture.test'],
    });
    const facts = JSON.stringify(result.run?.configuration);
    expect(facts).toContain('web_fetch');
    expect(facts).not.toContain('added-after-capture.test');
    const deniedRedirect = await f.run('/policy-escape');
    expect((deniedRedirect.execution?.result as { content?: string })?.content).toBe(
      'web_network_denied',
    );
    expect(f.webRequests.some((value) => value.startsWith('added-after-capture.test'))).toBe(false);
    expect(f.requests).toHaveLength(4);
    const tools = (await f.store.listExecutions('s')).filter(
      (execution) => execution.kind === 'tool',
    );
    expect(tools).toHaveLength(2);
    expect(tools.map((execution) => execution.id)).toEqual([
      result.execution!.id,
      deniedRedirect.execution!.id,
    ]);
  } finally {
    await f.close();
  }
}, 20000);
test('default Web off and current host admission withdrawal fail without any page or robots socket', async () => {
  for (const off of [true, false]) {
    const f = await fixture(off);
    try {
      if (!off) f.setAdmitted(false);
      const result = await f.run();
      expect(result.execution?.status).toBe('failed');
      if (off) {
        expect(result.execution?.result).toMatchObject({
          outcome: 'failed',
          content: 'permission_denied',
          details: {
            reason: 'capability_unavailable',
            adapterAttempted: false,
            dispatchCommitted: false,
          },
        });
        expect(result.execution?.authorization?.dispatched).toBe(false);
        expect(f.admissions).toEqual([]);
      } else {
        expect((result.execution?.result as { content?: string })?.content).toBe(
          'web_network_denied',
        );
        expect(result.execution?.authorization?.dispatched).toBe(true);
        expect(f.admissions).toEqual([
          { allowed: false, revision: 'resources-revoked-2' },
          { allowed: false, revision: 'resources-revoked-2' },
        ]);
      }
      expect(f.counts().network).toBe(0);
      expect(f.counts().dns).toBe(0);
      expect(f.counts().provider).toBeGreaterThan(0);
    } finally {
      await f.close();
    }
  }
}, 20000);
test('JSONC cannot set Web resource options or stale definition versions; failures precede Provider dispatch', async () => {
  const f = await fixture();
  try {
    for (const tool of [
      {
        id: 'web_fetch',
        definitionVersion: '1',
        options: { network: { mode: 'public' }, allowLoopbackForTests: true },
      },
      { id: 'web_fetch', definitionVersion: 'incorrect' },
    ]) {
      f.configuration.tools = [tool];
      f.save();
      const result = await f.run();
      expect(result.command.status).toBe('rejected');
      expect(f.counts()).toEqual({ dns: 0, network: 0, provider: 0 });
      expect(result.execution).toBeUndefined();
      expect(JSON.stringify(result.publicCommand.receipt)).toContain(
        tool.definitionVersion === 'incorrect'
          ? 'tool_definition_version_unavailable'
          : 'unsupported_tool_options',
      );
    }
  } finally {
    await f.close();
  }
}, 15000);
