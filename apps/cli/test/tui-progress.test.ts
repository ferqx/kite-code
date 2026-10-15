import { expect, test } from 'bun:test';
import type { AgentClient, SessionView } from '@kite-ai/client';
import { readTuiProgress } from '../host/tui-progress';

const view = {
  storeId: 'store',
  session: { id: 'session' },
  runs: [{ id: 'run', isActive: true, sessionId: 'session', originStoreId: 'store' }],
} as unknown as SessionView;
const current = { kind: 'plan_current', planId: 'plan', version: 2, digest: 'exact' };
const body = () => ({
  runId: 'run',
  originStoreId: 'store',
  approvalStatus: 'approved',
  current,
  plan: {
    ...current,
    kind: 'plan_document',
    title: 'Original approved plan',
    steps: [
      { id: 'a', title: 'Original first step' },
      { id: 'b', title: 'Original second step' },
    ],
  },
  progress: {
    ...current,
    kind: 'plan_progress',
    runId: 'run',
    steps: { a: { status: 'completed' }, b: { status: 'running' } },
  },
});
function client(payload: unknown) {
  const calls: unknown[][] = [];
  return {
    calls,
    reader: {
      async queryExtension(...args: unknown[]) {
        calls.push(args);
        return [
          {
            extensionId: 'builtin.planning',
            contentType: 'builtin.planning.record',
            contentVersion: 1,
            payload,
          },
        ];
      },
    } as unknown as Pick<AgentClient, 'queryExtension'>,
  };
}
test('progress reads one public query and projects only exact approved current Run steps', async () => {
  const source = client(body());
  expect(await readTuiProgress(source.reader, view, 'store', new AbortController().signal)).toEqual(
    {
      plan: {
        title: 'Original approved plan',
        steps: [
          { step: 'Original first step', status: 'completed' },
          { step: 'Original second step', status: 'in_progress' },
        ],
      },
    },
  );
  expect(source.calls).toHaveLength(1);
  expect(source.calls[0]!.slice(0, 4)).toEqual([
    'session',
    'builtin.planning',
    'planning.progress.view',
    { runId: 'run' },
  ]);
});
test('pointer-only status, unapproved plan, previous Run and malformed progress never invent visible facts', async () => {
  for (const payload of [
    current,
    { ...body(), approvalStatus: 'pending' },
    { ...body(), runId: 'other' },
    { ...body(), progress: { ...body().progress, digest: 'other' } },
    { ...body(), progress: { ...body().progress, steps: { a: 'completed' } } },
  ])
    expect(
      await readTuiProgress(client(payload).reader, view, 'store', new AbortController().signal),
    ).toEqual({});
});
test('confirmed initial pending steps and failures are preserved; completed summaries do not imply a compaction phase', async () => {
  const initial = await readTuiProgress(
    client({ ...body(), progress: null }).reader,
    view,
    'store',
    new AbortController().signal,
  );
  expect(initial.plan?.steps.map((step) => step.status)).toEqual(['pending', 'pending']);
  const failed = await readTuiProgress(
    client({
      ...body(),
      progress: {
        ...body().progress,
        steps: { a: { status: 'failed' }, b: { status: 'blocked' } },
      },
    }).reader,
    view,
    'store',
    new AbortController().signal,
  );
  expect(failed.plan?.steps.map((step) => step.status)).toEqual(['failed', 'blocked']);
  expect(failed.compactionPhase).toBeUndefined();
});
test('wrong Store or no uniquely active Run makes no query; optional query failure leaves UI usable', async () => {
  const source = client(body());
  expect(await readTuiProgress(source.reader, view, 'other', new AbortController().signal)).toEqual(
    {},
  );
  expect(
    await readTuiProgress(
      source.reader,
      { ...view, runs: [] },
      'store',
      new AbortController().signal,
    ),
  ).toEqual({});
  expect(source.calls).toHaveLength(0);
  const unavailable = {
    queryExtension: async () => {
      throw Error('not_available');
    },
  } as unknown as Pick<AgentClient, 'queryExtension'>;
  expect(await readTuiProgress(unavailable, view, 'store', new AbortController().signal)).toEqual(
    {},
  );
});

test('completed last source Run may retain proved progress; active Run always wins over older approval', async () => {
  const completed = { ...view, runs: [{ ...view.runs[0]!, isActive: false }] };
  expect(
    (await readTuiProgress(client(body()).reader, completed, 'store', new AbortController().signal))
      .plan,
  ).toBeDefined();
  const next = {
    ...view,
    runs: [...completed.runs, { ...view.runs[0]!, id: 'new', isActive: true }],
  };
  expect(
    await readTuiProgress(client(body()).reader, next, 'store', new AbortController().signal),
  ).toEqual({});
});
test('live compression phase requires exact active scope and survives unrelated optional planning query failure', async () => {
  const source = {
    queryExtension: async () => {
      throw Error('optional_unavailable');
    },
  } as unknown as Pick<AgentClient, 'queryExtension'>;
  const actual = {
    ...view,
    compressionProgress: { runId: 'run', originStoreId: 'store', phase: 'summarizing' as const },
  };
  expect(await readTuiProgress(source, actual, 'store', new AbortController().signal)).toEqual({
    compactionPhase: 'summarizing',
  });
  expect(
    await readTuiProgress(
      source,
      { ...actual, compressionProgress: { ...actual.compressionProgress, runId: 'old' } },
      'store',
      new AbortController().signal,
    ),
  ).toEqual({});
});
