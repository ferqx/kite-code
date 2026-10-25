import { expect, test } from 'bun:test';
import { ClientError, type Message, type ModelOutputSnapshot } from '@kite-ai/client';
import { JSDOM } from 'jsdom';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import {
  ModelOutputMessage,
  type ModelOutputMessageProps,
  modelOutputTerminalObserved,
} from '../src';
import { useConversationReadActive } from '../src/conversation-activity';
import { ConversationCache } from '../src/desktop/ConversationCache';

function CachedOutput(props: ModelOutputMessageProps) {
  const readActive = useConversationReadActive();
  return <ModelOutputMessage {...props} readActive={readActive} />;
}

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
test('terminal read hints require the original Model or owning Run, never absence or another source', () => {
  const { message } = outputFixture('partial', false);
  const execution = {
    id: 'model',
    sessionId: 'a',
    runId: 'run-a',
    kind: 'model' as const,
    status: 'cancelled' as const,
  };
  const run = { id: 'run-a', sessionId: 'a', status: 'cancelled' as const };
  expect(modelOutputTerminalObserved(message, [], [])).toBe(false);
  expect(modelOutputTerminalObserved(message, [execution], [])).toBe(true);
  expect(modelOutputTerminalObserved(message, [], [run])).toBe(true);
  for (const changed of [
    { id: 'foreign' },
    { sessionId: 'foreign' },
    { runId: 'foreign' },
    { kind: 'tool' as const },
    { status: 'running' as const },
  ])
    expect(modelOutputTerminalObserved(message, [{ ...execution, ...changed }], [])).toBe(false);
  for (const changed of [
    { id: 'foreign' },
    { sessionId: 'foreign' },
    { status: 'cancelling' as const },
  ])
    expect(modelOutputTerminalObserved(message, [], [{ ...run, ...changed }])).toBe(false);
  const fork = {
    ...message,
    sessionId: 'fork',
    runId: 'fork-run',
    originMessage: {
      storeId: 'store',
      sessionId: 'a',
      runId: 'run-a',
      messageId: 'source',
    },
  };
  expect(modelOutputTerminalObserved(fork, [execution], [])).toBe(true);
  expect(
    modelOutputTerminalObserved(fork, [], [{ ...run, id: 'fork-run', sessionId: 'fork' }]),
  ).toBe(false);
  expect(
    modelOutputTerminalObserved(
      { ...fork, originMessage: { ...fork.originMessage, runId: null } },
      [execution],
      [run],
    ),
  ).toBe(false);
  expect(modelOutputTerminalObserved(outputFixture().message, [execution], [run])).toBe(false);
});
test('host verified snapshots render immediately, suspend safely, and reject mismatched bodies', async () => {
  const f = await domFixture(),
    data = outputFixture('Verified child tail🙂');
  const content: (string | undefined)[] = [];
  const props = {
    message: data.message,
    storeId: 'store',
    verifiedSnapshot: data.snapshot,
    onContent: (text: string | undefined) => content.push(text),
  };
  try {
    await f.render(props);
    expect(f.host.querySelector('.message-markdown')!.textContent).toBe('Verified child tail🙂');
    expect(f.host.querySelector('.model-output-message > p')!.textContent).toBe('完整回复');
    expect(f.host.textContent).not.toContain('Model output');
    expect(f.host.textContent).not.toContain('查看完整回复');
    expect(content.at(-1)).toBe('Verified child tail🙂');
    await f.render({ ...props, suspended: true });
    expect(f.host.querySelector('.message-markdown')!.textContent).toBe('PREVIEW');
    expect(content.at(-1)).toBeUndefined();
    await f.render(props);
    expect(f.host.querySelector('.message-markdown')!.textContent).toBe('Verified child tail🙂');
    await f.click('收起完整回复');
    expect(f.host.querySelector('.message-markdown')!.textContent).toBe('PREVIEW');
    await f.click('查看完整回复');
    expect(f.host.querySelector('.message-markdown')!.textContent).toBe('Verified child tail🙂');
    for (const snapshot of [
      { ...data.snapshot, sessionId: 'other' },
      { ...data.snapshot, runId: 'other' },
      { ...data.snapshot, executionId: 'other' },
      { ...data.snapshot, output: { ...data.snapshot.output, content: 'wrong bytes' } },
    ]) {
      await f.render({
        ...props,
        message: {
          ...data.message,
          id: `other-${snapshot.executionId}-${snapshot.runId}-${snapshot.sessionId}-${snapshot.output.content}`,
        },
        verifiedSnapshot: snapshot,
      });
      expect(f.host.querySelector('.message-markdown')!.textContent).toBe('PREVIEW');
      expect(content.at(-1)).toBeUndefined();
    }
  } finally {
    await f.close();
  }
});
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
    await f.click('查看完整回复');
    expect(scopes).toEqual(['a']);
    expect(f.host.querySelector('.message-markdown')!.textContent).toBe(
      data.snapshot.output.content,
    );
    await f.render({
      message: { ...message, originMessage: { ...message.originMessage!, storeId: 'foreign' } },
      storeId: 'store',
      onRead,
    });
    await f.click('查看完整回复');
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
        (button) => button.textContent === '查看完整回复',
      )!.disabled,
    ).toBe(true);
    expect(f.host.textContent).toContain('暂不支持此内容格式，已保留回复预览');
    expect(scopes).toEqual(['a']);
  } finally {
    await f.close();
  }
});
test('a qualified host can read the restored sealed origin using the current snapshot Store; closing revokes the displayed full body', async () => {
  const f = await domFixture(),
    data = outputFixture('恢复原文\r\n雪🙂 tail'),
    content: (string | undefined)[] = [];
  const message: Message = {
    ...data.message,
    sessionId: 'fork',
    runId: null,
    originMessage: {
      storeId: 'original-store',
      sessionId: 'a',
      messageId: 'original',
      runId: 'run-a',
    },
  };
  let reads = 0;
  try {
    await f.render({
      message,
      storeId: 'store',
      canReadRestoredOrigin: true,
      onContent: (value) => content.push(value),
      onRead: async (input) => {
        reads++;
        expect(input.sessionId).toBe('a');
        expect(input.executionId).toBe('model');
        return data.snapshot;
      },
    });
    await f.click('查看完整回复');
    expect(reads).toBe(1);
    expect(f.host.textContent).toContain('完整回复');
    expect(content.at(-1)).toBe(data.snapshot.output.content);
    expect(message.originMessage!.storeId).toBe('original-store');
    await f.click('收起完整回复');
    expect(f.host.querySelector('.message-markdown')!.textContent).toBe('PREVIEW');
    expect(content.at(-1)).toBeUndefined();
    expect(reads).toBe(1);
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
    renderCached: (
      props: ModelOutputMessageProps,
      identity = 'a',
      loading = false,
      readActive = true,
    ) =>
      act(async () =>
        root.render(
          <ConversationCache
            identity={identity}
            loading={loading}
            visible
            cache={{ scope: 'store', revision: '1', readActive }}
          >
            <CachedOutput {...props} />
          </ConversationCache>,
        ),
      ),
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
test('ordinary reply automatically loads the verified >17MiB body once without preview headings or reader buttons', async () => {
  const f = await domFixture(),
    data = outputFixture(`${'x'.repeat(17 * 1024 * 1024 + 1)} 自动正文尾部🙂`),
    published: (string | undefined)[] = [];
  let reads = 0;
  const props: ModelOutputMessageProps = {
    autoRead: true,
    message: data.message,
    storeId: 'store',
    onRead: async (input) => {
      expect(input.sessionId).toBe('a');
      expect(input.executionId).toBe('model');
      reads++;
      return data.snapshot;
    },
    onContent: (value) => published.push(value),
  };
  try {
    await f.render(props);
    expect(reads).toBe(1);
    expect(f.host.querySelector('.message-markdown')!.textContent).toBe(
      data.snapshot.output.content,
    );
    expect(published.at(-1)).toBe(data.snapshot.output.content);
    expect(f.host.querySelector('.model-output-message > p')).toBeNull();
    expect(f.host.querySelectorAll('button')).toHaveLength(0);
    await f.render({ ...props, message: { ...data.message } });
    expect(reads).toBe(1);
    expect(published.at(-1)).toBe(data.snapshot.output.content);
  } finally {
    await f.close();
  }
});

test('ordinary automatic body aborts paused reads, isolates late replies and resumes only the current identity', async () => {
  const f = await domFixture(),
    data = outputFixture('旧会话秘密尾部'),
    next = outputFixture('当前会话完整尾部'),
    published: (string | undefined)[] = [];
  let reads = 0,
    signal: AbortSignal | undefined,
    release: ((snapshot: ModelOutputSnapshot) => void) | undefined;
  next.message = { ...next.message, id: 'next', sessionId: 'b', runId: 'run-b' };
  next.snapshot = { ...next.snapshot, sessionId: 'b', runId: 'run-b' };
  const props: ModelOutputMessageProps = {
    autoRead: true,
    message: data.message,
    storeId: 'store',
    onRead: async (input) => {
      reads++;
      signal = input.signal;
      return new Promise((resolve) => {
        release = resolve;
      });
    },
    onContent: (value) => published.push(value),
  };
  try {
    await f.render(props);
    expect(reads).toBe(1);
    expect(f.host.querySelector('.message-markdown')!.textContent).toBe('PREVIEW');
    expect(f.host.querySelectorAll('button')).toHaveLength(0);
    await f.render({ ...props, readActive: false });
    expect(signal?.aborted).toBe(true);
    expect(published.at(-1)).toBeUndefined();
    await f.render({
      ...props,
      message: next.message,
      onRead: async (input) => {
        expect(input.sessionId).toBe('b');
        reads++;
        return next.snapshot;
      },
    });
    await act(async () => release?.(data.snapshot));
    expect(reads).toBe(2);
    expect(f.host.querySelector('.message-markdown')!.textContent).toBe(
      next.snapshot.output.content,
    );
    expect(published.at(-1)).toBe(next.snapshot.output.content);
    expect(f.host.textContent).not.toContain(data.snapshot.output.content);
  } finally {
    await f.close();
  }
});

test('automatic read failures preserve the preview without a retry button or unverified copy content', async () => {
  const f = await domFixture(),
    data = outputFixture('核实后才显示的完整回复'),
    published: (string | undefined)[] = [];
  let reads = 0;
  const props: ModelOutputMessageProps = {
    autoRead: true,
    message: data.message,
    storeId: 'store',
    onRead: async () => {
      reads++;
      if (reads === 1) throw new ClientError('fixture_private_failure');
      return data.snapshot;
    },
    onContent: (value) => published.push(value),
  };
  try {
    await f.render(props);
    expect(reads).toBe(1);
    expect(f.host.querySelector('.message-markdown')!.textContent).toBe('PREVIEW');
    expect(f.host.querySelector('[role=alert]')!.textContent).toContain('完整回复读取失败');
    expect(f.host.textContent).not.toContain('fixture_private_failure');
    expect(published.at(-1)).toBeUndefined();
    expect(f.host.querySelectorAll('button')).toHaveLength(0);
    expect(f.host.querySelector('[role=alert]')!.textContent).toBe('完整回复读取失败。');
    await f.render({ ...props });
    expect(reads).toBe(1);
    await f.render({ ...props, message: { ...data.message, id: 'reloaded' } });
    expect(reads).toBe(2);
    expect(f.host.querySelector('.message-markdown')!.textContent).toBe(
      data.snapshot.output.content,
    );
    expect(published.at(-1)).toBe(data.snapshot.output.content);
    expect(f.host.querySelectorAll('button')).toHaveLength(0);
  } finally {
    await f.close();
  }
});

test('opted-in automatic read retry rechecks original ownership and pauses without publishing unverified copy content', async () => {
  const f = await domFixture(),
    data = outputFixture('核实后才显示的完整回复'),
    published: (string | undefined)[] = [],
    signals: AbortSignal[] = [];
  let release!: (snapshot: ModelOutputSnapshot) => void;
  const props: ModelOutputMessageProps = {
    autoRead: true,
    autoReadRetry: true,
    message: data.message,
    storeId: 'store',
    onRead: async (input) => {
      expect(input.sessionId).toBe('a');
      expect(input.executionId).toBe('model');
      signals.push(input.signal);
      if (signals.length === 1) return { ...data.snapshot, runId: 'foreign' };
      return new Promise((resolve) => {
        release = resolve;
      });
    },
    onContent: (value) => published.push(value),
  };
  try {
    await f.render(props);
    expect(signals).toHaveLength(1);
    expect(signals[0]!.aborted).toBe(true);
    expect(f.host.querySelector('.message-markdown')!.textContent).toBe('PREVIEW');
    expect(f.host.querySelector('[role=alert]')!.textContent).toContain(
      '完整回复读取失败，请重试。',
    );
    expect(f.host.textContent).not.toContain('model_output_identity_conflict');
    expect(published.at(-1)).toBeUndefined();
    await f.render({ ...props, readActive: false });
    expect(f.host.querySelector('button')!.getAttribute('aria-disabled')).toBe('true');
    await f.click('重新读取');
    expect(signals).toHaveLength(1);
    await f.render(props);
    expect(signals).toHaveLength(1);
    await f.click('重新读取');
    expect(signals).toHaveLength(2);
    expect(f.host.querySelector('[aria-busy=true]')).not.toBeNull();
    expect(f.host.querySelectorAll('button')).toHaveLength(0);
    expect(f.host.querySelector('.message-markdown')!.textContent).toBe('PREVIEW');
    expect(published.at(-1)).toBeUndefined();
    await f.render({ ...props });
    expect(signals).toHaveLength(2);
    await act(async () => release(data.snapshot));
    expect(f.host.querySelector('.message-markdown')!.textContent).toBe(
      data.snapshot.output.content,
    );
    expect(published.at(-1)).toBe(data.snapshot.output.content);
    expect(f.host.querySelector('[role=alert]')).toBeNull();
    expect(f.host.querySelectorAll('button')).toHaveLength(0);
    expect(signals).toHaveLength(2);
  } finally {
    await f.close();
  }
});

test('automatic replies reserve incomplete warnings for verified terminal output, never a live prefix or pending read', async () => {
  const f = await domFixture(),
    partial = outputFixture('首批已经显示的正文。', false),
    complete = outputFixture('首批已经显示的正文。');
  try {
    const props: ModelOutputMessageProps = {
      autoRead: true,
      message: partial.message,
      storeId: 'store',
      onRead: () => new Promise(() => {}),
    };
    await f.render(props);
    expect(f.host.textContent).not.toContain('回复未完成');
    for (const status of ['planned', 'dispatching', 'running'] as const) {
      await f.render({ ...props, verifiedSnapshot: { ...partial.snapshot, status } });
      expect(f.host.textContent).not.toContain('回复未完成');
      expect(f.host.querySelector('.message-markdown')!.textContent).toBe(
        partial.snapshot.output.content,
      );
    }
    for (const status of ['failed', 'cancelled', 'outcome_unknown', 'succeeded'] as const) {
      await f.render({ ...props, verifiedSnapshot: { ...partial.snapshot, status } });
      expect(f.host.textContent).toContain('回复未完成');
    }
    await f.render({ ...props, message: complete.message, verifiedSnapshot: complete.snapshot });
    expect(f.host.textContent).not.toContain('回复未完成');
    expect(f.host.querySelector('.message-markdown')!.textContent).toBe(
      complete.snapshot.output.content,
    );
  } finally {
    await f.close();
  }
});

test('terminal lifecycle refreshes an unchanged live body once and rejects the retired read', async () => {
  const f = await domFixture(),
    partial = outputFixture('Unchanged interrupted response', false);
  const reads: { signal: AbortSignal; resolve: (value: ModelOutputSnapshot) => void }[] = [];
  const props: ModelOutputMessageProps = {
    autoRead: true,
    message: partial.message,
    storeId: 'store',
    onRead: ({ signal }) => new Promise((resolve) => reads.push({ signal, resolve })),
  };
  try {
    await f.render(props);
    expect(reads).toHaveLength(1);
    await f.render({ ...props, terminalObserved: true });
    expect(reads).toHaveLength(2);
    expect(reads[0]!.signal.aborted).toBe(true);
    expect(f.host.textContent).not.toContain('回复未完成');
    await act(async () => reads[0]!.resolve({ ...partial.snapshot, status: 'running' }));
    expect(f.host.textContent).not.toContain(partial.snapshot.output.content);
    await act(async () => reads[1]!.resolve(partial.snapshot));
    expect(f.host.textContent).toContain('回复未完成');
    for (let index = 0; index < 3; index++)
      await f.render({ ...props, message: { ...partial.message }, terminalObserved: true });
    expect(reads).toHaveLength(2);
  } finally {
    await f.close();
  }
});

test('terminal refresh is qualified, bounded after failure, and resumes an interrupted refresh', async () => {
  const f = await domFixture(),
    partial = outputFixture('Verified live prefix', false);
  const reads: { signal: AbortSignal; resolve: (value: ModelOutputSnapshot) => void }[] = [];
  const published: (string | undefined)[] = [];
  const props: ModelOutputMessageProps = {
    autoRead: true,
    message: partial.message,
    storeId: 'store',
    onContent: (text) => published.push(text),
    onRead: ({ signal }) => new Promise((resolve) => reads.push({ signal, resolve })),
  };
  try {
    await f.render(props);
    await act(async () => reads[0]!.resolve({ ...partial.snapshot, status: 'running' }));
    await f.render({ ...props, terminalObserved: true, readActive: false });
    expect(reads).toHaveLength(1);
    expect(published.at(-1)).toBeUndefined();
    await f.render({ ...props, terminalObserved: true });
    expect(reads).toHaveLength(2);
    await f.render({ ...props, terminalObserved: true, readActive: false });
    expect(reads[1]!.signal.aborted).toBe(true);
    await f.render({ ...props, terminalObserved: true });
    expect(reads).toHaveLength(3);
    await act(async () => reads[1]!.resolve(partial.snapshot));
    expect(f.host.textContent).not.toContain('回复未完成');
    await act(async () => reads[2]!.resolve({ ...partial.snapshot, executionId: 'foreign' }));
    expect(f.host.textContent).not.toContain('回复未完成');
    expect(f.host.textContent).toContain('完整回复读取失败');
    for (let index = 0; index < 3; index++)
      await f.render({ ...props, message: { ...partial.message }, terminalObserved: true });
    expect(reads).toHaveLength(3);
    expect(published.filter((text) => text !== undefined)).toEqual([
      partial.snapshot.output.content,
      partial.snapshot.output.content,
      partial.snapshot.output.content,
    ]);
  } finally {
    await f.close();
  }
});

test('automatic replies reject mismatched or unsupported bodies and identify incomplete recorded replies', async () => {
  const f = await domFixture(),
    data = outputFixture(),
    partial = outputFixture('实际保存的未完成正文', false),
    published: (string | undefined)[] = [];
  let reads = 0;
  const props: ModelOutputMessageProps = {
    autoRead: true,
    message: data.message,
    storeId: 'store',
    onRead: async () => {
      reads++;
      return { ...data.snapshot, runId: 'foreign' };
    },
    onContent: (value) => published.push(value),
  };
  try {
    await f.render(props);
    expect(reads).toBe(1);
    expect(f.host.querySelector('.message-markdown')!.textContent).toBe('PREVIEW');
    expect(published.at(-1)).toBeUndefined();
    expect(f.host.textContent).not.toContain('identity_conflict');
    await f.render({
      ...props,
      message: {
        ...data.message,
        outputBody: { ...data.message.outputBody!, readAvailability: 'unsupported' },
      },
    });
    expect(reads).toBe(1);
    expect(f.host.querySelectorAll('button')).toHaveLength(0);
    await f.render({
      ...props,
      message: { ...partial.message, id: 'partial' },
      onRead: async () => {
        reads++;
        return partial.snapshot;
      },
    });
    expect(reads).toBe(2);
    expect(f.host.textContent).toContain('回复未完成');
    expect(f.host.querySelector('.message-markdown')!.textContent).toBe(
      partial.snapshot.output.content,
    );
    expect(f.host.querySelectorAll('button')).toHaveLength(0);
  } finally {
    await f.close();
  }
});

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
    expect(f.host.textContent).toContain('回复预览');
    await f.click('查看完整回复');
    expect(reads).toBe(1);
    expect(f.host.querySelector('.message-markdown')!.textContent).toBe(
      data.snapshot.output.content,
    );
    expect(copies.at(-1)).toBe(data.snapshot.output.content);
    await f.click('收起完整回复');
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
    await f.click('查看完整回复');
    await f.click('查看完整回复');
    expect(reads).toBe(1);
    await f.click('收起完整回复');
    expect(signal.aborted).toBe(true);
    release(data.snapshot);
    await act(async () => await Bun.sleep(1));
    expect(f.host.textContent).not.toContain('Full answer tail');
    await f.click('查看完整回复');
    await f.render({ message: { ...data.message, id: 'new' }, storeId: 'store', onRead });
    expect(signal.aborted).toBe(true);
    release(data.snapshot);
    await act(async () => await Bun.sleep(1));
    expect(f.host.textContent).not.toContain('Full answer tail');
    await f.click('查看完整回复');
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
    await f.click('查看完整回复');
    expect(f.host.querySelector('[role=alert]')!.textContent).toBe('完整回复读取失败，请重试。');
    expect(f.host.textContent).not.toContain('identity_conflict');
    expect(f.host.querySelector('.message-markdown')!.textContent).toBe('PREVIEW');
    await f.render({ message: data.message, storeId: 'store', onRead: async () => data.snapshot });
    await f.click('查看完整回复');
    expect(f.host.textContent).toContain('已记录的回复内容（回复未完成）');
    expect(f.host.querySelector('.message-markdown')!.textContent).toBe('PREFIX');
    expect(f.host.querySelector('details')).toBeNull();
  } finally {
    await f.close();
  }
});

test('ordinary preview and unavailable readers use concise copy without exposing errors or dropping preview content', async () => {
  const f = await domFixture(),
    data = outputFixture(),
    preview = `${'原始回复预览🙂'.repeat(900)}完整预览尾部`,
    published: (string | undefined)[] = [];
  data.message.content = preview;
  let reads = 0;
  try {
    for (const cause of [
      new ClientError('fixture_private_error_token'),
      new Error('private fixture failure details'),
    ]) {
      await f.render({
        message: data.message,
        storeId: 'store',
        onContent: (content) => published.push(content),
        onRead: async () => {
          reads++;
          throw cause;
        },
      });
      expect(f.host.querySelector('.message-markdown')!.textContent).toBe(preview);
      expect(f.host.querySelector('.model-output-message > p')!.textContent).toBe('回复预览');
      await f.click('查看完整回复');
      expect(f.host.querySelector('[role=alert]')!.textContent).toBe('完整回复读取失败，请重试。');
      expect(f.host.querySelector('.message-markdown')!.textContent).toBe(preview);
      expect(f.host.textContent).not.toMatch(
        /Model output|fixture_private_error_token|private fixture failure details|model_output_unavailable/,
      );
      expect(published.at(-1)).toBeUndefined();
    }
    expect(reads).toBe(2);
    await f.render({
      message: data.message,
      storeId: 'store',
    });
    expect(f.host.querySelector('button')!.disabled).toBe(true);
    expect(f.host.textContent).toContain('暂时无法查看完整回复');
    expect(f.host.querySelector('.message-markdown')!.textContent).toBe(preview);
    await f.render({
      message: { ...data.message, outputBody: undefined, contentFormat: 'unsupported' },
      storeId: 'store',
    });
    expect(f.host.textContent).toContain('暂不支持此内容格式，已保留原始预览');
    expect(f.host.querySelector('.message-markdown')!.textContent).toBe(preview);
    expect(reads).toBe(2);
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
    await f.click('查看完整回复');
    expect(f.host.textContent).not.toContain('PRIVATE THOUGHTS');
    expect(f.host.querySelector('details')).toBeNull();
    await f.render({ ...props, showReasoning: true });
    expect(f.host.querySelector('details')!.open).toBe(false);
    expect(f.host.querySelector('details pre')!.textContent).toBe('PRIVATE THOUGHTS');
  } finally {
    await f.close();
  }
});

test('KeepAlive retains the verified full body and exact Markdown DOM while retiring its old read lease and copy publication', async () => {
  const f = await domFixture(),
    data = outputFixture('Retained complete answer');
  let reads = 0;
  let signal: AbortSignal | undefined;
  const content: (string | undefined)[] = [];
  const props: ModelOutputMessageProps = {
    message: data.message,
    storeId: 'store',
    onContent: (value) => content.push(value),
    onRead: async (request) => {
      reads++;
      signal = request.signal;
      return data.snapshot;
    },
  };
  try {
    await f.renderCached(props);
    await f.click('查看完整回复');
    const body = f.host.querySelector('.message-markdown')!;
    const paragraph = body.querySelector('p')!;
    expect(body.textContent).toBe(data.snapshot.output.content);
    await f.renderCached(props, 'b');
    expect(body.isConnected).toBe(false);
    expect(signal?.aborted).toBe(true);
    await f.renderCached(props, 'a', true, false);
    expect(f.host.querySelector('.message-markdown') === body).toBe(true);
    expect(body.querySelector('p') === paragraph).toBe(true);
    expect(body.textContent).toBe(data.snapshot.output.content);
    expect(content.at(-1)).toBeUndefined();
    expect(reads).toBe(1);
    await f.renderCached(props);
    expect(f.host.querySelector('.message-markdown') === body).toBe(true);
    expect(body.querySelector('p') === paragraph).toBe(true);
    expect(content.at(-1)).toBe(data.snapshot.output.content);
    expect(reads).toBe(1);
    await f.renderCached({ ...props, message: { ...data.message, content: 'changed preview' } });
    expect(f.host.querySelector('.message-markdown')?.textContent).toBe('changed preview');
    expect(content.at(-1)).toBeUndefined();
  } finally {
    await f.close();
  }
});

test('KeepAlive aborts a pending full read on deactivation and permits a fresh read after activation without accepting the late body', async () => {
  const f = await domFixture(),
    data = outputFixture('Fresh verified body');
  let release: ((snapshot: ModelOutputSnapshot) => void) | undefined;
  let signal: AbortSignal | undefined;
  const props: ModelOutputMessageProps = {
    message: data.message,
    storeId: 'store',
    onRead: (request) => {
      signal = request.signal;
      return new Promise((resolve) => {
        release = resolve;
      });
    },
  };
  try {
    await f.renderCached(props);
    await f.click('查看完整回复');
    await f.renderCached(props, 'b');
    expect(signal?.aborted).toBe(true);
    await f.renderCached({ ...props, onRead: async () => data.snapshot });
    await act(async () => release?.(data.snapshot));
    expect(f.host.querySelector('.message-markdown')?.textContent).toBe('PREVIEW');
    await f.click('查看完整回复');
    expect(f.host.querySelector('.message-markdown')?.textContent).toBe(
      data.snapshot.output.content,
    );
  } finally {
    await f.close();
  }
});
