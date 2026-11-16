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

test('original blobs are shared only within one exact admission period and every identity dimension remains distinct', () => {
  const f = fixture();
  try {
    const scope = f.previews.createOriginalScope('generation/selection/epoch/child/message');
    const identity = {
      key: 'message/index/full-reference',
      hash: hash(1),
      mediaType: source.type,
      size: source.size,
    };
    expect(f.previews.rememberOriginal(scope, identity, source)).toBe(true);
    expect(f.previews.getOriginal(scope, identity)).toBe(source);
    for (const changed of [
      { ...identity, key: 'different-message/index/reference' },
      { ...identity, hash: hash(2) },
      { ...identity, mediaType: 'image/jpeg' },
      { ...identity, size: identity.size + 1 },
    ])
      expect(f.previews.getOriginal(scope, changed)).toBeUndefined();
    const parallel = f.previews.createOriginalScope(scope.key);
    expect(f.previews.getOriginal(parallel, identity)).toBeUndefined();
    f.previews.retireOriginalScope(scope);
    expect(f.previews.getOriginal(scope, identity)).toBeUndefined();
    expect(f.previews.rememberOriginal(scope, identity, source)).toBe(false);
    expect(f.previews.rememberOriginal(parallel, identity, source)).toBe(true);
    expect(f.previews.getOriginal(parallel, identity)).toBe(source);
    f.previews.clear();
    expect(f.previews.getOriginal(parallel, identity)).toBeUndefined();
    expect(f.previews.rememberOriginal(parallel, identity, source)).toBe(false);
  } finally {
    f.previews.clear();
  }
});

test('original LRU has one window-wide 64 MiB and 32-entry budget across scopes, separate from thumbnails', async () => {
  const f = fixture();
  try {
    const scopes = [f.previews.createOriginalScope('a'), f.previews.createOriginalScope('b')];
    const large = new Blob([new Uint8Array(16 * 1024 * 1024)], { type: 'image/png' });
    const identity = (index: number) => ({
      key: String(index),
      hash: hash(index),
      mediaType: large.type,
      size: large.size,
    });
    for (let index = 0; index < 4; index++)
      expect(f.previews.rememberOriginal(scopes[index % 2], identity(index), large)).toBe(true);
    expect(f.previews.getOriginal(scopes[0], identity(0))).toBe(large);
    f.previews.rememberOriginal(scopes[0], identity(4), large);
    expect(f.previews.getOriginal(scopes[1], identity(1))).toBeUndefined();
    expect(f.previews.getOriginal(scopes[0], identity(0))).toBe(large);
    f.previews.clear();
    const scope = f.previews.createOriginalScope('small');
    const smallIdentity = (index: number) => ({
      key: String(index),
      hash: hash(index),
      mediaType: source.type,
      size: source.size,
    });
    for (let index = 0; index < 32; index++)
      f.previews.rememberOriginal(scope, smallIdentity(index), source);
    f.previews.getOriginal(scope, smallIdentity(0));
    f.previews.rememberOriginal(scope, smallIdentity(32), source);
    expect(f.previews.getOriginal(scope, smallIdentity(1))).toBeUndefined();
    expect(f.previews.getOriginal(scope, smallIdentity(0))).toBe(source);
    const thumbnail = f.previews.prepare(source, hash(0), signal());
    f.workers[0]!.complete();
    expect((await thumbnail).blob).not.toBe(source);
    f.previews.retireOriginalScope(scope);
    expect((await f.previews.prepare(source, hash(0), signal())).blob).not.toBe(source);
    expect(f.workers[0]!.messages).toHaveLength(1);
  } finally {
    f.previews.clear();
  }
});

test('invalid original metadata and foreign scope tokens never enter the original bucket', () => {
  const f = fixture();
  const other = fixture();
  try {
    const scope = f.previews.createOriginalScope('exact');
    const identity = { key: 'image', hash: hash(1), mediaType: source.type, size: source.size };
    expect(
      f.previews.rememberOriginal(other.previews.createOriginalScope('exact'), identity, source),
    ).toBe(false);
    expect(f.previews.rememberOriginal(scope, { ...identity, hash: 'bad' }, source)).toBe(false);
    expect(f.previews.rememberOriginal(scope, { ...identity, size: source.size + 1 }, source)).toBe(
      false,
    );
    expect(
      f.previews.rememberOriginal(scope, { ...identity, mediaType: 'image/jpeg' }, source),
    ).toBe(false);
    expect(f.previews.getOriginal(scope, identity)).toBeUndefined();
  } finally {
    f.previews.clear();
    other.previews.clear();
  }
});
