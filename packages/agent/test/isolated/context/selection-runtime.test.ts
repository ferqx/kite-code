import { expect, test } from 'bun:test';
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFixedModel, type ModelEvent } from '@kite-ai/ai';
import { createRuntime } from '../../../src';
import { createArtifactStore } from '../../../src/artifacts';
import type { Extension } from '../../../src/extensions';
import { openSqliteStore } from '../../../src/sqlite';
import type { MessageRecord, ResultContextSource } from '../../../src/storage/types';

const finish: ModelEvent = {
  type: 'finish',
  reason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1 },
};

test('actual Model exhausts both selected-context cursors and rewind preserves only selected consumed result sources without replay', async () => {
  const root = mkdtempSync(join(tmpdir(), 'kite-selection-runtime-'));
  const ledger = join(root, 'external-ledger');
  const profile = { dataRoot: join(root, 'data'), profile: 'new' };
  const store = await openSqliteStore(profile);
  const artifacts = createArtifactStore({ profile, store });
  const expectedStoreId = (await store.getMetadata()).storeId;
  const model = createFixedModel([
    [
      ...Array.from(
        { length: 201 },
        (_, index): ModelEvent => ({
          type: 'tool_call',
          id: `call-${index}`,
          name: 'fixture.launch',
          arguments: JSON.stringify({ index }),
        }),
      ),
      { ...finish, reason: 'tool_calls' },
    ],
    [{ type: 'text_delta', text: 'all results read' }, finish],
    [{ type: 'text_delta', text: 'retained results read' }, finish],
    [{ type: 'text_delta', text: 'rewound results excluded' }, finish],
  ]);
  const extension: Extension = {
    id: 'fixture',
    version: '1',
    apiMajor: 1,
    tools: [
      {
        id: 'fixture.launch',
        version: '1',
        description: 'A finite set of harmless results and paired tool messages',
        inputSchema: {
          type: 'object',
          properties: { index: { type: 'integer', minimum: 0, maximum: 200 } },
          required: ['index'],
          additionalProperties: false,
        },
        async execute(input, context) {
          const index = (input as { index: number }).index;
          if (index < 101) {
            const ref = await context.operations.ensure({
              key: `result-${index}`,
              cancellation: 'detached',
              request: {
                kind: 'job',
                definitionId: 'fixture.result',
                definitionVersion: '1',
                input: { index },
              },
            });
            await context.operations.wait(ref, { signal: context.signal, timeoutMs: 4000 });
          }
          return { outcome: 'succeeded', content: `tool-${index}` };
        },
      },
    ],
    jobs: [
      {
        id: 'fixture.result',
        version: '1',
        description: 'An immutable, counted background result',
        inputSchema: {
          type: 'object',
          properties: { index: { type: 'integer', minimum: 0, maximum: 100 } },
          required: ['index'],
          additionalProperties: false,
        },
        async start(input) {
          appendFileSync(ledger, `${(input as { index: number }).index}\n`);
          return { reference: input };
        },
        async *observe(handle) {
          yield {
            type: 'terminal',
            supervision: 'ended',
            result: {
              outcome: 'succeeded',
              content: `result-${(handle.reference as { index: number }).index}`,
            },
          };
        },
        async cancel() {
          return { status: 'already_finished' };
        },
        async dispose() {},
      },
    ],
  };
  const runtime = createRuntime({
    store,
    artifacts,
    model,
    modelId: 'fixed',
    modelConcurrency: 1,
    extensions: [extension],
    permissions: {
      async authorize() {
        return { allowed: true, revision: 'policy-1' };
      },
    },
  });
  const submit = async (commandId: string) => {
    await runtime.submitCommand({
      expectedStoreId,
      commandId,
      sessionId: 's',
      subjectId: 'owner',
      request: { kind: 'run.start', content: commandId },
    });
    const command = await runtime.waitForCommand(commandId, { timeoutMs: 12000 });
    expect((await store.getRun((command.receipt as { runId: string }).runId))?.status).toBe(
      'completed',
    );
  };
  const selected = async () => {
    const messages: MessageRecord[] = [];
    const sources: ResultContextSource[] = [];
    let afterSeq = '0',
      afterSourceId = '';
    let selectionId: string | undefined, upperSeq: string | undefined;
    while (true) {
      const page = await runtime.getSelectedContext({
        expectedStoreId,
        sessionId: 's',
        ...(selectionId === undefined ? {} : { contextSelectionId: selectionId }),
        ...(upperSeq === undefined ? {} : { upperSeq }),
        afterSeq,
        afterSourceId,
        messageLimit: 200,
        sourceLimit: 100,
      });
      selectionId ??= page.selection.id;
      upperSeq ??= page.highWaterSeq;
      messages.push(...page.messages);
      sources.push(...page.resultSources);
      if (page.nextAfterSeq === null && page.nextAfterSourceId === null)
        return { messages, sources, selectionId };
      afterSeq = page.nextAfterSeq ?? upperSeq;
      afterSourceId = page.nextAfterSourceId ?? page.resultSources.at(-1)?.id ?? afterSourceId;
    }
  };
  try {
    await runtime.createWorkspace({
      expectedStoreId,
      id: 'w',
      rootUri: `file://${root}`,
      name: 'temporary',
    });
    await runtime.createSession({
      expectedStoreId,
      commandId: 'create',
      sessionId: 's',
      workspaceId: 'w',
      subjectId: 'owner',
      title: 'finite pagination',
    });
    await submit('first-work');
    expect(model.requests).toHaveLength(2);
    const first = await selected();
    expect(first.messages).toHaveLength(204);
    expect(first.sources).toHaveLength(101);
    const sourceIds = first.sources.map((value) => value.id).sort();
    const request = model.requests[1]!;
    expect(request.messages.filter((value) => value.role === 'tool')).toHaveLength(201);
    expect(
      request.messages.filter((value) => value.content.startsWith('Background execution')),
    ).toHaveLength(101);
    expect(
      request.messages
        .flatMap((value) => value.sourceIds ?? [])
        .filter((id) => sourceIds.includes(id))
        .sort(),
    ).toEqual(sourceIds);
    expect(new Set(request.messages.flatMap((value) => value.sourceIds ?? [])).size).toBe(304);
    const persistedModel = await store.getExecution(request.requestId);
    const body = (
      persistedModel!.input as unknown as {
        body: { reference: import('../../../src/storage/types').ArtifactReference };
      }
    ).body.reference;
    expect(body.scope).toEqual({ kind: 'session', id: 's' });
    expect(persistedModel?.result).toMatchObject({ modelInputBodyHash: body.hash });
    expect(
      JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(
          await artifacts.read({
            expectedStoreId,
            sessionId: 's',
            subjectId: 'owner',
            refId: body.id,
            scope: body.scope,
          }),
        ),
      ),
    ).toEqual(JSON.parse(JSON.stringify(request)));
    const count = () => readFileSync(ledger, 'utf8').trim().split('\n').length;
    expect(count()).toBe(101);
    const retainedBoundary = first.messages.find((value) => value.content === 'all results read')!;
    const retained = await runtime.selectContext({
      expectedStoreId,
      commandId: 'retain',
      sessionId: 's',
      subjectId: 'owner',
      expectedContextSelectionId: first.selectionId,
      boundary: { messageId: retainedBoundary.id, seq: retainedBoundary.seq },
    });
    expect((await selected()).sources.map((value) => value.id).sort()).toEqual(sourceIds);
    await submit('retained-work');
    expect(model.requests).toHaveLength(3);
    expect(
      model.requests[2]!.messages.flatMap((value) => value.sourceIds ?? [])
        .filter((id) => sourceIds.includes(id))
        .sort(),
    ).toEqual(sourceIds);
    expect(count()).toBe(101);
    const earlier = first.messages.find((value) => value.content === 'first-work')!;
    await runtime.selectContext({
      expectedStoreId,
      commandId: 'exclude',
      sessionId: 's',
      subjectId: 'owner',
      expectedContextSelectionId: retained.selection.id,
      boundary: { messageId: earlier.id, seq: earlier.seq },
    });
    expect((await selected()).sources).toHaveLength(0);
    expect((await store.getExecution(first.sources[0]!.executionId))?.delivery).toBe('consumed');
    await submit('new-work');
    expect(model.requests).toHaveLength(4);
    expect(model.requests[3]!.messages.map((value) => value.content)).toEqual([
      'first-work',
      'new-work',
    ]);
    expect(model.requests[3]!.messages.flatMap((value) => value.sourceIds ?? [])).toEqual([
      'first-work',
      'new-work',
    ]);
    expect((await store.getExecution(first.sources[0]!.executionId))?.delivery).toBe('consumed');
    expect(count()).toBe(101);
    expect(await store.getExecution(request.requestId)).toMatchObject({
      input: persistedModel!.input,
      result: { modelInputBodyHash: body.hash },
      status: 'succeeded',
    });
    expect((await store.listMessages('s', { afterSeq: '0', limit: 200 })).length).toBe(200);
    const second = await store.listMessages('s', {
      afterSeq: first.messages[199]!.seq,
      limit: 200,
    });
    expect(second.some((value) => value.id === retainedBoundary.id)).toBe(true);
  } finally {
    await runtime.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 20000);
