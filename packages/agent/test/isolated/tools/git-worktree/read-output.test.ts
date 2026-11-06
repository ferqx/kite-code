import { expect, test } from 'bun:test';
import type {
  ExecutionOutputPage,
  OperationRef,
  PublicExecution,
  ToolContext,
} from '../../../../src/extensions';
import { readWorktreeOutput } from '../../../../src/tools/git-worktree/read-output';

const ref: OperationRef = {
  commandId: 'command',
  sessionId: 'session',
  originStoreId: 'store',
  extensionId: 'builtin.shell',
  key: 'key',
  executionId: 'job',
};
const execution: PublicExecution = {
  id: 'job',
  sessionId: 'session',
  runId: 'run',
  kind: 'job',
  status: 'succeeded',
  result: { outcome: 'succeeded', content: '' },
  resultRevision: '1',
  originStoreId: 'store',
  definitionId: 'shell.command',
  definitionVersion: '1',
};
const request = { operationToken: 'a'.repeat(64), phase: 'list' as const };
const body = JSON.stringify({
  protocolVersion: 1,
  ...request,
  businessOutcome: 'succeeded',
  details: {
    action: 'list',
    observedAt: '2026-11-06T00:00:00.000Z',
    cwdChanged: false,
    mutation: 'not_started',
    repository: { root: '/repo', commonDir: '/repo/.git' },
    sourceWorktree: '/repo',
    worktrees: [],
  },
});
function page(content = body): ExecutionOutputPage {
  return {
    highWaterSeq: '1',
    items: [
      {
        executionId: 'job',
        seq: '1',
        throughSeq: '1',
        stream: 'stdout',
        content,
        droppedBytes: '0',
      },
    ],
  };
}
function context(pages: ExecutionOutputPage[], current = execution) {
  let cursor = 0;
  return {
    sessionId: 'session',
    operations: {
      get: async () => current,
      readOutput: async () => pages[cursor++] ?? { highWaterSeq: '1', items: [] },
    },
  } as unknown as ToolContext;
}
test('reads complete output through fixed upper cursor instead of a foreground preview', async () => {
  const seen: unknown[] = [];
  const ctx = context([]);
  ctx.operations.readOutput = async (_ref, options) => {
    seen.push(options);
    return seen.length === 1
      ? { highWaterSeq: '2', items: [{ ...page().items[0]!, content: body.slice(0, 40) }] }
      : {
          highWaterSeq: '2',
          items: [{ ...page().items[0]!, seq: '2', throughSeq: '2', content: body.slice(40) }],
        };
  };
  const result = await readWorktreeOutput(ref, ctx, request);
  expect(result.frame?.businessOutcome).toBe('succeeded');
  expect(seen).toEqual([
    { afterSeq: '0', limit: 200 },
    { afterSeq: '1', upperSeq: '2', limit: 200 },
  ]);
});
test('droppedBytes null/nonzero, gaps, duplicates, cursor stalls, bad UTF8 and token never succeed', async () => {
  const bad = [
    { ...page(), items: [{ ...page().items[0]!, droppedBytes: null }] },
    { ...page(), items: [{ ...page().items[0]!, droppedBytes: '1' }] },
    { ...page(), items: [{ ...page().items[0]!, seq: '2', throughSeq: '2' }] },
    { ...page(), highWaterSeq: '2', items: [page().items[0]!, page().items[0]!] },
    { ...page(), highWaterSeq: '2', items: [] },
    { ...page(), items: [{ ...page().items[0]!, content: '\ud800' }] },
    page(body + body),
    page(body.replace(request.operationToken, 'b'.repeat(64))),
    page(body.replace('"phase":"list"', '"phase":"remove"')),
  ];
  for (const value of bad)
    await expect(readWorktreeOutput(ref, context([value]), request)).rejects.toThrow();
});
test('original Job identity/version/Store and terminal status are required', async () => {
  for (const current of [
    { ...execution, originStoreId: 'other' },
    { ...execution, definitionVersion: '2' },
    { ...execution, status: 'running' as const },
    { ...execution, kind: 'tool' as const },
  ])
    await expect(readWorktreeOutput(ref, context([page()], current), request)).rejects.toThrow();
});
test('terminal page high water cannot grow between reads', async () => {
  const first = { highWaterSeq: '2', items: [{ ...page().items[0]!, content: body.slice(0, 40) }] };
  const second = {
    highWaterSeq: '3',
    items: [{ ...page().items[0]!, seq: '2', throughSeq: '2', content: body.slice(40) }],
  };
  await expect(readWorktreeOutput(ref, context([first, second]), request)).rejects.toThrow(
    'worktree_output_incomplete',
  );
});
