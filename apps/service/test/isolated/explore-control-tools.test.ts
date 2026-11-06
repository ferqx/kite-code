import { expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRuntime } from '@kite-ai/agent';
import { createArtifactStore } from '@kite-ai/agent/artifacts';
import { createTemporaryCredentialBackend } from '@kite-ai/agent/config';
import { selectProfile } from '@kite-ai/agent/profile';
import { createWorkspaceSerialLocks } from '@kite-ai/agent/resources';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import type { ModelAdapter, ModelEvent, ModelRequest } from '@kite-ai/ai';
import { windowsShellFixture } from '../../../../packages/agent/test/fixtures/windows-shell-runtime';
import {
  privateDirectory,
  removeTemporaryDirectory,
  temporaryDirectory,
} from '../../../../tests/fixtures/test-filesystem';
import { parseShellModelFeedback } from '../../../../tests/fixtures/unified-agent/shell-model-feedback';
import { startService } from '../../src';
import { createDefaultProcessConfiguration } from '../../src/configuration';
import { initializeLivePermissionFixture } from '../fixtures/live-permission-fixture';

const finish: ModelEvent = {
  type: 'finish',
  reason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1 },
};
const call = (name: string, input: object): ModelEvent[] => [
  { type: 'tool_call', id: crypto.randomUUID(), name, arguments: JSON.stringify(input) },
  { type: 'finish', reason: 'tool_calls', usage: { inputTokens: 1, outputTokens: 1 } },
];
async function until<T>(read: () => Promise<T | undefined>) {
  const deadline = Date.now() + 12000;
  for (;;) {
    const result = await read();
    if (result !== undefined) return result;
    if (Date.now() > deadline) throw Error('explore_control_deadline');
    await Bun.sleep(10);
  }
}

async function scenario(options: { networkOff?: boolean; shell?: boolean } = {}) {
  const root = temporaryDirectory('kite-explore-control-');
  const workspace = join(root, 'workspace');
  const control = join(root, 'control');
  const profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'test' });
  privateDirectory(workspace);
  privateDirectory(control);
  privateDirectory(profile.profilePath);
  const configPath = join(profile.profilePath, 'config.jsonc');
  const toolIds = [
    'task.spawn',
    'task.message',
    'task.events',
    'execution_evidence.read',
    ...(options.shell
      ? ['shell.execute', 'shell.stop', 'shell.read', 'shell.wait']
      : ['web_fetch']),
  ];
  writeFileSync(
    configPath,
    JSON.stringify({
      modelId: 'fixed',
      models: [
        {
          id: 'fixed',
          provider: 'compatible',
          model: 'unused-controlled-model',
          baseURL: 'http://127.0.0.1:9/v1',
        },
      ],
      tools: toolIds.map((id) => ({ id })),
    }),
  );
  let dns = 0;
  const webRequests: string[] = [];
  // This owned loopback server is the Web destination, never a Model provider.
  // Keep the real URL, DNS-pinning, admission and ordinary Tool permission path.
  const web = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      webRequests.push(path);
      return new Response(path === '/robots.txt' ? 'User-agent: *' : 'explore-approved-web-body', {
        headers: { 'content-type': 'text/plain' },
      });
    },
  });
  let runtime: ReturnType<typeof createRuntime> | undefined;
  let service: Awaited<ReturnType<typeof startService>> | undefined;
  let store: Awaited<ReturnType<typeof openSqliteStore>> | undefined;
  let workspaceSerialLocks: ReturnType<typeof createWorkspaceSerialLocks> | undefined;
  try {
    const assets = options.shell ? await windowsShellFixture() : undefined;
    const host = createDefaultProcessConfiguration({
      profile,
      userConfigurationPath: configPath,
      localCodex: false,
      browser: false,
      credentialBackend: createTemporaryCredentialBackend(),
      ...(assets
        ? {
            shell: {
              platform: 'win32' as const,
              configurationId: 'explore-control-native',
              env: Object.fromEntries(
                Object.entries(process.env).filter(
                  (entry): entry is [string, string] =>
                    typeof entry[1] === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(entry[0]),
                ),
              ),
              supervisorPath: assets.runner,
              bunExecutable: process.execPath,
              shellExecutable: assets.shell,
              windows: {
                coreutilsPath: assets.coreutils,
                fullShellExecutable: assets.fullShell,
                stateRoot: assets.stateRoot,
              },
              host: {
                controlBase: control,
                protectedRoots: [profile.dataRoot, control],
                readonlyAssets: [],
                runtimeReadOnlyRoots: [],
              },
            },
          }
        : {}),
      webFetch: {
        network: {
          policy: options.networkOff
            ? { mode: 'off' }
            : { mode: 'allowlist', hosts: ['explore.fixture.test'] },
          allowLoopbackForTests: true,
          resolveAddresses: async () => {
            dns++;
            return [{ address: '127.0.0.1', family: 4 }];
          },
          admitHop: async () => ({ allowed: true, revision: 'owned-explore-web-destination' }),
        },
      },
    });
    store = await openSqliteStore(profile);
    const activeStore = store;
    const expectedStoreId = (await store.getMetadata()).storeId;
    const childRequests: ModelRequest[] = [];
    const parentRequests: ModelRequest[] = [];
    let parentStep = 0;
    let childStep = 0;
    let parentCursor = '0';
    const message = 'EXACT_EXPLORE_PARENT_MESSAGE';
    const parent: ModelAdapter = {
      async *stream(request) {
        parentRequests.push(request);
        const last = request.messages.filter((message) => message.role === 'tool').at(-1);
        if (last) {
          const feedback = JSON.parse(last.content) as { next_seq?: string };
          if (typeof feedback.next_seq === 'string') parentCursor = feedback.next_seq;
        }
        if (parentStep++ === 0)
          yield* call('spawn_agent', {
            preset: 'explore',
            prompt:
              'Read the task evidence, send the parent the exact report, and use the selected tools.',
          });
        else {
          const executions = await activeStore.listExecutions('s');
          const child = executions.find((execution) => execution.definitionId === 'agent/explore');
          if (
            executions.some(
              (execution) =>
                execution.definitionId === 'task.spawn' && execution.status === 'failed',
            ) ||
            (child &&
              ['succeeded', 'failed', 'cancelled', 'outcome_unknown'].includes(child.status))
          )
            yield finish;
          else yield* call('wait_agent_events', { wait_ms: 100, after_seq: parentCursor });
        }
      },
    };
    const child: ModelAdapter = {
      async *stream(request) {
        childRequests.push(request);
        if (childStep++ === 0)
          yield* call('send_agent_message', { target: 'parent', content: message });
        else if (childStep === 2) yield* call('read_execution_evidence', { limit: 10 });
        else if (childStep === 3)
          yield* options.shell
            ? call('shell_execute', {
                command: 'printf explore-shell-ready; sleep 30',
                background: true,
              })
            : call('web_fetch', { url: `http://explore.fixture.test:${web.port}/page` });
        else if (options.shell && childStep === 4) {
          const last = request.messages.filter((item) => item.role === 'tool').at(-1)!;
          const { shellId } = parseShellModelFeedback(last.content);
          const carrier = (await activeStore.listExecutions('s')).find(
            (execution) => execution.definitionId === 'agent/explore',
          )!;
          await until(async () => {
            const job = (await activeStore.listExecutions(carrier.childSessionId!)).find(
              (execution) => execution.definitionId === 'shell.command',
            );
            if (job?.status !== 'running') return undefined;
            const output = await activeStore.listExecutionOutput({
              executionId: job.id,
              afterSeq: '0',
              limit: 20,
            });
            return output.items.some((item) => item.content.includes('explore-shell-ready'))
              ? job
              : undefined;
          });
          yield* call('shell_stop', {
            shell_id: shellId,
            command_id: 'stop-exact-explore-command',
          });
        } else yield finish;
      },
    };
    workspaceSerialLocks = createWorkspaceSerialLocks(profile);
    host.bindWorkspaceSerialLocks?.(workspaceSerialLocks);
    runtime = createRuntime({
      ...host,
      store,
      permissions: host.permissions!,
      workspaceSerialLocks,
      artifacts: createArtifactStore({ profile, store }),
      resolveRunConfiguration: async (input) => ({
        ...(await host.resolveRunConfiguration!(input)),
        model: parent,
      }),
      resolveChildRunConfiguration: async (input) => ({
        ...(await host.resolveChildRunConfiguration!(input)),
        model: child,
      }),
    });
    service = await startService({
      runtime,
      permissionManagement: host.permissionManagement!(runtime),
      subjectId: 'owner',
      buildId: 'explore-control-tools',
      profile: {
        dataRoot: profile.dataRoot,
        name: profile.profile,
        accessKey: profile.profileAccessKey,
      },
    });
    await runtime.createWorkspace({
      expectedStoreId,
      id: 'w',
      name: 'owned workspace',
      rootUri: pathToFileURL(workspace).href,
    });
    await runtime.createSession({
      expectedStoreId,
      subjectId: 'owner',
      commandId: 'create',
      sessionId: 's',
      workspaceId: 'w',
      title: 'explore controls',
    });
    await initializeLivePermissionFixture({
      runtime,
      profile,
      expectedStoreId,
      sessionId: 's',
      subjectId: 'owner',
      workspaceId: 'w',
      mode: 'full',
      trusted: true,
    });
    await runtime.submitCommand({
      expectedStoreId,
      subjectId: 'owner',
      commandId: 'work',
      sessionId: 's',
      request: { kind: 'run.start', content: 'Delegate the permitted investigation to explore.' },
    });
    try {
      await runtime.waitForCommand('work', { timeoutMs: 15000 });
    } catch (error) {
      const states = [];
      for (const session of await activeStore.listSessions())
        states.push({
          id: session.id,
          executions: (await activeStore.listExecutions(session.id))
            .filter((execution) => execution.kind !== 'model')
            .slice(-5)
            .map(({ definitionId, status, result }) => ({
              definitionId,
              status,
              result: JSON.stringify(result).slice(0, 600),
            })),
          interactions: (
            await activeStore.listInteractions({
              expectedStoreId,
              sessionId: session.id,
              state: 'pending',
            })
          ).interactions.map(({ definitionId }) => definitionId),
        });
      throw new Error(`explore_control_incomplete:${JSON.stringify(states)}`, { cause: error });
    }
    const carrier = await until(async () =>
      (await activeStore.listExecutions('s')).find(
        (execution) =>
          execution.definitionId === 'agent/explore' && execution.status === 'succeeded',
      ),
    );
    const childID = carrier.childSessionId!;
    await runtime.waitForCommand(`child-start-${carrier.id}`, { timeoutMs: 5000 });
    const executions = await activeStore.listExecutions(childID);
    for (const definitionId of ['task.message', 'execution_evidence.read'])
      expect(executions.find((execution) => execution.definitionId === definitionId)).toMatchObject(
        {
          status: 'succeeded',
          authorization: { dispatched: true },
        },
      );
    expect(JSON.stringify(parentRequests)).toContain(message);
    expect(parentRequests[0]!.tools.map((tool) => tool.id)).toContain('wait_agent_events');
    expect(executions.some((execution) => execution.definitionId === 'task.events')).toBe(false);
    expect(
      JSON.parse(childRequests[1]!.messages.filter((item) => item.role === 'tool').at(-1)!.content),
    ).toEqual({ accepted: true, delivery: 'queued' });
    const evidence = childRequests
      .flatMap((request) => request.messages)
      .find(
        (message) =>
          message.role === 'tool' && message.content.includes('Recorded execution evidence,'),
      );
    expect(evidence).toBeDefined();
    expect(JSON.parse(evidence!.content)).toMatchObject({
      items: [{ tool: 'task.message', status: 'succeeded' }],
      complete: true,
    });
    expect(childRequests.length).toBeGreaterThanOrEqual(4);
    for (const request of childRequests) {
      const names = request.tools.map((tool) => tool.id);
      for (const name of ['send_agent_message', 'read_execution_evidence'])
        expect(names).toContain(name);
      for (const name of [
        'spawn_agent',
        'wait_agent_events',
        'ask_user',
        'write_file',
        'edit_file',
        'list_agents',
      ])
        expect(names).not.toContain(name);
    }
    expect((await activeStore.getSession(childID))?.workspaceId).toBe('w');
    if (options.shell) {
      expect(
        executions.filter((execution) => execution.definitionId === 'shell.command'),
      ).toMatchObject([{ status: 'cancelled', result: { details: { processTreeStopped: true } } }]);
      expect(executions.find((execution) => execution.definitionId === 'shell.stop')).toMatchObject(
        {
          status: 'succeeded',
          authorization: { dispatched: true },
        },
      );
      expect(childRequests[0]!.tools.map((tool) => tool.id)).toContain('shell_stop');
    } else if (options.networkOff) {
      expect(executions.find((execution) => execution.definitionId === 'web_fetch')).toMatchObject({
        status: 'failed',
        authorization: { dispatched: false },
      });
      expect(dns).toBe(0);
      expect(webRequests).toEqual([]);
    } else {
      expect(executions.find((execution) => execution.definitionId === 'web_fetch')).toMatchObject({
        status: 'succeeded',
        authorization: { dispatched: true },
      });
      expect(dns).toBeGreaterThan(0);
      expect(webRequests).toEqual(['/robots.txt', '/page']);
      expect(JSON.stringify(childRequests)).toContain('explore-approved-web-body');
    }
  } finally {
    if (service) await service.close();
    else if (runtime) await runtime.close();
    else await store?.close();
    await workspaceSerialLocks?.close();
    await web.stop(true);
    removeTemporaryDirectory(root);
  }
}

test(
  'default explore continues after the send acknowledgment without a wait tool, reads evidence and fetches allowed Web content',
  () => scenario(),
  20000,
);
test(
  'explore Web selection preserves the inherited network-off hard gate with zero DNS or requests',
  () => scenario({ networkOff: true }),
  20000,
);
test.skipIf(process.platform !== 'win32')(
  'default explore stops its one original native background Shell by the returned handle',
  () => scenario({ shell: true }),
  25000,
);
