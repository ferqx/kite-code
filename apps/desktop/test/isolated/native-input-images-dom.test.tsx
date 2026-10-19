import { expect, test } from 'bun:test';
import { JSDOM } from 'jsdom';
import { act, useState } from 'react';
import type { NativeBridge, NativeRequest } from '../../src/native-bridge';
import { useNativeInputImages } from '../../src/native-input-images';
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
    await act(async () => images.add('a', [file]));
    const draft = images.get('a')[0]!;
    expect(draft.loading).toBe(false);
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
    await act(async () => images.addFiles('a', files));
    await act(async () => images.addFiles('a', files));
    expect(images.files('a')).toHaveLength(1);
    expect(images.files('b')).toEqual([]);
    const fileId = images.files('a')[0]!.id;
    await act(async () => images.move('a', 'moved'));
    expect(images.files('a')).toEqual([]);
    expect(images.get('moved')[0]?.id).toBe(draft.id);
    expect(images.files('moved')[0]?.id).toBe(fileId);
    await act(async () => images.removeIds([fileId]));
    expect(images.files('moved')).toEqual([]);
    expect(images.get('moved')).toHaveLength(1);
    await act(async () => root.render(<Fixture generation={2} />));
    expect(images.get('a')).toEqual([]);
    expect(document.getElementById('root')!.textContent).toBe('0');
    expect(calls).toContainEqual({ method: 'input.images.release', generation: 1, id: draft.id });
    expect(images.fileReferences([file])).toEqual(files);
    expect(images.fileReferences([])).toEqual([]);
    const resolver = bridge.fileReferences;
    delete bridge.fileReferences;
    expect(() => images.fileReferences([file])).toThrow('file_picker_restart_required');
    bridge.fileReferences = resolver;
    failure = 'temporary_picker_failure';
    expect(() => images.fileReferences([file])).toThrow('temporary_picker_failure');
    failure = 'invalid_native_request';
    await act(async () => images.add('a', [file]));
    expect(images.get('a')[0]?.error).toBe('图片附件功能尚未加载，请完全退出并重新打开应用。');
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
    let preparing!: Promise<void>;
    await act(async () => {
      preparing = images.add('batch', [large, large, large, large]);
      await images.add('other-scope', [file]);
    });
    expect(images.get('batch')).toHaveLength(4);
    expect(images.get('other-scope')[0]?.error).toContain('64 MiB');
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
    let nine!: Promise<void>;
    await act(async () => {
      nine = images.add('count', Array<File>(9).fill(file));
    });
    const beforeRejected = reads;
    await expect(images.add('count', [file, file])).rejects.toThrow('input_image_count_limit');
    expect(images.get('count')).toHaveLength(9);
    expect(reads).toBe(beforeRejected);
    let tenth!: Promise<void>, replacement!: Promise<void>;
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
  let pending: Promise<void> | undefined;
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
  }
});
