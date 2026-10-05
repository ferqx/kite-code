import { expect, test } from 'bun:test';
import type { Execution, SelectedContextPage } from '@kite-ai/client';
import { ContextPanel } from '../src';

const page: SelectedContextPage = {
  selection: {
    id: 'selected',
    sessionId: 's',
    previousSelectionId: 'old',
    boundaryMessageId: null,
    boundarySeq: '0',
    tailFromSeq: '3',
    ranges: [],
  },
  highWaterSeq: '3',
  messages: [],
  resultSources: [
    {
      id: 'source',
      seq: '3',
      sessionId: 's',
      createdSelectionId: 'selected',
      executionId: 'old-job',
      resultRevision: '4',
      originStoreId: 'original-store',
      inclusion: 'explicit',
      result: { content: 'untrusted body' },
    },
  ],
  nextAfterSeq: null,
  nextAfterSourceId: null,
  snapshotCursor: '20',
};
const execution: Execution = {
  id: 'old-job',
  originStoreId: 'original-store',
  sessionId: 's',
  runId: 'old-run',
  kind: 'job',
  definitionId: 'fixture.job',
  definitionVersion: '1',
  status: 'succeeded',
  result: { content: 'untrusted body' },
  resultRevision: '4',
  cancelRequestedAt: null,
  delivery: 'suppressed',
  deliveryReason: 'context_rewound',
};
function buttons(element: unknown): Array<{ disabled: boolean; onClick: () => void }> {
  if (!element || typeof element !== 'object') return [];
  const node = element as {
    type: unknown;
    props: { children?: unknown; disabled: boolean; onClick: () => void };
  };
  const children = node.props?.children;
  return [
    ...(node.type === 'button' ? [node.props] : []),
    ...(Array.isArray(children) ? children : [children]).flatMap(buttons),
  ];
}
test('pure React Context projection preserves selection, original result provenance and readonly has no operation entry', () => {
  const element = ContextPanel({ context: page, history: [execution] });
  const text = JSON.stringify(element);
  expect(text).toContain('original-store');
  expect(text).toContain('context_rewound');
  expect(text).toContain('old-job');
  expect(text).toContain('explicit');
  expect(buttons(element)).toEqual([]);
});
test('active Context operations are disabled; historical include passes exact original execution without claiming execution', () => {
  const seen: Execution[] = [];
  const disabled = ContextPanel({
    context: page,
    history: [execution],
    storeId: 'current-store',
    busy: true,
    onRewind() {},
    onInclude(value) {
      seen.push(value);
    },
  });
  expect(buttons(disabled).every((value) => value.disabled)).toBe(true);
  expect(JSON.stringify(disabled)).toContain('input_busy');
  const enabled = ContextPanel({
    context: page,
    history: [execution],
    storeId: 'current-store',
    onInclude(value) {
      seen.push(value);
    },
  });
  buttons(enabled)[0]!.onClick();
  expect(seen).toEqual([execution]);
  expect(JSON.stringify(enabled)).toContain('Include result only saves a source');
});

test('active include click retains exact Run and selection; queued notice does not claim inclusion', () => {
  let saved: unknown;
  const element = ContextPanel({
    context: page,
    history: [execution],
    storeId: 'store',
    busy: true,
    activeRun: {
      id: 'original-run',
      sessionId: 's',
      isActive: true,
    } as import('@kite-ai/client').Run,
    onInclude(_execution, scope) {
      saved = scope;
    },
  });
  const button = buttons(element)[0]!;
  expect(button.disabled).toBe(false);
  button.onClick();
  expect(saved).toEqual({
    storeId: 'store',
    sessionId: 's',
    contextSelectionId: 'selected',
    targetRunId: 'original-run',
  });
  expect(JSON.stringify(element)).toContain('original-run');
});
