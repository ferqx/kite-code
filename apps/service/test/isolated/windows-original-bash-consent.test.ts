import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRuntime, prepareOutputDirectory } from '@kite-ai/agent';
import { createArtifactStore } from '@kite-ai/agent/artifacts';
import { createTemporaryCredentialBackend } from '@kite-ai/agent/config';
import { selectProfile } from '@kite-ai/agent/profile';
import { createWorkspaceSerialLocks } from '@kite-ai/agent/resources';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import type { ModelAdapter, ModelEvent } from '@kite-ai/ai';
import { readApprovalOptions } from '@kite-ai/client';
import { discoverInstalledWindowsGitBash } from '../../../../packages/agent/src/jobs/windows-git-bash';
import { privateDirectory, temporaryDirectory } from '../../../../tests/fixtures/test-filesystem';
import { createDefaultProcessConfiguration } from '../../src/configuration';
import { initializeLivePermissionFixture } from '../fixtures/live-permission-fixture';

const finish: Extract<ModelEvent, { type: 'finish' }> = {
  type: 'finish',
  reason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1 },
};
test.skipIf(process.platform !== 'win32' || process.arch !== 'x64')(
  'original Bash verifies fresh user-process approvals before effects in each permission mode',
  async () => {
    const root = temporaryDirectory('kite-bash-consent-');
    const cwd = join(root, 'workspace'),
      control = join(root, 'control'),
      stateRoot = join(root, 'state');
    for (const path of [cwd, control, stateRoot]) mkdirSync(path);
    const profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'owned' });
    privateDirectory(profile.profilePath);
    const cfg = join(profile.profilePath, 'config.jsonc');
    writeFileSync(
      cfg,
      JSON.stringify({
        modelId: 'owned',
        models: [
          {
            id: 'owned',
            provider: 'compatible',
            model: 'unused',
            baseURL: 'http://127.0.0.1:9/v1',
          },
        ],
        tools: [{ id: 'shell.execute', definitionVersion: '1' }],
      }),
    );
    const { shell } = discoverInstalledWindowsGitBash();
    const host = createDefaultProcessConfiguration({
      profile,
      userConfigurationPath: cfg,
      ordinaryHostTools: true,
      localCodex: false,
      credentialBackend: createTemporaryCredentialBackend(),
      shell: {
        platform: 'win32',
        configurationId: 'windows-original-consent',
        env: {
          SystemRoot: process.env.SystemRoot!,
          PATH: process.env.PATH!,
          HOME: root,
          USERPROFILE: root,
          TEMP: join(root, 'temp'),
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_GLOBAL: 'NUL',
        },
        supervisorPath: resolve(
          import.meta.dir,
          '../../../../native/windows-sandbox-runner/target/release/kite-windows-runner.exe',
        ),
        bunExecutable: process.execPath,
        shellExecutable: shell,
        windows: { kind: 'native-git-bash', stateRoot, fullShellExecutable: shell },
        host: {
          controlBase: control,
          protectedRoots: [],
          readonlyAssets: [],
          runtimeReadOnlyRoots: [],
        },
      },
    });
    const store = await openSqliteStore(profile);
    const expectedStoreId = (await store.getMetadata()).storeId;
    const locks = createWorkspaceSerialLocks(profile);
    host.bindWorkspaceSerialLocks?.(locks);
    let timeout = false,
      businessNext = false,
      risk: 'ordinary' | 'critical' = 'ordinary',
      checks = 0,
      command = '';
    const business: ModelAdapter = {
      async *stream() {
        if (businessNext) {
          businessNext = false;
          yield {
            type: 'tool_call',
            id: crypto.randomUUID(),
            name: 'shell_execute',
            arguments: JSON.stringify({
              command,
              ...(timeout ? { execution_timeout_ms: 6500 } : {}),
            }),
          };
          yield { ...finish, reason: 'tool_calls' };
        } else {
          yield { type: 'text_delta', text: 'Done' };
          yield finish;
        }
      },
    };
    const reviewer: ModelAdapter = {
      async *stream() {
        checks++;
        yield {
          type: 'text_delta',
          text: JSON.stringify({ risk, reason: 'Controlled fixture classification.' }),
        };
        yield finish;
      },
    };
    const runtime = createRuntime({
      ...host,
      store,
      permissions: host.permissions!,
      workspaceSerialLocks: locks,
      artifacts: createArtifactStore({ profile, store }),
      outputCollections: {
        prepare: (context, identity) => prepareOutputDirectory(runtime, context, identity),
      },
      resolveRunConfiguration: async (input) => {
        const selected = await host.resolveRunConfiguration!(input);
        return {
          ...selected,
          model: business,
          ...(selected.authorizationCheck
            ? { authorizationCheck: { ...selected.authorizationCheck, model: reviewer } }
            : {}),
        };
      },
    });
    host.permissionManagement?.(runtime);
    try {
      await runtime.createWorkspace({
        expectedStoreId,
        id: 'w',
        name: 'Owned',
        rootUri: pathToFileURL(cwd).href,
      });
      for (const mode of ['accept_edits', 'auto', 'full'] as const) {
        const sessionId = mode,
          identity = { expectedStoreId, sessionId, subjectId: 'owner' };
        await runtime.createSession({
          ...identity,
          commandId: 'create-' + mode,
          workspaceId: 'w',
          title: mode,
        });
        await initializeLivePermissionFixture({
          runtime,
          profile,
          ...identity,
          workspaceId: 'w',
          mode,
          trusted: true,
        });
        const file = mode + '.txt',
          path = join(cwd, file),
          cards = new Set<string>();
        const actual = () => (existsSync(path) ? readFileSync(path, 'utf8') : '');
        const cases =
          mode === 'full'
            ? ['approved', 'timeout']
            : mode === 'auto'
              ? ['approved', 'denied', 'critical']
              : ['approved', 'denied'];
        for (const [i, choice] of cases.entries()) {
          const before = actual(),
            startChecks = checks,
            id = mode + '-' + i;
          businessNext = true;
          risk = choice === 'critical' ? 'critical' : 'ordinary';
          timeout = choice === 'timeout';
          command = timeout
            ? 'printf started > deadline-started; sleep 20; printf late > deadline-late'
            : 'printf x >> ' + file;
          await runtime.submitCommand({
            ...identity,
            commandId: id,
            request: { kind: 'run.start', content: 'Run the owned fixture.' },
          });
          const deadline = Date.now() + 25000;
          let answered = 0,
            settled = false;
          while (Date.now() < deadline) {
            const pending = (
              await store.listInteractions({ expectedStoreId, sessionId, state: 'pending' })
            ).interactions;
            for (const item of pending) {
              if (cards.has(item.id)) continue;
              cards.add(item.id);
              answered++;
              expect(mode).not.toBe('full');
              expect(choice).not.toBe('critical');
              expect(item.definitionId).toBe('shell.command');
              const [choiceView] = readApprovalOptions(item.request);
              expect(structuredClone(item.request)).toMatchObject({
                input: { command },
                policy: {
                  windowsNativeUserProcess: true,
                  executionScope: { filesystem: 'full_access', network: 'internet' },
                },
                options: [
                  {
                    kind: 'once',
                    presentation: {
                      label: expect.stringContaining('当前 Windows 用户文件和网络（不限工作区）'),
                      details: [expect.stringContaining('不限于工作区')],
                    },
                  },
                ],
              });
              expect(choiceView?.presentation.label).toContain(
                '当前 Windows 用户文件和网络（不限工作区）',
              );
              expect(choiceView?.presentation.details[0]).toContain('不限于工作区');
              expect(actual()).toBe(before);
              await runtime.answerInteraction({
                ...identity,
                commandId: crypto.randomUUID(),
                presentationSessionId: sessionId,
                interactionId: item.id,
                expectedRevision: item.revision,
                answer:
                  choice === 'approved'
                    ? { kind: 'approval', decision: 'approve', optionId: 'once' }
                    : { kind: 'approval', decision: 'deny' },
              });
            }
            const run = (await store.getView(sessionId)).runs.find(
              (row) => row.originCommandId === id,
            );
            if (run && !run.isActive) {
              settled = true;
              break;
            }
            await Bun.sleep(30);
          }
          expect(settled).toBe(true);
          expect(answered).toBe(mode === 'full' || choice === 'critical' ? 0 : 1);
          expect(actual()).toBe(before + (choice === 'approved' ? 'x' : ''));
          if (mode === 'auto') expect(checks - startChecks).toBe(1);
          if (timeout) {
            expect(readFileSync(join(cwd, 'deadline-started'), 'utf8')).toBe('started');
            expect(existsSync(join(cwd, 'deadline-late'))).toBe(false);
            const rows = await store.listExecutions(sessionId);
            const parent = rows.find(
              (row) => row.originCommandId === id && row.definitionId === 'shell.execute',
            );
            const job = rows.find(
              (row) => row.parentExecutionId === parent?.id && row.definitionId === 'shell.command',
            );
            expect(job?.result).toMatchObject({
              outcome: 'cancelled',
              details: { cleanupConfirmed: true, processTreeStopped: true },
            });
          }
        }
      }
      expect(existsSync(join(stateRoot, 'runtime'))).toBe(false);
    } finally {
      await runtime.close();
      await store.close();
      await locks.close();
    }
    // A cold host can observe the settled approvals and results. Observation is not
    // new launch authority and must not rerun either the approved or the refused command.
    const coldStore = await openSqliteStore(profile);
    const cold = createRuntime({ store: coldStore, permissions: host.permissions! });
    try {
      for (const sessionId of ['accept_edits', 'auto', 'full']) {
        expect((await cold.getView(sessionId)).runs.every((run) => !run.isActive)).toBe(true);
        expect(
          (await cold.listInteractions({ expectedStoreId, sessionId, state: 'pending' }))
            .interactions,
        ).toEqual([]);
        expect(readFileSync(join(cwd, sessionId + '.txt'), 'utf8')).toBe('x');
      }
      expect(existsSync(join(cwd, 'deadline-late'))).toBe(false);
    } finally {
      await cold.close();
      await coldStore.close();
    }
  },
  120000,
);
