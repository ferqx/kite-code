import { expect, test } from 'bun:test';
import { ClientError, type SessionLogEntry, type SessionLogPage } from '@kite-ai/client';
import type { BrowserClient } from '@kite-ai/client/browser';
import { JSDOM } from 'jsdom';
import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { type ModelInputPort, ModelInputs } from '../src/model-input';
import { WebPage } from '../src/page';
import { type RuntimeLogPort, RuntimeLogs } from '../src/runtime-logs';

function entry(cursor: string, model = false): SessionLogEntry {
  return {
    cursor,
    sessionId: 's',
    objectId: 'e',
    type: model ? 'model.invocation_prepared' : 'execution.changed',
    revision: '1',
    occurredAt: null,
    category: 'execution',
    recordedStatus: null,
    summary: 'Actual metadata',
    details: model ? { kind: 'model', executionId: 'model-original' } : {},
    modelExecutionId: model ? 'model-original' : null,
  };
}
function page(entries = [entry('1')], next: string | null = null): SessionLogPage {
  return {
    storeId: 'store',
    sessionId: 's',
    upperCursor: '3',
    snapshotCursor: '3',
    replayFloor: '0',
    entries,
    nextAfterCursor: next,
    complete: next === null,
  };
}
type Query = Parameters<NonNullable<RuntimeLogPort['listSessionLogs']>>[1];
async function fixture(
  read: (session: string, query: Query) => Promise<SessionLogPage>,
  fullPage = false,
) {
  const dom = new JSDOM('<div id="root"></div>', {
    url: fullPage ? 'http://localhost/sessions/s' : 'http://localhost',
    pretendToBeVisual: true,
  });
  const previous = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const calls: { session: string; query: Query }[] = [];
  const modelReads: [string, string][] = [];
  const client: RuntimeLogPort & ModelInputPort = {
    serverInfo: {
      storeId: 'store',
      dataAvailability: 'available',
      capabilities: ['session_logs', 'model_inputs'],
    },
    async listSessionLogs(session, query) {
      calls.push({ session, query });
      return read(session, query);
    },
    async listModelInputs() {
      throw new ClientError('unexpected_directory_read');
    },
    async getModelInput(session, execution) {
      modelReads.push([session, execution]);
      throw new ClientError('original_body_unavailable');
    },
  };
  const businessReads: string[] = [];
  function session(id: string) {
    return {
      id,
      workspaceId: 'w',
      parentSessionId: null,
      title: `Session ${id}`,
      controlRevision: '1',
      contextSelectionId: 'selection',
      nextSeq: '1',
      deletedAt: null,
    };
  }
  Object.assign(client, {
    async listAllWorkspaces() {
      return [{ id: 'w', name: 'Workspace' }];
    },
    async listAllSessions() {
      return [session('s'), session('next')];
    },
    async getView(id: string) {
      businessReads.push(`view:${id}`);
      return {
        storeId: 'store',
        snapshotCursor: '1',
        session: session(id),
        runs: [],
        executions: [],
        messages: [],
      };
    },
    async listMessages(id: string) {
      businessReads.push(`messages:${id}`);
      return [
        {
          id: `message-${id}`,
          sessionId: id,
          runId: 'r',
          seq: '1',
          status: 'complete',
          role: 'user',
          content: `Original ${id} body`,
        },
      ];
    },
  });
  function Panel({ session, suspended }: { session: string; suspended: boolean }) {
    const [target, setTarget] = useState<string>();
    return (
      <>
        <RuntimeLogs
          client={client}
          storeId="store"
          sessionId={session}
          window={dom.window as unknown as Window}
          suspended={suspended}
          onModel={setTarget}
        />
        <ModelInputs
          client={client}
          storeId="store"
          sessionId={session}
          window={dom.window as unknown as Window}
          suspended={suspended}
          initialExecutionId={target}
        />
      </>
    );
  }
  const root = createRoot(dom.window.document.getElementById('root')!);
  async function render(session = 's', suspended = false) {
    await act(async () => {
      root.render(
        fullPage ? (
          <WebPage
            client={client as unknown as BrowserClient}
            window={dom.window as unknown as Window}
            suspended={suspended}
          />
        ) : (
          <Panel key={session} session={session} suspended={suspended} />
        ),
      );
      await Bun.sleep(0);
    });
  }
  await render();
  const document = dom.window.document;
  const text = () => document.body.textContent!;
  const button = (label: string) =>
    Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find(
      (b) => b.textContent === label,
    )!;
  async function click(label: string) {
    await act(async () => {
      button(label).click();
      await Bun.sleep(0);
    });
  }
  async function visible(value: 'hidden' | 'visible') {
    await act(async () => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, value });
      document.dispatchEvent(new dom.window.Event('visibilitychange'));
    });
  }
  return {
    calls,
    businessReads,
    modelReads,
    client,
    render,
    document,
    text,
    button,
    click,
    visible,
    async close() {
      await act(async () => root.unmount());
      dom.window.close();
      for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}

test('logs open on demand, freeze upper across explicit pages, preserve null metadata and refresh failure', async () => {
  let count = 0;
  const f = await fixture(async () => {
    count++;
    if (count === 1) return page([entry('1')], '1');
    if (count === 2) return page([entry('3')]);
    throw new ClientError('cursor_expired');
  });
  try {
    expect(f.calls).toHaveLength(0);
    await f.click('Runtime logs');
    expect(f.calls[0]!.query.afterCursor).toBe('0');
    expect(f.calls[0]!.query.upperCursor).toBeUndefined();
    expect(f.text()).toContain('Time unknown');
    expect(f.text()).toContain('Status unknown');
    await f.click('Load more logs');
    expect(f.calls[1]!.query.afterCursor).toBe('1');
    expect(f.calls[1]!.query.upperCursor).toBe('3');
    expect(f.document.querySelectorAll('details')).toHaveLength(2);
    await f.click('Refresh Runtime logs');
    expect(f.text()).toContain('Stale · Last read logs · cursor_expired');
    expect(f.document.querySelectorAll('details')).toHaveLength(2);
    expect(f.calls).toHaveLength(3);
    expect(f.modelReads).toHaveLength(0);
  } finally {
    await f.close();
  }
});

test('scope, duplicate cursor, changed upper and non-progressing page fail without publishing partial logs', async () => {
  for (const bad of [
    { ...page(), storeId: 'other' },
    { ...page(), sessionId: 'other' },
    page([entry('1'), entry('1')]),
    { ...page(), replayFloor: '1' },
    page([], '1'),
    { ...page([entry('1')], '1'), complete: true },
    page([{ ...entry('1'), details: { payload: 'private' } } as unknown as SessionLogEntry]),
    page([{ ...entry('1', true), details: { executionId: 'different' } }]),
  ]) {
    const f = await fixture(async () => bad);
    try {
      await f.click('Runtime logs');
      expect(f.text()).toContain('session_logs_page_conflict');
      expect(f.document.querySelectorAll('details')).toHaveLength(0);
      expect(f.modelReads).toHaveLength(0);
    } finally {
      await f.close();
    }
  }
  let count = 0;
  const f = await fixture(async () =>
    ++count === 1
      ? page([entry('1')], '1')
      : { ...page([entry('2')]), upperCursor: '4', snapshotCursor: '4' },
  );
  try {
    await f.click('Runtime logs');
    await f.click('Load more logs');
    expect(f.text()).toContain('Stale');
    expect(f.document.querySelectorAll('details')).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test('cancel, close, hidden, suspended and changed Session abort original read and ignore late responses', async () => {
  for (const action of ['cancel', 'close', 'hidden', 'suspended', 'session']) {
    let resolve!: (page: SessionLogPage) => void;
    const f = await fixture(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    try {
      await f.click('Runtime logs');
      const signal = f.calls[0]!.query.signal!;
      if (action === 'cancel') await f.click('Cancel log read');
      if (action === 'close') await f.click('Close Runtime logs');
      if (action === 'hidden') await f.visible('hidden');
      if (action === 'suspended') await f.render('s', true);
      if (action === 'session') await f.render('next');
      expect(signal.aborted).toBe(true);
      await act(async () => {
        resolve(page([entry('1', true)]));
        await Bun.sleep(0);
      });
      expect(f.text()).not.toContain('Actual metadata');
      expect(f.modelReads).toHaveLength(0);
      if (action === 'hidden') {
        await f.visible('visible');
        expect(f.calls).toHaveLength(1);
      }
    } finally {
      await f.close();
    }
  }
});

test('accurate Model log target opens existing second confirmation without reading body or guessing from summary', async () => {
  const f = await fixture(async () => page([entry('1'), entry('2', true)]));
  try {
    await f.click('Runtime logs');
    expect(f.modelReads).toHaveLength(0);
    expect(
      Array.from(f.document.querySelectorAll('button')).filter((b) =>
        b.textContent?.startsWith('Inspect Model'),
      ),
    ).toHaveLength(1);
    await f.click('Inspect Model model-original');
    expect(f.text()).toContain('Read the complete sensitive input of model-original?');
    expect(f.modelReads).toHaveLength(0);
    await f.click('Confirm read original input');
    expect(f.modelReads).toEqual([['s', 'model-original']]);
    expect(f.text()).toContain('original_body_unavailable');
  } finally {
    await f.close();
  }
});

test('bounded metadata cache stops at 1000 entries and oversized page is never published', async () => {
  let count = 0;
  const f = await fixture(async () => {
    const start = count++ * 200;
    return {
      ...page(
        Array.from({ length: 200 }, (_, i) => entry(String(start + i + 1))),
        String(start + 200),
      ),
      upperCursor: '2000',
      snapshotCursor: '2000',
    };
  });
  try {
    await f.click('Runtime logs');
    for (let i = 0; i < 4; i++) await f.click('Load more logs');
    expect(f.document.querySelectorAll('details')).toHaveLength(1000);
    expect(f.button('Load more logs').disabled).toBe(true);
    expect(f.text()).toContain('Local cache limit reached');
    expect(f.calls).toHaveLength(5);
  } finally {
    await f.close();
  }
  const large = await fixture(async () =>
    page([{ ...entry('1'), summary: 'x'.repeat(512 * 1024) }]),
  );
  try {
    await large.click('Runtime logs');
    expect(large.text()).toContain('session_logs_page_budget_exceeded');
    expect(large.document.querySelectorAll('details')).toHaveLength(0);
  } finally {
    await large.close();
  }
});

test('cumulative UTF-8 metadata budget preserves prior complete pages and stops further reads', async () => {
  let count = 0;
  const f = await fixture(async () => {
    const id = String(++count);
    return {
      ...page([{ ...entry(id), summary: '文'.repeat(150 * 1024) }], id),
      upperCursor: '10',
      snapshotCursor: '10',
    };
  });
  try {
    await f.click('Runtime logs');
    for (let i = 0; i < 4; i++) await f.click('Load more logs');
    expect(f.document.querySelectorAll('details')).toHaveLength(4);
    expect(f.text()).toContain('session_logs_cache_limit');
    expect(f.button('Load more logs').disabled).toBe(true);
    expect(f.calls).toHaveLength(5);
  } finally {
    await f.close();
  }
});

test('actual Page wires log target to Model confirmation while directory, History and selected Session remain bound', async () => {
  const f = await fixture(async () => page([entry('1', true)]), true);
  try {
    expect(f.text()).toContain('Original s body');
    const reads = [...f.businessReads];
    await f.click('Runtime logs');
    await f.click('Inspect Model model-original');
    expect(f.text()).toContain('complete sensitive input of model-original');
    expect(f.modelReads).toHaveLength(0);
    await f.click('Close directory');
    await f.click('Open directory');
    expect(f.text()).toContain('Original s body');
    expect(f.businessReads).toEqual(reads);
    await f.click('Confirm read original input');
    expect(f.modelReads).toEqual([['s', 'model-original']]);
    await f.click('Workspace');
    async function select(id: string) {
      await act(async () => {
        f.document.querySelector<HTMLAnchorElement>(`a[href="/sessions/${id}"]`)!.click();
        await Bun.sleep(0);
      });
    }
    await select('next');
    expect(f.text()).toContain('Original next body');
    expect(f.text()).not.toContain('complete sensitive input');
    await select('s');
    expect(f.text()).toContain('Original s body');
    expect(f.text()).not.toContain('complete sensitive input');
    expect(f.calls).toHaveLength(1);
    expect(f.modelReads).toHaveLength(1);
  } finally {
    await f.close();
  }
});
