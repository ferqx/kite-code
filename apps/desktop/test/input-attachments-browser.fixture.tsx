import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Composer } from '../../../packages/ui/src/desktop/Composer';
import type { NativeBridge } from '../src/native-bridge';
import { useNativeInputImages } from '../src/native-input-images';
import '../src/native-tailwind.css';
import '@kite-ai/ui/desktop/style.css';

// Standalone test artifact only. It imports the real Composer, draft owner and encoder;
// the bounded acknowledgement delay leaves time to exercise input while bytes are prepared.
const metrics = {
  encoding: false,
  frames: 0,
  maxFrameGapMs: 0,
  longestTaskMs: 0,
  maxDataURLBytes: 0,
  bufferReads: 0,
  chunks: 0,
  elapsedMs: 0,
};
const arrayBuffer = FileReader.prototype.readAsArrayBuffer;
FileReader.prototype.readAsArrayBuffer = function (blob) {
  metrics.bufferReads++;
  return arrayBuffer.call(this, blob);
};
const dataURL = FileReader.prototype.readAsDataURL;
FileReader.prototype.readAsDataURL = function (blob) {
  metrics.maxDataURLBytes = Math.max(metrics.maxDataURLBytes, blob.size);
  return dataURL.call(this, blob);
};
new PerformanceObserver((entries) => {
  if (metrics.encoding)
    for (const entry of entries.getEntries())
      metrics.longestTaskMs = Math.max(metrics.longestTaskMs, entry.duration);
}).observe({ type: 'longtask', buffered: false });
let previous = performance.now();
function frame(now: number) {
  if (metrics.encoding) {
    metrics.frames++;
    metrics.maxFrameGapMs = Math.max(metrics.maxFrameGapMs, now - previous);
  }
  previous = now;
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
const bridge = {
  request: async (request) => {
    if (request.method === 'input.images.append') {
      metrics.chunks++;
      await new Promise((resolve) => setTimeout(resolve, 8));
    }
    return null;
  },
  watch: () => () => {},
} as NativeBridge;
const pixel = Uint8Array.from(
  atob(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6VQAAAABJRU5ErkJggg==',
  ),
  (char) => char.charCodeAt(0),
);
function Fixture() {
  const attachments = useNativeInputImages(bridge, 1, 'isolated-fixture');
  const [scope, setScope] = useState('A'),
    [narrow, setNarrow] = useState(false),
    [drafts, setDrafts] = useState<Record<string, string>>({}),
    [, tick] = useState(0);
  const container = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const timer = setInterval(() => tick((value) => value + 1), 200);
    return () => clearInterval(timer);
  }, []);
  async function large() {
    if (metrics.encoding) return;
    const bytes = new Uint8Array(16 * 1024 * 1024);
    bytes.set(pixel);
    const files = Array.from(
      { length: 4 },
      (_, index) => new File([bytes], `large-${index + 1}.png`, { type: 'image/png' }),
    );
    Object.assign(metrics, {
      encoding: true,
      frames: 0,
      maxFrameGapMs: 0,
      longestTaskMs: 0,
      maxDataURLBytes: 0,
      bufferReads: 0,
      chunks: 0,
      elapsedMs: 0,
    });
    previous = performance.now();
    const began = performance.now();
    await attachments.add(scope, files);
    metrics.elapsedMs = performance.now() - began;
    metrics.encoding = false;
    tick((value) => value + 1);
  }
  const list = container.current?.querySelector<HTMLElement>('.composer-attachments');
  return (
    <main className="kite-client" style={{ padding: 24, minHeight: '100vh' }}>
      <h1>附件浏览器回归夹具</h1>
      <nav style={{ display: 'flex', gap: 16, marginBottom: 20 }}>
        <button type="button" onClick={() => setScope('A')}>
          会话 A
        </button>
        <button type="button" onClick={() => setScope('B')}>
          会话 B
        </button>
        <button type="button" onClick={() => setNarrow(!narrow)}>
          切换窄宽度
        </button>
        <button
          type="button"
          onClick={() =>
            attachments.addFiles(
              scope,
              Array.from({ length: 12 }, (_, index) => ({
                name: `${scope}-文件-${index + 1}.ini`,
                uri: `file:///fixture/${scope}/${index + 1}.ini`,
              })),
            )
          }
        >
          添加12个文件
        </button>
        <button type="button" onClick={() => void large()} disabled={metrics.encoding}>
          开始64MiB编码
        </button>
      </nav>
      <div ref={container} style={{ width: narrow ? 380 : 720, maxWidth: '100%' }}>
        <Composer
          scopeKey={scope}
          draft={drafts[scope] ?? ''}
          onChange={(text) => setDrafts((value) => ({ ...value, [scope]: text }))}
          disabled={false}
          active={false}
          stopping={false}
          files={attachments.files(scope)}
          images={attachments.get(scope)}
          onFileReferences={(files) =>
            window.kiteNative?.fileReferences
              ? window.kiteNative.fileReferences(files)
              : files.map((file) => ({
                  name: file.name,
                  uri: `file:///fixture/${scope}/${encodeURIComponent(file.name)}`,
                }))
          }
          onFilesSelected={(files) => attachments.addFiles(scope, files)}
          onRemoveFile={(id) => attachments.removeIds([id])}
          onRemoveImage={(id) => attachments.removeIds([id])}
          onImageFiles={(files) => attachments.add(scope, files)}
        />
      </div>
      <section aria-label="回归观测">
        <pre>
          {JSON.stringify(
            {
              scope,
              diskFileReferences: !!window.kiteNative?.fileReferences,
              files: attachments.files(scope).map((file) => file.name),
              images: attachments.get(scope).map((image) => ({
                name: image.name,
                loading: !!image.loading,
                error: image.error,
              })),
              draft: drafts[scope] ?? '',
              width: list?.clientWidth,
              scrollWidth: list?.scrollWidth,
              scrollLeft: list?.scrollLeft,
              rows: list
                ? new Set(
                    [...list.children].map((child) =>
                      Math.round(child.getBoundingClientRect().top),
                    ),
                  ).size
                : 0,
              ...metrics,
            },
            null,
            2,
          )}
        </pre>
      </section>
    </main>
  );
}
document.documentElement.dataset.theme = 'dark';
createRoot(document.getElementById('root')!).render(<Fixture />);
