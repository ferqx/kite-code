import { expect, test } from 'bun:test';
import { JSDOM } from 'jsdom';
import { act, useState } from 'react';
import type {
  NativeAttachmentRecovery,
  NativePendingAttachment,
  NativePendingAttachments,
} from '../../src/input-images-bridge';
import type { NativeBridge, NativeRequest, NativeResult } from '../../src/native-bridge';
import { useNativeInputImages } from '../../src/native-input-images';
import { installImagePreviewWorker } from '../image-preview-worker.fixture';
import { prepareDesktopDom, promptValue, setPromptText } from '../native-page-dom.fixture';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

/** Main owns durable bytes across renderer lifetimes; actual SQLite has separate tests. */
function durableHost() {
  const calls: NativeRequest[] = [];
  const scopes = new Map<string, NativePendingAttachments>();
  // Immutable revision descriptors model the exact entries bound to an original send.
  const snapshots = new Map<string, Map<number, NativePendingAttachment[]>>();
  const save = (scope: string, value: NativePendingAttachments) => {
    scopes.set(scope, structuredClone(value));
    const revisions = snapshots.get(scope) ?? new Map<number, NativePendingAttachment[]>();
    revisions.set(value.revision, structuredClone(value.attachments));
    snapshots.set(scope, revisions);
  };
  const staged = new Map<string, NativePendingAttachment>();
  const bytes = new Map<string, number[]>();
  const sessionWorkspaces = new Map<string, string>();
  const stores = new Map([
    [1, 'store'],
    [2, 'store'],
    [3, 'other-store'],
  ]);
  const key = (sessionId: string, workspaceId?: string, generation = 1) =>
    JSON.stringify([
      stores.get(generation),
      workspaceId ?? sessionWorkspaces.get(sessionId),
      sessionId,
    ]);
  const read = (sessionId: string, workspaceId?: string, generation = 1) =>
    structuredClone(
      scopes.get(key(sessionId, workspaceId, generation)) ?? {
        kind: 'input.attachments' as const,
        revision: 0,
        attachments: [],
      },
    );
  const host: {
    before?: (request: NativeRequest) => Promise<void>;
    afterMove?: () => Promise<void>;
    afterWrite?: (
      request: Extract<NativeRequest, { method: 'input.attachments.write' }>,
    ) => Promise<void>;
    failure?: string;
    bridge: NativeBridge;
  } = {
    bridge: {
      watch: () => () => {},
      fileReferences: (files) =>
        files.map((file) => ({ name: file.name, uri: `file:///original/${file.name}` })),
      request: async (request): Promise<NativeResult> => {
        calls.push(request);
        await host.before?.(request);
        switch (request.method) {
          case 'input.attachments.read':
            return read(request.sessionId, request.workspaceId, request.generation);
          case 'input.attachments.move': {
            if (host.failure) throw Error(host.failure);
            const source = read('new-conversation', request.workspaceId, request.generation);
            const target = read(request.sessionId, request.workspaceId, request.generation);
            if (source.revision !== request.revision || target.revision !== request.targetRevision)
              throw Error('attachment_draft_conflict');
            const ids = new Set(target.attachments.map((item) => item.id));
            const moved: NativePendingAttachments = {
              kind: 'input.attachments',
              revision: target.revision + 1,
              attachments: [
                ...target.attachments,
                ...source.attachments.filter((item) => !ids.has(item.id)),
              ],
            };
            save(key('new-conversation', request.workspaceId, request.generation), {
              ...source,
              revision: source.revision + 1,
              attachments: [],
            });
            save(key(request.sessionId, request.workspaceId, request.generation), moved);
            await host.afterMove?.();
            return { ...structuredClone(moved), sourceRevision: source.revision + 1 };
          }
          case 'input.attachments.write': {
            if (host.failure) throw Error(host.failure);
            const previous = read(request.sessionId, request.workspaceId, request.generation);
            if (request.revision !== previous.revision) throw Error('attachment_draft_conflict');
            const attachments = request.attachments.map((item): NativePendingAttachment => {
              const material =
                staged.get(item.id) ?? previous.attachments.find((saved) => saved.id === item.id);
              if (item.kind !== 'reference' && item.state !== 'error' && !material)
                throw Error('attachment_bytes_missing');
              return { ...material, ...item, state: item.state ?? 'ready' };
            });
            const saved: NativePendingAttachments = {
              kind: 'input.attachments',
              revision: previous.revision + 1,
              attachments,
            };
            save(key(request.sessionId, request.workspaceId, request.generation), saved);
            await host.afterWrite?.(request);
            return structuredClone(saved);
          }
          case 'input.images.begin':
          case 'input.files.begin':
            staged.set(request.id, {
              id: request.id,
              name: request.name,
              kind: request.method === 'input.images.begin' ? 'image' : 'file',
              state: 'ready',
              size: request.size,
              mediaType: request.mediaType,
              ...('hash' in request ? { hash: request.hash } : {}),
            });
            bytes.set(request.id, []);
            return null;
          case 'input.images.append':
          case 'input.files.append': {
            const content =
              typeof request.data === 'string'
                ? [...Uint8Array.from(atob(request.data), (char) => char.charCodeAt(0))]
                : [...request.data];
            const target = bytes.get(request.id)!;
            expect(request.offset).toBe(target.length);
            target.push(...content);
            return null;
          }
          case 'input.images.release':
          case 'input.files.release':
            staged.delete(request.id);
            return null;
          case 'input.attachments.preview': {
            const saved = read(request.sessionId, request.workspaceId, request.generation);
            if (!saved.attachments.some((item) => item.id === request.id))
              throw Error('attachment_scope_mismatch');
            const content = bytes.get(request.id)!;
            return {
              kind: 'input.image.chunk',
              readId: request.id,
              offset: request.offset,
              nextOffset: content.length,
              data: btoa(String.fromCharCode(...content.slice(request.offset))),
              done: true,
            };
          }
          default:
            return null;
        }
      },
    },
  };
  return {
    host,
    calls,
    bytes,
    read,
    setSessionWorkspace(sessionId: string, workspaceId: string) {
      sessionWorkspaces.set(sessionId, workspaceId);
    },
    seed(
      sessionId: string,
      attachments: NativePendingAttachment[],
      workspaceId?: string,
      generation = 1,
    ) {
      save(key(sessionId, workspaceId, generation), {
        kind: 'input.attachments',
        revision: 1,
        attachments,
      });
    },
    appendDurable(sessionId: string, attachments: NativePendingAttachment[], workspaceId: string) {
      const prior = read(sessionId, workspaceId);
      const next = {
        ...prior,
        revision: prior.revision + 1,
        attachments: [...prior.attachments, ...attachments],
      };
      save(key(sessionId, workspaceId), next);
      return structuredClone(next);
    },
    recoverRejected(
      sessionId: string,
      revision: number,
      workspaceId: string,
      commandId: string,
    ): NativeAttachmentRecovery {
      const originals = snapshots.get(key(sessionId, workspaceId))?.get(revision);
      if (!originals) throw Error('recovery_original_snapshot_missing');
      const restored = originals.map((original, index) => {
        const item = { ...original, id: `${commandId}-recovered-${index}` };
        const content = bytes.get(original.id);
        if (content) bytes.set(item.id, [...content]);
        return item;
      });
      const prior = read(sessionId, workspaceId);
      const next = {
        ...prior,
        revision: prior.revision + 1,
        attachments: [...prior.attachments, ...restored],
      };
      save(key(sessionId, workspaceId), next);
      return {
        phase: 'restored',
        sessionId,
        workspaceId,
        revision: next.revision,
        ids: restored.map((item) => item.id),
      };
    },
    consume(sessionId: string, revision: number, workspaceId?: string) {
      const previous = read(sessionId, workspaceId);
      const bound = snapshots.get(key(sessionId, workspaceId))?.get(revision);
      if (!bound || previous.revision < revision) return false;
      const same = (a: NativePendingAttachment, b: NativePendingAttachment) =>
        (
          ['id', 'kind', 'name', 'state', 'mediaType', 'size', 'hash', 'uri', 'error'] as const
        ).every((field) => a[field] === b[field]);
      const attachments = previous.attachments.filter(
        (item) => !bound.some((original) => same(item, original)),
      );
      if (attachments.length === previous.attachments.length) return false;
      save(key(sessionId, workspaceId), {
        ...previous,
        revision: previous.revision + 1,
        attachments,
      });
      return true;
    },
  };
}

async function fixture(
  main = durableHost(),
  options: { localFileReferences?: boolean; generation?: number } = {},
) {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true });
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    navigator: globalThis.navigator,
    Blob: globalThis.Blob,
    createObjectURL: URL.createObjectURL,
    revokeObjectURL: URL.revokeObjectURL,
  };
  const restoreLayout = prepareDesktopDom(dom);
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    Blob: dom.window.Blob,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const restoreWorker = installImagePreviewWorker();
  const previewBlobs = new Map<string, Blob>();
  let nextUrl = 0;
  URL.createObjectURL = (blob) => {
    const url = `blob:pending-${++nextUrl}`;
    previewBlobs.set(url, blob as Blob);
    return url;
  };
  URL.revokeObjectURL = () => {};
  const { createRoot } = await import('react-dom/client');
  const { Composer } = await import('../../../../packages/ui/src/desktop/Composer');
  const root = createRoot(document.getElementById('root')!);
  let attachments!: ReturnType<typeof useNativeInputImages>;
  let currentScope = 'a',
    generation = options.generation ?? 1;
  let pendingSend: Promise<void> | undefined;
  const sends: { scope: string; revision: number | undefined; ids: string[]; text: string }[] = [];
  function Fixture() {
    const [texts, setTexts] = useState<Record<string, string>>({ a: '草稿 A', b: '草稿 B' });
    attachments = useNativeInputImages(
      main.host.bridge,
      generation,
      generation === 3 ? 'other-store' : 'store',
      options.localFileReferences,
    );
    const scope = currentScope;
    return (
      <Composer
        scopeKey={scope}
        draft={texts[scope] ?? ''}
        onChange={(value) => setTexts((prior) => ({ ...prior, [scope]: value }))}
        active={false}
        stopping={false}
        disabled={false}
        images={attachments.get(scope)}
        files={attachments.files(scope)}
        sendDisabled={attachments.blocked(scope)}
        imageError={attachments.error(scope)}
        onRemoveImage={(id) => attachments.removeIds([id])}
        onRemoveFile={(id) => attachments.removeIds([id])}
        onSend={() => {
          const ids = [...attachments.get(scope), ...attachments.files(scope)].map(
            (item) => item.id,
          );
          pendingSend = (async () => {
            const revision = await attachments.flush(scope);
            sends.push({ scope, revision, ids, text: texts[scope] ?? '' });
          })();
        }}
      />
    );
  }
  const render = async (scope = currentScope, nextGeneration = generation) => {
    currentScope = scope;
    generation = nextGeneration;
    await act(async () => root.render(<Fixture />));
  };
  await render();
  return {
    main,
    dom,
    sends,
    previewBlobs,
    get attachments() {
      return attachments;
    },
    file(name = 'photo.png', type = 'image/png') {
      return new dom.window.File([new Uint8Array([1, 2, 3])], name, { type }) as unknown as File;
    },
    render,
    async remount() {
      await act(async () => root.render(null));
      await render();
    },
    async send() {
      await act(async () =>
        document.querySelector<HTMLButtonElement>('[aria-label="发送消息"]')!.click(),
      );
    },
    async settleSend() {
      await act(async () => pendingSend);
    },
    async close() {
      await act(async () => root.unmount());
      await new Promise((resolve) => setTimeout(resolve, 0));
      restoreLayout();
      const { createObjectURL, revokeObjectURL, ...globals } = previous;
      Object.assign(globalThis, globals);
      URL.createObjectURL = createObjectURL;
      URL.revokeObjectURL = revokeObjectURL;
      dom.window.close();
      restoreWorker();
    },
  };
}

const sendButton = () => document.querySelector<HTMLButtonElement>('[aria-label="发送消息"]')!;
const reference = (name: string) => ({ name, uri: `file:///local/${name}` });

test('durable mixed attachments survive unmount and restore exact session, workspace and Store scopes without submitting', async () => {
  const f = await fixture();
  try {
    await act(async () => f.attachments.restore('a', 'session-a', 'workspace'));
    await act(async () => {
      await f.attachments.add('a', [f.file()]);
      const prepared = await f.attachments.fileReferences([
        f.file('report.pdf', 'application/pdf'),
      ]);
      f.attachments.addFiles('a', [...prepared, reference('notes.txt')]);
      await f.attachments.flush('a');
    });
    const originals = [...f.attachments.get('a'), ...f.attachments.files('a')].map(
      ({ id, name }) => ({ id, name }),
    );
    const durable = f.main.read('session-a', 'workspace');
    expect(durable.attachments.map((item) => item.kind)).toEqual(['image', 'file', 'reference']);
    expect(durable.attachments.map(({ id, name }) => ({ id, name }))).toEqual(originals);
    expect(f.main.bytes.get(originals[0]!.id)).toEqual([1, 2, 3]);
    expect(f.main.bytes.get(originals[1]!.id)).toEqual([1, 2, 3]);
    await act(async () => {
      await f.attachments.restore('b', 'session-b', 'workspace');
      f.attachments.addFiles('b', [reference('other.txt')]);
      await f.attachments.flush('b');
    });
    await f.remount();
    expect(f.attachments.get('a')).toEqual([]);
    await act(async () => f.attachments.restore('a', 'session-a', 'workspace'));
    expect(
      [...f.attachments.get('a'), ...f.attachments.files('a')].map(({ id, name }) => ({
        id,
        name,
      })),
    ).toEqual(originals);
    expect(document.querySelector('[aria-label="待发送附件"]')?.textContent).toContain(
      'report.pdf',
    );
    expect(document.querySelector('[aria-label="待发送附件"]')?.textContent).not.toContain(
      'other.txt',
    );
    expect(f.attachments.files('a')[1]?.uri).toBe('file:///local/notes.txt');
    const source = f.attachments.get('a')[0]?.previewSource;
    expect(source?.load).toBeDefined();
    let blob!: Blob;
    await act(async () => {
      blob = await source!.load!(new AbortController().signal);
    });
    const content = await new Promise<ArrayBuffer>((resolve) => {
      const reader = new f.dom.window.FileReader();
      reader.onload = () => resolve(reader.result as ArrayBuffer);
      reader.readAsArrayBuffer(blob);
    });
    expect([...new Uint8Array(content)]).toEqual([1, 2, 3]);
    await act(async () => {
      await f.attachments.restore('b', 'session-b', 'workspace');
      await f.attachments.restore('wrong-workspace', 'session-a', 'other-workspace');
    });
    expect(f.attachments.files('b').map((item) => item.name)).toEqual(['other.txt']);
    expect(f.attachments.files('wrong-workspace')).toEqual([]);
    expect(f.attachments.get('wrong-workspace')).toEqual([]);
    await f.render('a', 3);
    await act(async () => f.attachments.restore('a', 'session-a', 'workspace'));
    expect(f.attachments.files('a')).toEqual([]);
    expect(f.attachments.get('a')).toEqual([]);
    expect(f.sends).toEqual([]);
  } finally {
    await f.close();
  }
});

test('a restored animated attachment keeps first-frame metadata and original gallery bytes without reuploading', async () => {
  const f = await fixture();
  const display = f.dom.window.kiteNativeImageDisplay!;
  const render = display.render;
  const sources: Uint8Array[] = [];
  display.render = async (request) => {
    sources.push(request.bytes.slice());
    expect(request.mediaType).toBe('image/gif');
    expect(request.edge).toBe(512);
    const result = await render(request);
    return result.ok
      ? { ok: true, value: { ...result.value, animated: true, frame: 'first' } }
      : result;
  };
  try {
    await act(async () => f.attachments.restore('a', 'session-a', 'workspace'));
    await act(async () => {
      await f.attachments.add('a', [f.file('animated.gif', 'image/gif')]);
      await f.attachments.flush('a');
    });
    const saved = f.main.read('session-a', 'workspace');
    const original = f.attachments.get('a')[0]!;
    expect(original.previewFrame).toBe('first');
    expect(document.querySelector('.composer-attachments')?.textContent).toContain('动画首帧');
    const uploadCount = f.main.calls.filter((call) => call.method === 'input.images.begin').length;
    sources.length = 0;
    await f.remount();
    await act(async () => f.attachments.restore('a', 'session-a', 'workspace'));
    for (let attempt = 0; attempt < 100 && !f.attachments.get('a')[0]?.url; attempt++)
      await act(async () => new Promise((resolve) => setTimeout(resolve, 5)));
    const restored = f.attachments.get('a')[0]!;
    expect(restored.id).toBe(original.id);
    expect(restored.previewFrame).toBe('first');
    expect(restored.previewError).toBeUndefined();
    expect(document.querySelector('.composer-attachments')?.textContent).toContain('动画首帧');
    expect(sources.map((bytes) => [...bytes])).toEqual([[1, 2, 3]]);
    const thumbnail = f.previewBlobs.get(restored.url)!;
    expect(thumbnail.type).toBe('image/webp');
    expect(new TextDecoder().decode(await thumbnail.arrayBuffer())).toBe('derived');
    const gallerySource = await restored.previewSource!.load!(new AbortController().signal);
    expect(gallerySource.type).toBe('image/gif');
    expect([...new Uint8Array(await gallerySource.arrayBuffer())]).toEqual([1, 2, 3]);
    expect(f.main.bytes.get(restored.id)).toEqual([1, 2, 3]);
    expect(f.main.read('session-a', 'workspace')).toEqual(saved);
    expect(f.main.calls.filter((call) => call.method === 'input.images.begin')).toHaveLength(
      uploadCount,
    );
    expect(f.sends).toEqual([]);
  } finally {
    await f.close();
  }
});

test.each([
  'image',
  'file',
  'reference',
] as const)('a restored invalid %s stays visible and blocks send until removed', async (kind) => {
  const main = durableHost();
  main.seed('session-a', [
    {
      id: 'invalid',
      kind,
      name: 'missing.dat',
      state: 'error',
      error: 'missing',
      uri: 'file:///missing.dat',
    },
  ]);
  const f = await fixture(main);
  try {
    await act(async () => f.attachments.restore('a', 'session-a'));
    expect(
      document.querySelector(
        kind === 'image'
          ? '[aria-label="移除图片 missing.dat"]'
          : '[aria-label="移除附件 missing.dat"]',
      ),
    ).not.toBeNull();
    expect(document.querySelector('[aria-label="待发送附件"]')?.textContent).toContain(
      '附件已失效',
    );
    expect(sendButton().disabled).toBe(true);
    await f.send();
    expect(f.sends).toEqual([]);
    await act(async () => {
      await expect(f.attachments.flush('a')).rejects.toThrow('attachment_draft_unavailable');
    });
    await act(async () => {
      f.attachments.removeIds(['invalid']);
      await f.attachments.flush('a');
    });
    expect(sendButton().disabled).toBe(false);
    expect(main.read('session-a').attachments).toEqual([]);
  } finally {
    await f.close();
  }
});

test('a removal during image preparation cannot resurrect the image in UI or durable draft', async () => {
  const f = await fixture();
  const reached = deferred(),
    release = deferred();
  let preparing: ReturnType<typeof f.attachments.add> | undefined;
  f.main.host.before = async (request) => {
    if (request.method === 'input.images.append') {
      reached.resolve();
      await release.promise;
    }
  };
  try {
    await act(async () => f.attachments.restore('a', 'session-a'));
    await act(async () => {
      preparing = f.attachments.add('a', [f.file()]);
      await reached.promise;
    });
    const id = f.attachments.get('a')[0]!.id;
    expect(sendButton().disabled).toBe(true);
    await act(async () => {
      f.attachments.removeIds([id]);
      await f.attachments.flush('a');
    });
    expect(f.main.read('session-a').attachments).toEqual([]);
    await act(async () => {
      release.resolve();
      await preparing;
    });
    expect(f.attachments.get('a')).toEqual([]);
    expect(f.main.calls.filter((request) => request.method === 'input.images.finish')).toEqual([]);
    await f.remount();
    await act(async () => f.attachments.restore('a', 'session-a'));
    expect(f.attachments.get('a')).toEqual([]);
  } finally {
    release.resolve();
    await preparing;
    await f.close();
  }
});

test('late restore from a retired generation cannot repaint or overwrite the new scope', async () => {
  const main = durableHost();
  main.seed('session-a', [
    { id: 'old', kind: 'reference', name: 'old.txt', state: 'ready', uri: 'file:///old.txt' },
  ]);
  const f = await fixture(main);
  const reached = deferred(),
    release = deferred();
  let restoring: Promise<void> | undefined;
  main.host.before = async (request) => {
    if (request.method === 'input.attachments.read' && request.generation === 1) {
      reached.resolve();
      await release.promise;
    }
  };
  try {
    await act(async () => {
      restoring = f.attachments.restore('a', 'session-a');
      await reached.promise;
    });
    expect(sendButton().disabled).toBe(true);
    await f.render('a', 3);
    await act(async () => {
      await f.attachments.restore('a', 'session-a');
      f.attachments.addFiles('a', [reference('new.txt')]);
      await f.attachments.flush('a');
      release.resolve();
      await restoring;
    });
    expect(f.attachments.files('a').map((item) => item.name)).toEqual(['new.txt']);
    expect(document.querySelector('[aria-label="待发送附件"]')?.textContent).not.toContain(
      'old.txt',
    );
    expect(main.read('session-a').attachments.map((item) => item.name)).toEqual(['old.txt']);
    expect(main.read('session-a', undefined, 3).attachments.map((item) => item.name)).toEqual([
      'new.txt',
    ]);
    expect(f.sends).toEqual([]);
  } finally {
    release.resolve();
    await restoring;
    await f.close();
  }
});

test('CAS write failure retains visible attachments and text, reports failure and blocks sending', async () => {
  const f = await fixture();
  try {
    await act(async () => f.attachments.restore('a', 'session-a'));
    f.main.host.failure = 'attachment_draft_conflict';
    await act(async () => {
      f.attachments.addFiles('a', [reference('keep.txt')]);
      await setPromptText(document.querySelector('[role="textbox"]')!, '不应丢失的文字');
      await expect(f.attachments.flush('a')).rejects.toThrow('attachment_draft_unavailable');
    });
    expect(f.attachments.files('a').map((item) => item.name)).toEqual(['keep.txt']);
    expect(promptValue(document.querySelector('[role="textbox"]'))).toBe('不应丢失的文字');
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('附件草稿尚未确认保存');
    expect(sendButton().disabled).toBe(true);
    await f.send();
    expect(f.sends).toEqual([]);
    expect(f.main.read('session-a').attachments).toEqual([]);
  } finally {
    await f.close();
  }
});

test('send waits for an in-flight durable save and submits its confirmed revision only once', async () => {
  const f = await fixture();
  const reached = deferred(),
    release = deferred();
  f.main.host.before = async (request) => {
    if (request.method === 'input.attachments.write') {
      reached.resolve();
      await release.promise;
    }
  };
  try {
    await act(async () => f.attachments.restore('a', 'session-a'));
    await act(async () => {
      f.attachments.addFiles('a', [reference('pending.txt')]);
      await reached.promise;
    });
    await f.send();
    expect(f.sends).toEqual([]);
    await act(async () => release.resolve());
    await f.settleSend();
    expect(f.sends).toEqual([
      { scope: 'a', revision: 1, ids: [f.attachments.files('a')[0]!.id], text: '草稿 A' },
    ]);
    expect(f.main.read('session-a').revision).toBe(1);
    expect(
      f.main.calls.filter((request) => request.method === 'input.attachments.write'),
    ).toHaveLength(1);
  } finally {
    release.resolve();
    await f.settleSend();
    await f.close();
  }
});

test('an accepted revision removes only submitted IDs and preserves later additions through restart', async () => {
  const f = await fixture();
  try {
    await act(async () => {
      await f.attachments.restore('a', 'session-a');
      f.attachments.addFiles('a', [reference('sent.txt')]);
      await f.attachments.flush('a');
    });
    await f.send();
    await f.settleSend();
    const receipt = f.sends[0]!;
    expect(f.main.consume('session-a', receipt.revision!)).toBe(true);
    await act(async () => {
      f.attachments.addFiles('a', [reference('later.txt')]);
      f.attachments.accepted('a', receipt.revision, receipt.ids);
      await f.attachments.flush('a');
    });
    expect(f.attachments.files('a').map((item) => item.name)).toEqual(['later.txt']);
    expect(f.main.read('session-a').attachments.map((item) => item.name)).toEqual(['later.txt']);
    await f.remount();
    await act(async () => f.attachments.restore('a', 'session-a'));
    expect(f.attachments.files('a').map((item) => item.name)).toEqual(['later.txt']);
    expect(f.sends).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test('a successful old receipt cannot erase a newer durable attachment revision', async () => {
  const f = await fixture();
  try {
    await act(async () => {
      await f.attachments.restore('a', 'session-a');
      f.attachments.addFiles('a', [reference('sent.txt')]);
      await f.attachments.flush('a');
    });
    await f.send();
    await f.settleSend();
    const receipt = f.sends[0]!;
    await act(async () => {
      f.attachments.addFiles('a', [reference('newer.txt')]);
      await f.attachments.flush('a');
    });
    expect(f.main.read('session-a').revision).toBeGreaterThan(receipt.revision!);
    expect(f.main.consume('session-a', receipt.revision!)).toBe(true);
    expect(f.main.read('session-a').attachments.map((item) => item.name)).toEqual(['newer.txt']);
    await act(async () => {
      f.attachments.accepted('a', receipt.revision, receipt.ids);
      await f.attachments.flush('a');
    });
    expect(f.attachments.files('a').map((item) => item.name)).toEqual(['newer.txt']);
    expect(f.main.read('session-a').attachments.map((item) => item.name)).toEqual(['newer.txt']);
  } finally {
    await f.close();
  }
});

test('removing an image during a held first save keeps staged bytes until the queued write settles', async () => {
  const f = await fixture();
  const reached = deferred(),
    release = deferred();
  f.main.host.before = async (request) => {
    if (
      request.method === 'input.attachments.write' &&
      request.attachments.some((item) => item.kind === 'image')
    ) {
      reached.resolve();
      await release.promise;
    }
  };
  try {
    await act(async () => f.attachments.restore('a', 'session-a'));
    await act(async () => {
      f.attachments.addFiles('a', [reference('keep.txt')]);
      await f.attachments.add('a', [f.file()]);
      await reached.promise;
    });
    const id = f.attachments.get('a')[0]!.id;
    await act(async () => f.attachments.removeIds([id]));
    expect(f.attachments.get('a')).toEqual([]);
    expect(
      f.main.calls.some(
        (request) => request.method === 'input.images.release' && request.id === id,
      ),
    ).toBe(false);
    await act(async () => {
      release.resolve();
      await f.attachments.flush('a');
    });
    expect(f.attachments.error('a')).toBeUndefined();
    expect(f.main.read('session-a').attachments.map((item) => item.name)).toEqual(['keep.txt']);
    expect(
      f.main.calls.some(
        (request) => request.method === 'input.images.release' && request.id === id,
      ),
    ).toBe(true);
  } finally {
    release.resolve();
    await f.close();
  }
});

test.each([
  'before commit',
  'after commit',
] as const)('a receipt arriving during a newer held write %s preserves later attachments', async (phase) => {
  const f = await fixture();
  const reached = deferred(),
    release = deferred();
  try {
    await act(async () => {
      await f.attachments.restore('a', 'session-a');
      f.attachments.addFiles('a', [reference('sent.txt')]);
      await f.attachments.flush('a');
    });
    await f.send();
    await f.settleSend();
    const receipt = f.sends[0]!;
    const hold = async (request: NativeRequest) => {
      if (request.method === 'input.attachments.write' && request.attachments.length === 2) {
        reached.resolve();
        await release.promise;
      }
    };
    if (phase === 'before commit') f.main.host.before = hold;
    else f.main.host.afterWrite = hold;
    await act(async () => {
      f.attachments.addFiles('a', [reference('later.txt')]);
      await reached.promise;
    });
    expect(f.main.consume('session-a', receipt.revision!)).toBe(true);
    await act(async () => f.attachments.accepted('a', receipt.revision, receipt.ids));
    expect(f.attachments.files('a').map((item) => item.name)).toEqual(['later.txt']);
    await act(async () => {
      release.resolve();
      await f.attachments.flush('a');
    });
    expect(f.attachments.error('a')).toBeUndefined();
    expect(f.main.read('session-a').attachments.map((item) => item.name)).toEqual(['later.txt']);
    expect(f.sends).toHaveLength(1);
  } finally {
    release.resolve();
    await f.close();
  }
});

test('a failed initial restore can retry on re-entry without submitting or dropping persisted attachments', async () => {
  const main = durableHost();
  main.seed('session-a', [
    { id: 'saved', kind: 'reference', name: 'saved.txt', state: 'ready', uri: 'file:///saved.txt' },
  ]);
  const f = await fixture(main);
  main.host.before = async (request) => {
    if (request.method === 'input.attachments.read') throw Error('temporarily_unavailable');
  };
  try {
    await act(async () => f.attachments.restore('a', 'session-a'));
    expect(f.attachments.blocked('a')).toBe(true);
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('未能恢复');
    await f.render('b');
    main.host.before = undefined;
    await f.render('a');
    await act(async () => f.attachments.restore('a', 'session-a'));
    expect(f.attachments.error('a')).toBeUndefined();
    expect(f.attachments.blocked('a')).toBe(false);
    expect(f.attachments.files('a').map((item) => item.name)).toEqual(['saved.txt']);
    expect(f.sends).toEqual([]);
  } finally {
    await f.close();
  }
});

test('re-entry after a failed write retries a compatible durable revision and keeps unsaved local attachments', async () => {
  const f = await fixture();
  try {
    await act(async () => f.attachments.restore('a', 'session-a'));
    f.main.host.failure = 'temporary_write_failure';
    await act(async () => {
      f.attachments.addFiles('a', [reference('keep.txt')]);
      await expect(f.attachments.flush('a')).rejects.toThrow('attachment_draft_unavailable');
    });
    expect(f.attachments.blocked('a')).toBe(true);
    await f.render('b');
    f.main.host.failure = undefined;
    await f.render('a');
    await act(async () => {
      await f.attachments.restore('a', 'session-a');
      await f.attachments.flush('a');
    });
    expect(f.attachments.error('a')).toBeUndefined();
    expect(f.attachments.files('a').map((item) => item.name)).toEqual(['keep.txt']);
    expect(f.main.read('session-a').attachments.map((item) => item.name)).toEqual(['keep.txt']);
    expect(f.sends).toEqual([]);
  } finally {
    await f.close();
  }
});

test('re-entry never overwrites an unrelated durable revision after a CAS conflict', async () => {
  const f = await fixture();
  try {
    await act(async () => f.attachments.restore('a', 'session-a'));
    f.main.seed('session-a', [
      {
        id: 'other-window',
        kind: 'reference',
        name: 'remote.txt',
        state: 'ready',
        uri: 'file:///remote.txt',
      },
    ]);
    await act(async () => {
      f.attachments.addFiles('a', [reference('local.txt')]);
      await expect(f.attachments.flush('a')).rejects.toThrow('attachment_draft_unavailable');
    });
    await f.render('b');
    await f.render('a');
    await act(async () => {
      await f.attachments.restore('a', 'session-a');
      await expect(f.attachments.flush('a')).rejects.toThrow('attachment_draft_unavailable');
    });
    expect(f.attachments.files('a').map((item) => item.name)).toEqual(['local.txt']);
    expect(f.main.read('session-a').attachments.map((item) => item.name)).toEqual(['remote.txt']);
    expect(f.attachments.blocked('a')).toBe(true);
    expect(f.sends).toEqual([]);
  } finally {
    await f.close();
  }
});

test('a retired restored-image preview cannot repaint after a Store change', async () => {
  const f = await fixture();
  const reached = deferred(),
    release = deferred();
  try {
    await act(async () => {
      await f.attachments.restore('a', 'session-a');
      await f.attachments.add('a', [f.file()]);
      await f.attachments.flush('a');
    });
    await f.remount();
    f.main.host.before = async (request) => {
      if (request.method === 'input.attachments.preview') {
        reached.resolve();
        await release.promise;
      }
    };
    await act(async () => {
      await f.attachments.restore('a', 'session-a');
      await reached.promise;
    });
    const retired = f.attachments.get('a')[0]!;
    const source = retired.previewSource!;
    expect(retired.url).toBe('');
    await f.render('a', 3);
    await act(async () => {
      await f.attachments.restore('a', 'session-a');
      release.resolve();
    });
    expect(f.attachments.get('a')).toEqual([]);
    expect(document.querySelector('[aria-label="移除图片 photo.png"]')).toBeNull();
    expect(retired.url).toBe('');
    await expect(source.load!(new AbortController().signal)).rejects.toThrow(
      'input_image_draft_inactive',
    );
    expect(f.sends).toEqual([]);
  } finally {
    release.resolve();
    await f.close();
  }
});

test('Main consumes only the original descriptors from a newer revision before renderer reconciliation or restart', async () => {
  const f = await fixture();
  const reached = deferred(),
    release = deferred();
  try {
    await act(async () => {
      await f.attachments.restore('a', 'session-a');
      f.attachments.addFiles('a', [reference('sent.txt')]);
      await f.attachments.flush('a');
    });
    await f.send();
    await f.settleSend();
    const receipt = f.sends[0]!;
    await act(async () => {
      f.attachments.addFiles('a', [reference('later.txt')]);
      await f.attachments.flush('a');
    });
    const later = f.attachments.files('a').find((item) => item.name === 'later.txt')!;
    expect(f.main.read('session-a').revision).toBe(receipt.revision! + 1);
    expect(f.main.consume('session-a', receipt.revision!)).toBe(true);
    const consumed = f.main.read('session-a');
    expect(consumed.revision).toBe(receipt.revision! + 2);
    expect(consumed.attachments.map((item) => item.id)).toEqual([later.id]);
    let held = false;
    f.main.host.before = async (request) => {
      if (request.method === 'input.attachments.read' && !held) {
        held = true;
        reached.resolve();
        await release.promise;
      }
    };
    await act(async () => {
      f.attachments.accepted('a', receipt.revision, receipt.ids);
      await reached.promise;
    });
    // Retire the renderer while its accepted-receipt read-back is still suspended.
    await f.remount();
    await act(async () => f.attachments.restore('a', 'session-a'));
    expect(f.attachments.files('a').map((item) => item.id)).toEqual([later.id]);
    expect(document.querySelector('[aria-label="移除附件 sent.txt"]')).toBeNull();
    await act(async () => release.resolve());
    expect(f.attachments.files('a').map((item) => item.id)).toEqual([later.id]);
    expect(f.main.read('session-a')).toEqual(consumed);
    expect(f.main.consume('session-a', receipt.revision!)).toBe(false);
    expect(f.main.read('session-a')).toEqual(consumed);
    expect(f.sends).toHaveLength(1);
  } finally {
    release.resolve();
    await f.close();
  }
});

const pendingScope = JSON.stringify(['store', 'new-conversation', 'workspace']);
const createdScope = JSON.stringify(['store', 'created-session']);

test('atomic move durably transfers mixed pending attachments to the created session without resubmission', async () => {
  const f = await fixture();
  f.main.setSessionWorkspace('created-session', 'workspace');
  f.main.seed('created-session', [
    {
      id: 'existing',
      kind: 'reference',
      name: 'existing.txt',
      state: 'ready',
      uri: 'file:///existing.txt',
    },
  ]);
  try {
    await act(async () => {
      await f.attachments.restore(pendingScope, 'new-conversation', 'workspace');
      await f.attachments.add(pendingScope, [f.file()]);
      const prepared = await f.attachments.fileReferences([
        f.file('report.pdf', 'application/pdf'),
      ]);
      f.attachments.addFiles(pendingScope, [...prepared, reference('local.txt')]);
      await f.attachments.flush(pendingScope);
    });
    const original = f.main.read('new-conversation', 'workspace');
    const imageId = f.attachments.get(pendingScope)[0]!.id;
    const oldSource = f.attachments.get(pendingScope)[0]!.previewSource!;
    await act(async () => {
      await f.attachments.move(pendingScope, createdScope);
      await f.attachments.flush(pendingScope);
      await f.attachments.flush(createdScope);
    });
    expect(f.main.calls.find((request) => request.method === 'input.attachments.move')).toEqual({
      method: 'input.attachments.move',
      generation: 1,
      sessionId: 'created-session',
      workspaceId: 'workspace',
      revision: original.revision,
      targetRevision: 1,
    });
    expect(f.attachments.get(pendingScope)).toEqual([]);
    expect(f.attachments.files(pendingScope)).toEqual([]);
    expect(f.main.read('new-conversation', 'workspace').attachments).toEqual([]);
    const target = f.main.read('created-session');
    expect(target.attachments.map((item) => item.id)).toEqual([
      'existing',
      ...original.attachments.map((item) => item.id),
    ]);
    expect(f.attachments.get(createdScope)[0]?.id).toBe(imageId);
    expect(f.attachments.error(pendingScope)).toBeUndefined();
    expect(f.attachments.error(createdScope)).toBeUndefined();
    await expect(oldSource.load!(new AbortController().signal)).rejects.toThrow(
      'input_image_draft_inactive',
    );
    expect(
      (await f.attachments.get(createdScope)[0]!.previewSource!.load!(new AbortController().signal))
        .size,
    ).toBe(3);
    await f.remount();
    await act(async () => {
      await f.attachments.restore(pendingScope, 'new-conversation', 'workspace');
      await f.attachments.restore(createdScope, 'created-session');
    });
    expect(f.attachments.get(pendingScope)).toEqual([]);
    expect(f.attachments.files(pendingScope)).toEqual([]);
    expect(f.attachments.get(createdScope).map((item) => item.id)).toEqual([imageId]);
    expect(f.attachments.files(createdScope).map((item) => item.name)).toEqual([
      'existing.txt',
      'report.pdf',
      'local.txt',
    ]);
    expect(f.sends).toEqual([]);
  } finally {
    await f.close();
  }
});

test('atomic move failure leaves the original durable and visible attachments in place and blocks both scopes', async () => {
  const f = await fixture();
  f.main.setSessionWorkspace('created-session', 'workspace');
  try {
    await f.render(pendingScope);
    await act(async () => {
      await f.attachments.restore(pendingScope, 'new-conversation', 'workspace');
      f.attachments.addFiles(pendingScope, [reference('keep.txt')]);
      await f.attachments.flush(pendingScope);
    });
    const original = f.main.read('new-conversation', 'workspace');
    f.main.host.before = async (request) => {
      if (request.method === 'input.attachments.move') throw Error('move_failed');
    };
    await act(async () => f.attachments.move(pendingScope, createdScope));
    expect(f.attachments.files(pendingScope).map((item) => item.name)).toEqual(['keep.txt']);
    expect(f.attachments.files(createdScope)).toEqual([]);
    expect(f.main.read('new-conversation', 'workspace')).toEqual(original);
    expect(f.main.read('created-session').attachments).toEqual([]);
    expect(f.attachments.blocked(pendingScope)).toBe(true);
    expect(f.attachments.blocked(createdScope)).toBe(true);
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('附件转入会话尚未确认');
    expect(sendButton().disabled).toBe(true);
    await f.remount();
    await act(async () => f.attachments.restore(pendingScope, 'new-conversation', 'workspace'));
    expect(f.attachments.files(pendingScope).map((item) => item.name)).toEqual(['keep.txt']);
    expect(f.sends).toEqual([]);
  } finally {
    await f.close();
  }
});

test('attachments added to either scope during a held atomic move survive the frozen migration snapshot and restart', async () => {
  const f = await fixture();
  f.main.setSessionWorkspace('created-session', 'workspace');
  const reached = deferred(),
    release = deferred();
  let moving: Promise<void> | undefined;
  f.main.host.before = async (request) => {
    if (request.method === 'input.attachments.move') {
      reached.resolve();
      await release.promise;
    }
  };
  try {
    await act(async () => {
      await f.attachments.restore(pendingScope, 'new-conversation', 'workspace');
      f.attachments.addFiles(pendingScope, [reference('moving.txt')]);
      await f.attachments.flush(pendingScope);
    });
    const movingId = f.attachments.files(pendingScope)[0]!.id;
    await act(async () => {
      moving = f.attachments.move(pendingScope, createdScope);
      await reached.promise;
    });
    expect(f.attachments.blocked(pendingScope)).toBe(true);
    expect(f.attachments.blocked(createdScope)).toBe(true);
    expect(f.attachments.files(pendingScope).map((item) => item.id)).toEqual([movingId]);
    expect(f.attachments.files(createdScope)).toEqual([]);
    await act(async () => {
      f.attachments.addFiles(pendingScope, [reference('source-later.txt')]);
      f.attachments.addFiles(createdScope, [reference('target-later.txt')]);
    });
    expect(f.main.read('new-conversation', 'workspace').attachments.map((item) => item.id)).toEqual(
      [movingId],
    );
    expect(f.main.read('created-session').attachments).toEqual([]);
    await act(async () => {
      release.resolve();
      await moving;
      await f.attachments.flush(pendingScope);
      await f.attachments.flush(createdScope);
    });
    expect(f.attachments.files(pendingScope).map((item) => item.name)).toEqual([
      'source-later.txt',
    ]);
    expect(
      f.attachments
        .files(createdScope)
        .map((item) => item.name)
        .sort(),
    ).toEqual(['moving.txt', 'target-later.txt']);
    expect(
      f.main.read('new-conversation', 'workspace').attachments.map((item) => item.name),
    ).toEqual(['source-later.txt']);
    expect(
      f.main
        .read('created-session')
        .attachments.map((item) => item.name)
        .sort(),
    ).toEqual(['moving.txt', 'target-later.txt']);
    await f.remount();
    await act(async () => {
      await f.attachments.restore(pendingScope, 'new-conversation', 'workspace');
      await f.attachments.restore(createdScope, 'created-session');
    });
    expect(f.attachments.files(pendingScope).map((item) => item.name)).toEqual([
      'source-later.txt',
    ]);
    expect(
      f.attachments
        .files(createdScope)
        .map((item) => item.name)
        .sort(),
    ).toEqual(['moving.txt', 'target-later.txt']);
    expect(f.sends).toEqual([]);
  } finally {
    release.resolve();
    await moving;
    await f.close();
  }
});

test('a committed move with a lost response cannot rewrite the emptied source on re-entry and cold restore uses Main state', async () => {
  const f = await fixture();
  f.main.setSessionWorkspace('created-session', 'workspace');
  try {
    await f.render(pendingScope);
    await act(async () => {
      await f.attachments.restore(pendingScope, 'new-conversation', 'workspace');
      f.attachments.addFiles(pendingScope, [reference('moved.txt')]);
      await f.attachments.flush(pendingScope);
    });
    const originalId = f.attachments.files(pendingScope)[0]!.id;
    f.main.host.afterMove = async () => {
      throw Error('move_response_lost');
    };
    await act(async () => f.attachments.move(pendingScope, createdScope));
    const source = f.main.read('new-conversation', 'workspace');
    const target = f.main.read('created-session');
    expect(source.attachments).toEqual([]);
    expect(target.attachments.map((item) => item.id)).toEqual([originalId]);
    expect(f.attachments.files(pendingScope).map((item) => item.id)).toEqual([originalId]);
    expect(f.attachments.blocked(pendingScope)).toBe(true);
    expect(f.attachments.blocked(createdScope)).toBe(true);
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('完全退出并重新打开');
    const writes = f.main.calls.filter(
      (request) => request.method === 'input.attachments.write',
    ).length;
    await f.render(createdScope);
    await f.render(pendingScope);
    await act(async () => {
      await f.attachments.restore(pendingScope, 'new-conversation', 'workspace');
      await f.attachments.restore(createdScope, 'created-session');
      await expect(f.attachments.flush(pendingScope)).rejects.toThrow(
        'attachment_draft_unavailable',
      );
      await expect(f.attachments.flush(createdScope)).rejects.toThrow(
        'attachment_draft_unavailable',
      );
    });
    expect(
      f.main.calls.filter((request) => request.method === 'input.attachments.write'),
    ).toHaveLength(writes);
    expect(f.main.read('new-conversation', 'workspace')).toEqual(source);
    expect(f.main.read('created-session')).toEqual(target);
    await f.remount();
    await act(async () => {
      await f.attachments.restore(pendingScope, 'new-conversation', 'workspace');
      await f.attachments.restore(createdScope, 'created-session');
    });
    expect(f.attachments.files(pendingScope)).toEqual([]);
    expect(f.attachments.files(createdScope).map((item) => item.id)).toEqual([originalId]);
    expect(f.attachments.blocked(pendingScope)).toBe(false);
    expect(f.attachments.blocked(createdScope)).toBe(false);
    expect(
      f.main.calls.filter((request) => request.method === 'input.attachments.write'),
    ).toHaveLength(writes);
    expect(f.sends).toEqual([]);
  } finally {
    await f.close();
  }
});

test('removing an attachment during an atomic move cannot resurrect it in the target draft', async () => {
  const f = await fixture();
  f.main.setSessionWorkspace('created-session', 'workspace');
  const reached = deferred(),
    release = deferred();
  let moving: Promise<void> | undefined;
  f.main.host.before = async (request) => {
    if (request.method === 'input.attachments.move') {
      reached.resolve();
      await release.promise;
    }
  };
  try {
    await act(async () => {
      await f.attachments.restore(pendingScope, 'new-conversation', 'workspace');
      f.attachments.addFiles(pendingScope, [reference('removed.txt')]);
      await f.attachments.flush(pendingScope);
    });
    const id = f.attachments.files(pendingScope)[0]!.id;
    await act(async () => {
      moving = f.attachments.move(pendingScope, createdScope);
      await reached.promise;
    });
    await act(async () => f.attachments.removeIds([id]));
    expect(f.attachments.files(pendingScope)).toEqual([]);
    await act(async () => {
      release.resolve();
      await moving;
      await f.attachments.flush(pendingScope);
      await f.attachments.flush(createdScope);
    });
    expect(f.attachments.files(pendingScope)).toEqual([]);
    expect(f.attachments.files(createdScope)).toEqual([]);
    expect(f.main.read('new-conversation', 'workspace').attachments).toEqual([]);
    expect(f.main.read('created-session').attachments).toEqual([]);
    await f.remount();
    await act(async () => f.attachments.restore(createdScope, 'created-session'));
    expect(f.attachments.files(createdScope)).toEqual([]);
  } finally {
    release.resolve();
    await moving;
    await f.close();
  }
});

/** An accepted mixed input is later rejected before a Run or Message is admitted. */
async function acceptedRecoveryFixture() {
  const f = await fixture();
  f.main.setSessionWorkspace('session-a', 'workspace');
  try {
    await act(async () => {
      await f.attachments.restore('a', 'session-a', 'workspace');
      await f.attachments.add('a', [f.file('original.png')]);
      const prepared = await f.attachments.fileReferences([
        f.file('original.pdf', 'application/pdf'),
      ]);
      f.attachments.addFiles('a', prepared);
      await f.attachments.flush('a');
    });
    await f.send();
    await f.settleSend();
    const receipt = f.sends[0]!;
    expect(f.main.consume('session-a', receipt.revision!, 'workspace')).toBe(true);
    await act(async () => {
      f.attachments.accepted('a', receipt.revision, receipt.ids);
      await f.attachments.flush('a');
    });
    expect(f.attachments.get('a')).toEqual([]);
    expect(f.attachments.files('a')).toEqual([]);
    return { f, receipt };
  } catch (error) {
    await f.close();
    throw error;
  }
}

const attachmentIds = (f: Awaited<ReturnType<typeof fixture>>, scope = 'a') =>
  [...f.attachments.get(scope), ...f.attachments.files(scope)].map((item) => item.id).sort();

test('authoritative rejection restores only new prepared IDs and preserves later attachments, text and the confirmed revision', async () => {
  const { f, receipt } = await acceptedRecoveryFixture();
  const reached = deferred(),
    release = deferred();
  try {
    await act(async () => {
      f.attachments.addFiles('a', [reference('later-B.txt')]);
      await setPromptText(document.querySelector('[role="textbox"]')!, '编辑后的草稿 B');
      await f.attachments.flush('a');
    });
    const laterId = f.attachments.files('a')[0]!.id;
    const proof = f.main.recoverRejected('session-a', receipt.revision!, 'workspace', 'command-a');
    f.main.host.before = async (request) => {
      if (request.method === 'input.attachments.read') {
        reached.resolve();
        await release.promise;
      }
    };
    await act(async () => {
      f.attachments.recovery('a', 'command-a', proof);
      await reached.promise;
    });
    await act(async () => {
      await setPromptText(document.querySelector('[role="textbox"]')!, '恢复期间仍然编辑');
      f.attachments.addFiles('a', [reference('later-C.txt')]);
    });
    const newestId = f.attachments.files('a').find((item) => item.name === 'later-C.txt')!.id;
    let revision: number | undefined;
    await act(async () => {
      release.resolve();
      revision = await f.attachments.flush('a');
    });
    expect(attachmentIds(f)).toEqual([laterId, newestId, ...proof.ids!].sort());
    expect(attachmentIds(f).some((id) => receipt.ids.includes(id))).toBe(false);
    expect(promptValue(document.querySelector('[role="textbox"]'))).toBe('恢复期间仍然编辑');
    expect(f.attachments.error('a')).toBeUndefined();
    expect(f.attachments.blocked('a')).toBe(false);
    expect(revision).toBe(f.main.read('session-a').revision);
    expect(
      f.main
        .read('session-a')
        .attachments.map((item) => item.id)
        .sort(),
    ).toEqual(attachmentIds(f));
    expect(f.attachments.get('a')[0]?.name).toBe('original.png');
    expect(
      f.attachments.files('a').some((item) => item.name === 'original.pdf' && item.prepared),
    ).toBe(true);
    expect(f.sends).toHaveLength(1);
  } finally {
    release.resolve();
    await f.close();
  }
});

test('duplicate restored receipts neither duplicate attachments nor resurrect recovery IDs explicitly removed afterwards', async () => {
  const { f, receipt } = await acceptedRecoveryFixture();
  try {
    const proof = f.main.recoverRejected('session-a', receipt.revision!, 'workspace', 'command-a');
    await act(async () => {
      await f.attachments.recovery('a', 'command-a', proof);
      await f.attachments.flush('a');
    });
    expect(attachmentIds(f)).toEqual([...proof.ids!].sort());
    const revision = f.main.read('session-a').revision;
    await act(async () => {
      await f.attachments.recovery('a', 'command-a', proof);
      f.attachments.accepted('a', receipt.revision, receipt.ids);
      await f.attachments.flush('a');
    });
    expect(attachmentIds(f)).toEqual([...proof.ids!].sort());
    expect(f.main.read('session-a').revision).toBe(revision);
    await act(async () => {
      f.attachments.removeIds(proof.ids!);
      await f.attachments.flush('a');
    });
    const removed = f.main.read('session-a');
    await act(async () => {
      await f.attachments.recovery('a', 'command-a', proof);
      await f.attachments.flush('a');
    });
    expect(attachmentIds(f)).toEqual([]);
    expect(f.main.read('session-a')).toEqual(removed);
    expect(f.sends).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test('recovery cannot overwrite or adopt an unfamiliar other-window draft and leaves sending blocked', async () => {
  const { f, receipt } = await acceptedRecoveryFixture();
  try {
    await act(async () => {
      f.attachments.addFiles('a', [reference('local-B.txt')]);
      await f.attachments.flush('a');
    });
    const localId = f.attachments.files('a')[0]!.id;
    f.main.appendDurable(
      'session-a',
      [
        {
          id: 'foreign-window',
          kind: 'reference',
          name: 'foreign.txt',
          uri: 'file:///foreign.txt',
          state: 'ready',
        },
      ],
      'workspace',
    );
    const proof = f.main.recoverRejected('session-a', receipt.revision!, 'workspace', 'command-a');
    const durable = f.main.read('session-a');
    const writes = f.main.calls.filter(
      (request) => request.method === 'input.attachments.write',
    ).length;
    await act(async () => {
      await f.attachments.recovery('a', 'command-a', proof);
      await expect(f.attachments.flush('a')).rejects.toThrow('attachment_draft_unavailable');
    });
    expect(attachmentIds(f)).toContain(localId);
    expect(attachmentIds(f)).not.toContain('foreign-window');
    expect(f.attachments.blocked('a')).toBe(true);
    expect(f.main.read('session-a')).toEqual(durable);
    expect(
      f.main.calls.filter((request) => request.method === 'input.attachments.write'),
    ).toHaveLength(writes);
    expect(sendButton().disabled).toBe(true);
    expect(f.sends).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test('a late recovery stays in its exact original session and cannot repaint the selected other session', async () => {
  const { f, receipt } = await acceptedRecoveryFixture();
  const reached = deferred(),
    release = deferred();
  try {
    f.main.setSessionWorkspace('session-b', 'workspace');
    await act(async () => {
      await f.attachments.restore('b', 'session-b', 'workspace');
      f.attachments.addFiles('b', [reference('scope-B.txt')]);
      await f.attachments.flush('b');
    });
    const second = f.main.read('session-b');
    const proof = f.main.recoverRejected('session-a', receipt.revision!, 'workspace', 'command-a');
    f.main.host.before = async (request) => {
      if (request.method === 'input.attachments.read' && request.sessionId === 'session-a') {
        reached.resolve();
        await release.promise;
      }
    };
    await act(async () => {
      f.attachments.recovery('a', 'command-a', proof);
      await reached.promise;
    });
    await f.render('b');
    await act(async () => {
      await setPromptText(document.querySelector('[role="textbox"]')!, '会话 B 的新文字');
      release.resolve();
      await f.attachments.flush('a');
    });
    expect(attachmentIds(f, 'a')).toEqual([...proof.ids!].sort());
    expect(f.attachments.files('b').map((item) => item.name)).toEqual(['scope-B.txt']);
    expect(document.querySelector('[aria-label="待发送附件"]')?.textContent).toBe('scope-B.txt');
    expect(promptValue(document.querySelector('[role="textbox"]'))).toBe('会话 B 的新文字');
    expect(f.main.read('session-b')).toEqual(second);
    expect(f.sends).toHaveLength(1);
  } finally {
    release.resolve();
    await f.close();
  }
});

test('recovery proof for another session or workspace cannot affect the current scope', async () => {
  const { f, receipt } = await acceptedRecoveryFixture();
  try {
    await act(async () => {
      f.attachments.addFiles('a', [reference('local.txt')]);
      await f.attachments.flush('a');
    });
    const ids = attachmentIds(f),
      durable = f.main.read('session-a');
    const calls = f.main.calls.length;
    const proof: NativeAttachmentRecovery = {
      phase: 'restored',
      sessionId: 'other-session',
      workspaceId: 'workspace',
      revision: receipt.revision,
      ids: ['foreign-recovery'],
    };
    await act(async () => {
      await f.attachments.recovery('a', 'foreign-command', proof);
      await f.attachments.recovery('a', 'foreign-command', {
        ...proof,
        sessionId: 'session-a',
        workspaceId: 'other-workspace',
      });
    });
    expect(attachmentIds(f)).toEqual(ids);
    expect(f.main.read('session-a')).toEqual(durable);
    expect(f.main.calls).toHaveLength(calls);
    expect(f.attachments.error('a')).toBeUndefined();
    expect(f.sends).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test('unavailable recovery preserves later work and its error until an authoritative restored proof arrives', async () => {
  const { f, receipt } = await acceptedRecoveryFixture();
  try {
    await act(async () => {
      f.attachments.addFiles('a', [reference('later.txt')]);
      await f.attachments.flush('a');
    });
    const laterId = f.attachments.files('a')[0]!.id;
    const unavailable: NativeAttachmentRecovery = {
      phase: 'unavailable',
      sessionId: 'session-a',
      workspaceId: 'workspace',
      error: 'attachment_recovery_unavailable',
    };
    await act(async () => f.attachments.recovery('a', 'command-a', unavailable));
    expect(f.attachments.blocked('a')).toBe(true);
    expect(f.attachments.error('a')).toMatch(/附件.*恢复|恢复.*附件/);
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(f.attachments.error('a'));
    expect(attachmentIds(f)).toEqual([laterId]);
    await act(async () => {
      await f.attachments.restore('a', 'session-a', 'workspace');
      await expect(f.attachments.flush('a')).rejects.toThrow('attachment_draft_unavailable');
    });
    expect(f.attachments.blocked('a')).toBe(true);
    const proof = f.main.recoverRejected('session-a', receipt.revision!, 'workspace', 'command-a');
    await act(async () => {
      await f.attachments.recovery('a', 'command-a', proof);
      await f.attachments.flush('a');
    });
    expect(attachmentIds(f)).toEqual([laterId, ...proof.ids!].sort());
    expect(f.attachments.error('a')).toBeUndefined();
    expect(f.attachments.blocked('a')).toBe(false);
    expect(f.sends).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test('a transient recovery read failure can retry the same proof without resending or duplicating original attachments', async () => {
  const { f, receipt } = await acceptedRecoveryFixture();
  try {
    const proof = f.main.recoverRejected('session-a', receipt.revision!, 'workspace', 'command-a');
    f.main.host.before = async (request) => {
      if (request.method === 'input.attachments.read') throw Error('read_unavailable');
    };
    await act(async () => f.attachments.recovery('a', 'command-a', proof));
    expect(f.attachments.blocked('a')).toBe(true);
    await act(async () => {
      await expect(f.attachments.flush('a')).rejects.toThrow('attachment_draft_unavailable');
    });
    expect(attachmentIds(f)).toEqual([]);
    f.main.host.before = undefined;
    await act(async () => {
      await f.attachments.recovery('a', 'command-a', proof);
      await f.attachments.flush('a');
    });
    expect(attachmentIds(f)).toEqual([...proof.ids!].sort());
    expect(f.attachments.error('a')).toBeUndefined();
    expect(f.sends).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test('a retired attachment owner cannot consume a new generation receipt or suppress its read-back', async () => {
  const f = await fixture();
  try {
    await act(async () => {
      await f.attachments.restore('a', 'session-a');
      f.attachments.addFiles('a', [reference('sent.txt')]);
      await f.attachments.flush('a');
    });
    const retired = f.attachments;
    const ids = retired.files('a').map((item) => item.id);
    await f.render('a', 2);
    await act(async () => f.attachments.restore('a', 'session-a'));
    expect(f.main.consume('session-a', 1)).toBe(true);
    const before = f.main.calls.length;
    await act(async () => retired.accepted('a', 1, ids));
    expect(f.attachments.files('a').map((item) => item.id)).toEqual(ids);
    expect(f.main.calls).toHaveLength(before);
    await act(async () => {
      f.attachments.accepted('a', 1, ids);
      await f.attachments.flush('a');
    });
    expect(f.attachments.files('a')).toEqual([]);
    expect(f.attachments.error('a')).toBeUndefined();
    expect(f.main.read('session-a')).toEqual({
      kind: 'input.attachments',
      revision: 2,
      attachments: [],
    });
    expect(
      f.main.calls.slice(before).filter((input) => input.method === 'input.attachments.read'),
    ).toHaveLength(1);
    expect(
      f.main.calls.slice(before).filter((input) => input.method === 'input.attachments.write'),
    ).toEqual([]);
    await act(async () => {
      retired.accepted('a', undefined, ids);
      f.attachments.accepted('a', 1, ids);
      f.attachments.addFiles('a', [reference('newer.txt')]);
      await f.attachments.flush('a');
    });
    expect(f.main.read('session-a').attachments.map((item) => item.name)).toEqual(['newer.txt']);
    await f.remount();
    await act(async () => f.attachments.restore('a', 'session-a'));
    expect(f.attachments.files('a').map((item) => item.name)).toEqual(['newer.txt']);
    expect(f.sends).toEqual([]);
  } finally {
    await f.close();
  }
});

test('a retired receipt cannot remove an identical attachment ID in another Store', async () => {
  const f = await fixture();
  const entry: NativePendingAttachment = {
    id: 'same-id',
    kind: 'reference',
    name: 'other-store.txt',
    uri: 'file:///other-store.txt',
    state: 'ready',
  };
  try {
    await act(async () => f.attachments.restore('a', 'session-a'));
    const retired = f.attachments;
    f.main.seed('session-a', [entry], undefined, 3);
    await f.render('a', 3);
    await act(async () => f.attachments.restore('a', 'session-a'));
    const before = f.main.calls.length;
    await act(async () => {
      retired.accepted('a', 1, ['same-id']);
      retired.accepted('a', undefined, ['same-id']);
      await f.attachments.flush('a');
    });
    expect(f.attachments.files('a').map((item) => item.id)).toEqual(['same-id']);
    expect(f.main.read('session-a', undefined, 3)).toEqual({
      kind: 'input.attachments',
      revision: 1,
      attachments: [entry],
    });
    expect(f.main.calls.slice(before)).toEqual([]);
    expect(f.attachments.error('a')).toBeUndefined();
  } finally {
    await f.close();
  }
});

test('quit waits for a hidden workspace image preparation and saves every scope before cold restoration', async () => {
  const f = await fixture();
  const reached = deferred(),
    release = deferred();
  let preparing: ReturnType<typeof f.attachments.add> | undefined;
  let quit: Promise<void> | undefined;
  let done = false;
  f.main.host.before = async (input) => {
    if (input.method === 'input.images.finish') {
      reached.resolve();
      await release.promise;
    }
  };
  try {
    await act(async () => f.attachments.restore(pendingScope, 'new-conversation', 'workspace'));
    await f.render(pendingScope);
    await act(async () => {
      preparing = f.attachments.add(pendingScope, [f.file()]);
      await reached.promise;
    });
    await act(async () => {
      await f.attachments.restore('b', 'session-b', 'workspace');
      f.attachments.addFiles('b', [reference('B.txt')]);
    });
    await f.render('b');
    await act(async () => {
      quit = f.attachments.flushForQuit().then(() => {
        done = true;
      });
    });
    expect(done).toBe(false);
    expect(f.attachments.get(pendingScope)[0]?.loading).toBe(true);
    await act(async () => {
      release.resolve();
      await preparing;
      await quit;
    });
    expect(done).toBe(true);
    expect(
      f.main.read('new-conversation', 'workspace').attachments.map((item) => item.name),
    ).toEqual(['photo.png']);
    expect(f.main.read('session-b', 'workspace').attachments.map((item) => item.name)).toEqual([
      'B.txt',
    ]);
    await f.remount();
    await act(async () => {
      await f.attachments.restore(pendingScope, 'new-conversation', 'workspace');
      await f.attachments.restore('b', 'session-b', 'workspace');
    });
    expect(f.attachments.get(pendingScope)).toHaveLength(1);
    expect(f.attachments.files('b').map((item) => item.name)).toEqual(['B.txt']);
    expect(f.sends).toEqual([]);
  } finally {
    release.resolve();
    await preparing;
    await quit;
    await f.close();
  }
});

for (const localFileReferences of [false, true]) {
  test(`quit waits for ${localFileReferences ? 'local reference' : 'prepared file'} adoption and deduplication, not just preparation`, async () => {
    const f = await fixture(undefined, { localFileReferences });
    let quit: Promise<void> | undefined;
    try {
      await act(async () => f.attachments.restore('a', 'session-a'));
      const refs = await f.attachments.fileReferences([f.file('chosen.txt', 'text/plain')]);
      let done = false;
      await act(async () => {
        quit = f.attachments.flushForQuit().then(() => {
          done = true;
        });
      });
      expect(done).toBe(false);
      await act(async () => {
        f.attachments.addFiles('a', refs);
        await quit;
      });
      expect(done).toBe(true);
      const first = f.main.read('session-a');
      expect(first.attachments.map((item) => item.name)).toEqual(['chosen.txt']);
      const duplicate = await f.attachments.fileReferences([f.file('chosen.txt', 'text/plain')]);
      done = false;
      await act(async () => {
        quit = f.attachments.flushForQuit().then(() => {
          done = true;
        });
      });
      expect(done).toBe(false);
      await act(async () => {
        f.attachments.addFiles('a', duplicate);
        await quit;
      });
      expect(f.main.read('session-a')).toEqual(first);
      expect(f.attachments.files('a')).toHaveLength(1);
      await f.remount();
      await act(async () => f.attachments.restore('a', 'session-a'));
      expect(f.attachments.files('a')).toHaveLength(1);
      expect(f.sends).toEqual([]);
    } finally {
      await quit;
      await f.close();
    }
  });
}

test('quit accepts an explicitly cancelled unclaimed file handoff without saving or resurrecting it', async () => {
  const f = await fixture();
  const abort = new AbortController();
  try {
    await act(async () => f.attachments.restore('a', 'session-a'));
    const refs = await f.attachments.fileReferences(
      [f.file('cancelled.txt', 'text/plain')],
      abort.signal,
    );
    let done = false;
    let quit!: Promise<void>;
    await act(async () => {
      quit = f.attachments.flushForQuit().then(() => {
        done = true;
      });
    });
    expect(done).toBe(false);
    await act(async () => {
      abort.abort();
      await quit;
    });
    expect(done).toBe(true);
    expect(f.main.read('session-a').attachments).toEqual([]);
    expect(f.main.calls.filter((input) => input.method === 'input.files.release')).toContainEqual({
      method: 'input.files.release',
      generation: 1,
      id: refs[0]!.id,
    });
    expect(f.attachments.files('a')).toEqual([]);
  } finally {
    abort.abort();
    await f.close();
  }
});

test('an image preparation failure cancels that quit, but its durable error does not permanently prevent closing', async () => {
  const f = await fixture();
  const reached = deferred(),
    release = deferred();
  let preparing: ReturnType<typeof f.attachments.add> | undefined;
  let quit: Promise<void> | undefined;
  f.main.host.before = async (input) => {
    if (input.method === 'input.images.append') {
      reached.resolve();
      await release.promise;
      throw Error('disk_unavailable');
    }
  };
  try {
    await act(async () => f.attachments.restore('a', 'session-a'));
    await act(async () => {
      preparing = f.attachments.add('a', [f.file()]);
      await reached.promise;
    });
    await act(async () => {
      quit = f.attachments.flushForQuit();
      void quit.catch(() => {});
    });
    await act(async () => {
      release.resolve();
      await preparing;
      await expect(quit!).rejects.toThrow('attachment_preparation_failed');
    });
    expect(f.attachments.get('a')[0]?.error).toContain('图片准备失败');
    expect(f.main.read('session-a').attachments[0]?.state).toBe('error');
    await act(async () => f.attachments.flushForQuit());
    await expect(f.attachments.flush('a')).rejects.toThrow('attachment_draft_unavailable');
    await f.remount();
    await act(async () => {
      await f.attachments.restore('a', 'session-a');
      await f.attachments.flushForQuit();
    });
    expect(f.attachments.get('a')[0]?.error).toContain('附件已失效');
  } finally {
    release.resolve();
    await preparing;
    await quit?.catch(() => {});
    await f.close();
  }
});

test('quit retries a hidden uncertain write only against known durable snapshots and never overwrites another window', async () => {
  const f = await fixture();
  try {
    await act(async () => f.attachments.restore('a', 'session-a'));
    f.main.host.failure = 'disk_unavailable';
    await act(async () => f.attachments.addFiles('a', [reference('unsaved.txt')]));
    await f.render('b');
    await act(async () => {
      await f.attachments.restore('b', 'session-b');
      await expect(f.attachments.flushForQuit()).rejects.toThrow('attachment_draft_unavailable');
    });
    f.main.host.failure = undefined;
    f.main.seed('session-a', [
      {
        id: 'foreign',
        kind: 'reference',
        name: 'foreign.txt',
        uri: 'file:///foreign.txt',
        state: 'ready',
      },
    ]);
    await act(async () => {
      await expect(f.attachments.flushForQuit()).rejects.toThrow('attachment_draft_unavailable');
    });
    expect(f.main.read('session-a').attachments.map((item) => item.name)).toEqual(['foreign.txt']);
    f.main.seed('session-a', []);
    await act(async () => f.attachments.flushForQuit());
    expect(f.main.read('session-a').attachments.map((item) => item.name)).toEqual(['unsaved.txt']);
    expect(f.sends).toEqual([]);
  } finally {
    await f.close();
  }
});

test('quit preserves durable invalid attachments and tolerates an untouched read-only restore failure', async () => {
  const main = durableHost();
  main.seed('session-a', [
    {
      id: 'invalid',
      kind: 'image',
      name: 'invalid.png',
      state: 'error',
      error: 'expired',
      size: 0,
    },
  ]);
  const f = await fixture(main);
  try {
    await act(async () => f.attachments.restore('a', 'session-a'));
    main.host.before = async (input) => {
      if (input.method === 'input.attachments.read' && input.sessionId === 'session-b')
        throw Error('read_unavailable');
    };
    await act(async () => f.attachments.restore('b', 'session-b'));
    const writes = main.calls.filter((input) => input.method === 'input.attachments.write').length;
    await act(async () => f.attachments.flushForQuit());
    expect(main.calls.filter((input) => input.method === 'input.attachments.write')).toHaveLength(
      writes,
    );
    expect(main.read('session-a').attachments[0]?.state).toBe('error');
    await expect(f.attachments.flush('a')).rejects.toThrow('attachment_draft_unavailable');
    expect(f.attachments.error('b')).toContain('待发送附件未能恢复');
  } finally {
    await f.close();
  }
});

test('a removal while quit waits for image preparation stays removed through cold restore', async () => {
  const f = await fixture();
  const reached = deferred(),
    release = deferred();
  let preparing: ReturnType<typeof f.attachments.add> | undefined;
  let quit: Promise<void> | undefined;
  f.main.host.before = async (input) => {
    if (input.method === 'input.images.finish') {
      reached.resolve();
      await release.promise;
    }
  };
  try {
    await act(async () => f.attachments.restore('a', 'session-a'));
    await act(async () => {
      preparing = f.attachments.add('a', [f.file()]);
      await reached.promise;
    });
    await act(async () => {
      quit = f.attachments.flushForQuit();
      f.attachments.removeIds([f.attachments.get('a')[0]!.id]);
      release.resolve();
      await preparing;
      await quit;
    });
    expect(f.main.read('session-a').attachments).toEqual([]);
    await f.remount();
    await act(async () => f.attachments.restore('a', 'session-a'));
    expect(f.attachments.get('a')).toEqual([]);
  } finally {
    release.resolve();
    await preparing;
    await quit;
    await f.close();
  }
});

for (const nextGeneration of [2, 3]) {
  test(`quit waiting on an old image is cancelled by connection ${nextGeneration} without blocking its new owner`, async () => {
    const f = await fixture();
    const reached = deferred(),
      release = deferred();
    let preparing: ReturnType<typeof f.attachments.add> | undefined;
    let quit: Promise<void> | undefined;
    f.main.host.before = async (input) => {
      if (input.method === 'input.images.finish') {
        reached.resolve();
        await release.promise;
      }
    };
    try {
      await act(async () => f.attachments.restore('a', 'session-a'));
      await act(async () => {
        preparing = f.attachments.add('a', [f.file()]);
        await reached.promise;
      });
      await act(async () => {
        quit = f.attachments.flushForQuit();
        void quit.catch(() => {});
      });
      await f.render('b', nextGeneration);
      await expect(quit!).rejects.toThrow('attachment_draft_inactive');
      await act(async () => f.attachments.flushForQuit());
      await act(async () => {
        release.resolve();
        await preparing;
      });
      expect(f.attachments.get('a')).toEqual([]);
      expect(f.main.calls.filter((input) => input.method === 'input.attachments.write')).toEqual(
        [],
      );
    } finally {
      release.resolve();
      await preparing;
      await quit?.catch(() => {});
      await f.close();
    }
  });
}

for (const laterEdit of [false, true]) {
  test(`quit waits for an atomic move and preserves its unknown recovery path (later edit: ${laterEdit})`, async () => {
    const f = await fixture();
    const reached = deferred(),
      release = deferred();
    f.main.setSessionWorkspace('created-session', 'workspace');
    let move: Promise<void> | undefined, quit: Promise<void> | undefined;
    f.main.host.afterMove = async () => {
      reached.resolve();
      await release.promise;
      throw Error('lost_move_response');
    };
    try {
      await act(async () => {
        await f.attachments.restore(pendingScope, 'new-conversation', 'workspace');
        f.attachments.addFiles(pendingScope, [reference('moved.txt')]);
        await f.attachments.flush(pendingScope);
      });
      await act(async () => {
        move = f.attachments.move(pendingScope, createdScope);
        await reached.promise;
      });
      let done = false;
      await act(async () => {
        quit = f.attachments.flushForQuit().then(() => {
          done = true;
        });
        void quit.catch(() => {});
      });
      expect(done).toBe(false);
      if (laterEdit)
        await act(async () => f.attachments.addFiles(pendingScope, [reference('later.txt')]));
      await act(async () => {
        release.resolve();
        await move;
        if (laterEdit) await expect(quit!).rejects.toThrow('attachment_draft_unavailable');
        else await quit;
      });
      expect(done).toBe(!laterEdit);
      expect(
        f.main.read('created-session', 'workspace').attachments.map((item) => item.name),
      ).toEqual(['moved.txt']);
      if (!laterEdit) {
        await f.remount();
        await act(async () => f.attachments.restore(createdScope, 'created-session'));
        expect(f.attachments.files(createdScope).map((item) => item.name)).toEqual(['moved.txt']);
      } else
        expect(f.attachments.files(pendingScope).map((item) => item.name)).toContain('later.txt');
      expect(f.sends).toEqual([]);
    } finally {
      release.resolve();
      await move;
      await quit?.catch(() => {});
      await f.close();
    }
  });
}

test('an empty unattached owner may quit, but a local attachment without durable scope cannot', async () => {
  const f = await fixture(undefined, { generation: 0 });
  try {
    await act(async () => f.attachments.flushForQuit());
    await f.render('a', 1);
    await act(async () => f.attachments.addFiles('unrestored', [reference('local.txt')]));
    await expect(f.attachments.flushForQuit()).rejects.toThrow('attachment_draft_unavailable');
    expect(f.main.calls.filter((input) => input.method === 'input.attachments.write')).toEqual([]);
  } finally {
    await f.close();
  }
});
