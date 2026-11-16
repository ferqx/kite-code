// Explicit isolated test artifact. Never imported by the ordinary Native entrypoints.
import type { Execution, Message } from '@kite-ai/client';
import { useLayoutEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Composer } from '../../../packages/ui/src/desktop/Composer';
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from '../../../packages/ui/src/desktop/components/ui/dialog';
import { ImageGallery, type ImageGalleryItem } from '../../../packages/ui/src/desktop/ImageGallery';
import { ToolActivity } from '../../../packages/ui/src/desktop/ToolActivity';
import { nativeToolImages } from '../electron/tool-images';
import type { NativeBridge, NativeResult } from '../src/native-bridge';
import { NativeBrowserPane } from '../src/native-browser-pane';
import { NativeImageGalleryProvider } from '../src/native-image-gallery';
import { NativeImagePreviews } from '../src/native-image-previews';
import { useNativeInputImages } from '../src/native-input-images';
import { presentNativePreview } from '../src/native-preview-presentation';
import { NativeUserImages } from '../src/native-user-images';
import '../src/native-tailwind.css';
import '@kite-ai/ui/desktop/style.css';

const digest = async (bytes: BufferSource) =>
  [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
    .map((v) => v.toString(16).padStart(2, '0'))
    .join('');
const files: File[] = [];
for (let i = 0; i < 5; i++) {
  const canvas = new OffscreenCanvas(4096, 2304),
    ctx = canvas.getContext('2d')!;
  ctx.fillStyle = ['#20295e', '#663861', '#225853', '#785536', '#393e7a'][i]!;
  ctx.fillRect(0, 0, 4096, 2304);
  ctx.fillStyle = 'white';
  ctx.font = 'bold 180px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(`Kite 图像预览 ${i + 1}`, 2048, 580);
  ctx.fillStyle = '#b9c8fa';
  ctx.font = '90px sans-serif';
  ctx.fillText('4096 × 2304 · 原始高分辨率', 2048, 800);
  for (let n = 0; n < 4; n++) {
    ctx.fillStyle = '#00b5a3';
    ctx.beginPath();
    ctx.arc(700 + n * 900, 1350, 110, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'white';
    ctx.font = 'bold 96px sans-serif';
    ctx.fillText(String(n + 1), 700 + n * 900, 1380);
  }
  ctx.fillStyle = '#d6defc';
  ctx.font = '54px sans-serif';
  ctx.fillText('从机会验证到上市落地', 2048, 1780);
  ctx.strokeStyle = '#ddddff';
  ctx.lineWidth = 1;
  for (let x = 0; x < 1024; x += 4) {
    ctx.beginPath();
    ctx.moveTo(x, 2090);
    ctx.lineTo(x + 200, 2290);
    ctx.stroke();
  }
  files.push(
    new File([await canvas.convertToBlob({ type: 'image/png' })], `original-${i + 1}.png`, {
      type: 'image/png',
    }),
  );
}
files.push(new File([files[0]!], 'original-1.png', { type: 'image/png' }));
const bytes = await Promise.all(
  files.map(async (file) => new Uint8Array(await file.arrayBuffer())),
);
const hashes = await Promise.all(bytes.map((v) => digest(v.buffer as ArrayBuffer)));
const metrics = {
  requests: [] as {
    method: string;
    messageId?: string;
    index?: number;
    readId?: string;
    offset?: number;
    at: number;
  }[],
  reads: [] as {
    readId: string;
    index: number;
    messageId?: string;
    openAt: number;
    openedAt?: number;
    doneAt?: number;
    closeAt?: number;
    bytes: number;
    chunks: number;
  }[],
  readDelayMs: 0,
  originals: hashes,
  failed: false,
  held: false,
};
const leases = new Map<string, number>();
let hold = false,
  fail = false;
const releases: (() => void)[] = [];
const bridge: NativeBridge = {
  ...window.kiteNative!,
  watch: () => () => {},
  async request(request): Promise<NativeResult> {
    metrics.requests.push({
      method: request.method,
      at: performance.timeOrigin + performance.now(),
      ...('readId' in request ? { readId: request.readId } : {}),
      ...('offset' in request && typeof request.offset === 'number'
        ? { offset: request.offset }
        : {}),
      ...('messageId' in request ? { messageId: request.messageId } : {}),
      ...('index' in request ? { index: request.index } : {}),
    });
    if (request.method === 'input.image.open' || request.method === 'background.child.image.open') {
      const index =
        'messageId' in request && request.messageId.startsWith('other-')
          ? request.index + 3
          : request.index;
      leases.set(request.readId, index);
      const span = {
        readId: request.readId,
        index,
        ...('messageId' in request ? { messageId: request.messageId } : {}),
        openAt: performance.timeOrigin + performance.now(),
        bytes: 0,
        chunks: 0,
      } as (typeof metrics.reads)[number];
      metrics.reads.push(span);
      if (metrics.readDelayMs)
        await new Promise((resolve) => setTimeout(resolve, metrics.readDelayMs));
      if (hold) await new Promise<void>((resolve) => releases.push(resolve));
      if (fail) throw Error('fixture_original_temporarily_unavailable');
      span.openedAt = performance.timeOrigin + performance.now();
      return {
        kind: 'input.image.open',
        readId: request.readId,
        mediaType: 'image/png',
        size: bytes[index]!.length,
        hash: hashes[index]!,
      };
    }
    if (request.method === 'input.image.read' || request.method === 'background.child.image.read') {
      if (metrics.readDelayMs)
        await new Promise((resolve) => setTimeout(resolve, metrics.readDelayMs));
      const value = bytes[leases.get(request.readId)!]!,
        part = value.subarray(request.offset, request.offset + 65536);
      const span = metrics.reads.find((value) => value.readId === request.readId);
      if (span) {
        span.bytes += part.length;
        span.chunks++;
        if (request.offset + part.length === value.length)
          span.doneAt = performance.timeOrigin + performance.now();
      }
      return {
        kind: 'input.image.chunk',
        readId: request.readId,
        offset: request.offset,
        nextOffset: request.offset + part.length,
        done: request.offset + part.length === value.length,
        data: btoa(String.fromCharCode(...part)),
      };
    }
    if (
      request.method === 'input.image.close' ||
      request.method === 'background.child.image.close'
    ) {
      const span = metrics.reads.find((value) => value.readId === request.readId);
      if (span) span.closeAt = performance.timeOrigin + performance.now();
      leases.delete(request.readId);
    }
    return null;
  },
};
// Adversarial isolated sources deliberately ignore abort while held, so a late B
// can settle after C without changing the production Native reader or its queue.
const controlledHeld = new Set<number>(),
  controlledFailed = new Set<number>();
const controlledReleases = new Map<number, (() => void)[]>();
const controlledReads: {
  index: number;
  at: number;
  settledAt?: number;
  abortedAt?: number;
  failed?: boolean;
}[] = [];
const controlledImages: ImageGalleryItem[] = files.map((file, index) => ({
  id: String(index),
  name: file.name,
  source: {
    async load(signal) {
      const read = {
        index,
        at: performance.timeOrigin + performance.now(),
      } as (typeof controlledReads)[number];
      controlledReads.push(read);
      signal.addEventListener(
        'abort',
        () => {
          read.abortedAt = performance.timeOrigin + performance.now();
        },
        { once: true },
      );
      if (controlledHeld.has(index))
        await new Promise<void>((resolve) => {
          const list = controlledReleases.get(index) ?? [];
          list.push(resolve);
          controlledReleases.set(index, list);
        });
      read.settledAt = performance.timeOrigin + performance.now();
      if (controlledFailed.has(index)) {
        read.failed = true;
        throw Error('isolated_source_failed');
      }
      return file;
    },
  },
}));
const previews = new NativeImagePreviews();
const images = files.map((file, index) => ({
  name: file.name,
  reference: {
    id: `image-${index}`,
    storeId: 'store',
    sessionId: 's',
    subjectId: 'owner',
    scope: { kind: 'session' as const, id: 's' },
    mediaType: 'image/png' as const,
    size: String(file.size),
    hash: hashes[index]!,
  },
}));
const toolRefs = images.map((image) => ({
  ...image.reference,
  scope: { kind: 'execution' as const, id: 'execution' },
}));
const content = JSON.stringify({
  images: files.map((file) => ({ path: `/synthetic/${file.name}` })),
});
const execution = {
  id: 'execution',
  sessionId: 's',
  originStoreId: 'store',
  definitionId: 'files.view_images',
  definitionVersion: '1',
  status: 'succeeded',
  result: { outcome: 'succeeded', content, artifactRefs: toolRefs, modelImages: toolRefs },
} as unknown as Execution;
function message(id: string, role: 'user' | 'tool' = 'user'): Message {
  return {
    id,
    sessionId: 's',
    seq: '1',
    runId: null,
    role,
    status: 'complete',
    content: '',
    files: [],
    images,
    ...(role === 'tool' ? { sourceIds: ['execution'] } : {}),
  } as Message;
}
function OfficeViewport() {
  const node = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const p = presentNativePreview(node.current!, window.kiteNative!, 1, 'fixture-office');
    p.ready();
    return () => p.dispose();
  }, []);
  return (
    <div
      ref={node}
      data-fixture-office
      style={{ height: '100%', borderRadius: 8, background: '#bbb' }}
    >
      Native document viewport
    </div>
  );
}
const errorItems: ImageGalleryItem[] = [
  {
    id: 'error',
    name: '重试原图.png',
    source: {
      async load(signal) {
        if (hold) await new Promise<void>((resolve) => releases.push(resolve));
        signal.throwIfAborted();
        if (fail) throw Error('unavailable');
        return files[2]!;
      },
    },
  },
];

function App() {
  const attachments = useNativeInputImages(bridge, 1, 'store');
  const [expanded, setExpanded] = useState<boolean>();
  const [readAvailable, setReadAvailable] = useState(true),
    [controlledSelected, setControlledSelected] = useState<string | null>(null),
    [controlledRemoved, setControlledRemoved] = useState<number[]>([]);
  const [mode, setMode] = useState('draft'),
    [draft, setDraft] = useState('保留这段草稿，预览不能改动。'),
    [scope, setScope] = useState('s'),
    [ordinary, setOrdinary] = useState(false),
    [native, setNative] = useState('browser'),
    [errorSelected, setErrorSelected] = useState<string | null>(null);
  const api = {
    async add() {
      await attachments.add('draft', files);
    },
    readAvailable: setReadAvailable,
    controlled(index: number) {
      setControlledSelected(String(index));
    },
    controlledHold(index: number, value: boolean) {
      if (value) controlledHeld.add(index);
      else {
        controlledHeld.delete(index);
        for (const release of controlledReleases.get(index) ?? []) release();
        controlledReleases.delete(index);
      }
    },
    controlledFail(index: number, value: boolean) {
      if (value) controlledFailed.add(index);
      else controlledFailed.delete(index);
    },
    controlledRemove(index: number) {
      setControlledRemoved((values) => [...values, index]);
    },
    readDelay(value: number) {
      metrics.readDelayMs = value;
    },
    clearTrace() {
      metrics.requests.length = 0;
      metrics.reads.length = 0;
    },
    mode: setMode,
    native: setNative,
    scope: setScope,
    ordinary: setOrdinary,
    hold(value: boolean) {
      hold = value;
      metrics.held = value;
    },
    fail(value: boolean) {
      fail = value;
      metrics.failed = value;
    },
    release() {
      hold = false;
      for (const resolve of releases.splice(0)) resolve();
    },
    error() {
      setErrorSelected('error');
    },
    snapshot() {
      return {
        mode,
        scope,
        draft,
        controlledReads,
        readAvailable,
        leases: leases.size,
        pending: releases.length,
        images: attachments
          .get('draft')
          .map(({ id, name, url, ...value }) => ({ id, name, url, ...value })),
        ...metrics,
      };
    },
  };
  Object.assign(window, { imageGalleryFixture: api });
  return (
    <div
      className="kite-client dark"
      data-theme="dark"
      style={{ height: '100vh', display: 'flex', background: '#18191d', color: '#ddd' }}
    >
      <aside style={{ width: 150, padding: 20, background: '#141518' }}>
        Kite
        <br />
        <p>聊天与历史</p>
        <button type="button" onClick={() => setMode('draft')}>
          草稿
        </button>
        <button type="button" onClick={() => setMode('messages')}>
          消息
        </button>
        <button type="button" onClick={() => setOrdinary(true)}>
          普通对话框
        </button>
        <button
          type="button"
          onClick={() => setNative((v) => (v === 'browser' ? 'office' : 'browser'))}
        >
          切换原生面板
        </button>
      </aside>
      <main style={{ flex: 1, minWidth: 0, padding: 24, overflow: 'auto' }}>
        <h2>图片预览 · 隔离真实 Electron 验收</h2>
        <p>一组 6 张，最后一张与第一张同名同字节。</p>
        {mode === 'draft' ? (
          <Composer
            scopeKey={scope}
            draft={draft}
            onChange={setDraft}
            disabled={false}
            active={false}
            stopping={false}
            images={attachments.get('draft')}
            onRemoveImage={(id) => attachments.removeIds([id])}
          />
        ) : (
          <div
            className="conversation-viewport"
            style={{ overflow: 'auto', maxHeight: 'calc(100vh - 130px)' }}
          >
            <section data-fixture-user>
              <h3>用户消息</h3>
              <NativeUserImages
                bridge={bridge}
                previews={previews}
                generation={1}
                viewSelection={1}
                historyEpoch={0}
                readAvailable={readAvailable}
                message={message(`user-${scope}`)}
              />
            </section>
            <section data-fixture-tool>
              <h3>Agent · view_images</h3>
              <ToolActivity
                expanded={expanded}
                onToggle={setExpanded}
                messages={[
                  {
                    id: 'tool',
                    role: 'tool',
                    toolName: 'view_images',
                    text: content,
                    status: 'completed',
                    settled: true,
                    toolImageCount: 6,
                  },
                ]}
                renderChildren={() => null}
                renderImages={() => (
                  <NativeUserImages
                    bridge={bridge}
                    previews={previews}
                    generation={1}
                    viewSelection={1}
                    historyEpoch={0}
                    readAvailable={readAvailable}
                    message={message(`tool-${scope}`, 'tool')}
                    images={nativeToolImages(execution)}
                  />
                )}
              />
            </section>
            <section data-fixture-isolated>
              <h3>另一条用户消息 · 不应跨组</h3>
              <NativeUserImages
                bridge={bridge}
                previews={previews}
                generation={1}
                viewSelection={1}
                historyEpoch={0}
                readAvailable={readAvailable}
                message={{ ...message(`other-${scope}`), images: images.slice(3, 5) }}
              />
            </section>
          </div>
        )}
        <button type="button" onClick={() => setErrorSelected('error')}>
          隔离原图失败恢复
        </button>
      </main>
      <aside style={{ width: '32%', minWidth: 250, padding: 12, background: '#23252b' }}>
        <h3>右侧原生 {native}</h3>
        <div style={{ height: 'calc(100% - 55px)', display: 'flex', flexDirection: 'column' }}>
          {native === 'browser' ? (
            <NativeBrowserPane
              id="gallery-native-browser"
              visible
              tools={null}
              onTitleChange={() => {}}
              draft="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
            />
          ) : (
            <OfficeViewport />
          )}
        </div>
      </aside>
      <Dialog open={ordinary} onOpenChange={setOrdinary}>
        <DialogContent>
          <DialogTitle>普通对话框</DialogTitle>
          <p>图像预览应该位于这个对话框之上。</p>
          <button type="button" onClick={() => setErrorSelected('error')}>
            从对话框打开图片
          </button>
        </DialogContent>
      </Dialog>
      <ImageGallery
        images={controlledImages.filter((_, index) => !controlledRemoved.includes(index))}
        selectedId={controlledSelected}
        onSelectedIdChange={setControlledSelected}
        scopeKey={scope}
      />
      <ImageGallery
        images={errorItems}
        selectedId={errorSelected}
        onSelectedIdChange={setErrorSelected}
        scopeKey={scope}
      />
    </div>
  );
}
declare global {
  interface Window {
    imageGalleryFixture: {
      add(): Promise<void>;
      readAvailable(value: boolean): void;
      controlled(index: number): void;
      controlledHold(index: number, value: boolean): void;
      controlledFail(index: number, value: boolean): void;
      controlledRemove(index: number): void;
      readDelay(value: number): void;
      clearTrace(): void;
      mode(value: string): void;
      native(value: string): void;
      scope(value: string): void;
      ordinary(value: boolean): void;
      hold(value: boolean): void;
      fail(value: boolean): void;
      release(): void;
      error(): void;
      snapshot(): unknown;
    };
  }
}
createRoot(document.getElementById('root')!).render(
  <NativeImageGalleryProvider>
    <App />
  </NativeImageGalleryProvider>,
);
