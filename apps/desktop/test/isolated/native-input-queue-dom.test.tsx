import { expect, test } from 'bun:test';
import { JSDOM } from 'jsdom';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type {
  NativeInputQueueObservation,
  NativeInputQueueSubmission,
} from '../../src/input-queue-bridge';
import type { NativeBridge, NativeSelection } from '../../src/native-bridge';
import { useNativeInputQueue } from '../../src/native-input-queue';
import { backgroundItem } from '../background-item.fixture';
import { prepareDesktopDom } from '../native-page-dom.fixture';

const selection = (id = 'root'): NativeSelection => ({
  storeId: 'store',
  viewGeneration: 1,
  viewSelection: 1,
  session: { ...backgroundItem(1, true).rootSession, id },
  runs: [],
  executions: [],
  interactions: [],
  interactionsAfterId: null,
  canReadModelOutput: false,
  canReadInputQueue: true,
});
const metadata = (
  phase: NativeInputQueueSubmission['phase'],
  text?: string,
): NativeInputQueueSubmission => ({
  kind: 'input.queue.submission',
  scope: { storeId: 'store', sessionId: 'root', workspaceId: selection().session.workspaceId },
  commandId: 'original-withdraw',
  operation: 'edit',
  targetCommandId: 'a',
  phase,
  ...(text === undefined ? {} : { text }),
});

async function fixture(handler: NativeBridge['request']) {
  const dom = new JSDOM('<div id="root"></div>', {
    url: 'http://localhost',
    pretendToBeVisual: true,
  });
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    navigator: globalThis.navigator,
  };
  const restore = prepareDesktopDom(dom);
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const host = dom.window.document.getElementById('root')!,
    root = createRoot(host);
  const bridge = { request: handler } as NativeBridge;
  let current: ReturnType<typeof useNativeInputQueue>;
  const texts: string[] = [];
  function Harness({ selected, available }: { selected: NativeSelection; available: boolean }) {
    current = useNativeInputQueue({
      bridge,
      generation: 1,
      selection: selected,
      historyEpoch: 0,
      available,
      onEditText: (text) => {
        texts.push(text);
        return true;
      },
    });
    return (
      <div>
        {current.queue?.items.map((item) => (
          <span key={item.id}>{item.text}</span>
        ))}
        {current.error}
      </div>
    );
  }
  return {
    host,
    texts,
    get state() {
      return current!;
    },
    async render(selected = selection(), available = true) {
      await act(async () => root.render(<Harness selected={selected} available={available} />));
    },
    async close() {
      await act(async () => root.unmount());
      dom.window.close();
      restore();
      Object.assign(globalThis, previous);
    },
  };
}
const observed = (
  request: { readId: string; generation: number; viewSelection: number; historyEpoch: number },
  sessionId = 'root',
  entries = [{ id: 'a', text: '**原始**\n\n```sh\necho 雪🙂\n```', editable: true }],
  submissions: NativeInputQueueSubmission[] = [],
): NativeInputQueueObservation => ({
  kind: 'input.queue.observation',
  scope: {
    generation: request.generation,
    viewSelection: request.viewSelection,
    historyEpoch: request.historyEpoch,
    storeId: 'store',
    sessionId,
    workspaceId: selection().session.workspaceId,
  },
  readId: request.readId,
  observationId: 7,
  revision: 'a'.repeat(64),
  entries,
  submissions,
});

test('edit waits for exact withdrawal, fills the complete original once and never submits a replacement', async () => {
  const calls: string[] = [];
  let resolve!: (result: NativeInputQueueSubmission) => void;
  let removed = false;
  const text = '**原始**\n\n```sh\necho 雪🙂\n```';
  const f = await fixture(async (request) => {
    calls.push(request.method);
    if (request.method === 'input.queue.read')
      return observed(request, 'root', removed ? [] : undefined);
    if (request.method === 'input.queue.withdraw') {
      expect(request).toEqual({
        method: 'input.queue.withdraw',
        generation: 1,
        observationId: 7,
        targetCommandId: 'a',
        purpose: 'edit',
      });
      return new Promise((done) => {
        resolve = done;
      });
    }
    return null;
  });
  try {
    await f.render();
    let operation!: Promise<void>;
    await act(async () => {
      operation = Promise.resolve(f.state.queue!.onEdit('a'));
    });
    expect(f.texts).toEqual([]);
    expect(f.state.busy).toBe(true);
    await act(async () => {
      removed = true;
      resolve(metadata('applied', text));
      await operation;
    });
    expect(f.texts).toEqual([text]);
    expect(f.state.queue!.items).toEqual([]);
    expect(calls.filter((method) => method === 'input.queue.withdraw')).toHaveLength(1);
    expect(calls.filter((method) => method === 'input.queue.ack')).toHaveLength(1);
    expect(
      calls.some((method) => ['submit', 'cancelInput', 'conversation.send'].includes(method)),
    ).toBe(false);
  } finally {
    await f.close();
  }
});

test('a late original-session edit never fills or exposes entries in a replacement Session', async () => {
  let resolve!: (result: NativeInputQueueSubmission) => void;
  let reads = 0;
  const calls: string[] = [];
  const f = await fixture(async (request) => {
    calls.push(request.method);
    if (request.method === 'input.queue.read') {
      reads++;
      return observed(request, reads === 1 ? 'root' : 'other', [
        {
          id: reads === 1 ? 'a' : 'b',
          text: reads === 1 ? 'old draft' : 'new queue',
          editable: true,
        },
      ]);
    }
    if (request.method === 'input.queue.withdraw')
      return new Promise((done) => {
        resolve = done;
      });
    return null;
  });
  try {
    await f.render();
    let operation!: Promise<void>;
    await act(async () => {
      operation = Promise.resolve(f.state.queue!.onEdit('a'));
    });
    await f.render(selection('other'));
    expect(f.host.textContent).toBe('new queue');
    await act(async () => {
      resolve(metadata('applied', 'old draft'));
      await operation;
    });
    expect(f.texts).toEqual([]);
    expect(calls).not.toContain('input.queue.ack');
    expect(f.host.textContent).toBe('new queue');
  } finally {
    await f.close();
  }
});

test('lost withdrawal reply recovers its original ID, lookup fills once and a lost ack is retried without replay', async () => {
  let applied = false,
    acked = false,
    ackCount = 0;
  const calls: { method: string; commandId?: string }[] = [];
  const f = await fixture(async (request) => {
    calls.push({
      method: request.method,
      ...('commandId' in request ? { commandId: request.commandId } : {}),
    });
    if (request.method === 'input.queue.read')
      return observed(
        request,
        'root',
        applied ? [] : undefined,
        applied && !acked ? [metadata('applied')] : [],
      );
    if (request.method === 'input.queue.withdraw') {
      applied = true;
      throw Error('ipc_reply_lost');
    }
    if (request.method === 'input.queue.lookup') {
      expect(request.commandId).toBe('original-withdraw');
      return metadata('applied', '完整 **原文**');
    }
    if (request.method === 'input.queue.ack') {
      if (++ackCount === 1) throw Error('ack_reply_lost');
      acked = true;
    }
    return null;
  });
  try {
    await f.render();
    await act(async () => {
      await f.state.queue!.onEdit('a');
    });
    expect(f.texts).toEqual([]);
    expect(f.state.submissions.map((item) => item.commandId)).toEqual(['original-withdraw']);
    await act(async () => {
      await f.state.lookup('original-withdraw');
    });
    expect(f.texts).toEqual(['完整 **原文**']);
    await act(async () => {
      await f.state.lookup('original-withdraw');
    });
    expect(f.texts).toEqual(['完整 **原文**']);
    expect(ackCount).toBe(2);
    expect(calls.filter((call) => call.method === 'input.queue.withdraw')).toHaveLength(1);
    expect(f.state.submissions).toEqual([]);
  } finally {
    await f.close();
  }
});

test('foreign observations and a consumed-target rejection never grant editor content', async () => {
  let foreign = true;
  const f = await fixture(async (request) => {
    if (request.method === 'input.queue.read')
      return observed(request, foreign ? 'foreign' : 'root');
    if (request.method === 'input.queue.withdraw') return metadata('rejected');
    return null;
  });
  try {
    await f.render();
    expect(f.state.queue).toBeUndefined();
    expect(f.state.error).toContain('无法核对');
    foreign = false;
    await act(async () => f.state.retry());
    await act(async () => {
      await f.state.queue!.onEdit('a');
    });
    expect(f.texts).toEqual([]);
    await f.render({ ...selection(), canReadInputQueue: false });
    expect(f.state.queue?.disabled).toBe(true);
  } finally {
    await f.close();
  }
});

test('ordinary same-scope refresh retains queue DOM while revoking mutations, and a new scope drops it', async () => {
  const writes: string[] = [];
  const f = await fixture(async (request) => {
    if (request.method === 'input.queue.read') return observed(request);
    if (request.method === 'input.queue.withdraw') writes.push(request.method);
    return null;
  });
  try {
    await f.render();
    const original = f.host.querySelector('span');
    expect(original?.textContent).toContain('原始');
    await f.render(selection(), false);
    expect(f.host.querySelector('span')).toBe(original);
    expect(f.state.queue?.disabled).toBe(true);
    await act(async () => {
      await f.state.queue?.onEdit('a');
    });
    expect(writes).toEqual([]);
    await f.render(selection());
    expect(f.host.querySelector('span')).toBe(original);
    expect(f.state.queue?.disabled).toBe(false);
    await f.render(selection('other'), false);
    expect(f.host.querySelector('span')).toBeNull();
    expect(f.state.queue).toBeUndefined();
  } finally {
    await f.close();
  }
});
