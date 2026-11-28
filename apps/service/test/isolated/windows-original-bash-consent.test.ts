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
  'Git Shell Auto confines ordinary workspace effects and keeps required approvals on the exact Job',
  async () => {
    const root = temporaryDirectory('kite-bash-consent-');
    const cwd = join(root, 'workspace'),
      control = join(root, 'control'),
      stateRoot = join(root, 'state');
    for (const path of [cwd, control]) mkdirSync(path);
    privateDirectory(stateRoot);
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
        windows: {
          kind: 'native-git-bash',
          stateRoot,
          fullShellExecutable: shell,
          confinedBashCompatibility: resolve(
            import.meta.dir,
            '../../../../native/windows-msys-compat/target/release/ktipc.dll',
          ),
        },
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
    let businessNext = false,
      risk: 'ordinary' | 'high' | 'critical' = 'ordinary',
      checks = 0,
      command = '';
    const business: ModelAdapter = {
      async *stream() {
        if (businessNext) {
          businessNext = false;
          yield {
            type: 'tool_call',
            id: crypto.randomUUID(),
            name: 'exec_command',
            arguments: JSON.stringify({
              cmd: command,
              yield_time_ms: 20000,
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
            ? ['approved', 'cancel']
            : mode === 'auto'
              ? ['read', 'approved', 'high-approved', 'denied', 'outside', 'critical']
              : ['approved', 'denied'];
        for (const [i, choice] of cases.entries()) {
          const before = actual(),
            startChecks = checks,
            id = mode + '-' + i;
          businessNext = true;
          const highRisk = choice === 'denied' || choice === 'high-approved';
          risk = choice === 'critical' ? 'critical' : highRisk ? 'high' : 'ordinary';
          command =
            choice === 'cancel'
              ? 'printf started > deadline-started; sleep 20; printf late > deadline-late'
              : choice === 'read'
                ? 'date +%A'
                : choice === 'outside'
                  ? 'printf outside > ../outside.txt'
                  : choice === 'high-approved'
                    ? `printf y >> ${file}`
                    : choice === 'denied'
                      ? `date +%A >> ${file}`
                      : `printf x >> ${file}`;
          await runtime.submitCommand({
            ...identity,
            commandId: id,
            request: { kind: 'run.start', content: 'Run the owned fixture.' },
          });
          const deadline = Date.now() + 25000;
          let cancelled = false,
            answered = 0,
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
              expect(choice).not.toBe('read');
              expect(item.definitionId).toBe('shell.command');
              const [choiceView] = readApprovalOptions(item.request);
              if (mode === 'auto') {
                expect(highRisk).toBe(true);
                expect(structuredClone(item.request)).toMatchObject({
                  input: { command },
                  policy: {
                    executionScope: { filesystem: 'workspace_write', network: 'none' },
                  },
                });
                expect(choiceView?.kind).toBe('once');
              } else {
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
              }
              expect(actual()).toBe(before);
              await runtime.answerInteraction({
                ...identity,
                commandId: crypto.randomUUID(),
                presentationSessionId: sessionId,
                interactionId: item.id,
                expectedRevision: item.revision,
                answer:
                  choice === 'approved' || choice === 'high-approved'
                    ? { kind: 'approval', decision: 'approve', optionId: 'once' }
                    : { kind: 'approval', decision: 'deny' },
              });
            }
            const run = (await store.getView(sessionId)).runs.find(
              (row) => row.originCommandId === id,
            );
            if (
              choice === 'cancel' &&
              run?.isActive &&
              !cancelled &&
              existsSync(join(cwd, 'deadline-started'))
            ) {
              cancelled = true;
              await runtime.cancelRun({
                ...identity,
                commandId: 'cancel-original-shell',
                runId: run.id,
              });
            }
            if (run && !run.isActive) {
              settled = true;
              break;
            }
            await Bun.sleep(30);
          }
          expect(settled).toBe(true);
          expect(answered).toBe(mode === 'accept_edits' || (mode === 'auto' && highRisk) ? 1 : 0);
          expect(actual()).toBe(
            before + (choice === 'approved' ? 'x' : choice === 'high-approved' ? 'y' : ''),
          );
          if (mode === 'auto') expect(checks - startChecks).toBe(1);
          if (choice === 'outside') {
            const job = (await store.listExecutions(sessionId)).find(
              (row) => row.rootWorkCommandId === id && row.definitionId === 'shell.command',
            );
            expect(job?.result).toMatchObject({
              outcome: 'failed',
              details: { cleanupConfirmed: true, processTreeStopped: true },
            });
            expect(existsSync(join(root, 'outside.txt'))).toBe(false);
          }
          if (choice === 'read') {
            const job = (await store.listExecutions(sessionId)).find(
              (row) => row.rootWorkCommandId === id && row.definitionId === 'shell.command',
            );
            expect(job?.status, JSON.stringify(job?.result)).toBe('succeeded');
            expect(job?.result).toMatchObject({
              details: { exitCode: 0, cleanupConfirmed: true, processTreeStopped: true },
            });
            const output = await store.listExecutionOutput({
              executionId: job!.id,
              afterSeq: '0',
              limit: 20,
            });
            expect(
              output.items
                .filter(({ stream }) => stream === 'stdout')
                .map(({ content }) => content)
                .join('')
                .trim(),
            ).not.toBe('');
          }
          if (choice === 'cancel') {
            expect(cancelled).toBe(true);
            expect(readFileSync(join(cwd, 'deadline-started'), 'utf8')).toBe('started');
            expect(existsSync(join(cwd, 'deadline-late'))).toBe(false);
            const rows = await store.listExecutions(sessionId);
            const parent = rows.find(
              (row) => row.rootWorkCommandId === id && row.definitionId === 'shell.execute',
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
      expect(existsSync(join(stateRoot, 'runtime'))).toBe(true);
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
        expect(readFileSync(join(cwd, sessionId + '.txt'), 'utf8')).toBe(
          sessionId === 'auto' ? 'xy' : 'x',
        );
      }
      expect(existsSync(join(cwd, 'deadline-late'))).toBe(false);
    } finally {
      await cold.close();
      await coldStore.close();
    }
  },
  120000,
);
