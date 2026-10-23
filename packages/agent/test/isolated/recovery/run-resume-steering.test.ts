import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ModelRequest } from '@kite-ai/ai';
import { createArtifactStore } from '../../../src/artifacts';
import { createRuntime } from '../../../src/runtime';
import { openSqliteStore } from '../../../src/sqlite';
import { binding } from './run-resume-fixture';
import { agentGuidance, steeringAgentOptions } from './run-resume-steering-agent-fixture';

const guidance = 'Keep the original task; correction: Blue 雪, never Red.';
for (const proof of [
  'valid',
  'receipt',
  'body',
  'dispatched',
  'unknown',
  'wrong-input',
  'old-receipt',
] as const)
  test(`SIGKILL after applied steer restores only proven superseded Model (${proof})`, async () => {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), 'kite-steer-resume-')));
    const child = Bun.spawn(
      [
        process.execPath,
        fileURLToPath(new URL('./run-resume-crash-child.ts', import.meta.url)),
        directory,
        'steer_applied',
      ],
      { stdout: 'pipe', stderr: 'pipe' },
    );
    let store: Awaited<ReturnType<typeof openSqliteStore>> | undefined;
    let runtime: ReturnType<typeof createRuntime> | undefined;
    try {
      const deadline = Date.now() + 5000;
      while (!existsSync(join(directory, 'ready.json'))) {
        if (Date.now() > deadline) throw Error('steer_crash_timeout');
        await Bun.sleep(5);
      }
      child.kill('SIGKILL');
      await child.exited;
      let ready = JSON.parse(readFileSync(join(directory, 'ready.json'), 'utf8')) as {
        expectedStoreId: string;
        runId: string;
        expectedOwnerGeneration: string;
        executionId: string;
      };
      const retiredId = ready.executionId;
      if (proof === 'old-receipt') {
        const next = Bun.spawn(
          [
            process.execPath,
            fileURLToPath(new URL('./run-resume-crash-child.ts', import.meta.url)),
            directory,
            'steer_applied',
            'after-steer',
          ],
          { stdout: 'pipe', stderr: 'pipe' },
        );
        try {
          const end = Date.now() + 5000;
          while (!existsSync(join(directory, 'ready-after-steer.json'))) {
            if (Date.now() > end) throw Error('second_plan_timeout');
            await Bun.sleep(5);
          }
          ready = JSON.parse(readFileSync(join(directory, 'ready-after-steer.json'), 'utf8'));
          expect(ready.executionId).not.toBe(retiredId);
        } finally {
          next.kill('SIGKILL');
          await next.exited;
        }
      }
      const profile = { dataRoot: join(directory, 'data'), profile: 'test' };
      const db = new Database(join(profile.dataRoot, 'test', 'core.db'));
      try {
        const input = db
          .query("SELECT status,receipt_json FROM command WHERE id='applied-steer'")
          .get() as { status: string; receipt_json: string };
        const receipt = JSON.parse(input.receipt_json) as {
          messageId: string;
          supersededExecutionIds: string[];
        };
        const body = db
          .query('SELECT source_json FROM message WHERE id=?')
          .get(receipt.messageId) as { source_json: string };
        expect(input.status).toBe('applied');
        expect(JSON.parse(body.source_json)).toMatchObject({
          content: guidance,
          originCommandId: 'applied-steer',
          inputKind: 'input.steer',
          sourceIds: ['applied-steer'],
        });
        expect(receipt.supersededExecutionIds).toEqual([retiredId]);
        expect(
          db.query('SELECT state,dispatched FROM execution WHERE id=?').get(retiredId),
        ).toEqual({ state: 'cancelled', dispatched: 0 });
        if (proof === 'receipt' || proof === 'old-receipt')
          db.query("UPDATE command SET receipt_json=? WHERE id='applied-steer'").run(
            JSON.stringify({ ...receipt, supersededExecutionIds: [] }),
          );
        if (proof === 'body')
          db.query('UPDATE message SET source_json=? WHERE id=?').run(
            JSON.stringify({ ...JSON.parse(body.source_json), content: 'Forged replacement' }),
            receipt.messageId,
          );
        if (proof === 'dispatched')
          db.query('UPDATE execution SET dispatched=1 WHERE id=?').run(ready.executionId);
        if (proof === 'unknown')
          db.query("UPDATE execution SET state='outcome_unknown' WHERE id=?").run(
            ready.executionId,
          );
        if (proof === 'wrong-input') {
          const result = (
            db.query('SELECT result_json FROM execution WHERE id=?').get(ready.executionId) as {
              result_json: string;
            }
          ).result_json;
          const parsed = JSON.parse(result);
          parsed.details.inputCommandId = 'work';
          db.query('UPDATE execution SET result_json=? WHERE id=?').run(
            JSON.stringify(parsed),
            ready.executionId,
          );
        }
      } finally {
        db.close();
      }
      store = await openSqliteStore(profile);
      const requests: ModelRequest[] = [];
      runtime = createRuntime({
        store,
        artifacts: createArtifactStore({ profile, store }),
        permissions: binding(directory, 'steer_applied').permissions!,
        resolveRecoveryRunConfiguration: async () => ({
          ...binding(directory, 'steer_applied'),
          model: {
            async *stream(request) {
              requests.push(structuredClone(request));
              yield { type: 'text_delta', text: 'Finished from current proven history' };
              yield { type: 'finish', reason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } };
            },
          },
        }),
      });
      const resume = { ...ready, commandId: 'resume', sessionId: 's', subjectId: 'owner' };
      if (proof !== 'valid') {
        const error = await runtime.resumeRun(resume).then(
          () => null,
          (error) => error,
        );
        expect(error).toMatchObject({ code: 'run_resume_checkpoint_unavailable' });
        expect(requests).toHaveLength(0);
        expect(await store.getCommand('resume')).toBeNull();
        return;
      }
      await runtime.resumeRun(resume);
      await runtime.waitForCommand('work', { timeoutMs: 5000 });
      expect(requests).toHaveLength(1);
      const actual = requests[0]!;
      expect(actual.requestId).not.toBe(ready.executionId);
      expect(
        actual.messages.filter((message) => message.sourceIds?.includes('applied-steer')),
      ).toEqual([{ role: 'user', content: guidance, sourceIds: ['applied-steer'] }]);
      const originals = actual.messages.filter((message) =>
        message.sourceIds?.some((id) => id === 'work' || id === 'applied-steer'),
      );
      expect(originals.map((message) => message.sourceIds)).toEqual([['work'], ['applied-steer']]);
      expect((await store.getRun(ready.runId))!).toMatchObject({
        id: ready.runId,
        status: 'completed',
        originCommandId: 'work',
      });
      expect(await store.getExecution(ready.executionId)).toMatchObject({
        status: 'cancelled',
        result: { content: 'superseded_by_user_input' },
      });
      const next = await store.getExecution(actual.requestId);
      expect(next).toMatchObject({ runId: ready.runId, status: 'succeeded' });
      expect((next!.decisionSource as { retry?: unknown }).retry).toBeUndefined();
      const saved = await runtime.readModelInput({
        expectedStoreId: ready.expectedStoreId,
        sessionId: 's',
        subjectId: 'owner',
        executionId: actual.requestId,
      });
      expect(saved.request.messages).toEqual(actual.messages);
      expect(await runtime.resumeRun(resume)).toMatchObject({ status: 'applied' });
      expect(requests).toHaveLength(1);
      await runtime.close();
      runtime = undefined;
      await store.close();
      store = undefined;
      const cold = await openSqliteStore({ ...profile, mode: 'readonly' });
      try {
        const cursor = (await cold.getMetadata()).lastChangeCursor;
        expect(
          (await cold.listMessages('s')).filter((message) =>
            message.sourceIds?.includes('applied-steer'),
          ),
        ).toHaveLength(1);
        expect((await cold.getRun(ready.runId))?.status).toBe('completed');
        expect((await cold.getMetadata()).lastChangeCursor).toBe(cursor);
        expect(requests).toHaveLength(1);
      } finally {
        await cold.close();
      }
    } finally {
      child.kill('SIGKILL');
      await child.exited;
      if (runtime) await runtime.close();
      if (store) await store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  }, 10000);

for (const source of ['valid', 'damaged', 'both-missing', 'parent-cancelled'] as const)
  test(`SIGKILL preserves parent-to-child steering attribution through group resume (${source})`, async () => {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), 'kite-agent-steer-resume-')));
    const child = Bun.spawn(
      [
        process.execPath,
        fileURLToPath(new URL('./run-resume-steering-agent-crash-child.ts', import.meta.url)),
        directory,
      ],
      { stdout: 'pipe', stderr: 'pipe' },
    );
    let store: Awaited<ReturnType<typeof openSqliteStore>> | undefined;
    let runtime: ReturnType<typeof createRuntime> | undefined;
    try {
      const end = Date.now() + 8000;
      while (!existsSync(join(directory, 'ready.json'))) {
        if (Date.now() > end) {
          child.kill('SIGKILL');
          await child.exited;
          throw Error(`agent_crash_timeout: ${await new Response(child.stderr).text()}`);
        }
        await Bun.sleep(5);
      }
      child.kill('SIGKILL');
      await child.exited;
      const ready = JSON.parse(readFileSync(join(directory, 'ready.json'), 'utf8')) as {
        expectedStoreId: string;
        runId: string;
        expectedOwnerGeneration: string;
        executionId: string;
        childRunId: string;
        childExecutionId: string;
        steerId: string;
      };
      const profile = { dataRoot: join(directory, 'data'), profile: 'test' };
      const db = new Database(join(profile.dataRoot, 'test', 'core.db'));
      try {
        const command = db
          .query(
            'SELECT status,agent_source_execution_id,agent_carrier_execution_id FROM command WHERE id=?',
          )
          .get(ready.steerId) as {
          status: string;
          agent_source_execution_id: string;
          agent_carrier_execution_id: string;
        };
        expect(command.status).toBe('applied');
        expect(command.agent_source_execution_id).toBeTruthy();
        expect(command.agent_carrier_execution_id).toBeTruthy();
        expect(
          db.query('SELECT state,dispatched FROM execution WHERE id=?').get(ready.childExecutionId),
        ).toEqual({ state: 'cancelled', dispatched: 0 });
        if (source === 'damaged')
          db.query('UPDATE command SET agent_source_execution_id=? WHERE id=?').run(
            ready.executionId,
            ready.steerId,
          );
        if (source === 'both-missing')
          db.query(
            'UPDATE command SET agent_source_execution_id=NULL,agent_carrier_execution_id=NULL WHERE id=?',
          ).run(ready.steerId);
        if (source === 'parent-cancelled')
          db.query("UPDATE command SET cancelled=1 WHERE id='work'").run();
      } finally {
        db.close();
      }
      store = await openSqliteStore(profile);
      writeFileSync(join(directory, 'resuming'), 'resume');
      const before = readFileSync(join(directory, 'ledger'), 'utf8');
      runtime = createRuntime({
        store,
        artifacts: createArtifactStore({ profile, store }),
        ...steeringAgentOptions(directory),
      });
      const input = { ...ready, commandId: 'resume', sessionId: 's', subjectId: 'owner' };
      if (source !== 'valid') {
        const error = await runtime.resumeRun(input).then(
          () => null,
          (error) => error,
        );
        expect(error).toBeInstanceOf(Error);
        expect(readFileSync(join(directory, 'ledger'), 'utf8')).toBe(before);
        return;
      }
      await runtime.resumeRun(input);
      await runtime.waitForCommand('work', { timeoutMs: 5000 });
      const deadline = Date.now() + 5000;
      while ((await store.getRun(ready.childRunId))?.isActive) {
        if (Date.now() > deadline) throw Error('child_resume_timeout');
        await Bun.sleep(5);
      }
      const rows = readFileSync(join(directory, 'ledger'), 'utf8')
        .split('\n')
        .filter((line) => line.startsWith('child:'));
      expect(rows).toHaveLength(1);
      const request = JSON.parse(rows[0]!.slice('child:'.length)) as ModelRequest;
      const guide = request.messages.filter((message) =>
        message.sourceIds?.includes(ready.steerId),
      );
      expect(guide).toHaveLength(1);
      expect(guide[0]!.role).toBe('user');
      expect(JSON.parse(guide[0]!.content)).toMatchObject({
        kind: 'agent_message',
        content: agentGuidance,
      });
      expect(guide[0]!.content).not.toBe(agentGuidance);
      expect((await store.getRun(ready.childRunId))?.status).toBe('completed');
      expect((await store.getExecution(ready.childExecutionId))?.status).toBe('cancelled');
      expect((await store.getExecution(request.requestId))?.runId).toBe(ready.childRunId);
      expect(
        (await store.listMessages((await store.getRun(ready.childRunId))!.sessionId)).filter(
          (message) => message.sourceIds?.includes(ready.steerId),
        ),
      ).toHaveLength(1);
    } finally {
      child.kill('SIGKILL');
      await child.exited;
      if (runtime) await runtime.close();
      if (store) await store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  }, 15000);
