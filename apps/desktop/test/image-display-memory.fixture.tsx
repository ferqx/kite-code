// Isolated pressure artifact: exact fixture-source allowlist, production display pipeline.
import { ImageGallery, type ImageGalleryItem } from '@kite-ai/ui/desktop';
import { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { NativeImageGalleryProvider } from '../src/native-image-gallery';
import { NativeImagePreviews } from '../src/native-image-previews';
import '../src/native-tailwind.css';
import '@kite-ai/ui/desktop/style.css';

type Source = {
  group: string;
  mediaType?: string;
  name: string;
  width: number;
  height: number;
  encoded: number;
  sha256: string;
};
const sources: Source[] = await (await fetch('/sources')).json();
const previews = new NativeImagePreviews();
const reads: { index: number; hash: string; bytes: number }[] = [];
let held = false;
let corrupt = false;
const releases = new Set<() => void>();
async function load(index: number, signal: AbortSignal) {
  if (held)
    await new Promise<void>((resolve) => {
      const resume = () => {
        signal.removeEventListener('abort', resume);
        releases.delete(resume);
        resolve();
      };
      releases.add(resume);
      signal.addEventListener('abort', resume, { once: true });
    });
  signal.throwIfAborted();
  const source = sources[index]!;
  const bytes = new Uint8Array(await (await fetch(`/source/${index}`, { signal })).arrayBuffer());
  const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
    .map((v) => v.toString(16).padStart(2, '0'))
    .join('');
  signal.throwIfAborted();
  if (hash !== source.sha256 || bytes.length !== source.encoded)
    throw Error('fixture_source_changed');
  reads.push({ index, hash, bytes: bytes.length });
  return corrupt
    ? new Blob(['invalid image'], { type: 'image/png' })
    : new Blob([bytes], { type: source.mediaType ?? 'image/png' });
}
export interface ImageMemoryFixture {
  group(value: string): void;
  select(value: string | null): void;
  clear(): void;
  hold(value: boolean): void;
  corrupt(value: boolean): void;
  snapshot(): {
    group: string;
    selected: string | null;
    thumbnailCount: number;
    thumbnailDone: boolean;
    errors: string[];
    reads: typeof reads;
  };
}
declare global {
  interface Window {
    imageMemoryFixture: ImageMemoryFixture;
  }
}
function App() {
  const [group, setGroup] = useState(''),
    [selected, select] = useState<string | null>(null);
  const [thumbnails, setThumbnails] = useState<{ index: number; src: string }[]>([]);
  const [done, setDone] = useState(false),
    [errors, setErrors] = useState<string[]>([]);
  const items = useMemo(
    () => sources.flatMap((source, index) => (source.group === group ? [{ source, index }] : [])),
    [group],
  );
  const images = useMemo<ImageGalleryItem[]>(
    () =>
      items.map(({ source, index }) => ({
        id: String(index),
        name: source.name,
        source: { load: (signal) => load(index, signal) },
      })),
    [items],
  );
  useEffect(() => {
    const abort = new AbortController();
    const urls: string[] = [];
    setThumbnails([]);
    setDone(false);
    setErrors([]);
    void (async () => {
      for (const { source, index } of items) {
        const blob = await load(index, abort.signal);
        const derivative = await previews.prepare(blob, source.sha256, abort.signal);
        abort.signal.throwIfAborted();
        const src = URL.createObjectURL(derivative.blob);
        urls.push(src);
        setThumbnails((previous) => [...previous, { index, src }]);
      }
      if (!abort.signal.aborted) setDone(true);
    })().catch((error) => {
      if (!abort.signal.aborted) setErrors((previous) => [...previous, String(error)]);
    });
    return () => {
      abort.abort();
      for (const url of urls) URL.revokeObjectURL(url);
      previews.clear();
    };
  }, [items]);
  window.imageMemoryFixture = {
    group(value) {
      select(null);
      setGroup(value);
    },
    select,
    clear() {
      select(null);
      setGroup('');
    },
    hold(value) {
      held = value;
      if (!held) for (const release of [...releases]) release();
    },
    corrupt(value) {
      corrupt = value;
    },
    snapshot() {
      return {
        group,
        selected,
        thumbnailCount: thumbnails.length,
        thumbnailDone: done,
        errors,
        reads,
      };
    },
  };
  return (
    <main className="kite-client" style={{ height: '100vh', overflow: 'auto', padding: 24 }}>
      <h2>原生图片压力验收：{group}</h2>
      <p>512px 缩略图 · 原图来源不变 · 原生阅读副本</p>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(8, 1fr)', gap: 8 }}>
        {thumbnails.map(({ index, src }) => (
          <button
            type="button"
            key={index}
            onClick={() => select(String(index))}
            style={{ border: '1px solid #777', height: 136 }}
          >
            <img
              alt={sources[index]!.name}
              src={src}
              style={{ width: '100%', height: 104, objectFit: 'contain' }}
            />
            <span>{sources[index]!.name}</span>
          </button>
        ))}
      </div>
      {errors.map((error, i) => (
        <p role="alert" key={i}>
          {error}
        </p>
      ))}
      <ImageGallery
        images={images}
        selectedId={selected}
        onSelectedIdChange={select}
        scopeKey={group}
      />
    </main>
  );
}
createRoot(document.getElementById('root')!).render(
  <NativeImageGalleryProvider nativeWindow>
    <App />
  </NativeImageGalleryProvider>,
);
