import { expect, test } from 'bun:test';
import { type ImagePreviewWorker, NativeImagePreviews } from '../src/native-image-previews';

const source = new Blob(['original'], { type: 'image/png' });
const hash = (id: number) => id.toString(16).padStart(64, '0');
const signal = () => new AbortController().signal;
class PreviewWorker {
  onmessage: ImagePreviewWorker['onmessage'] = null;
  onerror: ImagePreviewWorker['onerror'] = null;
  messages: { id: number; source: Blob }[] = [];
  closed = false;
  postMessage(message: { id: number; source: Blob }) {
    this.messages.push(message);
  }
  terminate() {
    this.closed = true;
  }
  complete(width = 512, height = 512, blob = new Blob(['small'], { type: 'image/webp' })) {
    this.onmessage?.call(
      this as unknown as Worker,
      { data: { id: this.messages.at(-1)!.id, blob, width, height } } as MessageEvent,
    );
  }
}
function fixture() {
  const workers: PreviewWorker[] = [];
  const previews = new NativeImagePreviews(() => {
    const worker = new PreviewWorker();
    workers.push(worker);
    return worker;
  });
  return { workers, previews };
}
test('duplicate originals share a single conversion and cached data survives new callers without retaining original blobs', async () => {
  const f = fixture();
  try {
    const a = f.previews.prepare(source, hash(1), signal());
    const b = f.previews.prepare(source, hash(1), signal());
    expect(f.workers).toHaveLength(1);
    expect(f.workers[0]!.messages).toHaveLength(1);
    const c = f.previews.prepare(source, hash(2), signal());
    expect(f.workers[0]!.messages).toHaveLength(1);
    f.workers[0]!.complete();
    const first = await a;
    expect(await b).toBe(first);
    expect(first.blob).not.toBe(source);
    expect(first.cost).toBe(first.blob.size + 512 * 512 * 4);
    expect(f.workers[0]!.messages).toHaveLength(2);
    f.workers[0]!.complete();
    await c;
    expect(f.workers[0]!.onmessage).toBeNull();
    expect(f.workers[0]!.onerror).toBeNull();
    for (let index = 0; index < 100; index++)
      expect(await f.previews.prepare(source, hash(1), signal())).toBe(first);
    expect(f.workers[0]!.messages).toHaveLength(2);
    // A different media interpretation cannot borrow an earlier result.
    const different = f.previews.prepare(
      new Blob(['original'], { type: 'image/jpeg' }),
      hash(1),
      signal(),
    );
    f.workers[0]!.complete();
    await different;
    expect(f.workers[0]!.messages).toHaveLength(3);
  } finally {
    f.previews.clear();
  }
});
test('cancelling one shared consumer preserves the other; the last cancellation terminates computation and ignores late replies', async () => {
  const f = fixture();
  try {
    const owner = new AbortController(),
      other = new AbortController();
    const a = f.previews.prepare(source, hash(1), owner.signal).catch((error) => error);
    const b = f.previews.prepare(source, hash(1), other.signal);
    owner.abort();
    expect((await a).name).toBe('AbortError');
    expect(f.workers[0]!.closed).toBe(false);
    f.workers[0]!.complete();
    expect((await b).width).toBe(512);
    const controller = new AbortController();
    const canceled = f.previews.prepare(source, hash(2), controller.signal).catch((error) => error);
    const old = f.workers[0]!.onmessage;
    const queued = f.previews.prepare(source, hash(3), signal());
    controller.abort();
    expect((await canceled).name).toBe('AbortError');
    expect(f.workers[0]!.closed).toBe(true);
    old?.call(
      f.workers[0] as unknown as Worker,
      { data: { id: 2, blob: source, width: 1, height: 1 } } as MessageEvent,
    );
    f.workers[1]!.complete();
    expect((await queued).width).toBe(512);
  } finally {
    f.previews.clear();
  }
});
test('LRU bounds both estimated pixels and entry count; recently used thumbnails survive while old content is recomputed', async () => {
  const f = fixture();
  try {
    for (let index = 0; index < 31; index++) {
      const pending = f.previews.prepare(source, hash(index), signal());
      f.workers[0]!.complete();
      await pending;
    }
    await f.previews.prepare(source, hash(0), signal());
    const extra = f.previews.prepare(source, hash(31), signal());
    f.workers[0]!.complete();
    await extra;
    await f.previews.prepare(source, hash(0), signal());
    expect(f.workers[0]!.messages).toHaveLength(32);
    const evicted = f.previews.prepare(source, hash(1), signal());
    expect(f.workers[0]!.messages).toHaveLength(33);
    f.workers[0]!.complete();
    await evicted;
    f.previews.clear();
    for (let index = 0; index < 129; index++) {
      const pending = f.previews.prepare(source, hash(index), signal());
      f.workers[1]!.complete(1, 1);
      await pending;
    }
    const old = f.previews.prepare(source, hash(0), signal());
    expect(f.workers[1]!.messages).toHaveLength(130);
    f.workers[1]!.complete(1, 1);
    await old;
  } finally {
    f.previews.clear();
  }
});
test('scope clearing rejects queued consumers, retires the worker, and failures cannot poison later retries', async () => {
  const f = fixture();
  try {
    const a = f.previews.prepare(source, hash(1), signal()).catch((error) => error);
    const b = f.previews.prepare(source, hash(2), signal()).catch((error) => error);
    f.previews.clear();
    expect((await a).name).toBe('AbortError');
    expect((await b).name).toBe('AbortError');
    expect(f.workers[0]!.closed).toBe(true);
    const invalid = f.previews.prepare(source, hash(1), signal()).catch((error) => error);
    f.workers[1]!.complete(513, 1);
    expect((await invalid).message).toBe('image_preview_unavailable');
    const retry = f.previews.prepare(source, hash(1), signal());
    f.workers[2]!.complete();
    await retry;
    await expect(f.previews.prepare(source, 'not-a-digest', signal())).rejects.toThrow(
      'image_preview_source_invalid',
    );
  } finally {
    f.previews.clear();
  }
});
test('pending original payloads and queue count have bounded admission and cancelled queued jobs never enter the worker', async () => {
  const f = fixture();
  try {
    const large = new Blob([new Uint8Array(16 * 1024 * 1024)], { type: 'image/png' });
    const a = f.previews.prepare(large, hash(1), signal()).catch((error) => error);
    const controller = new AbortController();
    const b = f.previews.prepare(large, hash(2), controller.signal).catch((error) => error);
    await expect(f.previews.prepare(source, hash(3), signal())).rejects.toThrow(
      'image_preview_busy',
    );
    controller.abort();
    expect((await b).name).toBe('AbortError');
    expect(f.workers[0]!.messages).toHaveLength(1);
    f.workers[0]!.complete();
    await a;
    f.previews.clear();
    const pending = Array.from({ length: 8 }, (_, index) =>
      f.previews.prepare(source, hash(index), signal()).catch((error) => error),
    );
    await expect(f.previews.prepare(source, hash(99), signal())).rejects.toThrow(
      'image_preview_busy',
    );
    f.previews.clear();
    await Promise.all(pending);
  } finally {
    f.previews.clear();
  }
});
