import { expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRuntime } from '@kite-ai/agent';
import { createArtifactStore } from '@kite-ai/agent/artifacts';
import { createTemporaryCredentialBackend } from '@kite-ai/agent/config';
import { withBundledRipgrep } from '@kite-ai/agent/jobs/shell';
import { selectProfile } from '@kite-ai/agent/profile';
import { createWorkspaceSerialLocks } from '@kite-ai/agent/resources';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import type { ModelAdapter, ModelEvent } from '@kite-ai/ai';
import { discoverWindowsPowerShell } from '../../../../packages/agent/src/jobs/windows-powershell';
import { windowsShellFixture } from '../../../../packages/agent/test/fixtures/windows-shell-runtime';
import {
  privateDirectory,
  removeTemporaryDirectory,
  temporaryDirectory,
} from '../../../../tests/fixtures/test-filesystem';
import { createDefaultProcessConfiguration } from '../../src/configuration';
import { initializeLivePermissionFixture } from '../fixtures/live-permission-fixture';

const finish: Extract<ModelEvent, { type: 'finish' }> = {
  type: 'finish',
  reason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1 },
};

for (const backend of ['powershell', 'git-bash'] as const) {
  test.skipIf(process.platform !== 'win32' || process.arch !== 'x64')(
    backend +
      ' Auto skips review for verified reads, executes ordinary scripts and asks only for high risk',
    async () => {
      const root = temporaryDirectory('kite-windows-shell-auto-');
      const workspace = join(root, 'workspace');
      const control = join(root, 'control');
      const stateRoot = join(root, 'sandbox');
      const profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'auto' });
      try {
        for (const path of [workspace, control, stateRoot]) mkdirSync(path);
        privateDirectory(profile.profilePath);
        const git = realpathSync.native(Bun.which('git')!);
        const gitEnvironment = Object.fromEntries(
          Object.entries(process.env).filter(
            (entry): entry is [string, string] =>
              typeof entry[1] === 'string' && !/^git_/iu.test(entry[0]),
          ),
        );
        const gitRun = (...argv: string[]) => {
          const result = Bun.spawnSync([git, ...argv], {
            cwd: workspace,
            env: { ...gitEnvironment, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: 'NUL' },
          });
          expect(result.exitCode, result.stderr.toString()).toBe(0);
        };
        gitRun('init', '-q');
        writeFileSync(join(workspace, 'input.txt'), 'search-needle\n');
        writeFileSync(join(workspace, '.gitattributes'), '*.txt filter=side-effect\n');
        gitRun('-c', 'core.hooksPath=NUL', 'add', 'input.txt', '.gitattributes');
        gitRun(
          '-c',
          'core.hooksPath=NUL',
          '-c',
          'user.name=Kite test',
          '-c',
          'user.email=test@example.invalid',
          'commit',
          '-qm',
          'fixture commit',
        );
        writeFileSync(join(workspace, 'input.txt'), 'search-needle changed\n');
        const sideEffect = 'sh -c "printf external-helper > helper-ran.txt"';
        gitRun('config', '--local', 'core.fsmonitor', sideEffect);
        gitRun('config', '--local', 'filter.side-effect.clean', sideEffect);
        gitRun('config', '--local', 'diff.external', sideEffect);

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
                options: { maxOutputTokens: 32, reasoningEffort: 'high' },
              },
            ],
          }),
        );
        const assets = await windowsShellFixture();
        const powerShell = backend === 'powershell' ? await discoverWindowsPowerShell() : undefined;
        const host = createDefaultProcessConfiguration({
          profile,
          userConfigurationPath: user,
          ordinaryHostTools: true,
          localCodex: false,
          credentialBackend: createTemporaryCredentialBackend(),
          shell: {
            platform: 'win32',
            configurationId: 'windows-shell-auto-fixture',
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
            shellExecutable: powerShell?.executable.canonical ?? assets.shell,
            windows: powerShell
              ? { kind: 'powershell', powerShell, gitExecutable: git, stateRoot }
              : { kind: 'bash', fullShellExecutable: assets.fullShell, stateRoot },
            host: {
              controlBase: control,
              protectedRoots: [],
              readonlyAssets: [],
              runtimeReadOnlyRoots: [],
            },
          },
        });
        const reads = [
          powerShell
            ? 'rg.exe -n -g "*.txt" search-needle . | Select-Object -First 1'
            : 'rg -n -g "*.txt" search-needle . | head -1',
          powerShell ? 'Get-Content -LiteralPath input.txt -TotalCount 1' : 'head -n 1 input.txt',
          'git status --short',
          'git diff --stat',
          'git log -1 --oneline',
          'git branch --show-current',
        ];
        const scripts = [
          { name: 'ordinary', risk: 'ordinary' },
          { name: 'approved', risk: 'high' },
          { name: 'denied', risk: 'high' },
          { name: 'critical', risk: 'critical' },
          { name: 'timed-out', risk: 'high' },
        ].map((step) => {
          const filename = `${step.name} fixture.${powerShell ? 'ps1' : 'sh'}`;
          const text = powerShell
            ? `Set-Content -LiteralPath '${step.name}.txt' -Value '${step.name}'\n`
            : `#!/bin/bash\nprintf '${step.name}' > ${step.name}.txt\n`;
          writeFileSync(join(workspace, filename), text);
          return {
            ...step,
            command: `${powerShell ? '& ' : ''}'./${filename}'`,
            script: `./${filename}`,
            text,
          };
        });
        const commands = [...reads, ...scripts.map((step) => step.command), reads[0]!];
        const highRisk = scripts.filter(
          (step) => step.risk === 'high' && step.name !== 'timed-out',
        );
        const indexBefore = readFileSync(join(workspace, '.git/index'));
        let index = 0;
        const reviews: string[] = [];
        let releaseLateReview!: () => void;
        const lateReview = new Promise<void>((resolve) => (releaseLateReview = resolve));
        let lateAnswerAttempted = false;
        const business: ModelAdapter = {
          async *stream() {
            const command = commands[index++];
            if (command !== undefined) {
              yield {
                type: 'tool_call',
                id: crypto.randomUUID(),
                name: 'shell_execute',
                arguments: JSON.stringify({ command }),
              };
              yield { ...finish, reason: 'tool_calls' };
            } else yield finish;
          },
        };
        const reviewer: ModelAdapter = {
          async *stream(request, { signal }) {
            const payload = JSON.parse(
              request.messages.find((message) => message.role === 'user')!.content,
            );
            const step = scripts.find((value) => value.command === payload.operation.input.command);
            expect(step).toBeDefined();
            expect(payload.operation.kind).toBe('tool');
            expect(payload.material.directScripts).toMatchObject([
              { path: step!.script, text: step!.text, complete: true },
            ]);
            if (reviews.length === 0) {
              expect(readdirSync(stateRoot)).toEqual([]);
              expect(readFileSync(join(workspace, '.git/index'))).toEqual(indexBefore);
              expect(existsSync(join(workspace, 'helper-ran.txt'))).toBeFalse();
            }
            reviews.push(step!.name);
            if (step!.name === 'timed-out') {
              await lateReview;
              expect(signal.aborted).toBeTrue();
              lateAnswerAttempted = true;
            }
            yield {
              type: 'text_delta',
              text: JSON.stringify({ risk: step!.risk, reason: 'Controlled risk classification.' }),
            };
            yield finish;
          },
        };
        const store = await openSqliteStore(profile);
        const expectedStoreId = (await store.getMetadata()).storeId;
        const workspaceSerialLocks = createWorkspaceSerialLocks(profile);
        host.bindWorkspaceSerialLocks?.(workspaceSerialLocks);
        const runtime = createRuntime({
          ...host,
          store,
          permissions: host.permissions!,
          workspaceSerialLocks,
          artifacts: createArtifactStore({ profile, store }),
          resolveRunConfiguration: async (input) => {
            const selected = await host.resolveRunConfiguration!(input);
            if (!selected.authorizationCheck) throw Error('missing reviewer');
            const request = {
              modelId: selected.modelId!,
              requestId: 'probe',
              messages: [],
              tools: [],
            };
            expect(selected.model!.describeRequest?.(request).settings).toMatchObject({
              maxOutputTokens: 32,
              reasoningEffort: 'high',
            });
            const reviewerSettings =
              selected.authorizationCheck.model.describeRequest?.(request).settings;
            expect(reviewerSettings).toMatchObject({ reasoningEffort: 'low' });
            expect(reviewerSettings).not.toHaveProperty('maxOutputTokens');
            return {
              ...selected,
              model: business,
              authorizationCheck: {
                ...selected.authorizationCheck,
                model: reviewer,
                timeoutMs: 2000,
              },
            };
          },
        });
        host.permissionManagement?.(runtime);
        const sessionId = 'auto';
        const identity = { expectedStoreId, sessionId, subjectId: 'owner' };
        try {
          await runtime.createWorkspace({
            expectedStoreId,
            id: 'w',
            name: 'Windows Shell Auto',
            rootUri: pathToFileURL(workspace).href,
          });
          await runtime.createSession({
            ...identity,
            commandId: 'create',
            workspaceId: 'w',
            title: 'Windows Shell Auto',
          });
          await initializeLivePermissionFixture({
            runtime,
            profile,
            ...identity,
            workspaceId: 'w',
            mode: 'auto',
            trusted: true,
          });
          await runtime.submitCommand({
            ...identity,
            commandId: 'start',
            request: {
              kind: 'run.start',
              content: 'Read the fixture, run the exact scripts, then query the workspace again.',
            },
          });
          const seen = new Set<string>();
          const answered: string[] = [];
          const deadline = Date.now() + 40000;
          while (Date.now() < deadline) {
            const cards = (
              await store.listInteractions({ expectedStoreId, sessionId, state: 'pending' })
            ).interactions;
            for (const card of cards) {
              if (seen.has(card.id)) continue;
              seen.add(card.id);
              const request = card.request as { input: { command: string } };
              const command = request.input.command;
              expect(card.definitionId).toBe('shell.execute');
              const expected = highRisk[answered.length]!;
              expect(command).toBe(expected.command);
              answered.push(command);
              const approving = expected.name === 'approved';
              expect(existsSync(join(workspace, `${expected.name}.txt`))).toBeFalse();
              await runtime.answerInteraction({
                ...identity,
                commandId: crypto.randomUUID(),
                presentationSessionId: sessionId,
                interactionId: card.id,
                expectedRevision: card.revision,
                answer: approving
                  ? { kind: 'approval', decision: 'approve', optionId: 'once' }
                  : { kind: 'approval', decision: 'deny' },
              });
            }
            if ((await store.getView(sessionId)).runs.some((run) => !run.isActive)) break;
            await Bun.sleep(10);
          }
          expect((await store.getView(sessionId)).runs.every((run) => !run.isActive)).toBeTrue();
          expect(answered).toEqual(highRisk.map((step) => step.command));
          expect(reviews).toEqual(scripts.map((step) => step.name));
          expect(readFileSync(join(workspace, 'ordinary.txt'), 'utf8').trim()).toBe('ordinary');
          expect(existsSync(join(workspace, 'approved.txt'))).toBeTrue();
          expect(existsSync(join(workspace, 'denied.txt'))).toBeFalse();
          expect(existsSync(join(workspace, 'critical.txt'))).toBeFalse();
          expect(existsSync(join(workspace, 'timed-out.txt'))).toBeFalse();
          const executions = await store.listExecutions(sessionId);
          const tools = executions.filter(
            (execution) => execution.definitionId === 'shell.execute',
          );
          expect(tools.slice(-4).map((execution) => execution.status)).toEqual([
            'failed',
            'failed',
            'failed',
            'succeeded',
          ]);
          const timedOut = tools.at(-2)!;
          expect(timedOut).toMatchObject({
            authorization: { dispatched: false, check: { decision: 'unavailable' } },
            result: {
              details: {
                code: 'authorization_check_timeout',
                adapterAttempted: false,
                dispatchCommitted: false,
                authorizationCheck: { decision: 'timeout' },
              },
            },
          });
          expect(
            (await store.listInteractions({ expectedStoreId, sessionId })).interactions,
          ).toHaveLength(2);
          const checkId = timedOut.authorization!.check!.executionId;
          const stoppedCheck = await store.getExecution(checkId);
          expect(stoppedCheck).toMatchObject({
            status: 'failed',
            result: { code: 'authorization_check_timeout' },
          });
          releaseLateReview();
          const lateDeadline = Date.now() + 3000;
          while (!lateAnswerAttempted && Date.now() < lateDeadline) await Bun.sleep(10);
          expect(lateAnswerAttempted).toBeTrue();
          expect(await store.getExecution(checkId)).toEqual(stoppedCheck);
          const jobs = executions.filter((execution) => execution.definitionId === 'shell.command');
          expect(jobs.some((job) => job.parentExecutionId === timedOut.id)).toBeFalse();
          for (const job of jobs.slice(reads.length, -1)) {
            expect(job.authorization?.policy).toMatchObject({
              reason: 'parent_review',
              sourceExecutionId: job.parentExecutionId,
            });
            expect(job.authorization?.policy?.checkExecutionId).toBeDefined();
          }
          expect(jobs.map((execution) => execution.status)).toEqual(
            Array(reads.length + 3).fill('succeeded'),
          );
          expect(
            [...jobs.slice(0, reads.length), jobs.at(-1)!].map((execution) => execution.reference),
          ).toEqual(
            Array.from({ length: reads.length + 1 }, () =>
              expect.objectContaining({
                confinement: expect.objectContaining({ filesystem: 'read_only' }),
              }),
            ),
          );
          for (const [index, job] of jobs.entries()) {
            const expected = [
              'search-needle',
              'search-needle changed',
              ' M input.txt',
              'input.txt',
              'fixture commit',
            ][index];
            const output = await store.listExecutionOutput({
              executionId: job.id,
              afterSeq: '0',
            });
            const text = output.items
              .filter((chunk) => chunk.stream === 'stdout')
              .map((chunk) => chunk.content)
              .join('');
            if (expected) expect(text, commands[index]).toContain(expected);
            expect(text).not.toContain('external-helper');
          }
        } finally {
          releaseLateReview();
          await runtime.close();
          await store.close();
          await workspaceSerialLocks.close();
        }
      } finally {
        removeTemporaryDirectory(root);
      }
    },
    65000,
  );
}
