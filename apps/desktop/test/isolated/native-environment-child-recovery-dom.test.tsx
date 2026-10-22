import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { JSDOM } from 'jsdom';
import { act, useLayoutEffect } from 'react';
import { createRoot } from 'react-dom/client';
import type { NativeBridge, NativeSelection } from '../../src/native-bridge';
import { NativeChildDetail } from '../../src/native-child-detail';
import { useNativeEnvironment } from '../../src/native-environment';
import { backgroundItem } from '../background-item.fixture';
import { prepareDesktopDom } from '../native-page-dom.fixture';

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

test('automatic child retries retain verified messages through repeated child and directory failures', async () => {
  const dom = new JSDOM('<div id="root"/>', { pretendToBeVisual: true });
  const restoreLayout = prepareDesktopDom(dom);
  const frames: string[] = [];
  let sawTranscript = false;
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
    upperSeq: '1',
    messages: [
      {
        id: 'child-message',
        sessionId: 'child',
        seq: '1',
        role: 'assistant',
        status: 'incomplete',
        runId: item.childRun!.id,
        content: 'Saved child progress',
      },
    ],
    modelOutputs: [],
    presentation: { runs: [], tools: [], executions: [] },
  };
  const bytes = Buffer.from(JSON.stringify(facts));
  let opens = 0;
  let revision = 1;
  let directoryFail = false;
  let childFail = false;
  let directoryReads = 0;
  const bridge: NativeBridge = {
    watch: () => () => {},
    async request(request) {
      if (request.method === 'background.open') {
        directoryReads++;
        if (directoryFail) throw Error('directory_offline');
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
      }
      if (request.method === 'background.child.open') {
        opens++;
        if (childFail) throw Error('fixture_child_read_failed');

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
      revision,
      unavailable: false,
      onChanged: async () => {},
    });
    useLayoutEffect(() => {
      const text = dom.window.document.body.textContent ?? '';
      if (text.includes('Saved child progress')) sawTranscript = true;
      if (sawTranscript) frames.push(text);
    });
    return (
      <NativeChildDetail
        child={environment.child}
        generation={1}
        storeId="store"
        sessionId="child"
        executionId={item.execution.id}
        readActive
        onRefresh={() => environment.openChild('child', item.execution.id)}
        onTitleChange={() => {}}
      />
    );
  }
  const wait = async (milliseconds: number) =>
    act(async () => {
      await new Promise((resolve) => setTimeout(resolve, milliseconds));
    });
  try {
    await act(async () => root.render(<Harness />));
    await act(async () => environment.openChild('child', item.execution.id));
    await wait(30);
    expect(environment.child?.facts?.messages[0]?.content).toBe('Saved child progress');
    expect(environment.child?.facts?.session.id).toBe('child');
    childFail = true;
    revision++;
    await act(async () => root.render(<Harness />));
    expect(environment.child?.error).toBe('fixture_child_read_failed');
    expect(environment.child?.facts?.session.id).toBe('child');
    directoryFail = true;
    revision++;
    await act(async () => root.render(<Harness />));
    expect(environment.child?.facts?.session.id).toBe('child');
    await wait(400);
    expect(environment.child?.facts?.messages[0]?.content).toBe('Saved child progress');
    expect(environment.child?.error).toBe('background_child_unavailable');
    const reads = directoryReads;
    await wait(1200);
    expect(directoryReads).toBeGreaterThan(reads);
    expect(environment.child?.facts?.messages[0]?.content).toBe('Saved child progress');
    directoryFail = false;
    childFail = false;
    const deadline = Date.now() + 5000;
    while (environment.child?.error && Date.now() < deadline) await wait(25);
    expect(environment.child?.error).toBeUndefined();
    expect(environment.child?.loading).toBe(false);
    expect(environment.child?.facts?.messages[0]?.content).toBe('Saved child progress');
    expect(opens).toBeGreaterThan(2);
    expect(frames.length).toBeGreaterThan(5);
    expect(frames.every((text) => text.includes('Saved child progress'))).toBe(true);
    expect(dom.window.document.body.textContent).toContain('Saved child progress');
  } finally {
    await act(async () => root.unmount());
    restoreLayout();
    dom.window.close();
    for (const [key, descriptor] of prior) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
}, 10000);
