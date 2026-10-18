import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { selectProfile } from '@kite-ai/agent/profile';
import { launchPairedService } from '@kite-ai/service/paired';
import { privateDirectory } from '../../../../tests/fixtures/test-filesystem';
import { ownedUserConfiguration } from '../../../service/test/fixtures/user-configuration-fixture';
import {
  createStdioPermissionReader,
  promptPermissionMode,
  promptWorkspaceTrust,
} from '../../src/permissions';
import { buildOwnedDaemon } from './daemon-host-build';
import { type OriginalMessage, originalToolResults } from './original-tool-results';
import { untilRecovery } from './recovery-profile';

/** Formal default paired Service, public trusted Full mode and actual compatible SDK; two independent ordinary Shell Jobs. */
export async function callerJobProfile() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-caller-jobs-'))),
    workspace = join(root, 'workspace'),
    profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'owned' });
  symlinkSync(
    join(import.meta.dir, '../../node_modules'),
    join(root, 'node_modules'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  const userConfiguration = ownedUserConfiguration(join(root, 'home'));
  mkdirSync(workspace);
  privateDirectory(join(profile.profilePath, 'ui'));
  writeFileSync(join(profile.profilePath, 'ui/preferences.jsonc'), '{"language":"en-US"}', {
    mode: 0o600,
  });
  let calls = 0;
  const provider = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) {
      calls++;
      const body = (await req.json()) as { messages: OriginalMessage[] };
      const done = originalToolResults(
        body.messages,
        'two owned jobs',
        ['a', 'b'].map((key) => ({ id: `launch-${key}`, name: 'shell_launch' })),
      );
      const delta = done
        ? { content: 'PARENT_DONE_TWO_INDEPENDENT_JOBS' }
        : {
            tool_calls: ['a', 'b'].map((key, index) => ({
              index,
              id: `launch-${key}`,
              type: 'function',
              function: {
                name: 'shell_launch',
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
  writeFileSync(
    userConfiguration.path,
    JSON.stringify({
      modelId: 'fixed',
      models: [
        { id: 'fixed', provider: 'compatible', model: 'fixed', baseURL: `${provider.url.href}v1` },
      ],
      tools: [{ id: 'shell.launch', definitionVersion: '1' }],
    }),
  );
  const artifact = join(root, 'artifact');
  await buildOwnedDaemon(artifact);
  const entrypoint = join(artifact, 'node_modules/@kite-ai/service/main.js');
  const digest = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
  const chosen = {
    entrypoint,
    entrypointSha256: digest(entrypoint),
    executable: realpathSync(process.execPath),
    executableSha256: digest(process.execPath),
    buildId: 'caller-formal-jobs',
    apiMajor: 1,
  };
  const service = await launchPairedService({
    profile,
    ...chosen,
    spawnChild: userConfiguration.spawnChild,
    instanceId: crypto.randomUUID(),
    requiredCapabilities: ['commands', 'inputs', 'permission_controls'],
  });
  const client = service.client,
    storeId = service.bootstrap.storeId!;
  try {
    await client.createWorkspace({
      expectedStoreId: storeId,
      id: 'w',
      rootUri: pathToFileURL(workspace).href,
      name: 'owned',
    });
    await client.createSession({
      expectedStoreId: storeId,
      commandId: 'create',
      sessionId: 's',
      workspaceId: 'w',
      title: 'Jobs',
    });
    for (const [line, invoke] of [
      ['trust\n', promptWorkspaceTrust],
      ['full\n', promptPermissionMode],
    ] as const) {
      const reader = createStdioPermissionReader(Readable.from([line]));
      try {
        const result = await invoke(line.startsWith('trust') ? 'w' : 's', storeId, reader, {
          client,
          write() {},
        });
        if (result.exitCode !== 0) throw Error('caller_public_permission_failed');
      } finally {
        reader.dispose();
      }
    }
    await client.startRun('s', {
      expectedStoreId: storeId,
      commandId: 'work',
      kind: 'run.start',
      content: 'two owned jobs',
    });
    await untilRecovery(async () => {
      const original = await client.getCommand('work');
      if (original.status === 'rejected')
        throw Error(`caller_formal_work_rejected:${JSON.stringify(original.receipt)}`);
      const v = await client.getView('s');
      return (
        v.runs.some((r) => r.originCommandId === 'work' && r.status === 'completed') &&
        v.executions.filter((e) => e.kind === 'job' && e.status === 'running').length === 2
      );
    });
    const jobs = (await client.getView('s')).executions.filter((e) => e.kind === 'job');
    return {
      userConfiguration,
      root,
      workspace,
      profile,
      storeId,
      client,
      jobs,
      endpoint: service.bootstrap.endpoint,
      token: service.bootstrap.token,
      serviceProfile: service.bootstrap.profile,
      servicePid: service.pid,
      calls: () => calls,
      async close() {
        client.disposeNetwork();
        await service.close();
        writeFileSync(
          `${root}.service-exit.json`,
          JSON.stringify({
            pid: service.pid,
            closed: true,
            assembly: 'sealed-default-paired',
            policy: 'public-workspace-trust-and-full',
          }),
        );
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
