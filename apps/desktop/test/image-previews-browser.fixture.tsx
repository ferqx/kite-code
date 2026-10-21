import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Composer } from '../../../packages/ui/src/desktop/Composer';
import { Conversation } from '../../../packages/ui/src/desktop/Conversation';
import { ConversationCache } from '../../../packages/ui/src/desktop/ConversationCache';
import type { NativeBridge, NativeRequest, NativeResult } from '../src/native-bridge';
import { useNativeInputImages } from '../src/native-input-images';
import { NativeUserImages } from '../src/native-user-images';
import '../src/native-tailwind.css';
import '@kite-ai/ui/desktop/style.css';

const metrics = {
  conversions: 0,
  peakConversions: 0,
  active: 0,
  imageReads: 0,
  originalBytes: 0,
  originalMatches: 0,
  elapsedMs: 0,
  longestTaskMs: 0,
  maxFrameGapMs: 0,
  measuring: false,
};
const OriginalWorker = Worker;
class MeasuredWorker extends OriginalWorker {
  private converting = false;
  constructor(url: string | URL, options?: WorkerOptions) {
    super(url, options);
    this.addEventListener('message', () => {
      this.finished();
    });
    this.addEventListener('error', () => {
      this.finished();
    });
  }
  private finished() {
    if (this.converting) metrics.active--;
    this.converting = false;
  }
  override postMessage(value: unknown, options?: Transferable[] | StructuredSerializeOptions) {
    if (value && typeof value === 'object' && 'source' in value && value.source instanceof Blob) {
      metrics.conversions++;
      metrics.active++;
      this.converting = true;
      metrics.peakConversions = Math.max(metrics.peakConversions, metrics.active);
    }
    if (Array.isArray(options)) super.postMessage(value, options);
    else super.postMessage(value, options);
  }
  override terminate() {
    this.finished();
    super.terminate();
  }
}
Object.defineProperty(window, 'Worker', { value: MeasuredWorker });
new PerformanceObserver((list) => {
  if (metrics.measuring)
    for (const entry of list.getEntries())
      metrics.longestTaskMs = Math.max(metrics.longestTaskMs, entry.duration);
}).observe({ type: 'longtask' });
let lastFrame = performance.now();
requestAnimationFrame(function frame(now) {
  if (metrics.measuring) metrics.maxFrameGapMs = Math.max(metrics.maxFrameGapMs, now - lastFrame);
  lastFrame = now;
  requestAnimationFrame(frame);
});
let files: File[] = [],
  sourceBytes: Uint8Array[] = [],
  hashes: string[] = [];
const drafts = new Map<string, { hash: string; chunks: Uint8Array[] }>();
const leases = new Map<string, number>();
const digest = async (data: BufferSource) =>
  [...new Uint8Array(await crypto.subtle.digest('SHA-256', data))]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
const bridge: NativeBridge = {
  watch: () => () => {},
  async request(request: NativeRequest): Promise<NativeResult> {
    if (request.method === 'input.images.begin')
      drafts.set(request.id, { hash: request.hash, chunks: [] });
    if (request.method === 'input.images.append')
      drafts
        .get(request.id)!
        .chunks.push(Uint8Array.from(atob(request.data), (byte) => byte.charCodeAt(0)));
    if (request.method === 'input.images.finish') {
      const draft = drafts.get(request.id)!;
      const buffer = await new Blob(draft.chunks as BlobPart[]).arrayBuffer();
      metrics.originalBytes += buffer.byteLength;
      if ((await digest(buffer)) === draft.hash && hashes.includes(draft.hash))
        metrics.originalMatches++;
    }
    if (request.method === 'input.images.release') drafts.delete(request.id);
    if (request.method === 'input.image.open') {
      metrics.imageReads++;
      leases.set(request.readId, request.index);
      return {
        kind: 'input.image.open',
        readId: request.readId,
        mediaType: 'image/jpeg',
        size: sourceBytes[request.index]!.length,
        hash: hashes[request.index]!,
      };
    }
    if (request.method === 'input.image.read') {
      const bytes = sourceBytes[leases.get(request.readId)!]!;
      const data = bytes.subarray(request.offset, request.offset + 65536);
      return {
        kind: 'input.image.chunk',
        readId: request.readId,
        offset: request.offset,
        nextOffset: request.offset + data.length,
        done: request.offset + data.length === bytes.length,
        data: btoa(String.fromCharCode(...data)),
      };
    }
    if (request.method === 'input.image.close') leases.delete(request.readId);
    return null;
  },
};
function App() {
  const attachments = useNativeInputImages(bridge, 1, 'store');
  const [view, setView] = useState('draft'),
    [version, setVersion] = useState(1),
    [draft, setDraft] = useState('');
  const api = {
    async formats() {
      const canvas = new OffscreenCanvas(8, 4);
      const context = canvas.getContext('2d')!;
      context.fillStyle = 'rgba(255, 0, 0, 0.5)';
      context.fillRect(0, 0, 8, 4);
      const inputs = [
        await canvas.convertToBlob({ type: 'image/png' }),
        await canvas.convertToBlob({ type: 'image/webp' }),
        new Blob(
          [
            Uint8Array.from(
              atob('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'),
              (byte) => byte.charCodeAt(0),
            ),
          ],
          { type: 'image/gif' },
        ),
      ];
      const jpeg = new Uint8Array(
        await (await canvas.convertToBlob({ type: 'image/jpeg' })).arrayBuffer(),
      );
      const exif = new Uint8Array([
        255, 225, 0, 34, 69, 120, 105, 102, 0, 0, 73, 73, 42, 0, 8, 0, 0, 0, 1, 0, 18, 1, 3, 0, 1,
        0, 0, 0, 6, 0, 0, 0, 0, 0, 0, 0,
      ]);
      inputs.push(new Blob([jpeg.subarray(0, 2), exif, jpeg.subarray(2)], { type: 'image/jpeg' }));
      const results = [];
      for (const input of inputs) {
        const preview = await attachments.previews.prepare(
          input,
          await digest(await input.arrayBuffer()),
          new AbortController().signal,
        );
        const bitmap = await createImageBitmap(preview.blob);
        const output = new OffscreenCanvas(bitmap.width, bitmap.height),
          ctx = output.getContext('2d')!;
        ctx.drawImage(bitmap, 0, 0);
        results.push({
          type: input.type,
          outputType: preview.blob.type,
          width: bitmap.width,
          height: bitmap.height,
          alpha: ctx.getImageData(0, 0, 1, 1).data[3],
        });
        bitmap.close();
        output.width = output.height = 0;
      }
      canvas.width = canvas.height = 0;
      return results;
    },
    async generate() {
      const worker = new Worker(
        new URL('./image-previews-source-worker.fixture.ts', import.meta.url),
        { type: 'module' },
      );
      const blobs = await new Promise<Blob[]>((resolve, reject) => {
        worker.onmessage = (event) => resolve(event.data);
        worker.onerror = reject;
        worker.postMessage(null);
      });
      worker.terminate();
      files = blobs.map(
        (blob, index) => new File([blob], `photo-${index}.jpg`, { type: blob.type }),
      );
      sourceBytes = await Promise.all(
        files.map(async (file) => new Uint8Array(await file.arrayBuffer())),
      );
      hashes = await Promise.all(sourceBytes.map((bytes) => digest(bytes.buffer as ArrayBuffer)));
      return files.reduce((sum, file) => sum + file.size, 0);
    },
    async add() {
      metrics.measuring = true;
      metrics.longestTaskMs = metrics.maxFrameGapMs = 0;
      lastFrame = performance.now();
      const start = performance.now();
      await attachments.add('draft', files);
      metrics.elapsedMs = performance.now() - start;
      metrics.measuring = false;
    },
    clearDraft() {
      attachments.removeIds(attachments.get('draft').map((image) => image.id));
    },
    select(id: string) {
      setView(id);
      setVersion((value) => value + 1);
    },
    refresh() {
      setVersion((value) => value + 1);
    },
    snapshot() {
      return {
        ...metrics,
        previews: [...document.querySelectorAll<HTMLImageElement>('img')].map((image) => ({
          src: image.src,
          width: image.naturalWidth,
          height: image.naturalHeight,
          decoded: image.complete,
        })),
        errors: attachments
          .get('draft')
          .map((image) => image.error ?? image.previewError)
          .filter(Boolean),
      };
    },
  };
  Object.assign(window, { imagePreviewFixture: api });
  return (
    <div
      className="kite-client"
      style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}
    >
      <nav>
        <button type="button" onClick={() => api.select('draft')}>
          输入区
        </button>
        <button type="button" onClick={() => api.select('a')}>
          会话A
        </button>
        <button type="button" onClick={() => api.select('b')}>
          会话B
        </button>
      </nav>
      {view === 'draft' ? (
        <Composer
          scopeKey="draft"
          draft={draft}
          onChange={setDraft}
          disabled={false}
          active={false}
          stopping={false}
          images={attachments.get('draft')}
          onRemoveImage={(id) => attachments.removeIds([id])}
        />
      ) : (
        <ConversationCache
          identity={view}
          visible
          loading={false}
          cache={{ scope: 'window/store', revision: '0', readActive: true }}
        >
          <Conversation
            key={view}
            loading={false}
            selected
            connected
            saveReading={() => {}}
            messages={[
              {
                id: view,
                role: 'user',
                text: view === 'a' ? '十张原图的缩略图预览' : '另一个会话',
                settled: true,
              },
            ]}
            renderMessageContent={() =>
              view === 'a' ? (
                <NativeUserImages
                  bridge={bridge}
                  previews={attachments.previews}
                  generation={1}
                  viewSelection={version}
                  historyEpoch={0}
                  readAvailable
                  message={{
                    id: 'message-a',
                    sessionId: 'a',
                    seq: '1',
                    runId: null,
                    role: 'user',
                    status: 'complete',
                    content: '',
                    images: files.map((file, index) => ({
                      name: file.name,
                      reference: {
                        id: `image-${index}`,
                        storeId: 'store',
                        sessionId: 'a',
                        subjectId: 'owner',
                        scope: { kind: 'session', id: 'a' },
                        mediaType: 'image/jpeg',
                        size: String(file.size),
                        hash: hashes[index]!,
                      },
                    })),
                  }}
                />
              ) : (
                <p>另一个会话</p>
              )
            }
          />
        </ConversationCache>
      )}
    </div>
  );
}
declare global {
  interface Window {
    imagePreviewFixture: {
      generate: () => Promise<number>;
      formats: () => Promise<
        {
          type: string;
          outputType: string;
          width: number;
          height: number;
          alpha: number | undefined;
        }[]
      >;
      add: () => Promise<void>;
      clearDraft: () => void;
      select: (id: string) => void;
      refresh: () => void;
      snapshot: () => typeof metrics & {
        previews: { src: string; width: number; height: number; decoded: boolean }[];
        errors: string[];
      };
    };
  }
}
createRoot(document.getElementById('root')!).render(<App />);
