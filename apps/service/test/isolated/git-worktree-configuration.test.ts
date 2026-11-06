import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { type AgentRuntime, createRuntime } from '@kite-ai/agent';
import { createTemporaryCredentialBackend } from '@kite-ai/agent/config';
import { selectProfile } from '@kite-ai/agent/profile';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import type { ChangeEvent } from '@kite-ai/agent/storage';
import { privateDirectory } from '../../../../tests/fixtures/test-filesystem';
import {
  closeWorktreeFixture,
  verifyWorktreeExecutionEvidence,
  worktreeToolContents,
} from '../../../../tests/fixtures/worktree-execution-evidence';
import { persistentWorktreeDirectory } from '../../../../tests/fixtures/worktree-filesystem';
import { createDefaultProcessConfiguration } from '../../src/configuration';
import { createWorktreeHost } from '../../src/worktree-host';
import { initializeLivePermissionFixture } from '../fixtures/live-permission-fixture';

const native = process.platform === 'darwin' ? test : test.skip;
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
  if (result.exitCode) throw new Error(`fixture_git:${result.stderr.toString()}`);
  return result.stdout.toString().trim();
}
native(
  'only git.worktree reaches real Shell Jobs for list/create/remove with original cwd and replay protection',
  async () => {
    const root = persistentWorktreeDirectory('kite-service-worktree-');
    const source = join(root, 'source'),
      target = join(root, "中文 target\nwith quote'");
    mkdirSync(source);
    git(source, 'init', '-b', 'main');
    git(source, 'config', 'user.name', 'Worktree Fixture');
    git(source, 'config', 'user.email', 'worktree@example.invalid');
    writeFileSync(join(source, 'tracked.txt'), 'committed\n');
    git(source, 'add', 'tracked.txt');
    git(source, 'commit', '-m', 'initial');
    const head = git(source, 'rev-parse', 'HEAD');
    writeFileSync(join(source, 'tracked.txt'), 'local unstaged source\n');
    const profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'worktree' });
    privateDirectory(profile.profilePath);
    privateDirectory(join(root, 'control'));
    const requestTools: string[][] = [];
    const consumedToolContents = new Set<string>();
    const requests: Record<string, unknown> = {
      list: { action: 'list' },
      scopeDenied: {
        action: 'create',
        key: 'scope-denied',
        path: target,
        newBranch: 'must-not-exist',
      },
      create: {
        action: 'create',
        key: 'create-branch',
        path: target,
        newBranch: 'fixture-branch',
        permissions: { filesystem: 'full_access', network: 'none' },
      },
      remove: {
        action: 'remove',
        key: 'remove-branch',
        path: target,
        permissions: { filesystem: 'full_access', network: 'none' },
      },
      replay: {
        action: 'remove',
        key: 'remove-branch',
        path: target,
        permissions: { filesystem: 'full_access', network: 'none' },
      },
    };
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        const body = (await request.json()) as {
          messages: { role: string; content: string }[];
          tools?: { function: { name: string } }[];
        };
        requestTools.push((body.tools ?? []).map((tool) => tool.function.name));
        for (const content of worktreeToolContents(body.messages))
          consumedToolContents.add(content);
        const last = body.messages.reduce(
          (found, message, index) =>
            message.role === 'user' && message.content.startsWith('新任务：') ? index : found,
          -1,
        );
        const action = body.messages[last]?.content.slice('新任务：'.length) ?? '';
        const done = body.messages.slice(last + 1).some((message) => message.role === 'tool');
        const call = !done && requests[action];
        const delta = call
          ? {
              tool_calls: [
                {
                  index: 0,
                  id: `call-${action}`,
                  type: 'function',
                  function: { name: 'git_worktree', arguments: JSON.stringify(call) },
                },
              ],
            }
          : { content: 'Observed the original operation result.' };
        const chunk = (value: object, reason: string | null) =>
          `data: ${JSON.stringify({ id: 'local', object: 'chat.completion.chunk', created: 1, model: 'fixed', choices: [{ index: 0, delta: value, finish_reason: reason }] })}\n\n`;
        return new Response(
          chunk(delta, null) + chunk({}, call ? 'tool_calls' : 'stop') + 'data: [DONE]\n\n',
          { headers: { 'content-type': 'text/event-stream' } },
        );
      },
    });
    let store: Awaited<ReturnType<typeof openSqliteStore>> | undefined;
    let runtime: AgentRuntime | undefined;
    let bodyError: unknown;
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
          tools: [{ id: 'git.worktree', definitionVersion: '1' }],
        }),
      );
      const supervisor = await Bun.build({
        entrypoints: [
          join(
            import.meta.dir,
            '../../../../packages/agent/src/platform/process/shell-supervisor.ts',
          ),
        ],
        outdir: join(root, 'assets'),
        naming: 'shell-supervisor.js',
        target: 'bun',
      });
      expect(supervisor.success).toBe(true);
      const host = createDefaultProcessConfiguration({
        profile,
        userConfigurationPath: join(profile.profilePath, 'config.jsonc'),
        localCodex: false,
        credentialBackend: createTemporaryCredentialBackend(),
        shell: {
          platform: 'darwin',
          configurationId: 'worktree-service-fixture',
          env: { PATH: '/usr/bin:/bin', HOME: source },
          supervisorPath: supervisor.outputs[0]!.path,
          bunExecutable: process.execPath,
          shellExecutable: '/bin/sh',
          host: {
            controlBase: join(root, 'control'),
            protectedRoots: [profile.dataRoot, join(root, 'control')],
            readonlyAssets: [join(root, 'assets')],
            runtimeReadOnlyRoots: [dirname(process.execPath)],
          },
        },
      });
      store = await openSqliteStore({ dataRoot: profile.dataRoot, profile: profile.profile });
      runtime = createRuntime({
        ...host,
        permissions: host.permissions!,
        store,
        processConcurrency: 1,
        modelConcurrency: 1,
      });
      host.permissionManagement!(runtime);
      const expectedStoreId = (await store.getMetadata()).storeId;
      const base = { expectedStoreId, subjectId: 'owner', sessionId: 's' };
      await runtime.createWorkspace({
        expectedStoreId,
        id: 'source',
        rootUri: pathToFileURL(source).href,
        name: 'source',
      });
      await runtime.createSession({
        ...base,
        workspaceId: 'source',
        commandId: 'session',
        title: 'Worktree',
      });
      await initializeLivePermissionFixture({
        runtime,
        profile,
        ...base,
        workspaceId: 'source',
        mode: 'full',
        trusted: true,
        nativeShellRead: true,
      });
      const results = [];
      for (const action of ['list', 'scopeDenied', 'create', 'remove']) {
        let after = (await store.getMetadata()).lastChangeCursor;
        const timeline: ChangeEvent[] = [];
        await runtime.submitCommand({
          ...base,
          commandId: action,
          request: { kind: 'run.start', content: `新任务：${action}` },
        });
        let settled = false;
        const waiting = runtime.waitForCommand(action, { timeoutMs: 20000 }).finally(() => {
          settled = true;
        });
        for (;;) {
          const page = await runtime.getChanges({ after, limit: 200, sessionIds: ['s'] });
          timeline.push(...page.events);
          if (page.events.length) after = page.events.at(-1)!.cursor;
          if (settled && page.events.length === 0) break;
          await Bun.sleep(5);
        }
        const receipt = await waiting;
        expect(receipt, JSON.stringify(receipt)).toMatchObject({ status: 'applied' });
        const executions = await store.listExecutions('s');
        const tool = executions
          .filter((execution) => execution.definitionId === 'git.worktree')
          .at(-1)!;
        results.push(tool.result);
        await verifyWorktreeExecutionEvidence(store, 's', consumedToolContents);
        if (action === 'list') {
          // Corrupt reads of this original completed operation; never start replacement Jobs.
          const originalStore = store;
          const originalReads = {
            listExecutions: originalStore.listExecutions,
            listExtensionRecords: originalStore.listExtensionRecords,
            getCommand: originalStore.getCommand,
            getExecution: originalStore.getExecution,
            listExecutionOutput: originalStore.listExecutionOutput,
          };
          const wrongRef = {
            ...originalReads,
            async getExecution(id: string) {
              const row = await originalStore.getExecution(id);
              return row ? { ...row, originCommandId: 'foreign-command' } : row;
            },
          };
          const wrongRefError = await verifyWorktreeExecutionEvidence(wrongRef, 's').catch(
            (error: unknown) => error,
          );
          expect(wrongRefError).toMatchObject({
            message: expect.stringContaining('worktree_original_command_id'),
          });
          const missingOutput = {
            ...originalReads,
            async listExecutionOutput(
              input: Parameters<typeof originalStore.listExecutionOutput>[0],
            ) {
              const page = await originalStore.listExecutionOutput(input);
              return { ...page, items: [] };
            },
          };
          const missingOutputError = await verifyWorktreeExecutionEvidence(
            missingOutput,
            's',
          ).catch((error: unknown) => error);
          expect(missingOutputError).toMatchObject({ code: 'worktree_output_incomplete' });
          const missingContentError = await verifyWorktreeExecutionEvidence(
            store,
            's',
            new Set(),
          ).catch((error: unknown) => error);
          expect(missingContentError).toMatchObject({
            message: expect.stringContaining('worktree_full_result_not_consumed'),
          });
        }
        const jobs = executions.filter(
          (execution) =>
            execution.definitionId === 'shell.command' && execution.parentExecutionId === tool.id,
        );
        const eventIndex = (id: string, type: string) =>
          timeline.findIndex((event) => event.objectId === id && event.type === type);
        for (const job of jobs) {
          expect(eventIndex(job.id, 'execution.planned')).toBeGreaterThanOrEqual(0);
          expect(eventIndex(job.id, 'execution.running')).toBeGreaterThan(
            eventIndex(job.id, 'execution.dispatching'),
          );
          expect(eventIndex(job.id, 'execution.finished')).toBeGreaterThan(
            eventIndex(job.id, 'execution.running'),
          );
          expect(eventIndex(tool.id, 'execution.finished')).toBeGreaterThan(
            eventIndex(job.id, 'execution.finished'),
          );
        }
        if (jobs.length === 2)
          expect(eventIndex(jobs[1]!.id, 'execution.planned')).toBeGreaterThan(
            eventIndex(jobs[0]!.id, 'execution.finished'),
          );
        expect(
          timeline.filter(
            (event) => event.objectId === tool.id && event.type === 'execution.finished',
          ),
        ).toHaveLength(1);
        const continuation = executions
          .filter((execution) => execution.kind === 'model' && execution.originCommandId === action)
          .at(-1)!;
        expect(eventIndex(continuation.id, 'execution.planned')).toBeGreaterThan(
          eventIndex(tool.id, 'execution.finished'),
        );
        if (action === 'scopeDenied') {
          expect(tool.result).toMatchObject({
            outcome: 'failed',
            details: { mutation: 'not_started', cwdChanged: false },
          });
          expect(existsSync(target)).toBe(false);
          const branch = Bun.spawnSync(
            ['/usr/bin/git', 'show-ref', '--verify', '--quiet', 'refs/heads/must-not-exist'],
            { cwd: source },
          );
          expect(branch.exitCode).toBe(1);
          continue;
        }
        expect(tool.result, JSON.stringify({ action, result: tool.result })).toMatchObject({
          outcome: 'succeeded',
          details: { cwdChanged: false },
        });
        expect((await runtime.getWorkspace('source'))?.rootUri).toBe(pathToFileURL(source).href);
        expect(git(source, 'rev-parse', 'HEAD')).toBe(head);
        expect(readFileSync(join(source, 'tracked.txt'), 'utf8')).toBe('local unstaged source\n');
        if (action === 'create') {
          expect(git(target, 'rev-parse', 'HEAD')).toBe(head);
          expect(git(target, 'symbolic-ref', 'HEAD')).toBe('refs/heads/fixture-branch');
          expect(readFileSync(join(target, 'tracked.txt'), 'utf8')).toBe('committed\n');
        }
      }
      expect(results).toHaveLength(4);
      expect(existsSync(target)).toBe(false);
      expect(git(source, 'rev-parse', 'fixture-branch')).toBe(head);
      // Same-path replacement is a new entity. Historical remove must only replay its receipt.
      git(source, 'worktree', 'add', '--detach', target, head);
      await runtime.submitCommand({
        ...base,
        commandId: 'replay',
        request: { kind: 'run.start', content: '新任务：replay' },
      });
      expect((await runtime.waitForCommand('replay', { timeoutMs: 20000 })).status).toBe('applied');
      const executions = await store.listExecutions('s');
      expect(
        executions.filter((row) => row.definitionId === 'git.worktree').at(-1)?.result,
      ).toMatchObject({ outcome: 'succeeded', details: { replayed: true } });
      expect(git(target, 'rev-parse', 'HEAD')).toBe(head);
      await verifyWorktreeExecutionEvidence(store, 's', consumedToolContents);
      expect(executions.filter((row) => row.definitionId === 'shell.command')).toHaveLength(7);
      expect(
        requestTools.every(
          (names) => names.includes('git_worktree') && !names.includes('shell_execute'),
        ),
      ).toBe(true);
      // This known fixture has no links, generated files or unretained commits.
      git(source, 'worktree', 'remove', target);
    } catch (error) {
      bodyError = error;
    } finally {
      await closeWorktreeFixture({ runtime, store, server }, bodyError);
    }
    // Retain the owned repository on disk so failure evidence is never recursively deleted.
  },
  90000,
);

test('registered Workspace query reads every page and rejects store, cursor, path and paging uncertainty', async () => {
  const root = persistentWorktreeDirectory('kite-worktree-directory-');
  mkdirSync(join(root, '0'));
  mkdirSync(join(root, '1'));
  const pages = Array.from({ length: 2 }, (_, index) => ({
    storeId: 'store',
    highWaterSeq: '2',
    upperSeq: '2',
    snapshotCursor: '7',
    items: [
      {
        seq: String(index + 1),
        workspace: {
          id: String(index),
          rootUri: pathToFileURL(join(root, String(index))).href,
          name: 'registered',
        },
      },
    ],
    nextAfterSeq: index ? null : '1',
  }));
  const run = (mutate?: (page: (typeof pages)[number], index: number) => void) => {
    let index = 0;
    return createWorktreeHost(
      () =>
        ({
          getMetadata: async () => ({ storeId: 'store' }),
          listWorkspaceDirectory: async () => {
            const page = structuredClone(
              pages[index] ?? { ...pages[1]!, items: [], nextAfterSeq: null },
            );
            mutate?.(page, index);
            index++;
            return page;
          },
          getWorkspace: async (id: string) => pages[Number(id)]!.items[0]!.workspace,
        }) as unknown as AgentRuntime,
    ).readRegisteredWorkspaceRoots();
  };
  expect(await run()).toMatchObject({
    originStoreId: 'store',
    complete: true,
    roots: [join(root, '0'), join(root, '1')],
  });
  for (const mutate of [
    (page: (typeof pages)[number], index: number) => {
      if (index === 1) page.storeId = 'foreign';
    },
    (page: (typeof pages)[number], index: number) => {
      if (index === 1) page.snapshotCursor = '8';
    },
    (page: (typeof pages)[number], index: number) => {
      if (index === 0) page.nextAfterSeq = '0';
    },
    (page: (typeof pages)[number], index: number) => {
      if (index === 2) page.highWaterSeq = '3';
    },
  ])
    await expect(run(mutate)).rejects.toThrow('worktree_occupancy_unavailable');
  await expect(createWorktreeHost(() => undefined).readRegisteredWorkspaceRoots()).rejects.toThrow(
    'worktree_occupancy_unavailable',
  );
});
