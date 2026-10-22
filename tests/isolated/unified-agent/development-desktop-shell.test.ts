import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { selectProfile } from '@kite-ai/agent/profile';
import { launchPairedService } from '@kite-ai/service/paired';
import { ownedUserConfiguration } from '../../../apps/service/test/fixtures/user-configuration-fixture';
import { buildDevelopmentService } from '../../../scripts/development/desktop-reload';

const repository = realpathSync(join(import.meta.dir, '../../..'));
const nativeTest = process.platform === 'darwin' ? test : test.skip;
const shellNames = ['shell_execute', 'shell_launch', 'shell_read', 'shell_wait', 'shell_stop'];

nativeTest(
  'actual Desktop development Service supplies and executes Shell for the root and existing default/code child roles',
  async () => {
    const cache = join(repository, '.cache');
    mkdirSync(cache, { recursive: true });
    const root = realpathSync(mkdtempSync(join(cache, 'development-shell-')));
    const workspace = join(root, 'workspace');
    mkdirSync(workspace);
    const user = ownedUserConfiguration(join(root, 'home'));
    const profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'development' });
    const requests: {
      marker: string;
      names: string[];
      results: string[];
    }[] = [];
    const issued = new Set<string>();
    const provider = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        const body = (await request.json()) as {
          messages: { role: string; content: string | null }[];
          tools?: { function: { name: string } }[];
        };
        const names = body.tools?.map((tool) => tool.function.name) ?? [];
        const content =
          body.messages.find(
            (row) =>
              row.role === 'user' &&
              /DEV_SHELL_(PARENT|CHILD_DEFAULT|CHILD_CODE)/.test(row.content ?? ''),
          )?.content ?? '';
        const marker = content.includes('DEV_SHELL_CHILD_CODE')
          ? 'DEV_SHELL_CHILD_CODE'
          : content.includes('DEV_SHELL_CHILD_DEFAULT')
            ? 'DEV_SHELL_CHILD_DEFAULT'
            : 'DEV_SHELL_PARENT';
        const results = body.messages
          .filter((row) => row.role === 'tool')
          .map((row) => row.content ?? '');
        if (names.length) requests.push({ marker, names, results });
        const calls: { name: string; input: unknown }[] = [];
        if (names.length && !results.length && !issued.has(marker)) {
          issued.add(marker);
          if (marker === 'DEV_SHELL_PARENT')
            calls.push(
              { name: 'spawn_agent', input: { prompt: 'DEV_SHELL_CHILD_DEFAULT' } },
              {
                name: 'spawn_agent',
                input: { prompt: 'DEV_SHELL_CHILD_CODE', preset: 'code' },
              },
            );
          calls.push({
            name: 'shell_execute',
            input: { key: marker, command: `printf '${marker}_EXECUTED\\n'` },
          });
        }
        const frame = (delta: unknown, finish_reason: string | null) =>
          `data: ${JSON.stringify({ id: 'development-shell', object: 'chat.completion.chunk', model: 'fixture', choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
        return new Response(
          frame(
            calls.length
              ? {
                  tool_calls: calls.map((call, index) => ({
                    index,
                    id: `call-${marker}-${index}`,
                    type: 'function',
                    function: { name: call.name, arguments: JSON.stringify(call.input) },
                  })),
                }
              : { content: names.length ? `${marker}_DONE` : 'Development Shell' },
            null,
          ) +
            frame({}, calls.length ? 'tool_calls' : 'stop') +
            'data: [DONE]\n\n',
          { headers: { 'content-type': 'text/event-stream' } },
        );
      },
    });
    let service: Awaited<ReturnType<typeof launchPairedService>> | undefined;
    try {
      writeFileSync(
        user.path,
        JSON.stringify({
          modelId: 'local',
          models: [
            {
              id: 'local',
              provider: 'compatible',
              model: 'fixture',
              baseURL: `${provider.url.href}v1`,
            },
          ],
        }),
        { mode: 0o600 },
      );
      // Use the ordinary development builder and process entry, without host/tool/policy injection.
      const app = join(root, 'app');
      const built = await buildDevelopmentService(repository, app);
      service = await launchPairedService({
        entrypoint: join(app, 'services', built.id, 'main.js'),
        executable: realpathSync(process.execPath),
        buildId: `development-${built.sha256}`,
        instanceId: 'development-shell',
        apiMajor: 1,
        profile,
        spawnChild: user.spawnChild,
        requiredCapabilities: ['commands', 'permission_controls', 'host_status'],
      });
      const client = service.client;
      const expectedStoreId = service.bootstrap.storeId!;
      expect((await client.getHostStatus()).execution.shell).toMatchObject({
        configured: true,
        available: true,
        supervision: 'macos_coalition',
        reason: null,
      });
      await client.createWorkspace({
        expectedStoreId,
        id: 'w',
        name: 'development-shell',
        rootUri: pathToFileURL(workspace).href,
      });
      await client.createSession({
        expectedStoreId,
        commandId: 'create',
        sessionId: 's',
        workspaceId: 'w',
        title: 'Development Shell',
      });
      const mode = await client.getPermissionMode('s', { storeId: expectedStoreId });
      await client.setPermissionMode('s', {
        expectedStoreId,
        commandId: 'full',
        mode: 'full',
        makeDefault: false,
        ifRevision: mode.revision,
        ifDefaultRevision: mode.defaultRevision,
      });
      const trust = await client.getWorkspaceTrust('w', { storeId: expectedStoreId });
      await client.setWorkspaceTrust('w', {
        expectedStoreId,
        commandId: 'trust',
        trusted: true,
        canonicalIdentity: trust.canonicalIdentity,
        externalReadScopeDigest: trust.externalReadScopeDigest,
        ifRevision: trust.revision,
      });
      await client.startRun('s', {
        expectedStoreId,
        commandId: 'run',
        kind: 'run.start',
        content: 'DEV_SHELL_PARENT',
      });
      const deadline = Date.now() + 15000;
      let view = await client.getView('s');
      const childExecutions = (actual: typeof view) =>
        actual.executions.filter(
          (execution) =>
            execution.definitionId === 'agent/worker' || execution.definitionId === 'agent/code',
        );
      while (
        !view.runs.some((run) => run.originCommandId === 'run' && !run.isActive) ||
        childExecutions(view).length !== 2 ||
        childExecutions(view).some((execution) =>
          ['planned', 'dispatching', 'running'].includes(execution.status),
        )
      ) {
        if (Date.now() > deadline) throw Error('development_shell_run_deadline');
        await Bun.sleep(10);
        view = await client.getView('s');
      }
      expect(view.runs.find((run) => run.originCommandId === 'run')?.status).toBe('completed');
      const children = childExecutions(view);
      expect(children).toHaveLength(2);
      for (const execution of children) {
        expect(execution.status).toBe('succeeded');
        expect(execution.childSessionId).toBeString();
      }
      const views = [{ actual: view, marker: 'DEV_SHELL_PARENT' }];
      for (const child of children)
        views.push({
          actual: await client.getView(child.childSessionId!),
          marker:
            child.definitionId === 'agent/code'
              ? 'DEV_SHELL_CHILD_CODE'
              : 'DEV_SHELL_CHILD_DEFAULT',
        });
      for (const { actual, marker } of views) {
        const commands = actual.executions.filter(
          (execution) => execution.definitionId === 'shell.command',
        );
        expect(commands).toHaveLength(1);
        expect(commands[0]!.status).toBe('succeeded');
        expect(commands[0]!.result).toMatchObject({ details: { processTreeStopped: true } });
        const foreground = actual.executions.filter(
          (execution) => execution.definitionId === 'shell.execute',
        );
        expect(foreground).toHaveLength(1);
        expect(foreground[0]!.status).toBe('succeeded');
        expect(foreground[0]!.result).toMatchObject({
          outcome: 'succeeded',
          details: {
            stdout: `${marker}_EXECUTED\n`,
            stderr: '',
            droppedBytes: '0',
            truncated: false,
          },
        });
      }
      for (const marker of [
        'DEV_SHELL_PARENT',
        'DEV_SHELL_CHILD_DEFAULT',
        'DEV_SHELL_CHILD_CODE',
      ]) {
        const calls = requests.filter((request) => request.marker === marker);
        expect(calls.length).toBeGreaterThanOrEqual(2);
        for (const call of calls) expect(call.names).toEqual(expect.arrayContaining(shellNames));
        expect(
          calls.some((call) =>
            call.results.some((result) => result.includes(`${marker}_EXECUTED`)),
          ),
        ).toBe(true);
      }
    } finally {
      await service?.close();
      provider.stop(true);
      rmSync(root, { recursive: true, force: true });
    }
  },
  30000,
);
