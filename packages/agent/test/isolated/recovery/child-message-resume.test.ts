import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleepTimer } from 'node:timers/promises';
import type { ModelRequest } from '@kite-ai/ai';
import { expect, test } from '#kite-test';
import { spawn as spawnProcess } from '../../../../../scripts/tooling/process';
import { testRuntimeFlags } from '../../../../../scripts/tooling/test-command';
import { createArtifactStore } from '../../../src/artifacts';
import { createRuntime } from '../../../src/runtime';
import { openSqliteStore } from '../../../src/sqlite';
import type { ExecutionRecord, InteractionRecord, SessionView } from '../../../src/storage/types';
import { childMessageResumeOptions } from './child-message-resume-fixture';

async function until(check: () => Promise<boolean>) {
  const deadline = Date.now() + 10000;
  while (!(await check())) {
    if (Date.now() >= deadline) throw Error('child_message_resume_boundary_unconfirmed');
    await sleepTimer(5);
  }
}
function requests(directory: string): { actor: 'parent' | 'child'; request: ModelRequest }[] {
  return readFileSync(join(directory, 'models'), 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}
function spawnFixture(directory: string) {
  return spawnProcess(
    [
      process.execPath,
      ...testRuntimeFlags,
      join(import.meta.dirname, 'child-message-resume-fixture.ts'),
      directory,
    ],
    { stdout: 'pipe', stderr: 'pipe' },
  );
}
for (const drift of ['none', 'description', 'schema', 'snapshot'] as const)
  test(`real cold current child recovery ${drift === 'none' ? 'preserves its planned effect and original Model' : `rejects unrelated ${drift} drift`}`, async () => {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), 'kite-child-message-resume-')));
    let process_: ReturnType<typeof spawnFixture> | undefined;
    let stdout: Promise<string> | undefined, stderr: Promise<string> | undefined;
    let store: Awaited<ReturnType<typeof openSqliteStore>> | undefined;
    let runtime: ReturnType<typeof createRuntime> | undefined;
    try {
      process_ = spawnFixture(directory);
      stdout = new Response(process_.stdout).text();
      stderr = new Response(process_.stderr).text();
      await until(
        async () => existsSync(join(directory, 'ready.json')) || process_!.exitCode !== null,
      );
      if (!existsSync(join(directory, 'ready.json')))
        throw Error(`current fixture exited: ${await stderr}`);
      const ready = JSON.parse(readFileSync(join(directory, 'ready.json'), 'utf8')) as {
        pid: number;
        expectedStoreId: string;
        runId: string;
        expectedOwnerGeneration: string;
        root: SessionView;
        child: SessionView;
        carrier: ExecutionRecord;
        effect: ExecutionRecord;
        card: InteractionRecord;
      };
      expect(ready.pid).toBe(process_.pid);
      expect(ready.effect.status).toBe('planned');
      expect(ready.effect.callId).toBe('original-effect-call');
      expect(readFileSync(join(directory, 'effects'), 'utf8')).toBe('');
      const originalRequests = requests(directory);
      const childRequest = originalRequests.find((row) => row.actor === 'child')!.request;
      expect(childRequest.tools.some((tool) => tool.id === 'wait_agent_events')).toBe(false);
      expect(
        childRequest.tools.find((tool) => tool.id === 'send_agent_message')?.description,
      ).toContain('A successful result acknowledges queue acceptance only');
      const originalModel = ready.child.executions.find((row) => row.kind === 'model')!;
      expect(originalModel.status).toBe('succeeded');
      process_.kill('SIGKILL');
      expect(await process_.exited).not.toBe(0);
      expect(await stdout).toBe('');
      expect(await stderr).toBe('');
      const profile = { dataRoot: join(directory, 'data'), profile: 'test' };
      store = await openSqliteStore(profile);
      expect(await store.getExecution(originalModel.id)).toEqual(originalModel);
      runtime = createRuntime({
        store,
        artifacts: createArtifactStore({ profile, store }),
        ...childMessageResumeOptions(directory, false, drift),
      });
      const modelInputScope = {
        expectedStoreId: ready.expectedStoreId,
        sessionId: ready.child.session.id,
        subjectId: 'owner',
        executionId: originalModel.id,
      };
      const canonicalInput = async () => {
        const { snapshotCursor: _observationCursor, ...input } =
          await runtime!.readModelInput(modelInputScope);
        return input;
      };
      const originalInput = await canonicalInput();
      const input = {
        expectedStoreId: ready.expectedStoreId,
        sessionId: 's',
        runId: ready.runId,
        expectedOwnerGeneration: ready.expectedOwnerGeneration,
        commandId: 'resume',
        subjectId: 'owner',
      };
      if (drift !== 'none') {
        const result = await runtime.resumeRun(input).catch((error) => error);
        expect(result.code).toBe('capability_refresh_required');
        expect(requests(directory)).toEqual(originalRequests);
        expect(readFileSync(join(directory, 'effects'), 'utf8')).toBe('');
        expect(await store.getExecution(originalModel.id)).toEqual(originalModel);
        expect(await canonicalInput()).toEqual(originalInput);
        expect((await store.getExecution(ready.effect.id))?.status).toBe('planned');
        return;
      }
      expect((await runtime.resumeRun(input)).receipt).toMatchObject({
        outcome: 'run_resumed',
        runId: ready.runId,
      });
      expect(readFileSync(join(directory, 'effects'), 'utf8')).toBe('');
      const cards = await runtime.listInteractions({
        expectedStoreId: ready.expectedStoreId,
        sessionId: 's',
        state: 'pending',
      });
      expect(cards.interactions).toEqual([ready.card]);
      await runtime.answerInteraction({
        expectedStoreId: ready.expectedStoreId,
        commandId: 'approve-original',
        subjectId: 'owner',
        presentationSessionId: 's',
        interactionId: ready.card.id,
        expectedRevision: ready.card.revision,
        answer: { kind: 'approval', decision: 'approve', optionId: 'once' },
      });
      await until(async () =>
        (await store!.getView(ready.child.session.id)).runs.every(
          (run) => run.status === 'completed',
        ),
      );
      await until(async () => (await store!.getRun(ready.runId))?.status === 'completed');
      expect(
        readFileSync(join(directory, 'effects'), 'utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line)),
      ).toEqual([{ id: ready.effect.id, input: { original: 'once' } }]);
      expect(await store.getExecution(originalModel.id)).toEqual(originalModel);
      expect(await canonicalInput()).toEqual(originalInput);
      const child = await store.getView(ready.child.session.id);
      expect(child.executions.filter((row) => row.definitionId === 'effect.once')).toHaveLength(1);
      expect(child.executions.filter((row) => row.kind === 'model')).toHaveLength(2);
      const childRequests = requests(directory).filter((row) => row.actor === 'child');
      expect(childRequests).toHaveLength(2);
      expect(childRequests[0]!.request).toEqual(childRequest);
      const next = childRequests[1]!.request;
      expect(next.tools.some((tool) => tool.id === 'wait_agent_events')).toBe(false);
      expect(next.tools).toEqual(childRequest.tools);
      const parentRequest = requests(directory)
        .filter((row) => row.actor === 'parent')
        .at(-1)!;
      expect(parentRequest.request.tools.some((tool) => tool.id === 'wait_agent_events')).toBe(
        true,
      );
      expect(
        next.messages.some((message) => message.content === 'original effect exactly once'),
      ).toBe(true);
      expect((await store.getExecution(ready.effect.id))?.status).toBe('succeeded');
    } finally {
      if (process_?.exitCode === null) {
        process_.kill('SIGKILL');
        await process_.exited;
      }
      await stdout;
      await stderr;
      await runtime?.close();
      await store?.close();
      rmSync(directory, { recursive: true, force: true });
    }
  }, 25000);
