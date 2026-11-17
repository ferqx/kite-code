import { expect, test } from 'bun:test';
import { JSDOM } from 'jsdom';
import { act, useState } from 'react';
import type { NativeBridge, NativeRequest } from '../../src/native-bridge';
import { useNativeInputImages } from '../../src/native-input-images';
import { installImagePreviewWorker } from '../image-preview-worker.fixture';
import { prepareDesktopDom, promptValue, setPromptText } from '../native-page-dom.fixture';

test('Native attachments preserve original scopes and distinguish an outdated Main from ordinary picker failures', async () => {
  const dom = new JSDOM('<div id="root"></div>', { pretendToBeVisual: true });
  const old = {
    window: globalThis.window,
    document: globalThis.document,
    navigator: globalThis.navigator,
    FileReader: globalThis.FileReader,
    createObjectURL: URL.createObjectURL,
    revokeObjectURL: URL.revokeObjectURL,
  };
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    FileReader: dom.window.FileReader,
    IS_REACT_ACT_ENVIRONMENT: true,
  });

  const restoreWorker = installImagePreviewWorker();
  URL.createObjectURL = () => 'blob:fixture';
  URL.revokeObjectURL = () => {};
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(document.getElementById('root')!),
    calls: NativeRequest[] = [];
  let failure: string | undefined;
  let beginWait: Promise<void> | undefined;
  const files = [{ name: 'reference.pdf', uri: 'file:///C:/reference.pdf' }];
  const bridge = {
    fileReferences: (selected: readonly File[]) => {
      if (failure) throw Error(failure);
      return selected.length ? files : [];
    },
    request: async (request: NativeRequest) => {
      calls.push(request);
      if (request.method === 'input.images.begin' && failure)
        throw Object.assign(Error(failure), { code: failure });
      if (request.method === 'input.images.begin') await beginWait;
      return null;
    },
    watch: () => () => {},
  } as NativeBridge;
  let images!: ReturnType<typeof useNativeInputImages>;
  function Fixture({ generation }: { generation: number }) {
    images = useNativeInputImages(bridge, generation, 'store');
    return <div>{images.get('a').length}</div>;
  }
  try {
    await act(async () => root.render(<Fixture generation={1} />));
    const file = new dom.window.File([new Uint8Array([1, 2, 3])], 'original.png', {
      type: 'image/png',
    }) as unknown as File;
    const oversized = new dom.window.File(['small'], 'oversized.png', {
      type: 'image/png',
    }) as unknown as File;
    Object.defineProperty(oversized, 'size', { value: 16 * 1024 * 1024 + 1 });
    await act(async () =>
      images.addFiles(
        'full-files',
        Array.from({ length: 128 }, (_, i) => ({ name: `${i}.txt`, uri: `file:///${i}.txt` })),
      ),
    );
    expect(() => images.validateAttachments('full-files', [file], [{ name: 'new.txt' }])).toThrow(
      'input_file_count_limit',
    );
    expect(() =>
      images.validateAttachments('full-files', [], [{ name: '0.txt', uri: 'file:///0.txt' }]),
    ).not.toThrow();
    expect(images.get('full-files')).toEqual([]);
    expect(images.files('full-files')).toHaveLength(128);
    const before = calls.length;
    await expect(images.add('invalid-batch', [file, oversized])).rejects.toThrow(
      'input_image_too_large',
    );
    expect(images.get('invalid-batch')).toEqual([]);
    expect(calls).toHaveLength(before);
    await expect(
      images.add('invalid-batch', [
        file,
        new dom.window.File(['svg'], 'bad.svg', { type: 'image/svg+xml' }) as unknown as File,
      ]),
    ).rejects.toThrow('input_image_type');
    expect(images.get('invalid-batch')).toEqual([]);
    await act(async () => images.add('a', [file]));
    const draft = images.get('a')[0]!;
    expect(draft.loading).toBe(false);
    const source = draft.previewSource;
    expect(source && 'load' in source).toBe(true);
    if (!source?.load) throw Error('original_source_missing');
    const original = await source.load(new AbortController().signal);
    const originalBytes = await new Promise<ArrayBuffer>((resolve) => {
      const reader = new dom.window.FileReader();
      reader.onload = () => resolve(reader.result as ArrayBuffer);
      reader.readAsArrayBuffer(original as unknown as Blob);
    });
    expect([...new Uint8Array(originalBytes)]).toEqual([1, 2, 3]);
    expect(original.type).toBe('image/png');
    expect(await source.load(new AbortController().signal)).toBe(original);
    const aborted = new AbortController();
    aborted.abort();
    await expect(source.load(aborted.signal)).rejects.toThrow();
    expect(images.get('b')).toEqual([]);
    expect(calls.find((request) => request.method === 'input.images.begin')).toMatchObject({
      name: 'original.png',
      mediaType: 'image/png',
      size: 3,
      generation: 1,
    });
    expect(calls.find((request) => request.method === 'input.images.append')).toMatchObject({
      id: draft.id,
      offset: 0,
      data: 'AQID',
    });
    const display = window.kiteNativeImageDisplay;
    images.previews.clear();
    delete window.kiteNativeImageDisplay;
    await act(async () =>
      images.add('preview-failure', [
        new dom.window.File([new Uint8Array([4, 5, 6])], 'still-send.png', {
          type: 'image/png',
        }) as unknown as File,
      ]),
    );
    const failedPreview = images.get('preview-failure')[0]!;
    expect(failedPreview.previewError).toBe('预览不可用');
    expect(failedPreview.error).toBeUndefined();
    expect(failedPreview.loading).toBe(false);
    expect(
      calls.find(
        (request) => request.method === 'input.images.append' && request.id === failedPreview.id,
      ),
    ).toMatchObject({ data: 'BAUG' });
    const failedPreviewSource = failedPreview.previewSource;
    if (!failedPreviewSource?.load) throw Error('preview_failure_lost_original');
    expect((await failedPreviewSource.load(new AbortController().signal)).size).toBe(3);
    await act(async () => images.removeIds([failedPreview.id]));
    await expect(failedPreviewSource.load(new AbortController().signal)).rejects.toThrow(
      'input_image_draft_inactive',
    );
    window.kiteNativeImageDisplay = display;
    await act(async () => images.addFiles('a', files));
    await act(async () => images.addFiles('a', files));
    expect(images.files('a')).toHaveLength(1);
    expect(images.files('b')).toEqual([]);
    const fileId = images.files('a')[0]!.id;
    await act(async () => images.move('a', 'moved'));
    expect(images.files('a')).toEqual([]);
    expect(images.get('moved')[0]?.id).toBe(draft.id);
    await expect(source.load(new AbortController().signal)).rejects.toThrow(
      'input_image_draft_inactive',
    );
    const movedSource = images.get('moved')[0]!.previewSource;
    if (!movedSource?.load) throw Error('moved_original_source_missing');
    expect(await movedSource.load(new AbortController().signal)).toBe(original);
    expect(images.files('moved')[0]?.id).toBe(fileId);
    await act(async () => images.removeIds([fileId]));
    expect(images.files('moved')).toEqual([]);
    expect(images.get('moved')).toHaveLength(1);
    await act(async () => root.render(<Fixture generation={2} />));
    expect(images.get('a')).toEqual([]);
    await expect(movedSource.load(new AbortController().signal)).rejects.toThrow(
      'input_image_draft_inactive',
    );
    expect(document.getElementById('root')!.textContent).toBe('0');
    expect(calls).toContainEqual({ method: 'input.images.release', generation: 1, id: draft.id });
    const prepared = await images.fileReferences([file]);
    expect(prepared).toMatchObject([{ ...files[0], prepared: true }]);
    expect(calls.find((request) => request.method === 'input.files.append')).toMatchObject({
      data: new Uint8Array([1, 2, 3]),
    });
    expect(await images.fileReferences([])).toEqual([]);
    const resolver = bridge.fileReferences;
    delete bridge.fileReferences;
    let unavailable: unknown;
    try {
      await images.fileReferences([file]);
    } catch (error) {
      unavailable = error;
    }
    expect((unavailable as Error).message).toBe('file_picker_restart_required');
    bridge.fileReferences = resolver;
    failure = 'temporary_picker_failure';
    let failedPicker: unknown;
    try {
      await images.fileReferences([file]);
    } catch (error) {
      failedPicker = error;
    }
    expect((failedPicker as Error).message).toBe('temporary_picker_failure');
    failure = 'invalid_native_request';
    await act(async () => {
      expect(await images.add('a', [file])).toEqual({
        error: '图片附件功能尚未加载，请完全退出并重新打开应用。',
      });
    });
    expect(images.get('a')[0]?.error).toBe('图片附件功能尚未加载，请完全退出并重新打开应用。');
    expect(images.get('a')[0]?.errorKind).toBe('system');
    failure = undefined;
    let release!: () => void;
    beginWait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const large = new dom.window.File([new Uint8Array(16 * 1024 * 1024)], 'large.png', {
      type: 'image/png',
    }) as unknown as File;
    const readBuffer = dom.window.FileReader.prototype.readAsArrayBuffer;
    let reads = 0;
    dom.window.FileReader.prototype.readAsArrayBuffer = function (blob) {
      reads++;
      return readBuffer.call(this, blob);
    };
    let preparing!: ReturnType<typeof images.add>;
    await act(async () => {
      preparing = images.add('batch', [large, large, large, large]);
      await expect(images.add('other-scope', [file])).rejects.toThrow('input_image_total_limit');
    });
    expect(images.get('batch')).toHaveLength(4);
    expect(images.get('other-scope')).toEqual([]);
    for (
      let i = 0;
      i < 100 &&
      !calls.some(
        (request) => request.method === 'input.images.begin' && request.name === 'large.png',
      );
      i++
    )
      await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
    expect(
      calls.some(
        (request) => request.method === 'input.images.begin' && request.name === 'large.png',
      ),
    ).toBe(true);
    expect(reads).toBe(1);
    await act(async () => {
      images.removeIds(images.get('batch').map((image) => image.id));
      release();
      await preparing;
    });
    expect(reads).toBe(1);
    expect(images.get('batch')).toEqual([]);
    let resumeCount!: () => void;
    beginWait = new Promise<void>((resolve) => {
      resumeCount = resolve;
    });
    let nine!: ReturnType<typeof images.add>;
    await act(async () => {
      nine = images.add('count', Array<File>(9).fill(file));
    });
    const beforeRejected = reads;
    await expect(images.add('count', [file, file])).rejects.toThrow('input_image_count_limit');
    expect(images.get('count')).toHaveLength(9);
    expect(reads).toBe(beforeRejected);
    let tenth!: ReturnType<typeof images.add>, replacement!: ReturnType<typeof images.add>;
    await act(async () => {
      tenth = images.add('count', [file]);
    });
    expect(images.get('count')).toHaveLength(10);
    await expect(images.add('count', [file])).rejects.toThrow('input_image_count_limit');
    await act(async () => {
      images.removeIds([images.get('count').at(-1)!.id]);
      replacement = images.add('count', [file]);
    });
    expect(images.get('count')).toHaveLength(10);
    await act(async () => {
      images.removeIds(images.get('count').map((image) => image.id));
      resumeCount();
      await Promise.all([nine, tenth, replacement]);
    });
    dom.window.FileReader.prototype.readAsArrayBuffer = readBuffer;
  } finally {
    await act(async () => root.unmount());
    const { createObjectURL, revokeObjectURL, ...globals } = old;
    Object.assign(globalThis, globals);
    URL.createObjectURL = createObjectURL;
    URL.revokeObjectURL = revokeObjectURL;
    dom.window.close();
    restoreWorker();
  }
});

test('real Composer switches scopes during image encoding and removes only the selected attachment without finishing cancelled bytes', async () => {
  const dom = new JSDOM('<div id="root"></div>', { pretendToBeVisual: true });
  const restoreLayout = prepareDesktopDom(dom);
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    navigator: globalThis.navigator,
    FileReader: globalThis.FileReader,
    createObjectURL: URL.createObjectURL,
    revokeObjectURL: URL.revokeObjectURL,
  };
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    FileReader: dom.window.FileReader,
    IS_REACT_ACT_ENVIRONMENT: true,
  });

  const restoreWorker = installImagePreviewWorker();
  const revoked: string[] = [];
  URL.createObjectURL = () => 'blob:encoding';
  URL.revokeObjectURL = (url) => revoked.push(url);
  const { createRoot } = await import('react-dom/client');
  const { Composer } = await import('../../../../packages/ui/src/desktop/Composer');
  const root = createRoot(document.getElementById('root')!);
  const calls: NativeRequest[] = [];
  let reached!: () => void, release!: () => void;
  const appended = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  const bridge = {
    request: async (request: NativeRequest) => {
      calls.push(request);
      if (request.method === 'input.images.append') {
        reached();
        await wait;
      }
      return null;
    },
    watch: () => () => {},
  } as NativeBridge;
  let attachments!: ReturnType<typeof useNativeInputImages>;
  function Fixture() {
    const [scope, setScope] = useState('a');
    const [texts, setTexts] = useState<Record<string, string>>({ a: '原文 A', b: '原文 B' });
    attachments = useNativeInputImages(bridge, 1, 'store');
    return (
      <>
        <button type="button" onClick={() => setScope(scope === 'a' ? 'b' : 'a')}>
          切换会话
        </button>
        <Composer
          scopeKey={scope}
          draft={texts[scope]!}
          onChange={(text) => setTexts((prior) => ({ ...prior, [scope]: text }))}
          disabled={false}
          active={false}
          stopping={false}
          files={attachments.files(scope)}
          images={attachments.get(scope)}
          onRemoveFile={(id) => attachments.removeIds([id])}
          onRemoveImage={(id) => attachments.removeIds([id])}
        />
      </>
    );
  }
  const click = async (label: string) =>
    act(async () => {
      const button = [...document.querySelectorAll('button')].find(
        (button) => button.getAttribute('aria-label') === label || button.textContent === label,
      )!;
      expect(button).toBeDefined();
      button.click();
    });
  let pending: ReturnType<typeof attachments.add> | undefined;
  try {
    await act(async () => root.render(<Fixture />));
    await act(async () => {
      attachments.addFiles('a', [{ name: 'A.ini', uri: 'file:///A.ini' }]);
      pending = attachments.add('a', [
        new dom.window.File([new Uint8Array(1024 * 1024)], 'large.png', {
          type: 'image/png',
        }) as unknown as File,
      ]);
      await appended;
    });
    expect(attachments.get('a')[0]?.loading).toBe(true);
    expect(document.querySelector<HTMLButtonElement>('[aria-label="发送消息"]')?.disabled).toBe(
      true,
    );
    await click('切换会话');
    expect(document.querySelector('[aria-label="待发送附件"]')).toBeNull();
    await act(async () => {
      attachments.addFiles('b', [{ name: 'B.pdf', uri: 'file:///B.pdf' }]);
      await setPromptText(document.querySelector('[role="textbox"]')!, '编码时仍能输入 B');
    });
    expect(promptValue(document.querySelector('[role="textbox"]'))).toBe('编码时仍能输入 B');
    await click('切换会话');
    expect(promptValue(document.querySelector('[role="textbox"]'))).toBe('原文 A');
    expect(document.querySelector('[aria-label="待发送附件"]')?.textContent).toContain('A.ini');
    expect(document.querySelector('[aria-label="待发送附件"]')?.textContent).not.toContain('B.pdf');
    const imageId = attachments.get('a')[0]!.id;
    await click('移除图片 large.png');
    await act(async () => {
      release();
      await pending;
    });
    expect(attachments.get('a')).toEqual([]);
    expect(revoked).toEqual(['blob:encoding']);
    expect(calls.filter((request) => request.method === 'input.images.append')).toHaveLength(1);
    expect(calls.some((request) => request.method === 'input.images.finish')).toBe(false);
    expect(calls).toContainEqual({ method: 'input.images.release', generation: 1, id: imageId });
    await click('移除附件 A.ini');
    expect(document.querySelector('[aria-label="待发送附件"]')).toBeNull();
    await click('切换会话');
    expect(document.querySelector('[aria-label="待发送附件"]')?.textContent).toBe('B.pdf');
    expect(promptValue(document.querySelector('[role="textbox"]'))).toBe('编码时仍能输入 B');
  } finally {
    release();
    await pending;
    await act(async () => root.unmount());
    await new Promise((resolve) => setTimeout(resolve, 0));
    restoreLayout();
    const { createObjectURL, revokeObjectURL, ...globals } = previous;
    Object.assign(globalThis, globals);
    URL.createObjectURL = createObjectURL;
    URL.revokeObjectURL = revokeObjectURL;
    dom.window.close();
    restoreWorker();
  }
});

test.each([
  'retained',
  'removed',
  'scope',
  'hidden',
  'disabled',
  'readOnly',
  'unmounted',
  'reporter',
] as const)('already adopted image batches survive a newer picker but retire feedback when %s', async (mode) => {
  const dom = new JSDOM('<div id="root"></div>', { pretendToBeVisual: true });
  const restoreLayout = prepareDesktopDom(dom);
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    navigator: globalThis.navigator,
    FileReader: globalThis.FileReader,
    createObjectURL: URL.createObjectURL,
    revokeObjectURL: URL.revokeObjectURL,
  };
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    FileReader: dom.window.FileReader,
    IS_REACT_ACT_ENVIRONMENT: true,
  });

  const restoreWorker = installImagePreviewWorker();
  URL.createObjectURL = () => 'blob:batch';
  URL.revokeObjectURL = () => {};
  const { createRoot } = await import('react-dom/client');
  const { Composer } = await import('../../../../packages/ui/src/desktop/Composer');
  const root = createRoot(document.getElementById('root')!);
  const errors: string[] = [],
    calls: NativeRequest[] = [];
  let fail!: (error: Error) => void, entered!: () => void;
  const begin = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const waiting = new Promise<void>((_resolve, reject) => {
    fail = reject;
  });
  const bridge: NativeBridge = {
    watch: () => () => {},
    request: async (request) => {
      calls.push(request);
      if (request.method === 'input.images.begin' && request.name === 'first.png') {
        entered();
        await waiting;
      }
      return null;
    },
  };
  let attachments!: ReturnType<typeof useNativeInputImages>;
  const tasks: ReturnType<ReturnType<typeof useNativeInputImages>['add']>[] = [];
  const report = (message: string) => {
    errors.push(message);
  };
  const replacement = (message: string) => {
    errors.push(`replacement:${message}`);
  };
  function Fixture({ changed = false }: { changed?: boolean }) {
    const scope = changed && mode === 'scope' ? 'b' : 'a';
    attachments = useNativeInputImages(bridge, 1, 'store');
    return changed && mode === 'unmounted' ? null : (
      <Composer
        scopeKey={scope}
        draft="保留草稿"
        active={false}
        stopping={false}
        disabled={changed && mode === 'disabled'}
        readOnly={changed && mode === 'readOnly'}
        promptHidden={changed && mode === 'hidden'}
        onChange={() => {}}
        onError={changed && mode === 'reporter' ? replacement : report}
        images={attachments.get(scope)}
        onImageFiles={(files) => {
          const task = attachments.add(scope, files);
          tasks.push(task);
          return task;
        }}
      />
    );
  }
  const drop = async (name: string) => {
    const event = new dom.window.Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'dataTransfer', {
      value: {
        files: [new dom.window.File([new Uint8Array([1, 2, 3])], name, { type: 'image/png' })],
        types: ['Files'],
      },
    });
    await act(async () => document.querySelector('[role="textbox"]')!.dispatchEvent(event));
  };
  try {
    await act(async () => root.render(<Fixture />));
    await drop('first.png');
    await act(async () => begin);
    await drop('second.png');
    expect(attachments.get('a')).toHaveLength(2);
    if (mode === 'removed')
      await act(async () => attachments.removeIds([attachments.get('a')[0]!.id]));
    else if (mode !== 'retained') await act(async () => root.render(<Fixture changed />));
    await act(async () => {
      fail(Error('image_read_failed'));
      await Promise.all(tasks);
    });
    expect(errors).toEqual(mode === 'retained' ? ['图片准备失败，请移除后重新添加。'] : []);
    const first = attachments.get('a').find((image) => image.name === 'first.png');
    if (mode === 'removed') expect(first).toBeUndefined();
    else expect(first?.errorKind).toBe('system');
    expect(attachments.get('a').find((image) => image.name === 'second.png')?.loading).toBe(false);
    expect(calls.filter((request) => request.method === 'input.images.finish')).toHaveLength(1);
    if (mode === 'retained') {
      expect(document.querySelector('[role="alert"]')).toBeNull();
      expect(document.querySelector<HTMLButtonElement>('[aria-label="发送消息"]')?.disabled).toBe(
        true,
      );
    }
  } finally {
    fail(Error('cleanup'));
    await Promise.all(tasks);
    await act(async () => root.unmount());
    await new Promise((resolve) => setTimeout(resolve, 0));
    restoreLayout();
    const { createObjectURL, revokeObjectURL, ...globals } = previous;
    Object.assign(globalThis, globals);
    URL.createObjectURL = createObjectURL;
    URL.revokeObjectURL = revokeObjectURL;
    dom.window.close();
    restoreWorker();
  }
});
