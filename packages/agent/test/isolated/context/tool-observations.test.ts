import { expect, test } from 'bun:test';
import type { ModelMessage } from '@kite-ai/ai';
import type { ExecutionRecord } from '../../../src/storage/types';
import {
  childToolEvidence,
  type ToolObservation,
  toolObservation,
} from '../../../src/tool-observations';

const identity = { sessionId: 'child', runId: 'current', storeId: 'store' };
const lookup = (): ToolObservation => ({
  kind: 'lookup',
  scope: 'src',
  query: 'literal',
  sources: [],
  matchCount: 0,
  complete: true,
  coverage: 'page',
});
const inspection = (): ToolObservation => ({
  kind: 'inspection',
  scope: 'src/entry.ts',
  sources: [{ path: 'src/entry.ts', version: 'a'.repeat(64), fromLine: 1, toLine: 4 }],
  complete: true,
  coverage: 'file',
});
function pair(id: string, tool = 'lookup', content = 'untrusted displayed body'): ModelMessage[] {
  return [
    {
      role: 'assistant',
      content: '',
      toolCalls: [{ id: `call-${id}`, name: tool, arguments: '{}' }],
    },
    { role: 'tool', toolCallId: `call-${id}`, sourceIds: [id], content },
  ];
}
function record(
  id: string,
  observation = lookup(),
  overrides: Partial<ExecutionRecord> = {},
): ExecutionRecord {
  return {
    id,
    kind: 'tool',
    sessionId: identity.sessionId,
    runId: identity.runId,
    originStoreId: identity.storeId,
    callId: `call-${id}`,
    definitionId: 'lookup',
    definitionVersion: '3',
    status: 'succeeded',
    result: { outcome: 'succeeded', content: JSON.stringify({ observation }) },
    ...overrides,
  } as ExecutionRecord;
}
test('observations validate bounded line identities without treating malformed JSON as evidence', () => {
  expect(toolObservation(JSON.stringify({ observation: inspection() }))).toEqual(inspection());
  const withExcerpt = {
    ...inspection(),
    excerpt: { text: 'original preview 雪🙂', truncated: false },
  };
  expect(toolObservation(JSON.stringify({ observation: withExcerpt }))).toEqual(withExcerpt);
  expect(
    toolObservation(JSON.stringify({ observation: { ...lookup(), matchUnit: 'files' } })),
  ).toEqual({ ...lookup(), matchUnit: 'files' });
  for (const observation of [
    { ...inspection(), complete: 'yes' },
    { ...lookup(), matchCount: -1 },
    { ...lookup(), matchUnit: 'repositories' },
    { ...inspection(), sources: [{ path: 'a', version: 'v', fromLine: 4, toLine: 2 }] },
    { ...inspection(), sources: [{ path: 'a', version: '' }] },
    { ...inspection(), excerpt: { text: 'not a complete descriptor' } },
    { ...inspection(), excerpt: { text: 7, truncated: false } },
  ])
    expect(toolObservation(JSON.stringify({ observation }))).toBeUndefined();
  expect(toolObservation('not JSON')).toBeUndefined();
});

test('child evidence binds exact current scope and call provenance, deduplicates executions, and keeps definition versions distinct', async () => {
  const records = new Map<string, ExecutionRecord>();
  const history: ModelMessage[] = [];
  const invalid: Partial<ExecutionRecord>[] = [
    { runId: 'old-run' },
    { sessionId: 'foreign-child' },
    { originStoreId: 'foreign-store' },
    { callId: 'other-call' },
    { definitionId: 'other-tool' },
    { status: 'running' },
    { kind: 'model' },
  ];
  for (const [i, override] of invalid.entries()) {
    const id = `invalid-${i}`;
    history.push(...pair(id));
    records.set(id, record(id, lookup(), override));
  }
  for (const [id, definitionVersion] of [
    ['valid-v3', '3'],
    ['valid-v4', '4'],
  ] as const) {
    history.push(...pair(id));
    records.set(id, record(id, lookup(), { definitionVersion }));
  }
  history.push(...pair('valid-v3'));
  const evidence = await childToolEvidence(
    history,
    identity,
    async (id) => records.get(id) ?? null,
  );
  expect(evidence).toMatchObject({
    ...identity,
    coverage: 'selected_history',
    observationsOmitted: 0,
    toolCallsOmitted: 0,
  });
  expect(evidence!.observations.map((o) => o.executionId)).toEqual(['valid-v3', 'valid-v4']);
  expect(evidence!.tools).toEqual([
    { tool: 'lookup', definitionVersion: '3', outcomes: { succeeded: 1 } },
    { tool: 'lookup', definitionVersion: '4', outcomes: { succeeded: 1 } },
  ]);
  expect(evidence!.limitation).toContain('not proved absent');
  expect(
    await childToolEvidence(
      history,
      { ...identity, runId: 'no-such-run' },
      async (id) => records.get(id) ?? null,
    ),
  ).toBeUndefined();
});

test('roughly 19 MiB of original observations yield an explicit preview below 40 KiB and retain a small source inspection', async () => {
  const sources = Array.from({ length: 100 }, (_, i) => ({
    path: `${`${'d'.repeat(62)}/`.repeat(63)}f${i}`,
    version: 'a'.repeat(64),
  }));
  const large = { ...lookup(), sources };
  const content = JSON.stringify({ observation: large });
  expect(Buffer.byteLength(content) * 48).toBeGreaterThan(19_000_000);
  const history: ModelMessage[] = [];
  const records = new Map<string, ExecutionRecord>();
  for (let i = 0; i < 48; i++) {
    const id = `large-${i}`;
    history.push(...pair(id));
    records.set(id, record(id, large));
  }
  history.push(...pair('inspection', 'read'));
  records.set('inspection', record('inspection', inspection(), { definitionId: 'read' }));
  const evidence = await childToolEvidence(
    history,
    identity,
    async (id) => records.get(id) ?? null,
  );
  expect(Buffer.byteLength(JSON.stringify(evidence))).toBeLessThan(40 * 1024);
  expect(evidence!.observationsOmitted).toBe(48);
  expect(evidence!.observations.map((o) => o.executionId)).toEqual(['inspection']);
  expect(evidence!.tools[0]!.outcomes.succeeded).toBe(48);
  // Preview omission never mutates or truncates independently retained original receipts.
  expect((records.get('large-0')!.result as { content: string }).content).toBe(content);
});

test('tool summary overflow is disclosed without claiming absent calls or changing original outcomes', async () => {
  const history: ModelMessage[] = [];
  const records = new Map<string, ExecutionRecord>();
  for (let i = 0; i < 70; i++) {
    const id = `tool-${i}`;
    history.push(...pair(id, id));
    records.set(
      id,
      record(id, lookup(), {
        definitionId: id,
        status: 'failed',
        result: { outcome: 'failed', content: 'actual failure' },
      }),
    );
  }
  const evidence = await childToolEvidence(
    history,
    identity,
    async (id) => records.get(id) ?? null,
  );
  expect(evidence!.tools).toHaveLength(64);
  expect(evidence!.toolCallsOmitted).toBe(6);
  expect(evidence!.observations).toEqual([]);
  expect(evidence!.tools.every((tool) => tool.outcomes.failed === 1)).toBe(true);
  expect(evidence!.limitation).toContain('bounded preview');
});
