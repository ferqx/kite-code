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
  const request = { grants: ['approve_once', 'same_command'], input: { command: 'exact' } };
  const once = await read(request, 'approve\n');
  expect(once.answer).toEqual({ kind: 'approval', decision: 'approve', grant: 'approve_once' });
  const same = await read(request, 'approve same_command\n');
  expect(same.answer).toEqual({ kind: 'approval', decision: 'approve', grant: 'same_command' });
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
    { grants: ['approve_once'] },
    { grants: 'same_command' },
  ];
  for (const request of unoffered) {
    const value = await read(request, 'approve same_command\n');
    expect(value.answer).toBeUndefined();
    expect(value.lines.join('')).not.toContain('本 Session 相同命令');
  }
  expect((await read({ grants: ['same_command'] }, 'deny same_command\n')).answer).toBeUndefined();
  expect(
    (await read({ grants: ['same_command'] }, 'approve same_command\n', 'plan_review')).answer,
  ).toBeUndefined();
  expect(
    (await read({ grants: ['same_command'] }, 'approve same_command\n', 'question')).answer,
  ).toBeUndefined();
  expect((await read({ grants: ['same_command'] }, '')).answer).toBeUndefined();
});
