import { expect, spyOn, test } from 'bun:test';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRuntime } from '@kite-ai/agent';
import { createArtifactStore } from '@kite-ai/agent/artifacts';
import { createTemporaryCredentialBackend } from '@kite-ai/agent/config';
import type { Json, ToolResult } from '@kite-ai/agent/extensions';
import { selectProfile } from '@kite-ai/agent/profile';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { privateDirectory } from '../../../../tests/fixtures/test-filesystem';
import {
  closeWorktreeFixture,
  verifyWorktreeExecutionEvidence,
  worktreeToolContents,
} from '../../../../tests/fixtures/worktree-execution-evidence';
import { persistentWorktreeDirectory } from '../../../../tests/fixtures/worktree-filesystem';
import { createChildConfiguration } from '../../src/child-configuration';
import { createDefaultProcessConfiguration } from '../../src/configuration';
import { defaultTaskRoles } from '../../src/task-configuration';
import { initializeLivePermissionFixture } from '../fixtures/live-permission-fixture';

const native = process.platform === 'darwin' ? test : test.skip;
const receipt = (value: Json | null | undefined) => value as unknown as ToolResult | undefined;
function nativeWithDefaultHome(name: string, run: () => Promise<void>, timeoutMs: number) {
  native(
    name,
    async () => {
      if (process.env.KITE_WORKTREE_HOME_CASE === name) return run();
      const root = persistentWorktreeDirectory('kite-worktree-default-home-');
      const home = join(root, 'home');
      privateDirectory(join(home, '.kite-code'));
      const child = Bun.spawn(
        [
          process.execPath,
          'test',
          '--parallel=1',
          '--max-concurrency=1',
          import.meta.path,
          '--test-name-pattern',
          `^${name}$`,
        ],
        {
          env: {
            ...process.env,
            HOME: home,
            USERPROFILE: home,
            KITE_WORKTREE_HOME_CASE: name,
            KITE_WORKTREE_HOME_ROOT: root,
          },
          stdout: 'pipe',
          stderr: 'pipe',
        },
      );
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect(code, `${stdout}\n${stderr}`).toBe(0);
      expect(stderr).toMatch(/\b1 pass\b/);
      expect(stderr).toMatch(/\b0 fail\b/);
    },
    timeoutMs,
  );
}
type Call = { name: string; arguments: object };
async function until<T>(read: () => Promise<T | null>, label: string): Promise<T> {
  const deadline = Date.now() + 20000;
  for (;;) {
    const value = await read();
    if (value !== null) return value;
    if (Date.now() >= deadline) throw Error(`worktree_permission_fixture_timeout:${label}`);
    await Bun.sleep(10);
  }
}
async function fixture(requirePlan = false, defaultRootCase = false) {
  const root = defaultRootCase
    ? process.env.KITE_WORKTREE_HOME_ROOT
    : persistentWorktreeDirectory('kite-worktree-policy-');
  if (!root) throw Error('default_worktree_isolated_home_required');
  const home = join(root, 'home');
  const defaultRoot = join(home, '.kite-code', 'worktrees');
  if (defaultRootCase) {
    if (homedir() !== home || process.env.HOME !== home || process.env.USERPROFILE !== home)
      throw Error('default_worktree_isolated_home_mismatch');
    const stat = lstatSync(home);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      stat.uid !== process.getuid!() ||
      realpathSync(home) !== home
    )
      throw Error('default_worktree_isolated_home_not_owned_directory');
  }
  const source = join(root, 'source'),
    target = join(root, 'target');
  mkdirSync(source);
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(['/usr/bin/git', ...args], {
      cwd: source,
      env: {
        PATH: '/usr/bin:/bin',
        HOME: source,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_TERMINAL_PROMPT: '0',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    if (result.exitCode) throw Error(`fixture_git:${result.stderr.toString()}`);
    return result.stdout.toString().trim();
  };
  git('init', '-qb', 'main');
  git('config', 'user.name', 'Worktree Permission Fixture');
  git('config', 'user.email', 'worktree@example.invalid');
  writeFileSync(join(source, 'tracked.txt'), 'committed\n');
  git('add', '.');
  git('commit', '-qm', 'base');
  const profile = selectProfile({
    dataRoot: defaultRootCase ? join(home, '.kite-code', 'unified-agent') : join(root, 'data'),
    profile: 'fixture',
  });
  privateDirectory(profile.profilePath);
  const control = defaultRootCase ? profile.coordinationPath : join(root, 'control');
  privateDirectory(control);
  const checks: Record<string, unknown>[] = [];
  const consumedToolContents = new Set<string>();
  let store!: Awaited<ReturnType<typeof openSqliteStore>>;
  let runtime!: ReturnType<typeof createRuntime>;
  const reviewObservations: { rootExists: boolean; jobs: number }[] = [];
  let defaultTarget: string | undefined;
  const steps = new Map<string, number>();
  const seen: string[] = [];
  const calls = (scenario: string): Call[] => {
    const writeScope = { filesystem: 'full_access', network: 'none' };
    if (scenario.startsWith('default-create'))
      return [
        {
          name: 'git_worktree',
          arguments: {
            action: 'create',
            key: scenario,
            newBranch: scenario,
            permissions:
              scenario === 'default-create-workspace'
                ? { filesystem: 'workspace_write', network: 'none' }
                : writeScope,
          },
        },
      ];
    if (scenario === 'default-remove') {
      if (!defaultTarget) throw Error('default_worktree_receipt_missing');
      return [
        {
          name: 'git_worktree',
          arguments: {
            action: 'remove',
            key: scenario,
            path: defaultTarget,
            permissions: writeScope,
          },
        },
      ];
    }
    if (scenario === 'parent-worker-auto' || scenario === 'parent-worker-manual')
      return [
        { name: 'spawn_agent', arguments: { prompt: `WORKTREE_WRITABLE:${scenario.slice(14)}` } },
      ];
    if (scenario === 'auto-list') return [{ name: 'git_worktree', arguments: { action: 'list' } }];
    if (scenario === 'auto-create')
      return [
        {
          name: 'git_worktree',
          arguments: {
            action: 'create',
            key: 'auto-create',
            path: target,
            permissions: writeScope,
          },
        },
      ];
    if (scenario === 'auto-remove')
      return [
        {
          name: 'git_worktree',
          arguments: {
            action: 'remove',
            key: 'auto-remove',
            path: target,
            permissions: writeScope,
          },
        },
      ];
    if (scenario.startsWith('parent-'))
      return [
        {
          name: 'spawn_agent',
          arguments: { preset: scenario.slice(7), prompt: `WORKTREE_CHILD:${scenario.slice(7)}` },
        },
      ];
    if (scenario.startsWith('child-'))
      return [
        { name: 'git_worktree', arguments: { action: 'list' } },
        {
          name: 'git_worktree',
          arguments: {
            action: 'create',
            key: 'forbidden-create',
            path: join(root, `${scenario}-target`),
            permissions: writeScope,
          },
        },
        {
          name: 'git_worktree',
          arguments: {
            action: 'remove',
            key: 'forbidden-remove',
            path: target,
            permissions: writeScope,
          },
        },
      ];
    if (scenario === 'planning')
      return [
        { name: 'git_worktree', arguments: { action: 'list' } },
        {
          name: 'git_worktree',
          arguments: {
            action: 'create',
            key: 'plan-create',
            path: target,
            permissions: writeScope,
          },
        },
      ];
    throw Error(`unknown_worktree_permission_case:${scenario}`);
  };
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as { messages: { role: string; content: string }[] };
      const users = body.messages
        .filter((message) => message.role === 'user')
        .map((message) => message.content);
      let authorization: Record<string, unknown> | undefined;
      for (const value of users) {
        try {
          const decoded = JSON.parse(value);
          if (decoded.purpose === 'authorization_check') authorization = decoded;
        } catch {}
      }
      for (const content of worktreeToolContents(body.messages)) consumedToolContents.add(content);
      let script: Call[] = [];
      let content = 'Observed the original worktree result.';
      if (authorization) {
        if (defaultRootCase)
          reviewObservations.push({
            rootExists: existsSync(defaultRoot),
            jobs: (await store.listExecutions('default-create')).filter((row) => row.kind === 'job')
              .length,
          });
        checks.push(authorization);
        content = JSON.stringify({
          decision: 'approve_once',
          reason: 'Exact fixture worktree action is authorized.',
        });
      } else {
        const child = users.join('\n').match(/WORKTREE_CHILD:(explore)/)?.[1];
        const writable = users.join('\n').match(/WORKTREE_WRITABLE:(auto|manual)/)?.[1];
        const parent = users.join('\n').match(/WORKTREE_CASE:([a-z-]+)/)?.[1];
        const scenario = writable ? `writable-${writable}` : child ? `child-${child}` : parent;
        if (!scenario) throw Error(`worktree_permission_case_missing:${JSON.stringify(users)}`);
        seen.push(scenario);
        const step = steps.get(scenario) ?? 0;
        steps.set(scenario, step + 1);
        if (writable && step < 2) {
          if (defaultRootCase && step === 1) {
            const parentSession = `parent-worker-${writable}`;
            const carrier = (await store.listExecutions(parentSession)).find(
              (row) => row.definitionId === 'agent/general',
            );
            const created = carrier?.childSessionId
              ? (await store.listExecutions(carrier.childSessionId)).find(
                  (row) => row.definitionId === 'git.worktree',
                )
              : undefined;
            const details = receipt(created?.result)?.details as Record<string, Json> | undefined;
            if (
              receipt(created?.result)?.outcome !== 'succeeded' ||
              typeof details?.path !== 'string'
            )
              throw Error('default_child_worktree_receipt_missing');
            defaultTarget = details.path;
          }
          script = [
            {
              name: 'git_worktree',
              arguments: {
                action: step === 0 ? 'create' : 'remove',
                key: `${scenario}-${step === 0 ? 'create' : 'remove'}`,
                ...(defaultRootCase
                  ? step === 1
                    ? { path: defaultTarget }
                    : {}
                  : { path: target }),
                permissions: { filesystem: 'full_access', network: 'none' },
                ...(step === 0 ? { newBranch: `${scenario}-branch` } : {}),
              },
            },
          ];
        } else if (!writable && step === 0) script = calls(scenario);
      }
      const delta = script.length
        ? {
            tool_calls: script.map((call, index) => ({
              index,
              id: `call-${seen.at(-1)}-${index}`,
              type: 'function',
              function: { name: call.name, arguments: JSON.stringify(call.arguments) },
            })),
          }
        : { content };
      const chunk = (value: object, reason: string | null) =>
        `data: ${JSON.stringify({ id: 'fixed', object: 'chat.completion.chunk', created: 1, model: 'fixed', choices: [{ index: 0, delta: value, finish_reason: reason }] })}\n\n`;
      return new Response(
        `${chunk(delta, null)}${chunk({}, script.length ? 'tool_calls' : 'stop')}data: [DONE]\n\n`,
        { headers: { 'content-type': 'text/event-stream' } },
      );
    },
  });
  try {
    const config = defaultRootCase
      ? join(home, '.kite-code', 'kite-code.jsonc')
      : join(profile.profilePath, 'config.jsonc');
    writeFileSync(
      config,
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
        tools: ['git.worktree', 'task.spawn'].map((id) => ({ id, definitionVersion: '1' })),
        ...(requirePlan ? { planning: { requirePlan: true } } : {}),
      }),
    );
    const built = await Bun.build({
      entrypoints: [
        join(
          import.meta.dir,
          '../../../../packages/agent/src/platform/process/shell-supervisor.ts',
        ),
      ],
      outdir: join(root, 'assets'),
      target: 'bun',
      naming: 'shell-supervisor.js',
    });
    expect(built.success).toBe(true);
    const host = createDefaultProcessConfiguration({
      profile,
      userConfigurationPath: config,
      localCodex: false,
      browser: false,
      credentialBackend: createTemporaryCredentialBackend(),
      ...(requirePlan ? { planning: { requirePlan: true } } : {}),
      shell: {
        platform: 'darwin',
        configurationId: 'worktree-permission-fixture',
        env: { PATH: '/usr/bin:/bin', HOME: defaultRootCase ? home : source },
        supervisorPath: built.outputs[0]!.path,
        bunExecutable: process.execPath,
        shellExecutable: '/bin/sh',
        host: {
          controlBase: control,
          protectedRoots: [],
          readonlyAssets: [],
          runtimeReadOnlyRoots: [],
        },
      },
    });
    store = await openSqliteStore(profile);
    runtime = createRuntime({
      ...host,
      permissions: host.permissions!,
      store,
      artifacts: createArtifactStore({ profile, store }),
      processConcurrency: 1,
      modelConcurrency: 1,
    });
    host.permissionManagement!(runtime);
    const expectedStoreId = (await store.getMetadata()).storeId;
    await runtime.createWorkspace({
      expectedStoreId,
      id: 'source',
      rootUri: pathToFileURL(source).href,
      name: 'source',
    });
    async function run(scenario: string, mode: 'accept_edits' | 'auto' | 'full') {
      if (scenario === 'default-remove') {
        const created = (await store.listExecutions('default-create')).find(
          (row) => row.definitionId === 'git.worktree',
        );
        const details = receipt(created?.result)?.details as Record<string, Json> | undefined;
        if (receipt(created?.result)?.outcome !== 'succeeded' || typeof details?.path !== 'string')
          throw Error('default_worktree_receipt_missing');
        defaultTarget = details.path;
      }
      const base = { expectedStoreId, subjectId: 'owner', sessionId: scenario };
      await runtime.createSession({
        ...base,
        workspaceId: 'source',
        commandId: `create-${scenario}`,
        title: scenario,
      });
      await initializeLivePermissionFixture({
        runtime,
        profile,
        ...base,
        workspaceId: 'source',
        mode,
        trusted: true,
        nativeShellRead: true,
      });
      await runtime.submitCommand({
        ...base,
        commandId: scenario,
        request: { kind: 'run.start', content: `WORKTREE_CASE:${scenario}` },
      });
      const approvals: string[] = [];
      if (mode === 'accept_edits') {
        await until(async () => {
          const pending = await runtime.listInteractions({
            expectedStoreId,
            sessionId: scenario,
            state: 'pending',
          });
          for (const card of pending.interactions) {
            if (approvals.includes(card.id)) continue;
            expect(card.kind).toBe('approval');
            expect(card.definitionId).toBe('git.worktree');
            expect(card.definitionVersion).toBe('1');
            const execution = await store.getExecution(card.executionId);
            expect(execution).toMatchObject({
              kind: 'tool',
              status: 'planned',
              authorization: { dispatched: false },
            });
            expect(
              (await store.listExecutions(scenario)).filter((row) => row.kind === 'job'),
            ).toHaveLength(0);
            if (defaultRootCase) {
              expect(existsSync(defaultRoot)).toBe(scenario === 'default-remove');
              if (scenario === 'default-remove') expect(existsSync(defaultTarget!)).toBe(true);
            } else expect(existsSync(target)).toBe(scenario === 'auto-remove');
            await runtime.answerInteraction({
              expectedStoreId,
              commandId: `answer-${scenario}-${card.id}`,
              presentationSessionId: card.presentationSessionId,
              interactionId: card.id,
              expectedRevision: card.revision,
              subjectId: 'owner',
              answer: { kind: 'approval', decision: 'approve', grant: 'approve_once' },
            });
            approvals.push(card.id);
          }
          const command = await store.getCommand(scenario);
          const runId = (command?.receipt as { runId?: string } | undefined)?.runId;
          const current = runId ? await store.getRun(runId) : null;
          return current && !current.isActive ? true : null;
        }, 'one business approval');
      }
      if (requirePlan) {
        const tools = await until(async () => {
          const rows = (await store.listExecutions(scenario)).filter(
            (row) => row.definitionId === 'git.worktree',
          );
          return rows.length === 2 &&
            rows.every((row) => row.status === 'succeeded' || row.status === 'failed')
            ? rows
            : null;
        }, 'planning tools');
        // The fixture deliberately does not supply a Plan. End its still-pending
        // completion requirement after observing both exact permission outcomes.
        await runtime.cancelRun({
          ...base,
          commandId: 'cancel-planning-fixture',
          runId: tools[0]!.runId!,
        });
      }
      const command = await runtime.waitForCommand(scenario, { timeoutMs: 20000 });
      await verifyWorktreeExecutionEvidence(
        store,
        scenario,
        requirePlan ? undefined : consumedToolContents,
      );
      return { command, executions: await store.listExecutions(scenario), approvals };
    }
    async function runWritableChild(mode: 'accept_edits' | 'auto') {
      const scenario = `parent-worker-${mode === 'auto' ? 'auto' : 'manual'}`;
      const base = { expectedStoreId, subjectId: 'owner', sessionId: scenario };
      await runtime.createSession({
        ...base,
        workspaceId: 'source',
        commandId: `create-${scenario}`,
        title: scenario,
      });
      await initializeLivePermissionFixture({
        runtime,
        profile,
        ...base,
        workspaceId: 'source',
        mode,
        trusted: true,
        nativeShellRead: true,
      });
      await runtime.submitCommand({
        ...base,
        commandId: scenario,
        request: { kind: 'run.start', content: `WORKTREE_CASE:${scenario}` },
      });
      const approvals: string[] = [];
      const result = await until(async () => {
        const parentExecutions = await store.listExecutions(scenario);
        const carrier = parentExecutions.find(
          (row) => row.definitionId === 'agent/general' && row.childSessionId,
        );
        const pending = await runtime.listInteractions({
          expectedStoreId,
          sessionId: scenario,
          origin: 'all',
          state: 'pending',
        });
        for (const card of pending.interactions) {
          expect(mode).toBe('accept_edits');
          expect(card.kind).toBe('approval');
          expect(card.definitionId).toBe('git.worktree');
          expect(card.sessionId).toBe(carrier!.childSessionId!);
          expect(card.presentationSessionId).toBe(scenario);
          const execution = (await store.getExecution(card.executionId))!;
          expect(execution).toMatchObject({
            kind: 'tool',
            status: 'planned',
            authorization: { dispatched: false },
          });
          const removing = (execution.input as { action: string }).action === 'remove';
          if (defaultRootCase) {
            expect(existsSync(defaultRoot)).toBe(removing);
            if (removing) expect(existsSync(defaultTarget!)).toBe(true);
          } else expect(existsSync(target)).toBe(removing);
          await runtime.answerInteraction({
            expectedStoreId,
            commandId: `answer-${card.id}`,
            presentationSessionId: scenario,
            interactionId: card.id,
            expectedRevision: card.revision,
            subjectId: 'owner',
            answer: { kind: 'approval', decision: 'approve', grant: 'approve_once' },
          });
          approvals.push(card.id);
        }
        if (
          !carrier?.childSessionId ||
          !['succeeded', 'failed', 'cancelled'].includes(carrier.status)
        )
          return null;
        return {
          carrier,
          parentExecutions,
          executions: await store.listExecutions(carrier.childSessionId),
        };
      }, 'writable general business authorization');
      await verifyWorktreeExecutionEvidence(
        store,
        result.carrier.childSessionId!,
        consumedToolContents,
      );
      return { ...result, approvals };
    }
    return {
      root,
      source,
      target,
      home,
      defaultRoot,
      config,
      reviewObservations,
      checks,
      seen,
      run,
      runWritableChild,
      store,
      runtime,
      git,
      verifySession(sessionId: string) {
        return verifyWorktreeExecutionEvidence(store, sessionId, consumedToolContents);
      },
      async close(primaryError?: unknown) {
        await closeWorktreeFixture({ runtime, store, server }, primaryError);
      },
    };
  } catch (error) {
    await closeWorktreeFixture({ runtime, store, server }, error);
    throw error;
  }
}

test('default HOME mismatch refuses fixture setup before any repository or provider exists', async () => {
  const root = persistentWorktreeDirectory('kite-worktree-home-preflight-');
  const previous = process.env.KITE_WORKTREE_HOME_ROOT;
  process.env.KITE_WORKTREE_HOME_ROOT = root;
  try {
    await expect(fixture(false, true)).rejects.toThrow('default_worktree_isolated_home_mismatch');
    expect(existsSync(join(root, 'source'))).toBe(false);
    expect(existsSync(join(root, 'home'))).toBe(false);
    expect(existsSync(join(root, 'data'))).toBe(false);
  } finally {
    if (previous === undefined) delete process.env.KITE_WORKTREE_HOME_ROOT;
    else process.env.KITE_WORKTREE_HOME_ROOT = previous;
  }
});

test('initialization and Runtime close failures stop the fixture server and retain the original error', async () => {
  for (const runtimeCloseFails of [false, true]) {
    const server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: () => new Response('fixture'),
    });
    const url = server.url;
    const primary = Error('injected fixture initialization failure');
    const closeError = Error('injected Runtime close failure');
    let closes = 0;
    const close = async () => {
      closes++;
      if (runtimeCloseFails) throw closeError;
    };
    const failure = await closeWorktreeFixture(
      runtimeCloseFails ? { runtime: { close }, server } : { store: { close }, server },
      primary,
    ).catch((error: unknown) => error);
    expect(closes).toBe(1);
    if (runtimeCloseFails) {
      expect(failure).toBeInstanceOf(AggregateError);
      expect((failure as AggregateError).cause).toBe(primary);
      expect((failure as AggregateError).errors).toEqual([primary, closeError]);
    } else expect(failure).toBe(primary);
    await expect(fetch(url, { signal: AbortSignal.timeout(1000) })).rejects.toThrow();
  }
});

native(
  'actual fixture closes once and retains both test body and Runtime close errors',
  async () => {
    const f = await fixture();
    const primary = Error('injected test body failure');
    const secondary = Error('injected post-Runtime-close failure');
    const originalClose = f.runtime.close.bind(f.runtime);
    // Complete real Runtime teardown before injecting a failure; no live handle is abandoned.
    const closing = spyOn(f.runtime, 'close').mockImplementation(async () => {
      await originalClose();
      throw secondary;
    });
    const attempt = async () => {
      let bodyError: unknown;
      try {
        throw primary;
      } catch (error) {
        bodyError = error;
      } finally {
        await f.close(bodyError);
      }
    };
    try {
      const failure = await attempt().catch((error: unknown) => error);
      expect(closing).toHaveBeenCalledTimes(1);
      expect(failure).toBeInstanceOf(AggregateError);
      expect((failure as AggregateError).cause).toBe(primary);
      expect((failure as AggregateError).errors).toEqual([primary, secondary]);
      const url = (JSON.parse(readFileSync(f.config, 'utf8')) as { models: { baseURL: string }[] })
        .models[0]!.baseURL;
      const response = await fetch(url, { signal: AbortSignal.timeout(1000) }).catch(
        (error: unknown) => error,
      );
      expect(response).toBeInstanceOf(Error);
    } finally {
      closing.mockRestore();
    }
  },
);

native(
  'Auto list skips review; create/remove use generic original-action authorization through real Shell Jobs',
  async () => {
    const f = await fixture();
    let bodyError: unknown;
    try {
      const list = await f.run('auto-list', 'auto');
      expect(list.command.status).toBe('applied');
      expect(
        list.executions.find((row) => row.definitionId === 'git.worktree')?.result,
      ).toMatchObject({ outcome: 'succeeded' });
      expect(f.checks).toHaveLength(0);
      const created = await f.run('auto-create', 'auto');
      expect(created.command.status).toBe('applied');
      expect(
        created.executions.find((row) => row.definitionId === 'git.worktree')?.result,
      ).toMatchObject({ outcome: 'succeeded', details: { mutation: 'completed' } });
      expect(existsSync(f.target)).toBe(true);
      const removed = await f.run('auto-remove', 'auto');
      expect(removed.command.status).toBe('applied');
      expect(
        removed.executions.find((row) => row.definitionId === 'git.worktree')?.result,
      ).toMatchObject({ outcome: 'succeeded', details: { mutation: 'completed' } });
      expect(existsSync(f.target)).toBe(false);
      expect(f.checks).toHaveLength(2);
      expect(
        f.checks.every(
          (check) => check.reviewPurpose === undefined && check.purpose === 'authorization_check',
        ),
      ).toBe(true);
      expect(
        [...created.executions, ...removed.executions].filter(
          (row) => row.definitionId === 'shell.command',
        ),
      ).toHaveLength(4);
      for (const operation of [created, removed]) {
        const tool = operation.executions.find((row) => row.definitionId === 'git.worktree')!;
        expect(tool.authorization).toMatchObject({
          dispatched: true,
          check: { status: 'succeeded', decision: 'approve_once' },
        });
        for (const job of operation.executions.filter(
          (row) => row.definitionId === 'shell.command',
        ))
          expect(job.authorization).toMatchObject({
            dispatched: true,
            policy: {
              reason: 'parent_review',
              sourceExecutionId: tool.id,
              effectiveScope: { filesystem: 'full_access', network: 'none' },
            },
          });
        expect(operation.approvals).toHaveLength(0);
      }
    } catch (error) {
      bodyError = error;
    } finally {
      await f.close(bodyError);
    }
  },
  90000,
);

native(
  'manual worktree business approval covers only its original prepare and mutation Jobs',
  async () => {
    const f = await fixture();
    let bodyError: unknown;
    try {
      const created = await f.run('auto-create', 'accept_edits');
      expect(created.command.status).toBe('applied');
      expect(existsSync(f.target)).toBe(true);
      const removed = await f.run('auto-remove', 'accept_edits');
      expect(removed.command.status).toBe('applied');
      expect(existsSync(f.target)).toBe(false);
      expect(f.checks).toHaveLength(0);
      for (const operation of [created, removed]) {
        expect(operation.approvals).toHaveLength(1);
        const tool = operation.executions.find((row) => row.definitionId === 'git.worktree')!;
        expect(tool.result).toMatchObject({
          outcome: 'succeeded',
          details: { mutation: 'completed', cwdChanged: false },
        });
        expect(tool.authorization).toMatchObject({
          dispatched: true,
          human: { state: 'answered', decision: 'approve' },
        });
        const jobs = operation.executions.filter((row) => row.definitionId === 'shell.command');
        expect(jobs).toHaveLength(2);
        for (const job of jobs)
          expect(job.authorization).toMatchObject({
            dispatched: true,
            policy: {
              reason: 'parent_review',
              sourceExecutionId: tool.id,
              effectiveScope: { filesystem: 'full_access', network: 'none' },
            },
          });
      }
    } catch (error) {
      bodyError = error;
    } finally {
      await f.close(bodyError);
    }
  },
  90000,
);

for (const mode of ['accept_edits', 'auto'] as const)
  nativeWithDefaultHome(
    `default persistent target uses the original ${mode} business decision without Shell root masks`,
    async () => {
      const f = await fixture(false, true);
      let bodyError: unknown;
      try {
        const sourceHead = f.git('rev-parse', 'HEAD');
        const sourceContent = readFileSync(join(f.source, 'tracked.txt'), 'utf8');
        const configBefore = readFileSync(f.config, 'utf8');
        expect(existsSync(f.defaultRoot)).toBe(false);
        const created = await f.run('default-create', mode);
        const tool = created.executions.find((row) => row.definitionId === 'git.worktree')!;
        expect(tool.result).toMatchObject({
          outcome: 'succeeded',
          details: {
            action: 'create',
            mutation: 'completed',
            cwdChanged: false,
            head: sourceHead,
            branch: 'refs/heads/default-create',
            detached: false,
          },
        });
        expect(tool.input).not.toHaveProperty('path');
        const path = (receipt(tool.result)!.details as Record<string, Json>).path as string;
        expect(dirname(path)).toBe(f.defaultRoot);
        expect(existsSync(path)).toBe(true);
        expect(readFileSync(join(path, 'tracked.txt'), 'utf8')).toBe(sourceContent);
        const run = await f.store.getRun(tool.runId!);
        const sealed = run!.configuration as {
          snapshot: {
            shell: {
              assets: {
                gitWorktree: { configuration: { defaultRoot: string; sourceCwd: string } };
              };
            };
          };
        };
        expect(sealed.snapshot.shell.assets.gitWorktree.configuration).toMatchObject({
          defaultRoot: f.defaultRoot,
          sourceCwd: f.source,
        });
        if (mode === 'auto')
          expect(f.reviewObservations[0]).toEqual({ rootExists: false, jobs: 0 });
        const removed = await f.run('default-remove', mode);
        const remove = removed.executions.find((row) => row.definitionId === 'git.worktree')!;
        expect(remove.input).toMatchObject({ action: 'remove', path });
        expect(remove.result).toMatchObject({
          outcome: 'succeeded',
          details: {
            action: 'remove',
            path,
            mutation: 'completed',
            cwdChanged: false,
          },
        });
        expect(existsSync(path)).toBe(false);
        expect(f.git('rev-parse', 'refs/heads/default-create')).toBe(sourceHead);
        expect(f.git('symbolic-ref', 'HEAD')).toBe('refs/heads/main');
        expect(f.git('rev-parse', 'HEAD')).toBe(sourceHead);
        expect(readFileSync(join(f.source, 'tracked.txt'), 'utf8')).toBe(sourceContent);
        expect(readFileSync(f.config, 'utf8')).toBe(configBefore);
        expect(f.checks).toHaveLength(mode === 'auto' ? 2 : 0);
        for (const operation of [created, removed]) {
          expect(operation.command.status).toBe('applied');
          expect(operation.approvals).toHaveLength(mode === 'accept_edits' ? 1 : 0);
          const owner = operation.executions.find((row) => row.definitionId === 'git.worktree')!;
          const jobs = operation.executions.filter((row) => row.definitionId === 'shell.command');
          expect(jobs).toHaveLength(2);
          for (const job of jobs) {
            expect(job.parentExecutionId).toBe(owner.id);
            expect(job.status).toBe('succeeded');
            expect(job.authorization).toMatchObject({
              dispatched: true,
              policy: {
                reason: 'parent_review',
                sourceExecutionId: owner.id,
                effectiveScope: { filesystem: 'full_access', network: 'none' },
              },
            });
            expect(job.authorization?.check).toBeUndefined();
            expect(job.authorization?.human).toBeUndefined();
          }
          expect((await f.store.getSession(owner.sessionId))?.workspaceId).toBe('source');
        }
      } catch (error) {
        bodyError = error;
      } finally {
        await f.close(bodyError);
      }
    },
    90000,
  );

nativeWithDefaultHome(
  'workspace_write default target stays outside the approved write scope and creates no root or branch',
  async () => {
    const f = await fixture(false, true);
    let bodyError: unknown;
    try {
      const sourceHead = f.git('rev-parse', 'HEAD');
      const result = await f.run('default-create-workspace', 'full');
      const tool = result.executions.find((row) => row.definitionId === 'git.worktree')!;
      expect(receipt(tool.result)?.outcome).toBe('failed');
      expect(receipt(tool.result)?.details).toMatchObject({
        mutation: 'not_started',
        cwdChanged: false,
      });
      expect(existsSync(f.defaultRoot)).toBe(false);
      expect(f.git('branch', '--list', 'default-create-workspace')).toBe('');
      expect(f.git('rev-parse', 'HEAD')).toBe(sourceHead);
      const jobs = result.executions.filter((row) => row.definitionId === 'shell.command');
      expect(jobs).toHaveLength(2);
      for (const job of jobs) {
        expect(job.input).toMatchObject({
          permissions: {
            filesystem: 'workspace_write',
            network: 'none',
          },
        });
        expect(job.authorization?.dispatched).toBe(true);
      }
      expect(f.checks).toHaveLength(0);
    } catch (error) {
      bodyError = error;
    } finally {
      await f.close(bodyError);
    }
  },
  90000,
);

for (const mode of ['accept_edits', 'auto'] as const)
  nativeWithDefaultHome(
    `actual default general preserves ${mode} business authorization through parent-child permission composition`,
    async () => {
      const f = await fixture(false, true);
      let bodyError: unknown;
      try {
        const result = await f.runWritableChild(mode);
        expect(result.carrier.status).toBe('succeeded');
        expect(
          result.parentExecutions.filter((row) => row.definitionId === 'task.spawn'),
        ).toHaveLength(1);
        expect(
          result.parentExecutions.filter((row) => row.definitionId === 'git.worktree'),
        ).toHaveLength(0);
        const tools = result.executions.filter((row) => row.definitionId === 'git.worktree');
        const jobs = result.executions.filter((row) => row.definitionId === 'shell.command');
        expect(tools).toHaveLength(2);
        const createdPath = (receipt(tools[0]!.result)!.details as Record<string, Json>)
          .path as string;
        expect(tools[0]!.input).not.toHaveProperty('path');
        expect(dirname(createdPath)).toBe(f.defaultRoot);
        expect(tools[1]!.input).toMatchObject({ path: createdPath });
        expect(existsSync(createdPath)).toBe(false);
        expect(jobs).toHaveLength(4);
        expect(result.approvals).toHaveLength(mode === 'auto' ? 0 : 2);
        expect(f.checks).toHaveLength(mode === 'auto' ? 2 : 0);
        for (const tool of tools) {
          expect(tool.result).toMatchObject({
            outcome: 'succeeded',
            details: { mutation: 'completed', cwdChanged: false },
          });
          expect(tool.sessionId).toBe(result.carrier.childSessionId!);
          if (mode === 'auto')
            expect(tool.authorization?.check).toMatchObject({
              status: 'succeeded',
              decision: 'approve_once',
            });
          else
            expect(tool.authorization?.human).toMatchObject({
              accepted: true,
              decision: 'approve',
              grant: 'approve_once',
            });
          const internal = jobs.filter((job) => job.parentExecutionId === tool.id);
          expect(internal).toHaveLength(2);
          for (const job of internal) {
            expect(job.status).toBe('succeeded');
            expect(job.authorization).toMatchObject({
              dispatched: true,
              policy: {
                reason: 'parent_review',
                sourceExecutionId: tool.id,
                effectiveScope: { filesystem: 'full_access', network: 'none' },
              },
            });
            expect(job.authorization?.human).toBeUndefined();
            expect(job.authorization?.check).toBeUndefined();
            expect(job.authorization?.policy?.checkExecutionId).toBe(
              mode === 'auto' ? tool.authorization?.check?.executionId : undefined,
            );
          }
        }
        expect(existsSync(f.target)).toBe(false);
        expect(
          f.git('rev-parse', `refs/heads/writable-${mode === 'auto' ? 'auto' : 'manual'}-branch`),
        ).toBe(f.git('rev-parse', 'HEAD'));
      } catch (error) {
        bodyError = error;
      } finally {
        await f.close(bodyError);
      }
    },
    90000,
  );

native(
  'real explore child retains list and rejects create/remove even under inherited Full',
  async () => {
    const f = await fixture();
    let bodyError: unknown;
    try {
      for (const role of ['explore']) {
        const parent = await f.run(`parent-${role}`, 'full');
        expect(parent.command.status).toBe('applied');
        const carrier = await until(
          async () =>
            (await f.store.listExecutions(`parent-${role}`)).find(
              (row) =>
                row.definitionId === `agent/${role}` &&
                row.childSessionId &&
                ['succeeded', 'failed'].includes(row.status),
            ) ?? null,
          role,
        );
        const executions = await f.store.listExecutions(carrier.childSessionId!);
        await f.verifySession(carrier.childSessionId!);
        const results = executions
          .filter((row) => row.definitionId === 'git.worktree')
          .map((row) => row.result);
        expect(results, JSON.stringify({ role, results, seen: f.seen })).toHaveLength(3);
        expect(results[0]).toMatchObject({ outcome: 'succeeded', details: { action: 'list' } });
        for (const result of results.slice(1)) expect(result).toMatchObject({ outcome: 'failed' });
        expect(executions.filter((row) => row.definitionId === 'shell.command')).toHaveLength(1);
        expect(existsSync(join(f.root, `child-${role}-target`))).toBe(false);
        expect(existsSync(f.target)).toBe(false);
      }
      expect(f.checks).toHaveLength(0);
    } catch (error) {
      bodyError = error;
    } finally {
      await f.close(bodyError);
    }
  },
  90000,
);

test('read-only Service child selection binds exact builtin.shell/git.worktree/1 and excludes impostors', async () => {
  const configured = createChildConfiguration({
    roles: defaultTaskRoles,
    async resolve(_input, selection) {
      return {
        model: {
          stream() {
            throw Error('provider_must_not_run');
          },
        },
        modelId: selection.modelId,
        toolIds: selection.role.toolIds,
        snapshot: null,
      };
    },
  });
  for (const role of ['explore']) {
    for (const binding of [
      { extensionId: 'builtin.shell', id: 'git.worktree', version: '1' },
      { extensionId: 'custom.shell', id: 'git.worktree', version: '1' },
      { extensionId: 'builtin.shell', id: 'git.worktree', version: '2' },
    ]) {
      const request = {
        configurationId: role,
        signal: new AbortController().signal,
        parentTools: [binding],
        parentRun: { configuration: { modelId: 'fixed', tools: [binding] } },
      } as unknown as Parameters<NonNullable<typeof configured.resolveChildRunConfiguration>>[0];
      const selected = await configured.resolveChildRunConfiguration!(request);
      expect(selected.toolIds).toEqual(
        binding.extensionId === 'builtin.shell' && binding.version === '1' ? ['git.worktree'] : [],
      );
    }
  }
});

native(
  'required planning permits exact list but does not dispatch a worktree mutation before plan approval',
  async () => {
    const f = await fixture(true);
    let bodyError: unknown;
    try {
      const result = await f.run('planning', 'full');
      const tools = result.executions.filter((row) => row.definitionId === 'git.worktree');
      expect(tools).toHaveLength(2);
      expect(tools[0]!.result).toMatchObject({ outcome: 'succeeded' });
      expect(tools[1]!.result).toMatchObject({ outcome: 'failed' });
      expect(JSON.stringify(tools[1]!.result)).toContain('plan_approval_required');
      expect(result.executions.filter((row) => row.definitionId === 'shell.command')).toHaveLength(
        1,
      );
      expect(existsSync(f.target)).toBe(false);
      const required = await f.store.getExtensionRecord({
        sessionId: 'planning',
        extensionId: 'builtin.planning',
        key: `run/${tools[0]!.runId}/plan.required`,
      });
      expect(required?.value as Json).toBeDefined();
    } catch (error) {
      bodyError = error;
    } finally {
      await f.close(bodyError);
    }
  },
  60000,
);
