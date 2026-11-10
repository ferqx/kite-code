import { type AgentClient, ClientError, readTrajectoryEvidence } from '@kite-ai/client';
import {
  parseDecimal64,
  type TrajectoryEvent,
  type TrajectoryEvidenceCloseRequest,
  type TrajectoryEvidenceOpen,
  type TrajectoryEvidenceReadRequest,
  type TrajectoryEvidenceRef,
  type TrajectoryReadRequest,
  type TrajectoryScope,
  type TrajectorySnapshot,
  trajectorySnapshotSchema,
  verifyTrajectoryPage,
} from '@kite-ai/trajectory';
import { TrajectoryBundleCleanupError, writeNativeTrajectoryBundle } from './trajectory-bundle';

type Scope = { generation: number; selection: number; storeId: string; sessionId: string };
type EvidenceAccess = { scope: Scope; epoch: number };
type ChildScope = {
  parent: Scope;
  sessionId: string;
  runId: string;
  originStoreId: string;
  carrierId: string;
  workspaceId: string;
  proofCursor: string;
  upperCursor: string;
  events: Map<string, TrajectoryEvent>;
};
type TrajectoryClient = Pick<
  AgentClient,
  | 'openTrajectory'
  | 'readTrajectoryEvents'
  | 'openTrajectoryEvidence'
  | 'readTrajectoryEvidenceChunk'
  | 'closeTrajectoryEvidence'
>;
/** Fixed event reads and separately owned material leases for the selected Native view.
 * Direct children require an owner-sealed carrier observed through that parent's reader.
 * The proof and exact child event/ref ledger are revoked with the parent selection.
 */
export class NativeTrajectory {
  private readonly client: TrajectoryClient;
  private readonly current: () => Scope | undefined;
  private readonly active = new Set<AbortController>();
  private readonly pending = new Set<Promise<void>>();
  private readonly evidence = new Map<string, TrajectoryEvidenceCloseRequest>();
  // Cleanup identities survive an unconfirmed close; their reading authority does not.
  private readonly evidenceAccess = new Map<string, EvidenceAccess>();
  private evidenceEpoch = 0;
  private readonly evidenceChildren = new Map<string, ChildScope>();
  private readonly closing = new Map<string, Promise<void>>();
  private readonly closeErrors = new Map<string, unknown>();
  private closed = false;
  private fileFailure: TrajectoryBundleCleanupError | undefined;
  private readonly children = new Map<string, ChildScope>();
  constructor(client: TrajectoryClient, current: () => Scope | undefined) {
    this.client = client;
    this.current = current;
  }
  private scope(input: { storeId: string; sessionId: string }): Scope {
    const scope = this.current();
    if (
      this.closed ||
      !scope ||
      scope.storeId !== input.storeId ||
      scope.sessionId !== input.sessionId
    )
      throw new ClientError('native_selection_changed');
    return { ...scope };
  }
  private check(scope: Scope, abort: AbortController): void {
    const now = this.current();
    if (
      abort.signal.aborted ||
      !now ||
      now.generation !== scope.generation ||
      now.selection !== scope.selection ||
      now.storeId !== scope.storeId ||
      now.sessionId !== scope.sessionId
    )
      throw new ClientError('native_selection_changed');
  }
  private async read<T>(
    input: { storeId: string; sessionId: string },
    work: (signal: AbortSignal) => Promise<T>,
    child?: ChildScope,
  ): Promise<T> {
    if (child && this.children.get(this.childKey(child)) !== child)
      throw new ClientError('native_selection_changed');
    const scope = this.scope(child?.parent ?? input),
      abort = new AbortController();
    let settled!: () => void;
    const pending = new Promise<void>((resolve) => {
      settled = resolve;
    });
    this.active.add(abort);
    this.pending.add(pending);
    try {
      const value = await work(abort.signal);
      this.check(scope, abort);
      if (child && this.children.get(this.childKey(child)) !== child)
        throw new ClientError('native_selection_changed');
      return value;
    } finally {
      this.active.delete(abort);
      this.pending.delete(pending);
      settled();
    }
  }
  private childKey(input: { sessionId: string; runId: string }): string {
    return JSON.stringify([input.sessionId, input.runId]);
  }
  private child(input: {
    storeId: string;
    sessionId: string;
    runId?: string;
  }): ChildScope | undefined {
    if (input.sessionId === this.current()?.sessionId) return undefined;
    const child = input.runId
      ? this.children.get(this.childKey({ ...input, runId: input.runId }))
      : undefined;
    if (!child || input.storeId !== child.parent.storeId)
      throw new ClientError('native_selection_changed');
    const current = this.scope(child.parent);
    if (
      current.generation !== child.parent.generation ||
      current.selection !== child.parent.selection
    )
      throw new ClientError('native_selection_changed');
    return child;
  }
  private bound(child: ChildScope, upper: string, at = upper): void {
    if (
      parseDecimal64(upper) > parseDecimal64(child.upperCursor) ||
      parseDecimal64(at) > parseDecimal64(upper) ||
      parseDecimal64(upper) < parseDecimal64(child.proofCursor)
    )
      throw new ClientError('trajectory_child_scope_denied');
  }
  private retainChildren(events: readonly TrajectoryEvent[], upperCursor: string): void {
    const parent = this.current();
    if (!parent) return;
    for (const [key, child] of this.children)
      if (
        child.parent.generation !== parent.generation ||
        child.parent.selection !== parent.selection ||
        child.parent.sessionId !== parent.sessionId ||
        child.parent.storeId !== parent.storeId
      )
        this.children.delete(key);
      else if (parseDecimal64(upperCursor) > parseDecimal64(child.upperCursor))
        child.upperCursor = upperCursor;
    for (const event of events) {
      if (
        event.kind !== 'job' ||
        event.sessionId !== parent.sessionId ||
        event.identityConfidence !== 'verified_origin' ||
        !event.executionId ||
        !event.executionOriginStoreId ||
        !event.attributes.childSessionId ||
        event.attributes.childSessionId === parent.sessionId
      )
        continue;
      const display = event.attributes.display;
      if (
        display?.kind !== 'task' ||
        display.targetExecutionId !== event.executionId ||
        display.targetExecutionOriginStoreId !== event.executionOriginStoreId ||
        display.targetSessionId !== event.attributes.childSessionId ||
        !display.targetRunId
      )
        continue;
      const key = this.childKey({ sessionId: display.targetSessionId, runId: display.targetRunId });
      const old = this.children.get(key);
      // Conflicting carrier/origin proofs must never widen an already admitted scope.
      if (
        old &&
        (old.carrierId !== event.executionId || old.originStoreId !== event.executionOriginStoreId)
      )
        continue;
      if (old) {
        if (parseDecimal64(upperCursor) > parseDecimal64(old.upperCursor))
          old.upperCursor = upperCursor;
        if (parseDecimal64(event.sequence) < parseDecimal64(old.proofCursor))
          old.proofCursor = event.sequence;
      } else
        this.children.set(key, {
          parent: { ...parent },
          sessionId: display.targetSessionId,
          runId: display.targetRunId,
          originStoreId: event.executionOriginStoreId,
          carrierId: event.executionId,
          workspaceId: event.workspaceId,
          proofCursor: event.sequence,
          upperCursor,
          events: new Map(),
        });
    }
  }
  async open(input: TrajectoryScope) {
    const child = this.child(input);
    const value = await this.read(
      input,
      (signal) => this.client.openTrajectory(input, { signal }),
      child,
    );
    if (!child) return value;
    const upperCursor =
      parseDecimal64(value.upperCursor) < parseDecimal64(child.upperCursor)
        ? value.upperCursor
        : child.upperCursor;
    this.bound(child, upperCursor);
    return { ...value, upperCursor, historyCoverage: { ...value.historyCoverage, upperCursor } };
  }
  async readEvents(input: TrajectoryReadRequest) {
    const child = this.child(input);
    if (child) this.bound(child, input.upperCursor);
    const page = await this.read(
      input,
      async (signal) =>
        verifyTrajectoryPage(await this.client.readTrajectoryEvents(input, { signal }), input),
      child,
    );
    if (child) {
      if (
        page.events.some(
          (event) =>
            event.sessionId !== child.sessionId ||
            event.workspaceId !== child.workspaceId ||
            event.runId !== child.runId ||
            event.runOriginStoreId !== child.originStoreId ||
            event.identityConfidence !== 'verified_origin',
        )
      )
        throw new ClientError('trajectory_child_scope_denied');
      for (const event of page.events) child.events.set(event.eventId, event);
    } else this.retainChildren(page.events, input.upperCursor);
    return page;
  }
  export(path: string, snapshot: TrajectorySnapshot, includeEvidence: boolean): Promise<void> {
    const descriptor = trajectorySnapshotSchema.parse(snapshot);
    return this.read(descriptor, async (signal) => {
      const positions = new Map<string, string>();
      try {
        await writeNativeTrajectoryBundle(path, {
          snapshot: descriptor,
          signal,
          readEvents: async (request) => {
            const page = await this.client.readTrajectoryEvents(request, { signal });
            positions.clear();
            for (const event of page.events) positions.set(event.eventId, event.sequence);
            return page;
          },
          ...(includeEvidence
            ? {
                readEvidence: async (eventId: string, reference: TrajectoryEvidenceRef) => {
                  const atCursor = positions.get(eventId);
                  if (!atCursor) throw new ClientError('trajectory_evidence_unavailable');
                  let view: Awaited<ReturnType<typeof readTrajectoryEvidence>>;
                  try {
                    view = await readTrajectoryEvidence(
                      {
                        openTrajectoryEvidence: (request) => this.openEvidence(request),
                        readTrajectoryEvidenceChunk: (request) => this.readEvidence(request),
                        closeTrajectoryEvidence: async (request) => {
                          await this.closeEvidence(request);
                          return { closed: true };
                        },
                      },
                      {
                        storeId: descriptor.storeId,
                        sessionId: descriptor.sessionId,
                        upperCursor: descriptor.upperCursor,
                        atCursor,
                        eventId,
                        evidenceId: reference.evidenceId,
                        contentVersion: reference.contentVersion,
                      },
                      { signal },
                    );
                  } catch (error) {
                    // Earlier sealed Artifact observations may advertise a private Model
                    // envelope as available. Keep that material absent from the package;
                    // the typed Model evidence remains independently authorized.
                    if (
                      reference.kind === 'artifact' &&
                      error instanceof ClientError &&
                      error.code === 'artifact_scope_denied'
                    )
                      return null;
                    throw error;
                  }
                  return view.content;
                },
              }
            : {}),
        });
      } catch (error) {
        if (error instanceof TrajectoryBundleCleanupError) this.fileFailure = error;
        throw error;
      }
    });
  }
  async openEvidence(input: TrajectoryEvidenceOpen) {
    let child: ChildScope | undefined;
    if (input.sessionId !== this.current()?.sessionId) {
      child = [...this.children.values()].find((candidate) => {
        const event = candidate.events.get(input.eventId);
        return (
          candidate.sessionId === input.sessionId &&
          candidate.parent.storeId === input.storeId &&
          event?.evidenceRefs.some(
            (ref) =>
              ref.evidenceId === input.evidenceId && ref.contentVersion === input.contentVersion,
          )
        );
      });
      if (!child) throw new ClientError('trajectory_child_scope_denied');
      this.child({ ...input, runId: child.runId });
      this.bound(child, input.upperCursor, input.atCursor);
      if (
        parseDecimal64(child.events.get(input.eventId)!.sequence) > parseDecimal64(input.atCursor)
      )
        throw new ClientError('trajectory_child_scope_denied');
    }
    const access = { scope: this.scope(child?.parent ?? input), epoch: this.evidenceEpoch };
    let opened: Awaited<ReturnType<AgentClient['openTrajectoryEvidence']>> | undefined;
    try {
      const value = await this.read(
        input,
        async (signal) => {
          opened = await this.client.openTrajectoryEvidence(input, { signal });
          this.evidence.set(opened.readId, {
            storeId: input.storeId,
            sessionId: input.sessionId,
            readId: opened.readId,
          });
          this.evidenceAccess.set(opened.readId, access);
          if (child) this.evidenceChildren.set(opened.readId, child);
          if (
            child &&
            (opened.eventId !== input.eventId ||
              opened.evidenceId !== input.evidenceId ||
              opened.contentVersion !== input.contentVersion)
          )
            throw new ClientError('trajectory_child_scope_denied');
          return opened;
        },
        child,
      );
      return value;
    } catch (error) {
      if (opened)
        await this.closeEvidence({
          storeId: input.storeId,
          sessionId: input.sessionId,
          readId: opened.readId,
        });
      throw error;
    }
  }
  readEvidence(input: TrajectoryEvidenceReadRequest) {
    const original = this.evidence.get(input.readId);
    if (!original || original.storeId !== input.storeId || original.sessionId !== input.sessionId)
      throw new ClientError('trajectory_evidence_read_missing');
    const access = this.evidenceAccess.get(input.readId);
    const child = this.evidenceChildren.get(input.readId);
    if (input.sessionId !== this.current()?.sessionId && !child)
      throw new ClientError('native_selection_changed');
    if (child) this.child({ ...input, runId: child.runId });
    return this.read(
      input,
      async (signal) => {
        if (
          !access ||
          access.epoch !== this.evidenceEpoch ||
          this.evidenceAccess.get(input.readId) !== access
        )
          throw new ClientError('native_selection_changed');
        const owner = this.scope(access.scope);
        if (
          owner.generation !== access.scope.generation ||
          owner.selection !== access.scope.selection
        )
          throw new ClientError('native_selection_changed');
        const value = await this.client.readTrajectoryEvidenceChunk(input, { signal });
        if (this.evidenceAccess.get(input.readId) !== access || access.epoch !== this.evidenceEpoch)
          throw new ClientError('native_selection_changed');
        return value;
      },
      child,
    );
  }
  async closeEvidence(input: TrajectoryEvidenceCloseRequest): Promise<null> {
    const original = this.evidence.get(input.readId);
    if (!original) return null;
    if (original.storeId !== input.storeId || original.sessionId !== input.sessionId)
      throw new ClientError('trajectory_evidence_identity_mismatch');
    this.evidenceAccess.delete(input.readId);
    let work = this.closing.get(input.readId);
    if (!work) {
      work = (async () => {
        try {
          await this.client.closeTrajectoryEvidence(original);
          this.evidence.delete(input.readId);
          this.evidenceChildren.delete(input.readId);
          this.closeErrors.delete(input.readId);
        } catch (error) {
          this.closeErrors.set(input.readId, error);
          throw error;
        } finally {
          this.closing.delete(input.readId);
        }
      })();
      this.closing.set(input.readId, work);
    }
    await work;
    return null;
  }
  release(): void {
    ++this.evidenceEpoch;
    this.evidenceAccess.clear();
    this.children.clear();
    for (const abort of this.active) abort.abort();
    for (const input of this.evidence.values()) void this.closeEvidence(input).catch(() => {});
  }
  async close(): Promise<void> {
    this.closed = true;
    this.release();
    await Promise.all(this.pending);
    this.release();
    await Promise.allSettled(this.closing.values());
    if (this.closeErrors.size) throw this.closeErrors.values().next().value;
    if (this.fileFailure) throw this.fileFailure;
  }
}
