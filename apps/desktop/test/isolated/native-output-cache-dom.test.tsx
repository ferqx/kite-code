import { expect, test } from 'bun:test';
import { JSDOM } from 'jsdom';
import { act, type ReactNode, useRef } from 'react';
import { NativeOutputDisplayVersions } from '../../electron/output-display-versions';
import type { NativeBridge, NativeRequest, NativeResult } from '../../src/native-bridge';
import { sessionChange } from '../native-change.fixture';

test('shared output views refresh only affected windows and retire revoked or replacement scopes', async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true });
  const keys = [
    'window',
    'document',
    'navigator',
    'HTMLElement',
    'Node',
    'Element',
    'NodeFilter',
    'CustomEvent',
    'MutationObserver',
    'getComputedStyle',
    'IS_REACT_ACT_ENVIRONMENT',
  ] as const;
  const old = keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  for (const key of keys)
    Object.defineProperty(globalThis, key, {
      configurable: true,
      value: key === 'IS_REACT_ACT_ENVIRONMENT' ? true : Reflect.get(dom.window, key),
    });
  const { createRoot } = await import('react-dom/client');
  const { ConversationActivityContext, ConversationTurnElementContext } = await import(
    '@kite-ai/ui/desktop'
  );
  const intersections = new Map<Element, (nearby: boolean) => void>();
  Object.defineProperty(dom.window, 'IntersectionObserver', {
    value: class {
      private notify: (entries: { target: Element; isIntersecting: boolean }[]) => void;
      constructor(notify: (entries: { target: Element; isIntersecting: boolean }[]) => void) {
        this.notify = notify;
      }
      observe(target: Element) {
        const publish = (isIntersecting: boolean) => this.notify([{ target, isIntersecting }]);
        intersections.set(target, publish);
        publish(!target.hasAttribute('data-cold'));
      }
      unobserve(target: Element) {
        intersections.delete(target);
      }
    },
  });
  function Entry({ kind, children }: { kind: 'turn' | 'child' | 'cold'; children: ReactNode }) {
    const ref = useRef<HTMLDivElement>(null);
    return (
      <div ref={ref} {...{ [`data-${kind}`]: '' }}>
        <ConversationTurnElementContext value={ref}>{children}</ConversationTurnElementContext>
      </div>
    );
  }
  const { useNativeOutputFiles } = await import('../../src/native-output-files');
  const root = createRoot(document.getElementById('root')!);
  const versions = new NativeOutputDisplayVersions();
  const calls: NativeRequest[] = [];
  let owner = 'user',
    store = 'store',
    generation = 1,
    available = true,
    childPresent = true,
    fail = false;
  let content = 'old';
  let pendingReplacement: Promise<void> | undefined;
  let freeze = false,
    showCold = true;
  let retainedView: ReactNode;
  const source = {
    sessionId: 'a-child',
    runId: 'child-run',
    parentRunId: 'run',
    carrierExecutionId: 'carrier',
    name: 'child',
  };
  const bridge = {
    watch: () => () => {},
    async request(request: NativeRequest): Promise<NativeResult> {
      calls.push(request);
      if (fail) throw Error('denied');
      if (request.method === 'outputs.sources') {
        const sources = request.scope.sessionId === 'a' && childPresent ? [source] : [];
        versions.sources(request.scope.sessionId, sources);
        return { kind: 'outputs.sources', scope: request.scope, sources };
      }
      if (request.method === 'outputs.query') {
        const name = `${owner}-${request.scope.sessionId}-${content}.txt`;
        if (pendingReplacement) await pendingReplacement;
        return {
          kind: 'outputs.page',
          page: {
            scope: request.scope,
            revision: '1',
            collections: [],
            items: [
              {
                storeId: request.scope.storeId,
                sessionId: request.scope.sessionId,
                ownerRunId: request.runId ?? 'run',
                fileId: 'file',
                locator: { kind: 'delivery', key: 'delivery/1/producer/file' },
                name,
                size: '1',
                mediaType: 'text/plain',
                publishedAt: '2026-11-16T00:00:00Z',
              },
            ],
          },
        };
      }
      return null;
    },
  } as NativeBridge;
  let latest: ReturnType<typeof useNativeOutputFiles>;
  function Harness({
    session,
    revision = 1,
    pending,
  }: {
    session: string;
    revision?: number;
    pending?: string;
  }) {
    const outputs = useNativeOutputFiles({
      bridge,
      generation,
      storeId: pending ? undefined : store,
      sessionId: pending ? undefined : session,
      revision,
      pendingReading: pending ? { storeId: store, sessionId: pending } : undefined,
      display: versions.snapshot(store, owner, session),
      available,
      onEdit: async () => {},
      turnLabel: (id) => id,
    });
    latest = outputs;
    const turn = (sessionId: string, runId: string) =>
      JSON.stringify(['native-run', store, sessionId, runId]);
    const view = (
      <>
        {outputs.references}
        <div className="conversation-viewport">
          <Entry kind="turn">{outputs.renderTurnOutputs({ turnId: turn(session, 'run') })}</Entry>
          <Entry kind="child">
            {outputs.renderChildTurnOutputs('a-child', { turnId: turn('a-child', 'child-run') })}
          </Entry>
          {showCold && (
            <Entry kind="cold">
              {outputs.renderTurnOutputs({ turnId: turn(session, 'cold') })}
            </Entry>
          )}
        </div>
        <output>{JSON.stringify(outputs.request?.target)}</output>
      </>
    );
    if (session === 'a' && !freeze) retainedView = view;
    // The host may restore a covered reading before admitting new reads for that selection.
    return (
      <ConversationActivityContext value={{ readActive: !pending, resume: 0 }}>
        {freeze ? retainedView : view}
      </ConversationActivityContext>
    );
  }
  const render = async (session: string, revision = 1, pending?: string) => {
    await act(async () =>
      root.render(<Harness session={session} revision={revision} pending={pending} />),
    );
  };
  const settle = async () => {
    await act(async () => {
      await Bun.sleep(150);
    });
    await act(async () => {
      await Bun.sleep(150);
    });
  };
  const cards = () => document.querySelectorAll('.output-file-card');
  try {
    await render('a');
    await settle();
    expect(cards()).toHaveLength(3);
    expect(
      calls.filter((r) => r.method === 'outputs.query' && r.scope.sessionId === 'a-child'),
    ).toHaveLength(1);
    const count = calls.length;
    await render('a', 99);
    await settle();
    expect(calls).toHaveLength(count);
    const previousCards = [...cards()];
    versions.changed({ ...sessionChange('a'), type: 'run.started', objectId: 'unrelated-run' });
    await render('a');
    versions.changed({ ...sessionChange('a'), type: 'run.finished', objectId: 'unrelated-run' });
    await render('a');
    expect([...cards()]).toEqual(previousCards);
    expect(calls.slice(count).map((request) => request.method)).toEqual([
      'outputs.query',
      'outputs.query',
    ]);
    expect(
      calls.slice(count).every((request) => request.method === 'outputs.query' && !request.runId),
    ).toBe(true);
    await render('b');
    await settle();
    expect(document.body.textContent).not.toContain('user-a-old.txt');
    const beforeReturn = calls.length;
    freeze = true;
    await render('b', 1, 'a');
    expect(cards()).toHaveLength(3);
    await act(async () =>
      document
        .querySelector<HTMLButtonElement>('[data-turn] [aria-label="预览 user-a-child-old.txt"]')!
        .click(),
    );
    expect(latest!.request).toBeUndefined();
    await settle();
    expect(calls).toHaveLength(beforeReturn);
    freeze = false;
    await render('a');
    expect(cards()).toHaveLength(3);
    expect(document.body.textContent).not.toContain('读取中');
    await settle();
    expect(calls).toHaveLength(beforeReturn);
    await act(async () =>
      document
        .querySelector<HTMLButtonElement>('[data-turn] [aria-label="预览 user-a-child-old.txt"]')!
        .click(),
    );
    expect(latest!.request?.target).toMatchObject({ sessionId: 'a-child', fileId: 'file' });
    // A covered sibling cannot authorize a cold turn, even after history reads resume.
    const coldQueries = () =>
      calls.filter((r) => r.method === 'outputs.query' && r.runId === 'cold');
    expect(coldQueries()).toHaveLength(0);
    await act(async () => intersections.get(document.querySelector('[data-cold]')!)!(true));
    await settle();
    expect(coldQueries()).toHaveLength(1);
    expect(document.querySelector('[data-cold] .output-file-card')).not.toBeNull();
    showCold = false;
    await render('a');
    // SessionPage may retain the original React elements while a new selection is pending.
    // A background Run lifecycle change keeps the authorized old page through the handoff.
    freeze = true;
    await render('b');
    expect(document.body.textContent).toContain('user-a-child-old.txt');
    versions.changed({ ...sessionChange('a-child'), type: 'run.finished', objectId: 'child-run' });
    await render('b');
    expect(cards()).toHaveLength(3);
    expect(document.body.textContent).toContain('user-a-child-old.txt');
    freeze = false;
    await render('a');
    await settle();
    expect(cards()).toHaveLength(3);
    // A late child file refreshes the original window without dropping the primary card.
    await render('b');
    content = 'new';
    versions.changed({
      ...sessionChange('a-child'),
      type: 'extension.record_updated',
      objectId: 'builtin.files/delivery/file',
    });
    const lateDelivery = Promise.withResolvers<void>();
    pendingReplacement = lateDelivery.promise;
    const beforeChildRefresh = calls.length;
    try {
      await render('a');
      expect(document.body.textContent).toContain('user-a-child-old.txt');
      expect(document.body.textContent).toContain('user-a-old.txt');
      expect(calls.slice(beforeChildRefresh)).toEqual([
        expect.objectContaining({ method: 'outputs.query', runId: 'child-run' }),
      ]);
    } finally {
      pendingReplacement = undefined;
      await act(async () => lateDelivery.resolve());
    }
    await settle();
    expect(document.body.textContent).toContain('user-a-child-new.txt');
    expect(document.body.textContent).not.toContain('user-a-child-old.txt');
    expect(document.body.textContent).toContain('user-a-old.txt');
    const obsoleteDelivery = Promise.withResolvers<void>();
    pendingReplacement = obsoleteDelivery.promise;
    const childRun = { ...sessionChange('a-child'), type: 'run.finished', objectId: 'child-run' };
    try {
      content = 'obsolete';
      versions.changed(childRun);
      await render('a');
      expect(document.body.textContent).toContain('user-a-child-new.txt');
      pendingReplacement = undefined;
      content = 'newest';
      versions.changed(childRun);
      await render('a');
      expect(document.body.textContent).toContain('user-a-child-newest.txt');
    } finally {
      pendingReplacement = undefined;
      await act(async () => obsoleteDelivery.resolve());
    }
    expect(document.body.textContent).toContain('user-a-child-newest.txt');
    expect(document.body.textContent).not.toContain('user-a-child-obsolete.txt');
    content = 'new';
    freeze = true;
    await render('b');
    childPresent = false;
    // Main learned the exact source disappeared before the frozen A view was replaced.
    expect(versions.sources('a', [])).toBe(true);
    await render('b');
    expect(cards()).toHaveLength(0);
    freeze = false;
    await render('a');
    expect(document.body.textContent).not.toContain('a-child');
    await settle();
    expect(cards()).toHaveLength(1);
    // Revoked availability removes facts, and unsuccessful re-admission cannot restore them.
    available = false;
    fail = true;
    versions.changed({ ...sessionChange(null), type: 'host_control.changed' });
    await render('a');
    expect(cards()).toHaveLength(0);
    available = true;
    await render('a');
    await settle();
    expect(cards()).toHaveLength(0);
    fail = false;
    versions.reset();
    await render('a');
    await settle();
    expect(cards()).toHaveLength(1);
    const replaceScope = async (replace: () => void) => {
      const outstanding = Promise.withResolvers<void>();
      const beforeReplacement = calls.length;
      pendingReplacement = outstanding.promise;
      try {
        replace();
        await render('a');
        expect(calls.slice(beforeReplacement).some((r) => r.method === 'outputs.query')).toBe(true);
        expect(cards()).toHaveLength(0);
      } finally {
        pendingReplacement = undefined;
        await act(async () => outstanding.resolve());
      }
      expect(document.querySelector('[data-turn] .output-file-card')).not.toBeNull();
    };
    await replaceScope(() => {
      owner = 'other-user';
    });
    expect(document.body.textContent).toContain('other-user-a-new.txt');
    await replaceScope(() => {
      store = 'other-store';
    });
    await replaceScope(() => {
      generation++;
    });
    await replaceScope(() => versions.reset());
    expect(calls.every((r) => r.method === 'outputs.sources' || r.method === 'outputs.query')).toBe(
      true,
    );
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of old) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
}, 10_000);

test('warm file lists hide collection status while Main rechecks child collection admission', async () => {
  const { NativeCaller } = await import('../../electron/native-caller');
  const { backgroundItem } = await import('../background-item.fixture');
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true });
  const keys = [
    'window',
    'document',
    'navigator',
    'HTMLElement',
    'Node',
    'Element',
    'NodeFilter',
    'CustomEvent',
    'MutationObserver',
    'getComputedStyle',
    'IS_REACT_ACT_ENVIRONMENT',
  ] as const;
  const old = keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  for (const key of keys)
    Object.defineProperty(globalThis, key, {
      configurable: true,
      value: key === 'IS_REACT_ACT_ENVIRONMENT' ? true : Reflect.get(dom.window, key),
    });
  const { createRoot } = await import('react-dom/client');
  const { useNativeOutputFiles } = await import('../../src/native-output-files');
  const root = createRoot(document.getElementById('root')!);
  const child = backgroundItem(1, true);
  let revision = '7',
    queries = 0,
    sourceChecks = 0,
    retries = 0;
  const retried: unknown[] = [];
  const connection = {
    serverInfo: { storeId: 'store', subjectId: 'local-user', capabilities: ['output_files'] },
    connect: async () => ({}),
    verifyConnection: async () => ({ dataAvailability: 'available' }),
    async observe({ signal }: { signal: AbortSignal }) {
      await new Promise<void>((resolve) =>
        signal.addEventListener('abort', () => resolve(), { once: true }),
      );
    },
    async getView(id: string) {
      return {
        storeId: 'store',
        snapshotCursor: '0',
        session: { ...child.rootSession, id, rootSessionId: id },
        runs: [],
        executions: [],
        messages: [],
      };
    },
    listWorkspaces: async () => [],
    listAllWorkspaces: async () => [],
    listAllSessions: async () => [],
    listSessions: async () => [],
    disposeNetwork() {},
    async listAllBackgroundExecutions({ rootSessionId }: { rootSessionId: string }) {
      sourceChecks++;
      return rootSessionId === 'root' ? [structuredClone(child)] : [];
    },
    listBackgroundExecutions: async () => ({ items: [structuredClone(child)] }),
    async queryOutputFiles(
      input: Parameters<import('@kite-ai/client').AgentClient['queryOutputFiles']>[0],
    ) {
      queries++;
      const ownerRunId = input.scope.sessionId === 'child' ? 'original-child-run' : 'parent-run';
      return {
        scope: input.scope,
        revision: '1',
        items: [
          {
            storeId: 'store',
            sessionId: input.scope.sessionId,
            ownerRunId,
            fileId: 'file',
            locator: { kind: 'delivery', key: 'delivery/1/producer/file' },
            name: `${input.scope.sessionId}.txt`,
            size: '1',
            mediaType: 'text/plain',
            publishedAt: '2026-11-16T00:00:00Z',
          },
        ],
        collections:
          input.scope.sessionId === 'child'
            ? [
                {
                  collectionId: 'collection',
                  revision,
                  ownerRunId,
                  state: 'failed',
                  expectedCount: 2,
                  publishedCount: 1,
                  errorCode: 'archive_failed',
                  retryUntil: '2099-01-01T00:00:00Z',
                },
              ]
            : [],
      };
    },
    async retryOutputCollection(input: unknown) {
      retried.push(input);
      retries++;
    },
  } as unknown as import('@kite-ai/client').AgentClient;
  const caller = new NativeCaller(connection, () => {});
  const calls: NativeRequest[] = [];
  const bridge = {
    watch: () => () => {},
    async request(request: NativeRequest) {
      calls.push(request);
      return caller.invoke(request);
    },
  } as NativeBridge;
  function Harness() {
    const state = caller.state();
    const outputs = useNativeOutputFiles({
      bridge,
      generation: state.generation,
      storeId: 'store',
      sessionId: state.selection?.session.id,
      revision: state.outputFilesRevision ?? 0,
      display: state.outputFilesDisplay,
      onEdit: async () => {},
      turnLabel: (id) => id,
    });
    return (
      <>
        {outputs.references}
        <section data-turn>
          {outputs.renderTurnOutputs({
            turnId: JSON.stringify([
              'native-run',
              'store',
              state.selection?.session.id,
              'parent-run',
            ]),
          })}
        </section>
      </>
    );
  }
  const render = async () => {
    await act(async () => root.render(<Harness />));
  };
  const settle = async () => {
    await act(async () => {
      await Bun.sleep(150);
    });
    await act(async () => {
      await Bun.sleep(150);
    });
  };
  const select = async (sessionId: string) => {
    await caller.invoke({ method: 'select', generation: 1, sessionId });
    await render();
  };
  const retry = (expectedRevision = '7') =>
    bridge.request({
      method: 'outputs.retry',
      generation: 1,
      scope: { storeId: 'store', sessionId: 'child' },
      collectionId: 'collection',
      expectedRevision,
    });
  const expectFileListsOnly = () => {
    expect(document.querySelectorAll('.output-file-card')).toHaveLength(2);
    expect(document.querySelector('.output-references')?.textContent).toContain('child.txt');
    expect(document.body.textContent).not.toMatch(/读取中|整理|重试/);
    expect(document.querySelector('[role="alert"], [role="status"]')).toBeNull();
  };
  try {
    await caller.invoke({ method: 'attach' });
    await select('root');
    await settle();
    expectFileListsOnly();
    await select('other');
    await settle();
    const warmQueries = queries,
      warmCalls = calls.length;
    await select('root');
    expectFileListsOnly();
    await settle();
    expect(queries).toBe(warmQueries);
    expect(calls).toHaveLength(warmCalls);
    expect(calls.every((r) => r.method === 'outputs.sources' || r.method === 'outputs.query')).toBe(
      true,
    );
    // Exercise the Main contract independently of the display-only lists.
    await retry();
    expect(retries).toBe(1);
    expect(queries).toBe(warmQueries + 1);
    expect(retried).toEqual([
      {
        scope: { storeId: 'store', sessionId: 'child' },
        collectionId: 'collection',
        expectedRevision: '7',
      },
    ]);
    await settle();
    await select('other');
    await select('root');
    // The display is not a mutation credential: a changed revision must be re-read
    // and denied before the write, even if its change event has not arrived yet.
    revision = '8';
    await expect(retry()).rejects.toThrow('output_scope_unavailable');
    expect(queries).toBe(warmQueries + 2);
    expect(retries).toBe(1);
    expectFileListsOnly();
    await select('other');
    await select('root');
    child.childSession!.deletedAt = 42;
    const beforeDeleted = queries;
    const beforeSourceCheck = sourceChecks;
    await expect(retry('8')).rejects.toThrow(/output_(?:scope|source)_unavailable/);
    expect(sourceChecks).toBeGreaterThan(beforeSourceCheck);
    expect(queries).toBe(beforeDeleted);
    expect(retries).toBe(1);
  } finally {
    await act(async () => root.unmount());
    await caller.close();
    dom.window.close();
    for (const [key, descriptor] of old) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
