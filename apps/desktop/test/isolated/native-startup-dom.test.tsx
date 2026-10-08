import { expect, test } from 'bun:test';
import { JSDOM } from 'jsdom';
import { act } from 'react';
import type {
  NativeBridge,
  NativeDirectory,
  NativeEvent,
  NativeRequest,
  NativeResult,
  NativeStartupBridge,
  NativeState,
} from '../../src/native-bridge';
import { prepareDesktopDom } from '../native-page-dom.fixture';

const bootstrap = new JSDOM('<div></div>', { pretendToBeVisual: true });
const originals = {
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
const { NativeDesktop } = await import('../../src/native');
Object.assign(globalThis, originals);
bootstrap.window.close();

const empty: NativeDirectory = { storeId: 'store', workspaces: [], sessions: [] };
const state = (generation: number, directory?: NativeDirectory): NativeState => ({
  generation,
  directory,
  creationSubmissions: [],
  inputSubmissions: [],
  permissionSubmissions: [],
  interactionSubmissions: [],
});
function fixture(
  read: (request: NativeRequest) => NativeResult | Promise<NativeResult>,
  hostBridge: Partial<NativeStartupBridge> = {},
) {
  const dom = new JSDOM('<div id="root"></div>', {
    url: 'http://localhost',
    pretendToBeVisual: true,
  });
  const restore = prepareDesktopDom(dom),
    prior = {
      window: globalThis.window,
      document: globalThis.document,
      navigator: globalThis.navigator,
    };
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const calls: NativeRequest[] = [],
    listeners = new Set<(event: NativeEvent) => void>();
  const bridge: NativeBridge & Partial<NativeStartupBridge> = {
    ...hostBridge,
    request: async (request) => {
      calls.push(request);
      if (request.method === 'conversation.models.read')
        return {
          kind: 'settings.models',
          observationId: 1,
          scope: 'user',
          storeId: 'store',
          canWrite: false,
          defaultModelId: null,
          errors: ['model_not_configured'],
          models: [],
        };
      return read(request);
    },
    watch: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  Object.assign(dom.window, { kiteNative: bridge });
  const host = dom.window.document.getElementById('root')!,
    root = createRoot(host);
  return {
    dom,
    host,
    root,
    calls,
    render: () => act(async () => root.render(<NativeDesktop />)),
    notify: (generation: number) =>
      act(async () => {
        for (const listener of listeners) listener({ kind: 'changed', generation });
      }),
    retry: () =>
      act(async () => {
        const button = [...host.querySelectorAll('button')].find(
          (button) => button.textContent === '重新尝试',
        )!;
        button.click();
        button.click();
      }),
    async close() {
      await act(async () => root.unmount());
      dom.window.close();
      restore();
      Object.assign(globalThis, prior);
    },
  };
}

test('retained startup hides the entire product until admitted attach and the complete initial directory; empty projects and missing models still enter the original page', async () => {
  let attach!: (value: NativeState) => void, directory!: (value: NativeDirectory) => void;
  const attaching = new Promise<NativeState>((resolve) => {
      attach = resolve;
    }),
    reading = new Promise<NativeDirectory>((resolve) => {
      directory = resolve;
    });
  let observed = { ...empty, unavailable: true };
  const f = fixture((request) => {
    if (request.method === 'attach') return attaching;
    if (request.method === 'directory') return reading;
    if (request.method === 'state') return state(1, observed);
    return null;
  });
  try {
    await f.render();
    expect(f.host.querySelector('main[aria-label="kite 启动页"]')?.getAttribute('aria-busy')).toBe(
      'true',
    );
    expect(f.host.querySelector('.shell')).toBeNull();
    expect(f.host.querySelector('textarea')).toBeNull();
    expect(f.calls.map((request) => request.method)).toEqual(['attach']);
    await act(async () => attach(state(1)));
    expect(f.host.querySelector('.shell')).toBeNull();
    expect(f.calls.map((request) => request.method)).toEqual(['attach', 'directory']);
    await act(async () => directory(observed));
    expect(f.host.querySelector('.shell')).toBeNull();
    observed = { ...empty, unavailable: false };
    await f.notify(1);
    expect(f.host.querySelector('main[aria-label="kite 启动页"]')).toBeNull();
    expect(f.host.querySelector('.kite-client.shell')).not.toBeNull();
    expect(f.host.querySelector('textarea[aria-label="新对话草稿"]')).not.toBeNull();
    expect(f.host.textContent).toContain('没有已启用且配置可用的默认模型，请选择模型。');
    expect(
      f.calls.every((request) =>
        ['attach', 'directory', 'state', 'conversation.models.read'].includes(request.method),
      ),
    ).toBe(true);
  } finally {
    await f.close();
  }
});

test('startup failures retry explicitly once; a late previous observation and post-ready connection failure preserve the entered page and draft with zero work', async () => {
  let mode = 'attach-fails',
    generation = 0;
  let release!: (value: NativeState) => void;
  const held = new Promise<NativeState>((resolve) => {
    release = resolve;
  });
  const f = fixture((request) => {
    if (request.method === 'attach') {
      if (mode === 'attach-fails') throw Error('native_connection_unavailable');
      return state(++generation);
    }
    if (request.method === 'directory') {
      if (mode === 'directory-fails') throw Error('session_directory_unavailable');
      return empty;
    }
    if (request.method === 'state') {
      if (mode === 'late') return held;
      if (mode === 'connection-fails') throw Error('native_connection_unavailable');
      return state(generation, empty);
    }
    return null;
  });
  try {
    await f.render();
    expect(f.host.querySelector('[role="alert"]')?.textContent).toContain(
      'native_connection_unavailable',
    );
    expect(f.host.querySelector('.shell')).toBeNull();
    mode = 'directory-fails';
    await f.retry();
    expect(f.calls.filter((request) => request.method === 'attach').length).toBe(2);
    expect(f.host.querySelector('[role="alert"]')?.textContent).toContain(
      'session_directory_unavailable',
    );
    expect(f.host.querySelector('.shell')).toBeNull();
    mode = 'late';
    await f.notify(generation);
    mode = 'ready';
    await f.retry();
    expect(f.calls.filter((request) => request.method === 'attach').length).toBe(3);
    expect(f.host.querySelector('.kite-client.shell')).not.toBeNull();
    await act(async () =>
      release(
        state(1, {
          storeId: 'obsolete',
          workspaces: [{ id: 'old', name: 'old scope', rootUri: 'file:///old' }],
          sessions: [],
        }),
      ),
    );
    expect(f.host.textContent).not.toContain('old scope');
    expect(f.host.querySelector('main[aria-label="kite 启动页"]')).toBeNull();
    const draft = f.host.querySelector<HTMLTextAreaElement>('textarea[aria-label="新对话草稿"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        f.dom.window.HTMLTextAreaElement.prototype,
        'value',
      )!.set!.call(draft, '保留原草稿\n雪🙂');
      draft.dispatchEvent(new f.dom.window.Event('input', { bubbles: true }));
    });
    mode = 'connection-fails';
    await f.notify(generation);
    expect(f.host.querySelector('main[aria-label="kite 启动页"]')).toBeNull();
    expect(f.host.querySelector('.kite-client.shell')).not.toBeNull();
    expect(draft.value).toBe('保留原草稿\n雪🙂');
    expect(f.calls.filter((request) => request.method === 'attach').length).toBe(3);
    expect(
      f.calls.every((request) =>
        ['attach', 'directory', 'state', 'detach', 'conversation.models.read'].includes(
          request.method,
        ),
      ),
    ).toBe(true);
  } finally {
    await f.close();
  }
});

test('retained save button requires the Service diagnostic; fixed save failure and explicit retry preserve startup boundaries', async () => {
  let failed = true,
    saves = 0;
  const f = fixture(
    (request) => {
      if (request.method === 'attach') {
        if (failed) throw Error('required_capability_missing');
        return state(1);
      }
      if (request.method === 'directory') return empty;
      return null;
    },
    {
      startupStatus: async () => ({ diagnosticAvailable: true }),
      saveStartupDiagnostic: async () => {
        saves++;
        if (saves === 1) throw Error('/private/user credential session-content');
        return false;
      },
    },
  );
  const save = () =>
    act(async () => {
      [...f.host.querySelectorAll('button')]
        .find((button) => button.textContent === '保存诊断')!
        .click();
    });
  try {
    await f.render();
    expect(f.host.textContent).toContain('保存诊断');
    await save();
    expect(f.host.textContent).toContain('保存启动诊断失败，请选择新的文件名并重试。');
    expect(f.host.textContent).not.toContain('credential');
    await save();
    expect(f.host.textContent).not.toContain('保存启动诊断失败');
    expect(saves).toBe(2);
    expect(f.calls.map((call) => call.method)).toEqual(['attach']);
    failed = false;
    await f.retry();
    expect(f.host.querySelector('main[aria-label="kite 启动页"]')).toBeNull();
    expect(f.host.textContent).not.toContain('保存诊断');
    expect(f.calls.filter((call) => call.method === 'attach').length).toBe(2);
  } finally {
    await f.close();
  }
});
