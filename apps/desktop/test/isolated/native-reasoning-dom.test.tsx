import { expect, test } from 'bun:test';
import type { Message } from '@kite-ai/client';
import { ModelOutputMessage } from '@kite-ai/ui';
import { MessageContent, SessionPage } from '@kite-ai/ui/desktop';
import { JSDOM } from 'jsdom';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { desktopMessages } from '../../src/native-presentation';
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
      expect(host.textContent).not.toContain('正在回复');
      expect(host.textContent).not.toContain('Read complete recorded Model output');
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
      expect(host.textContent).toContain('正在回复');
      expect(host.querySelector('[data-final-reply="true"]')).toBeNull();
      expect(host.querySelector('.agent-turn-status-label')?.textContent).not.toContain('正在思考');

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
      await render(current, { ...run, status: 'completed', isActive: false, finishedAt: 3000 });
      expect(host.querySelectorAll('[data-final-reply="true"]')).toHaveLength(1);
      expect(host.querySelector('.agent-turn-final')?.textContent).toContain(
        'PUBLIC_ANSWER_PREFIX',
      );
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
    messages.map((message) => (message.compression ? 'system' : 'assistant')),
  );
  expect(presented[0]!.text).toBe('Actual reply');
  expect(presented[1]!.text).toBe('');
  expect(presented[2]!.text).toBe('Complete reply');
  expect(presented[3]!.systemKind).toBe('compaction');
  expect(presented[6]!.text).toBe(' \n');
});
