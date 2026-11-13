import {
  projectTrajectory,
  type TrajectoryEvent,
  trajectoryEventSchema,
} from '@kite-ai/trajectory';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test } from '#kite-test';
import { trajectoryFactAnchor } from '../src/desktop/trajectory/fact-anchor';
import { loopPartLabel, loopPartSnippet } from '../src/desktop/trajectory/loop-materials';
import { trajectoryOutputState } from '../src/desktop/trajectory/output-presence';
import { TrajectoryTimeline } from '../src/desktop/trajectory/TrajectoryTimeline';
import { buildTrajectoryTree } from '../src/desktop/trajectory/tree';
import {
  buildTrajectoryWorkbenchIndex,
  filterTrajectoryWorkbench,
} from '../src/desktop/trajectory/workbench';
import { trajectoryMaterialTargets } from '../src/desktop/trajectory/workbench-details';

function fact(n: number, values: Record<string, unknown> = {}): TrajectoryEvent {
  return trajectoryEventSchema.parse({
    schema: 'kite.trajectory',
    schemaVersion: 1,
    eventId: `te_${n.toString(16).padStart(64, '0')}`,
    sequence: String(n),
    origin: { storeId: 'store', cursor: String(n) },
    sessionId: 's',
    workspaceId: 'w',
    runId: 'r',
    runOriginStoreId: 'store',
    executionId: 'm',
    executionOriginStoreId: 'store',
    kind: 'model',
    phase: 'completed',
    recordedStatus: 'succeeded',
    occurredAt: n * 100,
    sourceEventType: 'execution.completed',
    sourceRecordRevision: String(n),
    identityConfidence: 'verified_origin',
    attributes: {},
    evidenceRefs: [],
    ...values,
  });
}
function model(
  n = 1,
  state: Record<string, unknown> = {},
  presence: Record<string, unknown> | null = {},
) {
  const reference = {
    kind: 'model_output',
    evidenceId: `output-${n}`,
    contentVersion: `v${n}`,
    availability: 'available',
    mediaType: 'application/json',
  };
  return fact(n, {
    evidenceRefs: [reference],
    attributes:
      presence === null
        ? {}
        : {
            display: {
              kind: 'model',
              outputPresence: {
                hasText: false,
                toolCallCount: 1,
                complete: true,
                evidenceId: reference.evidenceId,
                contentVersion: reference.contentVersion,
                ...presence,
              },
            },
          },
    ...state,
  });
}
function view(events: TrajectoryEvent[]) {
  const p = projectTrajectory(events, { atCursor: events.at(-1)!.sequence, completePrefix: true });
  return filterTrajectoryWorkbench(
    buildTrajectoryWorkbenchIndex(p, buildTrajectoryTree(p, []), { loopParts: true }),
  );
}
const reply = (w: ReturnType<typeof view>) => w.byId.get('execution:m:part:reply')!;
const visibleReply = (w: ReturnType<typeof view>) =>
  w.visibleRows.some((r) => r.id === 'execution:m:part:reply');

test('sealed tool-only output is hidden without reading a body, while identity/material ownership survives', () => {
  const events = [model()];
  const original = JSON.stringify(events);
  const w = view(events);
  expect(visibleReply(w)).toBe(false);
  expect(reply(w).outputSuppressed).toBe(true);
  expect(trajectoryMaterialTargets(reply(w), 'content')[0]?.reference.evidenceId).toBe('output-1');
  expect(w.visibleRows.some((r) => r.id === 'execution:m:part:thinking')).toBe(true);
  expect(w.rows.find((r) => r.kind === 'run')?.summary?.model).toBe(1);
  expect(JSON.stringify(events)).toBe(original);
});

test('text, whitespace, empty-without-tools, legacy and mismatched proof never remove normal output', () => {
  for (const event of [
    model(1, {}, { hasText: true }),
    model(1, {}, { toolCallCount: 0 }),
    model(1, {}, null),
    model(1, {}, { contentVersion: 'other' }),
    model(1, {}, { evidenceId: 'other' }),
    model(1, { identityConfidence: 'legacy_local' }),
    model(1, { phase: 'outcome_unknown', recordedStatus: 'outcome_unknown' }),
    model(1, { phase: 'failed', recordedStatus: 'failed' }),
    model(1, { phase: 'cancelled', recordedStatus: 'cancelled' }),
  ])
    expect(visibleReply(view([event]))).toBe(true);
  const w = view([model(1, {}, { hasText: true })]);
  expect(
    loopPartSnippet(reply(w), [
      {
        eventId: w.eventsById.values().next().value!.eventId,
        evidenceId: 'output-1',
        contentVersion: 'v1',
        status: 'available',
        data: { content: ' \n\t ', complete: true },
      },
    ]),
  ).toBe('正文仅包含空白字符（已保存）');
  const empty = view([model(1, {}, { toolCallCount: 0 })]);
  expect(loopPartSnippet(reply(empty), [])).toBe('已完成，无正文');
});

test('active no-text prefixes stay in thought, positive prefixes remain, and old success cannot override current unknown', () => {
  const prefix = model(1, { phase: 'running', recordedStatus: 'running' }, { complete: false });
  expect(visibleReply(view([prefix]))).toBe(false);
  const partial = trajectoryEventSchema.parse({
    ...prefix,
    evidenceRefs: prefix.evidenceRefs.map((r) => ({ ...r, availability: 'partial' })),
  });
  expect(visibleReply(view([partial]))).toBe(false);
  expect(
    visibleReply(
      view([
        model(
          1,
          { phase: 'running', recordedStatus: 'running' },
          { complete: false, hasText: true },
        ),
      ]),
    ),
  ).toBe(true);
  expect(
    visibleReply(
      view([model(), fact(2, { phase: 'outcome_unknown', recordedStatus: 'outcome_unknown' })]),
    ),
  ).toBe(true);
  const current = view([model()]).byId.get('execution:m')!;
  expect(
    trajectoryOutputState({
      ...current,
      step: { ...current.step!, identityConfidence: 'legacy_local' },
    }),
  ).toBe('unknown');
  expect(
    trajectoryOutputState({
      ...current,
      step: { ...current.step!, executionOriginStoreId: 'foreign' },
    }),
  ).toBe('unknown');
});

test('canonical tool-only and active empty assistant records are not visible replies or timeline/message statistics', () => {
  for (const pending of [false, true]) {
    const m = model(
      1,
      pending ? { phase: 'running', recordedStatus: 'running' } : {},
      pending ? { complete: false } : {},
    );
    const ref = {
      kind: 'message',
      evidenceId: 'message',
      contentVersion: 'mv1',
      availability: pending ? 'partial' : 'available',
      mediaType: 'application/json',
    };
    const msg = fact(2, {
      kind: 'message',
      phase: 'observed',
      recordedStatus: pending ? 'incomplete' : 'complete',
      attributes: {
        messageId: 'a',
        role: 'assistant',
        messageSeq: '1',
        revision: '1',
        status: pending ? 'incomplete' : 'complete',
        display: {
          kind: 'message',
          outputPresence: {
            hasText: false,
            toolCallCount: 1,
            complete: !pending,
            evidenceId: 'message',
            contentVersion: 'mv1',
          },
        },
      },
      evidenceRefs: [ref],
    });
    const w = view([m, msg]);
    expect(w.byId.has('message:a')).toBe(true);
    expect(w.visibleRows.some((r) => r.id === 'message:a')).toBe(false);
    expect(w.rows.find((r) => r.kind === 'run')?.summary?.assistantMessages).toBe(0);
    expect(w.rows.find((r) => r.kind === 'run')?.summary?.model).toBe(1);
    expect(
      renderToStaticMarkup(
        createElement(TrajectoryTimeline, {
          workbench: w,
          mode: 'time',
          onChoose: () => {},
          onModeChange: () => {},
        }),
      ),
    ).not.toContain('data-trajectory-marker="message:a"');
    const foreign = view([
      m,
      trajectoryEventSchema.parse({ ...msg, executionOriginStoreId: 'foreign' }),
    ]);
    expect(foreign.visibleRows.some((r) => r.id === 'message:a')).toBe(true);
  }
});

test('older genuine or unknown attempt output retains a labeled history entry and exact selected version', () => {
  for (const oldPresence of [null, { hasText: true, complete: false }]) {
    const old = model(1, { phase: 'failed', recordedStatus: 'failed' }, oldPresence);
    const next = model(2, { executionId: 'retry' });
    next.attributes = {
      ...next.attributes,
      previousExecutionId: 'm',
      previousExecutionOriginStoreId: 'store',
      retryAttempt: 2,
      retryReason: 'connection_failed',
    } as typeof next.attributes;
    const w = view([old, next]);
    expect(visibleReply(w)).toBe(true);
    expect(reply(w).outputHistory).toBe(true);
    expect(loopPartLabel(reply(w), [])).toBe('历史输出');
    expect(
      trajectoryMaterialTargets(reply(w), 'content', old.eventId)[0]?.reference.evidenceId,
    ).toBe('output-1');
  }
});

test('incoming fact insertions and hidden output anchors preserve the stable row and fractional offset', () => {
  const old = view([
    model(1, { phase: 'running', recordedStatus: 'running' }, { complete: false }),
  ]);
  const next = view([model(1, {}, { hasText: true })]);
  const previous = ['before', 'execution:m:part:thinking', 'after'];
  const rows = [
    { id: 'inserted' },
    { id: 'before' },
    { id: 'execution:m:part:thinking' },
    { id: 'after' },
  ] as typeof next.visibleRows;
  expect(trajectoryFactAnchor(previous, rows, 38 + 7, next.byId)).toBe(76 + 7);
  expect(trajectoryFactAnchor(['execution:m:part:reply'], old.visibleRows, 5, old.byId)).toBe(
    old.visibleRows.findIndex((r) => r.id === 'execution:m:part:thinking') * 38 + 5,
  );
});
