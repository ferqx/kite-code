import type { AgentBrowserAnnotation, AgentBrowserView } from './agent-browser-view';
import {
  type BrowserAnnotationCapture,
  type BrowserSavedAnnotation,
  browserNoteFrameCharacters,
  browserNoteLimit,
  browserNoteWindowLimit,
  readBrowserAnnotations,
} from './browser-annotation-content';
import { inputImageChunkBytes } from './input-image-encoding';
import type { NativeBridge } from './native-bridge';
export type BrowserNoteInput = BrowserAnnotationCapture;
export function browserNoteInput(
  view: AgentBrowserView,
  element: AgentBrowserAnnotation,
  note: string,
): BrowserNoteInput {
  if (
    !view.frame ||
    view.frame.data.length > browserNoteFrameCharacters ||
    !view.annotations.some((item) => JSON.stringify(item) === JSON.stringify(element)) ||
    note.length > 2000
  )
    throw Error('browser_note_invalid');
  return structuredClone({
    capturedAt: new Date().toISOString(),
    source: {
      browserId: view.browserId,
      generation: view.generation,
      seq: view.seq,
      frameSeq: view.frame.seq,
      url: view.url,
      title: view.title,
    },
    element,
    frame: {
      ...view.frame,
      byteLength:
        (view.frame.data.length * 3) / 4 -
        (view.frame.data.endsWith('==') ? 2 : view.frame.data.endsWith('=') ? 1 : 0),
    },
    note: note.trim(),
  });
}
export type BrowserNoteDraft = BrowserNoteInput & {
  id: string;
  version: number;
  status: 'preparing' | 'ready' | 'error' | 'missing_image';
  error?: string;
  imageId: string;
  imageHash: string;
};
export type BrowserNoteBatch = {
  key: string;
  entries: readonly { id: string; version: number; imageId: string; imageHash: string }[];
};
type Binding = BrowserNoteBatch & { phase: 'sending' | 'unknown' };

/** Window-only, Session-scoped context. These historical refs never become browser commands. */
export class BrowserAnnotationDrafts {
  private drafts = new Map<string, BrowserNoteDraft[]>();
  private bindings = new Map<string, Binding>();
  private listeners = new Set<() => void>();
  private queue = Promise.resolve();
  private closed = false;
  revision = 0;
  private bridge: NativeBridge | undefined;
  private generation: number | undefined;
  constructor(bridge: NativeBridge | undefined, generation: number | undefined) {
    this.bridge = bridge;
    this.generation = generation;
  }
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  snapshot = () => this.revision;
  private changed() {
    this.revision++;
    for (const listener of this.listeners) listener();
  }
  get(key: string): readonly BrowserNoteDraft[] {
    return this.drafts.get(key) ?? [];
  }
  blocked(key: string) {
    return [...this.bindings.values()].some((binding) => binding.key === key);
  }
  locked(key: string, id: string) {
    return [...this.bindings.values()].some(
      (binding) => binding.key === key && binding.entries.some((entry) => entry.id === id),
    );
  }
  pending(key: string) {
    return [...this.bindings.values()].find((binding) => binding.key === key)?.phase;
  }
  private release(item: BrowserNoteDraft) {
    if (!this.bridge || !this.generation || !item.imageId) return;
    void this.bridge
      .request({ method: 'input.images.release', generation: this.generation, id: item.imageId })
      .catch(() => {});
  }
  add(key: string, input: BrowserNoteInput) {
    if (this.closed || !this.bridge || !this.generation) throw Error('browser_note_unavailable');
    if (
      this.get(key).length >= browserNoteLimit ||
      [...this.drafts.values()].reduce((n, rows) => n + rows.length, 0) >= browserNoteWindowLimit
    )
      throw Error('browser_note_limit');
    if (input.frame.data.length > browserNoteFrameCharacters || input.note.length > 2000)
      throw Error('browser_note_limit');
    const item: BrowserNoteDraft = {
      ...structuredClone(input),
      id: crypto.randomUUID(),
      version: 1,
      status: 'preparing',
      imageId: crypto.randomUUID(),
      imageHash: '',
    };
    this.drafts.set(key, [...this.get(key), item]);
    this.changed();
    this.prepare(key, item);
    return item.id;
  }
  edit(key: string, id: string, note: string) {
    const old = this.get(key).find((item) => item.id === id);
    if (!old || old.status === 'preparing' || this.locked(key, id) || note.length > 2000)
      return false;
    const next = { ...old, note: note.trim(), version: old.version + 1 };
    this.drafts.set(
      key,
      this.get(key).map((item) => (item === old ? next : item)),
    );
    this.changed();
    return true;
  }
  remove(key: string, id: string) {
    const item = this.get(key).find((item) => item.id === id);
    if (!item || this.locked(key, id)) return false;
    this.drafts.set(
      key,
      this.get(key).filter((row) => row !== item),
    );
    this.release(item);
    this.changed();
    return true;
  }
  document(key: string): readonly BrowserSavedAnnotation[] {
    return readBrowserAnnotations(
      this.get(key).map(({ id, version, capturedAt, source, element, frame, note, imageHash }) => ({
        id,
        version,
        capturedAt,
        source,
        element,
        frame: {
          mimeType: frame.mimeType,
          width: frame.width,
          height: frame.height,
          seq: frame.seq,
          byteLength: frame.byteLength,
        },
        note,
        imageHash,
      })),
    );
  }
  restore(key: string, saved: readonly BrowserSavedAnnotation[] | undefined) {
    if (this.drafts.has(key)) return;
    const notes = readBrowserAnnotations(saved).map((note) => ({
      ...structuredClone(note),
      frame: { ...note.frame, data: '' },
      imageId: '',
      status: 'missing_image' as const,
      error: '快照未恢复，请重新选取画面；临时图片身份不会跨窗口复用。',
    }));
    if (
      [...this.drafts.values()].reduce((n, rows) => n + rows.length, 0) + notes.length >
      browserNoteWindowLimit
    )
      throw Error('browser_note_limit');
    this.drafts.set(key, notes);
    this.changed();
  }
  capture(key: string): BrowserNoteBatch {
    if (this.blocked(key) || this.get(key).some((item) => item.status !== 'ready'))
      throw Error('browser_notes_not_ready');
    return {
      key,
      entries: this.get(key).map(({ id, version, imageId, imageHash }) => ({
        id,
        version,
        imageId,
        imageHash,
      })),
    };
  }
  bind(commandId: string, batch: BrowserNoteBatch) {
    if (!batch.entries.length) return;
    if (
      this.closed ||
      this.blocked(batch.key) ||
      batch.entries.some(
        (entry) =>
          !this.get(batch.key).some(
            (item) =>
              item.id === entry.id &&
              item.version === entry.version &&
              item.status === 'ready' &&
              item.imageHash === entry.imageHash &&
              item.imageId === entry.imageId,
          ),
      )
    )
      throw Error('browser_notes_changed');
    this.bindings.set(commandId, { ...batch, entries: [...batch.entries], phase: 'sending' });
    this.changed();
  }
  restoreBinding(
    commandId: string,
    key: string,
    refs: readonly { id: string; version: number; imageHash: string }[],
    phase: string,
  ) {
    if (
      !refs.length ||
      this.bindings.has(commandId) ||
      !refs.some((ref) =>
        this.get(key).some(
          (note) =>
            note.id === ref.id && note.version === ref.version && note.imageHash === ref.imageHash,
        ),
      )
    )
      return;
    this.bindings.set(commandId, {
      key,
      entries: refs.map((ref) => ({ ...ref, imageId: '' })),
      phase: 'unknown',
    });
    this.settle(commandId, phase, key);
  }
  settle(commandId: string, phase: string, key?: string) {
    const binding = this.bindings.get(commandId);
    if (!binding || (key !== undefined && binding.key !== key)) return;
    if (['accepted', 'applied', 'terminal'].includes(phase)) {
      const submitted = new Set(binding.entries.map((entry) => `${entry.id}:${entry.version}`));
      const removed = this.get(binding.key).filter((item) =>
        submitted.has(`${item.id}:${item.version}`),
      );
      this.drafts.set(
        binding.key,
        this.get(binding.key).filter((item) => !submitted.has(`${item.id}:${item.version}`)),
      );
      this.bindings.delete(commandId);
      for (const item of removed) this.release(item);
    } else if (['failed', 'rejected'].includes(phase)) this.bindings.delete(commandId);
    else if (phase === 'unknown') binding.phase = 'unknown';
    else return;
    this.changed();
  }
  private prepare(key: string, item: BrowserNoteDraft) {
    const bridge = this.bridge!,
      generation = this.generation!;
    const alive = () => !this.closed && this.get(key).includes(item);
    const task = async () => {
      if (!alive()) return;
      const check = () => {
        if (!alive()) throw Error('browser_note_removed');
      };
      try {
        const decoded = atob(item.frame.data);
        if (
          !decoded.length ||
          decoded.length > 96 * 1024 ||
          decoded.length !== item.frame.byteLength
        )
          throw Error('browser_note_limit');
        const bytes = new Uint8Array(decoded.length);
        for (let i = 0; i < decoded.length; i++) bytes[i] = decoded.charCodeAt(i);
        const digest = await crypto.subtle.digest('SHA-256', bytes.buffer);
        check();
        const hash = [...new Uint8Array(digest)]
          .map((value) => value.toString(16).padStart(2, '0'))
          .join('');
        if (item.imageHash && item.imageHash !== hash) throw Error('browser_note_hash_mismatch');
        item.imageHash = hash;
        this.changed();
        const name = `网页注释-${item.id.slice(0, 8)}`;
        await bridge.request({
          method: 'input.images.begin',
          generation,
          id: item.imageId,
          name: `${name}-快照.jpg`,
          mediaType: 'image/jpeg',
          size: bytes.length,
          hash,
        });
        check();
        for (let offset = 0; offset < bytes.length; offset += inputImageChunkBytes) {
          let binary = '';
          for (const value of bytes.subarray(offset, offset + inputImageChunkBytes))
            binary += String.fromCharCode(value);
          const data = btoa(binary);
          check();
          await bridge.request({
            method: 'input.images.append',
            generation,
            id: item.imageId,
            offset,
            data,
          });
          check();
        }
        await bridge.request({ method: 'input.images.finish', generation, id: item.imageId });
        check();
        item.status = 'ready';
      } catch {
        this.release(item);
        if (!alive()) return;
        item.status = 'error';
        item.error = '注释快照准备失败，说明已保留；请删除后重新选取。';
      }
      if (alive()) this.changed();
    };
    this.queue = this.queue.then(task, task);
  }
  close() {
    this.closed = true;
    for (const rows of this.drafts.values()) for (const item of rows) this.release(item);
    this.drafts.clear();
    this.bindings.clear();
    this.listeners.clear();
  }
}
