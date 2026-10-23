import { expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ModelAdapter, ModelEvent, ModelMessage, ModelRequest } from '@kite-ai/ai';
import { createArtifactStore } from '../../../src/artifacts';
import type { CompressionInput, ContextCompressor } from '../../../src/context';
import { createRuntime } from '../../../src/runtime';
import { openSqliteStore } from '../../../src/sqlite';

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
  const deadline = Date.now() + 6000;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() >= deadline) throw Error('compression_steering_fixture_timeout');
    await Bun.sleep(5);
  }
}

for (const mode of ['omitted', 'stale_red'] as const)
  test(`two actual compressions retain independent original steers even when the summary is ${mode}`, async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-compression-steering-')));
    const profile = { dataRoot: join(root, 'data'), profile: 'test' };
    const store = await openSqliteStore(profile);
    const storeId = (await store.getMetadata()).storeId;
    const base = { expectedStoreId: storeId, sessionId: 's', subjectId: 'owner' };
    const firstTool = gate(),
      releaseFirstTool = gate(),
      thirdModel = gate(),
      releaseThirdModel = gate();
    const normal: ModelRequest[] = [],
      summaryRequests: ModelRequest[] = [];
    const prepareInputs: CompressionInput[] = [];
    const originals = [
      ['work', 'Original task: inspect the owned material; preserve this exact task 雪🙂.'],
      [
        'guide-one',
        'Independent first guide: use Red for the tentative report.\nExact first tail.',
      ],
      [
        'guide-two',
        'Independent second guide: preserve the Unicode appendix 雪🙂 and every final reference.',
      ],
      [
        'guide-correction',
        'Correction: use Blue instead of Red. This later original user instruction supersedes the tentative Red requirement.\nExact correction tail.',
      ],
    ] as const;
    const newTail = [
      'guide-new-tail',
      'New tail after both compressions: keep Blue and the final footer 尾🙂.',
    ] as const;
    const summaries = [1, 2].map((number) =>
      mode === 'omitted'
        ? `Summary ${number}: only implementation history; original user requirements intentionally omitted.`
        : `Summary ${number}: obsolete requirement says Red; the report should still use Red.`,
    );
    let toolCount = 0;
    const hasSource = (messages: readonly ModelMessage[], id: string) =>
      messages.some((message) => message.sourceIds?.includes(id));
    const compressor: ContextCompressor = {
      id: 'fixture.retained-inputs',
      version: '1',
      async shouldCompress(input) {
        return (
          originals.every(([id]) => hasSource(input.messages, id)) &&
          (prepareInputs.length === 0 || (prepareInputs.length === 1 && toolCount === 2))
        );
      },
      async prepare(input) {
        prepareInputs.push(input);
        // This is an actual compressor input contract, not a second copy to append.
        const retained = input.retainedMessages;
        expect(retained).toBeDefined();
        for (const [id, content] of originals) {
          expect(retained!.filter((message) => message.sourceIds?.includes(id))).toHaveLength(1);
          expect(retained!.find((message) => message.sourceIds?.includes(id))!.content).toBe(
            content,
          );
          expect(input.messages.filter((message) => message.sourceIds?.includes(id))).toHaveLength(
            1,
          );
        }
        return {
          instructions: 'OWNED_COMPRESS_STEERING',
          snapshot: { mode, attempt: prepareInputs.length },
        };
      },
      async validateSummary(input) {
        return summaries.includes(input.summary);
      },
    };
    const model: ModelAdapter = {
      async *stream(request, context) {
        if (request.messages.some((message) => message.content === 'OWNED_COMPRESS_STEERING')) {
          summaryRequests.push(structuredClone(request));
          yield { type: 'text_delta', text: summaries[summaryRequests.length - 1]! };
          yield finish;
          return;
        }
        normal.push(structuredClone(request));
        const index = normal.length;
        if (index <= 2) {
          yield {
            type: 'text_delta',
            text: `${index === 1 ? 'OBSOLETE ASSISTANT HISTORY' : 'INTERMEDIATE ASSISTANT HISTORY'} `.repeat(
              300,
            ),
          };
          yield {
            type: 'tool_call',
            id: `actual-query-${index}`,
            name: 'fixture.query',
            arguments: '{}',
          };
          yield { ...finish, reason: 'tool_calls' };
          return;
        }
        if (index === 3) {
          thirdModel.release();
          await Promise.race([
            releaseThirdModel.promise,
            new Promise<never>((_, reject) =>
              context.signal.addEventListener('abort', () => reject(context.signal.reason), {
                once: true,
              }),
            ),
          ]);
        }
        yield {
          type: 'text_delta',
          text: 'Fixed response; this fixture verifies the prepared input, not semantic compliance.',
        };
        yield finish;
      },
    };
    const runtime = createRuntime({
      store,
      artifacts: createArtifactStore({ profile, store }),
      model,
      modelId: 'fixed',
      compressor,
      extensions: [
        {
          id: 'fixture',
          version: '1',
          apiMajor: 1,
          tools: [
            {
              id: 'fixture.query',
              version: '1',
              description: 'Actual finite read-only query',
              inputSchema: { type: 'object', properties: {}, additionalProperties: false },
              async execute(_input, context) {
                toolCount++;
                const actual = (await store.getSession('s'))!.title;
                if (toolCount === 1) {
                  firstTool.release();
                  await Promise.race([
                    releaseFirstTool.promise,
                    new Promise<never>((_, reject) =>
                      context.signal.addEventListener(
                        'abort',
                        () => reject(context.signal.reason),
                        { once: true },
                      ),
                    ),
                  ]);
                }
                return {
                  outcome: 'succeeded',
                  content: `OLD TOOL HISTORY ${toolCount}: ${actual}\n`.repeat(300),
                };
              },
            },
          ],
        },
      ],
      permissions: { authorize: async () => ({ allowed: true, revision: 'owned' }) },
    });
    const submitSteer = async (runId: string, id: string, content: string) =>
      runtime.submitCommand({
        ...base,
        commandId: id,
        request: {
          kind: 'input.steer',
          targetRunId: runId,
          contextSelectionId: (await store.getSession('s'))!.contextSelectionId,
          content,
        },
      });
    try {
      await runtime.createWorkspace({
        expectedStoreId: storeId,
        id: 'w',
        name: 'owned',
        rootUri: pathToFileURL(root).href,
      });
      await runtime.createSession({
        ...base,
        commandId: 'create',
        workspaceId: 'w',
        title: 'owned reader',
      });
      await runtime.submitCommand({
        ...base,
        commandId: originals[0][0],
        request: { kind: 'run.start', content: originals[0][1] },
      });
      await until(async () => (toolCount === 1 ? true : undefined));
      const originalRun = (await store.getView('s')).runs[0]!;
      expect(originalRun.isActive).toBe(true);
      for (const [id, content] of originals.slice(1))
        await submitSteer(originalRun.id, id, content);
      releaseFirstTool.release();
      await until(async () => (normal.length === 3 ? true : undefined));
      await thirdModel.promise;
      expect(summaryRequests).toHaveLength(2);
      expect(prepareInputs).toHaveLength(2);
      await submitSteer(originalRun.id, newTail[0], newTail[1]);
      releaseThirdModel.release();
      await runtime.waitForCommand('work', { timeoutMs: 10000 });
      expect(normal).toHaveLength(4);
      expect(toolCount).toBe(2);
      for (const request of normal.slice(1)) {
        const summary = request.messages.findIndex((message) =>
          message.sourceIds?.some((id) => id.startsWith('compression-')),
        );
        expect(summary).toBeGreaterThanOrEqual(0);
        expect(request.messages[summary]!.content).toContain(
          summaries[request === normal[1] ? 0 : 1]!,
        );
        const positions: number[] = [];
        for (const [id, content] of originals) {
          const matches = request.messages.filter((message) => message.sourceIds?.includes(id));
          expect(matches).toHaveLength(1);
          expect(matches[0]).toMatchObject({ role: 'user', content, sourceIds: [id] });
          positions.push(request.messages.indexOf(matches[0]!));
        }
        expect(positions).toEqual([...positions].sort((a, b) => a - b));
        expect(positions[0]!).toBeGreaterThan(summary);
        expect(
          request.messages.some((message) =>
            message.content.includes('OBSOLETE ASSISTANT HISTORY'),
          ),
        ).toBe(false);
        expect(
          request.messages.some((message) => message.content.includes('OLD TOOL HISTORY 1:')),
        ).toBe(false);
      }
      const last = normal.at(-1)!;
      const tail = last.messages.filter((message) => message.sourceIds?.includes(newTail[0]));
      expect(tail).toHaveLength(1);
      expect(tail[0]).toMatchObject({ role: 'user', content: newTail[1], sourceIds: [newTail[0]] });
      expect(last.messages.indexOf(tail[0]!)).toBeGreaterThan(
        last.messages.findIndex((message) => message.sourceIds?.includes('guide-correction')),
      );
      const view = await store.getView('s');
      expect(view.runs).toHaveLength(1);
      expect(view.runs[0]).toMatchObject({ id: originalRun.id, status: 'completed' });
      for (const [id, content] of [...originals, newTail]) {
        const physical = view.messages.filter((message) => message.sourceIds?.includes(id));
        expect(physical).toHaveLength(1);
        expect(physical[0]!.content).toBe(content);
        expect((await store.getCommand(id))!.status).toBe('applied');
      }
    } finally {
      releaseFirstTool.release();
      releaseThirdModel.release();
      await runtime.close();
      await store.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 15000);

test('compression retains cancelled original task and applied steer as historical context before a new explicit tail', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-compression-cancelled-input-')));
  const profile = { dataRoot: join(root, 'data'), profile: 'test' };
  const store = await openSqliteStore(profile);
  const expectedStoreId = (await store.getMetadata()).storeId;
  const base = { expectedStoreId, sessionId: 's', subjectId: 'owner' };
  const toolEntered = gate(),
    releaseTool = gate(),
    secondEntered = gate();
  const requests: ModelRequest[] = [];
  const originalBody = 'Old original request: use Red for the report 雪🙂.';
  const steerBody = 'Actually applied old guidance: keep the original appendix.';
  const currentBody = 'New independent request: use Blue; do not restart the cancelled old work.';
  const runtime = createRuntime({
    store,
    artifacts: createArtifactStore({ profile, store }),
    modelId: 'fixed',
    compressor: {
      id: 'owned.cancelled-history',
      version: '1',
      async prepare() {
        return { instructions: 'OWNED_CANCELLED_SUMMARY', snapshot: {} };
      },
    },
    model: {
      async *stream(request, { signal }) {
        if (request.messages.some((message) => message.content === 'OWNED_CANCELLED_SUMMARY')) {
          yield {
            type: 'text_delta',
            text: 'Stale summary: Red is the old unfinished report requirement.',
          };
          yield finish;
          return;
        }
        requests.push(structuredClone(request));
        if (requests.length === 1) {
          yield { type: 'text_delta', text: 'CANCELLED OLD ASSISTANT HISTORY '.repeat(300) };
          yield {
            type: 'tool_call',
            id: 'read-before-cancel',
            name: 'fixture.query',
            arguments: '{}',
          };
          yield { ...finish, reason: 'tool_calls' };
          return;
        }
        if (requests.length === 2) {
          secondEntered.release();
          await new Promise<never>((_, reject) => {
            if (signal.aborted) reject(signal.reason);
            else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
          });
        }
        yield {
          type: 'text_delta',
          text: 'Fixed completion; this test only verifies the prepared input.',
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
            id: 'fixture.query',
            version: '1',
            description: 'Actual harmless query',
            inputSchema: { type: 'object' },
            async execute() {
              toolEntered.release();
              await releaseTool.promise;
              return { outcome: 'succeeded', content: 'CANCELLED OLD TOOL HISTORY '.repeat(300) };
            },
          },
        ],
      },
    ],
    permissions: { authorize: async () => ({ allowed: true, revision: 'owned' }) },
  });
  try {
    await runtime.createWorkspace({
      expectedStoreId,
      id: 'w',
      name: 'owned',
      rootUri: pathToFileURL(root).href,
    });
    await runtime.createSession({
      ...base,
      commandId: 'create',
      workspaceId: 'w',
      title: 'cancelled history',
    });
    await runtime.submitCommand({
      ...base,
      commandId: 'old-work',
      request: { kind: 'run.start', content: originalBody },
    });
    await until(async () =>
      requests.length === 1 &&
      (await store.listExecutions('s')).some(
        (entry) => entry.definitionId === 'fixture.query' && entry.status === 'dispatching',
      )
        ? true
        : undefined,
    );
    await toolEntered.promise;
    const originalRun = (await store.getView('s')).runs[0]!;
    const selection = (await store.getSession('s'))!.contextSelectionId;
    await runtime.submitCommand({
      ...base,
      commandId: 'old-steer',
      request: {
        kind: 'input.steer',
        targetRunId: originalRun.id,
        contextSelectionId: selection,
        content: steerBody,
      },
    });
    releaseTool.release();
    await until(async () => (requests.length === 2 ? true : undefined));
    await secondEntered.promise;
    expect((await store.getCommand('old-steer'))!.status).toBe('applied');
    await runtime.cancelCommand({ ...base, commandId: 'cancel-old', targetCommandId: 'old-work' });
    await runtime.waitForCommand('old-work', { timeoutMs: 6000 });
    expect(await store.getRun(originalRun.id)).toMatchObject({
      status: 'cancelled',
      isActive: false,
    });
    await runtime.compressContext({
      ...base,
      commandId: 'compact-cancelled',
      expectedContextSelectionId: selection,
    });
    await runtime.waitForCommand('compact-cancelled', { timeoutMs: 6000 });
    expect(
      (await store.getSelectedContext({ expectedStoreId, sessionId: 's' })).compression,
    ).toBeDefined();
    await runtime.submitCommand({
      ...base,
      commandId: 'new-work',
      request: { kind: 'run.start', content: currentBody },
    });
    await runtime.waitForCommand('new-work', { timeoutMs: 6000 });
    expect(requests).toHaveLength(3);
    const actual = requests[2]!;
    const summaryPosition = actual.messages.findIndex((message) =>
      message.sourceIds?.some((id) => id.startsWith('compression-')),
    );
    const positions: number[] = [];
    for (const [id, content, kind] of [
      ['old-work', originalBody, 'run.start'],
      ['old-steer', steerBody, 'input.steer'],
    ] as const) {
      const retained = actual.messages.filter((message) => message.sourceIds?.includes(id));
      expect(retained).toHaveLength(1);
      expect(retained[0]!.role).toBe('user');
      expect(retained[0]!.sourceIds).toEqual([id]);
      expect(retained[0]!.content).toContain('Historical user input');
      expect(retained[0]!.content).toContain('not a pending task or authorization');
      const historical = JSON.parse(retained[0]!.content.split('\n')[1]!);
      expect(historical).toMatchObject({
        kind: 'historical_user_input',
        content,
        origin: { runId: originalRun.id, inputCommandId: id, inputKind: kind },
        run: { status: 'cancelled', isActive: false },
      });
      positions.push(actual.messages.indexOf(retained[0]!));
    }
    expect(summaryPosition).toBeGreaterThanOrEqual(0);
    expect(positions[0]!).toBeGreaterThan(summaryPosition);
    expect(positions[1]!).toBeGreaterThan(positions[0]!);
    const current = actual.messages.filter((message) => message.sourceIds?.includes('new-work'));
    expect(current).toHaveLength(1);
    expect(current[0]!.content).toBe(currentBody);
    expect(actual.messages.indexOf(current[0]!)).toBeGreaterThan(positions[1]!);
    expect(
      actual.messages.some((message) =>
        message.content.includes('CANCELLED OLD ASSISTANT HISTORY'),
      ),
    ).toBe(false);
    expect(
      actual.messages.some((message) => message.content.includes('CANCELLED OLD TOOL HISTORY')),
    ).toBe(false);
    expect(await store.getRun(originalRun.id)).toMatchObject({
      status: 'cancelled',
      isActive: false,
    });
  } finally {
    releaseTool.release();
    await runtime.close();
    await store.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 15000);
