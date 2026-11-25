import { afterAll, beforeAll, expect, test } from 'bun:test';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { temporaryDirectory } from '../../../../../tests/fixtures/test-filesystem';
import { prepareQualifiedSqliteFixture } from '../../../../../tests/fixtures/unified-agent/qualified-sqlite-fixture';
import { createArtifactStore } from '../../../src/artifacts';
import { createRuntime } from '../../../src/runtime';
import { openSqliteStore } from '../../../src/sqlite';
import { authorizationClockBinding } from './authorization-check-clock-fixture';

// The runner isolates this file. Select the qualified SQLite engine before opening any DB.
let qualified: Awaited<ReturnType<typeof prepareQualifiedSqliteFixture>> | undefined;
beforeAll(async () => {
  qualified = await prepareQualifiedSqliteFixture();
}, 60000);
afterAll(() => qualified?.close());

type Ready = {
  expectedStoreId: string;
  runId: string;
  expectedOwnerGeneration: string;
  targetId: string;
  checkId: string;
  checkPayload: unknown;
};
async function seed(shape: 'current' | 'context') {
  const directory = temporaryDirectory('kite-current-check-recovery-');
  const child = Bun.spawn(
    [
      process.execPath,
      fileURLToPath(new URL('./authorization-check-clock-crash-child.ts', import.meta.url)),
      directory,
      JSON.stringify(qualified!.engine.selection),
      shape,
    ],
    { stdout: 'pipe', stderr: 'pipe' },
  );
  try {
    const deadline = Date.now() + 8000;
    while (!existsSync(join(directory, 'ready.json'))) {
      if (child.exitCode !== null || Date.now() > deadline) {
        child.kill('SIGKILL');
        await child.exited;
        throw Error(`check_seed_failed:${await new Response(child.stderr).text()}`);
      }
      await Bun.sleep(5);
    }
    const ready = JSON.parse(readFileSync(join(directory, 'ready.json'), 'utf8')) as Ready;
    child.kill('SIGKILL');
    const exit = await child.exited;
    expect(child.signalCode === 'SIGKILL' || exit === 137).toBe(true);
    return { directory, ready, profile: { dataRoot: join(directory, 'data'), profile: 'test' } };
  } catch (error) {
    if (child.exitCode === null) {
      child.kill('SIGKILL');
      await child.exited;
    }
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

for (const shape of ['current', 'context'] as const)
  test(`new ${shape} settled check survives actual SIGKILL without provider replay, reinterpretation or deadline renewal`, async () => {
    const { directory, ready, profile } = await seed(shape);
    let store: Awaited<ReturnType<typeof openSqliteStore>> | undefined;
    let runtime: ReturnType<typeof createRuntime> | undefined;
    const counts = { checks: 0, models: 0, effects: 0 };
    try {
      // Cold observation consumes only the sealed v1 receipt. Its current interpreter deliberately throws.
      store = await openSqliteStore({ ...profile, mode: 'readonly' });
      const cursor = (await store.getMetadata()).lastChangeCursor;
      const coldCheck = (await store.getExecution(ready.checkId))!;
      expect(coldCheck.status).toBe('succeeded');
      expect(
        (coldCheck.result as { authorizationCheckOutput: { version: number } })
          .authorizationCheckOutput.version,
      ).toBe(1);
      expect((await store.getMetadata()).lastChangeCursor).toBe(cursor);
      expect(readFileSync(join(directory, 'checks'), 'utf8')).toBe('check\n');
      expect(readFileSync(join(directory, 'interpretations'), 'utf8')).toBe('interpret\n');
      await store.close();
      store = await openSqliteStore(profile);
      const originalRun = (await store.getRun(ready.runId))!;
      const originalCheck = (await store.getExecution(ready.checkId))!;
      const configuration = originalRun.configuration as {
        authorizationCheck: { id: string; version: string; modelId: string; timeoutMs: number };
        toolBehaviors: unknown[];
      };
      expect(configuration.authorizationCheck).toEqual({
        id: 'checker',
        version: '1',
        modelId: 'review',
        timeoutMs: 3000,
      });
      expect(configuration.toolBehaviors).toHaveLength(1);
      // The saved check deadline covers all three attempts, each with a 3000 ms limit.
      expect(
        (ready.checkPayload as { timeout: { startedAt: number; deadlineAt: number } }).timeout
          .deadlineAt -
          (ready.checkPayload as { timeout: { startedAt: number; deadlineAt: number } }).timeout
            .startedAt,
      ).toBe(9000);
      runtime = createRuntime({
        store,
        artifacts: createArtifactStore({ profile, store }),
        ...authorizationClockBinding(directory, false, counts, shape === 'context'),
      });
      const base = { expectedStoreId: ready.expectedStoreId, sessionId: 's', subjectId: 'owner' };
      const card = (await runtime.listInteractions({ ...base, state: 'pending' })).interactions[0]!;
      await runtime.resumeRun({
        ...base,
        commandId: 'resume',
        runId: ready.runId,
        expectedOwnerGeneration: ready.expectedOwnerGeneration,
      });
      await runtime.answerInteraction({
        ...base,
        commandId: 'answer',
        presentationSessionId: 's',
        interactionId: card.id,
        expectedRevision: card.revision,
        answer: { kind: 'approval', decision: 'approve', optionId: 'once' },
      });
      await runtime.waitForCommand('work', { timeoutMs: 5000 });
      expect((await store.getExecution(ready.targetId))!.status).toBe('succeeded');
      expect((await store.getRun(ready.runId))!.configuration).toEqual(originalRun.configuration);
      const check = (await store.getExecution(ready.checkId))!;
      expect(check.result).toEqual(originalCheck.result);
      expect(
        ((await store.getCommand(check.originCommandId))!.request as { input: unknown }).input,
      ).toEqual(ready.checkPayload);
      expect(
        (await store.listExecutions('s')).filter(
          (execution) => execution.kind === 'model' && execution.runId === null,
        ),
      ).toHaveLength(1);
      expect(counts).toEqual({ checks: 0, models: 1, effects: 1 });
      expect(readFileSync(join(directory, 'checks'), 'utf8')).toBe('check\n');
      expect(readFileSync(join(directory, 'interpretations'), 'utf8')).toBe('interpret\n');
      expect(readFileSync(join(directory, 'effects'), 'utf8')).toBe('effect\n');
      const repeated = await runtime
        .resumeRun({
          ...base,
          commandId: 'resume-again',
          runId: ready.runId,
          expectedOwnerGeneration: ready.expectedOwnerGeneration,
        })
        .catch((error) => error);
      expect(repeated).toMatchObject({ code: 'owner_changed' });
      expect(counts).toEqual({ checks: 0, models: 1, effects: 1 });
    } finally {
      await runtime?.close();
      await store?.close();
      rmSync(directory, { recursive: true, force: true });
    }
  }, 20000);

for (const mutation of [
  'checker-missing',
  'checker-id',
  'checker-version',
  'checker-model',
  'checker-budget',
  'tool-version',
  'missing-behavior',
  'behavior-configuration',
] as const)
  test(`new Run explicitly rejects ${mutation} recovery drift without replaying its settled check`, async () => {
    const { directory, ready, profile } = await seed('current');
    const store = await openSqliteStore(profile);
    const counts = { checks: 0, models: 0, effects: 0 };
    const binding = authorizationClockBinding(directory, false, counts);
    if (mutation === 'checker-id') binding.authorizationCheck.id = 'different';
    if (mutation === 'checker-version') binding.authorizationCheck.version = 'different';
    if (mutation === 'checker-model') binding.authorizationCheck.modelId = 'different';
    if (mutation === 'checker-budget') binding.authorizationCheck.timeoutMs = 6000;
    if (mutation === 'tool-version') {
      binding.extensions[0]!.tools[0]!.version = '2';
      binding.toolBehaviors = [];
    }
    if (mutation === 'missing-behavior') binding.toolBehaviors = [];
    if (mutation === 'behavior-configuration')
      binding.toolBehaviors = [
        { ...binding.toolBehaviors[0]!, configurationDigest: 'b'.repeat(64) },
      ];
    const runtime = createRuntime({
      store,
      artifacts: createArtifactStore({ profile, store }),
      ...binding,
      ...(mutation === 'checker-missing' ? { authorizationCheck: undefined } : {}),
    });
    try {
      const original = (await store.getRun(ready.runId))!;
      const executions = await store.listExecutions('s');
      const before = (await store.getMetadata()).lastChangeCursor;
      const error = await runtime
        .resumeRun({
          expectedStoreId: ready.expectedStoreId,
          sessionId: 's',
          subjectId: 'owner',
          commandId: 'resume',
          runId: ready.runId,
          expectedOwnerGeneration: ready.expectedOwnerGeneration,
        })
        .catch((error) => error);
      expect(error).toMatchObject({ code: 'run_configuration_mismatch' });
      expect((await store.getRun(ready.runId))!.configuration).toEqual(original.configuration);
      expect(await store.listExecutions('s')).toEqual(executions);
      const changes = await store.getChanges({ after: before, limit: 20 });
      expect(
        changes.events.map((event) => ({ type: event.type, objectId: event.objectId })),
      ).toEqual([{ type: 'run.resume_prepared', objectId: 'resume' }]);
      expect(counts).toEqual({ checks: 0, models: 0, effects: 0 });
      expect(readFileSync(join(directory, 'checks'), 'utf8')).toBe('check\n');
      expect(readFileSync(join(directory, 'interpretations'), 'utf8')).toBe('interpret\n');
      expect(existsSync(join(directory, 'effects'))).toBe(false);
    } finally {
      await runtime.close();
      await store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  }, 20000);
