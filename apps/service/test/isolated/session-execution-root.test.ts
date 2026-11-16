import { expect, test } from 'bun:test';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { type AgentRuntime, createRuntime, prepareOutputDirectory } from '@kite-ai/agent';
import { createArtifactStore } from '@kite-ai/agent/artifacts';
import { createTemporaryCredentialBackend } from '@kite-ai/agent/config';
import type { ToolContext } from '@kite-ai/agent/extensions';
import { selectProfile } from '@kite-ai/agent/profile';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { privateDirectory } from '../../../../tests/fixtures/test-filesystem';
import { parseShellModelFeedback } from '../../../../tests/fixtures/unified-agent/shell-model-feedback';
import { persistentWorktreeDirectory } from '../../../../tests/fixtures/worktree-filesystem';
import { createDefaultProcessConfiguration } from '../../src/configuration';
import { createWorktreeHost } from '../../src/worktree-host';
import { initializeLivePermissionFixture } from '../fixtures/live-permission-fixture';

const native = process.platform === 'darwin' ? test : test.skip;
function git(cwd: string, ...args: string[]) {
  const value = Bun.spawnSync(['/usr/bin/git', ...args], {
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
  if (value.exitCode) throw new Error(value.stderr.toString());
  return value.stdout.toString().trim();
}

async function exerciseRootSwitch(
  protectProfile = false,
  mode: 'full' | 'auto' = 'full',
  background = false,
) {
  const root = persistentWorktreeDirectory('session-root-');
  const source = join(root, 'source'),
    target = join(root, 'target');
  mkdirSync(source);
  git(source, 'init', '-b', 'main');
  git(source, 'config', 'user.name', 'Root fixture');
  git(source, 'config', 'user.email', 'root@example.invalid');
  writeFileSync(join(source, 'AGENTS.md'), 'SOURCE_ROOT_ONLY_MARKER\n');
  writeFileSync(join(source, 'where.txt'), 'source-root-content\n');
  git(source, 'add', '.');
  git(source, 'commit', '-m', 'initial');
  git(source, 'worktree', 'add', '--detach', target, 'HEAD');
  writeFileSync(join(target, 'AGENTS.md'), 'TARGET_ROOT_ONLY_MARKER\n');
  writeFileSync(join(target, 'where.txt'), 'target-root-content\n');
  // launchd control sockets require a short path; code worktrees remain durable.
  const hostRoot = realpathSync(mkdtempSync(join(tmpdir(), 'kite-root-host-')));
  const profile = selectProfile({ dataRoot: join(hostRoot, 'data'), profile: 'roots' });
  privateDirectory(profile.profilePath);
  privateDirectory(join(hostRoot, 'control'));
  const calls: [string, Record<string, unknown>][] = background
    ? [
        ['git_worktree', { action: 'use', path: target }],
        [
          'shell_execute',
          {
            background: true,
            command:
              'while [ ! -f release-old-shell ]; do sleep 0.05; done; pwd; pwd > "$KITE_OUTPUT_DIR/late.txt"',
          },
        ],
        ['git_worktree', { action: 'exit' }],
        ['shell_wait', {}],
      ]
    : [
        ['git_worktree', { action: 'use', path: target }],
        ['read_file', { path: 'where.txt' }],
        [
          'shell_execute',
          { command: mode === 'auto' ? 'pwd; printf root-inspected > inspection.txt' : 'pwd' },
        ],
        ['git_worktree', { action: 'list' }],
        [
          'git_worktree',
          { action: 'create', path: join(root, 'created-from-target'), filesystem: 'full_access' },
        ],
        ['git_worktree', { action: 'exit' }],
        ['read_file', { path: 'where.txt' }],
        [
          'shell_execute',
          { command: mode === 'auto' ? 'pwd; printf root-inspected > inspection.txt' : 'pwd' },
        ],
      ];
  let index = 0;
  const reviews: Record<string, unknown>[] = [];
  const requests: { messages: { role: string; content: unknown }[] }[] = [];
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as { messages: { role: string; content: unknown }[] };
      let review: Record<string, unknown> | undefined;
      try {
        const value = JSON.parse(
          String(body.messages.filter((row) => row.role === 'user').at(-1)?.content ?? ''),
        );
        if (value.purpose === 'shell_risk' || value.purpose === 'authorization_check')
          review = value;
      } catch {}
      if (review) reviews.push(review);
      else requests.push(body);
      const call = review ? undefined : calls[index++];
      if (background && call?.[0] === 'git_worktree' && call[1].action === 'exit') {
        const deadline = Date.now() + 10000;
        let originalJob = (await store!.listExecutions('s')).find(
          (row) => row.definitionId === 'shell.command',
        );
        while (originalJob?.status !== 'running' && Date.now() < deadline) {
          await Bun.sleep(20);
          originalJob = (await store!.listExecutions('s')).find(
            (row) => row.definitionId === 'shell.command',
          );
        }
        expect(originalJob?.status, JSON.stringify(originalJob?.result)).toBe('running');
        expect(originalJob?.authorization?.dispatched).toBe(true);
      }
      if (background && call?.[0] === 'shell_wait') {
        const originalJob = (await store!.listExecutions('s')).find(
          (row) => row.definitionId === 'shell.command',
        );
        expect(originalJob).toMatchObject({
          status: 'running',
          authorization: { dispatched: true },
          decisionSource: {
            executionRoot: { epoch: '1', effectiveRootUri: pathToFileURL(target).href },
          },
        });
        expect((await runtime!.getSessionExecutionRoot({ sessionId: 's' })).epoch).toBe('2');
        const previous = body.messages.filter((row) => row.role === 'tool');
        const launched = previous.find((row) => String(row.content).includes('shell_id'));
        const shellId = parseShellModelFeedback(String(launched?.content ?? '')).shellId;
        expect(shellId).toBeTruthy();
        call[1] = { shell_id: shellId, wait_ms: 10000 };
        writeFileSync(join(target, 'release-old-shell'), 'release after exit');
      }
      const delta = call
        ? {
            tool_calls: [
              {
                index: 0,
                id: `call-${index}`,
                type: 'function',
                function: { name: call[0], arguments: JSON.stringify(call[1]) },
              },
            ],
          }
        : {
            content: review
              ? JSON.stringify(
                  review.purpose === 'shell_risk'
                    ? {
                        risk: 'ordinary',
                        reason: 'Prints the current directory and writes a fixed fixture marker.',
                      }
                    : {
                        decision: 'approve_once',
                        reason: 'Fixture approves this exact operation.',
                      },
                )
              : 'Done.',
          };
      const chunk = (value: object, reason: string | null) =>
        `data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'fixed', choices: [{ index: 0, delta: value, finish_reason: reason }] })}\n\n`;
      return new Response(
        chunk(delta, null) + chunk({}, call ? 'tool_calls' : 'stop') + 'data: [DONE]\n\n',
        { headers: { 'content-type': 'text/event-stream' } },
      );
    },
  });
  let store: Awaited<ReturnType<typeof openSqliteStore>> | undefined;
  let runtime: AgentRuntime | undefined;
  try {
    writeFileSync(
      join(profile.profilePath, 'config.jsonc'),
      JSON.stringify({
        modelId: 'fixed',
        models: [
          {
            id: 'fixed',
            provider: 'compatible',
            model: 'fixed',
            baseURL: `http://127.0.0.1:${server.port}/v1`,
          },
        ],
        tools: [
          { id: 'git.worktree' },
          { id: 'files.read' },
          { id: 'shell.execute' },
          ...(background ? [{ id: 'shell.wait' }] : []),
        ],
      }),
    );
    const supervisor = await Bun.build({
      entrypoints: [
        join(
          import.meta.dir,
          '../../../../packages/agent/src/platform/process/shell-supervisor.ts',
        ),
      ],
      outdir: join(hostRoot, 'assets'),
      naming: 'shell-supervisor.js',
      target: 'bun',
    });
    expect(supervisor.success).toBe(true);
    const host = createDefaultProcessConfiguration({
      profile,
      localCodex: false,
      userConfigurationPath: join(profile.profilePath, 'config.jsonc'),
      credentialBackend: createTemporaryCredentialBackend(),
      shell: {
        platform: 'darwin',
        configurationId: 'session-root-fixture',
        env: { PATH: '/usr/bin:/bin', HOME: source },
        supervisorPath: supervisor.outputs[0]!.path,
        bunExecutable: process.execPath,
        shellExecutable: '/bin/sh',
        host: {
          controlBase: join(hostRoot, 'control'),
          // Match the production host: its own staging path is not a protected parent.
          protectedRoots: [
            join(hostRoot, 'control'),
            ...(protectProfile ? [profile.dataRoot] : []),
          ],
          readonlyAssets: [join(hostRoot, 'assets')],
          runtimeReadOnlyRoots: [dirname(process.execPath)],
        },
      },
    });
    store = await openSqliteStore({ dataRoot: profile.dataRoot, profile: profile.profile });
    runtime = createRuntime({
      ...host,
      permissions: host.permissions!,
      store,
      artifacts: createArtifactStore({ profile, store }),
      outputCollections: {
        prepare: (context, identity) => prepareOutputDirectory(runtime!, context, identity),
      },
      processConcurrency: 2,
      modelConcurrency: 1,
    });
    host.permissionManagement!(runtime);
    const expectedStoreId = (await store.getMetadata()).storeId;
    const base = { expectedStoreId, subjectId: 'owner', sessionId: 's' };
    await runtime.createWorkspace({
      expectedStoreId,
      id: 'w',
      rootUri: pathToFileURL(source).href,
      name: 'source',
    });
    await runtime.createSession({
      ...base,
      workspaceId: 'w',
      commandId: 'create-s',
      title: 'root-switch',
    });
    await runtime.createSession({
      ...base,
      sessionId: 'other',
      workspaceId: 'w',
      commandId: 'create-other',
      title: 'untouched',
    });
    await initializeLivePermissionFixture({
      runtime,
      profile,
      ...base,
      workspaceId: 'w',
      mode,
      trusted: true,
      nativeShellRead: true,
    });
    await runtime.submitCommand({
      ...base,
      commandId: 'switch-run',
      request: {
        kind: 'run.start',
        content:
          'Use the target worktree, read and inspect it, then exit and inspect the original workspace.',
      },
    });
    const receipt = await runtime.waitForCommand('switch-run', { timeoutMs: 30000 });
    const rows = await store.listExecutions('s');
    const tools = rows.filter((row) => row.kind === 'tool');
    expect(
      receipt,
      JSON.stringify({
        receipt,
        tools: tools.map((x) => ({ tool: x.definitionId, result: x.result })),
      }),
    ).toMatchObject({ status: 'applied' });
    expect(
      tools.map((row) => row.status),
      JSON.stringify(tools.map((x) => x.result)),
    ).toEqual(
      Array.from({ length: calls.length }, (_, index) =>
        protectProfile && index === 4 ? 'failed' : 'succeeded',
      ),
    );
    if (protectProfile)
      expect(tools[4]!.result).toMatchObject({
        outcome: 'failed',
        details: { code: 'git_permission_denied', mutation: 'not_started' },
      });
    expect(new Set(rows.filter((row) => row.runId).map((row) => row.runId)).size).toBe(1);
    expect((await runtime.getSessionExecutionRoot({ sessionId: 's' })).epoch).toBe('2');
    expect((await runtime.getSessionExecutionRoot({ sessionId: 's' })).effectiveRootUri).toBe(
      pathToFileURL(source).href,
    );
    expect((await runtime.getSessionExecutionRoot({ sessionId: 'other' })).epoch).toBe('0');
    expect((await runtime.getWorkspace('w'))!.rootUri).toBe(pathToFileURL(source).href);
    if (background) {
      const jobs = rows.filter((row) => row.definitionId === 'shell.command');
      expect(jobs).toHaveLength(1);
      expect(jobs[0]).toMatchObject({
        status: 'succeeded',
        authorization: { dispatched: true },
        decisionSource: {
          executionRoot: { epoch: '1', effectiveRootUri: pathToFileURL(target).href },
        },
        result: { details: { processTreeStopped: true } },
      });
      const deadline = Date.now() + 10000;
      let page = await runtime.queryOutputFiles(base);
      while (!page.items.some((item) => item.name === 'late.txt') && Date.now() < deadline) {
        await Bun.sleep(20);
        page = await runtime.queryOutputFiles(base);
      }
      expect(
        page.collections.map((item) => item.state),
        JSON.stringify(page),
      ).toEqual(['ready']);
      expect(page.items.map((item) => item.name)).toEqual(['late.txt']);
      const record = await runtime.resolveOutputFile({ ...base, target: page.items[0]! });
      expect(record.sourceExecutionId).toBe(jobs[0]!.id);
      const read = await runtime.readArtifact({
        ...base,
        refId: record.reference.id,
        scope: record.reference.scope,
      });
      expect(new TextDecoder().decode(read.content)).toBe(`${target}\n`);
      expect(existsSync(join(source, 'release-old-shell'))).toBe(false);
      return;
    }
    expect(JSON.stringify(tools[1]!.result)).toContain('target-root-content');
    expect(JSON.stringify(tools[2]!.result)).toContain(target);
    expect(JSON.stringify(tools[6]!.result)).toContain('source-root-content');
    expect(JSON.stringify(tools[7]!.result)).toContain(source);
    const prefix = (n: number) =>
      JSON.stringify(requests[n]?.messages.filter((m) => m.role !== 'tool'));
    expect(prefix(1)).toContain('TARGET_ROOT_ONLY_MARKER');
    expect(prefix(1)).not.toContain('SOURCE_ROOT_ONLY_MARKER');
    expect(prefix(6)).toContain('SOURCE_ROOT_ONLY_MARKER');
    expect(prefix(6)).not.toContain('TARGET_ROOT_ONLY_MARKER');
    if (mode === 'auto') {
      expect(reviews.length).toBe(2);
      expect(reviews.every((review) => review.purpose === 'shell_risk')).toBe(true);
      expect(readFileSync(join(target, 'inspection.txt'), 'utf8')).toBe('root-inspected');
      expect(readFileSync(join(source, 'inspection.txt'), 'utf8')).toBe('root-inspected');
    }
    expect(existsSync(target)).toBe(true);
    expect(existsSync(join(root, 'created-from-target', '.git'))).toBe(!protectProfile);
    expect(JSON.stringify(tools[3]!.result)).toContain(target);
    expect(readFileSync(join(target, 'where.txt'), 'utf8')).toBe('target-root-content\n');
  } catch (error) {
    console.error(error);
    throw error;
  } finally {
    await runtime?.close();
    await store?.close();
    server.stop(true);
  }
}

native(
  'same Run explicitly uses and exits a worktree with Files, Shell and project sources at one epoch',
  () => exerciseRootSwitch(),
  60000,
);
native(
  'Auto keeps exact Shell risk review after a root change without losing the original Run ceiling',
  () => exerciseRootSwitch(false, 'auto'),
  60000,
);

native(
  'a dispatched background Shell retains its root and collects output after the same Run exits',
  () => exerciseRootSwitch(false, 'full', true),
  60000,
);

native(
  'an explicit protected root still denies Git filesystem inspection after switching even in Full mode',
  () => exerciseRootSwitch(true),
  60000,
);

native(
  'worktree activation rejects a target replaced after permission inspection without preparing a new root',
  async () => {
    const root = persistentWorktreeDirectory('root-approval-');
    const source = join(root, 'source'),
      target = join(root, 'target');
    mkdirSync(source);
    git(source, 'init', '-b', 'main');
    git(
      source,
      '-c',
      'user.name=Root fixture',
      '-c',
      'user.email=root@example.invalid',
      'commit',
      '--allow-empty',
      '-m',
      'initial',
    );
    git(source, 'worktree', 'add', '--detach', target, 'HEAD');
    let prepared = 0;
    const runtime = {
      getSessionExecutionRoot: async () => ({
        sessionId: 's',
        workspaceId: 'w',
        effectiveRootUri: pathToFileURL(source).href,
        epoch: '0',
        identity: null,
      }),
      getSession: async () => ({
        id: 's',
        workspaceId: 'w',
        rootSessionId: 's',
        ownerInstanceId: 'owner',
        ownerGeneration: '1',
      }),
      getExecution: async () => ({
        id: 'e',
        sessionId: 's',
        kind: 'tool',
        definitionId: 'git.worktree',
        definitionVersion: '1',
        originStoreId: 'store',
        decisionSource: {},
      }),
      getWorkspace: async () => ({ rootUri: pathToFileURL(source).href }),
      getMetadata: async () => ({ storeId: 'store' }),
      prepareSessionExecutionRoot: async () => {
        prepared++;
        throw new Error('must_not_prepare');
      },
    } as unknown as AgentRuntime;
    const host = createWorktreeHost(() => runtime);
    const request = { action: 'use' as const, path: target };
    const context = {
      sessionId: 's',
      executionId: 'e',
      signal: new AbortController().signal,
    } as ToolContext;
    await host.describeExecutionRoot(request, context, source);
    renameSync(target, `${target}-old`);
    mkdirSync(target);
    copyFileSync(join(`${target}-old`, '.git'), join(target, '.git'));
    let failure: unknown;
    try {
      await host.prepareExecutionRoot(request, context, source);
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ code: 'execution_root_changed' });
    expect(prepared).toBe(0);
    expect(existsSync(`${target}-old`)).toBe(true);
  },
);
