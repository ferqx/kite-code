import { expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import type { ExecutionRecord } from '@kite-ai/agent/storage';
import { createClient } from '@kite-ai/client';
import { semanticDigest } from '../../../../packages/agent/src/json';
import { startService } from '../../src';
import {
  ancestorText,
  ledgerLines,
  longRunRuntime,
  rounds,
  sourceText,
  toolCount,
} from '../fixtures/long-run-resume-binding';

async function until(check: () => Promise<boolean>, milliseconds: number) {
  const deadline = performance.now() + milliseconds;
  while (!(await check())) {
    if (performance.now() >= deadline) throw Error('long_run_resume_deadline');
    await Bun.sleep(5);
  }
}
async function closeWithin<T>(operation: Promise<T>, deadline: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(Error('long_run_cleanup_unconfirmed')),
          Math.max(0, deadline - performance.now()),
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function mapBatches<T>(ids: string[], read: (id: string) => Promise<T>) {
  const values: T[] = [];
  for (let index = 0; index < ids.length; index += 32)
    values.push(...(await Promise.all(ids.slice(index, index + 32).map(read))));
  return values;
}

test('public cold resume preserves over 4096 genuine original executions and discovered sources without replaying completed work', async () => {
  const root = realpathSync(mkdtempSync('/private/tmp/kite-long-run-resume-'));
  const workspace = join(root, 'workspace');
  mkdirSync(join(workspace, 'nested'), { recursive: true });
  writeFileSync(join(workspace, 'AGENTS.md'), sourceText);
  writeFileSync(join(workspace, 'nested', 'AGENTS.md'), ancestorText);
  writeFileSync(join(workspace, 'nested', 'value.txt'), 'original target');
  const ledger = join(root, 'ledger');
  writeFileSync(ledger, '');
  const profile = { dataRoot: join(root, 'data'), profile: 'owned' };
  const child = Bun.spawn(
    [
      process.execPath,
      new URL('../fixtures/long-run-resume-child.ts', import.meta.url).pathname,
      root,
    ],
    { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
  );
  const stdout = new Response(child.stdout).text();
  const stderr = new Response(child.stderr).text();
  let store: Awaited<ReturnType<typeof openSqliteStore>> | undefined;
  let runtime: ReturnType<typeof longRunRuntime> | undefined;
  let service: Awaited<ReturnType<typeof startService>> | undefined;
  let client: ReturnType<typeof createClient> | undefined;
  let failure: unknown;
  const cleanup: unknown[] = [];
  try {
    await until(async () => {
      if (child.exitCode !== null)
        throw Error(`long_run_hot_exit:${child.exitCode}:${await stderr}`);
      return existsSync(join(root, 'ready.json'));
    }, 120000);
    const ready = JSON.parse(readFileSync(join(root, 'ready.json'), 'utf8')) as {
      storeId: string;
      runId: string;
      execution: ExecutionRecord;
    };
    child.kill('SIGKILL');
    expect(await child.exited).toBe(137);
    expect(child.signalCode).toBe('SIGKILL');
    expect(await stdout).toBe('');
    expect(await stderr).toBe('');
    const originalLedger = readFileSync(ledger, 'utf8');
    const lines = ledgerLines(ledger);
    const tools = lines.filter((v) => v.startsWith('tool:')).map((v) => v.slice(5));
    const models = lines.filter((v) => v.startsWith('dispatch:')).map((v) => v.slice(9));
    expect(tools).toHaveLength(toolCount);
    expect(new Set(tools).size).toBe(toolCount);
    expect(models.length).toBeGreaterThanOrEqual(rounds);
    expect(tools.length + models.length + 1).toBeGreaterThan(4096);
    expect(ready.execution.status).toBe('planned');
    expect(ready.execution.runId).toBe(ready.runId);
    store = await openSqliteStore(profile);
    runtime = longRunRuntime({ store, profile, ledger, workspace, cold: true });
    service = await startService({
      runtime,
      profile: { dataRoot: profile.dataRoot, name: profile.profile, accessKey: 'owned' },
      subjectId: 'owner',
      buildId: 'long-resume',
    });
    client = createClient({
      endpoint: service.endpoint,
      token: service.bootstrap.token,
      expected: {
        apiMajor: 1,
        profile: service.bootstrap.profile,
        instanceId: service.bootstrap.instanceId,
        buildId: service.bootstrap.buildId,
        requiredCapabilities: ['commands', 'run_resume', 'model_inputs'],
      },
    });
    await client.connect();
    const actual = client;
    // Every original ID is read explicitly: no finite View window is treated as a census.
    const before = await mapBatches([...tools, ...models], (id) => actual.getExecution(id));
    expect(before.every((v) => v.status === 'succeeded')).toBe(true);
    expect(before.every((v) => v.runId === ready.runId && v.sessionId === 's')).toBe(true);
    const planned = await actual.getExecution(ready.execution.id);
    expect(planned.status).toBe('planned');
    const originalPlanned = (await store.getExecution(planned.id))!;
    expect(originalPlanned.attempt).toBe(ready.execution.attempt);
    const plannedInput = await actual.getModelInput('s', planned.id);
    expect(plannedInput.metadata.authorization).toEqual({
      availability: 'unavailable',
      reason: 'not_dispatched',
    });
    expect(JSON.stringify(plannedInput)).toContain(sourceText);
    expect(JSON.stringify(plannedInput)).toContain(ancestorText);
    expect(readFileSync(ledger, 'utf8')).toBe(originalLedger);
    const receipt = await actual.resumeRun('s', {
      kind: 'run.resume',
      expectedStoreId: ready.storeId,
      commandId: 'resume-original',
      runId: ready.runId,
    });
    expect(receipt).toMatchObject({
      id: 'resume-original',
      status: 'applied',
      receipt: {
        outcome: 'run_resumed',
        runId: ready.runId,
        originalCommandId: 'work',
        boundary: 'before_model_dispatch',
      },
    });
    await until(async () => (await actual.getRun(ready.runId)).status === 'completed', 30000);
    const resumed = await actual.getExecution(planned.id);
    expect(resumed.status).toBe('succeeded');
    expect((await store.getExecution(planned.id))!.attempt).toBe(originalPlanned.attempt);
    expect(resumed.definitionId).toBe(planned.definitionId);
    expect(resumed.definitionVersion).toBe(planned.definitionVersion);
    expect(resumed.runId).toBe(ready.runId);
    const resumedInput = await actual.getModelInput('s', planned.id);
    expect(resumedInput.request).toEqual(plannedInput.request);
    expect(resumedInput.metadata).toEqual({
      ...plannedInput.metadata,
      authorization: {
        availability: 'available',
        allowed: true,
        revision: 'long-resume-policy',
        definitionVersion: originalPlanned.definitionVersion,
        inputDigest: await semanticDigest(originalPlanned.input),
        policy: null,
      },
    });
    expect(resumedInput.bodyHash).toBe(plannedInput.bodyHash);
    expect(resumedInput.bodyBytes).toBe(plannedInput.bodyBytes);
    expect(await mapBatches([...tools, ...models], (id) => actual.getExecution(id))).toEqual(
      before,
    );
    expect(await actual.getCommand('resume-original')).toEqual(receipt);
    expect(ledgerLines(ledger).filter((v) => v.startsWith('tool:'))).toEqual(
      lines.filter((v) => v.startsWith('tool:')),
    );
    expect(ledgerLines(ledger).filter((v) => v.startsWith('model:'))).toHaveLength(
      models.length + 1,
    );
    const afterLedger = readFileSync(ledger, 'utf8');
    expect(await actual.getRun(ready.runId)).toMatchObject({
      id: ready.runId,
      status: 'completed',
    });
    expect(await actual.getExecution(planned.id)).toEqual(resumed);
    expect(readFileSync(ledger, 'utf8')).toBe(afterLedger);
  } catch (error) {
    failure = error;
    const lines = ledgerLines(ledger);
    console.error(
      'LONG_RUN_RESUME_ACTUAL_FAILURE',
      JSON.stringify({
        root,
        originalTools: lines.filter((line) => line.startsWith('tool:')).length,
        originalModels: lines.filter((line) => line.startsWith('model:')).length,
        originalDispatches: lines.filter((line) => line.startsWith('dispatch:')).length,
        childExitCode: child.exitCode,
      }),
    );
  } finally {
    const cleanupDeadline = performance.now() + 5000;
    client?.disposeNetwork();
    if (child.exitCode === null) {
      try {
        child.kill('SIGKILL');
        await closeWithin(child.exited, cleanupDeadline);
      } catch (error) {
        cleanup.push(error);
      }
    }
    try {
      await closeWithin(Promise.resolve(service?.close()), cleanupDeadline);
    } catch (error) {
      cleanup.push(error);
    }
    let runtimeClosed = !runtime;
    try {
      await closeWithin(Promise.resolve(runtime?.close()), cleanupDeadline);
      runtimeClosed = true;
    } catch (error) {
      cleanup.push(error);
    }
    // Never release the Store under an unconfirmed Runtime owner.
    if (runtimeClosed)
      try {
        await closeWithin(Promise.resolve(store?.close()), cleanupDeadline);
      } catch (error) {
        cleanup.push(error);
      }
    if (!cleanup.length && !failure) rmSync(root, { recursive: true, force: true });
    else console.error('LONG_RUN_RESUME_RETAINED_ROOT', root);
  }
  if (cleanup.length)
    throw new AggregateError(
      failure ? [failure, ...cleanup] : cleanup,
      'long_run_resume_cleanup_failed',
    );
  if (failure) throw failure;
}, 180000);
