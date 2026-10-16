import { expect, test } from 'bun:test';
import type { ModelOutputSnapshot } from '@kite-ai/client';
import type { DesktopMarkdownTree } from '@kite-ai/ui/desktop';
import {
  type MarkdownWorker,
  NativeMarkdownOwner,
  NativeMarkdownPreparation,
  nativePreparedMarkdown,
} from '../src/native-markdown';

const tree = (): DesktopMarkdownTree => ({ type: 'root', children: [] }) as DesktopMarkdownTree;
const snapshot = (content: string) => ({ output: { content } }) as ModelOutputSnapshot;
class FakeWorker {
  onmessage: MarkdownWorker['onmessage'] = null;
  onerror: MarkdownWorker['onerror'] = null;
  messages: { id: number; text: string }[] = [];
  terminated = false;
  postMessage(value: { id: number; text: string }) {
    this.messages.push(value);
  }
  terminate() {
    this.terminated = true;
  }
  complete() {
    const value = this.messages.at(-1)!;
    this.onmessage?.call(
      this as unknown as Worker,
      { data: { ...value, tree: tree() } } as MessageEvent,
    );
  }
}
test('pure worker queue has explicit admission, cancellation releases current computation and rejects late results', async () => {
  const workers: FakeWorker[] = [];
  const queue = new NativeMarkdownPreparation(() => {
    const worker = new FakeWorker();
    workers.push(worker);
    return worker as unknown as MarkdownWorker;
  });
  const active = new AbortController();
  const first = queue.prepare('active', active.signal).catch((error) => error);
  const pending = Array.from({ length: 8 }, (_, i) =>
    queue.prepare(String(i), new AbortController().signal),
  );
  await expect(queue.prepare('ninth', new AbortController().signal)).rejects.toThrow(
    'native_markdown_busy',
  );
  active.abort();
  expect((await first).name).toBe('AbortError');
  expect(workers[0]!.terminated).toBe(true);
  const late = workers[0]!.onmessage;
  late?.call(
    workers[0] as unknown as Worker,
    { data: { id: 1, text: 'active', tree: tree() } } as MessageEvent,
  );
  for (let i = 0; i < 8; i++) {
    workers[1]!.complete();
    await pending[i];
  }
  expect(workers[1]!.onmessage).toBeNull();
  expect(workers[1]!.onerror).toBeNull();
  const hold = queue.prepare('hold', new AbortController().signal);
  await expect(
    queue.prepare('x'.repeat(8 * 1024 * 1024 + 1), new AbortController().signal),
  ).rejects.toThrow('native_markdown_busy');
  workers[1]!.complete();
  await hold;
});
test('100 same-view revisions release old trees/listeners while preserving shared prefix ownership and full oversized text', async () => {
  const abort = new AbortController();
  const listeners = new Set<EventListenerOrEventListenerObject>();
  const add = abort.signal.addEventListener.bind(abort.signal),
    remove = abort.signal.removeEventListener.bind(abort.signal);
  abort.signal.addEventListener = ((
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: AddEventListenerOptions,
  ) => {
    if (type === 'abort') listeners.add(listener);
    add(type, listener, options);
  }) as typeof add;
  abort.signal.removeEventListener = ((
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: EventListenerOptions,
  ) => {
    if (type === 'abort') listeners.delete(listener);
    remove(type, listener, options);
  }) as typeof remove;
  const parse = async () => tree();
  const stable = snapshot('stable'.repeat(6000));
  let previous: NativeMarkdownOwner | undefined, previousSnapshot: ModelOutputSnapshot | undefined;
  for (let revision = 0; revision < 100; revision++) {
    const owner = new NativeMarkdownOwner(abort.signal, parse);
    const fresh = snapshot(`${revision}:${'中文🙂'.repeat(9000)}`);
    await owner.prepare(stable);
    await owner.prepare(fresh);
    previous?.dispose();
    if (previousSnapshot)
      expect(
        nativePreparedMarkdown(previousSnapshot, previousSnapshot.output.content),
      ).toBeUndefined();
    expect(nativePreparedMarkdown(stable, stable.output.content)).toBeDefined();
    expect(nativePreparedMarkdown(fresh, fresh.output.content)).toBeDefined();
    expect(nativePreparedMarkdown(fresh, 'wrong content')).toBeUndefined();
    expect(listeners.size).toBe(1);
    previous = owner;
    previousSnapshot = fresh;
  }
  const giant = snapshot('full🙂'.repeat(250000));
  await previous!.prepare(giant);
  expect(nativePreparedMarkdown(giant, giant.output.content)?.text).toBe(giant.output.content);
  abort.abort();
  expect(listeners.size).toBe(0);
  expect(nativePreparedMarkdown(stable, stable.output.content)).toBeUndefined();
  expect(nativePreparedMarkdown(giant, giant.output.content)).toBeUndefined();
});
test('cancelled preparation cannot attach a late tree to a retired snapshot', async () => {
  const abort = new AbortController();
  let release!: (value: DesktopMarkdownTree) => void;
  const owner = new NativeMarkdownOwner(
    abort.signal,
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const value = snapshot('late'.repeat(10000));
  const pending = owner.prepare(value);
  owner.dispose();
  release(tree());
  await expect(pending).rejects.toThrow('native_markdown_owner_closed');
  expect(nativePreparedMarkdown(value, value.output.content)).toBeUndefined();
});

test('worker exact text mismatches fail the owned request and never populate presentation data', async () => {
  const worker = new FakeWorker();
  const queue = new NativeMarkdownPreparation(() => worker as unknown as MarkdownWorker);
  const pending = queue.prepare('exact source', new AbortController().signal);
  worker.onmessage?.call(
    worker as unknown as Worker,
    { data: { id: 1, text: 'different source', tree: tree() } } as MessageEvent,
  );
  await expect(pending).rejects.toThrow('native_markdown_identity_mismatch');
  expect(worker.terminated).toBe(true);
});
