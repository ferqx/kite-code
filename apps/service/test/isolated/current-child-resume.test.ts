import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleepTimer } from 'node:timers/promises';
import { selectProfile } from '@kite-ai/agent/profile';
import type { ExecutionRecord, InteractionRecord, SessionView } from '@kite-ai/agent/storage';
import type { ModelRequest } from '@kite-ai/ai';
import { expect, test } from '#kite-test';
import { spawn as spawnProcess } from '../../../../scripts/tooling/process';
import { testRuntimeFlags } from '../../../../scripts/tooling/test-command';
import {
  privateDirectory,
  removeTemporaryDirectory,
  temporaryDirectory,
} from '../../../../tests/fixtures/test-filesystem';
import { currentChildContent, startCurrentChildResume } from '../fixtures/current-child-resume';

async function until(read: () => Promise<boolean>) {
  const deadline = Date.now() + 15000;
  while (!(await read())) {
    if (Date.now() >= deadline) throw Error('current_service_child_resume_timeout');
    await sleepTimer(5);
  }
}
function spawnFixture(directory: string) {
  return spawnProcess(
    [
      process.execPath,
      ...testRuntimeFlags,
      join(import.meta.dirname, '../fixtures/current-child-resume.ts'),
      directory,
    ],
    { stdout: 'pipe', stderr: 'pipe' },
  );
}
test('current default Service resumes its original general child, approval and planned file effect after SIGKILL', async () => {
  const directory = temporaryDirectory('kite-current-service-child-resume-');
  const profile = selectProfile({ dataRoot: join(directory, 'data'), profile: 'test' });
  privateDirectory(profile.profilePath);
  privateDirectory(join(directory, 'workspace'));
  writeFileSync(join(directory, 'models.ndjson'), '');
  writeFileSync(
    join(profile.profilePath, 'config.jsonc'),
    JSON.stringify({
      modelId: 'fixed',
      models: [
        {
          id: 'fixed',
          provider: 'compatible',
          model: 'fixed-controlled',
          baseURL: 'http://127.0.0.1:9/v1',
        },
      ],
      tools: ['task.spawn', 'task.events', 'files.write'].map((id) => ({ id })),
    }),
  );
  let process_: ReturnType<typeof spawnFixture> | undefined;
  let stdout: Promise<string> | undefined, stderr: Promise<string> | undefined;
  let cold: Awaited<ReturnType<typeof startCurrentChildResume>> | undefined;
  const models = () =>
    readFileSync(join(directory, 'models.ndjson'), 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { actor: string; request: ModelRequest });
  try {
    process_ = spawnFixture(directory);
    stdout = new Response(process_.stdout).text();
    stderr = new Response(process_.stderr).text();
    await until(
      async () => existsSync(join(directory, 'ready.json')) || process_!.exitCode !== null,
    );
    if (!existsSync(join(directory, 'ready.json')))
      throw Error(`current child fixture failed: ${await stderr}`);
    const ready = JSON.parse(readFileSync(join(directory, 'ready.json'), 'utf8')) as {
      expectedStoreId: string;
      root: SessionView;
      child: SessionView;
      carrier: ExecutionRecord;
      effect: ExecutionRecord;
      card: InteractionRecord;
    };
    expect(ready.carrier.definitionId).toBe('agent/general');
    expect(ready.effect.status).toBe('planned');
    expect(ready.effect.input).toEqual({
      path: join(directory, 'workspace', 'result.txt'),
      content: currentChildContent,
    });
    expect(ready.card.executionId).toBe(ready.effect.id);
    expect(ready.child.session.parentSessionId).toBe('s');
    const originalModel = ready.child.executions.find((row) => row.kind === 'model')!;
    expect(originalModel.status).toBe('succeeded');
    expect(models().filter((row) => row.actor === 'child')).toHaveLength(1);
    const originalRequest = models().find((row) => row.actor === 'child')!.request;
    process_.kill('SIGKILL');
    expect(await process_.exited).not.toBe(0);
    expect(await stdout).toBe('');
    expect(await stderr).toBe('');
    cold = await startCurrentChildResume(directory);
    const { runtime, client, store, target } = cold;
    expect(existsSync(target)).toBe(false);
    expect(await store.getExecution(originalModel.id)).toEqual(originalModel);
    const originalInput = await runtime.readModelInput({
      expectedStoreId: ready.expectedStoreId,
      sessionId: ready.child.session.id,
      subjectId: 'owner',
      executionId: originalModel.id,
    });
    const result = await client.resumeRun('s', {
      kind: 'run.resume',
      commandId: 'resume-current',
      expectedStoreId: ready.expectedStoreId,
      runId: ready.root.runs[0]!.id,
    });
    expect(result.receipt).toMatchObject({ outcome: 'run_resumed', runId: ready.root.runs[0]!.id });
    const pending = await client.listInteractions('s', {
      storeId: ready.expectedStoreId,
      state: 'pending',
    });
    expect(pending.interactions.map((row) => [row.id, row.revision, row.executionId])).toEqual([
      [ready.card.id, ready.card.revision, ready.effect.id],
    ]);
    expect(existsSync(target)).toBe(false);
    await client.answerInteraction('s', ready.card.id, {
      expectedStoreId: ready.expectedStoreId,
      commandId: 'answer-current-original',
      expectedRevision: ready.card.revision,
      answer: { kind: 'approval', decision: 'approve', optionId: 'once' },
    });
    await until(async () => {
      const root = await runtime.getView('s'),
        child = await runtime.getView(ready.child.session.id);
      if ([...root.runs, ...child.runs].some((run) => run.status === 'failed'))
        throw Error(
          `current_child_recovery_failed:${JSON.stringify([...root.runs, ...child.runs].map(({ id, sessionId, status, reason }) => ({ id, sessionId, status, reason })))}`,
        );
      return (
        root.runs.every((row) => row.status === 'completed') &&
        child.runs.every((row) => row.status === 'completed')
      );
    });
    const child = await runtime.getView(ready.child.session.id);
    const written = child.executions.find((row) => row.id === ready.effect.id)!;
    expect(written.status, JSON.stringify(written.result)).toBe('succeeded');
    expect(readFileSync(target, 'utf8')).toBe(currentChildContent);
    expect(child.runs.map((row) => row.id)).toEqual(ready.child.runs.map((row) => row.id));
    expect(
      child.executions
        .filter((row) => row.definitionId === 'files.write')
        .map((row) => [row.id, row.status, row.attempt]),
    ).toEqual([[ready.effect.id, 'succeeded', 1]]);
    expect(await store.getExecution(originalModel.id)).toEqual(originalModel);
    const afterInput = await runtime.readModelInput({
      expectedStoreId: ready.expectedStoreId,
      sessionId: ready.child.session.id,
      subjectId: 'owner',
      executionId: originalModel.id,
    });
    expect(afterInput.request).toEqual(originalInput.request);
    expect(models().filter((row) => row.actor === 'child')).toHaveLength(2);
    expect(models().find((row) => row.actor === 'child')!.request).toEqual(originalRequest);
    expect(
      (await runtime.getView('s')).executions
        .filter((row) => row.childSessionId)
        .map((row) => row.id),
    ).toEqual([ready.carrier.id]);
  } finally {
    if (process_?.exitCode === null) {
      process_.kill('SIGKILL');
      await process_.exited;
    }
    await stdout;
    await stderr;
    await cold?.close();
    removeTemporaryDirectory(directory);
  }
}, 30000);
