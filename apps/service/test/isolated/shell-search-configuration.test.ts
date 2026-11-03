import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRuntime } from '@kite-ai/agent';
import { createArtifactStore } from '@kite-ai/agent/artifacts';
import { createTemporaryCredentialBackend } from '@kite-ai/agent/config';
import { withBundledRipgrep } from '@kite-ai/agent/jobs/shell';
import { planningExtensionId } from '@kite-ai/agent/planning';
import { selectProfile } from '@kite-ai/agent/profile';
import { createWorkspaceSerialLocks } from '@kite-ai/agent/resources';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import type { ModelAdapter, ModelEvent } from '@kite-ai/ai';
import { windowsShellFixture } from '../../../../packages/agent/test/fixtures/windows-shell-runtime';
import { privateDirectory } from '../../../../tests/fixtures/test-filesystem';
import { createDefaultProcessConfiguration } from '../../src/configuration';
import { initializeLivePermissionFixture } from '../fixtures/live-permission-fixture';

const native = process.platform === 'win32' ? test : test.skip;
const call = (name: string, input: object): ModelEvent[] => [
  { type: 'tool_call', id: crypto.randomUUID(), name, arguments: JSON.stringify(input) },
  { type: 'finish', reason: 'tool_calls', usage: { inputTokens: 1, outputTokens: 1 } },
];
const finish: ModelEvent = {
  type: 'finish',
  reason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1 },
};

native(
  'Service permits actual Shell searches before plan review and gives read-only children query access without mutation authority',
  async () => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'kite-service-shell-search-')));
    const workspace = join(root, 'workspace'),
      control = join(root, 'control');
    mkdirSync(workspace);
    mkdirSync(control);
    writeFileSync(join(workspace, '中文 source.txt'), 'search-needle\n');
    const profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'search' });
    privateDirectory(profile.profilePath);
    const user = join(profile.profilePath, 'config.jsonc');
    writeFileSync(
      user,
      JSON.stringify({
        modelId: 'fixed',
        models: [
          {
            id: 'fixed',
            provider: 'compatible',
            model: 'unused',
            baseURL: 'http://127.0.0.1:9/v1',
          },
        ],
      }),
    );
    const assets = windowsShellFixture();
    const host = createDefaultProcessConfiguration({
      profile,
      userConfigurationPath: user,
      ordinaryHostTools: true,
      localCodex: false,
      credentialBackend: createTemporaryCredentialBackend(),
      shell: {
        platform: 'win32',
        configurationId: 'native-search-test',
        env: withBundledRipgrep(
          Object.fromEntries(
            Object.entries(process.env).filter(
              (entry): entry is [string, string] =>
                typeof entry[1] === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(entry[0]),
            ),
          ),
        ).env,
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
    });
    const store = await openSqliteStore(profile);
    const diagnostic = await host.diagnosticSource!.snapshot({ subjectId: 'owner', storeId: null });
    expect(diagnostic.execution.shell).toMatchObject({
      available: true,
      supervision: 'windows_job',
      qualification: 'windows_unelevated',
    });
    expect(diagnostic.execution.sandbox).toEqual({
      backend: 'windows_restricted_token',
      available: true,
      qualification: 'write_restricted',
    });
    const expectedStoreId = (await store.getMetadata()).storeId;
    let closed = false,
      lastNativeId: string | undefined;
    let rootStep = 0,
      childStep = 0,
      planningStep = 0,
      externalStep = 0;
    const externalModel: ModelAdapter = {
      async *stream() {
        if (externalStep++ === 0)
          yield* call('shell_execute', {
            key: 'approved-external',
            command: 'printf approved-external >> ../approved.txt',
            permissions: { filesystem: 'full_access', network: 'none' },
          });
        else yield finish;
      },
    };
    const childModel: ModelAdapter = {
      async *stream() {
        if (childStep++ === 0)
          yield* call('shell_execute', { key: 'child-files', command: 'rg --files' });
        else if (childStep === 2)
          yield* call('shell_execute', { key: 'child-directory', command: 'ls' });
        else if (childStep === 3)
          yield* call('shell_execute', {
            key: 'child-search',
            command: "rg search-needle '中文 source.txt'",
          });
        else if (childStep === 4)
          yield* call('shell_execute', {
            key: 'denied-write',
            command: 'printf forbidden > forbidden.txt',
          });
        else yield finish;
      },
    };
    const rootModel: ModelAdapter = {
      async *stream() {
        if (rootStep++ === 0)
          yield* call('spawn_agent', { prompt: 'Inspect source read-only.', preset: 'explore' });
        else {
          const carrier = (await store.listExecutions('child-root')).find(
            (e) => e.definitionId === 'agent/explore',
          );
          const view = carrier?.childSessionId ? await store.getView(carrier.childSessionId) : null;
          if (view?.runs.some((run) => !run.isActive)) yield finish;
          else yield* call('wait_agent_events', { wait_ms: 100 });
        }
      },
    };
    const planningModel: ModelAdapter = {
      async *stream() {
        if (planningStep++ === 0)
          yield* call('shell_execute', {
            key: 'plan-search',
            command: "rg search-needle '中文 source.txt'",
          });
        else if (planningStep === 2)
          yield* call('write_plan', {
            plan_id: 'plan',
            expected_version: null,
            title: 'Search first',
            body: 'Inspect then ask approval.',
            steps: [{ id: 'a', title: 'Inspect' }],
          });
        else {
          const pointer = (
            await store.getExtensionRecord({
              sessionId: 'plan-root',
              extensionId: planningExtensionId,
              key: 'plan.current',
            })
          )?.value as Record<string, string | number>;
          yield* call('request_plan_review', {
            plan_id: pointer.planId,
            version: pointer.version,
            digest: pointer.digest,
          });
        }
      },
    };
    const workspaceSerialLocks = createWorkspaceSerialLocks(profile);
    host.bindWorkspaceSerialLocks?.(workspaceSerialLocks);
    const runtime = createRuntime({
      ...host,
      store,
      permissions: host.permissions!,
      workspaceSerialLocks,
      artifacts: createArtifactStore({ profile, store }),
      resolveRunConfiguration: async (input) => ({
        ...(await host.resolveRunConfiguration!(input)),
        model:
          input.session.id === 'plan-root'
            ? planningModel
            : input.session.id === 'outside-root'
              ? externalModel
              : rootModel,
      }),
      resolveChildRunConfiguration: async (input) => ({
        ...(await host.resolveChildRunConfiguration!(input)),
        model: childModel,
      }),
    });
    host.permissionManagement?.(runtime);
    const until = async (predicate: () => Promise<boolean>) => {
      const deadline = Date.now() + 12000;
      while (!(await predicate())) {
        if (Date.now() > deadline) throw Error('shell_search_deadline');
        await Bun.sleep(10);
      }
    };
    try {
      await runtime.createWorkspace({
        expectedStoreId,
        id: 'w',
        name: 'search',
        rootUri: pathToFileURL(workspace).href,
      });
      for (const sessionId of ['child-root', 'plan-root', 'outside-root']) {
        const identity = { expectedStoreId, sessionId, subjectId: 'owner' };
        await runtime.createSession({
          ...identity,
          commandId: `create-${sessionId}`,
          workspaceId: 'w',
          title: 'search',
        });
        await initializeLivePermissionFixture({
          runtime,
          profile,
          ...identity,
          workspaceId: 'w',
          mode: 'accept_edits',
          trusted: true,
        });
        await runtime.submitCommand({
          ...identity,
          commandId: `start-${sessionId}`,
          request: {
            kind: 'run.start',
            content: 'Search the source',
            ...(sessionId === 'plan-root'
              ? {
                  extensionInputs: [
                    {
                      extensionId: planningExtensionId,
                      definitionVersion: '1',
                      input: { mode: 'plan' },
                    },
                  ],
                }
              : {}),
          },
        });
        if (sessionId === 'outside-root') {
          for (const definitionId of ['shell.execute', 'shell.command']) {
            let card:
              | Awaited<ReturnType<typeof store.listInteractions>>['interactions'][number]
              | undefined;
            await until(async () => {
              card = (
                await store.listInteractions({ expectedStoreId, sessionId, state: 'pending' })
              ).interactions.find((item) => item.definitionId === definitionId);
              return !!card;
            });
            expect(existsSync(join(root, 'approved.txt'))).toBe(false);
            expect(JSON.stringify(card!.request)).toContain('full_access');
            await runtime.answerInteraction({
              ...identity,
              commandId: `approve-${crypto.randomUUID()}`,
              presentationSessionId: sessionId,
              interactionId: card!.id,
              expectedRevision: card!.revision,
              answer: { kind: 'approval', decision: 'approve', grant: 'approve_once' },
            });
          }
          await until(async () =>
            (await store.getView(sessionId)).runs.some((run) => !run.isActive),
          );
          expect(await Bun.file(join(root, 'approved.txt')).text()).toBe('approved-external');
          const native = (await store.listExecutions(sessionId)).find(
            (item) => item.definitionId === 'shell.command',
          )!;
          lastNativeId = native.id;
          expect(native.status).toBe('succeeded');
          expect(native.reference).toMatchObject({
            confinement: { filesystem: 'full_access', network: 'none' },
          });
          const before = externalStep;
          await runtime.submitCommand({
            ...identity,
            commandId: `start-${sessionId}`,
            request: { kind: 'run.start', content: 'Search the source' },
          });
          expect(externalStep).toBe(before);
          expect(await Bun.file(join(root, 'approved.txt')).text()).toBe('approved-external');
        } else if (sessionId === 'child-root') {
          await until(async () =>
            (await store.getView(sessionId)).runs.some((run) => !run.isActive),
          );
          const carrier = (await store.listExecutions(sessionId)).find(
            (e) => e.definitionId === 'agent/explore',
          )!;
          expect(carrier.childSessionId).toBeTruthy();
          const executions = await store.listExecutions(carrier.childSessionId!);
          expect(executions.filter((e) => e.definitionId === 'shell.command')).toHaveLength(3);
          expect(executions.find((e) => e.definitionId === 'shell.command')?.status).toBe(
            'succeeded',
          );
          const tools = executions.filter((e) => e.definitionId === 'shell.execute');
          expect(tools.map((e) => e.status)).toEqual([
            'succeeded',
            'succeeded',
            'succeeded',
            'failed',
          ]);
          expect(JSON.stringify(tools[3]!.result)).toContain(
            'read_only_task_requires_literal_search',
          );
          expect(existsSync(join(workspace, 'forbidden.txt'))).toBe(false);
        } else {
          await until(async () =>
            (
              await store.listInteractions({ expectedStoreId, sessionId, state: 'pending' })
            ).interactions.some((interaction) => interaction.kind === 'plan_review'),
          );
          const executions = await store.listExecutions(sessionId);
          expect(executions.find((e) => e.definitionId === 'shell.execute')?.status).toBe(
            'succeeded',
          );
          expect(executions.find((e) => e.definitionId === 'shell.command')?.status).toBe(
            'succeeded',
          );
          expect(executions.find((e) => e.definitionId === 'planning.review')?.status).toBe(
            'dispatching',
          );
        }
      }
      const original = await store.getExecution(lastNativeId!);
      await runtime.close();
      await store.close();
      closed = true;
      const counts = [rootStep, childStep, planningStep, externalStep];
      const cold = await openSqliteStore(profile);
      try {
        const before = (await cold.getMetadata()).lastChangeCursor;
        const execution = await cold.getExecution(lastNativeId!);
        expect(execution?.result).toEqual(original?.result);
        expect(execution?.reference).toEqual(original?.reference);
        expect(execution?.status).toBe('succeeded');
        expect((await cold.getMetadata()).lastChangeCursor).toBe(before);
        expect([rootStep, childStep, planningStep, externalStep]).toEqual(counts);
        expect(await Bun.file(join(root, 'approved.txt')).text()).toBe('approved-external');
      } finally {
        await cold.close();
      }
    } finally {
      if (!closed) {
        await runtime.close();
        await store.close();
      }
      await workspaceSerialLocks.close();
      rmSync(root, { recursive: true, force: true });
    }
  },
  35000,
);
