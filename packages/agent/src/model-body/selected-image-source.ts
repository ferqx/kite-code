import { createHash } from 'node:crypto';
import type { ArtifactReadInput } from '../artifact-port';
import { canonicalJson } from '../json';
import { matchesModelRequestIdentity } from '../model-request-identity';
import { isMissingPublishedImage } from '../published-blob-missing';
import type { Store } from '../storage/port';
import { AgentError, type ArtifactReference, type Json } from '../storage/types';
import { toolImages } from '../tool-images';

export interface ImageSourceLocator {
  messageId: string;
  seq: string;
  executionId: string;
}
export interface SelectedImageRead {
  expectedStoreId: string;
  sessionId: string;
  subjectId: string;
  runId: string;
  locator: ImageSourceLocator;
  ordinals: number[];
}
const hash = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');
const rec = (x: Json | null | undefined) =>
  x !== null && typeof x === 'object' && !Array.isArray(x) ? x : {};
function requireSource(v: unknown): asserts v {
  if (!v) throw new AgentError('image_source_unverified');
}
export function validImageSelection(l: ImageSourceLocator, ordinals: number[]) {
  return (
    !!l &&
    Object.keys(l).sort().join(',') === 'executionId,messageId,seq' &&
    [l.messageId, l.executionId].every(
      (x) => typeof x === 'string' && x.length > 0 && x.length <= 256,
    ) &&
    typeof l.seq === 'string' &&
    /^[1-9][0-9]{0,18}$/.test(l.seq) &&
    Array.isArray(ordinals) &&
    ordinals.length > 0 &&
    ordinals.length <= 4 &&
    ordinals.every(
      (x, i) => Number.isSafeInteger(x) && x >= 1 && x <= 10 && (i === 0 || x > ordinals[i - 1]!),
    )
  );
}
async function resolve(store: Store, input: SelectedImageRead) {
  const { expectedStoreId, sessionId, subjectId, runId, locator: l, ordinals } = input,
    scope = { expectedStoreId, sessionId, subjectId };
  requireSource(validImageSelection(l, ordinals));
  const bound = await store.readOriginalRunSelection({ ...scope, runId });
  const session = await store.getSession(sessionId),
    run = await store.getRun(runId);
  requireSource(
    session &&
      !session.deletedAt &&
      run?.isActive &&
      run.sessionId === sessionId &&
      run.contextSelectionId === bound.selection.id &&
      session.contextSelectionId === run.contextSelectionId &&
      BigInt(l.seq) <= BigInt(session.nextSeq),
  );
  const src = await resolveSelectedImageCarrier(
    store,
    { ...scope, selectionId: bound.selection.id },
    l,
    'files.view_images',
  );
  requireSource(ordinals.every((n) => n <= src.refs.length));
  return {
    refs: ordinals.map((n) => src.refs[n - 1]!),
    selection: bound.selection.id,
    originalScope: { ...scope, sessionId: src.refs[0]!.sessionId },
    count: src.refs.length,
  };
}

type CarrierScope = {
  expectedStoreId: string;
  sessionId: string;
  subjectId: string;
  selectionId: string;
};
export interface SourceRoot {
  locator: ImageSourceLocator;
  ordinals: number[];
  sourceCount: number;
}
async function selectedCarrier(
  store: Store,
  scope: CarrierScope,
  l: ImageSourceLocator,
  requiredDefinition?: string,
) {
  const { expectedStoreId, subjectId } = scope;
  requireSource(validImageSelection(l, [1]));
  const [selected] = await store.readSelectedToolLocators({
    ...scope,
    selectionId: scope.selectionId,
    lo: l.seq,
    hi: l.seq,
  });
  requireSource(selected?.id === l.messageId && selected.seq === l.seq);
  // The selected row can be an inherited fork projection; resolve its immutable origin through the current session.
  const origin = await store.getMessageOrigin({ ...scope, messageId: selected.id }),
    m = origin.message;
  requireSource(
    typeof origin.originStoreId === 'string' &&
      origin.originStoreId.length > 0 &&
      origin.subjectId === subjectId &&
      m.role === 'tool' &&
      m.status === 'complete' &&
      m.sourceIds?.length === 1 &&
      m.sourceIds[0] === l.executionId,
  );
  const e = await store.getExecution(l.executionId),
    v = rec(e?.result);
  requireSource(
    e?.kind === 'tool' &&
      ['files.view_images', 'files.reinspect_images'].includes(e.definitionId) &&
      (!requiredDefinition || e.definitionId === requiredDefinition) &&
      e.definitionVersion === '1' &&
      e.originStoreId === origin.originStoreId &&
      e.status === 'succeeded' &&
      v.outcome === 'succeeded' &&
      v.content === m.content &&
      e.sessionId === m.sessionId &&
      e.runId &&
      e.runId === m.runId &&
      e.callId === m.toolCallId,
  );
  const command = await store.getCommand(e.originCommandId),
    decision = rec(e.decisionSource);
  requireSource(
    command?.subjectId === subjectId &&
      command.sessionId === e.sessionId &&
      command.originStoreId === e.originStoreId &&
      decision.kind === 'model_decision' &&
      typeof decision.modelExecutionId === 'string',
  );
  const originalScope = { expectedStoreId, subjectId, sessionId: e.sessionId };
  const snapshot = await store.getModelOutputSnapshot({
    ...originalScope,
    executionId: decision.modelExecutionId,
  });
  requireSource(
    snapshot.complete &&
      snapshot.identity.executionId === decision.modelExecutionId &&
      snapshot.identity.confirmation === 'succeeded' &&
      snapshot.identity.status === 'succeeded' &&
      snapshot.identity.sessionId === e.sessionId &&
      snapshot.identity.runId === e.runId &&
      snapshot.identity.originCommandId === e.originCommandId &&
      snapshot.storeId === expectedStoreId &&
      snapshot.originStoreId === e.originStoreId &&
      snapshot.subjectId === subjectId,
  );
  const model = await store.getExecution(decision.modelExecutionId);
  requireSource(
    model?.kind === 'model' &&
      model.status === 'succeeded' &&
      model.runId === e.runId &&
      model.originStoreId === e.originStoreId,
  );
  const source = rec(model.decisionSource);
  const bindings = source.toolBindings;
  requireSource(
    matchesModelRequestIdentity(source, model.id) &&
      Array.isArray(bindings) &&
      bindings
        .map(rec)
        .some(
          (t) => t.id === e.definitionId && t.version === '1' && t.extensionId === 'builtin.files',
        ),
  );
  const receipt = rec(model.result).modelToolCalls;
  if (snapshot.output) {
    requireSource(
      snapshot.output.complete &&
        Array.isArray(receipt) &&
        receipt.length === snapshot.output.toolCallCount &&
        receipt.length <= 4096,
    );
    const calls = receipt.map(rec).filter((c) => c.id === e.callId);
    requireSource(
      calls.length === 1 &&
        calls[0]?.name === e.definitionId &&
        calls[0].inputDigest === hash(canonicalJson(e.input)),
    );
  } else {
    const calls = snapshot.toolCalls.filter((c) => c.id === e.callId);
    requireSource(
      calls.length === 1 &&
        calls[0]?.name === e.definitionId &&
        canonicalJson(JSON.parse(calls[0].arguments)) === canonicalJson(e.input),
    );
  }
  const all = toolImages(v.modelImages, e.id, { id: e.definitionId, version: e.definitionVersion }),
    published = v.artifactRefs;
  requireSource(Array.isArray(published) && all.length > 0);
  const refs: ArtifactReference[] = [];
  for (const r of all) {
    requireSource(published.some((p) => canonicalJson(p) === canonicalJson(r as unknown as Json)));
    const a = await store.getArtifactReference({ ...originalScope, scope: r.scope!, refId: r.id });
    requireSource(
      a &&
        a.id === r.id &&
        a.storeId === e.originStoreId &&
        a.subjectId === subjectId &&
        a.sessionId === e.sessionId &&
        a.scope.kind === 'execution' &&
        a.scope.id === e.id &&
        a.mediaType === 'image/png' &&
        a.size === r.size &&
        /^[a-f0-9]{64}$/.test(a.hash),
    );
    refs.push(a);
  }
  return {
    refs,
    execution: e,
    definition: e.definitionId,
    locator: l,
    originalScope,
    count: all.length,
    originMessageId: m.id,
  };
}

/** Metadata only. No pixel reads, no blanket authority by hash, and no recursive derived ancestry. */
export async function resolveSelectedImageCarrier(
  store: Store,
  scope: CarrierScope,
  locator: ImageSourceLocator,
  requiredDefinition?: string,
) {
  const carrier = await selectedCarrier(store, scope, locator, requiredDefinition);
  const { definition, refs } = carrier;
  let root: SourceRoot = { locator, ordinals: refs.map((_, i) => i + 1), sourceCount: refs.length };
  if (definition === 'files.reinspect_images') {
    // Input is sealed to the original successful model's call digest above. A result string alone is not a source.
    const args = rec(carrier.execution.input),
      original = args.locator as unknown as ImageSourceLocator,
      ordinals = args.ordinals as number[];
    requireSource(
      Object.keys(args).sort().join(',') === 'locator,ordinals' &&
        validImageSelection(original, ordinals) &&
        ordinals.length === refs.length &&
        BigInt(original.seq) < BigInt(locator.seq),
    );
    const result = rec(JSON.parse(String(rec(carrier.execution.result).content)));
    requireSource(
      result.kind === 'selected_original_images' &&
        canonicalJson(result.source!) === canonicalJson(args.locator!) &&
        canonicalJson(result.ordinals!) === canonicalJson(args.ordinals!),
    );
    const sourceOrigin = await store.getMessageOrigin({
      ...scope,
      sessionId: carrier.execution.sessionId,
      messageId: original.messageId,
    });
    const [local] = await store.readSelectedToolLocators({
      ...scope,
      lo: original.seq,
      hi: original.seq,
    });
    requireSource(local?.seq === original.seq);
    // Fork rows have fork-local message IDs. Re-resolve the same original Execution in this selected branch.
    const rootLoc = { messageId: local.id, seq: local.seq, executionId: original.executionId };
    const parent = await selectedCarrier(store, scope, rootLoc, 'files.view_images');
    requireSource(
      sourceOrigin.originStoreId === parent.execution.originStoreId &&
        sourceOrigin.subjectId === scope.subjectId &&
        sourceOrigin.message.id === parent.originMessageId &&
        result.sourceCount === parent.count,
    );
    for (const [i, n] of ordinals.entries()) {
      const r = parent.refs[n - 1];
      requireSource(r && r.hash === refs[i]!.hash && r.size === refs[i]!.size);
    }
    root = { locator: rootLoc, ordinals, sourceCount: parent.count };
  }
  return { definition, locator, refs, root };
}
export async function readSelectedImageMembers(
  store: Store,
  read: (x: ArtifactReadInput) => Promise<{ reference: ArtifactReference; content: Uint8Array }>,
  input: SelectedImageRead,
  signal?: AbortSignal,
) {
  try {
    signal?.throwIfAborted();
    const original = await resolve(store, input),
      parts: Uint8Array[] = [],
      missing: number[] = [],
      available: number[] = [];
    for (const [i, r] of original.refs.entries()) {
      signal?.throwIfAborted();
      try {
        const b = await read({ ...original.originalScope, refId: r.id, scope: r.scope, signal });
        requireSource(
          canonicalJson(b.reference as unknown as Json) === canonicalJson(r as unknown as Json) &&
            b.content.byteLength === Number(r.size) &&
            hash(b.content) === r.hash,
        );
        parts.push(b.content);
        available.push(input.ordinals[i]!);
      } catch (e) {
        signal?.throwIfAborted();
        if (!isMissingPublishedImage(e, r.hash)) throw e;
        missing.push(input.ordinals[i]!);
      }
    }
    const again = await resolve(store, input);
    signal?.throwIfAborted();
    requireSource(
      canonicalJson(again as unknown as Json) === canonicalJson(original as unknown as Json),
    );
    return missing.length
      ? { kind: 'partial_resource_unavailable' as const, missing, available }
      : { kind: 'ready' as const, parts, count: original.count };
  } catch {
    signal?.throwIfAborted();
    throw new AgentError('image_source_unverified');
  }
}

export type SourceListing = Omit<SelectedImageRead, 'locator' | 'ordinals'> & {
  beforeSeq?: string;
};
export async function listSelectedImageSources(
  store: Store,
  input: SourceListing,
  signal?: AbortSignal,
) {
  try {
    const { runId, expectedStoreId, sessionId, subjectId, beforeSeq } = input,
      scope = { expectedStoreId, sessionId, subjectId };
    requireSource(
      beforeSeq === undefined ||
        (/^[1-9][0-9]{0,18}$/.test(beforeSeq) && typeof beforeSeq === 'string'),
    );
    const bound = await store.readOriginalRunSelection({ ...scope, runId }),
      session = await store.getSession(sessionId),
      run = await store.getRun(runId);
    requireSource(
      run?.isActive &&
        run.sessionId === sessionId &&
        session?.contextSelectionId === bound.selection.id &&
        run.contextSelectionId === bound.selection.id,
    );
    const hi = beforeSeq === undefined ? BigInt(session.nextSeq) : BigInt(beforeSeq) - 1n;
    requireSource(hi >= 0n && hi <= BigInt(session.nextSeq));
    const lo = hi > 16n ? hi - 15n : 1n;
    const out: { locator: ImageSourceLocator; sourceCount: number }[] = [];
    let next = lo > 1n ? String(lo) : null;
    if (hi > 0n) {
      const rows = await store.readSelectedToolLocators({
        ...scope,
        selectionId: bound.selection.id,
        lo: String(lo),
        hi: String(hi),
      });
      for (const r of rows) {
        signal?.throwIfAborted();
        const {
          message,
          subjectId: owner,
          originStoreId,
        } = await store.getMessageOrigin({ ...scope, messageId: r.id });
        requireSource(
          owner === subjectId && typeof originStoreId === 'string' && originStoreId.length > 0,
        );
        if (message.sourceIds?.length !== 1) continue;
        const e = await store.getExecution(message.sourceIds[0]!);
        if (
          e?.definitionId !== 'files.view_images' ||
          e.definitionVersion !== '1' ||
          e.status !== 'succeeded'
        )
          continue;
        const locator = { messageId: r.id, seq: r.seq, executionId: e.id };
        const b = await resolve(store, { ...scope, runId, locator, ordinals: [1] });
        out.push({ locator, sourceCount: b.count });
        if (out.length === 8) {
          next = BigInt(r.seq) > 1n ? r.seq : null;
          break;
        }
      }
    }
    signal?.throwIfAborted();
    requireSource((await store.getSession(sessionId))?.contextSelectionId === bound.selection.id);
    return { sources: out, nextBeforeSeq: next };
  } catch {
    signal?.throwIfAborted();
    throw new AgentError('image_source_unverified');
  }
}
