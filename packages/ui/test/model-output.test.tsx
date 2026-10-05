import { expect, test } from 'bun:test';
import type { Message, ModelOutputSnapshot } from '@kite-ai/client';
import { JSDOM } from 'jsdom';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { ModelOutputMessage, type ModelOutputMessageProps } from '../src';

export function outputFixture(content = 'Full answer tail', complete = true) {
  const contentBytes = String(new TextEncoder().encode(content).length);
  const message: Message = {
    id: 'message',
    sessionId: 'a',
    runId: 'run-a',
    seq: '1',
    role: 'assistant',
    status: complete ? 'complete' : 'incomplete',
    content: 'PREVIEW',
    outputBody: {
      kind: 'model_output',
      executionId: 'model',
      complete,
      contentBytes,
      reasoningBytes: '0',
      toolCallCount: 0,
    },
  };
  const snapshot: ModelOutputSnapshot = {
    storeId: 'store',
    sessionId: 'a',
    rootSessionId: 'a',
    runId: 'run-a',
    executionId: 'model',
    originCommandId: 'command',
    rootWorkCommandId: 'command',
    rootWorkSeq: '1',
    attempt: 1,
    status: complete ? 'succeeded' : 'cancelled',
    bodyHash: 'a'.repeat(64),
    bodyBytes: '1',
    contentBytes,
    reasoningBytes: '0',
    snapshotCursor: '1',
    output: { content, reasoning: '', toolCalls: [], complete },
  };
  return { message, snapshot };
}
test('Fork full reader uses the proved original Session/Run; foreign origin and unsupported content cannot fetch or publish a body', async () => {
  const f = await domFixture(),
    data = outputFixture();
  const message: Message = {
    ...data.message,
    id: 'copied',
    sessionId: 'fork',
    runId: null,
    originMessage: {
      storeId: 'store',
      sessionId: data.message.sessionId,
      messageId: data.message.id,
      runId: data.message.runId,
    },
  };
  const scopes: string[] = [];
  const onRead: NonNullable<ModelOutputMessageProps['onRead']> = async (input) => {
    scopes.push(input.sessionId);
    return data.snapshot;
  };
  try {
    await f.render({ message, storeId: 'store', onRead });
    expect(scopes).toHaveLength(0);
    await f.click('Read complete recorded Model output');
    expect(scopes).toEqual(['a']);
    expect(f.host.querySelector('.message-markdown')!.textContent).toBe(
      data.snapshot.output.content,
    );
    await f.render({
      message: { ...message, originMessage: { ...message.originMessage!, storeId: 'foreign' } },
      storeId: 'store',
      onRead,
    });
    await f.click('Read complete recorded Model output');
    expect(scopes).toEqual(['a']);
    expect(f.host.querySelector('.message-markdown')!.textContent).toBe('PREVIEW');
    await f.render({
      message: {
        ...message,
        outputBody: { ...message.outputBody!, readAvailability: 'unsupported' },
      },
      storeId: 'store',
      onRead,
    });
    expect(
      [...f.host.querySelectorAll('button')].find(
        (button) => button.textContent === 'Read complete recorded Model output',
      )!.disabled,
    ).toBe(true);
    expect(f.host.textContent).toContain('unsupported original content format');
    expect(scopes).toEqual(['a']);
  } finally {
    await f.close();
  }
});
async function domFixture() {
  const dom = new JSDOM('<div id="root"></div>');
  const prior = { window: globalThis.window, document: globalThis.document };
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const host = dom.window.document.getElementById('root')!,
    root = createRoot(host);
  return {
    host,
    render: (props: ModelOutputMessageProps) =>
      act(async () => root.render(<ModelOutputMessage {...props} />)),
    click: async (label: string) =>
      act(async () =>
        [...host.querySelectorAll('button')].find((b) => b.textContent === label)!.click(),
      ),
    close: async () => {
      await act(async () => root.unmount());
      dom.window.close();
      Object.assign(globalThis, prior);
    },
  };
}
test('explicit full reader renders >17MiB exact tail and copies only currently loaded body; close restores labeled preview', async () => {
  const f = await domFixture(),
    data = outputFixture(`${'x'.repeat(17 * 1024 * 1024 + 1)} EXACT TAIL`),
    copies: (string | undefined)[] = [];
  let reads = 0;
  try {
    await f.render({
      message: data.message,
      storeId: 'store',
      onRead: async () => {
        reads++;
        return data.snapshot;
      },
      onContent: (value) => copies.push(value),
    });
    expect(reads).toBe(0);
    expect(f.host.textContent).toContain('full body not loaded');
    await f.click('Read complete recorded Model output');
    expect(reads).toBe(1);
    expect(f.host.querySelector('.message-markdown')!.textContent).toBe(
      data.snapshot.output.content,
    );
    expect(copies.at(-1)).toBe(data.snapshot.output.content);
    await f.click('Close full Model output');
    expect(copies.at(-1)).toBeUndefined();
    expect(f.host.querySelector('.message-markdown')!.textContent).toBe('PREVIEW');
  } finally {
    await f.close();
  }
}, 15000);
test('single-flight close, identity replacement and suspension abort view reads; late body never replaces preview', async () => {
  const f = await domFixture(),
    data = outputFixture();
  let release!: (value: ModelOutputSnapshot) => void,
    signal!: AbortSignal,
    reads = 0;
  const onRead: ModelOutputMessageProps['onRead'] = (input) => {
    reads++;
    signal = input.signal;
    return new Promise((resolve) => (release = resolve));
  };
  try {
    await f.render({ message: data.message, storeId: 'store', onRead });
    await f.click('Read complete recorded Model output');
    await f.click('Read complete recorded Model output');
    expect(reads).toBe(1);
    await f.click('Close full Model output');
    expect(signal.aborted).toBe(true);
    release(data.snapshot);
    await act(async () => await Bun.sleep(1));
    expect(f.host.textContent).not.toContain('Full answer tail');
    await f.click('Read complete recorded Model output');
    await f.render({ message: { ...data.message, id: 'new' }, storeId: 'store', onRead });
    expect(signal.aborted).toBe(true);
    release(data.snapshot);
    await act(async () => await Bun.sleep(1));
    expect(f.host.textContent).not.toContain('Full answer tail');
    await f.click('Read complete recorded Model output');
    await f.render({
      message: { ...data.message, id: 'new' },
      storeId: 'store',
      onRead,
      suspended: true,
    });
    expect(signal.aborted).toBe(true);
    release(data.snapshot);
  } finally {
    await f.close();
  }
});
test('missing capability keeps preview; wrong identity fails without full body; incomplete prefix never exposes complete calls', async () => {
  const f = await domFixture(),
    data = outputFixture('PREFIX', false);
  try {
    await f.render({ message: data.message, storeId: 'store' });
    expect(f.host.querySelector('button')!.disabled).toBe(true);
    await f.render({
      message: data.message,
      storeId: 'store',
      onRead: async () => ({ ...data.snapshot, storeId: 'foreign' }),
    });
    await f.click('Read complete recorded Model output');
    expect(f.host.querySelector('[role=alert]')!.textContent).toContain('identity_conflict');
    expect(f.host.querySelector('.message-markdown')!.textContent).toBe('PREVIEW');
    await f.render({ message: data.message, storeId: 'store', onRead: async () => data.snapshot });
    await f.click('Read complete recorded Model output');
    expect(f.host.textContent).toContain('Complete recorded incomplete prefix');
    expect(f.host.querySelector('.message-markdown')!.textContent).toBe('PREFIX');
    expect(f.host.querySelector('details')).toBeNull();
  } finally {
    await f.close();
  }
});

test('ordinary conversation excludes raw reasoning; only explicit diagnostic host exposes its collapsed details', async () => {
  const f = await domFixture(),
    data = outputFixture();
  data.message.outputBody!.reasoningBytes = '16';
  data.snapshot.reasoningBytes = '16';
  data.snapshot.output.reasoning = 'PRIVATE THOUGHTS';
  const props = { message: data.message, storeId: 'store', onRead: async () => data.snapshot };
  try {
    await f.render(props);
    await f.click('Read complete recorded Model output');
    expect(f.host.textContent).not.toContain('PRIVATE THOUGHTS');
    expect(f.host.querySelector('details')).toBeNull();
    await f.render({ ...props, showReasoning: true });
    expect(f.host.querySelector('details')!.open).toBe(false);
    expect(f.host.querySelector('details pre')!.textContent).toBe('PRIVATE THOUGHTS');
  } finally {
    await f.close();
  }
});
