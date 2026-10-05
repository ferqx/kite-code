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
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { selectProfile } from '@kite-ai/agent/profile';
import { launchPairedService } from '@kite-ai/service/paired';
import type { CLIServiceArtifact } from '../../host';
import { buildOwnedDaemon } from './daemon-host-build';

async function until<T>(read: () => Promise<T>, matches: (value: T) => boolean) {
  const deadline = Date.now() + 20000;
  for (;;) {
    const value = await read();
    if (matches(value)) return value;
    if (Date.now() > deadline) throw Error('file_fork_receipt_deadline');
    await Bun.sleep(5);
  }
}
export async function fileRecoveryProfile(input: { secondMutation?: boolean } = {}) {
  const root = realpathSync(mkdtempSync('/private/tmp/kite-cli-file-fork-'));
  const workspace = join(root, 'workspace'),
    home = join(root, 'home');
  mkdirSync(workspace);
  mkdirSync(home, { mode: 0o700 });
  const file = join(workspace, 'original.txt');
  writeFileSync(file, 'original bytes\r\n');
  const profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'owned' });
  mkdirSync(profile.profilePath, { recursive: true, mode: 0o700 });
  mkdirSync(join(profile.profilePath, 'ui'), { mode: 0o700 });
  writeFileSync(join(profile.profilePath, 'ui/preferences.jsonc'), '{"language":"en-US"}', {
    mode: 0o600,
  });
  let requests = 0;
  const provider = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as { messages: { role: string; content: string }[] };
      const n = requests++;
      const read = body.messages.filter((m) => m.role === 'tool').at(-1);
      const call =
        n === 0 || (input.secondMutation && n === 3)
          ? { name: 'files.read', input: { path: 'original.txt', limit: 1000 } }
          : n === 1 || (input.secondMutation && n === 4)
            ? {
                name: 'files.write',
                input: {
                  path: 'original.txt',
                  content: n === 1 ? 'actual changed bytes\r\n' : 'later actual Run bytes\r\n',
                  base: JSON.parse(read!.content).baseline,
                },
              }
            : null;
      const frame = (delta: unknown, finish_reason: string | null) =>
        `data: ${JSON.stringify({ id: `actual-${n}`, object: 'chat.completion.chunk', model: 'fixed', choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
      return new Response(
        frame(
          call
            ? {
                tool_calls: [
                  {
                    index: 0,
                    id: `call-${n}`,
                    type: 'function',
                    function: { name: call.name, arguments: JSON.stringify(call.input) },
                  },
                ],
              }
            : { content: 'completed' },
          null,
        ) +
          frame({}, call ? 'tool_calls' : 'stop') +
          'data: [DONE]\n\n',
        { headers: { 'content-type': 'text/event-stream' } },
      );
    },
  });
  writeFileSync(
    join(profile.profilePath, 'config.jsonc'),
    JSON.stringify({
      modelId: 'fixed',
      models: [
        { id: 'fixed', provider: 'compatible', model: 'fixed', baseURL: `${provider.url.href}v1` },
      ],
      tools: [
        { id: 'files.read', definitionVersion: '3' },
        { id: 'files.write', definitionVersion: '2' },
      ],
    }),
  );
  await buildOwnedDaemon(join(root, 'artifact'));
  const entrypoint = join(root, 'artifact/node_modules/@kite-ai/service/main.js');
  const hash = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
  const artifact: CLIServiceArtifact = {
    entrypoint,
    entrypointSha256: hash(entrypoint),
    executable: realpathSync(process.execPath),
    executableSha256: hash(realpathSync(process.execPath)),
    apiMajor: 1,
    buildId: 'file-recovery-owned',
  };
  const service = await launchPairedService({
    entrypoint: artifact.entrypoint,
    profile,
    instanceId: 'owned',
    buildId: 'file-fork-receipt',
    apiMajor: 1,
    requiredCapabilities: ['extensions_actions', 'extension_queries'],
    spawnChild: (command, { env }) =>
      Bun.spawn([...command], {
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
        env: { ...env, HOME: home },
      }),
  });
  try {
    const client = service.client,
      storeId = service.bootstrap.storeId!;
    await client.createWorkspace({
      expectedStoreId: storeId,
      id: 'w',
      name: 'owned',
      rootUri: pathToFileURL(workspace).href,
    });
    await client.createSession({
      expectedStoreId: storeId,
      commandId: 'create',
      sessionId: 's',
      workspaceId: 'w',
      title: 'original',
    });
    const mode = await client.getPermissionMode('s', { storeId });
    await client.setPermissionMode('s', {
      expectedStoreId: storeId,
      commandId: 'mode',
      mode: 'full',
      ifRevision: mode.revision,
      makeDefault: false,
      ifDefaultRevision: mode.defaultRevision,
    });
    const trust = await client.getWorkspaceTrust('w', { storeId });
    await client.setWorkspaceTrust('w', {
      expectedStoreId: storeId,
      commandId: 'trust',
      trusted: true,
      canonicalIdentity: trust.canonicalIdentity,
      externalReadScopeDigest: trust.externalReadScopeDigest,
      ifRevision: trust.revision,
    });
    await client.startRun('s', {
      expectedStoreId: storeId,
      commandId: 'work',
      kind: 'run.start',
      content: 'Read and change the original file.',
    });
    const command = await until(
      () => client.getCommand('work'),
      (c) => c.status === 'applied',
    );
    const runId = (command.receipt as { runId: string }).runId;
    const run = await until(
      () => client.getRun(runId),
      (r) => !r.isActive,
    );
    if (run.status !== 'completed' || readFileSync(file, 'utf8') !== 'actual changed bytes\r\n')
      throw Error('file_fixture_warm_failed');
    const checkpointId = (await client.listFileCheckpoints('s')).payload.items[0]!.checkpoint.id;
    await service.close();
    return {
      checkpointId,
      root,
      workspace,
      home,
      profile,
      file,
      artifact,
      calls: () => requests,
      close() {
        provider.stop(true);
        rmSync(root, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await service.close();
    provider.stop(true);
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

export async function compileFileRecoveryTUI(root: string, runner: string) {
  const modules = join(root, 'node_modules');
  mkdirSync(modules, { recursive: true });
  for (const name of ['ink', 'react'])
    symlinkSync(
      realpathSync(join(resolve(import.meta.dir, '../../../..'), 'node_modules', name)),
      join(modules, name),
      'dir',
    );
  return Bun.build({
    entrypoints: [runner],
    outdir: root,
    target: 'bun',
    external: ['ink', 'react', 'react-devtools-core'],
  });
}
