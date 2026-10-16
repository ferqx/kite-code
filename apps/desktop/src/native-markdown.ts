import { ClientError, type ModelOutputSnapshot } from '@kite-ai/client';
import {
  type DesktopMarkdownTree,
  getDesktopMarkdownParse,
  type PreparedDesktopMarkdown,
  rememberDesktopMarkdownParse,
} from '@kite-ai/ui/desktop';

export type MarkdownWorker = Pick<Worker, 'postMessage' | 'terminate' | 'onmessage' | 'onerror'>;
type Job = {
  id: number;
  text: string;
  signal: AbortSignal;
  resolve: (tree: DesktopMarkdownTree) => void;
  reject: (cause: unknown) => void;
  abort: () => void;
};

/** One pure computation plus a bounded admission queue; cancellation never touches business execution. */
export class NativeMarkdownPreparation {
  private worker?: MarkdownWorker;
  private active?: Job;
  private readonly queued: Job[] = [];
  private queuedBytes = 0;
  private serial = 0;
  private readonly create: () => MarkdownWorker;
  constructor(create: () => MarkdownWorker) {
    this.create = create;
  }

  prepare(text: string, signal: AbortSignal): Promise<DesktopMarkdownTree> {
    signal.throwIfAborted();
    if (
      this.active &&
      (this.queued.length >= 8 || this.queuedBytes + text.length * 2 > 16 * 1024 * 1024)
    )
      return Promise.reject(new ClientError('native_markdown_busy'));
    return new Promise((resolve, reject) => {
      const job: Job = {
        id: ++this.serial,
        text,
        signal,
        resolve,
        reject,
        abort: () => {
          const index = this.queued.indexOf(job);
          if (index >= 0) {
            this.queued.splice(index, 1);
            this.queuedBytes -= text.length * 2;
          }
          if (this.active === job) {
            this.active = undefined;
            this.worker?.terminate();
            this.worker = undefined;
          }
          signal.removeEventListener('abort', job.abort);
          reject(signal.reason);
          this.drain();
        },
      };
      signal.addEventListener('abort', job.abort, { once: true });
      if (!this.active) this.start(job);
      else {
        this.queued.push(job);
        this.queuedBytes += text.length * 2;
      }
      if (signal.aborted) job.abort();
    });
  }

  private start(job: Job) {
    this.active = job;
    try {
      this.worker ??= this.create();
      const worker = this.worker;
      worker.onmessage = (event) => {
        if (this.worker !== worker || this.active !== job) return;
        const value = event.data;
        if (
          value?.id !== job.id ||
          value.text !== job.text ||
          value.tree?.type !== 'root' ||
          !Array.isArray(value.tree.children)
        ) {
          this.finish(
            job,
            new ClientError(
              value?.error === 'native_markdown_parse_failed'
                ? value.error
                : 'native_markdown_identity_mismatch',
            ),
          );
          return;
        }
        this.finish(job, undefined, value.tree);
      };
      worker.onerror = () =>
        this.finish(job, new ClientError('native_markdown_worker_unavailable'));
      worker.postMessage({ id: job.id, text: job.text });
    } catch {
      this.finish(job, new ClientError('native_markdown_worker_unavailable'));
    }
  }

  private finish(job: Job, error?: unknown, tree?: DesktopMarkdownTree) {
    if (this.active !== job) return;
    this.active = undefined;
    if (this.worker) {
      this.worker.onmessage = null;
      this.worker.onerror = null;
    }
    job.signal.removeEventListener('abort', job.abort);
    if (error) {
      this.worker?.terminate();
      this.worker = undefined;
      job.reject(error);
    } else job.resolve(tree!);
    this.drain();
  }
  private drain() {
    if (this.active) return;
    const next = this.queued.shift();
    if (next) {
      this.queuedBytes -= next.text.length * 2;
      this.start(next);
    }
  }
}

const prepared = new WeakMap<
  ModelOutputSnapshot,
  { owner: NativeMarkdownOwner; value: PreparedDesktopMarkdown }
>();
let preparation: NativeMarkdownPreparation | undefined;
function defaultPrepare(text: string, signal: AbortSignal) {
  preparation ??= new NativeMarkdownPreparation(
    () => new Worker(new URL('./native-markdown-worker.ts', import.meta.url), { type: 'module' }),
  );
  return preparation.prepare(text, signal);
}

/** One active display batch owns trees; inactive facts retain only verified source data. */
export class NativeMarkdownOwner {
  private readonly snapshots = new Set<ModelOutputSnapshot>();
  private disposed = false;
  private readonly abort = () => this.dispose();
  private readonly signal: AbortSignal;
  private readonly parse: typeof defaultPrepare;
  constructor(signal: AbortSignal, parse = defaultPrepare) {
    this.signal = signal;
    this.parse = parse;
    signal.throwIfAborted();
    signal.addEventListener('abort', this.abort, { once: true });
  }
  async prepare(snapshot: ModelOutputSnapshot): Promise<void> {
    this.check();
    const text = snapshot.output.content;
    if (text.length < 32768 || (typeof Worker === 'undefined' && this.parse === defaultPrepare))
      return;
    const cached = getDesktopMarkdownParse(text);
    const tree = cached ?? (await this.parse(text, this.signal));
    this.check();
    if (!cached) rememberDesktopMarkdownParse(text, tree);
    prepared.set(snapshot, { owner: this, value: { text, tree } });
    this.snapshots.add(snapshot);
  }
  private check() {
    this.signal.throwIfAborted();
    if (this.disposed) throw new ClientError('native_markdown_owner_closed');
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.signal.removeEventListener('abort', this.abort);
    for (const snapshot of this.snapshots)
      if (prepared.get(snapshot)?.owner === this) prepared.delete(snapshot);
    this.snapshots.clear();
  }
}
export function nativePreparedMarkdown(
  snapshot: ModelOutputSnapshot | undefined,
  text: string,
): PreparedDesktopMarkdown | undefined {
  const value = snapshot ? prepared.get(snapshot)?.value : undefined;
  return value?.text === text ? value : undefined;
}
