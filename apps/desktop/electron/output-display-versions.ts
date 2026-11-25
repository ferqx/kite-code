import type { Change } from '@kite-ai/client';
import {
  type NativeOutputDisplayState,
  type NativeOutputFileVersion,
  type NativeOutputSource,
  nativeOutputSourceKey,
} from '../src/output-files-bridge';

type Root = {
  revision: number;
  sourcesRevision: number;
  filesRevision: number;
  files: Map<string, NativeOutputFileVersion>;
  sessions: Set<string>;
  sources: Set<string>;
};

export function nativeOutputRecord(change: Change) {
  if (change.type !== 'extension.record_updated') return null;
  const prefix = /^builtin\.files\/(delivery|collection|output|output-index)\//.exec(
    change.objectId,
  );
  return prefix && { kind: prefix[1]!, hasRecordId: change.objectId.length > prefix[0].length };
}

/** Observation invalidation only. These counters never grant access to a source or target. */
export class NativeOutputDisplayVersions {
  private epoch = 0;
  private nextRevision = 0;
  private roots = new Map<string, Root>();

  reset() {
    this.epoch++;
    this.roots.clear();
  }

  private root(sessionId: string) {
    let root = this.roots.get(sessionId);
    if (!root) {
      root = {
        revision: ++this.nextRevision,
        sourcesRevision: 0,
        filesRevision: 0,
        files: new Map(),
        sessions: new Set([sessionId]),
        sources: new Set(),
      };
      this.roots.set(sessionId, root);
    } else {
      this.roots.delete(sessionId);
      this.roots.set(sessionId, root);
    }
    while (this.roots.size > 12) this.roots.delete(this.roots.keys().next().value!);
    return root;
  }

  private revoke(root: Root) {
    root.revision = ++this.nextRevision;
    root.files.clear();
    root.filesRevision = 0;
    root.sources.clear();
  }

  sources(sessionId: string, sources: readonly NativeOutputSource[]) {
    const root = this.root(sessionId);
    const proved = new Set(sources.map(nativeOutputSourceKey));
    const revoked = [...root.sources].some((source) => !proved.has(source));
    if (revoked) this.revoke(root);
    root.sources = proved;
    root.sessions = new Set([sessionId, ...sources.map((source) => source.sessionId)]);
    return revoked;
  }

  changed(change: Change, output = nativeOutputRecord(change)): boolean {
    const { type, sessionId, objectId } = change;
    const run = type === 'run.started' || type === 'run.finished' || type === 'run.interrupted';
    const hint =
      (output?.kind === 'delivery' || output?.kind === 'collection') &&
      change.payload &&
      typeof change.payload === 'object' &&
      !Array.isArray(change.payload)
        ? change.payload.outputRunId
        : undefined;
    const runId = run ? objectId : typeof hint === 'string' && hint.length ? hint : undefined;
    const revoke = type === 'host_control.changed' || type.startsWith('permission.');
    // Creation exposes no ancestry. Refresh the directory without discarding admitted cards.
    const discover =
      type === 'session.created' ||
      type === 'session.forked' ||
      (type === 'run.started' &&
        !!sessionId &&
        ![...this.roots.values()].some((root) => root.sessions.has(sessionId)));
    let changed = false;
    for (const [rootId, root] of this.roots) {
      const knownSource = !!sessionId && root.sessions.has(sessionId);
      if (revoke || (knownSource && type === 'session.delete_requested')) {
        this.revoke(root);
        changed = true;
        continue;
      }
      if (
        discover ||
        (knownSource &&
          sessionId !== rootId &&
          (type === 'run.started' || type === 'session.renamed'))
      ) {
        root.sourcesRevision = ++this.nextRevision;
        changed = true;
      }
      if (sessionId && knownSource && (run || output)) {
        const key = JSON.stringify([sessionId, runId]);
        const revision = ++this.nextRevision;
        if (!root.files.has(key) && root.files.size === 64) {
          // Compact in batches so long sessions can still isolate subsequent Run changes.
          root.filesRevision = revision;
          root.files.clear();
        } else {
          root.files.set(key, { sessionId, runId, revision });
        }
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
      roots: [...this.roots].map(([sessionId, root]) => ({
        sessionId,
        revision: root.revision,
        sourcesRevision: root.sourcesRevision,
        filesRevision: root.filesRevision,
        files: [...root.files.values()],
      })),
    };
  }
}
