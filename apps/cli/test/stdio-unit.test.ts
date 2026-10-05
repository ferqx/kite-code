import { expect, test } from 'bun:test';
import { Readable } from 'node:stream';
import type { AgentClient, Interaction } from '@kite-ai/client';
import { createStdioInteractionHandler, run } from '../src';

async function read(kind: Interaction['kind'], request: Interaction['request'], text: string) {
  const stdio = createStdioInteractionHandler({ input: Readable.from([text]), write() {} });
  try {
    return await stdio.answerInteraction({ kind, request } as Interaction, {
      signal: new AbortController().signal,
    });
  } finally {
    stdio.dispose();
  }
}

test('stdio plan review uses only explicitly offered mode and never promotes Full', async () => {
  const request = {
    planId: 'original',
    version: 'v1',
    digest: 'digest',
    content: 'original body',
    allowedModes: ['accept_edits'],
  };
  expect(await read('plan_review', request, 'approve accept_edits\n')).toEqual({
    kind: 'plan_review',
    decision: 'approve',
    mode: 'accept_edits',
  });
  expect(await read('plan_review', request, 'approve auto\n')).toBeUndefined();
  expect(await read('plan_review', request, 'approve full\n')).toBeUndefined();
  expect(await read('plan_review', request, 'approve\n')).toBeUndefined();
  expect(await read('plan_review', request, 'revise keep the original identity\n')).toEqual({
    kind: 'plan_review',
    decision: 'revise',
    feedback: 'keep the original identity',
  });
  expect(await read('plan_review', request, 'deny\n')).toEqual({
    kind: 'plan_review',
    decision: 'deny',
  });
});

test('stdio questions preserve internal choices; unsupported schemas, no newline and overflow do not answer', async () => {
  const request = {
    schema: {
      type: 'object',
      properties: { choice: { type: 'string', enum: ['id-original'] } },
      required: ['choice'],
      additionalProperties: false,
    },
  };
  expect(await read('question', request, '{"choice":"id-original"}\n')).toEqual({
    kind: 'question',
    answers: { choice: 'id-original' },
  });
  expect(await read('question', request, '{"choice":"display label"}\n')).toBeUndefined();
  expect(
    await read('question', request, '{"choice":"id-original","extra":true}\n'),
  ).toBeUndefined();
  expect(
    await read('question', { schema: { type: 'string', pattern: '^secret$' } }, '"secret"\n'),
  ).toBeUndefined();
  expect(await read('approval', {}, 'approve')).toBeUndefined();
  expect(await read('approval', {}, `${'x'.repeat(65537)}\napprove\n`)).toBeUndefined();
});

test('a child Job with null runId is matched by its original parent; another old child is excluded', async () => {
  const receipt = {
    id: 'work',
    kind: 'run.start',
    sessionId: 's',
    originStoreId: 'store',
    receipt: { runId: 'current-run' },
  };
  const card = (id: string, child: string) => ({
    id,
    originStoreId: 'store',
    sessionId: child,
    presentationSessionId: 's',
    ancestry: [child, 's'],
    runId: `${child}-run`,
    revision: '1',
    kind: 'approval',
    state: 'pending',
  });
  const client = {
    serverInfo: { capabilities: ['interactions'] },
    async startRun() {
      return receipt;
    },
    async getCommand() {
      return receipt;
    },
    async getRun() {
      return {
        id: 'current-run',
        sessionId: 's',
        originStoreId: 'store',
        originCommandId: 'work',
        isActive: true,
      };
    },
    async listInteractions() {
      return {
        interactions: [card('old-card', 'old-child'), card('original-card', 'current-child')],
        nextAfterId: null,
      };
    },
    async getView() {
      return {
        storeId: 'store',
        executions: [
          {
            originStoreId: 'store',
            sessionId: 's',
            id: 'old-carrier',
            childSessionId: 'old-child',
            runId: null,
            parentExecutionId: 'old-parent',
          },
          {
            originStoreId: 'store',
            sessionId: 's',
            id: 'old-parent',
            runId: 'old-run',
            parentExecutionId: null,
          },
          {
            originStoreId: 'store',
            sessionId: 's',
            id: 'carrier',
            childSessionId: 'current-child',
            runId: null,
            parentExecutionId: 'parent',
          },
          {
            originStoreId: 'store',
            sessionId: 's',
            id: 'parent',
            runId: 'current-run',
            parentExecutionId: null,
          },
        ],
      };
    },
  } as unknown as AgentClient;
  const result = await run(
    's',
    { kind: 'run.start', commandId: 'work', expectedStoreId: 'store', content: 'explicit intent' },
    { client, write() {} },
  );
  expect(result.status).toBe('waiting_interaction');
  expect(result.interactions?.map((value) => value.id)).toEqual(['original-card']);
});

for (const invalid of [undefined, 'store', 'session', 'id', 'cycle', 'missing'] as const)
  test(`nested same-Session approval proves the persisted original parent chain: ${invalid ?? 'valid'}`, async () => {
    const reads: string[] = [];
    let answers = 0;
    const receipt = {
      id: 'work',
      kind: 'run.start',
      sessionId: 's',
      originStoreId: 'store',
      status: 'applied',
      receipt: { runId: 'original-run' },
      cancelRequestedAt: null,
    };
    const card = (id: string, executionId: string) => ({
      id,
      executionId,
      runId: null,
      originStoreId: 'store',
      sessionId: 's',
      presentationSessionId: 's',
      ancestry: ['s'],
      revision: '1',
      kind: 'approval',
      state: 'pending',
    });
    const client = {
      serverInfo: { capabilities: ['interactions'] },
      async startRun() {
        return receipt;
      },
      async getCommand() {
        return receipt;
      },
      async getRun() {
        return {
          id: 'original-run',
          sessionId: 's',
          originStoreId: 'store',
          originCommandId: 'work',
          isActive: true,
        };
      },
      async listInteractions() {
        return {
          interactions: [card('old-card', 'old-job'), card('original-card', 'job')],
          nextAfterId: null,
        };
      },
      async getView() {
        throw Error('finite view must not be the parent proof');
      },
      async getExecution(id: string) {
        reads.push(id);
        if (id === 'old-job')
          return {
            id,
            originStoreId: 'store',
            sessionId: 's',
            runId: null,
            parentExecutionId: 'old-parent',
          };
        if (id === 'old-parent')
          return {
            id,
            originStoreId: 'store',
            sessionId: 's',
            runId: 'old-run',
            parentExecutionId: null,
          };
        if (invalid === 'missing') throw Error('missing original fact');
        if (id === 'job')
          return {
            id,
            originStoreId: 'store',
            sessionId: 's',
            runId: null,
            parentExecutionId: 'bridge',
          };
        if (id === 'bridge')
          return {
            id: invalid === 'id' ? 'other' : id,
            originStoreId: invalid === 'store' ? 'foreign' : 'store',
            sessionId: invalid === 'session' ? 'other' : 's',
            runId: null,
            parentExecutionId: invalid === 'cycle' ? 'job' : 'parent',
          };
        return {
          id,
          originStoreId: 'store',
          sessionId: 's',
          runId: 'original-run',
          parentExecutionId: null,
        };
      },
      async answerInteraction() {
        answers++;
        throw Error('wrong-scope answer');
      },
    } as unknown as AgentClient;
    const result = await run(
      's',
      { kind: 'run.start', commandId: 'work', expectedStoreId: 'store', content: 'original' },
      { client, write() {}, timeoutMs: 200 },
    );
    expect(result.status).toBe(invalid ? 'outcome_unknown' : 'waiting_interaction');
    expect(result.interactions?.map((value) => value.id)).toEqual(
      invalid ? undefined : ['original-card'],
    );
    expect(reads.slice(0, 2)).toEqual(['old-job', 'old-parent']);
    expect(answers).toBe(0);
  });
