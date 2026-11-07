import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { ModelRequest } from '@kite-ai/ai';
import { createArtifactStore } from '../../../src/artifacts';
import { createRuntime } from '../../../src/runtime';
import { openSqliteStore } from '../../../src/sqlite';
import type { Store } from '../../../src/storage/port';
import { guidanceConfiguration } from './completion-guidance.fixture';

for (const mode of ['same', 'changed', 'owners', 'compression', 'refresh'] as const)
  test(`completion guidance consumes each owner's latest delivered fact: ${mode}`, async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-completion-guidance-')));
    const profile = { dataRoot: join(root, 'data'), profile: 'test' };
    const store = await openSqliteStore(profile);
    const expectedStoreId = (await store.getMetadata()).storeId;
    const requests: ModelRequest[] = [];
    let key = 'original';
    const config = guidanceConfiguration(root, {
      owners: mode === 'owners' ? 2 : 1,
      key: () => key,
      compress: mode === 'compression',
      refresh: mode === 'refresh',
      onModel: (request) => {
        requests.push(request);
        if (mode === 'changed' && requests.length === 2) key = 'new-fact';
      },
    });
    const runtime = createRuntime({
      store,
      permissions: config.permissions!,
      artifacts: createArtifactStore({ profile, store }),
      resolveRunConfiguration: async () => config,
    });
    const base = { expectedStoreId, sessionId: 's', subjectId: 'owner' };
    try {
      await runtime.createWorkspace({
        expectedStoreId,
        id: 'w',
        name: 'temporary',
        rootUri: pathToFileURL(root).href,
      });
      await runtime.createSession({
        ...base,
        commandId: 'create',
        workspaceId: 'w',
        title: 'guidance',
      });
      for (const commandId of ['work', 'new-run']) {
        const before = requests.length;
        await runtime.submitCommand({
          ...base,
          commandId,
          request: { kind: 'run.start', content: 'Original task' },
        });
        const command = await runtime.waitForCommand(commandId, { timeoutMs: 5000 });
        expect((await store.getRun((command.receipt as { runId: string }).runId))?.status).toBe(
          'failed',
        );
        expect(requests.length - before).toBe(
          mode === 'owners' ||
            ((mode === 'compression' || mode === 'changed') && commandId === 'work')
            ? 3
            : 2,
        );
      }
      const failures = (await store.listExecutions('s', 200)).filter(
        (row) => row.status !== 'succeeded',
      );
      expect(failures).toHaveLength(mode === 'refresh' ? 1 : 0);
      if (mode === 'refresh')
        expect(failures[0]).toMatchObject({
          status: 'failed',
          result: { code: 'context_refresh_required' },
        });
    } finally {
      await runtime.close();
      await store.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

for (const frontier of [
  'planned',
  'settled',
  'static-planned',
  'static-settled',
  'corrupt-marker',
  'foreign-owner',
  'extra-field',
] as const)
  test(`same-Run cold recovery retains ${frontier} diagnostic delivery proof`, async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-completion-guidance-cold-')));
    const profile = { dataRoot: join(root, 'data'), profile: 'test' };
    const child = Bun.spawn(
      [
        process.execPath,
        fileURLToPath(new URL('./completion-guidance-crash.fixture.ts', import.meta.url)),
        root,
        frontier.startsWith('static-') ? frontier : frontier === 'planned' ? 'planned' : 'settled',
      ],
      { stdout: 'pipe', stderr: 'pipe' },
    );
    let runtime: ReturnType<typeof createRuntime> | undefined;
    let store: Awaited<ReturnType<typeof openSqliteStore>> | undefined;
    try {
      const deadline = Date.now() + 5000;
      while (!existsSync(join(root, 'ready.json'))) {
        if (Date.now() > deadline) throw Error('guidance_child_timeout');
        await Bun.sleep(5);
      }
      const ready = JSON.parse(readFileSync(join(root, 'ready.json'), 'utf8'));
      child.kill('SIGKILL');
      await child.exited;
      store = await openSqliteStore(profile);
      const config = guidanceConfiguration(root);
      const actualConfig = frontier.startsWith('static-')
        ? { ...config, extensions: undefined }
        : config;
      const restorable = ['planned', 'settled', 'static-planned', 'static-settled'].includes(
        frontier,
      );
      const wrapped = new Proxy(store, {
        get(target, key) {
          if (key === 'verifyRunResume' && !restorable)
            return async (input: Parameters<Store['verifyRunResume']>[0]) => {
              const state = await target.verifyRunResume(input);
              const source = state.executions.at(-1)!.decisionSource as {
                sourceBody?: unknown;
                continuation: { completionGuidance: { pending: Record<string, unknown> } };
              };
              expect(source.sourceBody).toBeUndefined();
              const pending = source.continuation.completionGuidance.pending;
              if (frontier === 'corrupt-marker') pending.sourceDigest = '0'.repeat(64);
              if (frontier === 'foreign-owner') pending.extensionId = 'unregistered.owner';
              if (frontier === 'extra-field') pending.extra = 'not Core metadata';
              return state;
            };
          const value = Reflect.get(target, key);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      runtime = createRuntime({
        store: wrapped,
        extensions: frontier.startsWith('static-') ? config.extensions : undefined,
        permissions: config.permissions!,
        artifacts: createArtifactStore({ profile, store: wrapped }),
        resolveRunConfiguration: async () => actualConfig,
        resolveRecoveryRunConfiguration: async () => actualConfig,
      });
      if (!restorable) {
        const error = await runtime
          .resumeRun({ ...ready, commandId: 'resume', sessionId: 's', subjectId: 'owner' })
          .catch((error) => error);
        expect(error.code).toBe('run_continuation_invalid');
        expect(readFileSync(join(root, 'model-ledger'), 'utf8').trim().split('\n')).toHaveLength(2);
        return;
      }
      await runtime.resumeRun({
        ...ready,
        commandId: 'resume',
        sessionId: 's',
        subjectId: 'owner',
      });
      const deadline2 = Date.now() + 5000;
      while ((await store.getRun(ready.runId))!.isActive) {
        if (Date.now() > deadline2) throw Error('guidance_resume_timeout');
        await Bun.sleep(5);
      }
      expect((await store.getRun(ready.runId))?.status).toBe('failed');
      expect(readFileSync(join(root, 'model-ledger'), 'utf8').trim().split('\n')).toHaveLength(2);
      expect((await store.getExecution(ready.executionId))?.status).toBe('succeeded');
      expect(
        (await store.listExecutions('s', 200)).filter((row) => row.kind === 'model'),
      ).toHaveLength(2);
    } finally {
      if (child.exitCode === null) {
        child.kill('SIGKILL');
        await child.exited;
      }
      await runtime?.close();
      await store?.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 15000);
