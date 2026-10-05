import { expect, test } from 'bun:test';
import type { AgentClient, SelectedContextPage, SessionView } from '@kite-ai/client';
import { createDesktopController } from '../src';

function view(id: string): SessionView {
  return {
    storeId: 'store',
    snapshotCursor: '0',
    session: {
      id,
      rootSessionId: id,
      workspaceId: 'w',
      parentSessionId: null,
      title: id,
      controlRevision: '1',
      contextSelectionId: 'selected',
      nextSeq: '3',
      deletedAt: null,
    },
    runs: [],
    messages: [],
    executions: [],
  };
}
function page(id = 's'): SelectedContextPage {
  return {
    selection: {
      id: 'selected',
      sessionId: id,
      previousSelectionId: null,
      boundaryMessageId: null,
      boundarySeq: '0',
      tailFromSeq: '0',
      ranges: [],
    },
    highWaterSeq: '3',
    messages: [],
    resultSources: [],
    nextAfterSeq: null,
    nextAfterSourceId: null,
    snapshotCursor: '0',
  };
}
test('unknown Context mutation keeps original selection/command across view switch and only queries that command', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let mutations = 0;
  let reads = '';
  const client = {
    serverInfo: { storeId: 'store', capabilities: ['context'] },
    async getView(id: string) {
      return view(id);
    },
    async getContext(id: string) {
      return page(id);
    },
    async rewind(
      session: string,
      input: { commandId: string; expectedContextSelectionId: string },
    ) {
      mutations++;
      expect(session).toBe('original');
      expect(input.expectedContextSelectionId).toBe('selected');
      await gate;
      throw new Error('lost');
    },
    async getCommand(id: string) {
      reads = id;
      return {
        id,
        sessionId: 'original',
        originStoreId: 'store',
        status: 'applied',
        kind: 'context.select',
        receipt: {},
        cancelRequestedAt: null,
      };
    },
  } as unknown as AgentClient;
  const desktop = createDesktopController({ admittedClient: client, onSnapshot() {} });
  await desktop.selectSession('original');
  const one = desktop.rewindContext(null);
  expect(desktop.rewindContext(null)).toBe(one);
  await desktop.selectSession('new');
  release();
  await expect(one).rejects.toThrow('lost');
  const saved = desktop.contextSubmissions[0]!;
  expect(saved.phase).toBe('unknown');
  expect(saved.sessionId).toBe('original');
  expect(saved.intent.expectedContextSelectionId).toBe('selected');
  expect(mutations).toBe(1);
  await desktop.lookupContextIntent(saved.intent.commandId);
  expect(reads).toBe(saved.intent.commandId);
  expect(desktop.contextSubmissions[0]?.phase).toBe('applied');
  expect(mutations).toBe(1);
});
test('context paging exhausts independent sources without replaying exhausted messages and pins high water/selection', async () => {
  const queries: Record<string, unknown>[] = [];
  const source = {
    id: 'source',
    seq: '1',
    sessionId: 's',
    createdSelectionId: 'selected',
    executionId: 'job',
    resultRevision: '1',
    originStoreId: 'original',
    inclusion: 'automatic' as const,
    result: null,
  };
  const client = {
    serverInfo: { storeId: 'store', capabilities: ['context'] },
    async getView(id: string) {
      return view(id);
    },
    async getContext(_id: string, input: Record<string, unknown>) {
      queries.push(input);
      return queries.length === 1
        ? { ...page(), resultSources: [source], nextAfterSeq: '1' }
        : queries.length === 2
          ? { ...page(), nextAfterSeq: '2' }
          : page();
    },
  } as unknown as AgentClient;
  const desktop = createDesktopController({ admittedClient: client, onSnapshot() {} });
  await desktop.selectSession('s');
  await desktop.loadContextPage();
  await desktop.loadContextPage();
  expect(queries[1]).toMatchObject({
    storeId: 'store',
    contextSelectionId: 'selected',
    upperSeq: '3',
    afterSeq: '1',
    afterSourceId: 'source',
  });
  expect(queries[2]).toMatchObject({ upperSeq: '3', afterSeq: '2', afterSourceId: 'source' });
  await expect(desktop.loadContextPage()).rejects.toThrow('context_page_end');
});
test('active Run blocks Context locally as input_busy and never converts it into steer', async () => {
  let mutations = 0;
  const client = {
    serverInfo: { storeId: 'store', capabilities: ['context'] },
    async getView(id: string) {
      return { ...view(id), runs: [{ isActive: true }] };
    },
    async getContext() {
      return page();
    },
    async rewind() {
      mutations++;
    },
  } as unknown as AgentClient;
  const desktop = createDesktopController({ admittedClient: client, onSnapshot() {} });
  await desktop.selectSession('s');
  expect(() => desktop.rewindContext(null)).toThrow('input_busy');
  expect(mutations).toBe(0);
});

test('source-only next pages keep exhausted messages at fixed high water rather than resetting message cursor', async () => {
  const queries: Record<string, unknown>[] = [];
  const client = {
    serverInfo: { storeId: 'store', capabilities: ['context'] },
    async getView(id: string) {
      return view(id);
    },
    async getContext(_id: string, input: Record<string, unknown>) {
      queries.push(input);
      return {
        ...page(),
        nextAfterSourceId: queries.length === 1 ? 'first' : queries.length === 2 ? 'second' : null,
      };
    },
  } as unknown as AgentClient;
  const desktop = createDesktopController({ admittedClient: client, onSnapshot() {} });
  await desktop.selectSession('s');
  await desktop.loadContextPage();
  await desktop.loadContextPage();
  expect(queries[1]).toMatchObject({ upperSeq: '3', afterSeq: '3', afterSourceId: 'first' });
  expect(queries[2]).toMatchObject({ upperSeq: '3', afterSeq: '3', afterSourceId: 'second' });
});

test('a later pinned page offers its exact message boundary and duplicate property ordering cannot send twice', async () => {
  let reads = 0;
  let writes = 0;
  const client = {
    serverInfo: { storeId: 'store', capabilities: ['context'] },
    async getView(id: string) {
      return view(id);
    },
    async getContext() {
      reads++;
      return reads === 1
        ? { ...page(), nextAfterSeq: '1' }
        : {
            ...page(),
            messages: [
              {
                id: 'later',
                sessionId: 's',
                runId: 'old',
                seq: '2',
                status: 'complete',
                role: 'assistant',
                content: 'complete later message',
              },
            ],
          };
    },
    async rewind(
      _id: string,
      input: { commandId: string; boundary: { messageId: string; seq: string } },
    ) {
      writes++;
      expect(input.boundary).toEqual({ messageId: 'later', seq: '2' });
      return {
        command: {
          id: input.commandId,
          sessionId: 's',
          originStoreId: 'store',
          kind: 'context.select',
          status: 'applied',
          receipt: {},
          cancelRequestedAt: null,
        },
      };
    },
  } as unknown as AgentClient;
  const desktop = createDesktopController({ admittedClient: client, onSnapshot() {} });
  await desktop.selectSession('s');
  await desktop.loadContextPage();
  const one = desktop.rewindContext({ messageId: 'later', seq: '2' });
  const two = desktop.rewindContext({ seq: '2', messageId: 'later' });
  expect(two).toBe(one);
  await one;
  expect(writes).toBe(1);
});

test('active include freezes original Run and queues through view switch; reconciliation never resubmits', async () => {
  const execution = {
    id: 'job',
    sessionId: 'original',
    originStoreId: 'store',
    kind: 'job',
    status: 'succeeded',
    delivery: 'suppressed',
    resultRevision: '4',
  };
  let submitted: Record<string, unknown> | undefined;
  let resolve!: (value: unknown) => void;
  let reads = 0;
  const client = {
    serverInfo: { storeId: 'store', capabilities: ['context'] },
    async getView(id: string) {
      return {
        ...view(id),
        executions: [execution],
        runs: [{ id: 'run-original', sessionId: id, isActive: true }],
      };
    },
    async getContext(id: string) {
      return page(id);
    },
    async includeResult(_session: string, _execution: string, input: Record<string, unknown>) {
      submitted = input;
      return new Promise((r) => {
        resolve = r;
      });
    },
    async getCommand(id: string) {
      reads++;
      return {
        id,
        sessionId: 'original',
        originStoreId: 'store',
        kind: 'result.include',
        status: 'applied',
        receipt: { outcome: 'result_included' },
        cancelRequestedAt: null,
      };
    },
  } as unknown as AgentClient;
  const desktop = createDesktopController({ admittedClient: client, onSnapshot() {} });
  await desktop.selectSession('original');
  expect(() =>
    desktop.includeHistoricalResult(execution as import('@kite-ai/client').Execution),
  ).toThrow('input_target_changed');
  const scope = {
    storeId: 'store',
    sessionId: 'original',
    contextSelectionId: 'selected',
    targetRunId: 'run-original',
  };
  const promise = desktop.includeHistoricalResult(
    execution as import('@kite-ai/client').Execution,
    scope,
  );
  await Promise.resolve();
  await desktop.selectSession('new');
  resolve({
    command: {
      id: submitted!.commandId,
      originStoreId: 'store',
      sessionId: 'original',
      kind: 'result.include',
      status: 'accepted',
      receipt: { outcome: 'result_queued', runId: 'run-original' },
      cancelRequestedAt: null,
    },
  });
  await promise;
  expect(submitted!.targetRunId).toBe('run-original');
  expect(desktop.contextSubmissions[0]!.phase).toBe('queued');
  expect(desktop.contextSubmissions[0]!.sessionId).toBe('original');
  await desktop.lookupContextIntent(String(submitted!.commandId));
  expect(desktop.contextSubmissions[0]!.phase).toBe('applied');
  expect(reads).toBe(1);
});

test('stale clicked scope and missing original result provenance never submit or rebind active include', async () => {
  let posts = 0;
  const execution = {
    id: 'job',
    sessionId: 's',
    originStoreId: 'original-store',
    kind: 'job',
    status: 'succeeded',
    delivery: 'suppressed',
    resultRevision: '9',
  } as import('@kite-ai/client').Execution;
  const client = {
    serverInfo: { storeId: 'store', capabilities: ['context'] },
    async getView(id: string) {
      return {
        ...view(id),
        executions: [execution],
        runs: [{ id: 'run-current', sessionId: id, isActive: true }],
      };
    },
    async getContext(id: string) {
      return page(id);
    },
    async includeResult() {
      posts++;
    },
  } as unknown as AgentClient;
  const desktop = createDesktopController({ admittedClient: client, onSnapshot() {} });
  await desktop.selectSession('s');
  expect(() =>
    desktop.includeHistoricalResult(execution, {
      storeId: 'old-store',
      sessionId: 's',
      contextSelectionId: 'selected',
      targetRunId: 'run-current',
    }),
  ).toThrow('context_selection_changed');
  expect(() =>
    desktop.includeHistoricalResult(execution, {
      storeId: 'store',
      sessionId: 's',
      contextSelectionId: 'selected',
      targetRunId: 'old-run',
    }),
  ).toThrow('input_target_changed');
  delete execution.originStoreId;
  const error = await desktop
    .includeHistoricalResult(execution, {
      storeId: 'store',
      sessionId: 's',
      contextSelectionId: 'selected',
      targetRunId: 'run-current',
    })
    .catch((error) => error);
  expect(error.code).toBe('historical_result_unavailable');
  expect(posts).toBe(0);
});
