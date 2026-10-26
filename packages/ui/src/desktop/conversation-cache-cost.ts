import type { RetainedConversationResource } from '../conversation-activity';

export const CONVERSATION_CACHE_ENTRY_BYTES = 8 * 1024 * 1024;
export const CONVERSATION_CACHE_ENTRY_NODES = 10_000;
const NODES_PER_TASK = 1024;

export type ConversationCacheCostSnapshot = { bytes: number; nodes: number };
export type ConversationCacheCostScheduler = (task: () => void) => () => void;

function changesCost(records: MutationRecord[], measured: boolean) {
  return records.some((record) => {
    if (record.type === 'characterData')
      return (record.oldValue?.length ?? 0) !== (record.target.nodeValue?.length ?? 0);
    // A replacement can detach the current node of an in-flight TreeWalker.
    // Only a complete estimate can reuse a topology-changing equal-cost edit.
    if (!measured) return true;
    // React may replace a textarea's default text node with an equal copy.
    // Equal leaf-text replacement preserves the exact node/UTF-16 estimate.
    if (record.addedNodes.length !== record.removedNodes.length) return true;
    let delta = 0;
    for (const node of record.addedNodes) {
      if (node.nodeType !== 3) return true;
      delta += node.nodeValue?.length ?? 0;
    }
    for (const node of record.removedNodes) {
      if (node.nodeType !== 3) return true;
      delta -= node.nodeValue?.length ?? 0;
    }
    return delta !== 0;
  });
}

/** A DOM estimate is eligible only after a complete, unchanged background scan. */
export class ConversationCacheCost {
  private observer?: MutationObserver;
  private cancel?: () => void;
  private revision = 0;
  private measured?: { revision: number; bytes: number; nodes: number };
  private resources = new Map<RetainedConversationResource, number>();
  private resourceBytes = 0;
  private changed?: () => void;
  private schedule: ConversationCacheCostScheduler;
  private container: HTMLElement;

  constructor(container: HTMLElement, schedule?: ConversationCacheCostScheduler) {
    this.container = container;
    this.schedule =
      schedule ??
      ((task) => {
        const view = container.ownerDocument.defaultView!;
        const id = view.setTimeout(task, 0);
        return () => view.clearTimeout(id);
      });
  }

  start(changed?: () => void) {
    if (this.observer) return;
    this.changed = changed;
    const Observer = this.container.ownerDocument.defaultView!.MutationObserver;
    this.observer = new Observer((records) => {
      if (changesCost(records, this.measured?.revision === this.revision)) this.invalidate();
    });
    this.observer.observe(this.container, {
      childList: true,
      characterData: true,
      characterDataOldValue: true,
      subtree: true,
    });
    this.invalidate(false);
  }

  stop() {
    this.observer?.disconnect();
    this.observer = undefined;
    this.changed = undefined;
    this.revision++;
    this.measured = undefined;
    this.cancel?.();
    this.cancel = undefined;
    this.resources.clear();
    this.resourceBytes = 0;
  }

  /** Draining records never walks the DOM; unobserved mutations cannot use an old estimate. */
  snapshot(): ConversationCacheCostSnapshot | undefined {
    this.drain(false);
    const measured = this.measured;
    return measured?.revision === this.revision
      ? { nodes: measured.nodes, bytes: measured.bytes + this.resourceBytes }
      : undefined;
  }

  retain(resource: RetainedConversationResource) {
    this.remove(resource);
    const bytes =
      Number.isFinite(resource.bytes) && resource.bytes >= 0 ? resource.bytes : Infinity;
    this.resources.set(resource, bytes);
    this.resourceBytes += bytes;
    this.changed?.();
    return () => this.remove(resource);
  }

  remove(resource: RetainedConversationResource) {
    const bytes = this.resources.get(resource);
    if (bytes === undefined) return;
    this.resources.delete(resource);
    // Invalid estimates remain conservative without Infinity - Infinity becoming NaN.
    this.resourceBytes = Number.isFinite(this.resourceBytes)
      ? this.resourceBytes - bytes
      : [...this.resources.values()].reduce((sum, value) => sum + value, 0);
  }

  private drain(notify = true) {
    if (
      this.observer &&
      changesCost(this.observer.takeRecords(), this.measured?.revision === this.revision)
    )
      this.invalidate(notify);
  }

  private invalidate(notify = true) {
    if (!this.observer) return;
    this.revision++;
    this.measured = undefined;
    this.cancel?.();
    if (notify) this.changed?.();
    if (!this.observer) return;
    const revision = this.revision;
    let walker: TreeWalker | undefined;
    let nodes = 0;
    let bytes = 0;
    const step = () => {
      if (!this.observer || revision !== this.revision) return;
      this.cancel = undefined;
      this.drain();
      if (!this.observer || revision !== this.revision) return;
      walker ??= this.container.ownerDocument.createTreeWalker(this.container, 0xffffffff);
      for (let count = 0; count < NODES_PER_TASK; count++) {
        const node = walker.nextNode();
        if (!node) {
          this.measured = { revision, bytes, nodes };
          return;
        }
        nodes++;
        bytes += 96 + (node.nodeValue?.length ?? 0) * 2;
        if (nodes > CONVERSATION_CACHE_ENTRY_NODES || bytes > CONVERSATION_CACHE_ENTRY_BYTES) {
          this.measured = { revision, bytes, nodes };
          return;
        }
      }
      this.cancel = this.schedule(step);
    };
    this.cancel = this.schedule(step);
  }
}
