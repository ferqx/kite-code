import { expect, test } from 'bun:test';
import type { Message } from '@kite-ai/client';
import { ModelOutputMessage } from '@kite-ai/ui';
import { ConversationActivityContext, MessageContent, SessionPage } from '@kite-ai/ui/desktop';
import { JSDOM } from 'jsdom';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { ConversationCache } from '../../../../packages/ui/src/desktop/ConversationCache';
import { desktopMessages } from '../../src/native-presentation';
import { NativeReasoningCache, renderNativeReasoning } from '../../src/native-reasoning';
import { desktopTranscript } from '../../src/native-transcript';
import type { NativeRunFact } from '../../src/tool-messages-bridge';
import { prepareDesktopDom } from '../native-page-dom.fixture';

const user: Message = {
  id: 'user',
  sessionId: 's',
  runId: 'r',
  seq: '1',
  role: 'user',
  status: 'complete',
  content: 'Explain the project',
};
const thought: Message = {
  id: 'partial_model',
  sessionId: 's',
  runId: 'r',
  seq: '2',
  role: 'assistant',
  status: 'incomplete',
  content: '',
  firstOutput: 'reasoning',
  sourceIds: ['model'],
};
const run: NativeRunFact = {
  id: 'r',
  sessionId: 's',
  originStoreId: 'store',
  status: 'running',
  isActive: true,
  createdAt: 1000,
  finishedAt: null,
  reason: null,
};

for (const mode of ['inline', 'artifact', 'legacy-artifact'] as const)
  test(`Native reasoning-only ${mode} stays a status and starts streaming only when actual text arrives`, async () => {
    const dom = new JSDOM('<div id="root"></div>', {
      url: 'http://localhost',
      pretendToBeVisual: true,
    });
    const restoreLayout = prepareDesktopDom(dom);
    const previous = { window: globalThis.window, document: globalThis.document };
    const previousAct = Object.getOwnPropertyDescriptor(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
    Object.assign(globalThis, {
      window: dom.window,
      document: dom.window.document,
      IS_REACT_ACT_ENVIRONMENT: true,
    });
    const host = dom.window.document.getElementById('root')!,
      root = createRoot(host);
    const observed: string[] = [];
    const observer = new dom.window.MutationObserver(() => observed.push(host.textContent ?? ''));
    observer.observe(host, { childList: true, subtree: true, characterData: true });
    let reads = 0;
    let current: Message = {
      ...thought,
      ...(mode === 'legacy-artifact' ? { firstOutput: undefined } : {}),
      ...(mode !== 'inline'
        ? {
            outputBody: {
              kind: 'model_output',
              executionId: 'model',
              complete: false,
              contentBytes: '0',
              reasoningBytes: '70000',
              toolCallCount: 0,
            },
          }
        : {}),
    };
    async function render(message: Message, state = run) {
      const messages = [
        user,
        // A failed/retried Model can leave its original incomplete reasoning
        // prefix in history. It must not own a later attempt's activity label.
        { ...thought, id: 'old_attempt', sourceIds: ['old_model'] },
        { ...message, seq: '3' },
      ];
      const transcript = desktopTranscript({
        messages,
        runs: [state],
        tools: [],
        storeId: 'store',
        sessionId: 's',
      });
      await act(async () =>
        root.render(
          <SessionPage
            workspaces={[]}
            sessionLabel="reasoning"
            readingKey="s"
            loading={false}
            connected
            connectionLabel="local"
            actions={{}}
            messages={transcript.messages}
            turnActivity={transcript.turnActivity}
            renderMessageContent={(model) => (
              <ModelOutputMessage
                message={messages.find((entry) => entry.id === model.id)!}
                storeId="store"
                renderText={(text) => <MessageContent text={text} />}
                onRead={async () => {
                  reads++;
                  throw Error('unexpected_body_read');
                }}
              />
            )}
          />,
        ),
      );
      return transcript;
    }
    try {
      const reasoning = await render(current);
      expect(reasoning.messages.find((message) => message.id === current.id)?.role).toBe(
        'thinking',
      );
      expect(host.textContent).toContain('正在思考');
      expect(host.querySelector('.message.assistant')).toBeNull();
      expect(host.querySelector('.model-output-message')).toBeNull();
      expect(host.querySelectorAll('.response-status')).toHaveLength(1);
      expect(host.querySelector('.response-status')?.textContent).toBe('正在思考…');
      expect(host.querySelector('.agent-turn-summary')).toBeNull();
      expect(host.textContent).not.toContain('查看完整回复');
      expect(reads).toBe(0);

      current = {
        ...current,
        content: 'PUBLIC_ANSWER_PREFIX',
        ...(current.outputBody
          ? { outputBody: { ...current.outputBody, contentBytes: '20' } }
          : {}),
      };
      const answering = await render(current);
      expect(answering.messages.find((message) => message.id === current.id)?.role).toBe(
        'assistant',
      );
      expect(host.querySelector('.message.assistant')?.textContent).toContain(
        'PUBLIC_ANSWER_PREFIX',
      );
      expect(host.querySelector('.response-status')).toBeNull();
      expect(host.querySelector('[data-final-reply="true"]')).toBeNull();
      expect(host.querySelector('.agent-turn-status-label')?.textContent).toBe('进行中');
      const running = host.querySelector('.agent-turn-status-label');

      // More reasoning does not change the original first channel or retract actual text.
      current = {
        ...current,
        ...(current.outputBody
          ? { outputBody: { ...current.outputBody, reasoningBytes: '80000' } }
          : {}),
      };
      await render(current);
      expect(host.querySelector('.message.assistant')?.textContent).toContain(
        'PUBLIC_ANSWER_PREFIX',
      );
      current = {
        ...current,
        status: 'complete',
        ...(current.outputBody ? { outputBody: { ...current.outputBody, complete: true } } : {}),
      };
      await render(current);
      expect(host.querySelector('[data-final-reply="true"]')).toBeNull();
      expect(host.querySelector('.agent-turn-status-label')).toBe(running);
      expect(host.querySelector('.response-status')).toBeNull();
      await render(current, { ...run, status: 'completed', isActive: false, finishedAt: 3000 });
      expect(host.querySelectorAll('[data-final-reply="true"]')).toHaveLength(1);
      expect(host.querySelector('.agent-turn-final')?.textContent).toContain(
        'PUBLIC_ANSWER_PREFIX',
      );
      expect(host.querySelector('.response-status')).toBeNull();
      expect(reads).toBe(0);
      expect(observed.some((text) => text.includes('正在思考'))).toBe(true);
    } finally {
      observer.disconnect();
      await act(async () => root.unmount());
      restoreLayout();
      Object.assign(globalThis, previous);
      if (previousAct) Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', previousAct);
      else Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
      dom.window.close();
    }
  });

test('Native phase presentation retains real content, complete history and compression identity', () => {
  const pendingBody = {
    ...thought,
    outputBody: {
      kind: 'model_output' as const,
      executionId: 'model',
      complete: false,
      contentBytes: '8',
      reasoningBytes: '70000',
      toolCallCount: 0,
    },
  };
  const messages: Message[] = [
    { ...thought, content: 'Actual reply' },
    pendingBody,
    { ...thought, status: 'complete', content: 'Complete reply' },
    { ...thought, compression: { id: 'compression', trigger: 'automatic', status: 'running' } },
    { ...thought, firstOutput: 'tool_calls' },
    { ...thought, firstOutput: 'content' },
    { ...thought, content: ' \n' },
    { ...thought, contentFormat: 'unsupported' },
    {
      ...pendingBody,
      outputBody: { ...pendingBody.outputBody, contentBytes: '0', readAvailability: 'unsupported' },
    },
    {
      ...pendingBody,
      firstOutput: 'tool_calls',
      outputBody: { ...pendingBody.outputBody, contentBytes: '0' },
    },
    { ...thought, firstOutput: undefined },
  ];
  const presented = desktopMessages(messages);
  expect(presented.map((message) => message.role)).toEqual(
    messages.filter((message) => !message.compression).map(() => 'assistant'),
  );
  expect(presented[0]!.text).toBe('Actual reply');
  expect(presented[1]!.text).toBe('');
  expect(presented[2]!.text).toBe('Complete reply');
  expect(presented.some((message) => message.systemKind === 'compaction')).toBe(false);
  expect(presented[5]!.text).toBe(' \n');
});

test('verified reasoning survives a read epoch without reviving revoked, unrelated or late output', async () => {
  const dom = new JSDOM('<div id="root"></div>', {
    url: 'http://localhost',
    pretendToBeVisual: true,
  });
  const restoreLayout = prepareDesktopDom(dom);
  const previous = { window: globalThis.window, document: globalThis.document };
  const previousAct = Object.getOwnPropertyDescriptor(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const host = dom.window.document.getElementById('root')!;
  const root = createRoot(host);
  const cache = new NativeReasoningCache();
  const pending: {
    signal: AbortSignal;
    resolve: (text: string) => void;
    reject: (error: Error) => void;
  }[] = [];
  let reads = 0;
  let message = thought;
  let scope = JSON.stringify([1, 'store', 's']);
  let epoch = 0;
  let revision = '1';
  let active = true;
  let available = true;
  let authorized = true;
  let open = true;
  let mounted = 0;
  const render = () =>
    act(async () => {
      const accessEpoch = cache.observe('connection', authorized);
      root.render(
        <ConversationActivityContext key={mounted} value={{ readActive: active, resume: 0 }}>
          {renderNativeReasoning({
            scope: JSON.stringify([scope, accessEpoch]),
            original: message,
            open,
            revision,
            readEpoch: epoch,
            authorized,
            cache,
            read: available
              ? (signal) => {
                  reads++;
                  return new Promise<string>((resolve, reject) =>
                    pending.push({ signal, resolve, reject }),
                  );
                }
              : undefined,
          })}
        </ConversationActivityContext>,
      );
    });
  const finish = (text: string) => act(async () => pending.at(-1)!.resolve(text));
  const fail = () =>
    act(async () => pending.at(-1)!.reject(Error('model_output_identity_mismatch')));
  try {
    available = false;
    await render();
    expect(host.textContent).toBe('');
    expect(reads).toBe(0);
    available = true;
    await render();
    await fail();
    expect(host.textContent).toBe('');
    revision = 'empty';
    await render();
    await finish('');
    expect(host.textContent).toBe('');
    open = false;
    await render();
    open = true;
    await render();
    await finish('VERIFIED_STREAM_PREFIX');
    const paragraph = host.querySelector('p');
    expect(host.textContent).toContain('VERIFIED_STREAM_PREFIX');
    revision = '2';
    await render();
    const slow = pending.at(-1)!;
    const reading = reads;
    for (const update of ['3', '4', '5']) {
      revision = update;
      await render();
    }
    expect(slow.signal.aborted).toBe(false);
    expect(reads).toBe(reading);
    const verified = 'VERIFIED_STREAM_PREFIX AFTER_SLOW_READ';
    await act(async () => slow.resolve(verified));
    expect(host.textContent).toBe(verified);
    expect(reads).toBe(reading + 1);
    await finish(verified);
    revision = '6';
    await render();
    const oldRead = pending.at(-1)!;
    active = false;
    available = false;
    epoch++;
    await render();
    expect(oldRead.signal.aborted).toBe(true);
    expect(host.querySelector('p')).toBe(paragraph);
    expect(host.textContent).toBe(verified);
    expect(host.querySelector('[role="status"]')).toBeNull();
    await act(async () => oldRead.resolve('STALE_OFFLINE_OUTPUT'));
    expect(host.textContent).toBe(verified);
    const pausedReads = reads;
    epoch++;
    await render();
    expect(reads).toBe(pausedReads);
    expect(host.textContent).toBe(verified);

    // A trace can be rebuilt before the streamed body gets a complete revision.
    mounted++;
    revision = 'same-source-new-revision';
    await render();
    expect(reads).toBe(pausedReads);
    expect(host.textContent).toBe(verified);
    expect(host.querySelector('[role="status"]')).toBeNull();

    active = true;
    available = true;
    await render();
    expect(reads).toBe(pausedReads + 1);
    expect(host.textContent).toBe(verified);
    await finish(`${verified} AND_RECONNECTED_SUFFIX`);
    expect(host.textContent).toContain('AND_RECONNECTED_SUFFIX');
    message = { ...message, status: 'complete' };
    await render();
    expect(host.textContent).toContain('AND_RECONNECTED_SUFFIX');
    await finish('VERIFIED_FINAL_REASONING');
    const finalReads = reads;
    open = false;
    await render();
    open = true;
    await render();
    expect(reads).toBe(finalReads);
    expect(host.textContent).toBe('VERIFIED_FINAL_REASONING');

    // A stale or empty retry never interrupts a previously verified body.
    const verifiedBody = host.querySelector('p');
    epoch++;
    await render();
    await fail();
    expect(host.querySelector('p')).toBe(verifiedBody);
    expect(host.textContent).toBe('VERIFIED_FINAL_REASONING');
    epoch++;
    await render();
    await finish('');
    expect(host.querySelector('p')).toBe(verifiedBody);
    expect(host.textContent).toBe('VERIFIED_FINAL_REASONING');
    epoch++;
    await render();
    await finish('VERIFIED_FINAL_REASONING');
    expect(host.querySelector('p')).toBe(verifiedBody);
    expect(reads).toBe(finalReads + 3);

    // A restarted view paints its cached body during reader calibration and then revalidates.
    epoch++;
    active = false;
    available = false;
    mounted++;
    await render();
    expect(host.textContent).toBe('VERIFIED_FINAL_REASONING');
    expect(reads).toBe(finalReads + 3);
    active = true;
    available = true;
    await render();
    expect(reads).toBe(finalReads + 4);
    expect(host.textContent).toBe('VERIFIED_FINAL_REASONING');
    await finish('VERIFIED_FINAL_REASONING');

    active = false;
    available = false;
    mounted++;
    revision = 'same-source-complete-revision-changed';
    await render();
    expect(host.textContent).toBe('VERIFIED_FINAL_REASONING');
    expect(reads).toBe(finalReads + 4);
    active = true;
    available = true;
    await render();
    expect(reads).toBe(finalReads + 5);
    expect(host.textContent).toBe('VERIFIED_FINAL_REASONING');
    const revokedRead = pending.at(-1)!;
    authorized = false;
    await render();
    expect(revokedRead.signal.aborted).toBe(true);
    expect(host.textContent).toBe('');
    await act(async () => revokedRead.resolve('STALE_REVOKED_OUTPUT'));
    expect(host.textContent).toBe('');
    authorized = true;
    await render();
    expect(host.textContent).toBe('');
    expect(reads).toBe(finalReads + 6);
    await finish('NEWLY_VERIFIED_AFTER_CAPABILITY_RESTORED');
    expect(host.textContent).toBe('NEWLY_VERIFIED_AFTER_CAPABILITY_RESTORED');

    for (const change of [
      () => {
        scope = JSON.stringify([1, 'store', 'different-session']);
      },
      () => {
        scope = JSON.stringify([1, 'different-store', 'different-session']);
      },
      () => {
        scope = JSON.stringify([2, 'different-store', 'different-session']);
      },
      () => {
        message = { ...message, runId: 'different-run' };
      },
      () => {
        message = { ...message, sourceIds: ['different-execution'] };
      },
    ]) {
      revision += '-next';
      await render();
      const stale = pending.at(-1)!;
      change();
      await render();
      expect(stale.signal.aborted).toBe(true);
      expect(host.textContent).toBe('');
      await act(async () => stale.resolve('UNRELATED_LATE_OUTPUT'));
      expect(host.textContent).toBe('');
      await finish('VERIFIED_CURRENT_IDENTITY');
      expect(host.textContent).toBe('VERIFIED_CURRENT_IDENTITY');
    }
  } finally {
    await act(async () => root.unmount());
    restoreLayout();
    Object.assign(globalThis, previous);
    if (previousAct) Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', previousAct);
    else Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
    dom.window.close();
  }
});

test('a missing selection preserves the last reasoning capability only within its boundary', () => {
  const cache = new NativeReasoningCache();
  const initialEpoch = cache.observe('connection', true);
  const body = { text: 'cached reasoning' };
  cache.set('body', body);
  expect(cache.observe('connection', undefined)).toBe(initialEpoch);
  expect(cache.get('body')).toBe(body);

  const revokedEpoch = cache.observe('connection', false);
  expect(revokedEpoch).toBe(initialEpoch + 1);
  expect(cache.get('body')).toBeUndefined();
  expect(cache.observe('connection', undefined)).toBe(revokedEpoch);
  expect(cache.observe('connection', false)).toBe(revokedEpoch);

  expect(cache.observe('connection', true)).toBe(revokedEpoch);
  cache.set('body', body);
  cache.observe('new connection', undefined);
  expect(cache.get('body')).toBeUndefined();
});

for (const scenario of ['active-loading', 'inactive-loading', 'folded'] as const)
  test(`explicit reasoning capability removal retires ${scenario} conversation trees and body cache`, async () => {
    const dom = new JSDOM('<div id="root"></div>', {
      url: 'http://localhost',
      pretendToBeVisual: true,
    });
    const restoreLayout = prepareDesktopDom(dom);
    const previous = { window: globalThis.window, document: globalThis.document };
    const previousAct = Object.getOwnPropertyDescriptor(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
    Object.assign(globalThis, {
      window: dom.window,
      document: dom.window.document,
      IS_REACT_ACT_ENVIRONMENT: true,
    });
    const host = dom.window.document.getElementById('root')!;
    const root = createRoot(host);
    const cache = new NativeReasoningCache();
    const pending: { signal: AbortSignal; resolve: (text: string) => void }[] = [];
    let authorized = true;
    let loading = false;
    let session = 's';
    let folded = false;
    let readEpoch = 0;
    let reads = 0;
    function Detail({ accessEpoch, allowed }: { accessEpoch: number; allowed: boolean }) {
      return renderNativeReasoning({
        scope: JSON.stringify(['s', accessEpoch]),
        readEpoch,
        original: { ...thought, status: 'complete' },
        open: true,
        authorized: allowed,
        cache,
        read: (signal) => {
          reads++;
          return new Promise<string>((resolve) => pending.push({ signal, resolve }));
        },
      });
    }
    const render = () =>
      act(async () => {
        const accessEpoch = cache.observe('connection', authorized);
        root.render(
          <ConversationCache
            identity={session}
            visible
            loading={loading}
            cache={{
              scope: JSON.stringify(['connection', accessEpoch]),
              revision: 'directory',
              readActive: authorized && !loading,
            }}
          >
            {session === 's' && !folded ? (
              <Detail accessEpoch={accessEpoch} allowed={authorized} />
            ) : (
              <p>OTHER_OR_FOLDED</p>
            )}
          </ConversationCache>,
        );
      });
    try {
      await render();
      await act(async () => pending.at(-1)!.resolve('PRE_REVOCATION_REASONING'));
      expect(host.textContent).toContain('PRE_REVOCATION_REASONING');
      readEpoch++;
      await render();
      const stale = pending.at(-1)!;
      if (scenario === 'inactive-loading') session = 'other';
      if (scenario === 'folded') folded = true;
      if (scenario === 'active-loading') loading = true;
      await render();
      if (scenario === 'active-loading')
        expect(host.textContent).toContain('PRE_REVOCATION_REASONING');
      authorized = false;
      await render();
      expect(stale.signal.aborted).toBe(true);
      expect(host.textContent).not.toContain('PRE_REVOCATION_REASONING');
      await act(async () => stale.resolve('LATE_REVOKED_REASONING'));
      expect(host.textContent).not.toContain('LATE_REVOKED_REASONING');
      authorized = true;
      await render();
      const beforeReturnReads = reads;
      session = 's';
      folded = false;
      loading = true;
      await render();
      expect(host.textContent).not.toContain('PRE_REVOCATION_REASONING');
      expect(host.textContent).not.toContain('LATE_REVOKED_REASONING');
      expect(reads).toBe(beforeReturnReads);
      loading = false;
      await render();
      expect(reads).toBe(beforeReturnReads + 1);
      expect(host.textContent).not.toContain('PRE_REVOCATION_REASONING');
      await act(async () => pending.at(-1)!.resolve('CURRENT_VERIFIED_REASONING'));
      expect(host.textContent).toContain('CURRENT_VERIFIED_REASONING');
    } finally {
      await act(async () => root.unmount());
      restoreLayout();
      Object.assign(globalThis, previous);
      if (previousAct) Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', previousAct);
      else Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
      dom.window.close();
    }
  });
