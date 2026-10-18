import { expect, test } from 'bun:test';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { temporaryDirectory } from '../../../../../tests/fixtures/test-filesystem';
import { createArtifactStore } from '../../../src/artifacts';
import type {
  ModelSettledEvent,
  ModelStartedEvent,
  RunSettledEvent,
  RunStartedEvent,
} from '../../../src/extensions';
import { createRuntime } from '../../../src/runtime';
import { openSqliteStore } from '../../../src/sqlite';
import { binding } from '../recovery/run-resume-fixture';

async function until(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 5000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('lifecycle_recovery_timeout');
    await Bun.sleep(5);
  }
}

test.each([
  'planned_model',
  'completion',
] as const)('cold recovery resumes %s without replaying Run start or previously settled Models', async (mode) => {
  const root = temporaryDirectory('kite-lifecycle-recovery-');
  const child = Bun.spawn(
    [
      process.execPath,
      fileURLToPath(new URL('../recovery/run-resume-crash-child.ts', import.meta.url)),
      root,
      mode,
    ],
    { stdout: 'pipe', stderr: 'pipe' },
  );
  const stderr = new Response(child.stderr).text();
  const stdout = new Response(child.stdout).text();
  let store: Awaited<ReturnType<typeof openSqliteStore>> | undefined;
  let runtime: ReturnType<typeof createRuntime> | undefined;
  try {
    await until(async () => {
      if (child.exitCode !== null) throw new Error(`fixture_exit:${await stderr}`);
      return existsSync(join(root, 'ready.json'));
    });
    const ready = JSON.parse(readFileSync(join(root, 'ready.json'), 'utf8')) as {
      expectedStoreId: string;
      runId: string;
      expectedOwnerGeneration: string;
      executionId: string;
    };
    child.kill('SIGKILL');
    await child.exited;
    await stdout;
    expect(await stderr).toBe('');
    const profile = { dataRoot: join(root, 'data'), profile: 'test' };
    store = await openSqliteStore(profile);
    const events: (RunStartedEvent | ModelStartedEvent | ModelSettledEvent | RunSettledEvent)[] =
      [];
    const observe = (event: (typeof events)[number]) => {
      events.push(event);
    };
    const config = binding(root, mode);
    runtime = createRuntime({
      store,
      artifacts: createArtifactStore({ profile, store }),
      permissions: config.permissions!,
      resolveRecoveryRunConfiguration: async () => ({
        ...config,
        extensions: config.extensions!.map((extension) => ({
          ...extension,
          lifecycle: {
            onRunStart: observe,
            onModelStart: observe,
            onModelEnd: observe,
            onRunEnd: observe,
          },
        })),
      }),
    });
    const ledgerBefore = readFileSync(join(root, 'ledger'), 'utf8');
    await runtime.getView('s');
    expect(events).toEqual([]);
    const input = {
      ...ready,
      commandId: 'resume',
      sessionId: 's',
      subjectId: 'owner',
    };
    await runtime.resumeRun(input);
    await until(() => events.some((event) => event.type === 'run.settled'));
    expect(events.some((event) => event.type === 'run.started')).toBe(false);
    const starts = events.filter((event) => event.type === 'model.started');
    const ends = events.filter((event) => event.type === 'model.settled');
    const actualCalls = readFileSync(join(root, 'ledger'), 'utf8')
      .slice(ledgerBefore.length)
      .split('\n')
      .filter((line) => line.startsWith('model:'));
    expect(starts.map((event) => `model:${event.executionId}`)).toEqual(actualCalls);
    expect(ends.map((event) => event.executionId)).toEqual(
      starts.map((event) => event.executionId),
    );
    expect(events.filter((event) => event.type === 'run.settled')).toMatchObject([
      { runId: ready.runId, originCommandId: 'work', status: 'completed' },
    ]);
    const eventIds = events.map((event) => event.eventId);
    await runtime.resumeRun(input);
    await runtime.getView('s');
    expect(events.map((event) => event.eventId)).toEqual(eventIds);
  } finally {
    child.kill('SIGKILL');
    await child.exited;
    await runtime?.close();
    await store?.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 15000);
