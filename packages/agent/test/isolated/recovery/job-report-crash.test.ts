import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime } from '../../../src/runtime';
import { openSqliteStore } from '../../../src/sqlite';
import { crashReportOptions } from './job-report-crash-child';

async function deadline<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(Error('crash_fixture_deadline')), 5000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
async function line(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  let text = '';
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) throw Error('crash_fixture_early_exit');
      text += new TextDecoder().decode(chunk.value);
      if (text.length > 16384) throw Error('crash_fixture_output_invalid');
      const newline = text.indexOf('\n');
      if (newline >= 0) return text.slice(0, newline);
    }
  } finally {
    reader.releaseLock();
  }
}

test('owned SIGKILL after accepted report preserves cold reads and explicit report resume without child replay', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-job-report-crash-'))),
    ledger = join(root, 'outside-profile-model-ledger.jsonl');
  const child = Bun.spawn(
    [
      process.execPath,
      new URL('./job-report-crash-child.ts', import.meta.url).pathname,
      root,
      ledger,
    ],
    { stdout: 'pipe', stderr: 'pipe' },
  );
  let runtime: ReturnType<typeof createRuntime> | undefined;
  try {
    const ready = JSON.parse(await deadline(line(child.stdout))) as {
      storeId: string;
      sessionId: string;
      reportId: string;
      parentId: string;
      executionId: string;
    };
    expect(child.exitCode).toBeNull();
    child.kill('SIGKILL');
    expect(await deadline(child.exited)).toBe(137);
    expect(child.signalCode).toBe('SIGKILL');
    expect(await new Response(child.stderr).text()).toBe('');
    const records = () =>
      readFileSync(ledger, 'utf8')
        .trim()
        .split('\n')
        .map(
          (value) =>
            JSON.parse(value) as {
              kind: string;
              request: { messages: { sourceIds?: string[] }[] };
            },
        );
    expect(
      records()
        .map((record) => record.kind)
        .sort(),
    ).toEqual(['child', 'parent-complete', 'parent-start']);
    const profile = { dataRoot: join(root, 'data'), profile: 'crash' },
      store = await openSqliteStore(profile);
    runtime = createRuntime(crashReportOptions({ store, profile, ledger }));
    const cursor = (await store.getMetadata()).lastChangeCursor;
    const parent = (await runtime.getView(ready.sessionId)).runs.find(
      (run) => run.id === ready.parentId,
    )!;
    expect(parent.status).toBe('completed');
    expect(parent.isActive).toBe(false);
    expect((await runtime.getCommand(ready.reportId))!.status).toBe('accepted');
    expect((await store.getExecution(ready.executionId))!.status).toBe('succeeded');
    expect(
      (
        await runtime.getSelectedContext({
          expectedStoreId: ready.storeId,
          sessionId: ready.sessionId,
        })
      ).resultSources,
    ).toHaveLength(0);
    expect((await store.getMetadata()).lastChangeCursor).toBe(cursor);
    expect(records()).toHaveLength(3);
    const intent = {
      expectedStoreId: ready.storeId,
      sessionId: ready.sessionId,
      subjectId: 'owner',
      commandId: 'resume-after-real-kill',
      reportCommandId: ready.reportId,
    };
    const resumed = await deadline(runtime.resumeJobReport(intent));
    expect(resumed.receipt).toMatchObject({
      reportCommandId: ready.reportId,
      outcome: 'report_resumed',
    });
    await runtime.waitForCommand(ready.reportId, { timeoutMs: 5000 });
    expect((await runtime.resumeJobReport(intent)).id).toBe(resumed.id);
    expect(
      (await runtime.resumeJobReport({ ...intent, commandId: 'second-resume-same-report' }))
        .receipt,
    ).toEqual(resumed.receipt);
    const after = await runtime.getView(ready.sessionId);
    expect(after.runs).toHaveLength(2);
    expect(after.runs.find((run) => run.id === ready.parentId)?.status).toBe('completed');
    expect(after.runs.filter((run) => run.originCommandId === ready.reportId)).toHaveLength(1);
    const context = await runtime.getSelectedContext({
      expectedStoreId: ready.storeId,
      sessionId: ready.sessionId,
    });
    expect(context.resultSources).toHaveLength(1);
    expect(context.resultSources[0]!.executionId).toBe(ready.executionId);
    expect(context.resultSources[0]!.originStoreId).toBe(ready.storeId);
    const facts = records();
    expect(facts.filter((record) => record.kind === 'child')).toHaveLength(1);
    expect(facts.filter((record) => record.kind === 'parent-start')).toHaveLength(1);
    expect(facts.filter((record) => record.kind === 'report')).toHaveLength(1);
    expect(facts).toHaveLength(4);
    expect(
      facts
        .find((record) => record.kind === 'report')!
        .request.messages.some((message) =>
          message.sourceIds?.includes(context.resultSources[0]!.id),
        ),
    ).toBe(true);
  } finally {
    if (child.exitCode === null) {
      child.kill('SIGKILL');
      await child.exited;
    }
    await runtime?.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 12000);
