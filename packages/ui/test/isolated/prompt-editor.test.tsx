import { afterAll, afterEach, expect, test } from 'bun:test';
import { JSDOM } from 'jsdom';
import { act, createRef } from 'react';
import type { PromptEditorHandle } from '../../src/desktop/PromptEditor';

const dom = new JSDOM('<div id="root"></div>', {
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
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  HTMLInputElement: dom.window.HTMLInputElement,
  Event: dom.window.Event,
  CustomEvent: dom.window.CustomEvent,
  Element: dom.window.Element,
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
const { Composer } = await import('../../src/desktop/Composer');
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
test('live Markdown preserves original source until editing, pastes plain Markdown safely, isolates scopes and respects IME', async () => {
  const ref = createRef<PromptEditorHandle>(),
    changes: string[] = [],
    images: File[][] = [];
  let sends = 0;
  const props = {
    value: '# 标题\n\n**强调** 和 `代码`',
    scopeKey: 'a',
    label: '任务输入',
    disabled: false,
    inputRef: ref,
    onChange: (value: string) => changes.push(value),
    onSend: () => sends++,
    onFiles: (files: readonly File[]) => images.push([...files]),
  };
  await render(<PromptEditor {...props} />);
  expect(document.querySelector('h1')?.textContent).toBe('标题');
  expect(document.querySelector('.prompt-bold')?.textContent).toBe('强调');
  expect(changes).toEqual([]);
  await act(async () => ref.current!.moveCaretToEnd());
  const input = document.querySelector<HTMLElement>('[role="textbox"]')!;
  await act(async () => {
    input.dispatchEvent(new Clipboard('\n\n> 引用\n\n- 项目'));
  });
  expect(input.querySelector('blockquote')?.textContent).toBe('引用');
  expect(input.querySelector('li')?.textContent).toBe('项目');
  expect(input.querySelector('script')).toBeNull();
  expect(changes.at(-1)).toContain('引用');
  for (const options of [
    { key: 'Enter', shiftKey: true },
    { key: 'Enter', isComposing: true },
    { key: 'Enter', keyCode: 229 },
  ])
    await act(async () => {
      input.dispatchEvent(
        new dom.window.KeyboardEvent('keydown', { ...options, bubbles: true, cancelable: true }),
      );
    });
  expect(sends).toBe(0);
  await act(async () => {
    input.dispatchEvent(
      new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    );
  });
  expect(sends).toBe(1);
  const file = new dom.window.File(['image'], 'pasted.png', {
    type: 'image/png',
  }) as unknown as File;
  await act(async () => {
    input.dispatchEvent(new Clipboard('', [file]));
  });
  expect(images).toEqual([[file]]);
  const before = changes.length;
  await render(<PromptEditor {...props} value="另一会话" scopeKey="b" />);
  expect(input.textContent).toBe('另一会话');
  expect(changes).toHaveLength(before);
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
  expect(document.querySelector('[role="textbox"]')?.textContent).toBe('新输入');
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
  expect(document.querySelector('[role="textbox"]')?.textContent).toBe('');
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
  expect(document.querySelector('[role="textbox"]')?.textContent).toBe('正文');
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
  expect(document.querySelector('[role="textbox"]')?.textContent).toBe(props.draft);
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
  const editor = document.querySelector<HTMLElement>('[role="textbox"]')!;
  await act(async () => editor.dispatchEvent(new Clipboard('', [image])));
  const drop = new dom.window.Event('drop', { bubbles: true, cancelable: true });
  Object.defineProperty(drop, 'dataTransfer', { value: { files: [image], types: ['Files'] } });
  await act(async () => editor.dispatchEvent(drop));
  expect(batches).toBe(1);
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('10 张');
  await render(<Composer {...props} images={images.slice(1)} />);
  await act(async () => editor.dispatchEvent(new Clipboard('', [image])));
  expect(batches).toBe(2);
  expect(editor.textContent).toBe('原文');
});
