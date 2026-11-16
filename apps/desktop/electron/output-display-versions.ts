import type { Change } from '@kite-ai/client';
import type { NativeOutputDisplayState, NativeOutputSource } from '../src/output-files-bridge';

/** Observation invalidation only. These counters never grant access to a source or target. */
export class NativeOutputDisplayVersions {
  private epoch = 0;
  private nextRevision = 0;
  private roots = new Map<string, { revision: number; sessions: Set<string> }>();

  reset() {
    this.epoch++;
    this.roots.clear();
  }

  private root(sessionId: string) {
    let root = this.roots.get(sessionId);
    if (!root) {
      root = { revision: ++this.nextRevision, sessions: new Set([sessionId]) };
      this.roots.set(sessionId, root);
    } else {
      this.roots.delete(sessionId);
      this.roots.set(sessionId, root);
    }
    while (this.roots.size > 12) this.roots.delete(this.roots.keys().next().value!);
    return root;
  }

  sources(sessionId: string, sources: readonly NativeOutputSource[]) {
    this.root(sessionId).sessions = new Set([
      sessionId,
      ...sources.map((source) => source.sessionId),
    ]);
  }

  changed(change: Change): boolean {
    const all =
      change.type === 'host_control.changed' ||
      change.type.startsWith('permission.') ||
      // Creation/start events do not expose ancestry. Until the exact source directory
      // proves membership, conservatively invalidate retained roots rather than guess.
      change.type === 'session.created' ||
      change.type === 'session.forked' ||
      (change.type === 'run.started' &&
        ![...this.roots.values()].some((root) => root.sessions.has(change.sessionId ?? '')));
    const output =
      (change.type === 'extension.record_updated' &&
        /^builtin\.files\/(delivery|collection|output|output-index)\//.test(change.objectId)) ||
      change.type === 'run.started' ||
      change.type === 'run.finished' ||
      change.type === 'run.interrupted' ||
      change.type === 'session.renamed' ||
      change.type === 'session.delete_requested';
    let changed = false;
    for (const root of this.roots.values()) {
      if (all || (output && !!change.sessionId && root.sessions.has(change.sessionId))) {
        root.revision = ++this.nextRevision;
        changed = true;
      }
    }
    return changed;
  }

  snapshot(storeId: string, subjectId: string, selected?: string): NativeOutputDisplayState {
    if (selected) this.root(selected);
    return {
      storeId,
      subjectId,
      epoch: this.epoch,
      roots: [...this.roots].map(([sessionId, root]) => ({ sessionId, revision: root.revision })),
    };
  }
}
