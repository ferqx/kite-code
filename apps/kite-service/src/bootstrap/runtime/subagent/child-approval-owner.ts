import type { RuntimeApprovalInteraction } from '@kite-ai/runtime-contract';
import { sameRuntimeClientInteractionIdentity } from '@kite-ai/runtime-contract';
import {
  createRuntimeStoredCommandReceipt,
  type RuntimeCommandCommitEvidence,
  type RuntimeStoredCommandReceipt,
} from '@kite-ai/runtime-host/storage';
import type { KiteChildApprovalProxyRecord } from '@kite-ai/runtime-storage-sqlite';
import type { KiteSessionAppServerStorageOwner } from '../../kite-session-app-server-storage';
import type { RuntimeEvent, RuntimeState } from '../state-runtime';
import { projectChildApprovalProxy } from './child-approval-proxy';

export interface ChildApprovalProxyOwner {
  list(parentState: Readonly<RuntimeState>): readonly RuntimeApprovalInteraction[];
  read(proxyInteractionId: string): KiteChildApprovalProxyRecord | null;
  publishRequested(proxy: KiteChildApprovalProxyRecord): void;
  publishDecided(
    proxyInteractionId: string,
    publishParentEvent?: (
      event: Extract<RuntimeEvent, { type: 'subagent.child_approval_proxy_changed' }>,
    ) => void,
  ): void;
  decide(input: {
    readonly parentState: Readonly<RuntimeState>;
    readonly interaction: RuntimeApprovalInteraction;
    readonly decision: 'approve_once' | 'reject';
    readonly evidence: RuntimeCommandCommitEvidence;
  }): RuntimeStoredCommandReceipt;
  /** Called only by Host activation after it verifies the applied parent receipt. */
  activateDecision(proxyInteractionId: string): void;
  waitForDecision(
    proxyInteractionId: string,
    signal?: AbortSignal,
  ): Promise<KiteChildApprovalProxyRecord>;
}

/** Private App owner; public Runtime commands remain parent-scoped. */
export function createChildApprovalProxyOwner(input: {
  readonly owner: KiteSessionAppServerStorageOwner;
  readonly parentSessionId: string;
  readonly getParentState: () => Readonly<RuntimeState>;
  readonly publishParentEvent: (
    event: Extract<RuntimeEvent, { type: 'subagent.child_approval_proxy_changed' }>,
  ) => void;
}): ChildApprovalProxyOwner {
  const waiters = new Map<string, Set<() => void>>();
  const activatedDecisions = new Set<string>();
  const wake = (id: string): void => {
    for (const resolve of waiters.get(id) ?? []) resolve();
    waiters.delete(id);
  };
  const read = (id: string): KiteChildApprovalProxyRecord | null =>
    input.owner.readChildApprovalProxy(input.parentSessionId, id);
  const listRows = (): readonly KiteChildApprovalProxyRecord[] => {
    const rows: KiteChildApprovalProxyRecord[] = [];
    let cursor: string | undefined;
    for (;;) {
      const page = input.owner.listPendingChildApprovalProxies(input.parentSessionId, 100, cursor);
      rows.push(...page);
      if (page.length < 100) return Object.freeze(rows);
      cursor = page.at(-1)!.proxyInteractionId;
    }
  };
  const project = (state: Readonly<RuntimeState>, proxy: KiteChildApprovalProxyRecord) => {
    const childState = input.owner.storage.sessions.loadSnapshot<RuntimeState>(proxy.childThreadId);
    return childState ? projectChildApprovalProxy({ parentState: state, childState, proxy }) : null;
  };
  const publishChange = (
    proxy: KiteChildApprovalProxyRecord,
    status: 'pending' | 'decided',
    publishParentEvent = input.publishParentEvent,
  ): void => {
    if (proxy.parentSessionId !== input.parentSessionId || proxy.status !== status)
      throw new Error('Child approval wake changed its durable proxy status.');
    const state = input.getParentState();
    if (state.session.threadId !== input.parentSessionId)
      throw new Error('Child approval wake changed parent Session.');
    if (status === 'pending' && !project(state, proxy))
      throw new Error('Child approval wake lacks a visible exact proxy.');
    if (status === 'decided' && (!proxy.parentCommandId || !proxy.parentCommandDigest))
      throw new Error('Child approval wake lacks a durable parent receipt.');
    const previous = input.owner.storage.sessions
      .loadEventsStrict(input.parentSessionId)
      .filter((entry) => entry.event.type === 'subagent.child_approval_proxy_changed')
      .map(
        (entry) =>
          entry.event as Extract<RuntimeEvent, { type: 'subagent.child_approval_proxy_changed' }>,
      );
    if (
      previous.some(
        (event) =>
          event.proxyInteractionId === proxy.proxyInteractionId &&
          event.childInvocationId !== proxy.childInvocationId,
      )
    )
      throw new Error('Child approval wake conflicts with persisted parent lineage.');
    if (
      previous.some(
        (event) => event.proxyInteractionId === proxy.proxyInteractionId && event.status === status,
      )
    )
      return;
    publishParentEvent({
      type: 'subagent.child_approval_proxy_changed',
      proxyInteractionId: proxy.proxyInteractionId,
      childInvocationId: proxy.childInvocationId,
      status,
    });
  };
  const result: ChildApprovalProxyOwner = {
    list(parentState) {
      if (parentState.session.threadId !== input.parentSessionId)
        throw new Error('Child approval list changed parent Session.');
      return Object.freeze(
        listRows().flatMap((row) => {
          const approval = project(parentState, row);
          return approval ? [approval] : [];
        }),
      );
    },
    read,
    publishRequested(proxy) {
      const current = read(proxy.proxyInteractionId);
      if (
        !current ||
        current.childThreadId !== proxy.childThreadId ||
        current.approvalDigest !== proxy.approvalDigest
      )
        throw new Error('Child approval wake lost its exact proxy.');
      publishChange(current, 'pending');
    },
    publishDecided(proxyInteractionId, publishParentEvent) {
      const current = read(proxyInteractionId);
      if (!current) throw new Error('Child approval decision wake has no durable proxy.');
      publishChange(current, 'decided', publishParentEvent);
    },
    decide({ parentState, interaction, decision, evidence }) {
      const proxy = read(interaction.interactionId);
      if (
        !proxy ||
        proxy.status !== 'pending' ||
        parentState.session.threadId !== input.parentSessionId ||
        input.getParentState().revision !== parentState.revision ||
        interaction.sessionRevision !== parentState.revision ||
        evidence.scopeSessionId !== input.parentSessionId ||
        evidence.targetSessionId !== input.parentSessionId
      )
        throw new Error('Child approval decision lost its parent scope or revision.');
      const expected = project(parentState, proxy);
      if (!expected || !sameRuntimeClientInteractionIdentity(expected, interaction))
        throw new Error('Child approval decision changed its visible interaction identity.');
      const receipt = createRuntimeStoredCommandReceipt(evidence, parentState.revision);
      input.owner.runWithSessionExecution(input.parentSessionId, () =>
        input.owner.storage.transactions.commitDecision({
          sessionId: input.parentSessionId,
          events: [],
          snapshot: parentState,
          commandReceipt: receipt,
          childApprovalProxyDecision: {
            proxyInteractionId: proxy.proxyInteractionId,
            childRequestRevision: proxy.childRequestRevision,
            childGeneration: proxy.childGeneration,
            approvalDigest: proxy.approvalDigest as `sha256:${string}`,
            decision,
          },
        }),
      );
      const committed = read(proxy.proxyInteractionId);
      if (
        committed?.status !== 'decided' ||
        committed.decision !== decision ||
        committed.parentCommandId !== receipt.commandId
      )
        throw new Error('Child approval decision receipt was not durable.');
      return receipt;
    },
    activateDecision(proxyInteractionId) {
      const current = read(proxyInteractionId);
      if (!current || current.status !== 'decided' || !current.parentCommandId)
        throw new Error('Child approval activation has no durable parent decision.');
      activatedDecisions.add(proxyInteractionId);
      wake(proxyInteractionId);
    },
    waitForDecision(proxyInteractionId, signal) {
      const current = read(proxyInteractionId);
      if (!current) return Promise.reject(new Error('Child approval proxy is unavailable.'));
      if (current.status !== 'pending' && activatedDecisions.has(proxyInteractionId))
        return Promise.resolve(current);
      return new Promise<KiteChildApprovalProxyRecord>((resolve, reject) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          signal?.removeEventListener('abort', abort);
          const set = waiters.get(proxyInteractionId);
          set?.delete(finish);
          if (set?.size === 0) waiters.delete(proxyInteractionId);
          const next = read(proxyInteractionId);
          if (next && next.status !== 'pending' && activatedDecisions.has(proxyInteractionId))
            resolve(next);
          else reject(new Error('Child approval proxy wake lacks a durable decision.'));
        };
        const abort = () => {
          if (settled) return;
          settled = true;
          const set = waiters.get(proxyInteractionId);
          set?.delete(finish);
          if (set?.size === 0) waiters.delete(proxyInteractionId);
          reject(new Error('Child approval wait was interrupted.'));
        };
        const set = waiters.get(proxyInteractionId) ?? new Set<() => void>();
        set.add(finish);
        waiters.set(proxyInteractionId, set);
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
        // Close the read→subscribe race against another accepted parent command.
        else if (
          read(proxyInteractionId)?.status !== 'pending' &&
          activatedDecisions.has(proxyInteractionId)
        )
          finish();
      });
    },
  };
  return Object.freeze(result);
}
