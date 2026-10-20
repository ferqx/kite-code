export type ImagePreview = {
  readonly blob: Blob;
  readonly width: number;
  readonly height: number;
  /** Encoded data plus an RGBA estimate; this is not a browser heap limit. */
  readonly cost: number;
};
export type ImagePreviewWorker = Pick<
  Worker,
  'postMessage' | 'terminate' | 'onmessage' | 'onerror'
>;
type Subscriber = {
  signal: AbortSignal;
  resolve: (preview: ImagePreview) => void;
  reject: (error: unknown) => void;
  abort: () => void;
};
type Job = { id: number; key: string; source: Blob; subscribers: Set<Subscriber> };
const MAX_ENTRIES = 128;
const MAX_COST = 32 * 1024 * 1024;
const MAX_PENDING_BYTES = 32 * 1024 * 1024;

/** Window/connection-owned derived data. Callers must independently admit and verify originals. */
export class NativeImagePreviews {
  private readonly entries = new Map<string, ImagePreview>();
  private readonly jobs = new Map<string, Job>();
  private readonly queue: Job[] = [];
  private active?: Job;
  private worker?: ImagePreviewWorker;
  private timer?: ReturnType<typeof setTimeout>;
  private serial = 0;
  private cost = 0;
  private pendingBytes = 0;
  private readonly create: () => ImagePreviewWorker;
  constructor(
    create: () => ImagePreviewWorker = () =>
      new Worker(new URL('./native-image-preview-worker.ts', import.meta.url), { type: 'module' }),
  ) {
    this.create = create;
  }

  prepare(source: Blob, hash: string, signal: AbortSignal): Promise<ImagePreview> {
    signal.throwIfAborted();
    if (!/^[a-f0-9]{64}$/.test(hash) || source.size < 1 || source.size > 16 * 1024 * 1024)
      return Promise.reject(Error('image_preview_source_invalid'));
    // Only full-content identities established by the original reader enter the cache.
    const key = JSON.stringify(['preview-512-webp-v1', hash, source.type, source.size]);
    const cached = this.entries.get(key);
    if (cached) {
      this.entries.delete(key);
      this.entries.set(key, cached);
      return Promise.resolve(cached);
    }
    let job = this.jobs.get(key);
    if (!job) {
      if (this.jobs.size >= 8 || this.pendingBytes + source.size > MAX_PENDING_BYTES)
        return Promise.reject(Error('image_preview_busy'));
      job = { id: ++this.serial, key, source, subscribers: new Set() };
      this.jobs.set(key, job);
      this.pendingBytes += source.size;
      this.queue.push(job);
    }
    const pending = job;
    const result = new Promise<ImagePreview>((resolve, reject) => {
      const subscriber: Subscriber = {
        signal,
        resolve,
        reject,
        abort: () => {
          signal.removeEventListener('abort', subscriber.abort);
          pending.subscribers.delete(subscriber);
          reject(signal.reason);
          if (!pending.subscribers.size) {
            this.retire(pending);
            if (this.active === pending) {
              this.active = undefined;
              this.stopWorker();
            }
            this.drain();
          }
        },
      };
      pending.subscribers.add(subscriber);
      signal.addEventListener('abort', subscriber.abort, { once: true });
      if (signal.aborted) subscriber.abort();
    });
    this.drain();
    return result;
  }

  clear() {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    this.stopWorker();
    this.active = undefined;
    for (const job of this.jobs.values())
      for (const subscriber of job.subscribers) {
        subscriber.signal.removeEventListener('abort', subscriber.abort);
        subscriber.reject(new DOMException('Image preview scope closed', 'AbortError'));
      }
    this.jobs.clear();
    this.queue.length = 0;
    this.pendingBytes = 0;
    this.entries.clear();
    this.cost = 0;
  }

  private retire(job: Job) {
    if (this.jobs.get(job.key) !== job) return;
    this.jobs.delete(job.key);
    this.pendingBytes -= job.source.size;
    const index = this.queue.indexOf(job);
    if (index >= 0) this.queue.splice(index, 1);
  }
  private stopWorker() {
    if (this.worker) {
      this.worker.onmessage = this.worker.onerror = null;
      this.worker.terminate();
      this.worker = undefined;
    }
  }
  private finish(job: Job, preview?: ImagePreview) {
    if (this.active !== job) return;
    this.active = undefined;
    this.retire(job);
    if (this.worker) this.worker.onmessage = this.worker.onerror = null;
    if (preview) {
      this.entries.set(job.key, preview);
      this.cost += preview.cost;
      while (this.entries.size > MAX_ENTRIES || this.cost > MAX_COST) {
        const key = this.entries.keys().next().value!;
        this.cost -= this.entries.get(key)!.cost;
        this.entries.delete(key);
      }
    } else this.stopWorker();
    for (const subscriber of job.subscribers) {
      subscriber.signal.removeEventListener('abort', subscriber.abort);
      if (preview) subscriber.resolve(preview);
      else subscriber.reject(Error('image_preview_unavailable'));
    }
    job.subscribers.clear();
    this.drain();
  }
  private drain() {
    if (this.active) return;
    const job = this.queue.shift();
    if (!job) {
      if (this.worker && this.timer === undefined)
        this.timer = setTimeout(() => {
          this.timer = undefined;
          this.stopWorker();
        }, 5000);
      return;
    }
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    this.active = job;
    try {
      this.worker ??= this.create();
      const worker = this.worker;
      worker.onmessage = (event) => {
        if (this.worker !== worker || this.active !== job) return;
        const value = event.data;
        if (
          value?.id !== job.id ||
          !(value.blob instanceof Blob) ||
          !value.blob.size ||
          !['image/webp', 'image/png'].includes(value.blob.type) ||
          !Number.isInteger(value.width) ||
          !Number.isInteger(value.height) ||
          value.width < 1 ||
          value.height < 1 ||
          value.width > 512 ||
          value.height > 512 ||
          value.blob.size > 2 * 1024 * 1024
        )
          this.finish(job);
        else
          this.finish(job, {
            blob: value.blob,
            width: value.width,
            height: value.height,
            cost: value.blob.size + value.width * value.height * 4,
          });
      };
      worker.onerror = (event) => {
        event.preventDefault();
        this.finish(job);
      };
      worker.postMessage({ id: job.id, source: job.source });
    } catch {
      this.finish(job);
    }
  }
}
