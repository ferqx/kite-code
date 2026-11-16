import {
  type AgentClient,
  type BackgroundExecutionItem,
  ClientError,
  type OutputFilesPage,
  type OutputFileTarget,
} from '@kite-ai/client';
import type { NativeOutputSource } from '../src/output-files-bridge';
import { backgroundIdentity } from './background';

export type NativeOutputScope = {
  generation: number;
  selection: number;
  subjectId: string;
  storeId: string;
  sessionId: string;
};
type AdmissionScope = NativeOutputScope & { outputEpoch: number };
type Source = { item: BackgroundExecutionItem; view: NativeOutputSource };
const sourceKey = (sessionId: string, runId: string) => JSON.stringify([sessionId, runId]);
const targetKey = (target: OutputFileTarget) =>
  JSON.stringify([
    target.storeId,
    target.sessionId,
    target.fileId,
    target.locator.kind,
    target.locator.kind === 'legacy-operation' ? target.locator.executionId : target.locator.key,
  ]);

/** Presentation admission only. Source records and all reads retain their original child identity. */
export class NativeOutputSources {
  private catalog?: { scope: string; sources: Map<string, Source> };
  private targets = new Map<string, { scope: string; source: string; identity: string }>();
  private collections = new Map<string, { scope: string; source: string; revision: string }>();
  private epoch = 0;
  private readSequence = 0;
  private readonly client: AgentClient;
  private readonly current: () => NativeOutputScope | undefined;
  constructor(client: AgentClient, current: () => NativeOutputScope | undefined) {
    this.client = client;
    this.current = current;
  }
  private scope(generation: number) {
    const current = this.current();
    if (!current || current.generation !== generation)
      throw new ClientError('output_scope_unavailable');
    return { ...current, outputEpoch: this.epoch };
  }
  private check(scope: AdmissionScope) {
    if (JSON.stringify(this.scope(scope.generation)) !== JSON.stringify(scope))
      throw new ClientError('output_scope_unavailable');
  }
  reset() {
    this.epoch++;
    this.catalog = undefined;
    this.targets.clear();
    this.collections.clear();
  }
  includesSession(sessionId: string) {
    const current = this.current();
    return !!(
      current &&
      this.catalog?.scope === JSON.stringify(this.scope(current.generation)) &&
      [...this.catalog.sources.values()].some((source) => source.view.sessionId === sessionId)
    );
  }
  async read(generation: number, requested: { storeId: string; sessionId: string }) {
    const scope = this.scope(generation);
    if (scope.storeId !== requested.storeId || scope.sessionId !== requested.sessionId)
      throw new ClientError('output_scope_unavailable');
    const readSequence = ++this.readSequence;
    const items = await this.client.listAllBackgroundExecutions({ rootSessionId: scope.sessionId });
    this.check(scope);
    const sources = new Map<string, Source>();
    for (const item of items) {
      if (item.rootSession.id !== scope.sessionId)
        throw new ClientError('output_source_unavailable');
      if (!item.childSession || !item.childRun) continue;
      const { execution, session, rootSession, childSession, childRun, run } = item;
      if (
        !run ||
        rootSession.parentSessionId !== null ||
        rootSession.rootSessionId !== scope.sessionId ||
        session.rootSessionId !== scope.sessionId ||
        rootSession.deletedAt !== null ||
        childSession.deletedAt !== null ||
        session.deletedAt !== null ||
        execution.sessionId !== session.id ||
        execution.rootSessionId !== scope.sessionId ||
        execution.childSessionId !== childSession.id ||
        childSession.parentSessionId !== session.id ||
        childSession.rootSessionId !== scope.sessionId ||
        childSession.workspaceId !== rootSession.workspaceId ||
        session.workspaceId !== rootSession.workspaceId ||
        run.sessionId !== session.id ||
        childRun.sessionId !== childSession.id ||
        childRun.originCommandId !== `child-start-${execution.id}` ||
        childRun.originStoreId !== execution.originStoreId ||
        run.originStoreId !== execution.originStoreId ||
        childRun.rootWorkCommandId !== execution.rootWorkCommandId ||
        childRun.rootWorkSeq !== execution.rootWorkSeq ||
        run.rootWorkCommandId !== execution.rootWorkCommandId ||
        run.rootWorkSeq !== execution.rootWorkSeq
      )
        throw new ClientError('output_source_unavailable');
      const key = sourceKey(childSession.id, childRun.id);
      if (sources.has(key)) throw new ClientError('output_source_unavailable');
      sources.set(key, {
        item,
        view: {
          sessionId: childSession.id,
          runId: childRun.id,
          parentRunId: run.id,
          carrierExecutionId: execution.id,
          name: childSession.title || '子 Agent',
        },
      });
    }
    // Current tasks are one level deep. Retained older descendants may project only
    // through a complete original Run chain, never through a same-name/latest child.
    for (const source of sources.values()) {
      let item = source.item;
      const visited = new Set<string>();
      while (item.session.id !== scope.sessionId) {
        const key = sourceKey(item.session.id, item.run!.id);
        if (visited.has(key)) throw new ClientError('output_source_unavailable');
        visited.add(key);
        const parent = sources.get(key);
        if (!parent) throw new ClientError('output_source_unavailable');
        item = parent.item;
      }
      source.view.parentRunId = item.run!.id;
    }
    // The Native transport is bounded. An incomplete source list is a visible failure,
    // not an empty or silently truncated list of delivered files.
    if (sources.size > 4096) throw new ClientError('output_source_limit');
    if (readSequence !== this.readSequence)
      throw new ClientError('output_source_observation_changed');
    this.catalog = { scope: JSON.stringify(scope), sources };
    return {
      kind: 'outputs.sources' as const,
      scope: { storeId: scope.storeId, sessionId: scope.sessionId },
      sources: [...sources.values()].map((source) => ({ ...source.view })),
    };
  }
  private async source(scope: AdmissionScope, sessionId: string, runId?: string) {
    if (sessionId === scope.sessionId) return;
    if (this.catalog?.scope !== JSON.stringify(scope)) await this.read(scope.generation, scope);
    this.check(scope);
    const source = [...this.catalog!.sources.values()].find(
      (entry) => entry.view.sessionId === sessionId && (!runId || entry.view.runId === runId),
    );
    if (!source) throw new ClientError('output_scope_unavailable');
    const page = await this.client.listBackgroundExecutions({
      storeId: scope.storeId,
      rootSessionId: scope.sessionId,
      executionId: source.item.execution.id,
      limit: 1,
    });
    this.check(scope);
    if (
      page.items.length !== 1 ||
      backgroundIdentity(page.items[0]!) !== backgroundIdentity(source.item) ||
      page.items[0]!.childSession?.deletedAt !== null ||
      page.items[0]!.rootSession.deletedAt !== null
    ) {
      this.reset();
      throw new ClientError('output_source_unavailable');
    }
    return source;
  }
  private retain(scope: AdmissionScope, file: OutputFilesPage['items'][number]) {
    if (file.sessionId === scope.sessionId) return;
    const key = sourceKey(file.sessionId, file.ownerRunId);
    const source = this.catalog?.sources.get(key);
    if (!source || this.catalog?.scope !== JSON.stringify(scope))
      throw new ClientError('output_source_unavailable');
    this.targets.set(targetKey(file), {
      scope: JSON.stringify(scope),
      source: key,
      identity: backgroundIdentity(source.item),
    });
    while (this.targets.size > 8192) this.targets.delete(this.targets.keys().next().value!);
  }
  checkTarget(generation: number, target: OutputFileTarget) {
    const scope = this.scope(generation);
    if (target.storeId !== scope.storeId) throw new ClientError('output_scope_unavailable');
    if (target.sessionId === scope.sessionId) return;
    const lease = this.targets.get(targetKey(target));
    const source = lease && this.catalog?.sources.get(lease.source);
    if (
      !lease ||
      lease.scope !== JSON.stringify(scope) ||
      this.catalog?.scope !== lease.scope ||
      !source ||
      lease.identity !== backgroundIdentity(source.item)
    )
      throw new ClientError('output_scope_unavailable');
  }
  targetCheck(generation: number, target: OutputFileTarget) {
    const scope = this.scope(generation);
    this.checkTarget(generation, target);
    return () => {
      this.check(scope);
      this.checkTarget(generation, target);
    };
  }
  async query(generation: number, input: Parameters<AgentClient['queryOutputFiles']>[0]) {
    const scope = this.scope(generation);
    if (input.scope.storeId !== scope.storeId) throw new ClientError('output_scope_unavailable');
    await this.source(scope, input.scope.sessionId, input.runId);
    const page = await this.client.queryOutputFiles(input);
    this.check(scope);
    if (
      page.scope.storeId !== input.scope.storeId ||
      page.scope.sessionId !== input.scope.sessionId ||
      page.items.some(
        (file) =>
          file.storeId !== scope.storeId ||
          file.sessionId !== input.scope.sessionId ||
          (input.runId && file.ownerRunId !== input.runId),
      )
    )
      throw new ClientError('output_source_unavailable');
    for (const file of page.items) this.retain(scope, file);
    if (input.scope.sessionId !== scope.sessionId)
      for (const collection of page.collections) {
        const key = sourceKey(input.scope.sessionId, collection.ownerRunId);
        if (
          !this.catalog?.sources.has(key) ||
          (input.runId && input.runId !== collection.ownerRunId)
        )
          throw new ClientError('output_source_unavailable');
        this.collections.set(JSON.stringify([input.scope.sessionId, collection.collectionId]), {
          scope: JSON.stringify(scope),
          source: key,
          revision: collection.revision,
        });
      }
    while (this.collections.size > 8192)
      this.collections.delete(this.collections.keys().next().value!);
    return page;
  }
  async resolve(generation: number, target: OutputFileTarget) {
    const scope = this.scope(generation);
    if (target.storeId !== scope.storeId) throw new ClientError('output_scope_unavailable');
    await this.source(scope, target.sessionId);
    const resolved = await this.client.resolveOutputFile(target);
    this.check(scope);
    if (targetKey(resolved.summary) !== targetKey(target))
      throw new ClientError('output_source_unavailable');
    await this.source(scope, target.sessionId, resolved.summary.ownerRunId);
    this.retain(scope, resolved.summary);
    return resolved;
  }
  async retry(generation: number, input: Parameters<AgentClient['retryOutputCollection']>[0]) {
    const scope = this.scope(generation);
    if (scope.storeId !== input.scope.storeId) throw new ClientError('output_scope_unavailable');
    if (input.scope.sessionId !== scope.sessionId) {
      const lease = this.collections.get(
        JSON.stringify([input.scope.sessionId, input.collectionId]),
      );
      const source = lease && this.catalog?.sources.get(lease.source);
      if (
        !lease ||
        lease.scope !== JSON.stringify(scope) ||
        lease.revision !== input.expectedRevision ||
        !source
      )
        throw new ClientError('output_scope_unavailable');
      await this.source(scope, source.view.sessionId, source.view.runId);
    }
    this.check(scope);
    await this.client.retryOutputCollection(input);
    this.check(scope);
  }
}
