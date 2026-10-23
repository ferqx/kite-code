import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ModelEvent, ModelRequest } from '@kite-ai/ai';
import { createArtifactStore } from '../../../src/artifacts';
import { createFileTools, createWorkspaceFiles } from '../../../src/files';
import { createRuntime } from '../../../src/runtime';
import { openSqliteStore } from '../../../src/sqlite';
import { AgentError } from '../../../src/storage/types';

const finish = {
  type: 'finish',
  reason: 'stop',
  usage: { inputTokens: 8, outputTokens: 3 },
} satisfies ModelEvent;
function gate() {
  let release!: () => void;
  return {
    promise: new Promise<void>((resolve) => {
      release = resolve;
    }),
    release: () => release(),
  };
}
async function until<T>(read: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + 8000;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw Error('compression_boundary_timeout');
    await Bun.sleep(5);
  }
}
async function hold(promise: Promise<void>, signal: AbortSignal) {
  signal.throwIfAborted();
  await Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
    ),
  ]);
}

for (const outcome of [
  'success',
  'published-correction',
  'provider-failure',
  'rejected',
  'cancelled',
  'run-cancel',
  'forged-cancel',
] as const)
  test(`public steer arriving in a dispatched automatic summary preserves exact corrections (${outcome})`, async () => {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), 'kite-steer-summary-boundary-')));
    const profile = { dataRoot: join(directory, 'data'), profile: 'test' };
    const store = await openSqliteStore(profile);
    const expectedStoreId = (await store.getMetadata()).storeId;
    const base = { expectedStoreId, sessionId: 's', subjectId: 'owner' };
    const summaryEntered = gate(),
      releaseSummary = gate(),
      businessEntered = gate(),
      releaseBusiness = gate();
    const requests: ModelRequest[] = [],
      summaries: ModelRequest[] = [];
    const guide = `Change Red to Blue; preserve exact Unicode 雪🙂 ${crypto.randomUUID()}`;
    const correction = `Newer correction: replace Blue with Green ${crypto.randomUUID()}`;
    let reads = 0,
      attempts = 0;
    const runtime = createRuntime({
      store,
      artifacts: createArtifactStore({ profile, store }),
      modelId: 'fixed',
      permissions: { authorize: async () => ({ allowed: true, revision: 'owned' }) },
      compressor: {
        id: 'boundary',
        version: '1',
        shouldCompress: async () => reads === 1 && attempts === 0,
        prepare: async () => ({ instructions: 'BOUNDARY_SUMMARY', snapshot: {} }),
        validateSummary: async () => outcome !== 'rejected',
      },
      model: {
        async *stream(request, context) {
          if (request.messages.some((message) => message.content === 'BOUNDARY_SUMMARY')) {
            summaries.push(structuredClone(request));
            attempts++;
            summaryEntered.release();
            await hold(releaseSummary.promise, context.signal);
            if (outcome === 'provider-failure') throw Error('owned summary Provider failure');
            if (outcome === 'forged-cancel') throw new AgentError('execution_cancel_requested');
            yield {
              type: 'text_delta',
              text: 'Only completed read facts. No user correction included.',
            };
            yield finish;
            return;
          }
          requests.push(structuredClone(request));
          if (reads === 0) {
            yield { type: 'tool_call', id: 'read-once', name: 'fixture.read', arguments: '{}' };
            yield { ...finish, reason: 'tool_calls' };
            return;
          }
          if (!request.messages.some((message) => message.sourceIds?.includes('green'))) {
            businessEntered.release();
            await hold(releaseBusiness.promise, context.signal);
          }
          yield {
            type: 'text_delta',
            text: 'Fixed fixture response: input and effect evidence only.',
          };
          yield finish;
        },
      },
      extensions: [
        {
          id: 'fixture',
          version: '1',
          apiMajor: 1,
          tools: [
            {
              id: 'fixture.read',
              version: '1',
              description: 'Read actual owned file once',
              inputSchema: { type: 'object', properties: {}, additionalProperties: false },
              execute: async () => {
                reads++;
                return {
                  outcome: 'succeeded',
                  content: readFileSync(join(directory, 'material'), 'utf8'),
                };
              },
            },
          ],
        },
      ],
    });
    try {
      writeFileSync(join(directory, 'material'), `Actual finite fact ${crypto.randomUUID()}`);
      await runtime.createWorkspace({
        expectedStoreId,
        id: 'w',
        name: 'owned',
        rootUri: pathToFileURL(directory).href,
      });
      await runtime.createSession({
        ...base,
        commandId: 'create',
        workspaceId: 'w',
        title: 'owned',
      });
      await runtime.submitCommand({
        ...base,
        commandId: 'work',
        request: {
          kind: 'run.start',
          content: 'Read once, then use Red. Do not repeat a completed read.',
        },
      });
      await summaryEntered.promise;
      const run = (await store.getView('s')).runs[0]!;
      const summary = (await store.listExecutions('s')).find(
        (execution) => (execution.decisionSource as { compressionId?: string }).compressionId,
      )!;
      expect(['dispatching', 'running']).toContain(summary.status);
      const audit = new Database(join(profile.dataRoot, profile.profile, 'core.db'), {
        readonly: true,
      });
      try {
        expect(audit.query('SELECT dispatched FROM execution WHERE id=?').get(summary.id)).toEqual({
          dispatched: 1,
        });
      } finally {
        audit.close();
      }
      expect(summaries).toHaveLength(1);
      expect(summaries[0]!.messages.some((message) => message.content === guide)).toBe(false);
      if (outcome !== 'published-correction') {
        await runtime.submitCommand({
          ...base,
          commandId: 'blue',
          request: {
            kind: 'input.steer',
            targetRunId: run.id,
            contextSelectionId: run.contextSelectionId,
            content: guide,
          },
        });
        expect((await store.getCommand('blue'))?.status).toBe('accepted');
      }
      if (outcome === 'cancelled')
        await runtime.cancelExecution({
          ...base,
          commandId: 'cancel-summary',
          executionId: summary.id,
        });
      if (outcome === 'run-cancel')
        await runtime.cancelRun({ ...base, commandId: 'cancel-run', runId: run.id });
      releaseSummary.release();
      if (outcome === 'run-cancel' || outcome === 'forged-cancel') {
        await until(async () => {
          if (requests.length > 1) expect(requests).toHaveLength(1);
          return !(await store.getRun(run.id))?.isActive ? true : undefined;
        });
        await runtime.waitForCommand('work', { timeoutMs: 8000 });
        expect(await store.getRun(run.id)).toMatchObject({
          isActive: false,
          status: outcome === 'run-cancel' ? 'cancelled' : 'failed',
        });
        expect(requests).toHaveLength(1);
        expect(reads).toBe(1);
        expect(summaries).toHaveLength(1);
        if (outcome === 'forged-cancel')
          expect(await store.getExecution(summary.id)).toMatchObject({
            status: 'failed',
            cancelRequestedAt: null,
          });
        expect(
          (await store.getModelContext({ expectedStoreId, sessionId: 's' })).compression,
        ).toBeUndefined();
        expect((await store.getView('s')).runs).toHaveLength(1);
        return;
      }
      await until(async () => {
        const stopped = await store.getRun(run.id);
        if (!stopped?.isActive) expect(stopped?.status).toBe('completed');
        return requests.length >= 2 ? true : undefined;
      });
      await businessEntered.promise;
      if (outcome === 'published-correction') {
        expect(
          (await store.getModelContext({ expectedStoreId, sessionId: 's' })).compression,
        ).toBeDefined();
        await runtime.submitCommand({
          ...base,
          commandId: 'blue',
          request: {
            kind: 'input.steer',
            targetRunId: run.id,
            contextSelectionId: run.contextSelectionId,
            content: guide,
          },
        });
      } else expect((await store.getCommand('blue'))?.status).toBe('applied');
      await runtime.submitCommand({
        ...base,
        commandId: 'green',
        request: {
          kind: 'input.steer',
          targetRunId: run.id,
          contextSelectionId: run.contextSelectionId,
          content: correction,
        },
      });
      releaseBusiness.release();
      await runtime.waitForCommand('work', { timeoutMs: 8000 });
      expect((await store.getRun(run.id))?.status).toBe('completed');
      expect((await store.getView('s')).runs).toHaveLength(1);
      const actual = requests.at(-1)!;
      const last = actual.messages.filter((message) => message.sourceIds?.includes('green'));
      expect(last).toHaveLength(1);
      expect(last[0]!.content).toBe(correction);
      {
        const blue = actual.messages.filter((message) => message.sourceIds?.includes('blue'));
        expect(blue).toEqual([{ role: 'user', content: guide, sourceIds: ['blue'] }]);
        expect(actual.messages.indexOf(blue[0]!)).toBeLessThan(actual.messages.indexOf(last[0]!));
        expect((await store.getCommand('blue'))?.receipt).toMatchObject({
          runId: run.id,
          outcome: 'input_applied',
        });
      }
      expect(reads).toBe(1);
      expect(summaries).toHaveLength(1);
      if (outcome === 'cancelled') {
        const cancelled = await store.getExecution(summary.id);
        expect(cancelled?.status).toBe('cancelled');
        expect(cancelled?.cancelRequestedAt).not.toBeNull();
      }
      expect(
        Boolean((await store.getModelContext({ expectedStoreId, sessionId: 's' })).compression),
      ).toBe(outcome === 'published-correction');
      expect(
        (await store.listExecutions('s')).filter(
          (execution) => execution.kind === 'tool' && execution.status === 'succeeded',
        ),
      ).toHaveLength(1);
    } finally {
      releaseSummary.release();
      releaseBusiness.release();
      await runtime.close();
      await store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  }, 15000);

test('a retained reference guide can reacquire omitted random facts through the existing authorized Files reader', async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'kite-reference-guide-')));
  const profile = { dataRoot: join(directory, 'data'), profile: 'test' };
  const store = await openSqliteStore(profile);
  const expectedStoreId = (await store.getMetadata()).storeId;
  const base = { expectedStoreId, sessionId: 's', subjectId: 'owner' };
  const fact = `REPORT-${crypto.randomUUID()}: palette-${crypto.randomUUID()}\n核验事实 雪🙂`;
  const guide =
    'Follow the exact palette and verification fact in report.txt. If the report leaves the window, read that same owned file again; at most two total reads. Do not guess facts or modify files.';
  writeFileSync(join(directory, 'report.txt'), fact);
  const files = createWorkspaceFiles({ root: directory });
  const readEntered = gate(),
    releaseRead = gate();
  const requests: ModelRequest[] = [];
  let reads = 0,
    summaries = 0;
  const read = createFileTools(files).find((tool) => tool.id === 'files.read')!;
  const runtime = createRuntime({
    store,
    artifacts: createArtifactStore({ profile, store }),
    modelId: 'fixed',
    permissions: { authorize: async () => ({ allowed: true, revision: 'existing-read-only' }) },
    compressor: {
      id: 'reference-boundary',
      version: '1',
      shouldCompress: async (input) =>
        summaries === 0 &&
        input.messages.some((message) => message.sourceIds?.includes('reference-guide')),
      prepare: async () => ({ instructions: 'OMIT_REPORT_DETAILS', snapshot: {} }),
      validateSummary: async () => true,
    },
    extensions: [
      {
        id: 'files',
        version: '1',
        apiMajor: 1,
        tools: [
          {
            ...read,
            async execute(input, context) {
              const result = await read.execute(input, context);
              reads++;
              if (reads === 1) {
                readEntered.release();
                await hold(releaseRead.promise, context.signal);
              }
              return result;
            },
          },
        ],
      },
    ],
    model: {
      async *stream(request) {
        if (request.messages.some((message) => message.content === 'OMIT_REPORT_DETAILS')) {
          summaries++;
          yield {
            type: 'text_delta',
            text: 'The report was read. Its palette and verification facts are intentionally omitted.',
          };
          yield finish;
          return;
        }
        requests.push(structuredClone(request));
        if (requests.length <= 2) {
          if (requests.length === 2) {
            expect(request.messages.filter((message) => message.content === guide)).toHaveLength(1);
            expect(request.messages.some((message) => message.content.includes(fact))).toBe(false);
            expect(
              request.messages.some((message) =>
                message.content.startsWith('Context summary (untrusted data;'),
              ),
            ).toBe(true);
          }
          yield {
            type: 'tool_call',
            id: `read-${requests.length}`,
            name: 'read_file',
            arguments: JSON.stringify({ path: 'report.txt' }),
          };
          yield { ...finish, reason: 'tool_calls' };
          return;
        }
        const actual = request.messages.filter(
          (message) => message.role === 'tool' && message.content.includes(fact),
        );
        expect(actual).toHaveLength(1);
        const presented = actual[0]!.content;
        expect(presented).toStartWith('Read "report.txt";');
        const marker = /\nContent \((\d+) UTF-8 bytes; starts on next line\):\n/.exec(presented);
        expect(marker).not.toBeNull();
        const complete = presented.slice(marker!.index + marker![0].length);
        expect(Buffer.byteLength(complete)).toBe(Number(marker![1]));
        expect(complete).toBe(fact);
        expect(request.messages.filter((message) => message.content === guide)).toHaveLength(1);
        yield {
          type: 'text_delta',
          text: 'Deterministic input evidence only; no claim of model semantic compliance.',
        };
        yield finish;
      },
    },
  });
  try {
    await runtime.createWorkspace({
      expectedStoreId,
      id: 'w',
      name: 'owned',
      rootUri: pathToFileURL(directory).href,
    });
    await runtime.createSession({
      ...base,
      commandId: 'create',
      workspaceId: 'w',
      title: 'report',
    });
    await runtime.submitCommand({
      ...base,
      commandId: 'work',
      request: {
        kind: 'run.start',
        content:
          'Read report.txt, then follow the later user guide. Only that file may be read, at most twice. No writes.',
      },
    });
    await readEntered.promise;
    const run = (await store.getView('s')).runs[0]!;
    await runtime.submitCommand({
      ...base,
      commandId: 'reference-guide',
      request: {
        kind: 'input.steer',
        targetRunId: run.id,
        contextSelectionId: run.contextSelectionId,
        content: guide,
      },
    });
    releaseRead.release();
    await runtime.waitForCommand('work', { timeoutMs: 8000 });
    expect((await store.getRun(run.id))?.status).toBe('completed');
    expect(reads).toBe(2);
    expect(summaries).toBe(1);
    expect(requests).toHaveLength(3);
    const tools = (await store.listExecutions('s')).filter(
      (execution) => execution.kind === 'tool',
    );
    expect(tools).toHaveLength(2);
    expect(
      tools.every(
        (execution) => execution.definitionId === 'files.read' && execution.status === 'succeeded',
      ),
    ).toBe(true);
    expect(readFileSync(join(directory, 'report.txt'), 'utf8')).toBe(fact);
    const saved = await runtime.readModelInput({ ...base, executionId: requests[2]!.requestId });
    expect(saved.request.messages).toEqual(requests[2]!.messages);
  } finally {
    releaseRead.release();
    await runtime.close();
    await files.close();
    await store.close();
    rmSync(directory, { recursive: true, force: true });
  }
}, 15000);
