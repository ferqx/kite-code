// Legacy compatibility coverage, not a supported current model tool.
import { expect, test } from 'bun:test';
import type { ToolContext } from '../../../src/extensions';
import { AgentError } from '../../../src/storage/types';
import { createExecutionEvidenceExtension } from '../../fixtures/legacy-execution-evidence';

const context = {
  sessionId: 'owner',
  runId: 'current',
  executionId: 'reader',
  signal: new AbortController().signal,
} as ToolContext;

test('evidence argument and unavailable-scope failures explain public recovery without starting work', async () => {
  let reads = 0;
  const tool = createExecutionEvidenceExtension({
    async read() {
      reads++;
      return { items: [], nextCursor: null };
    },
  }).tools![0]!;
  const results = [
    await tool.execute({ sessionId: 'foreign' }, context),
    await tool.execute({}, { ...context, runId: null }),
  ];
  expect(reads).toBe(0);
  for (const result of results) {
    expect(result.outcome).toBe('failed');
    expect(result.content).toMatch(/did not rerun|no operation was rerun/);
    expect(result.content).not.toMatch(/\b(?:Job|carrier|Run|Session|dispatch)\b/i);
  }
  expect(results[0]!.content).toContain('execution_id');
  expect(results[1]!.content).toContain('current task scope is unavailable');
});

for (const code of ['execution_evidence_cursor_invalid', 'execution_evidence_scope_denied'])
  test(`${code} preserves the boundary and offers a read-only recovery without leaking backend text`, async () => {
    const tool = createExecutionEvidenceExtension({
      async read() {
        throw new AgentError(code, 'PRIVATE_BACKEND_AND_FOREIGN_ID');
      },
    }).tools![0]!;
    const result = await tool.execute({ cursor: 'original-cursor' }, context);
    expect(result.outcome).toBe('failed');
    expect(result.details).toEqual({ code });
    expect(result.content).toContain('without');
    expect(result.content).not.toContain('PRIVATE_BACKEND_AND_FOREIGN_ID');
    expect(result.content).not.toMatch(/\b(?:Job|carrier|Run|Session|dispatch)\b/i);
    if (code === 'execution_evidence_cursor_invalid')
      expect(result.content).toContain('do not rerun the original operation');
    else {
      expect(result.content).toContain('already available result and source evidence');
      expect(result.content).toContain('No unrelated history was returned');
    }
  });

test('an unverified evidence result retains no foreign payload and does not expand reader scope', async () => {
  const tool = createExecutionEvidenceExtension({
    async read() {
      return {
        items: [
          {
            taskRunId: 'foreign',
            execution: {
              id: 'foreign-id',
              sessionId: 'foreign-owner',
              runId: 'foreign',
              kind: 'tool',
              status: 'succeeded',
              resultRevision: '1',
              result: { content: 'PRIVATE_PAYLOAD' },
            },
          },
        ],
        nextCursor: null,
      };
    },
  }).tools![0]!;
  const result = await tool.execute({ executionId: 'foreign-id' }, context);
  expect(result.outcome).toBe('failed');
  expect(result.details).toEqual({ code: 'execution_evidence_scope_denied' });
  expect(result.content).toContain('Do not invent an ID or rerun');
  expect(result.content).not.toContain('foreign-id');
  expect(result.content).not.toContain('PRIVATE_PAYLOAD');
});
