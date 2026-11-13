import { JSDOM } from 'jsdom';
import { act } from 'react';
import { afterAll, afterEach, expect, test } from '#kite-test';
import { markdownMarkup } from '../markdown-dom.fixture';
import { setEditorText } from '../prompt-editor.fixture';

const dom = new JSDOM('<!doctype html><div id="root"></div>', {
  url: 'http://localhost',
  pretendToBeVisual: true,
});
Object.assign(dom.window.Range.prototype, {
  getBoundingClientRect: () => new dom.window.DOMRect(),
  getClientRects: () => [],
});
dom.window.HTMLElement.prototype.scrollIntoView = () => {};
const originals = new Map<string, PropertyDescriptor | undefined>();
class Clipboard extends dom.window.Event {
  clipboardData: { files: File[]; getData(type: string): string };
  constructor(text: string, files: File[] = []) {
    super('paste', { bubbles: true, cancelable: true });
    this.clipboardData = {
      files,
      getData: (type) => (type === 'text/plain' ? text : '<script>unsafe()</script>'),
    };
  }
}
for (const [key, value] of Object.entries({
  window: dom.window,
  Window: dom.window.Window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  HTMLInputElement: dom.window.HTMLInputElement,
  Event: dom.window.Event,
  CustomEvent: dom.window.CustomEvent,
  addEventListener: dom.window.addEventListener.bind(dom.window),
  removeEventListener: dom.window.removeEventListener.bind(dom.window),
  dispatchEvent: dom.window.dispatchEvent.bind(dom.window),
  DocumentFragment: dom.window.DocumentFragment,
  DOMRect: dom.window.DOMRect,
  ResizeObserver: class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
  IntersectionObserver: class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
  Element: dom.window.Element,
  SVGElement: dom.window.SVGElement,
  Node: dom.window.Node,
  NodeFilter: dom.window.NodeFilter,
  MutationObserver: dom.window.MutationObserver,
  ClipboardEvent: Clipboard,
  DragEvent: dom.window.MouseEvent,
  getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
  cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
  IS_REACT_ACT_ENVIRONMENT: true,
})) {
  originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
}
const { createRoot } = await import('react-dom/client');
const { PromptEditor } = await import('../../src/desktop/PromptEditor');
const { PromptMarkdown } = await import('../../src/desktop/PromptMarkdown');
const { MessageContent } = await import('../../src/desktop/MessageContent');
const { ConversationActivityContext } = await import('../../src/conversation-activity');
const { Composer } = await import('../../src/desktop/Composer');
const { ReadGate } = await import('../../src/desktop/ReadGate');
const { Button } = await import('../../src/desktop/components/ui/button');
let root: ReturnType<typeof createRoot> | undefined;
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  root = undefined;
  document.getElementById('root')!.innerHTML = '';
});
afterAll(() => {
  dom.window.close();
  for (const [key, original] of originals) {
    if (original) Object.defineProperty(globalThis, key, original);
    else Reflect.deleteProperty(globalThis, key);
  }
});
async function render(node: React.ReactNode) {
  root ??= createRoot(document.getElementById('root')!);
  await act(async () => root!.render(node));
}

test('nested read gates retain business state and nodes while blocking buttons, editing and file drops', async () => {
  let clicks = 0,
    files = 0,
    sends = 0;
  const view = (blocked: boolean) => (
    <ReadGate blocked={blocked}>
      <ReadGate blocked={false}>
        <Button onClick={() => clicks++}>操作</Button>
        <Button disabled>业务不可用</Button>
        <PromptEditor
          value="原草稿"
          scopeKey="a"
          label="读取门禁草稿"
          disabled={false}
          onChange={() => {}}
          onSend={() => sends++}
          onFiles={() => files++}
        />
      </ReadGate>
    </ReadGate>
  );
  await render(view(true));
  const [button, unavailable] = document.querySelectorAll<HTMLButtonElement>('button');
  const editor = document.querySelector<HTMLTextAreaElement>('[role="textbox"]')!;
  expect(button!.disabled).toBe(true);
  expect(button!.dataset.disabled).toBeUndefined();
  expect(unavailable!.dataset.disabled).toBe('true');
  expect(editor.readOnly).toBe(true);
  expect(editor.dataset.disabled).toBeUndefined();
  const drop = new dom.window.Event('drop', { bubbles: true, cancelable: true });
  Object.defineProperty(drop, 'dataTransfer', {
    value: { files: [new dom.window.File(['a'], 'a.txt')] },
  });
  await act(async () => {
    button!.click();
    editor.dispatchEvent(drop);
    editor.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  });
  expect([clicks, files, sends]).toEqual([0, 0, 0]);
  await render(view(false));
  expect(document.querySelector('[role="textbox"]') === editor).toBe(true);
  expect(document.querySelector('button') === button).toBe(true);
  expect(editor.readOnly).toBe(false);
  expect(editor.value).toBe('原草稿');
  expect(button!.disabled).toBe(false);
  expect(unavailable!.disabled).toBe(true);
  await act(async () => button!.click());
  expect(clicks).toBe(1);
});
async function chooseAttachment(label: string) {
  await act(async () => {
    document
      .querySelector<HTMLButtonElement>('[aria-label="添加附件"]')!
      .dispatchEvent(
        new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
      );
  });
  const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
    (item) => item.getAttribute('aria-label') === label,
  );
  expect(item).toBeDefined();
  await act(async () => item!.click());
}
async function selectFiles(files: readonly File[]) {
  await act(async () => {
    const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(input, 'files', { configurable: true, value: files });
    input.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  });
}

test('prompt display retains nodes and selection on receipt changes and gates file links by current read access', async () => {
  const paths: string[] = [];
  const text = '**原提示词**\n\n[文件](src/a%20b.ts)';
  const view = (readActive: boolean) => (
    <ConversationActivityContext.Provider value={{ readActive, resume: 0 }}>
      <PromptMarkdown text={text} openFile={(path) => paths.push(path)} />
    </ConversationActivityContext.Provider>
  );
  await render(view(true));
  const paragraph = document.querySelector('.prompt-markdown p')!;
  const link = document.querySelector<HTMLButtonElement>('.file-link')!;
  const range = document.createRange();
  range.selectNodeContents(paragraph);
  window.getSelection()!.removeAllRanges();
  window.getSelection()!.addRange(range);
  const mutations: MutationRecord[] = [];
  const observer = new MutationObserver((records) => mutations.push(...records));
  observer.observe(document.querySelector('.prompt-markdown')!, {
    childList: true,
    subtree: true,
    characterData: true,
  });
  try {
    await render(view(false));
    await act(async () => link.click());
    expect(paths).toEqual([]);
    await render(view(true));
    expect(document.querySelector('.prompt-markdown p')).toBe(paragraph);
    expect(window.getSelection()!.toString()).toBe('原提示词');
    expect(mutations).toHaveLength(0);
    await act(async () => link.click());
    expect(paths).toEqual(['src/a b.ts']);
    await render(<PromptMarkdown text="更新后的正文" />);
    expect(document.querySelector('.prompt-markdown')!.textContent).toBe('更新后的正文');
  } finally {
    observer.disconnect();
  }
});

test('long user prose expands without replacing Markdown and pauses its controls with the reader', async () => {
  const style = document.createElement('style');
  style.textContent = '.prompt-markdown-controls { max-height: 200px; }';
  document.head.append(style);
  const prototype = dom.window.HTMLElement.prototype;
  const originalBounds = prototype.getBoundingClientRect;
  let height = 400;
  prototype.getBoundingClientRect = function () {
    return this.matches('.typeset-chat')
      ? new dom.window.DOMRect(0, 0, 300, height)
      : originalBounds.call(this);
  };
  const view = (readActive: boolean, blocked = false) => (
    <ConversationActivityContext.Provider value={{ readActive, resume: 0 }}>
      <ReadGate blocked={blocked}>
        <PromptMarkdown text={'# 标题\n\n[文件](src/a.ts)'} />
      </ReadGate>
    </ConversationActivityContext.Provider>
  );
  try {
    await render(view(true));
    const markdown = document.querySelector('.prompt-markdown')!;
    const heading = markdown.querySelector('h1')!;
    const button = markdown.querySelector<HTMLButtonElement>('.prompt-markdown-toggle')!;
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(document.getElementById(button.getAttribute('aria-controls')!)).not.toBeNull();
    await act(async () => button.click());
    expect(markdown.getAttribute('data-expanded')).toBe('true');
    expect(markdown.querySelector('h1')).toBe(heading);
    await render(view(false));
    expect(button.disabled).toBe(true);
    await act(async () => button.click());
    expect(markdown.getAttribute('data-expanded')).toBe('true');
    await render(view(true, true));
    expect(button.disabled).toBe(true);
    await render(view(true));
    expect(button.disabled).toBe(false);
    expect(markdown.querySelector('h1')).toBe(heading);
    await act(async () => button.click());
    expect(button.getAttribute('aria-expanded')).toBe('false');
    height = 100;
    await act(async () => window.dispatchEvent(new dom.window.Event('resize')));
    expect(markdown.querySelector('.prompt-markdown-toggle')).toBeNull();
    expect(markdown.textContent).toBe('标题\n文件');
  } finally {
    prototype.getBoundingClientRect = originalBounds;
    style.remove();
  }
});

test('sending keeps the prompt editable and focused while every submission path remains blocked', async () => {
  let changes = '',
    sends = 0;
  const view = (sending: boolean, disabled = sending) => (
    <Composer
      scopeKey="a"
      draft="原提示词"
      active={false}
      stopping={false}
      sending={sending}
      disabled={disabled}
      onChange={(text) => {
        changes = text;
      }}
      onSend={() => sends++}
    />
  );
  await render(view(false));
  const input = document.querySelector<HTMLTextAreaElement>('textarea.prompt-editor')!;
  input.focus();
  await render(view(true));
  expect(document.querySelector('textarea.prompt-editor')).toBe(input);
  expect(document.activeElement).toBe(input);
  expect(input.disabled).toBe(false);
  expect(input.readOnly).toBe(false);
  expect(input.dataset.disabled).toBeUndefined();
  expect(document.querySelector('.composer-action')?.getAttribute('aria-busy')).toBe('true');
  await act(async () => {
    setEditorText(input, '等待期间的新草稿');
    input.dispatchEvent(
      new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    );
    document
      .querySelector('form')!
      .dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
    document.querySelector<HTMLButtonElement>('.composer-action')!.click();
  });
  expect(changes).toBe('等待期间的新草稿');
  expect(sends).toBe(0);
  await render(view(false, true));
  expect(input.disabled).toBe(true);
});
test('the native prompt shows original text while user and Agent messages share Markdown', async () => {
  const value =
    '# 标题\n\n**说明：**正文\n\n| 列 | 值 |\n| :--- | ---: |\n| 表格 | 12 |\n\n$x^2$\n\n<script>unsafe()</script>\n\n![图片](https://invalid.example/a.png)';
  await render(
    <>
      <PromptEditor
        value={value}
        scopeKey="plain"
        label="草稿"
        disabled={false}
        onChange={() => {}}
        onSend={() => {}}
      />
      <PromptMarkdown text={value} />
      <section className="agent-comparison">
        <MessageContent text={value} />
      </section>
    </>,
  );
  const input = document.querySelector<HTMLTextAreaElement>('.prompt-editor')!;
  expect(input.tagName).toBe('TEXTAREA');
  expect(input.value).toBe(value);
  expect(input.querySelector('h1, table, img, script')).toBeNull();
  expect(document.querySelector('.milkdown, .ProseMirror, [contenteditable]')).toBeNull();
  const user = document.querySelector('.prompt-markdown .typeset-chat')!;
  expect(user.querySelector('h1')?.textContent).toBe('标题');
  expect(user.querySelector('strong')?.textContent).toBe('说明：');
  expect(user.querySelectorAll('table')).toHaveLength(1);
  expect(user.querySelectorAll('.katex')).toHaveLength(1);
  expect(user.querySelector('script, img[src^="http"]')).toBeNull();
  expect(markdownMarkup(document.querySelector('.agent-comparison .typeset-chat')!)).toBe(
    markdownMarkup(user),
  );
});

test('plain edits publish exact Markdown immediately and native IME confirmation never sends', async () => {
  const changes: string[] = [],
    files: File[][] = [];
  let sends = 0;
  const value = '**原文**',
    next = '# 标题\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\n';
  await render(
    <PromptEditor
      value={value}
      scopeKey="a"
      label="草稿"
      disabled={false}
      onChange={(text) => changes.push(text)}
      onSend={() => sends++}
      onFiles={(batch) => files.push([...batch])}
    />,
  );
  const input = document.querySelector<HTMLTextAreaElement>('.prompt-editor')!;
  await act(async () => setEditorText(input, next));
  expect(changes).toEqual([next]);
  expect(input.value).toBe(next);
  await act(async () => {
    input.dispatchEvent(
      new dom.window.KeyboardEvent('keydown', {
        key: 'Enter',
        keyCode: 229,
        isComposing: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    input.dispatchEvent(
      new dom.window.KeyboardEvent('keydown', {
        key: 'Enter',
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  expect(sends).toBe(0);
  await act(async () =>
    input.dispatchEvent(
      new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    ),
  );
  expect(sends).toBe(1);
  expect(input.value).toBe(next);
  const file = new dom.window.File(['image'], 'pasted.png', {
    type: 'image/png',
  }) as unknown as File;
  const paste = new Clipboard('must not replace the draft', [file]);
  await act(async () => input.dispatchEvent(paste));
  expect(files).toEqual([[file]]);
  expect(paste.defaultPrevented).toBe(true);
  expect(input.value).toBe(next);
  expect(changes).toEqual([next]);
});

test('plain source echoes keep the control and selection; write gates reject synthetic late input', async () => {
  let value = '原文';
  const changes: string[] = [];
  const view = (blocked = false) => (
    <ReadGate blocked={blocked}>
      <PromptEditor
        value={value}
        scopeKey="echo"
        label="草稿"
        disabled={false}
        onChange={(next) => {
          value = next;
          changes.push(next);
        }}
        onSend={() => {}}
      />
    </ReadGate>
  );
  await render(view());
  const input = document.querySelector<HTMLTextAreaElement>('.prompt-editor')!;
  await act(async () => setEditorText(input, '**输入内容**'));
  input.setSelectionRange(2, 6);
  await render(view());
  expect(document.querySelector('.prompt-editor') === input).toBe(true);
  expect([input.selectionStart, input.selectionEnd]).toEqual([2, 6]);
  await render(view(true));
  expect(input.readOnly).toBe(true);
  expect(input.disabled).toBe(false);
  await act(async () => setEditorText(input, '不允许写入'));
  expect(input.value).toBe('**输入内容**');
  expect(changes).toEqual(['**输入内容**']);
  value = '外部新草稿';
  await render(view());
  expect(input.value).toBe(value);
  expect(input.readOnly).toBe(false);
});

test('plain scope changes preserve normal controls but retire an active old composition', async () => {
  const changes: string[] = [];
  const view = (scope: string, value: string) => (
    <PromptEditor
      value={value}
      scopeKey={scope}
      label="草稿"
      disabled={false}
      onChange={(next) => changes.push(next)}
      onSend={() => {}}
    />
  );
  await render(view('a', '甲草稿'));
  const first = document.querySelector<HTMLTextAreaElement>('.prompt-editor')!;
  await render(view('b', '乙草稿'));
  expect(document.querySelector('.prompt-editor') === first).toBe(true);
  expect(first.value).toBe('乙草稿');
  await act(async () =>
    first.dispatchEvent(
      new dom.window.CompositionEvent('compositionstart', { bubbles: true, data: 'ni' }),
    ),
  );
  await render(view('c', '丙草稿'));
  const next = document.querySelector<HTMLTextAreaElement>('.prompt-editor')!;
  expect(next === first).toBe(false);
  await act(async () => {
    setEditorText(first, '迟到候选');
    first.dispatchEvent(
      new dom.window.CompositionEvent('compositionend', { bubbles: true, data: '迟到候选' }),
    );
  });
  expect(next.value).toBe('丙草稿');
  expect(changes).toEqual([]);
});

test('file picker keeps references separate from text, discards late selections and permits attachment-only send', async () => {
  let resolve!: (files: { name: string; uri: string }[]) => void,
    output: readonly { name: string; uri: string }[] = [],
    sent = 0;
  const props = {
    draft: '原文',
    scopeKey: 'a',
    disabled: false,
    active: false,
    stopping: false,
    onSend: () => sent++,
    onChange: () => {
      throw Error('File selection must not edit the prompt');
    },
    onFilesSelected: (files: readonly { name: string; uri: string }[]) => (output = files),
    onFileReferences: () =>
      new Promise<{ name: string; uri: string }[]>((r) => {
        resolve = r;
      }),
  };
  await render(<Composer {...props} />);
  await chooseAttachment('添加文件');
  const pdf = new dom.window.File(['pdf'], '报告(1).pdf', {
    type: 'application/pdf',
  }) as unknown as File;
  await selectFiles([pdf]);
  await render(<Composer {...props} draft="新输入" />);
  await act(async () => resolve([{ name: '报告(1).pdf', uri: 'file:///C:/report(1).pdf' }]));
  expect(output).toEqual([{ name: '报告(1).pdf', uri: 'file:///C:/report(1).pdf' }]);
  expect(document.querySelector<HTMLTextAreaElement>('[role="textbox"]')?.value).toBe('新输入');
  await chooseAttachment('添加文件');
  await selectFiles([pdf]);
  output = [];
  await render(<Composer {...props} scopeKey="b" />);
  await act(async () => resolve([{ name: 'late', uri: 'file:///late' }]));
  expect(output).toEqual([]);
  await render(
    <Composer
      {...props}
      draft=""
      files={[{ id: 'file', name: '报告.pdf', uri: 'file:///report.pdf' }]}
      images={[{ id: 'image', name: 'pasted.png', url: 'blob:fixture' }]}
    />,
  );
  await act(async () =>
    document
      .querySelector('form')!
      .dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true })),
  );
  expect(sent).toBe(1);
  expect(document.querySelector('[aria-label="待发送附件"]')?.textContent).toContain('报告.pdf');
  expect(document.querySelector<HTMLTextAreaElement>('[role="textbox"]')?.value).toBe('');
});

test('ordinary file preparation keeps cancellation and send blocking without progress copy or accepting a late result', async () => {
  const signals: AbortSignal[] = [];
  let resolve!: (files: { name: string; uri: string }[]) => void;
  let accepted: readonly { name: string; uri: string }[] = [];
  const props = {
    draft: '保留草稿',
    scopeKey: 'a',
    disabled: false,
    active: false,
    stopping: false,
    onChange: () => {},
    onSend: () => {},
    onFilesSelected: (files: readonly { name: string; uri: string }[]) => {
      accepted = files;
    },
    onFileReferences: (_files: readonly File[], signal?: AbortSignal) => {
      signals.push(signal!);
      return new Promise<{ name: string; uri: string }[]>((done) => {
        resolve = done;
      });
    },
  };
  const file = new dom.window.File(['text'], 'report.txt') as unknown as File;
  await render(<Composer {...props} />);
  await chooseAttachment('添加文件');
  await selectFiles([file]);
  const preparation = document.querySelector('[role="status"]')!;
  expect(preparation.getAttribute('aria-label')).toBe('正在添加附件');
  expect(preparation.textContent).toBe('取消添加');
  expect(preparation.querySelector('.animate-spin')).not.toBeNull();
  expect(document.querySelector<HTMLButtonElement>('[aria-label="发送消息"]')?.disabled).toBe(true);
  const cancel = [...document.querySelectorAll('button')].find(
    (button) => button.textContent === '取消添加',
  )!;
  await act(async () => cancel.click());
  expect(signals[0]!.aborted).toBe(true);
  await act(async () => resolve([{ name: 'late', uri: 'file:///late' }]));
  expect(accepted).toEqual([]);
  expect(document.querySelector('[role="status"]')).toBeNull();
  expect(document.querySelector<HTMLTextAreaElement>('[role="textbox"]')?.value).toBe('保留草稿');
  await chooseAttachment('添加文件');
  await selectFiles([file]);
  expect(signals[1]!.aborted).toBe(false);
  await act(async () => resolve([{ name: 'report.txt', uri: 'file:///report.txt' }]));
  expect(accepted).toEqual([{ name: 'report.txt', uri: 'file:///report.txt' }]);
  expect(document.querySelector('[role="status"]')).toBeNull();
});

test('a prepared ordinary file arriving after the composer becomes unavailable is released without changing the draft', async () => {
  for (const unavailable of ['disabled', 'promptHidden'] as const) {
    let signal!: AbortSignal;
    let finish!: (files: readonly { name: string; uri: string }[]) => void;
    let accepted = 0;
    const props = {
      scopeKey: unavailable,
      draft: '保留未发送的正文',
      disabled: false,
      active: false,
      stopping: false,
      onChange: () => {
        throw Error('preparation must preserve draft');
      },
      onFileReferences: (_files: readonly File[], owner?: AbortSignal) => {
        signal = owner!;
        return new Promise<readonly { name: string; uri: string }[]>((resolve) => {
          finish = resolve;
        });
      },
      onFilesSelected: () => {
        accepted++;
      },
    };
    await render(<Composer {...props} />);
    await chooseAttachment('添加文件');
    await selectFiles([new dom.window.File(['saved'], 'late.txt') as unknown as File]);
    await render(<Composer {...props} {...{ [unavailable]: true }} />);
    await act(async () => finish([{ name: 'late.txt', uri: 'file:///late.txt' }]));
    expect(signal.aborted).toBe(true);
    expect(accepted).toBe(0);
    await render(<Composer {...props} />);
    expect(document.querySelector<HTMLTextAreaElement>('[role="textbox"]')?.value).toBe(
      props.draft,
    );
    expect(document.body.textContent).not.toContain('正在保存附件');
  }
});

test('one file selection automatically separates images from path references, cancels stale selections and never edits text', async () => {
  const images: File[][] = [];
  const references: File[][] = [];
  let paths: readonly { name: string; uri: string }[] = [];
  const props = {
    scopeKey: 'a',
    draft: '正文',
    disabled: false,
    active: false,
    stopping: false,
    onChange: () => {
      throw Error('Image selection must not edit text');
    },
    onImageFiles: (files: readonly File[]) => images.push([...files]),
    onFileReferences: (files: readonly File[]) => {
      references.push([...files]);
      return [{ name: files[0]!.name, uri: 'file:///report.pdf' }];
    },
    onFilesSelected: (files: readonly { name: string; uri: string }[]) => {
      paths = files;
    },
  };
  await render(<Composer {...props} />);
  const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
  expect(input.accept).toBe('');
  expect(input.multiple).toBe(true);
  const file = new dom.window.File(['image'], 'selected.png', {
    type: 'image/png',
  }) as unknown as File;
  const pdf = new dom.window.File(['pdf'], 'report.pdf', {
    type: 'application/pdf',
  }) as unknown as File;
  await chooseAttachment('添加文件');
  expect(document.querySelector('[aria-label="添加图片"]')).toBeNull();
  await selectFiles([file, pdf]);
  expect(images).toEqual([[file]]);
  expect(references).toEqual([[pdf]]);
  expect(paths).toEqual([{ name: 'report.pdf', uri: 'file:///report.pdf' }]);
  await chooseAttachment('添加文件');
  await act(async () => input.dispatchEvent(new dom.window.Event('cancel', { bubbles: true })));
  await selectFiles([file]);
  expect(images).toHaveLength(1);
  await chooseAttachment('添加文件');
  await render(<Composer {...props} scopeKey="b" />);
  await selectFiles([file]);
  expect(images).toHaveLength(1);
  expect(document.querySelector<HTMLTextAreaElement>('[role="textbox"]')?.value).toBe('正文');
});
test('file picker explains an unloaded host, preserves the draft and keeps ordinary failure details private', async () => {
  let code = 'file_picker_restart_required',
    changes = 0,
    sends = 0;
  const props = {
    draft: '尚未发送的原文',
    disabled: false,
    active: false,
    stopping: false,
    onChange: () => {
      changes++;
    },
    onSend: () => {
      sends++;
    },
    onFileReferences: async () => {
      throw Object.assign(Error('private host details C:/private'), { code });
    },
  };
  await render(<Composer {...props} />);
  await chooseAttachment('添加文件');
  const file = new dom.window.File(['text'], 'file.txt') as unknown as File;
  await selectFiles([file]);
  expect(document.querySelector('[role="alert"]')?.textContent).toBe(
    '文件选择功能尚未加载，请完全退出并重新打开应用。',
  );
  expect(document.querySelector<HTMLTextAreaElement>('[role="textbox"]')?.value).toBe(props.draft);
  code = 'temporary_picker_failure';
  await chooseAttachment('添加文件');
  await selectFiles([file]);
  expect(document.querySelector('[role="alert"]')?.textContent).toBe('无法添加文件，请重试。');
  expect(document.body.textContent).not.toContain('private host details');
  expect(changes).toBe(0);
  expect(sends).toBe(0);
});

test('the unified entry limits image counts before dispatch, including mixed selections, repeated paste and drop; removing a picture restores capacity', async () => {
  let batches = 0,
    references = 0;
  const image = new dom.window.File(['png'], 'image.png', { type: 'image/png' }) as unknown as File;
  const pdf = new dom.window.File(['pdf'], 'report.pdf', {
    type: 'application/pdf',
  }) as unknown as File;
  const props = {
    scopeKey: 'count',
    draft: '原文',
    disabled: false,
    active: false,
    stopping: false,
    onChange: () => {
      throw Error('attachments must not change text');
    },
    onImageFiles: () => {
      batches++;
    },
    onFileReferences: () => {
      references++;
      return [{ name: 'report.pdf', uri: 'file:///report.pdf' }];
    },
  };
  await render(<Composer {...props} />);
  await chooseAttachment('添加文件');
  await selectFiles([...Array<File>(11).fill(image), pdf]);
  expect(batches).toBe(0);
  expect(references).toBe(0);
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('10 张');
  await chooseAttachment('添加文件');
  await selectFiles(Array<File>(10).fill(image));
  expect(batches).toBe(1);
  const images = Array.from({ length: 10 }, (_, index) => ({
    id: String(index),
    name: 'image.png',
    url: 'blob:fixture',
  }));
  await render(<Composer {...props} images={images} />);
  const editor = document.querySelector<HTMLTextAreaElement>('[role="textbox"]')!;
  await act(async () => editor.dispatchEvent(new Clipboard('', [image])));
  const drop = new dom.window.Event('drop', { bubbles: true, cancelable: true });
  Object.defineProperty(drop, 'dataTransfer', { value: { files: [image], types: ['Files'] } });
  await act(async () => editor.dispatchEvent(drop));
  expect(batches).toBe(1);
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('10 张');
  await render(<Composer {...props} images={images.slice(1)} />);
  await act(async () => editor.dispatchEvent(new Clipboard('', [image])));
  expect(batches).toBe(2);
  expect(editor.value).toBe('原文');
});
