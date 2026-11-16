import { expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRuntime } from '@kite-ai/agent';
import { createArtifactStore } from '@kite-ai/agent/artifacts';
import { createTemporaryCredentialBackend } from '@kite-ai/agent/config';
import { selectProfile } from '@kite-ai/agent/profile';
import { createWorkspaceSerialLocks } from '@kite-ai/agent/resources';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { persistentWorktreeDirectory } from '../../../../tests/fixtures/worktree-filesystem';
import { startService } from '../../src';
import { createDefaultProcessConfiguration } from '../../src/configuration';
import { initializeLivePermissionFixture } from '../fixtures/live-permission-fixture';

// The seed stops at the real Store dispatch edge after a Model has sealed the
// workspace read in epoch one, before native Files has read any content.
async function openFixture(root: string, source: string, pause: boolean) {
  const profile = selectProfile({ dataRoot: join(root, 'profiles'), profile: 'test' });
  const store = await openSqliteStore(profile);
  const storeId = (await store.getMetadata()).storeId;
  const observed = new Proxy(store, {
    get(target, property) {
      if (!pause || property !== 'markDispatching') return Reflect.get(target, property);
      return async (input: Parameters<typeof store.markDispatching>[0]) => {
        const execution = await store.getExecution(input.executionId);
        if (execution?.kind === 'tool' && execution.definitionId === 'files.read') {
          const decision = execution.decisionSource as {
            modelExecutionId: string;
            executionRoot: { epoch: string };
          };
          if (execution.status !== 'planned' || decision.executionRoot.epoch !== '1')
            throw Error('worktree_read_recovery_boundary_invalid');
          console.log(
            JSON.stringify({
              storeId,
              runId: execution.runId,
              targetId: execution.id,
              modelId: decision.modelExecutionId,
            }),
          );
          await new Promise<void>(() => {});
        }
        return store.markDispatching(input);
      };
    },
  });
  const host = createDefaultProcessConfiguration({
    profile,
    userConfigurationPath: join(profile.profilePath, 'config.jsonc'),
    localCodex: false,
    credentialBackend: createTemporaryCredentialBackend(),
    shell: {
      platform: 'darwin',
      configurationId: 'worktree-read-recovery',
      env: { PATH: '/usr/bin:/bin', HOME: source },
      supervisorPath: join(root, 'assets', 'shell-supervisor.js'),
      bunExecutable: process.execPath,
      shellExecutable: '/bin/sh',
      host: {
        controlBase: join(root, 'control'),
        protectedRoots: [join(root, 'control')],
        readonlyAssets: [join(root, 'assets')],
        runtimeReadOnlyRoots: [dirname(process.execPath)],
      },
    },
  });
  const artifacts = createArtifactStore({ profile, store });
  const locks = createWorkspaceSerialLocks(profile);
  host.bindWorkspaceSerialLocks?.(locks);
  const runtime = createRuntime({
    ...host,
    store: observed,
    artifacts,
    workspaceSerialLocks: locks,
    permissions: host.permissions!,
  });
  host.permissionManagement?.(runtime);
  return {
    profile,
    store,
    storeId,
    runtime,
    async close() {
      await runtime.close();
      await locks.close();
      await artifacts.close();
      await store.close();
    },
  };
}

async function seed(root: string, source: string) {
  const f = await openFixture(root, source, true);
  await f.runtime.createWorkspace({
    expectedStoreId: f.storeId,
    id: 'w',
    name: 'Owned recovery workspace',
    rootUri: pathToFileURL(source).href,
  });
  await f.runtime.createSession({
    expectedStoreId: f.storeId,
    sessionId: 's',
    commandId: 'create',
    workspaceId: 'w',
    subjectId: 'owner',
    title: 'Worktree read recovery',
  });
  await initializeLivePermissionFixture({
    runtime: f.runtime,
    profile: f.profile,
    expectedStoreId: f.storeId,
    sessionId: 's',
    workspaceId: 'w',
    subjectId: 'owner',
    mode: 'auto',
    trusted: true,
    nativeShellRead: true,
  });
  await f.runtime.submitCommand({
    expectedStoreId: f.storeId,
    sessionId: 's',
    commandId: 'work',
    subjectId: 'owner',
    request: {
      kind: 'run.start',
      content: 'Use the linked worktree, inspect it, then exit and inspect the original workspace.',
    },
  });
  await new Promise<void>(() => {});
}

async function firstLine(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  let text = '';
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) throw Error('worktree_read_recovery_child_exited');
      text += new TextDecoder().decode(next.value);
      if (text.includes('\n')) return text.split('\n')[0]!;
    }
  } finally {
    reader.releaseLock();
  }
}

function git(cwd: string, ...args: string[]) {
  const result = Bun.spawnSync(['/usr/bin/git', ...args], {
    cwd,
    env: {
      PATH: '/usr/bin:/bin',
      HOME: cwd,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (result.exitCode) throw Error(result.stderr.toString());
}

const native = process.platform === 'darwin' ? test : test.skip;
native(
  'cold HTTP resume preserves the original epoch-one Files call, then exits to the original workspace',
  async () => {
    const repo = persistentWorktreeDirectory('read-recovery-');
    const source = join(repo, 'source'),
      target = join(repo, 'target');
    mkdirSync(source);
    git(source, 'init', '-b', 'main');
    writeFileSync(join(source, 'AGENTS.md'), 'RECOVERY_SOURCE_PROJECT_MARKER\n');
    writeFileSync(join(source, 'where.txt'), 'RECOVERY_SOURCE_FILE\n');
    git(source, 'add', '.');
    git(
      source,
      '-c',
      'user.name=Recovery fixture',
      '-c',
      'user.email=recovery@example.invalid',
      'commit',
      '-m',
      'fixture',
    );
    git(source, 'worktree', 'add', '--detach', target, 'HEAD');
    writeFileSync(join(target, 'AGENTS.md'), 'RECOVERY_TARGET_PROJECT_MARKER\n');
    writeFileSync(join(target, 'where.txt'), 'RECOVERY_TARGET_FILE\n');
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-root-resume-')));
    const profile = selectProfile({ dataRoot: join(root, 'profiles'), profile: 'test' });
    mkdirSync(profile.profilePath, { recursive: true, mode: 0o700 });
    mkdirSync(join(root, 'control'), { mode: 0o700 });
    const supervisor = await Bun.build({
      entrypoints: [
        fileURLToPath(
          new URL(
            '../../../../packages/agent/src/platform/process/shell-supervisor.ts',
            import.meta.url,
          ),
        ),
      ],
      outdir: join(root, 'assets'),
      naming: 'shell-supervisor.js',
      target: 'bun',
    });
    expect(supervisor.success).toBe(true);
    const requests: { messages: { role: string; content: unknown }[] }[] = [];
    const calls = [
      ['git_worktree', { action: 'use', path: target }],
      ['read_file', { path: 'where.txt' }],
      ['git_worktree', { action: 'exit' }],
      ['read_file', { path: 'where.txt' }],
    ] as const;
    let reviews = 0;
    const provider = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        const body = (await request.json()) as {
          tools?: unknown[];
          messages: { role: string; content: unknown }[];
        };
        const reviewing = !body.tools?.length;
        if (reviewing) reviews++;
        const call = reviewing ? undefined : calls[requests.push(body) - 1];
        const delta = reviewing
          ? {
              content: JSON.stringify({
                decision: 'approve_once',
                reason: 'Exact fixture operation',
              }),
            }
          : call
            ? {
                tool_calls: [
                  {
                    index: 0,
                    id: `call-${requests.length}`,
                    type: 'function',
                    function: { name: call[0], arguments: JSON.stringify(call[1]) },
                  },
                ],
              }
            : { content: 'Finished the original Run.' };
        const frame = (delta: unknown, finish_reason: string | null) =>
          `data: ${JSON.stringify({ id: 'root-recovery', object: 'chat.completion.chunk', model: 'fixed', choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
        return new Response(
          `${frame(delta, null)}${frame({}, call ? 'tool_calls' : 'stop')}data: [DONE]\n\n`,
          { headers: { 'content-type': 'text/event-stream' } },
        );
      },
    });
    writeFileSync(
      join(profile.profilePath, 'config.jsonc'),
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
        tools: [{ id: 'git.worktree' }, { id: 'files.read' }],
      }),
    );
    const imports = [
      ['createRuntime', '../../../../packages/agent/src/index.ts'],
      ['createArtifactStore', '../../../../packages/agent/src/artifacts.ts'],
      ['createTemporaryCredentialBackend', '../../../../packages/agent/src/config/index.ts'],
      ['selectProfile', '../../../../packages/agent/src/profile.ts'],
      ['createWorkspaceSerialLocks', '../../../../packages/agent/src/resources.ts'],
      ['openSqliteStore', '../../../../packages/agent/src/sqlite.ts'],
      ['createDefaultProcessConfiguration', '../../src/configuration.ts'],
      ['initializeLivePermissionFixture', '../fixtures/live-permission-fixture.ts'],
    ];
    const script = join(root, 'seed.ts');
    writeFileSync(
      script,
      `import {join,dirname} from 'node:path';import {pathToFileURL} from 'node:url';${imports.map(([name, path]) => `import {${name}} from ${JSON.stringify(fileURLToPath(new URL(path!, import.meta.url)))};`).join('')}const openFixture=${openFixture.toString()};await (${seed.toString()})(${JSON.stringify(root)},${JSON.stringify(source)});`,
    );
    const child = Bun.spawn([process.execPath, script], { stdout: 'pipe', stderr: 'pipe' });
    let f: Awaited<ReturnType<typeof openFixture>> | undefined;
    let service: Awaited<ReturnType<typeof startService>> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const ready = JSON.parse(
        await Promise.race([
          firstLine(child.stdout),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(Error('worktree_read_recovery_seed_timeout')), 15000);
          }),
        ]),
      ) as { storeId: string; runId: string; targetId: string; modelId: string };
      clearTimeout(timer);
      child.kill('SIGKILL');
      expect(await child.exited).toBe(137);
      expect(child.signalCode).toBe('SIGKILL');
      expect(requests).toHaveLength(2);
      f = await openFixture(root, source, false);
      const original = await f.runtime.getExecution(ready.modelId);
      expect(original?.status).toBe('succeeded');
      expect(original?.decisionSource).toMatchObject({
        capabilitySnapshot: {
          executionRoot: { epoch: '1', effectiveRootUri: pathToFileURL(target).href },
        },
      });
      const planned = await f.runtime.getExecution(ready.targetId);
      expect(planned?.status).toBe('planned');
      expect(planned?.authorization?.dispatched).toBe(false);
      expect(planned?.decisionSource).toMatchObject({
        executionRoot: { epoch: '1', effectiveRootUri: pathToFileURL(target).href },
      });
      expect(await f.runtime.getSessionExecutionRoot({ sessionId: 's' })).toMatchObject({
        epoch: '1',
        effectiveRootUri: pathToFileURL(target).href,
      });
      service = await startService({
        runtime: f.runtime,
        profile: { dataRoot: profile.dataRoot, name: profile.profile, accessKey: 'fixture' },
        subjectId: 'owner',
        buildId: 'worktree-read-recovery',
      });
      const response = await fetch(`${service.endpoint}/v1/sessions/s/commands`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${service.bootstrap.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          kind: 'run.resume',
          expectedStoreId: ready.storeId,
          commandId: 'resume',
          runId: ready.runId,
        }),
      });
      const receipt = await response.json();
      expect(response.status, JSON.stringify(receipt)).toBe(202);
      const deadline = Date.now() + 15000;
      while ((await f.runtime.getView('s')).runs.find((run) => run.id === ready.runId)?.isActive) {
        if (Date.now() > deadline) throw Error('worktree_read_recovery_completion_timeout');
        await Bun.sleep(5);
      }
      const rows = await f.store.listExecutions('s');
      const tools = rows.filter((row) => row.kind === 'tool');
      expect(
        tools.map((row) => row.status),
        JSON.stringify(tools.map((row) => row.result)),
      ).toEqual(['succeeded', 'succeeded', 'succeeded', 'succeeded']);
      expect(tools.map((row) => row.definitionId)).toEqual([
        'git.worktree',
        'files.read',
        'git.worktree',
        'files.read',
      ]);
      expect(tools[1]?.id).toBe(ready.targetId);
      expect(JSON.stringify(tools[1]?.result)).toContain('RECOVERY_TARGET_FILE');
      expect(JSON.stringify(tools[1]?.result)).not.toContain('RECOVERY_SOURCE_FILE');
      expect(JSON.stringify(tools[3]?.result)).toContain('RECOVERY_SOURCE_FILE');
      expect((await f.runtime.getExecution(ready.modelId))?.result).toEqual(original?.result);
      expect(rows.filter((row) => row.kind === 'model' && row.runId)).toHaveLength(5);
      expect(requests).toHaveLength(5);
      expect(new Set(rows.filter((row) => row.runId).map((row) => row.runId)).size).toBe(1);
      expect(await f.runtime.getSessionExecutionRoot({ sessionId: 's' })).toMatchObject({
        epoch: '2',
        effectiveRootUri: pathToFileURL(source).href,
      });
      expect((await f.runtime.getWorkspace('w'))?.rootUri).toBe(pathToFileURL(source).href);
      const prefix = (n: number) =>
        JSON.stringify(requests[n]?.messages.filter((message) => message.role !== 'tool'));
      expect(prefix(1)).toContain('RECOVERY_TARGET_PROJECT_MARKER');
      expect(prefix(1)).not.toContain('RECOVERY_SOURCE_PROJECT_MARKER');
      expect(prefix(2)).toContain('RECOVERY_TARGET_PROJECT_MARKER');
      expect(prefix(2)).not.toContain('RECOVERY_SOURCE_PROJECT_MARKER');
      expect(prefix(3)).toContain('RECOVERY_SOURCE_PROJECT_MARKER');
      expect(prefix(3)).not.toContain('RECOVERY_TARGET_PROJECT_MARKER');
      expect(reviews).toBe(0);
      expect(existsSync(target)).toBe(true);
      expect(readFileSync(join(target, 'where.txt'), 'utf8')).toBe('RECOVERY_TARGET_FILE\n');
    } finally {
      clearTimeout(timer);
      if (child.exitCode === null) child.kill('SIGKILL');
      await child.exited;
      const stderr = await new Response(child.stderr).text();
      if (stderr) console.error('worktree-read-recovery-child', stderr);
      await service?.close();
      await f?.close();
      provider.stop(true);
      rmSync(root, { recursive: true, force: true });
      // The real Git worktrees stay in the existing persistent fixture area.
    }
  },
  45000,
);
