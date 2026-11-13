import type { Message, ModelOutputSnapshot } from '@kite-ai/client';
import { JSDOM } from 'jsdom';
import { act } from 'react';
import { expect, test } from '#kite-test';
import type {
  NativeBridge,
  NativeRequest,
  NativeShellSettingsFacts,
} from '../../src/native-bridge';
import { prepareDesktopDom } from '../native-page-dom.fixture';

const bootstrap = new JSDOM('<!doctype html><div></div>');
const initialGlobals = {
  window: globalThis.window,
  document: globalThis.document,
  navigator: globalThis.navigator,
};
Object.assign(globalThis, {
  window: bootstrap.window,
  document: bootstrap.window.document,
  navigator: bootstrap.window.navigator,
});
const { createRoot } = await import('react-dom/client');
const { MessageContent } = await import('@kite-ai/ui/desktop');
const { NativeGeneralSettings } = await import('../../src/native-general-settings');
const { NativeModelOutputMessage } = await import('../../src/native-model-output-message');
Object.assign(globalThis, initialGlobals);
bootstrap.window.close();

function fixture() {
  const dom = new JSDOM('<div id="root"></div>', {
    url: 'http://localhost',
    pretendToBeVisual: true,
  });
  const restoreDom = prepareDesktopDom(dom);
  const prior = {
    window: globalThis.window,
    document: globalThis.document,
    IS_REACT_ACT_ENVIRONMENT: (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
      .IS_REACT_ACT_ENVIRONMENT,
  };
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
      restoreDom();
      Object.assign(globalThis, prior);
    },
  };
}
test('General keeps the Windows Shell choice through failed preparation and updates it on confirmed retry', async () => {
  const f = fixture(),
    requests: NativeRequest[] = [];
  let settings: NativeShellSettingsFacts = {
    kind: 'settings.general.shell',
    storeId: 'store',
    preference: 'auto',
    automatic: 'powershell',
    gitBashAvailable: false,
    powerShellAvailable: true,
  };
  let saving = Promise.withResolvers<void>();
  let failInitialRead = true;
  const bridge = {
    async request(request: NativeRequest) {
      requests.push(request);
      if (request.method === 'settings.general.shell.read') {
        if (failInitialRead) {
          failInitialRead = false;
          throw Error('windows_shell_asset_changed');
        }
        return settings;
      }
      if (request.method === 'settings.general.shell.save') {
        await saving.promise;
        settings = { ...settings, preference: request.preference };
        return settings;
      }
      return null;
    },
  } as NativeBridge;
  const render = (windowsShell: boolean) =>
    act(async () =>
      f.root.render(
        <NativeGeneralSettings
          bridge={bridge}
          generation={1}
          storeId="store"
          editor="vscode"
          onEditorChange={() => {}}
          windowsShell={windowsShell}
        />,
      ),
    );
  try {
    await render(false);
    expect(f.host.textContent).not.toContain('集成终端 Shell');
    expect(requests.some(({ method }) => method.startsWith('settings.general.shell.'))).toBe(false);
    await render(true);
    expect(f.host.querySelector('[role="alert"]')?.textContent).toBe('暂时无法读取集成终端设置。');
    const retry = [...f.host.querySelectorAll('button')].find(
      (button) => button.textContent === '重新读取',
    )!;
    await act(async () => retry.click());
    const select = f.host.querySelector('[role="combobox"][aria-label="集成终端 Shell"]')!;
    expect(select.textContent).toBe('自动（推荐）');
    expect(f.host.textContent).toContain('仅对新会话生效');
    async function choosePowerShell() {
      await act(async () =>
        select.dispatchEvent(
          new f.dom.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }),
        ),
      );
      const options = [...f.dom.window.document.querySelectorAll<HTMLElement>('[role="option"]')];
      expect(options.map((option) => option.textContent)).toEqual([
        '自动（推荐）',
        'Git Bash（不可用）',
        'Windows PowerShell 5.1',
      ]);
      expect(options[1]?.getAttribute('aria-disabled')).toBe('true');
      await act(async () =>
        options[2]!.dispatchEvent(
          new f.dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
        ),
      );
      expect(select.textContent).toBe('自动（推荐）');
      expect(f.host.querySelector('[role="status"]')?.textContent).toBe('正在保存…');
    }
    const read: NativeRequest = { method: 'settings.general.shell.read', generation: 1 };
    const save: NativeRequest = {
      method: 'settings.general.shell.save',
      generation: 1,
      preference: 'powershell',
    };
    const shellRequests = () =>
      requests.filter(({ method }) => method.startsWith('settings.general.shell.'));
    await choosePowerShell();
    await act(async () => saving.reject(Error('windows_shell_asset_changed')));
    expect(select.textContent).toBe('自动（推荐）');
    expect(f.host.querySelector('[role="status"]')?.textContent).toBeUndefined();
    expect(f.host.querySelector('[role="alert"]')?.textContent).toBe('未确认这次选择，请重试。');
    expect(shellRequests()).toEqual([read, read, save, read]);

    saving = Promise.withResolvers<void>();
    await choosePowerShell();
    expect(f.host.querySelector('[role="alert"]')?.textContent).toBeUndefined();
    await act(async () => saving.resolve());
    expect(select.textContent).toBe('Windows PowerShell 5.1');
    expect(f.host.querySelector('[role="status"]')?.textContent).toBeUndefined();
    expect(shellRequests()).toEqual([read, read, save, read, save]);
  } finally {
    await f.close();
  }
});

test('General displays file preferences without reading model configuration', async () => {
  const f = fixture();
  const requests: NativeRequest[] = [];
  const editors: string[] = [];
  const bridge = {
    watch: () => () => {},
    async request(request: NativeRequest) {
      requests.push(request);
      return null;
    },
  } satisfies NativeBridge;
  try {
    await act(async () =>
      f.root.render(
        <NativeGeneralSettings
          bridge={bridge}
          generation={1}
          editor="vscode"
          onEditorChange={(value) => editors.push(value)}
        />,
      ),
    );
    expect(f.host.textContent).toContain('默认文件打开位置');
    expect(f.host.textContent).not.toContain('模型');
    expect(f.host.querySelectorAll('.settings-row')).toHaveLength(1);
    const editor = f.host.querySelector('[role="combobox"][aria-label="默认编辑器"]')!;
    await act(async () => {
      editor.dispatchEvent(
        new f.dom.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }),
      );
    });
    await act(async () => {
      const choice = [
        ...f.dom.window.document.querySelectorAll<HTMLElement>('[role="option"]'),
      ].find((option) => option.textContent === 'Zed');
      expect(choice).toBeDefined();
      choice!.dispatchEvent(
        new f.dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
      );
    });
    expect(editors).toEqual(['zed']);
    expect(requests).toEqual([]);
  } finally {
    await f.close();
  }
});

test('original Markdown path callbacks apply only to the automatic verified body while unsafe schemes, images and paused bodies remain inert', async () => {
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
  let completeRead!: (value: ModelOutputSnapshot) => void;
  const render = (readOnly = false, suspended = false) =>
    act(async () =>
      f.root.render(
        <NativeModelOutputMessage
          message={message}
          storeId="store"
          suspended={suspended}
          onRead={() => {
            reads++;
            return new Promise((resolve) => {
              completeRead = resolve;
            });
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
    expect(reads).toBe(1);
    expect(f.host.querySelector('.file-link')).toBeNull();
    expect(f.host.querySelector('.model-output-message > button')).toBeNull();
    await act(async () => completeRead(snapshot));
    expect(reads).toBe(1);
    expect(f.host.querySelectorAll('.file-link')).toHaveLength(1);
    await click('原文件');
    expect(opened).toEqual(['space 雪.txt']);
    expect(f.host.querySelectorAll('img')).toHaveLength(0);
    expect(f.host.querySelector('a')!.getAttribute('href')).toBe('https://example.com');
    const fileLink = f.host.querySelector('.file-link')!;
    await render(true);
    expect(f.host.querySelector('.file-link')).toBe(fileLink);
    expect(fileLink.getAttribute('aria-disabled')).toBe('true');
    await click('原文件');
    expect(opened).toEqual(['space 雪.txt']);
    await render();
    expect(f.host.querySelector('.file-link')).toBe(fileLink);
    expect(fileLink.getAttribute('aria-disabled')).toBeNull();
    await click('原文件');
    expect(opened).toEqual(['space 雪.txt', 'space 雪.txt']);
    await render(true, true);
    expect(f.host.querySelector('.message-markdown')!.textContent).toBe('PREVIEW');
    expect(reads).toBe(1);
    expect(opened).toHaveLength(2);
  } finally {
    await f.close();
  }
});
