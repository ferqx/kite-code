import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRuntime } from '@kite-ai/agent';
import { selectProfile } from '@kite-ai/agent/profile';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { createClient } from '@kite-ai/client';
import { startService } from '@kite-ai/service';
import { createDefaultProcessConfiguration } from '@kite-ai/service/configuration';
import { untilRecovery } from './recovery-profile';

/** Explicit host policy and actual compatible SDK; two independent ordinary Shell Jobs. */
export async function callerJobProfile() {
  const root = realpathSync(mkdtempSync('/private/tmp/kite-caller-jobs-')),
    workspace = join(root, 'workspace'),
    profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'owned' });
  symlinkSync(join(import.meta.dir, '../../node_modules'), join(root, 'node_modules'), 'dir');
  mkdirSync(workspace);
  mkdirSync(join(profile.profilePath, 'ui'), { recursive: true, mode: 0o700 });
  writeFileSync(join(profile.profilePath, 'ui/preferences.jsonc'), '{"language":"en-US"}', {
    mode: 0o600,
  });
  let calls = 0;
  const provider = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) {
      calls++;
      const body = (await req.json()) as { messages: { role: string }[] };
      const done = body.messages.at(-1)?.role === 'tool';
      const delta = done
        ? { content: 'PARENT_DONE_TWO_INDEPENDENT_JOBS' }
        : {
            tool_calls: ['a', 'b'].map((key, index) => ({
              index,
              id: `launch-${key}`,
              type: 'function',
              function: {
                name: 'shell.launch',
                arguments: JSON.stringify({
                  key,
                  command: `printf 'JOB_${key}_UTF8 中🙂é\\n'; while :; do /bin/sleep 1; done`,
                  cancellation: 'detached',
                }),
              },
            })),
          };
      const frame = (d: unknown, reason: string | null) =>
        `data: ${JSON.stringify({ id: 'fixed', object: 'chat.completion.chunk', model: 'fixed', choices: [{ index: 0, delta: d, finish_reason: reason }] })}\n\n`;
      return new Response(
        `${frame(delta, null) + frame({}, done ? 'stop' : 'tool_calls')}data: [DONE]\n\n`,
        { headers: { 'content-type': 'text/event-stream' } },
      );
    },
  });
  const built = await Bun.build({
    entrypoints: [
      join(import.meta.dir, '../../../../packages/agent/src/platform/process/shell-supervisor.ts'),
    ],
    target: 'bun',
    outdir: join(root, 'assets'),
    naming: 'shell-supervisor.js',
  });
  if (!built.success) throw Error('caller_shell_build_failed');
  writeFileSync(
    join(profile.profilePath, 'config.jsonc'),
    JSON.stringify({
      modelId: 'fixed',
      models: [
        { id: 'fixed', provider: 'compatible', model: 'fixed', baseURL: `${provider.url.href}v1` },
      ],
      tools: [{ id: 'shell.launch', definitionVersion: '1' }],
    }),
  );
  const host = createDefaultProcessConfiguration({
    profile,
    shell: {
      platform: 'darwin',
      configurationId: 'caller-owned-confined-1',
      env: { PATH: '/usr/bin:/bin' },
      supervisorPath: built.outputs[0]!.path,
      bunExecutable: process.execPath,
      shellExecutable: '/bin/sh',
      graceMs: 20,
    },
    permissionPolicy: {
      readPolicy: () => ({
        mode: 'full',
        workspaceTrust: true,
        revision: 'explicit-caller-job-fixture',
        allowed: [
          { kind: 'model', definitionId: 'fixed', definitionVersion: '1' },
          { kind: 'tool', definitionId: 'shell.launch', definitionVersion: '1' },
          { kind: 'job', definitionId: 'shell.command', definitionVersion: '1' },
        ],
      }),
    },
  });
  const store = await openSqliteStore({ dataRoot: profile.dataRoot, profile: 'owned' }),
    runtime = createRuntime({ ...host, store, permissions: host.permissions! }),
    storeId = (await store.getMetadata()).storeId;
  const service = await startService({
      runtime,
      buildId: 'caller-owned-jobs',
      profile: { dataRoot: profile.dataRoot, name: 'owned', accessKey: profile.profileAccessKey },
    }),
    client = createClient({
      endpoint: service.endpoint,
      token: service.bootstrap.token,
      expected: {
        profile: service.bootstrap.profile,
        apiMajor: 1,
        requiredCapabilities: ['commands', 'inputs'],
      },
    });
  await client.connect();
  try {
    await client.createWorkspace({
      expectedStoreId: storeId,
      id: 'w',
      rootUri: `file://${workspace}`,
      name: 'owned',
    });
    await client.createSession({
      expectedStoreId: storeId,
      commandId: 'create',
      sessionId: 's',
      workspaceId: 'w',
      title: 'Jobs',
    });
    await client.startRun('s', {
      expectedStoreId: storeId,
      commandId: 'work',
      kind: 'run.start',
      content: 'two owned jobs',
    });
    await untilRecovery(async () => {
      const v = await client.getView('s');
      return (
        v.runs.some((r) => r.originCommandId === 'work' && r.status === 'completed') &&
        v.executions.filter((e) => e.kind === 'job' && e.status === 'running').length === 2
      );
    });
    const jobs = (await client.getView('s')).executions.filter((e) => e.kind === 'job');
    return {
      root,
      workspace,
      profile,
      storeId,
      client,
      jobs,
      store,
      endpoint: service.endpoint,
      token: service.bootstrap.token,
      serviceProfile: service.bootstrap.profile,
      calls: () => calls,
      async close() {
        client.disposeNetwork();
        await service.close();
        provider.stop(true);
        rmSync(root, { recursive: true, force: true });
      },
    };
  } catch (error) {
    client.disposeNetwork();
    await service.close();
    provider.stop(true);
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}
