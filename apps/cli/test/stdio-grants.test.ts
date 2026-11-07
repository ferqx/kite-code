import { expect, test } from 'bun:test';
import { Readable } from 'node:stream';
import type { Interaction } from '@kite-ai/client';
import { createStdioInteractionHandler } from '../src';

async function read(
  request: Interaction['request'],
  text: string,
  kind: Interaction['kind'] = 'approval',
) {
  const lines: string[] = [];
  const stdio = createStdioInteractionHandler({
    input: Readable.from([text]),
    write(line) {
      lines.push(line);
    },
  });
  const original = {
    id: 'original',
    originStoreId: 'store',
    sessionId: 'child',
    presentationSessionId: 'root',
    executionId: 'exec',
    runId: 'run',
    attempt: 1,
    revision: '9',
    kind,
    request,
  } as Interaction;
  try {
    return {
      answer: await stdio.answerInteraction(original, { signal: new AbortController().signal }),
      lines,
      original,
    };
  } finally {
    stdio.dispose();
  }
}
test('stdio default once and explicit offered same-command retain original prompt scope; deny never grants', async () => {
  const request = {
    options: [
      { optionId: 'once', kind: 'once', presentation: { label: '仅此次', details: [] } },
      {
        optionId: 'scope-example',
        kind: 'scope',
        presentation: {
          label: '本 Session 相同命令',
          details: ['仅限此会话的完整相同命令、环境与执行范围'],
        },
      },
    ],
    input: { command: 'exact' },
  };
  const once = await read(request, 'approve\n');
  expect(once.answer).toEqual({ kind: 'approval', decision: 'approve', optionId: 'once' });
  const same = await read(request, 'approve scope-example\n');
  expect(same.answer).toEqual({ kind: 'approval', decision: 'approve', optionId: 'scope-example' });
  expect(same.lines.join('')).toContain('本 Session 相同命令');
  expect(JSON.parse(same.lines[0]!)).toMatchObject({
    interactionId: 'original',
    originStoreId: 'store',
    sessionId: 'child',
    presentationSessionId: 'root',
    executionId: 'exec',
    revision: '9',
  });
  expect((await read(request, 'deny\n')).answer).toEqual({ kind: 'approval', decision: 'deny' });
});
test('stdio cannot invent an unoffered grant or turn plan review, question, invalid input or EOF into same-command approval', async () => {
  const unoffered: Interaction['request'][] = [
    {},
    {
      options: [{ optionId: 'once', kind: 'once', presentation: { label: '仅此次', details: [] } }],
    },
    { options: 'scope-example' },
  ];
  for (const request of unoffered) {
    const value = await read(request, 'approve scope-example\n');
    expect(value.answer).toBeUndefined();
    expect(value.lines.join('')).not.toContain('本 Session 相同命令');
  }
  expect(
    (
      await read(
        {
          options: [
            {
              optionId: 'scope-example',
              kind: 'scope',
              presentation: {
                label: '本 Session 相同命令',
                details: ['仅限此会话的完整相同命令、环境与执行范围'],
              },
            },
          ],
        },
        'deny same_command\n',
      )
    ).answer,
  ).toBeUndefined();
  expect(
    (
      await read(
        {
          options: [
            {
              optionId: 'scope-example',
              kind: 'scope',
              presentation: {
                label: '本 Session 相同命令',
                details: ['仅限此会话的完整相同命令、环境与执行范围'],
              },
            },
          ],
        },
        'approve scope-example\n',
        'plan_review',
      )
    ).answer,
  ).toBeUndefined();
  expect(
    (
      await read(
        {
          options: [
            {
              optionId: 'scope-example',
              kind: 'scope',
              presentation: {
                label: '本 Session 相同命令',
                details: ['仅限此会话的完整相同命令、环境与执行范围'],
              },
            },
          ],
        },
        'approve scope-example\n',
        'question',
      )
    ).answer,
  ).toBeUndefined();
  expect(
    (
      await read(
        {
          options: [
            {
              optionId: 'scope-example',
              kind: 'scope',
              presentation: {
                label: '本 Session 相同命令',
                details: ['仅限此会话的完整相同命令、环境与执行范围'],
              },
            },
          ],
        },
        '',
      )
    ).answer,
  ).toBeUndefined();
});
