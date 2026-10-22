import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { JSDOM } from 'jsdom';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { NativeBridge, NativeSelection } from '../../src/native-bridge';
import { useNativeEnvironment } from '../../src/native-environment';
import { backgroundItem } from '../background-item.fixture';

test('a failed child read recovers without cancelling a slow retry at the next backoff tick', async () => {
  const dom = new JSDOM('<div id="root"/>', { pretendToBeVisual: true });
  const keys = ['window', 'document', 'IS_REACT_ACT_ENVIRONMENT'] as const;
  const prior = keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const root = createRoot(dom.window.document.getElementById('root')!);
  const item = backgroundItem(1, true);
  const facts = {
    item,
    session: item.childSession,
    upperSeq: '0',
    messages: [],
    modelOutputs: [],
    presentation: { runs: [], tools: [], executions: [] },
  };
  const bytes = Buffer.from(JSON.stringify(facts));
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let opens = 0;
  const closed: string[] = [];
  let retriedReadId = '';
  const bridge: NativeBridge = {
    watch: () => () => {},
    async request(request) {
      if (request.method === 'background.open')
        return {
          kind: 'background.page',
          viewGeneration: 1,
          viewSelection: 1,
          rootSessionId: 'root',
          storeId: 'store',
          readId: request.readId,
          observationId: 1,
          startIndex: 0,
          nextIndex: 1,
          total: 1,
          complete: true,
          entries: [item],
        };
      if (request.method === 'background.child.open') {
        opens++;
        if (opens === 1) throw Error('fixture_child_read_failed');
        retriedReadId = request.readId;
        await held;
        return {
          kind: 'background.child.opened',
          viewGeneration: 1,
          rootSessionId: 'root',
          viewSelection: 1,
          storeId: 'store',
          observationId: 1,
          readId: request.readId,
          executionId: item.execution.id,
          childSessionId: item.childSession!.id,
          childRunId: item.childRun!.id,
          wireBytes: String(bytes.length),
          wireHash: createHash('sha256').update(bytes).digest('hex'),
        };
      }
      if (request.method === 'background.child.read') {
        const chunk = bytes.subarray(request.offset, request.offset + request.limit);
        const nextOffset = request.offset + chunk.length;
        return {
          kind: 'background.child.chunk',
          readId: request.readId,
          offset: request.offset,
          nextOffset,
          eof: nextOffset === bytes.length,
          data: chunk.toString('base64'),
        };
      }
      if (request.method === 'background.child.close') closed.push(request.readId);
      return null;
    },
  };
  let environment!: ReturnType<typeof useNativeEnvironment>;
  function Harness() {
    environment = useNativeEnvironment({
      bridge,
      generation: 1,
      selection: {
        viewGeneration: 1,
        viewSelection: 1,
        storeId: 'store',
        session: item.rootSession,
        runs: [],
        executions: [],
        interactions: [],
        interactionsAfterId: null,
      } as unknown as NativeSelection,
      revision: 1,
      unavailable: false,
      onChanged: async () => {},
    });
    return environment.card;
  }
  const wait = async (milliseconds: number) =>
    act(async () => {
      await new Promise((resolve) => setTimeout(resolve, milliseconds));
    });
  try {
    await act(async () => root.render(<Harness />));
    await act(async () => environment.openChild('child', item.execution.id));
    expect(environment.child?.error).toBe('fixture_child_read_failed');
    const deadline = Date.now() + 3000;
    while (opens < 2 && Date.now() < deadline) await wait(25);
    expect(opens).toBe(2);
    expect(environment.child?.loading).toBe(true);
    // The next timer fires after 1000 ms while the exact retry is still held.
    await wait(1250);
    expect(opens).toBe(2);
    expect(closed).not.toContain(retriedReadId);
    await act(async () => release());
    await wait(20);
    expect(environment.child?.loading).toBe(false);
    expect(environment.child?.error).toBeUndefined();
    expect(environment.child?.facts?.session.id).toBe('child');
    await wait(1100);
    expect(opens).toBe(2);
    expect(dom.window.document.body.textContent).not.toContain('fixture_child_read_failed');
  } finally {
    release();
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of prior) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
