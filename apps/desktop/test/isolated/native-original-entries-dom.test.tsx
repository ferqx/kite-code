import { expect, test } from 'bun:test';
import type { Message, ModelOutputSnapshot } from '@kite-ai/client';
import { ModelOutputMessage } from '@kite-ai/ui';
import { MessageContent } from '@kite-ai/ui/desktop';
import { JSDOM } from 'jsdom';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type {
  NativeBridge,
  NativeModelSettingsFacts,
  NativeRequest,
  NativeSelection,
} from '../../src/native-bridge';
import { NativeGeneralSettings } from '../../src/native-general-settings';

function fixture() {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' });
  const prior = { window: globalThis.window, document: globalThis.document };
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const host = dom.window.document.getElementById('root')!,
    root = createRoot(host);
  return {
    dom,
    host,
    root,
    async close() {
      await act(async () => root.unmount());
      dom.window.close();
      Object.assign(globalThis, prior);
    },
  };
}
const facts: NativeModelSettingsFacts = {
  kind: 'settings.models',
  observationId: 1,
  storeId: 'store',
  scope: 'user',
  canWrite: true,
  errors: [],
  defaultModelId: 'default',
  selectedModelId: 'temporary',
  models: [
    {
      id: 'default',
      provider: 'compatible',
      model: 'config-default',
      enabled: true,
      configured: true,
      diagnostics: [],
    },
    {
      id: 'temporary',
      provider: 'other',
      model: 'temporary-choice',
      enabled: true,
      configured: true,
      diagnostics: [],
    },
  ],
};

test('retained General card reads the accurate configuration default and never shows a late other-Workspace or temporary choice', async () => {
  const f = fixture(),
    requests: NativeRequest[] = [],
    editors: string[] = [];
  let release!: (value: NativeModelSettingsFacts) => void;
  const held = new Promise<NativeModelSettingsFacts>((resolve) => {
    release = resolve;
  });
  let phase = 'user';
  const bridge = {
    request: async (request: NativeRequest) => {
      requests.push(request);
      if (request.method !== 'settings.models.read') return null;
      if (phase === 'held') return held;
      if (phase === 'error') throw Error('configuration_unavailable');
      return phase === 'user'
        ? facts
        : {
            ...facts,
            scope: 'workspace',
            workspaceId: 'wb',
            defaultModelId: 'b',
            models: [{ ...facts.models[0]!, id: 'b', model: 'workspace-b' }],
          };
    },
  } as NativeBridge;
  const selection = (id: string, workspaceId: string, viewSelection: number) =>
    ({ storeId: 'store', session: { id, workspaceId }, viewSelection }) as NativeSelection;
  const render = (selection?: NativeSelection) =>
    act(async () =>
      f.root.render(
        <NativeGeneralSettings
          bridge={bridge}
          generation={1}
          storeId="store"
          selection={selection}
          revision={0}
          editor="vscode"
          onEditorChange={(value) => editors.push(value)}
        />,
      ),
    );
  try {
    await render();
    expect(f.host.querySelector('.settings-value')!.textContent).toBe(
      'compatible · config-default',
    );
    expect(f.host.textContent).not.toContain('temporary-choice');
    const editor = f.host.querySelector('select')!;
    await act(async () => {
      editor.value = 'zed';
      editor.dispatchEvent(new f.dom.window.Event('change', { bubbles: true }));
    });
    expect(editors).toEqual(['zed']);
    phase = 'held';
    await render(selection('a', 'wa', 1));
    expect(f.host.querySelector('.settings-value')!.textContent).toBe('正在读取');
    phase = 'b';
    await render(selection('b', 'wb', 2));
    expect(f.host.querySelector('.settings-value')!.textContent).toBe('compatible · workspace-b');
    await act(async () => release({ ...facts, scope: 'workspace', workspaceId: 'wa' }));
    expect(f.host.querySelector('.settings-value')!.textContent).toBe('compatible · workspace-b');
    phase = 'error';
    await render();
    expect(f.host.querySelector('.settings-value')!.textContent).toBe('读取失败');
    expect(f.host.querySelector('[role="alert"]')!.textContent).toContain('当前默认模型不可读');
    expect(
      requests.every((request) =>
        ['settings.models.read', 'settings.models.close'].includes(request.method),
      ),
    ).toBe(true);
    expect(
      requests
        .filter((request) => request.method === 'settings.models.read')
        .map((request) => request.scope),
    ).toEqual(['user', 'workspace', 'workspace', 'user']);
  } finally {
    await f.close();
  }
});

test('original Markdown path callbacks apply to the displayed preview and verified full body while unsafe schemes, images and closed bodies remain inert', async () => {
  const f = fixture(),
    opened: string[] = [];
  const content =
    '[原文件](space%20%E9%9B%AA.txt) [外链](https://example.com) [定位](#part) [文件协议](file:///outside) ![图片](https://invalid/image.png)';
  const message: Message = {
    id: 'message',
    sessionId: 's',
    runId: 'run',
    seq: '1',
    role: 'assistant',
    status: 'complete',
    content: 'PREVIEW',
    outputBody: {
      kind: 'model_output',
      executionId: 'model',
      complete: true,
      contentBytes: String(new TextEncoder().encode(content).byteLength),
      reasoningBytes: '0',
      toolCallCount: 0,
    },
  };
  const snapshot: ModelOutputSnapshot = {
    storeId: 'store',
    sessionId: 's',
    rootSessionId: 's',
    runId: 'run',
    executionId: 'model',
    originCommandId: 'command',
    rootWorkCommandId: 'command',
    rootWorkSeq: '1',
    attempt: 1,
    status: 'succeeded',
    bodyHash: 'a'.repeat(64),
    bodyBytes: '1',
    contentBytes: message.outputBody!.contentBytes,
    reasoningBytes: '0',
    snapshotCursor: '1',
    output: { content, reasoning: '', toolCalls: [], complete: true },
  };
  let reads = 0;
  const render = (readOnly = false) =>
    act(async () =>
      f.root.render(
        <ModelOutputMessage
          message={message}
          storeId="store"
          onRead={async () => {
            reads++;
            return snapshot;
          }}
          renderText={(text) => (
            <MessageContent
              text={text}
              openFile={readOnly ? undefined : (path) => opened.push(path)}
            />
          )}
        />,
      ),
    );
  const click = (text: string) =>
    act(async () =>
      [...f.host.querySelectorAll('button')].find((button) => button.textContent === text)!.click(),
    );
  try {
    await render();
    expect(reads).toBe(0);
    expect(f.host.querySelector('.file-link')).toBeNull();
    await click('Read complete recorded Model output');
    expect(reads).toBe(1);
    expect(f.host.querySelectorAll('.file-link')).toHaveLength(1);
    await click('原文件');
    expect(opened).toEqual(['space 雪.txt']);
    expect(f.host.querySelectorAll('img')).toHaveLength(0);
    expect(f.host.querySelector('a')!.getAttribute('href')).toBe('https://example.com');
    await render(true);
    expect(f.host.querySelector('.file-link')).toBeNull();
    await click('Close full Model output');
    expect(f.host.querySelector('.message-markdown')!.textContent).toBe('PREVIEW');
    expect(reads).toBe(1);
    expect(opened).toHaveLength(1);
  } finally {
    await f.close();
  }
});
